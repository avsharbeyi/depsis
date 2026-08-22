//! Request dispatch — the single chokepoint every privileged operation passes through.
//!
//! Order matters and is not negotiable:
//!
//!   parse → authorize → audit(intent) → execute → audit(outcome)
//!
//! Parsing first means a malformed or flag-shaped operand is refused before any identity work,
//! and an unparseable request never reaches an executor. Auditing intent *before* execution
//! means a call that hangs or crashes the agent still left a trace of what was attempted.

use crate::audit::{self, Outcome, Sink};
use crate::authz::{Decision, Policy};
use crate::op::{AclType, Request, Response, SCHEMA_VERSION};
use crate::seams::{CommandRunner, OpenIntent, PeerIdentity, SafePath, SeamError, TokenSource};
use crate::transfer::{
    Abandoned, Direction, InsertError, PendingTransfer, TransferRegistry, MAX_PENDING_TRANSFERS,
};
use crate::zerotier::{self, ZeroTierError};
use std::io::Seek;
use std::sync::Mutex;

/// Absolute paths only.
///
/// `execvp` falls back to searching `/bin:/usr/bin` when `PATH` is unset, so a relative program
/// name is a supply chain question rather than a convenience. These constants are the complete
/// set of binaries the agent will ever run.
pub mod bin {
    pub const ZFS: &str = "/usr/sbin/zfs";
    pub const ZPOOL: &str = "/usr/sbin/zpool";
    pub const SMARTCTL: &str = "/usr/sbin/smartctl";
    pub const TESTPARM: &str = "/usr/bin/testparm";
}

/// Where staging files live inside a share.
///
/// Literal components, never caller-supplied. ADR-0008 keeps staging INSIDE the destination
/// dataset so publishing is an O(1) same-dataset rename rather than a copy — a separate staging
/// dataset would mean writing every byte twice and doubling the user's quota mid-upload.
pub const STAGING_DIR: [&str; 2] = [".depsis", "staging"];

fn depsis_agent_max_pending() -> usize {
    MAX_PENDING_TRANSFERS
}

/// Turn a ZeroTier client error into the answer the API needs.
///
/// The split IS ADR-0020's third rule. "Not installed" and "not running" are ordinary states of a
/// box — DEPSIS packages neither ZeroTier nor podman — and the API turns them into 503 with a
/// card that explains itself. Everything else is a fault: it goes back as an error so that
/// `handle` audits it as one, because a misconfigured daemon that reports itself as merely absent
/// is a bug nobody goes looking for.
fn zerotier_error(e: ZeroTierError) -> Result<Response, SeamError> {
    if e.is_unavailable() {
        Ok(Response::ZeroTierUnavailable {
            reason: e.to_string(),
        })
    } else {
        Err(SeamError::Io(e.to_string()))
    }
}

pub struct Agent<'a, R: CommandRunner, S: Sink, P: SafePath> {
    pub policy: Policy,
    pub runner: &'a R,
    pub audit: &'a S,
    /// The share tree, confined by `openat2`. `None` on a box with no storage configured yet,
    /// which is the normal state of a NAS before setup — the transfer operations then refuse,
    /// with a reason, rather than the agent refusing to start at all.
    pub paths: Option<&'a P>,
    /// Deliberately NOT `+ Sync`, unlike `Sink`.
    ///
    /// The design review recommended making every one of `Agent`'s shared types `Sync` so the whole
    /// struct could cross into the data channel's worker threads. Passing the whole struct is what
    /// makes that necessary, and passing less is better: the data channel needs the policy, the
    /// audit sink and the confined paths, and it never mints a token or runs a command. Requiring
    /// `Sync` here would spread the constraint to `MockTokenSource` and, by the same argument,
    /// `CommandRunner` and `MockCommandRunner` — contagion bought for nothing.
    pub tokens: &'a dyn TokenSource,
    /// Shared with the data socket's accept loop, which runs concurrently with this one. The
    /// control loop is deliberately serial (ADR-0006), but bulk transfers must not be: a 10 GB
    /// upload holding the control socket would block every other privileged call for its duration.
    pub transfers: &'a Mutex<TransferRegistry>,
}

impl<'a, R: CommandRunner, S: Sink, P: SafePath> Agent<'a, R, S, P> {
    pub fn new(
        policy: Policy,
        runner: &'a R,
        audit: &'a S,
        paths: Option<&'a P>,
        tokens: &'a dyn TokenSource,
        transfers: &'a Mutex<TransferRegistry>,
    ) -> Self {
        Self {
            policy,
            runner,
            audit,
            paths,
            tokens,
            transfers,
        }
    }

    /// Open the staging file and hand back a token for the data channel.
    ///
    /// The resolution happens HERE, once, and the descriptor is what survives. The token names
    /// that descriptor; nothing the caller sends on the data socket can change which file it
    /// writes to. That is the property which makes splitting one upload across two connections
    /// safe, and it is why the data socket takes a token rather than repeating the file name.
    fn open_transfer(
        &self,
        share: &str,
        staging_name: &str,
        peer: PeerIdentity,
        correlation_id: &str,
        reason: &str,
    ) -> Result<Response, SeamError> {
        let Some(paths) = self.paths else {
            return Ok(Response::Refused {
                reason: "no share root is configured; storage is not set up".to_string(),
            });
        };

        let relative = [share, STAGING_DIR[0], STAGING_DIR[1], staging_name];
        // Append, not CreateNew: tus uploads resume, and the second PATCH for one upload must
        // continue the same `.part` rather than being refused for existing.
        let mut file = paths.open(&relative, OpenIntent::Append)?;

        // Where a resumed upload continues from. Read from the file itself rather than tracked
        // separately: a number kept beside the data is a number that can disagree with it.
        let offset = file
            .seek(std::io::SeekFrom::End(0))
            .map_err(|e| SeamError::Io(format!("seek staging file: {e}")))?;

        let token = self.tokens.token();

        // Poison is RECOVERED, not treated as fatal. Refusing on a poisoned mutex means refusing
        // forever, for every tenant, while the process stays alive — so `Restart=on-failure` never
        // fires, `ping` still answers and telemetry stays green. That is neither recovering nor
        // dying, which is the worst of the three.
        //
        // It is safe here because of what the registry is: a HashMap with no invariant spanning
        // entries, in a crate that carries `forbid(unsafe_code)`. A panic cannot leave it torn —
        // it can only leave it missing an insert, which is indistinguishable from the insert not
        // having happened yet.
        let mut registry = self
            .transfers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let inserted = registry.insert(
            token.clone(),
            PendingTransfer {
                file,
                direction: Direction::Receive,
                share: share.to_string(),
                staging_name: staging_name.to_string(),
                // The peer the CONTROL connection authenticated. The data connection must present
                // the same uid, or a token that leaked into a log line becomes a bearer write.
                opened_by: peer,
                correlation_id: correlation_id.to_string(),
                reason: reason.to_string(),
                opened_at: std::time::Instant::now(),
            },
        );
        drop(registry);

        match inserted {
            Ok(()) => Ok(Response::Transfer { token, offset }),
            // Both refusals are states a caller can legitimately hit, so both say which one it is.
            Err(InsertError::Occupied) => Ok(Response::Refused {
                reason: format!("{staging_name} already has a transfer open or streaming"),
            }),
            Err(InsertError::Full) => Ok(Response::Refused {
                reason: format!(
                    "too many transfers are open (limit {})",
                    depsis_agent_max_pending()
                ),
            }),
        }
    }

    /// Move a finished staging file into place, durably.
    ///
    /// ADR-0008 steps 4 and 5. The directory fsync is the one people skip, and skipping it means
    /// a power cut can leave the data on disk with nothing pointing at it — the file survived and
    /// the rename did not.
    /// Open a published file for reading and register a one-time token for it.
    ///
    /// The mirror of `open_transfer`, and deliberately built from the same pieces: the same
    /// `openat2(RESOLVE_BENEATH)` resolution, the same registry, the same one-time token bound to
    /// the same uid. What differs is one field, and everything that follows from it lives in the
    /// data channel rather than here.
    fn open_download(
        &self,
        share: &str,
        path: &[&str],
        peer: PeerIdentity,
        correlation_id: &str,
        reason: &str,
    ) -> Result<Response, SeamError> {
        let Some(paths) = self.paths else {
            return Ok(Response::Refused {
                reason: "no share root is configured; storage is not set up".to_string(),
            });
        };
        if path.is_empty() {
            return Ok(Response::Refused {
                reason: "a download needs a path".to_string(),
            });
        }

        let mut relative: Vec<&str> = Vec::with_capacity(path.len() + 1);
        relative.push(share);
        relative.extend_from_slice(path);
        let file = match paths.open(&relative, OpenIntent::Read) {
            Ok(file) => file,
            // A refusal, not an error. The file being gone is an ordinary answer to a download —
            // it was deleted, or renamed over SMB since the listing the caller is working from —
            // and an error here becomes a 500 for something the client can act on.
            Err(SeamError::NotFound(_)) => {
                return Ok(Response::Refused {
                    reason: "no such file".to_string(),
                })
            }
            Err(other) => return Err(other),
        };

        // The size comes from the descriptor the agent just opened, never from the caller. A Range
        // validated against a number the caller supplied is not validated at all.
        let size = file
            .metadata()
            .map_err(|e| SeamError::Io(format!("stat the file to be read: {e}")))?
            .len();

        let key = path.join("/");
        let token = self.tokens.token();
        let mut registry = self
            .transfers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let inserted = registry.insert(
            token.clone(),
            PendingTransfer {
                file,
                direction: Direction::Send,
                share: share.to_string(),
                staging_name: key,
                opened_by: peer,
                correlation_id: correlation_id.to_string(),
                reason: reason.to_string(),
                opened_at: std::time::Instant::now(),
            },
        );
        drop(registry);

        match inserted {
            Ok(()) => Ok(Response::Download { token, size }),
            // A second reader while one is still open. Refused rather than queued: the interlock
            // exists so a publish cannot rename a file out from under an open descriptor, and one
            // reader at a time is a price a download can pay by retrying.
            Err(InsertError::Occupied) => Ok(Response::Refused {
                reason: "this file already has a reader".to_string(),
            }),
            Err(InsertError::Full) => Ok(Response::Refused {
                reason: format!("too many transfers are open (limit {MAX_PENDING_TRANSFERS})"),
            }),
        }
    }

    /// Throw a staging file away.
    ///
    /// Two steps that must happen in this order: release the registry entry, then unlink. Doing it
    /// the other way round would unlink a file whose descriptor the registry still holds, and the
    /// entry would keep a deleted inode alive against `MAX_PENDING_TRANSFERS` until it timed out.
    fn discard_transfer(&self, share: &str, staging_name: &str) -> Result<Response, SeamError> {
        let Some(paths) = self.paths else {
            return Ok(Response::Refused {
                reason: "no share root is configured; storage is not set up".to_string(),
            });
        };

        {
            let mut registry = self
                .transfers
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if registry.abandon(share, staging_name) == Abandoned::Streaming {
                return Ok(Response::Refused {
                    reason: format!("{staging_name} is being written right now"),
                });
            }
        }

        let staging = [share, STAGING_DIR[0], STAGING_DIR[1]];
        let existed = paths.remove_file(&staging, staging_name)?;
        Ok(Response::Discarded { existed })
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "Every operand is one the agent must not infer. The share and the staging name \
                  come from the caller because only it knows which upload this is; the destination \
                  because only it knows where the user asked for the file; expected_bytes and the \
                  owner pair because both are checked rather than trusted. Bundling them into a \
                  struct would satisfy the lint and put a parameter list behind one more name."
    )]
    fn publish_transfer(
        &self,
        share: &str,
        staging_name: &str,
        destination: &[&str],
        expected_bytes: u64,
        owner_uid: u32,
        owner_gid: u32,
    ) -> Result<Response, SeamError> {
        let Some(paths) = self.paths else {
            return Ok(Response::Refused {
                reason: "no share root is configured; storage is not set up".to_string(),
            });
        };
        let Some((file_name, dirs)) = destination.split_last() else {
            return Ok(Response::Refused {
                reason: "destination is empty".to_string(),
            });
        };
        // Refused before anything is opened. A published file owned by root at 0600 is unreadable
        // by the person who uploaded it, which is the exact failure these operands were added to
        // end — accepting 0 here would let a caller that forgot the mapping reintroduce it, and it
        // would present as "uploads are broken" rather than as a missing field.
        if owner_uid == 0 || owner_gid == 0 {
            return Ok(Response::Refused {
                reason: "a published file may not be owned by root; supply the user's uid and gid"
                    .to_string(),
            });
        }

        // Publishing a file that is still being written renames a half-written object into the
        // user's tree — the exact outcome atomic publish exists to prevent. The agent holds the
        // state that answers this; it does not have to trust the API's belief that the upload
        // finished, which is the one assumption ADR-0006 says it must not make.
        {
            let registry = self
                .transfers
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if registry.is_busy(share, staging_name) {
                return Ok(Response::Refused {
                    reason: format!("{staging_name} is still open or streaming"),
                });
            }
        }

        let staged = [share, STAGING_DIR[0], STAGING_DIR[1], staging_name];
        let file = paths.open(&staged, OpenIntent::Read)?;
        let size = file
            .metadata()
            .map_err(|e| SeamError::Io(format!("stat staging file: {e}")))?
            .len();

        // Ownership BEFORE the fsync, and the order is the whole reason this is not one line
        // further down. `fchown` changes inode metadata; `fsync` is what makes inode metadata
        // durable. Chowning after the fsync would leave a window where a power cut publishes the
        // file under its real name with the old owner still recorded — a file the user can see and
        // cannot read, with nothing left to fix it, because the staging entry is gone.
        paths.set_owner(&file, owner_uid, owner_gid)?;

        // ADR-0008 step 2, done HERE rather than assumed.
        //
        // `SafePath::publish` bundles step 5 (the destination-directory fsync) so a call site
        // cannot skip it. Step 2 — the file's own data — had no such home: it was left to whoever
        // wrote the bytes, on the far side of a process boundary and a possible agent restart, with
        // nothing recording that it ever ran. Doing it again on the descriptor being published
        // costs one syscall on already-clean pages and removes the assumption. fsync on an
        // O_RDONLY descriptor is permitted on Linux.
        file.sync_all()
            .map_err(|e| SeamError::Io(format!("fsync staging file before publish: {e}")))?;

        // The API says how many bytes it believes are there; the agent checks. Without this, a
        // client that died at 90% plus a buggy or compromised API renames a short file to the name
        // the user chose — and because publish uses RENAME_NOREPLACE, the good copy can then NEVER
        // be written over it. The rule that publishing never destroys a file the user already has
        // would have permanently given the name to a corrupt one.
        if size != expected_bytes {
            return Ok(Response::Refused {
                reason: format!("staged file is {size} bytes, caller expected {expected_bytes}"),
            });
        }

        let mut dest_dir: Vec<&str> = vec![share];
        dest_dir.extend_from_slice(dirs);
        let staging_dir = [share, STAGING_DIR[0], STAGING_DIR[1]];

        // Rename and directory fsync in one call, so step 5 cannot be left out here.
        paths.publish(&staging_dir, staging_name, &dest_dir, file_name)?;

        Ok(Response::Publish { bytes: size })
    }

    /// Handle one raw request line.
    ///
    /// Returns a `Response` in every case, including refusal — the caller is a program, and a
    /// dropped connection is harder to diagnose than a structured refusal.
    pub fn handle(
        &self,
        raw: &str,
        peer: PeerIdentity,
        correlation_id: &str,
        reason: &str,
    ) -> Response {
        let request: Request = match serde_json::from_str(raw) {
            Ok(r) => r,
            Err(e) => {
                // No audit entry with an operation name here: we do not know what was asked,
                // and inventing one would put a fiction in an append-only log.
                return Response::Refused {
                    reason: format!("unparseable request: {e}"),
                };
            }
        };

        match self.policy.authorize(peer, &request) {
            Decision::Deny(why) => {
                self.audit.record(audit::entry(
                    correlation_id,
                    peer,
                    &request,
                    reason,
                    Outcome::Refused(why.to_string()),
                ));
                return Response::Refused {
                    reason: why.to_string(),
                };
            }
            Decision::Allow => {}
        }

        self.audit.record(audit::entry(
            correlation_id,
            peer,
            &request,
            reason,
            Outcome::Allowed,
        ));

        match self.execute(&request, peer, correlation_id, reason) {
            Ok(response) => response,
            Err(e) => {
                let msg = e.to_string();
                self.audit.record(audit::entry(
                    correlation_id,
                    peer,
                    &request,
                    reason,
                    Outcome::Failed(msg.clone()),
                ));
                Response::Failed { reason: msg }
            }
        }
    }

    /// Run one already-parsed, already-authorized request.
    ///
    /// Takes the peer and the envelope's audit fields because the transfer operations must RECORD
    /// them: a token has an owner (only that uid may redeem it on the data socket) and a data
    /// connection has to be traceable back to the HTTP request that caused it. Threading them here
    /// rather than looking them up later is what makes both properties impossible to forget.
    fn execute(
        &self,
        request: &Request,
        peer: PeerIdentity,
        correlation_id: &str,
        reason: &str,
    ) -> Result<Response, SeamError> {
        match request {
            Request::Ping {} => Ok(Response::Ok {
                schema_version: SCHEMA_VERSION,
            }),

            Request::PoolStatus { pool } => {
                // -H -p: script-parsable, exact byte counts. Never statvfs (ADR-0008, P0-G).
                let out = self.runner.run(
                    bin::ZFS,
                    &["get", "-Hp", "-o", "value", "used,available", pool.as_str()],
                )?;
                let mut it = out.split_whitespace();
                let used = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
                let available = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
                let health = self
                    .runner
                    .run(bin::ZPOOL, &["list", "-H", "-o", "health", pool.as_str()])?
                    .trim()
                    .to_string();
                Ok(Response::PoolStatus {
                    health,
                    used_bytes: used,
                    available_bytes: available,
                })
            }

            Request::CreateDataset {
                dataset,
                acltype,
                refquota_bytes,
            } => {
                let acl = match acltype {
                    // The only variant that exists. P0-B measured that `nfsv4` reports itself
                    // as configured while enforcing nothing, so it is unrepresentable in `op`.
                    AclType::Posixacl => "acltype=posixacl",
                };
                let quota;
                let mut args: Vec<&str> = vec![
                    "create",
                    "-o",
                    acl,
                    "-o",
                    "xattr=sa",
                    "-o",
                    "dnodesize=auto",
                ];
                if let Some(bytes) = refquota_bytes {
                    quota = format!("refquota={bytes}");
                    args.push("-o");
                    args.push(&quota);
                }
                args.push(dataset.as_str());
                self.runner.run(bin::ZFS, &args)?;

                // Verify rather than assume. P0-B: acltype=nfsv4 sets cleanly and reports
                // itself back, so "the create command succeeded" proves nothing about whether
                // ACLs work. Read the property and refuse to hand over a dataset that would
                // silently enforce nothing.
                let got = self
                    .runner
                    .run(
                        bin::ZFS,
                        &["get", "-H", "-o", "value", "acltype", dataset.as_str()],
                    )?
                    .trim()
                    .to_string();
                // `posixacl` reads back as `posix` — a documented alias, measured in P0-A.
                if !matches!(got.as_str(), "posixacl" | "posix") {
                    return Ok(Response::Failed {
                        reason: format!(
                            "dataset created but acltype reads back as {got:?}; refusing to \
                             publish a dataset that may enforce no ACLs at all"
                        ),
                    });
                }
                Ok(Response::Created {
                    dataset: dataset.as_str().to_string(),
                })
            }

            Request::CreateSnapshot { dataset, name } => {
                let full = format!("{}@{}", dataset.as_str(), name.as_str());
                self.runner.run(bin::ZFS, &["snapshot", &full])?;
                Ok(Response::Snapshot { full_name: full })
            }

            Request::DiffSnapshots { dataset, from, to } => {
                let a = format!("{}@{}", dataset.as_str(), from.as_str());
                let b = format!("{}@{}", dataset.as_str(), to.as_str());
                // -H tab-separated, -F include file type. R lines carry both paths, which is
                // what lets reconciliation see a rename as a rename (ADR-0011, P0-D).
                let out = self.runner.run(bin::ZFS, &["diff", "-H", "-F", &a, &b])?;
                Ok(Response::Diff {
                    lines: out.lines().map(str::to_string).collect(),
                })
            }

            Request::ReadSmartSummary { disk_by_id } => {
                // Built from a validated single component, so the caller cannot reach outside
                // /dev/disk/by-id or smuggle a flag (risk R1).
                let path = format!("/dev/disk/by-id/{}", disk_by_id.as_str());
                let out = self
                    .runner
                    .run(bin::SMARTCTL, &["-H", "-A", "--json=c", &path])?;
                let healthy = out.contains("\"passed\": true") || out.contains("PASSED");
                Ok(Response::Smart {
                    healthy,
                    temperature_celsius: None,
                    raw: out,
                })
            }

            Request::OpenTransfer {
                share,
                staging_name,
            } => self.open_transfer(
                share.as_str(),
                staging_name.as_str(),
                peer,
                correlation_id,
                reason,
            ),

            Request::PublishTransfer {
                share,
                staging_name,
                destination,
                expected_bytes,
                owner_uid,
                owner_gid,
            } => {
                let dest: Vec<&str> = destination.iter().map(|c| c.as_str()).collect();
                self.publish_transfer(
                    share.as_str(),
                    staging_name.as_str(),
                    &dest,
                    *expected_bytes,
                    *owner_uid,
                    *owner_gid,
                )
            }

            Request::DiscardTransfer {
                share,
                staging_name,
            } => self.discard_transfer(share.as_str(), staging_name.as_str()),

            Request::OpenDownload { share, path } => {
                let parts: Vec<&str> = path.iter().map(|c| c.as_str()).collect();
                self.open_download(share.as_str(), &parts, peer, correlation_id, reason)
            }

            Request::PublishSambaConfig { shares } => {
                // testparm is necessary but NOT sufficient. P0-B measured an invalid
                // full_audit opname passing testparm cleanly and then making smbd refuse every
                // connection. The real implementation must follow this with a live connection
                // smoke test and roll back on failure (§17); this skeleton stops at validation
                // and says so rather than pretending the gate is complete.
                self.runner
                    .run(bin::TESTPARM, &["-s", "--suppress-prompt"])?;
                Ok(Response::Published {
                    shares: shares.len(),
                })
            }

            // ── ZeroTier (ADR-0020) ──
            //
            // No `CommandRunner` and no `zerotier-cli`. The CLI is a thin wrapper over the same
            // local API, and going through it would mean a fork, an argv, and a text format to
            // parse — three things the closed operation set exists to avoid — in exchange for
            // nothing the HTTP call does not already give.
            Request::ZeroTierStatus {} => match zerotier::status() {
                Ok(node) => Ok(Response::ZeroTierStatus {
                    node_id: node.node_id,
                    online: node.online,
                    version: node.version,
                }),
                Err(e) => zerotier_error(e),
            },

            Request::ZeroTierNetworks {} => match zerotier::networks() {
                Ok(networks) => Ok(Response::ZeroTierNetworks { networks }),
                Err(e) => zerotier_error(e),
            },

            Request::ZeroTierJoin { network_id } => match zerotier::join(network_id) {
                Ok(network) => Ok(Response::ZeroTierJoined { network }),
                Err(e) => zerotier_error(e),
            },

            Request::ZeroTierLeave { network_id } => match zerotier::leave(network_id) {
                Ok(()) => Ok(Response::ZeroTierLeft {
                    network_id: network_id.as_str().to_string(),
                }),
                Err(e) => zerotier_error(e),
            },
        }
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "The crate-level denials exist because a panic in a root daemon is a denial of               service on the one component that cannot be restarted casually. In tests the               opposite is true: a failed assertion SHOULD panic, and indexing a fixture is               clearer than unwrapping an Option."
)]
mod tests {
    use super::*;
    use crate::audit::MemorySink;
    use crate::seams::mock::{MockCommandRunner, MockSafePath, MockTokenSource};

    const API_UID: u32 = 999;

    fn peer(uid: u32) -> PeerIdentity {
        PeerIdentity {
            uid,
            gid: uid,
            pid: 4242,
        }
    }

    /// The collaborators every dispatch test needs.
    ///
    /// A struct rather than five arguments: the transfer registry and the share root have to
    /// outlive the `Agent` that borrows them, and returning the `Agent` alone would borrow
    /// temporaries that die at the end of the call.
    struct Harness {
        transfers: Mutex<TransferRegistry>,
        tokens: MockTokenSource,
        root: tempfile::TempDir,
        paths: Option<MockSafePath>,
    }

    impl Harness {
        /// No share root: the state of a box before storage is set up.
        fn bare() -> Self {
            let root = tempfile::tempdir().expect("tempdir");
            Self {
                transfers: Mutex::new(TransferRegistry::new()),
                tokens: MockTokenSource::default(),
                root,
                paths: None,
            }
        }

        /// A share root with `<share>/.depsis/staging` already in place.
        fn with_share(share: &str) -> Self {
            let root = tempfile::tempdir().expect("tempdir");
            let staging = root
                .path()
                .join(share)
                .join(STAGING_DIR[0])
                .join(STAGING_DIR[1]);
            std::fs::create_dir_all(&staging).expect("mkdir staging");
            let paths = Some(MockSafePath::new(root.path()));
            Self {
                transfers: Mutex::new(TransferRegistry::new()),
                tokens: MockTokenSource::default(),
                root,
                paths,
            }
        }

        fn share_path(&self, parts: &[&str]) -> std::path::PathBuf {
            let mut p = self.root.path().to_path_buf();
            for part in parts {
                p.push(part);
            }
            p
        }

        fn agent<'a, R: CommandRunner, S: Sink>(
            &'a self,
            runner: &'a R,
            sink: &'a S,
        ) -> Agent<'a, R, S, MockSafePath> {
            Agent::new(
                Policy { api_uid: API_UID },
                runner,
                sink,
                self.paths.as_ref(),
                &self.tokens,
                &self.transfers,
            )
        }
    }

    fn agent<'a, R: CommandRunner, S: Sink>(
        runner: &'a R,
        sink: &'a S,
        harness: &'a Harness,
    ) -> Agent<'a, R, S, MockSafePath> {
        harness.agent(runner, sink)
    }

    #[test]
    fn ping_reports_the_schema_version() {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp =
            agent(&r, &s, &h).handle(r#"{"op":"ping"}"#, peer(API_UID), "c1", "health check");
        assert_eq!(
            resp,
            Response::Ok {
                schema_version: SCHEMA_VERSION
            }
        );
    }

    #[test]
    fn a_free_form_command_is_refused_and_runs_nothing() {
        // The headline property of TB4: there is no way to ask the agent to run a command.
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"exec","argv":["/bin/sh","-c","zpool destroy tank"]}"#,
            peer(API_UID),
            "c2",
            "attack",
        );
        assert!(matches!(resp, Response::Refused { .. }));
        assert!(r.calls.borrow().is_empty(), "nothing may be executed");
    }

    #[test]
    fn an_unauthorized_uid_is_refused_and_audited() {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(r#"{"op":"ping"}"#, peer(1000), "c3", "probe");
        assert!(matches!(resp, Response::Refused { .. }));
        assert!(r.calls.borrow().is_empty());
        let entries = s.entries();
        assert_eq!(entries.len(), 1);
        assert!(matches!(entries[0].outcome, Outcome::Refused(_)));
        assert_eq!(entries[0].uid, 1000);
    }

    #[test]
    fn a_dataset_name_shaped_like_a_flag_never_reaches_the_runner() {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"create_snapshot","dataset":"-R","name":"s1"}"#,
            peer(API_UID),
            "c4",
            "snapshot",
        );
        assert!(matches!(resp, Response::Refused { .. }));
        assert!(r.calls.borrow().is_empty());
    }

    #[test]
    fn create_dataset_always_passes_posixacl_and_sa() {
        let r = MockCommandRunner::with_responses(["".into(), "posix".into()]);
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"create_dataset","dataset":"tank/u/1","acltype":"posixacl","refquota_bytes":1048576}"#,
            peer(API_UID),
            "c5",
            "provision user",
        );
        assert!(matches!(resp, Response::Created { .. }));
        let argv = r.call(0).expect("create was run");
        assert_eq!(argv[0], bin::ZFS);
        assert!(argv.contains(&"acltype=posixacl".to_string()));
        assert!(argv.contains(&"xattr=sa".to_string()));
        assert!(argv.contains(&"refquota=1048576".to_string()));
        assert!(!argv.iter().any(|a| a.contains("nfsv4")));
    }

    #[test]
    fn create_dataset_refuses_to_publish_when_acltype_reads_back_wrong() {
        // The measured failure mode: the create succeeds and the property reports itself as
        // configured while enforcing nothing. Verification, not optimism.
        let r = MockCommandRunner::with_responses(["".into(), "nfsv4".into()]);
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"create_dataset","dataset":"tank/u/2","acltype":"posixacl"}"#,
            peer(API_UID),
            "c6",
            "provision user",
        );
        match resp {
            Response::Failed { reason } => assert!(reason.contains("nfsv4")),
            other => panic!("expected refusal to publish, got {other:?}"),
        }
    }

    #[test]
    fn smart_reads_are_confined_to_dev_disk_by_id() {
        let r = MockCommandRunner::with_responses(["PASSED".into()]);
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"read_smart_summary","disk_by_id":"wwn-0x600224801b119da9"}"#,
            peer(API_UID),
            "c7",
            "telemetry",
        );
        assert!(matches!(resp, Response::Smart { healthy: true, .. }));
        let argv = r.call(0).expect("smartctl was run");
        assert!(argv
            .last()
            .expect("path arg")
            .starts_with("/dev/disk/by-id/"));
    }

    #[test]
    fn a_smart_read_cannot_be_pointed_at_an_arbitrary_device() {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        for evil in [
            r#"{"op":"read_smart_summary","disk_by_id":"../../dev/sda"}"#,
            r#"{"op":"read_smart_summary","disk_by_id":"-d"}"#,
        ] {
            let resp = agent(&r, &s, &h).handle(evil, peer(API_UID), "c8", "attack");
            assert!(matches!(resp, Response::Refused { .. }), "{evil}");
        }
        assert!(r.calls.borrow().is_empty());
    }

    #[test]
    fn every_executed_program_is_an_absolute_path() {
        let r = MockCommandRunner::with_responses(["1024 2048".into(), "ONLINE".into()]);
        let s = MemorySink::default();
        let h = Harness::bare();
        agent(&r, &s, &h).handle(
            r#"{"op":"pool_status","pool":"tank"}"#,
            peer(API_UID),
            "c9",
            "telemetry",
        );
        for argv in r.calls.borrow().iter() {
            assert!(
                argv[0].starts_with('/'),
                "program {:?} must be absolute — execvp falls back to /bin:/usr/bin",
                argv[0]
            );
        }
    }

    #[test]
    fn the_audit_entry_carries_identity_and_correlation_id() {
        let r = MockCommandRunner::with_responses(["".into()]);
        let s = MemorySink::default();
        let h = Harness::bare();
        agent(&r, &s, &h).handle(
            r#"{"op":"create_snapshot","dataset":"tank/u/1","name":"nightly"}"#,
            peer(API_UID),
            "corr-abc",
            "scheduled snapshot",
        );
        let entries = s.entries();
        let e = entries.first().expect("an entry was recorded");
        assert_eq!(e.correlation_id, "corr-abc");
        assert_eq!(e.uid, API_UID);
        assert_eq!(e.pid, 4242);
        assert_eq!(e.operation, "create_snapshot");
        assert_eq!(e.reason, "scheduled snapshot");
    }

    #[test]
    fn an_unparseable_request_is_not_audited_under_an_invented_operation() {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle("{not json", peer(API_UID), "c10", "junk");
        assert!(matches!(resp, Response::Refused { .. }));
        // An append-only log must not contain a guess about what was asked.
        assert!(s.entries().is_empty());
    }
    // ── transfers ──
    //
    // The bulk data path's control half. The byte-carrying socket is separate; these settle what
    // the control channel does, which is where the confinement decision is made.

    fn open_transfer(h: &Harness, share: &str, name: &str) -> Response {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let raw = format!(r#"{{"op":"open_transfer","share":"{share}","staging_name":"{name}"}}"#);
        h.agent(&r, &s)
            .handle(&raw, peer(API_UID), "c-transfer", "upload")
    }

    #[test]
    fn opening_a_transfer_creates_the_staging_file_and_returns_a_token() {
        let h = Harness::with_share("alice");

        match open_transfer(&h, "alice", "u1.part") {
            Response::Transfer { token, offset } => {
                assert_eq!(token, "token-1", "the mock source mints predictable tokens");
                assert_eq!(offset, 0, "a new upload starts at zero");
            }
            other => panic!("expected a transfer, got {other:?}"),
        }

        assert!(
            h.share_path(&["alice", ".depsis", "staging", "u1.part"])
                .exists(),
            "the staging file must exist once a transfer is open"
        );
    }

    #[test]
    fn a_resumed_transfer_reports_where_to_continue() {
        // tus resumes. The second PATCH for one upload must continue the same `.part` rather than
        // being refused for existing, and the offset has to come from the FILE — a number tracked
        // beside the data is a number that can disagree with it.
        let h = Harness::with_share("alice");
        std::fs::write(
            h.share_path(&["alice", ".depsis", "staging", "u2.part"]),
            b"twelve bytes",
        )
        .expect("seed a partial upload");

        match open_transfer(&h, "alice", "u2.part") {
            Response::Transfer { offset, .. } => assert_eq!(offset, 12),
            other => panic!("expected a transfer, got {other:?}"),
        }
    }

    #[test]
    fn a_transfer_is_refused_when_no_share_root_is_configured() {
        // The state of a NAS before setup. Refused with a reason, not silently missing — and the
        // agent still starts, because the operations that SET UP storage run through it.
        let h = Harness::bare();
        match open_transfer(&h, "alice", "u.part") {
            Response::Refused { reason } => assert!(reason.contains("no share root")),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn a_transfer_cannot_name_a_share_outside_the_root() {
        // `SafeComponent` refuses this at parse time, before any path work — which is the point of
        // typing the operand rather than checking it later.
        let h = Harness::with_share("alice");
        match open_transfer(&h, "../etc", "u.part") {
            Response::Refused { reason } => assert!(reason.contains("unparseable")),
            other => panic!("expected a parse refusal, got {other:?}"),
        }
    }

    #[test]
    fn publishing_moves_the_file_and_refuses_to_overwrite() {
        let h = Harness::with_share("alice");
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        std::fs::write(
            h.share_path(&["alice", ".depsis", "staging", "done.part"]),
            b"final contents",
        )
        .expect("stage");

        let raw = r#"{"op":"publish_transfer","share":"alice","staging_name":"done.part","destination":["report.txt"],"expected_bytes":14,"owner_uid":1000,"owner_gid":1000}"#;
        match h
            .agent(&r, &s)
            .handle(raw, peer(API_UID), "c-pub", "publish")
        {
            Response::Publish { bytes } => assert_eq!(bytes, 14),
            other => panic!("expected a publish, got {other:?}"),
        }

        assert!(
            h.share_path(&["alice", "report.txt"]).exists(),
            "the file must be where the user asked for it"
        );
        assert!(
            !h.share_path(&["alice", ".depsis", "staging", "done.part"])
                .exists(),
            "and gone from staging"
        );

        // A second publish onto the same name must lose. Publishing is not allowed to destroy a
        // file the user already has, which is why the real implementation uses RENAME_NOREPLACE.
        std::fs::write(
            h.share_path(&["alice", ".depsis", "staging", "again.part"]),
            b"different",
        )
        .expect("stage again");
        let raw2 = r#"{"op":"publish_transfer","share":"alice","staging_name":"again.part","destination":["report.txt"],"expected_bytes":9,"owner_uid":1000,"owner_gid":1000}"#;
        match h
            .agent(&r, &s)
            .handle(raw2, peer(API_UID), "c-pub2", "publish")
        {
            Response::Failed { reason } => assert!(reason.contains("already exists")),
            other => panic!("expected a refusal to overwrite, got {other:?}"),
        }
        assert_eq!(
            std::fs::read(h.share_path(&["alice", "report.txt"])).expect("read"),
            b"final contents",
            "the original must be untouched"
        );
    }

    // ── discarding ──

    fn discard(h: &Harness, share: &str, staging_name: &str) -> Response {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let raw = format!(
            r#"{{"op":"discard_transfer","share":"{share}","staging_name":"{staging_name}"}}"#
        );
        h.agent(&r, &s)
            .handle(&raw, peer(API_UID), "c-discard", "cancelled upload")
    }

    #[test]
    fn a_discarded_staging_file_is_gone_and_its_name_is_free_again() {
        // The dead end this closes: `.depsis/staging` counts against the user's refquota, Samba
        // vetoes `/.depsis/` and the API filters the prefix server-side, so an abandoned chunk was
        // invisible to the user, undeletable by the user, undeletable by the API — which cannot
        // write inside a share at all — and undeletable by the agent. Quota nobody could reclaim.
        let h = Harness::with_share("alice");
        assert!(matches!(
            open_transfer(&h, "alice", "cancelled.part"),
            Response::Transfer { .. }
        ));
        assert!(h
            .share_path(&["alice", ".depsis", "staging", "cancelled.part"])
            .exists());

        match discard(&h, "alice", "cancelled.part") {
            Response::Discarded { existed } => assert!(existed),
            other => panic!("expected a discard, got {other:?}"),
        }
        assert!(!h
            .share_path(&["alice", ".depsis", "staging", "cancelled.part"])
            .exists());

        // The registry entry went with it. Without that the descriptor would sit against
        // MAX_PENDING_TRANSFERS holding a deleted inode alive until the TTL expired, and the name
        // would stay reserved for five minutes after every cancelled upload.
        {
            let registry = h.transfers.lock().expect("lock");
            assert_eq!(registry.pending_count(), 0);
            assert!(!registry.is_busy("alice", "cancelled.part"));
        }
        assert!(
            matches!(
                open_transfer(&h, "alice", "cancelled.part"),
                Response::Transfer { .. }
            ),
            "and the user can retry under the same name immediately"
        );
    }

    #[test]
    fn discarding_a_file_that_is_already_gone_is_a_success() {
        // A caller retrying a discard must not have to tell "already clean" apart from a fault —
        // and the sweeper can legitimately have got there first.
        let h = Harness::with_share("alice");
        match discard(&h, "alice", "never-existed.part") {
            Response::Discarded { existed } => assert!(!existed),
            other => panic!("expected a discard, got {other:?}"),
        }
    }

    #[test]
    fn discarding_is_refused_while_a_data_connection_is_writing() {
        // Unlinking a file a worker is still appending to leaves that worker writing into an
        // unlinked inode and reporting `stored`. The bytes go nowhere and nothing says so.
        let h = Harness::with_share("alice");
        let token = match open_transfer(&h, "alice", "live.part") {
            Response::Transfer { token, .. } => token,
            other => panic!("expected a transfer, got {other:?}"),
        };

        // Claim it the way the data channel does, and hold the in-flight guard for the call.
        let key = {
            let mut registry = h.transfers.lock().expect("lock");
            let (_transfer, key) = registry.claim(&token, peer(API_UID)).expect("claim");
            key
        };
        let guard = crate::transfer::guard_in_flight(&h.transfers, key);

        match discard(&h, "alice", "live.part") {
            Response::Refused { reason } => {
                assert!(reason.contains("being written right now"), "got: {reason}");
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
        assert!(
            h.share_path(&["alice", ".depsis", "staging", "live.part"])
                .exists(),
            "the file must still be there for the connection that is writing it"
        );

        // And once the connection ends, the same call works.
        drop(guard);
        assert!(matches!(
            discard(&h, "alice", "live.part"),
            Response::Discarded { existed: true }
        ));
    }

    #[test]
    fn a_second_transfer_on_one_staging_file_is_refused() {
        // The interlock, through the dispatcher. Both would sit at the same offset and their data
        // connections would overwrite each other with no error at any layer.
        let h = Harness::with_share("alice");
        assert!(matches!(
            open_transfer(&h, "alice", "u.part"),
            Response::Transfer { .. }
        ));
        match open_transfer(&h, "alice", "u.part") {
            Response::Refused { reason } => assert!(reason.contains("already has a transfer")),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn publishing_is_refused_while_the_file_is_still_open() {
        // A PublishTransfer arriving mid-upload would renameat2 a half-written file into the user's
        // tree — exactly what atomic publish exists to prevent. The agent answers from state it
        // holds itself rather than trusting the API's belief that the upload finished.
        let h = Harness::with_share("alice");
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        std::fs::write(
            h.share_path(&["alice", ".depsis", "staging", "live.part"]),
            b"partial",
        )
        .expect("stage");
        assert!(matches!(
            open_transfer(&h, "alice", "live.part"),
            Response::Transfer { .. }
        ));

        let raw = r#"{"op":"publish_transfer","share":"alice","staging_name":"live.part","destination":["out.txt"],"expected_bytes":7,"owner_uid":1000,"owner_gid":1000}"#;
        match h
            .agent(&r, &s)
            .handle(raw, peer(API_UID), "c-busy", "publish")
        {
            Response::Refused { reason } => assert!(reason.contains("still open")),
            other => panic!("expected a refusal, got {other:?}"),
        }
        assert!(
            !h.share_path(&["alice", "out.txt"]).exists(),
            "nothing may have been moved"
        );
    }

    #[test]
    fn a_published_file_is_handed_to_the_uploader_not_left_with_root() {
        // The gap that P1-D asserted for two commits: a published file stayed root-owned at 0600,
        // so the person who uploaded it could not read it back. What is measured here is that the
        // publish path ASKS for the right owner; that the ask takes effect is measured against a
        // real kernel in `unix.rs` and end to end in P1-D, because a chown needs CAP_CHOWN and a
        // portable test running as an ordinary user could only ever assert that it failed.
        let h = Harness::with_share("alice");
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        std::fs::write(
            h.share_path(&["alice", ".depsis", "staging", "owned.part"]),
            b"twelve bytes",
        )
        .expect("stage");

        let raw = r#"{"op":"publish_transfer","share":"alice","staging_name":"owned.part","destination":["mine.txt"],"expected_bytes":12,"owner_uid":1000,"owner_gid":1001}"#;
        match h.agent(&r, &s).handle(raw, peer(API_UID), "c", "publish") {
            Response::Publish { bytes } => assert_eq!(bytes, 12),
            other => panic!("expected a publish, got {other:?}"),
        }
        assert_eq!(
            h.paths.as_ref().expect("paths").owners(),
            vec![(1000, 1001)],
            "the uid and gid the caller supplied must reach the filesystem seam unchanged"
        );
    }

    #[test]
    fn a_publish_that_would_leave_the_file_root_owned_is_refused() {
        // Not because root ownership is an escalation — the mode is 0600 and nothing is setuid —
        // but because it is exactly the broken state the operands exist to end. A caller that
        // forgot the mapping must fail loudly rather than reproduce the bug it was sent to fix.
        let h = Harness::with_share("alice");
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        std::fs::write(
            h.share_path(&["alice", ".depsis", "staging", "root.part"]),
            b"x",
        )
        .expect("stage");

        for raw in [
            r#"{"op":"publish_transfer","share":"alice","staging_name":"root.part","destination":["a.txt"],"expected_bytes":1,"owner_uid":0,"owner_gid":1000}"#,
            r#"{"op":"publish_transfer","share":"alice","staging_name":"root.part","destination":["b.txt"],"expected_bytes":1,"owner_uid":1000,"owner_gid":0}"#,
        ] {
            match h.agent(&r, &s).handle(raw, peer(API_UID), "c", "publish") {
                Response::Refused { reason } => {
                    assert!(reason.contains("owned by root"), "got: {reason}");
                }
                other => panic!("root ownership must be refused, got {other:?}"),
            }
        }
        assert!(
            h.paths.as_ref().expect("paths").owners().is_empty(),
            "a refused publish must not have touched the file at all"
        );
        assert!(
            h.share_path(&["alice", ".depsis", "staging", "root.part"])
                .exists(),
            "and the staging file must survive so a corrected call can still publish it"
        );
    }

    #[test]
    fn publishing_refuses_a_size_the_caller_did_not_expect() {
        // A client that died at 90%, plus an API that believes it finished. Without this the short
        // file takes the user's chosen name — and RENAME_NOREPLACE then makes that name permanently
        // unavailable to the good copy.
        let h = Harness::with_share("alice");
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        std::fs::write(
            h.share_path(&["alice", ".depsis", "staging", "short.part"]),
            b"only nine",
        )
        .expect("stage");

        let raw = r#"{"op":"publish_transfer","share":"alice","staging_name":"short.part","destination":["full.txt"],"expected_bytes":9999,"owner_uid":1000,"owner_gid":1000}"#;
        match h
            .agent(&r, &s)
            .handle(raw, peer(API_UID), "c-short", "publish")
        {
            Response::Refused { reason } => assert!(reason.contains("expected 9999")),
            other => panic!("expected a refusal, got {other:?}"),
        }
        assert!(!h.share_path(&["alice", "full.txt"]).exists());
    }

    #[test]
    fn the_number_of_open_transfers_has_a_ceiling() {
        // Every open transfer is a descriptor held by a root daemon. Without a cap a burst of opens
        // exhausts RLIMIT_NOFILE and takes the control socket down with it.
        let h = Harness::with_share("alice");
        for i in 0..MAX_PENDING_TRANSFERS {
            assert!(
                matches!(
                    open_transfer(&h, "alice", &format!("f{i}.part")),
                    Response::Transfer { .. }
                ),
                "open {i} should be within the cap"
            );
        }
        match open_transfer(&h, "alice", "one-too-many.part") {
            Response::Refused { reason } => assert!(reason.contains("too many transfers")),
            other => panic!("expected a refusal at the cap, got {other:?}"),
        }
    }

    #[test]
    fn a_transfer_records_who_opened_it_and_why() {
        // The data connection needs both: the uid to check that the redeemer is the opener, and the
        // correlation id so its audit entry ties back to the HTTP request. Taken from the control
        // envelope, never from the data wire.
        let h = Harness::with_share("alice");
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let raw = r#"{"op":"open_transfer","share":"alice","staging_name":"traced.part"}"#;
        h.agent(&r, &s)
            .handle(raw, peer(API_UID), "corr-77", "upload for job 9");

        let registry = h.transfers.lock().expect("lock");
        assert_eq!(registry.pending_count(), 1);
        assert!(
            registry.is_busy("alice", "traced.part"),
            "the name must be reserved from the moment it is opened"
        );
    }

    #[test]
    fn a_transfer_is_audited_under_its_own_name() {
        // §16: a privileged call has to be explicable afterwards, and "open_transfer" is what the
        // journal should say — not a generic name that makes every upload look the same.
        let h = Harness::with_share("alice");
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let raw = r#"{"op":"open_transfer","share":"alice","staging_name":"a.part"}"#;
        h.agent(&r, &s)
            .handle(raw, peer(API_UID), "c-audit", "upload for job 7");

        let entries = s.entries();
        assert!(
            entries.iter().any(|e| e.operation == "open_transfer"),
            "the audit trail must name the operation, got {entries:?}"
        );
        assert!(
            entries.iter().any(|e| e.reason == "upload for job 7"),
            "and carry the caller's reason"
        );
    }

    // ── ZeroTier ──
    //
    // These go through `handle`, so they cover parsing, authorization and audit as well as the
    // handler. They do NOT require zerotier-one: on a box without it the answer is
    // `ZeroTierUnavailable`, which is the behaviour worth asserting either way.

    #[test]
    fn a_malformed_network_id_never_reaches_the_handler() {
        // The point of `NetworkId`: these are refused at parse time, before authorization, before
        // audit, and long before anything could be concatenated into a request path.
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        for raw in [
            r#"{"op":"zerotier_join","network_id":"../../../etc/pas"}"#,
            r#"{"op":"zerotier_join","network_id":"8056C2E21C000001"}"#,
            r#"{"op":"zerotier_leave","network_id":"8056c2e21c00000"}"#,
            r#"{"op":"zerotier_leave","network_id":"0123456789ab\r\ncd"}"#,
        ] {
            let resp = h.agent(&r, &s).handle(raw, peer(API_UID), "c-zt", "join");
            assert!(
                matches!(resp, Response::Refused { .. }),
                "{raw} must be refused, got {resp:?}"
            );
        }
        assert!(r.calls.borrow().is_empty(), "nothing may be executed");
        assert!(
            s.entries().is_empty(),
            "an unparseable request has no operation name to audit"
        );
    }

    #[test]
    fn a_status_request_answers_either_the_node_or_that_zerotier_is_absent() {
        // Never `Failed`. "Switched off" and "broken" are the distinction the operator needs
        // most (ADR-0020), and this is the assertion that keeps them apart.
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = h.agent(&r, &s).handle(
            r#"{"op":"zerotier_status"}"#,
            peer(API_UID),
            "c-zt-status",
            "remote access card",
        );
        match &resp {
            Response::ZeroTierStatus { node_id, .. } => assert_eq!(node_id.len(), 10),
            Response::ZeroTierUnavailable { reason } => assert!(!reason.is_empty()),
            other => panic!("unexpected answer: {other:?}"),
        }
        assert!(
            s.entries().iter().any(|e| e.operation == "zerotier_status"),
            "the call must be audited under its own name"
        );
        assert!(
            r.calls.borrow().is_empty(),
            "the local API is spoken to directly; no process is spawned"
        );
    }

    #[test]
    fn a_networks_request_answers_either_a_list_or_that_zerotier_is_absent() {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = h.agent(&r, &s).handle(
            r#"{"op":"zerotier_networks"}"#,
            peer(API_UID),
            "c-zt-nets",
            "remote access card",
        );
        assert!(
            matches!(
                resp,
                Response::ZeroTierNetworks { .. } | Response::ZeroTierUnavailable { .. }
            ),
            "unexpected answer: {resp:?}"
        );
    }

    #[test]
    fn zerotier_operations_still_require_the_api_uid() {
        // The agent holds the local API token because it grants network control. A caller that
        // is not the API must not be able to spend it, and the check is the same one every other
        // operation gets — which is the reason there is only one.
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        for raw in [
            r#"{"op":"zerotier_status"}"#,
            r#"{"op":"zerotier_join","network_id":"8056c2e21c000001"}"#,
        ] {
            let resp = h
                .agent(&r, &s)
                .handle(raw, peer(1000), "c-zt-deny", "probe");
            assert!(matches!(resp, Response::Refused { .. }));
        }
    }

    #[test]
    fn a_zerotier_status_request_takes_no_arguments() {
        // `deny_unknown_fields` on an empty struct variant, and the braces in `ZeroTierStatus {}`
        // are what make it bite. A unit variant would have accepted the smuggled field.
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = h.agent(&r, &s).handle(
            r#"{"op":"zerotier_status","path":"/controller/network"}"#,
            peer(API_UID),
            "c-zt-smuggle",
            "attack",
        );
        assert!(matches!(resp, Response::Refused { .. }));
    }
}
