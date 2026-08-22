//! The bulk data channel: the only path by which user file content reaches a share.
//!
//! ADR-0017 has the reasoning; this file has the consequences. The short version is that the
//! unprivileged API cannot write into a share, the clean handover (agent opens with `openat2`,
//! passes the descriptor back over `SCM_RIGHTS`) is unreachable because Node's `net` has no
//! ancillary data, and so the bytes travel instead — over a socket separate from the control one.
//!
//! The wire, in full. One preamble, two directions — which one applies is decided by the token,
//! not by anything the client says, because the control call already fixed it:
//!
//! ```text
//!   UPLOAD (the token names a staging file opened for append)
//!   client → {"token":"…","offset":N,"length":M}\n
//!   agent  → {"status":"ready"}\n
//!   client → exactly M bytes
//!   agent  → {"status":"stored","bytes":M}\n     (or {"status":"failed","kind":…})
//!
//!   DOWNLOAD (the token names a published file opened for reading)
//!   client → {"token":"…","offset":N,"length":M}\n
//!   agent  → {"status":"sending","bytes":M}\n    (or {"status":"failed","kind":…})
//!   agent  → exactly M bytes
//! ```
//!
//! The preamble is IDENTICAL, and that is worth more than the symmetry: `offset` and `length` are
//! exactly what an HTTP Range request carries, so range support on the download side needs no new
//! field, no second parser and no second place where a bounds check could be forgotten.
//!
//! Three properties of that shape are load-bearing and none is obvious:
//!
//! 1. **A declared length, not a half-close.** EOF carries no intent: an OOM-killed client, a
//!    reset connection and an orderly `shutdown(SHUT_WR)` are byte-identical here, so "the stream
//!    ended" cannot be read as "the upload finished". With a length, a short stream is a detectable
//!    failure instead of a truncated file reported as success and then published.
//! 2. **The token names an already-opened descriptor.** Nothing on this wire names a path, so this
//!    connection cannot reach anything the control channel did not already confine.
//! 3. **The preamble reader returns the leftover bytes.** A client that writes the preamble and its
//!    first payload bytes in one syscall is the ordinary case, not an edge case.

use std::io::{Read, Seek, Write};
use std::time::{Duration, Instant};

use crate::audit::{Entry, Outcome, Sink};
use crate::authz::{Decision, Policy};
use crate::seams::{PeerIdentity, SeamError};
use crate::transfer::{guard_in_flight, ClaimError, Direction, PendingTransfer, TransferRegistry};

/// The preamble must arrive quickly; it is one short line the client already has in hand.
pub const PREAMBLE_BUDGET: Duration = Duration::from_secs(10);

/// The preamble's size cap. Exceeding it is a refusal, never a silent truncation at the newline.
pub const MAX_PREAMBLE_BYTES: usize = 256;

/// How long a streaming connection may produce NOTHING before it is cut off.
///
/// An idle budget, re-armed before every read — not a total deadline. Both obvious alternatives are
/// wrong here, and the reason belongs next to the constant:
///
///   * Copying the control channel's absolute deadline kills every legitimate large upload. Ten
///     gigabytes at 100 MB/s needs a hundred seconds; over a slow link, far more.
///   * A bare `SO_RCVTIMEO` set once reinstates the bug P1-D fixed: it bounds ONE `recv(2)`, so a
///     peer sending a byte every 29 seconds re-arms it forever — now on a channel that has many
///     connections rather than one.
///
/// No total deadline is needed on top, because the declared `length` already bounds the transfer.
pub const IDLE_BUDGET: Duration = Duration::from_secs(30);

/// The copy buffer. Fixed, never a growing `Vec`: the memory ceiling of the whole data channel is
/// this times the worker count, and that should be a number someone can read off the source.
const COPY_BUFFER: usize = 64 * 1024;

/// Linux's `ENOSPC` and `EDQUOT`, written as numbers deliberately.
///
/// `std::io::ErrorKind` has no stable variant for either (`StorageFull` and `QuotaExceeded` are
/// both unstable), and `rustix::io::Errno` would be the tidy source but is a unix-only dependency —
/// while this module lives in the core, which ADR-0006 requires to compile for the Windows target
/// so that no `cfg` can creep in. Both values are architecture-independent on Linux
/// (`asm-generic/errno.h`), which is the only platform the agent actually runs on.
const ENOSPC: i32 = 28;
const EDQUOT: i32 = 122;

/// What the client declares before it starts sending.
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preamble {
    pub token: String,
    /// Where the client believes the file currently ends. Checked against the file itself.
    pub offset: u64,
    /// Exactly how many bytes follow. The agent reads this many and stops.
    pub length: u64,
}

/// One line of JSON back to the client.
#[derive(Debug, serde::Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DataReply {
    Ready,
    Stored {
        bytes: u64,
    },
    /// The agent is about to write exactly `bytes` raw bytes. A distinct status from `ready`
    /// because the two mean opposite things about who talks next, and a client that confused them
    /// would sit waiting while the agent sat waiting.
    Sending {
        bytes: u64,
    },
    Failed {
        reason: String,
        kind: FailureKind,
    },
}

/// Why a data transfer failed, in a form the API can branch on.
///
/// ADR-0008 requires the tus layer to answer 507 rather than 500 when a user's `refquota` is
/// exhausted. Without this the only signal is `std::io::Error`'s `Display` — a locale- and
/// kernel-dependent `strerror` string — so meeting that requirement would mean matching
/// `"Disk quota exceeded"` on the wrong side of a trust boundary. The day that match fails, the
/// client sees a 500, calls it transient, and retries the same chunk into the same full dataset
/// forever.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    /// `ENOSPC` or `EDQUOT`. On ZFS this can surface at `fsync` rather than at `write`, because
    /// quota accounting happens at transaction-group commit — so both paths classify.
    OutOfSpace,
    /// Anything else the kernel reported.
    Io,
    /// The caller was wrong: not authorized, an unparseable preamble, no such transfer, a stale
    /// offset, or fewer bytes than it declared. Nothing was written, or what was has been undone.
    Refused,
}

/// Classify an IO error into something the other side can act on.
pub fn classify(error: &std::io::Error) -> FailureKind {
    match error.raw_os_error() {
        Some(ENOSPC | EDQUOT) => FailureKind::OutOfSpace,
        _ => FailureKind::Io,
    }
}

/// Read the preamble line, and hand back whatever arrived after it.
///
/// The leftover is the whole point. `read_request_line_within` — the control channel's reader —
/// appends the entire chunk it read and then runs `String::from_utf8_lossy` over the lot, which is
/// correct there because nothing follows the line. Here, a client that writes the preamble and its
/// first payload bytes in one syscall is the ordinary case: `stream.pipeline(body, socket)` does
/// it, and packet coalescing does it anyway. Reusing that reader would silently replace the first
/// kilobytes of the user's file with U+FFFD, and nothing downstream would notice, because the
/// offset arithmetic stays self-consistent all the way to publish.
pub fn read_preamble(
    stream: &mut impl Read,
    budget: Duration,
    mut arm: impl FnMut(Duration) -> Result<(), SeamError>,
) -> Result<(String, Vec<u8>), SeamError> {
    let deadline = Instant::now() + budget;
    let mut buf: Vec<u8> = Vec::with_capacity(MAX_PREAMBLE_BYTES);
    let mut chunk = [0u8; MAX_PREAMBLE_BYTES];

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(SeamError::Io("preamble did not arrive in time".into()));
        }
        arm(remaining)?;

        let read = match stream.read(&mut chunk) {
            Ok(0) => {
                return Err(SeamError::Io(
                    "connection closed before the preamble".into(),
                ))
            }
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(SeamError::Io(format!("read preamble: {e}"))),
        };

        let data = chunk
            .get(..read)
            .ok_or_else(|| SeamError::Io("short read window out of range".into()))?;

        if let Some(at) = data.iter().position(|b| *b == b'\n') {
            let head = data
                .get(..at)
                .ok_or_else(|| SeamError::Io("newline index out of range".into()))?;
            let tail = data
                .get(at.saturating_add(1)..)
                .ok_or_else(|| SeamError::Io("leftover index out of range".into()))?;
            buf.extend_from_slice(head);
            // Strict, not lossy: the preamble is JSON against a schema the agent published, so
            // invalid UTF-8 is a broken client rather than something to repair silently.
            let line = String::from_utf8(buf)
                .map_err(|_| SeamError::Io("preamble is not valid UTF-8".into()))?;
            return Ok((line, tail.to_vec()));
        }

        buf.extend_from_slice(data);
        // Checked AFTER appending, so the cap counts what arrived rather than what was framed. A
        // preamble at or over the cap is refused, never cut at the limit and parsed as if whole.
        if buf.len() >= MAX_PREAMBLE_BYTES {
            return Err(SeamError::Io(format!(
                "preamble exceeds {MAX_PREAMBLE_BYTES} bytes"
            )));
        }
    }
}

/// Everything the data channel needs, and nothing else.
///
/// Deliberately not `&Agent`. This channel needs the policy, the audit sink and the registry; it
/// never mints a token and never runs a command, so taking the whole struct would force `Sync` onto
/// `TokenSource` and `CommandRunner` and their mocks — contagion bought for nothing.
pub struct DataChannel<'a, S: Sink> {
    pub policy: Policy,
    pub audit: &'a S,
    pub transfers: &'a std::sync::Mutex<TransferRegistry>,
}

impl<S: Sink> DataChannel<'_, S> {
    /// Serve one data connection.
    ///
    /// The order is peer → preamble → registry, and it buys attribution rather than safety. An
    /// earlier version of this comment claimed that looking the token up first would let an
    /// unauthorized caller consume somebody else's live transfer; a mutation test disproved it.
    /// `TransferRegistry::claim` already refuses a mismatched uid and puts the entry back, so
    /// deleting the check below leaves every upload intact — which is exactly why the claim was
    /// worth checking rather than believing.
    ///
    /// What the check does buy is real, and smaller than that: a process that is not the API is
    /// refused before it can drive the preamble parser or reach the registry at all, and the
    /// journal records it as an unauthorized peer instead of as a token error. §16 requires a
    /// privileged call to be explicable afterwards, and "no such transfer" is not an explanation
    /// of a stray local process connecting to the data socket.
    pub fn serve<T: Read + Write>(
        &self,
        stream: &mut T,
        peer: PeerIdentity,
        mut arm_read: impl FnMut(Duration) -> Result<(), SeamError>,
    ) -> Result<(), SeamError> {
        if self.policy.authorize_peer(peer) != Decision::Allow {
            return self.refuse(stream, peer, "caller is not the API uid");
        }

        let (line, leftover) = read_preamble(stream, PREAMBLE_BUDGET, &mut arm_read)?;
        let preamble: Preamble = match serde_json::from_str(&line) {
            Ok(p) => p,
            Err(e) => return self.refuse(stream, peer, &format!("unparseable preamble: {e}")),
        };

        let (mut transfer, key) = {
            let mut registry = self
                .transfers
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match registry.claim(&preamble.token, peer) {
                Ok(claimed) => claimed,
                Err(why) => {
                    let reason = match why {
                        // One answer for both. Telling them apart says whether a token ever
                        // existed, and a token is a secret.
                        ClaimError::Unknown | ClaimError::NotYours => "no such transfer",
                        ClaimError::Expired => "the transfer expired",
                    };
                    return self.refuse(stream, peer, reason);
                }
            }
        };

        // From here the name is marked in flight, and this guard clears it however we return —
        // including by panic. `PublishTransfer` is refused for as long as it lives.
        let _guard = guard_in_flight(self.transfers, key);

        let attempt = match transfer.direction {
            Direction::Receive => {
                self.attempt(stream, &mut arm_read, &mut transfer, &preamble, &leftover)
            }
            // Nothing follows a download's preamble, so a leftover here is a client that sent
            // bytes it was never invited to send. Refused rather than discarded: the only ways to
            // produce it are a broken client and a request smuggled behind a legitimate one.
            Direction::Send if !leftover.is_empty() => {
                Attempt::refused("a download preamble must not be followed by data".to_string())
            }
            Direction::Send => self.send(stream, &mut transfer, &preamble),
        };
        self.record(peer, &transfer, &attempt);

        // A successful download has already written its header AND its body. Writing the reply
        // again here would append a second JSON line to the end of the user's file as the client
        // sees it — the bytes would be right on disk and wrong on the wire, which is the kind of
        // corruption that survives every test that only checks the file.
        let already_answered =
            transfer.direction == Direction::Send && attempt.outcome == Outcome::Allowed;
        if already_answered {
            return Ok(());
        }
        reply(stream, &attempt.reply)
    }

    /// The privileged half: check the offset, take the bytes, make them durable.
    fn attempt<T: Read + Write>(
        &self,
        stream: &mut T,
        arm_read: &mut impl FnMut(Duration) -> Result<(), SeamError>,
        transfer: &mut PendingTransfer,
        preamble: &Preamble,
        leftover: &[u8],
    ) -> Attempt {
        // The offset of record is the FILE, not the number the control channel handed out — that
        // one can be up to `TRANSFER_TTL` stale, and the client may have retried in between.
        let start = match transfer.file.seek(std::io::SeekFrom::End(0)) {
            Ok(at) => at,
            Err(e) => return Attempt::from_io(&e, 0),
        };
        if start != preamble.offset {
            return Attempt::refused(format!(
                "offset mismatch: the file is at {start}, the caller declared {}",
                preamble.offset
            ));
        }

        // Only now, once this connection is going to be honoured, is the client told to send.
        if let Err(e) = reply(stream, &DataReply::Ready) {
            return Attempt::refused(format!("could not acknowledge: {e}"));
        }

        match self.copy_exactly(stream, arm_read, &mut transfer.file, preamble, leftover) {
            Ok(written) => {
                // `fsync` has a failure branch, and it must not be retried on this descriptor:
                // Linux reports a writeback error once per file description (the `errseq_t`
                // sequence), so a second `fsync` can return success having flushed nothing. The
                // rollback is what makes that safe — the bytes are discarded, not silently kept.
                if let Err(e) = transfer.file.sync_all() {
                    self.rollback(&mut transfer.file, start);
                    return Attempt::from_io(&e, start);
                }
                Attempt {
                    reply: DataReply::Stored { bytes: written },
                    outcome: Outcome::Allowed,
                    detail: format!("{written} bytes at offset {start}"),
                }
            }
            Err(CopyError::Io(e)) => {
                self.rollback(&mut transfer.file, start);
                Attempt::from_io(&e, start)
            }
            Err(CopyError::Short { got, want }) => {
                self.rollback(&mut transfer.file, start);
                Attempt::refused(format!("the stream ended after {got} of {want} bytes"))
            }
        }
    }

    /// Write exactly `length` bytes from `offset` back to the client.
    ///
    /// The range is checked against the FILE, not against anything the caller sent. The API has its
    /// own copy of the size in `file_entries`, and that copy can be stale — a file replaced outside
    /// DEPSIS is exactly the case reconciliation exists for — so a range validated there and not
    /// here would let a caller read past the end of a shorter file into whatever the kernel
    /// returns, or be refused for a file that has since grown.
    fn send<T: Read + Write>(
        &self,
        stream: &mut T,
        transfer: &mut PendingTransfer,
        preamble: &Preamble,
    ) -> Attempt {
        let size = match transfer.file.metadata() {
            Ok(meta) => meta.len(),
            Err(e) => return Attempt::from_io(&e, 0),
        };

        // `checked_add`, because `offset + length` on two caller-supplied u64s is where a wrapping
        // sum turns "past the end" into "well inside the file".
        let end = match preamble.offset.checked_add(preamble.length) {
            Some(end) => end,
            None => return Attempt::refused("the requested range overflows".to_string()),
        };
        if end > size {
            return Attempt::refused(format!(
                "the requested range ends at {end}, the file is {size} bytes"
            ));
        }

        if let Err(e) = transfer
            .file
            .seek(std::io::SeekFrom::Start(preamble.offset))
        {
            return Attempt::from_io(&e, 0);
        }

        // The header goes out BEFORE the bytes and is not batched with them. A client that has to
        // guess how many bytes are coming cannot tell a complete short file from a connection that
        // died halfway — which is the same mistake the upload side avoids with a declared length.
        if let Err(e) = reply(
            stream,
            &DataReply::Sending {
                bytes: preamble.length,
            },
        ) {
            return Attempt::refused(format!("could not announce the transfer: {e}"));
        }

        let mut written: u64 = 0;
        let mut buf = [0u8; COPY_BUFFER];
        while written < preamble.length {
            let remaining = preamble.length.saturating_sub(written);
            let take = usize::try_from(remaining)
                .unwrap_or(COPY_BUFFER)
                .min(COPY_BUFFER);
            let window = match buf.get_mut(..take) {
                Some(window) => window,
                None => return Attempt::refused("read window out of range".to_string()),
            };

            let read = match transfer.file.read(window) {
                Ok(0) => {
                    // The file shrank between the size check and here. Nothing can be done for the
                    // bytes already on the wire — the length was announced — so the connection is
                    // failed rather than padded, and the client sees a short read instead of a file
                    // silently filled with something else.
                    return Attempt::refused(format!(
                        "the file ended after {written} of {} bytes",
                        preamble.length
                    ));
                }
                Ok(n) => n,
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Attempt::from_io(&e, 0),
            };

            let data = match window.get(..read) {
                Some(data) => data,
                None => return Attempt::refused("short read out of range".to_string()),
            };
            if let Err(e) = stream.write_all(data) {
                return Attempt::from_io(&e, 0);
            }
            written = written.saturating_add(read as u64);
        }

        if let Err(e) = stream.flush() {
            return Attempt::from_io(&e, 0);
        }

        Attempt {
            // Already sent, before the body. Reusing it here would put a second header AFTER the
            // bytes and corrupt the download, so the reply this attempt carries is the one already
            // on the wire and `serve` must not write it again.
            reply: DataReply::Sending {
                bytes: preamble.length,
            },
            outcome: Outcome::Allowed,
            detail: format!("{written} bytes from offset {}", preamble.offset),
        }
    }

    /// Copy exactly `length` bytes, starting with whatever came in the preamble's packet.
    fn copy_exactly<T: Read>(
        &self,
        stream: &mut T,
        arm_read: &mut impl FnMut(Duration) -> Result<(), SeamError>,
        file: &mut std::fs::File,
        preamble: &Preamble,
        leftover: &[u8],
    ) -> Result<u64, CopyError> {
        let want = preamble.length;
        let mut written: u64 = 0;

        // The leftover FIRST. These bytes are already out of the socket; forgetting them is how the
        // head of every fast upload disappears.
        if !leftover.is_empty() {
            let take = usize::try_from(want.min(leftover.len() as u64)).unwrap_or(leftover.len());
            let head = leftover.get(..take).ok_or_else(|| {
                CopyError::Io(std::io::Error::other("leftover window out of range"))
            })?;
            file.write_all(head).map_err(CopyError::Io)?;
            written = written.saturating_add(take as u64);
        }

        let mut buf = [0u8; COPY_BUFFER];
        while written < want {
            // Re-armed before EVERY read, which is what makes `IDLE_BUDGET` an idle budget rather
            // than a decoration. Arming once outside the loop would bound one `recv(2)` and let a
            // peer trickling a byte every 29 seconds hold a worker open indefinitely.
            arm_read(IDLE_BUDGET).map_err(|e| {
                CopyError::Io(std::io::Error::other(format!(
                    "could not arm the read: {e}"
                )))
            })?;

            let remaining = want.saturating_sub(written);
            let take = usize::try_from(remaining)
                .unwrap_or(COPY_BUFFER)
                .min(COPY_BUFFER);
            let window = buf
                .get_mut(..take)
                .ok_or_else(|| CopyError::Io(std::io::Error::other("copy window out of range")))?;

            match stream.read(window) {
                // Short, not "finished". The declared length is what says an upload is complete; an
                // early EOF is a client that died, and treating it as success is how a truncated
                // file gets fsynced and published as whole.
                Ok(0) => return Err(CopyError::Short { got: written, want }),
                Ok(n) => {
                    let data = window.get(..n).ok_or_else(|| {
                        CopyError::Io(std::io::Error::other("read window out of range"))
                    })?;
                    file.write_all(data).map_err(CopyError::Io)?;
                    written = written.saturating_add(n as u64);
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(CopyError::Io(e)),
            }
        }
        Ok(written)
    }

    /// Put the file back exactly where this connection found it.
    ///
    /// Without this, every failed chunk is permanent damage: the API cannot write inside a share to
    /// repair it, and the staging file's own length is what the next attempt resumes from — so a
    /// half-written chunk would make the retry land at the wrong offset and corrupt the result
    /// silently rather than fail.
    fn rollback(&self, file: &mut std::fs::File, to: u64) {
        if let Err(e) = file.set_len(to) {
            // There is nothing better available: the connection is already failing and the client
            // is about to be told so. Saying it out loud is what stops it being invisible — this is
            // the one case where the staging file is left in a state the next attempt cannot use.
            eprintln!("depsis-agent: could not roll back a failed transfer to offset {to}: {e}");
        }
    }

    /// Refuse before any file is involved.
    ///
    /// The audit entry carries no correlation id because there is none: either the caller was not
    /// the API, or its preamble named nothing the registry knows. Writing the token in here instead
    /// would put a live credential in the journal.
    fn refuse<T: Write>(
        &self,
        stream: &mut T,
        peer: PeerIdentity,
        reason: &str,
    ) -> Result<(), SeamError> {
        self.audit.record(Entry {
            correlation_id: "-".to_string(),
            uid: peer.uid,
            pid: peer.pid,
            operation: "data_transfer",
            reason: "-".to_string(),
            outcome: Outcome::Refused(reason.to_string()),
        });
        reply(
            stream,
            &DataReply::Failed {
                reason: reason.to_string(),
                kind: FailureKind::Refused,
            },
        )
    }

    /// One audit entry per data connection that reached a transfer.
    ///
    /// §16 requires a privileged call to be explicable afterwards. Without this the journal shows
    /// `open_transfer` and `publish_transfer` and says nothing about who wrote the bytes, how many,
    /// or whether it was refused — so the requirement would hold for the two cheap operations and
    /// fail for the one that writes user data as root.
    ///
    /// The correlation id comes from the registry, never from the data wire: accepting it there
    /// would let the unprivileged side author its own audit metadata.
    fn record(&self, peer: PeerIdentity, transfer: &PendingTransfer, attempt: &Attempt) {
        self.audit.record(Entry {
            correlation_id: transfer.correlation_id.clone(),
            uid: peer.uid,
            pid: peer.pid,
            operation: "data_transfer",
            reason: format!(
                "{}/{}: {} ({})",
                transfer.share, transfer.staging_name, attempt.detail, transfer.reason
            ),
            outcome: attempt.outcome.clone(),
        });
    }
}

/// The result of one attempted transfer: what the client is told, and what the journal records.
///
/// One value carrying both, because the two must agree. Building the reply in one place and the
/// audit entry in another is how a connection comes to answer `stored` while the journal says
/// `failed` — and the journal is the thing nobody re-reads until it matters.
struct Attempt {
    reply: DataReply,
    outcome: Outcome,
    detail: String,
}

impl Attempt {
    fn refused(reason: String) -> Self {
        Self {
            outcome: Outcome::Refused(reason.clone()),
            detail: reason.clone(),
            reply: DataReply::Failed {
                reason,
                kind: FailureKind::Refused,
            },
        }
    }

    fn from_io(error: &std::io::Error, start: u64) -> Self {
        let kind = classify(error);
        let reason = error.to_string();
        Self {
            outcome: Outcome::Failed(reason.clone()),
            detail: format!("{reason}; rolled back to offset {start}"),
            reply: DataReply::Failed { reason, kind },
        }
    }
}

enum CopyError {
    Io(std::io::Error),
    Short { got: u64, want: u64 },
}

fn reply<T: Write>(stream: &mut T, reply: &DataReply) -> Result<(), SeamError> {
    let line =
        serde_json::to_string(reply).map_err(|e| SeamError::Io(format!("serialise reply: {e}")))?;
    stream
        .write_all(line.as_bytes())
        .and_then(|()| stream.write_all(b"\n"))
        .and_then(|()| stream.flush())
        .map_err(|e| SeamError::Io(format!("write reply: {e}")))
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "The crate-level denials exist because a panic in a root daemon is a denial of \
              service on the one component that cannot be restarted casually. In tests the \
              opposite is true: a failed assertion SHOULD panic, and indexing a fixture is \
              clearer than unwrapping an Option."
)]
mod tests {
    use super::*;
    use crate::audit::MemorySink;
    use std::cell::Cell;
    use std::sync::Mutex;

    const API: PeerIdentity = PeerIdentity {
        uid: 999,
        gid: 999,
        pid: 4242,
    };
    const STRANGER: PeerIdentity = PeerIdentity {
        uid: 1000,
        gid: 1000,
        pid: 4243,
    };
    const POLICY: Policy = Policy { api_uid: 999 };

    /// A socket the test drives byte for byte.
    ///
    /// Chunk boundaries are the point of this fake rather than an implementation detail: the two
    /// bugs this module exists to prevent — losing the bytes that share a packet with the preamble,
    /// and calling a short stream a finished upload — are both invisible unless the test can say
    /// exactly how the data was split.
    struct Wire {
        inbound: Vec<Vec<u8>>,
        outbound: Vec<u8>,
    }

    impl Wire {
        fn new(chunks: &[&[u8]]) -> Self {
            Self {
                inbound: chunks.iter().map(|c| c.to_vec()).collect(),
                outbound: Vec::new(),
            }
        }

        /// The replies the agent wrote, one per line.
        fn replies(&self) -> Vec<serde_json::Value> {
            String::from_utf8_lossy(&self.outbound)
                .lines()
                .filter(|l| !l.is_empty())
                .map(|l| serde_json::from_str(l).expect("the agent must answer in JSON"))
                .collect()
        }

        fn last_reply(&self) -> serde_json::Value {
            self.replies().pop().expect("at least one reply")
        }
    }

    impl Read for Wire {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.inbound.is_empty() {
                return Ok(0);
            }
            let chunk = self.inbound.remove(0);
            let n = chunk.len().min(buf.len());
            buf[..n].copy_from_slice(&chunk[..n]);
            if n < chunk.len() {
                self.inbound.insert(0, chunk[n..].to_vec());
            }
            Ok(n)
        }
    }

    impl Write for Wire {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.outbound.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// A registry holding one transfer over a real file, plus the directory keeping it alive.
    struct Fixture {
        _dir: tempfile::TempDir,
        path: std::path::PathBuf,
        registry: Mutex<TransferRegistry>,
        audit: MemorySink,
    }

    fn fixture(initial: &[u8], opened_by: PeerIdentity) -> Fixture {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("chunk.part");
        std::fs::write(&path, initial).expect("seed the staging file");
        let file = std::fs::OpenOptions::new()
            .read(true)
            .append(true)
            .open(&path)
            .expect("open the staging file");

        let mut registry = TransferRegistry::new();
        registry
            .insert(
                "tok".to_string(),
                PendingTransfer {
                    file,
                    direction: Direction::Receive,
                    share: "alice".to_string(),
                    staging_name: "chunk.part".to_string(),
                    opened_by,
                    correlation_id: "req-7".to_string(),
                    reason: "tus PATCH".to_string(),
                    opened_at: Instant::now(),
                },
            )
            .expect("insert");

        Fixture {
            _dir: dir,
            path,
            registry: Mutex::new(registry),
            audit: MemorySink::default(),
        }
    }

    impl Fixture {
        fn channel(&self) -> DataChannel<'_, MemorySink> {
            DataChannel {
                policy: POLICY,
                audit: &self.audit,
                transfers: &self.registry,
            }
        }

        fn contents(&self) -> Vec<u8> {
            std::fs::read(&self.path).expect("read back the staging file")
        }
    }

    fn never_fails(_: Duration) -> Result<(), SeamError> {
        Ok(())
    }

    fn preamble_line(offset: u64, length: u64) -> Vec<u8> {
        format!("{{\"token\":\"tok\",\"offset\":{offset},\"length\":{length}}}\n").into_bytes()
    }

    // ── the leftover ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn the_bytes_sharing_a_packet_with_the_preamble_are_not_lost() {
        // The ordinary case for any client that pipes a body straight into the socket. If the
        // leftover were dropped the file would still end up `length` bytes long — the copy loop
        // would simply read further — so the corruption is silent and survives to publish.
        let f = fixture(b"", API);
        let mut wire = Wire::new(&[b"{\"token\":\"tok\",\"offset\":0,\"length\":11}\nhello world"]);

        f.channel()
            .serve(&mut wire, API, never_fails)
            .expect("serve");

        assert_eq!(f.contents(), b"hello world");
        assert_eq!(
            wire.last_reply(),
            serde_json::json!({"status": "stored", "bytes": 11})
        );
    }

    #[test]
    fn read_preamble_hands_back_exactly_what_followed_the_newline() {
        let mut wire = Wire::new(&[b"{\"a\":1}\nAB", b"CD"]);
        let (line, leftover) =
            read_preamble(&mut wire, PREAMBLE_BUDGET, never_fails).expect("preamble");
        assert_eq!(line, "{\"a\":1}");
        assert_eq!(leftover, b"AB");
    }

    #[test]
    fn a_preamble_at_the_cap_is_refused_rather_than_cut_at_it() {
        // Truncating at the limit and parsing the head is the dangerous failure: a caller could
        // pad past the cap and have the agent act on a `length` it never sent.
        let flood = vec![b'x'; MAX_PREAMBLE_BYTES + 16];
        let mut wire = Wire::new(&[&flood]);
        let err = read_preamble(&mut wire, PREAMBLE_BUDGET, never_fails)
            .expect_err("an oversized preamble must be refused");
        assert!(
            format!("{err}").contains("exceeds"),
            "the refusal must say why: {err}"
        );
    }

    // ── the declared length ──────────────────────────────────────────────────────────────────

    #[test]
    fn a_stream_that_ends_early_is_a_failure_and_the_file_is_put_back() {
        // The single most important property in this file. Without it a client that dies mid-chunk
        // produces a shorter file that is fsynced, reported `stored`, and then published as whole.
        let f = fixture(b"already", API);
        let mut wire = Wire::new(&[&preamble_line(7, 10), b"abcd"]);

        f.channel()
            .serve(&mut wire, API, never_fails)
            .expect("serve");

        assert_eq!(
            f.contents(),
            b"already",
            "a failed transfer must leave the file byte for byte as it found it"
        );
        let reply = wire.last_reply();
        assert_eq!(reply["status"], "failed");
        assert_eq!(reply["kind"], "refused");
        assert!(
            reply["reason"]
                .as_str()
                .unwrap_or_default()
                .contains("4 of 10"),
            "the client must be told how far it got: {reply}"
        );
    }

    #[test]
    fn a_client_that_keeps_talking_past_its_declared_length_is_ignored() {
        // The other half of the same guarantee: the length bounds the read, so trailing bytes
        // cannot extend the file. Without it a chunk followed by junk would leave the staging file
        // longer than the offset the API believes it is at, and the next chunk would land wrong.
        let f = fixture(b"", API);
        let mut wire = Wire::new(&[&preamble_line(0, 5), b"hello", b"MORE MORE MORE"]);

        f.channel()
            .serve(&mut wire, API, never_fails)
            .expect("serve");

        assert_eq!(f.contents(), b"hello");
    }

    #[test]
    fn the_stated_offset_must_match_the_file_itself() {
        // The control channel's offset can be up to TRANSFER_TTL stale. Trusting it would append a
        // chunk on top of one already written and silently duplicate that region.
        let f = fixture(b"twelve bytes", API);
        let mut wire = Wire::new(&[&preamble_line(0, 3), b"abc"]);

        f.channel()
            .serve(&mut wire, API, never_fails)
            .expect("serve");

        assert_eq!(f.contents(), b"twelve bytes");
        let reply = wire.last_reply();
        assert_eq!(reply["status"], "failed");
        assert_eq!(reply["kind"], "refused");
        assert!(
            wire.replies().iter().all(|r| r["status"] != "ready"),
            "a refused transfer must never be told to start sending"
        );
    }

    // ── who may connect ──────────────────────────────────────────────────────────────────────

    #[test]
    fn an_unauthorized_peer_is_refused_and_the_transfer_survives_it() {
        // Note what this does NOT prove. Deleting the peer check in `serve` leaves both assertions
        // below green, because the registry independently refuses a mismatched uid and puts the
        // entry back. The surviving token is the registry's doing, not the policy's — which is why
        // the attribution test underneath exists and why `serve`'s comment says so.
        let f = fixture(b"", API);
        let mut theirs = Wire::new(&[&preamble_line(0, 4), b"evil"]);
        f.channel()
            .serve(&mut theirs, STRANGER, never_fails)
            .expect("serve");
        assert_eq!(theirs.last_reply()["status"], "failed");
        assert_eq!(f.contents(), b"");

        // The token still works for its owner.
        let mut ours = Wire::new(&[&preamble_line(0, 4), b"good"]);
        f.channel()
            .serve(&mut ours, API, never_fails)
            .expect("serve");
        assert_eq!(f.contents(), b"good");
    }

    #[test]
    fn a_stranger_is_journalled_as_a_stranger_not_as_a_bad_token() {
        // This is what the peer check actually earns, and the only assertion in this file that
        // fails when it is removed. Without it every non-API process reaching the data socket is
        // recorded as `no such transfer` — indistinguishable from an expired upload — and §16's
        // requirement that a privileged call be explicable afterwards quietly stops holding for
        // the one connection that writes user data as root.
        let f = fixture(b"", API);
        let mut wire = Wire::new(&[&preamble_line(0, 4), b"evil"]);
        f.channel()
            .serve(&mut wire, STRANGER, never_fails)
            .expect("serve");

        let entries = f.audit.entries();
        let Outcome::Refused(ref why) = entries[0].outcome else {
            panic!(
                "an unauthorized peer must be recorded as refused: {:?}",
                entries[0]
            );
        };
        assert!(
            why.contains("not the API uid"),
            "the journal must say the caller was the wrong process, not that its token was bad: {why}"
        );
        assert_eq!(
            wire.last_reply()["reason"],
            "caller is not the API uid",
            "and the client is told the same thing, so a misconfigured API uid is diagnosable"
        );
    }

    #[test]
    fn a_token_opened_by_one_uid_is_not_usable_by_another() {
        let f = fixture(b"", STRANGER);
        let mut wire = Wire::new(&[&preamble_line(0, 4), b"evil"]);
        f.channel()
            .serve(&mut wire, API, never_fails)
            .expect("serve");
        assert_eq!(f.contents(), b"");
        assert_eq!(wire.last_reply()["reason"], "no such transfer");
    }

    #[test]
    fn an_unknown_token_and_a_stolen_one_read_identically() {
        // Two connections, two different underlying causes, one answer. A distinguishable refusal
        // turns the data socket into an oracle for whether a given token exists.
        let mine = fixture(b"", API);
        let mut unknown = Wire::new(&[b"{\"token\":\"nope\",\"offset\":0,\"length\":1}\nx"]);
        mine.channel()
            .serve(&mut unknown, API, never_fails)
            .expect("serve");

        let theirs = fixture(b"", STRANGER);
        let mut stolen = Wire::new(&[&preamble_line(0, 1), b"x"]);
        theirs
            .channel()
            .serve(&mut stolen, API, never_fails)
            .expect("serve");

        assert_eq!(unknown.last_reply(), stolen.last_reply());
    }

    #[test]
    fn a_transfer_can_be_claimed_only_once() {
        let f = fixture(b"", API);
        let mut first = Wire::new(&[&preamble_line(0, 2), b"hi"]);
        f.channel()
            .serve(&mut first, API, never_fails)
            .expect("serve");
        assert_eq!(first.last_reply()["status"], "stored");

        let mut replay = Wire::new(&[&preamble_line(2, 2), b"no"]);
        f.channel()
            .serve(&mut replay, API, never_fails)
            .expect("serve");
        assert_eq!(replay.last_reply()["reason"], "no such transfer");
        assert_eq!(f.contents(), b"hi");
    }

    // ── the interlock ────────────────────────────────────────────────────────────────────────

    #[test]
    fn the_name_is_free_again_once_the_connection_ends() {
        // `PublishTransfer` consults `is_busy` before it renames. If the mark outlived the
        // connection the file could never be published; if it were never set, a publish arriving
        // mid-stream would rename a half-written file into the user's tree.
        let f = fixture(b"", API);
        let mut wire = Wire::new(&[&preamble_line(0, 2), b"hi"]);

        f.channel()
            .serve(&mut wire, API, never_fails)
            .expect("serve");

        let registry = f.registry.lock().expect("lock");
        assert!(!registry.is_busy("alice", "chunk.part"));
        assert_eq!(registry.in_flight_count(), 0);
        assert_eq!(registry.pending_count(), 0);
    }

    #[test]
    fn a_failed_transfer_also_releases_the_name() {
        let f = fixture(b"", API);
        let mut wire = Wire::new(&[&preamble_line(0, 99), b"short"]);
        f.channel()
            .serve(&mut wire, API, never_fails)
            .expect("serve");
        assert!(!f
            .registry
            .lock()
            .expect("lock")
            .is_busy("alice", "chunk.part"));
    }

    // ── the idle budget ──────────────────────────────────────────────────────────────────────

    #[test]
    fn the_read_deadline_is_re_armed_before_every_read_not_once() {
        // A single `set_read_timeout` before the loop bounds one `recv(2)`. A peer sending one byte
        // just inside the budget re-arms it forever and holds a worker for as long as it likes —
        // the exact bug P1-D found on the control socket, and the reason this closure is threaded
        // down into the copy loop rather than called once at the top of `serve`.
        let f = fixture(b"", API);
        let mut wire = Wire::new(&[&preamble_line(0, 4), b"a", b"b", b"c", b"d"]);
        let arms = Cell::new(0_usize);

        f.channel()
            .serve(&mut wire, API, |budget| {
                if budget == IDLE_BUDGET {
                    arms.set(arms.get().saturating_add(1));
                }
                Ok(())
            })
            .expect("serve");

        assert_eq!(
            arms.get(),
            4,
            "one arming per payload read, not one for the whole connection"
        );
    }

    // ── the send direction ───────────────────────────────────────────────────────────────────

    /// A registry holding one READABLE file under a token.
    fn readable(contents: &[u8], opened_by: PeerIdentity) -> Fixture {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("rapor.txt");
        std::fs::write(&path, contents).expect("seed the published file");
        let file = std::fs::File::open(&path).expect("open for reading");

        let mut registry = TransferRegistry::new();
        registry
            .insert(
                "tok".to_string(),
                PendingTransfer {
                    file,
                    direction: Direction::Send,
                    share: "alice".to_string(),
                    staging_name: "Belgeler/rapor.txt".to_string(),
                    opened_by,
                    correlation_id: "req-9".to_string(),
                    reason: "GET /files/{id}/content".to_string(),
                    opened_at: Instant::now(),
                },
            )
            .expect("insert");

        Fixture {
            _dir: dir,
            path,
            registry: Mutex::new(registry),
            audit: MemorySink::default(),
        }
    }

    /// Split a download connection's output into its header line and the raw bytes after it.
    fn split_download(wire: &Wire) -> (serde_json::Value, Vec<u8>) {
        let at = wire
            .outbound
            .iter()
            .position(|b| *b == b'\n')
            .expect("the agent must announce the transfer before sending");
        let header = serde_json::from_slice(&wire.outbound[..at]).expect("a JSON header");
        (header, wire.outbound[at + 1..].to_vec())
    }

    #[test]
    fn a_download_announces_its_length_and_then_sends_exactly_that() {
        let f = readable(b"hello world", API);
        let mut wire = Wire::new(&[&preamble_line(0, 11)]);

        f.channel()
            .serve(&mut wire, API, never_fails)
            .expect("serve");

        let (header, body) = split_download(&wire);
        assert_eq!(
            header,
            serde_json::json!({"status": "sending", "bytes": 11})
        );
        assert_eq!(body, b"hello world");
    }

    #[test]
    fn a_range_reads_from_the_middle_of_the_file() {
        // The preamble's `offset` and `length` ARE an HTTP Range. Getting this wrong in either
        // direction produces a file that downloads without error and is wrong in the middle.
        let f = readable(b"0123456789", API);
        let mut wire = Wire::new(&[&preamble_line(3, 4)]);

        f.channel()
            .serve(&mut wire, API, never_fails)
            .expect("serve");

        let (header, body) = split_download(&wire);
        assert_eq!(header["bytes"], 4);
        assert_eq!(body, b"3456");
    }

    #[test]
    fn nothing_is_sent_after_the_body() {
        // `serve` writes the attempt's reply at the end for every other kind of connection. On a
        // successful download the header is already on the wire and the body after it, so writing
        // it again would append a JSON line to the end of the user's file as the client sees it —
        // right on disk, wrong on the wire, and invisible to any test that only checks the file.
        let f = readable(b"abc", API);
        let mut wire = Wire::new(&[&preamble_line(0, 3)]);

        f.channel()
            .serve(&mut wire, API, never_fails)
            .expect("serve");

        let (_, body) = split_download(&wire);
        assert_eq!(body, b"abc", "exactly the file, with nothing appended");
    }

    #[test]
    fn a_range_past_the_end_is_refused_before_a_byte_is_sent() {
        // Checked against the FILE, not against the caller's arithmetic. The API keeps its own copy
        // of the size in `file_entries` and that copy can be stale, so a range validated only there
        // would read past the end of a file that has since been replaced by a shorter one.
        let f = readable(b"short", API);
        let mut wire = Wire::new(&[&preamble_line(0, 500)]);

        f.channel()
            .serve(&mut wire, API, never_fails)
            .expect("serve");

        let reply = wire.last_reply();
        assert_eq!(reply["status"], "failed");
        assert_eq!(reply["kind"], "refused");
        assert!(
            wire.replies().iter().all(|r| r["status"] != "sending"),
            "a refused range must never announce a transfer"
        );
    }

    #[test]
    fn a_range_whose_end_overflows_is_refused_rather_than_wrapping() {
        // `offset + length` on two caller-supplied u64s is where a wrapping sum turns "far past the
        // end" into "well inside the file", and the bounds check then passes.
        let f = readable(b"short", API);
        let mut wire = Wire::new(&[&preamble_line(u64::MAX, 8)]);

        f.channel()
            .serve(&mut wire, API, never_fails)
            .expect("serve");

        assert_eq!(wire.last_reply()["status"], "failed");
        assert!(
            wire.replies().iter().all(|r| r["status"] != "sending"),
            "an overflowing range must never announce a transfer"
        );
    }

    #[test]
    fn a_zero_length_download_is_a_valid_empty_answer() {
        // An empty file is a file. Refusing it would make every zero-byte upload undownloadable.
        let f = readable(b"", API);
        let mut wire = Wire::new(&[&preamble_line(0, 0)]);

        f.channel()
            .serve(&mut wire, API, never_fails)
            .expect("serve");

        let (header, body) = split_download(&wire);
        assert_eq!(header["bytes"], 0);
        assert!(body.is_empty());
    }

    #[test]
    fn a_download_preamble_followed_by_data_is_refused() {
        // Nothing follows a download's preamble. Bytes here are a broken client at best and a
        // second request smuggled behind a legitimate one at worst.
        let f = readable(b"hello", API);
        let mut wire = Wire::new(&[b"{\"token\":\"tok\",\"offset\":0,\"length\":5}\nEXTRA"]);

        f.channel()
            .serve(&mut wire, API, never_fails)
            .expect("serve");

        assert_eq!(wire.last_reply()["status"], "failed");
    }

    #[test]
    fn a_download_is_audited_like_every_other_privileged_read() {
        // §16 does not distinguish reading a tenant's file from writing one: both are the agent
        // touching user data as root, and both have to be explicable afterwards.
        let f = readable(b"hello", API);
        let mut wire = Wire::new(&[&preamble_line(1, 3)]);

        f.channel()
            .serve(&mut wire, API, never_fails)
            .expect("serve");

        let entries = f.audit.entries();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].outcome, Outcome::Allowed);
        assert_eq!(entries[0].correlation_id, "req-9");
        assert!(
            entries[0].reason.contains("Belgeler/rapor.txt"),
            "the journal must name what was read: {}",
            entries[0].reason
        );
    }

    #[test]
    fn a_downloads_token_belongs_to_the_uid_that_opened_it() {
        // The same rule as an upload, and it matters more here: a leaked download token is a read
        // of another tenant's file rather than a write into one's own.
        let f = readable(b"secret", STRANGER);
        let mut wire = Wire::new(&[&preamble_line(0, 6)]);

        f.channel()
            .serve(&mut wire, API, never_fails)
            .expect("serve");

        assert_eq!(wire.last_reply()["reason"], "no such transfer");
        assert!(wire.replies().iter().all(|r| r["status"] != "sending"));
    }

    // ── failure classification ───────────────────────────────────────────────────────────────

    #[test]
    fn out_of_space_is_distinguishable_from_every_other_io_error() {
        // ADR-0008 needs 507 rather than 500 when a tenant's refquota is full. The only alternative
        // is matching on `strerror` text across a trust boundary, in whatever locale the daemon
        // happens to be running under.
        assert_eq!(
            classify(&std::io::Error::from_raw_os_error(ENOSPC)),
            FailureKind::OutOfSpace
        );
        assert_eq!(
            classify(&std::io::Error::from_raw_os_error(EDQUOT)),
            FailureKind::OutOfSpace,
            "a per-dataset quota is the common case on ZFS, and it is not ENOSPC"
        );
        assert_eq!(
            classify(&std::io::Error::from_raw_os_error(5)),
            FailureKind::Io
        );
        assert_eq!(
            classify(&std::io::Error::other("no errno at all")),
            FailureKind::Io
        );
    }

    // ── the journal ──────────────────────────────────────────────────────────────────────────

    #[test]
    fn every_data_connection_leaves_exactly_one_audit_entry() {
        let f = fixture(b"", API);
        let mut wire = Wire::new(&[&preamble_line(0, 2), b"hi"]);
        f.channel()
            .serve(&mut wire, API, never_fails)
            .expect("serve");

        let entries = f.audit.entries();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].operation, "data_transfer");
        assert_eq!(entries[0].outcome, Outcome::Allowed);
        assert_eq!(entries[0].uid, API.uid);
        assert_eq!(entries[0].pid, API.pid);
    }

    #[test]
    fn the_correlation_id_is_the_registrys_and_never_the_wires() {
        // §16: the unprivileged side must not be able to author its own audit metadata. The
        // preamble is `deny_unknown_fields`, so it cannot even carry one — this asserts that the
        // value which does get recorded came from the control call that opened the transfer.
        let f = fixture(b"", API);
        let mut wire = Wire::new(&[&preamble_line(0, 2), b"hi"]);
        f.channel()
            .serve(&mut wire, API, never_fails)
            .expect("serve");

        let entries = f.audit.entries();
        assert_eq!(entries[0].correlation_id, "req-7");
        assert!(
            entries[0].reason.contains("tus PATCH"),
            "the reason given at OpenTransfer must survive to the data connection: {}",
            entries[0].reason
        );
    }

    #[test]
    fn a_refused_connection_is_audited_too_and_carries_no_token() {
        let f = fixture(b"", API);
        let mut wire = Wire::new(&[&preamble_line(0, 4), b"evil"]);
        f.channel()
            .serve(&mut wire, STRANGER, never_fails)
            .expect("serve");

        let entries = f.audit.entries();
        assert_eq!(entries.len(), 1);
        assert!(matches!(entries[0].outcome, Outcome::Refused(_)));
        assert_eq!(entries[0].uid, STRANGER.uid);
        assert!(
            !format!("{:?}", entries[0]).contains("tok"),
            "a live token must never reach the journal: {:?}",
            entries[0]
        );
    }

    #[test]
    fn an_unparseable_preamble_is_refused_without_touching_the_registry() {
        let f = fixture(b"", API);
        let mut wire = Wire::new(&[b"not json at all\n"]);
        f.channel()
            .serve(&mut wire, API, never_fails)
            .expect("serve");

        assert_eq!(wire.last_reply()["kind"], "refused");
        assert_eq!(
            f.registry.lock().expect("lock").pending_count(),
            1,
            "a broken preamble must not consume the transfer it failed to name"
        );
    }
}
