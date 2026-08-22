//! The registry that ties a one-time token to an already-resolved staging file.
//!
//! This exists because the bulk data path needs two connections and a capability has to survive
//! between them. The control socket resolves the path under `openat2(RESOLVE_BENEATH)` and keeps
//! the descriptor here; the data socket presents a token and gets that descriptor back. Nothing
//! the caller sends on the data socket names a path, so the second connection cannot widen what
//! the first one was confined to — which is the whole reason the token exists rather than simply
//! repeating the file name on the data channel.
//!
//! ONE-TIME-NESS IS A PROPERTY OF THE FILE, NOT OF THE TOKEN. An earlier version keyed only by
//! token, which meant two `OpenTransfer` calls naming one staging file both succeeded, both sat at
//! the same offset, and their data connections overwrote each other. It also dropped the entry the
//! moment a token was claimed, so from the first byte to the last there was no record that the file
//! was in flight — and a `PublishTransfer` arriving in that window would `renameat2` a file still
//! being appended to, into the user's tree. That is exactly the half-written file that atomic
//! publish exists to prevent. So the registry is keyed by `(share, staging_name)` and models both
//! states: waiting for its data connection, and streaming (ADR-0017).
//!
//! Platform-neutral by construction: it holds `std::fs::File`, which exists everywhere, so the
//! core keeps its zero-`cfg` property (ADR-0006).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::seams::PeerIdentity;

/// How long an opened transfer waits for its data connection.
///
/// Long enough for a client to be slow, short enough that an abandoned upload does not hold a
/// descriptor and a partially written file open indefinitely.
pub const TRANSFER_TTL: Duration = Duration::from_secs(300);

/// How long a claimed transfer may stream before the agent reclaims the name.
///
/// Distinct from `TRANSFER_TTL`, which governs PICKUP only. A transfer that has started streaming
/// is bounded by its declared length and an idle deadline on the connection itself; this is the
/// backstop for a data thread that died without running its guard's `Drop` — which should be
/// impossible, and is therefore exactly the kind of thing worth a backstop.
pub const CLAIMED_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// A token's length in bytes before hex encoding.
///
/// 32 bytes from `getrandom`. The token authorizes writing to an already-chosen file, so guessing
/// one is only useful to a process that already passed SO_PEERCRED — but "only useful to an
/// attacker who is already inside" is exactly the reasoning that turns a small number into a real
/// one later.
///
/// This constant is also why the data socket carries no rate limit: 256 bits over a local AF_UNIX
/// socket is not guessable at any rate. The two facts are coupled, and writing only one of them
/// down would leave the next reader thinking a limiter had been forgotten.
pub const TOKEN_BYTES: usize = 32;

/// How many transfers may be open at once.
///
/// Every entry is a descriptor held by a root daemon. Unbounded, roughly a thousand `OpenTransfer`
/// calls inside a second exhaust the default `RLIMIT_NOFILE` and take the CONTROL socket down with
/// them — the queue's own denial of service. Sized against the unit's `LimitNOFILE=`, and small
/// because a single appliance does not have sixty-four simultaneous uploads.
pub const MAX_PENDING_TRANSFERS: usize = 64;

/// The file a token names, plus everything the data connection will need to audit itself.
/// Which way the bytes go once a data connection presents the token.
///
/// One registry for both directions rather than two, because everything around it is the same
/// question: which already-resolved descriptor does this token name, who is allowed to use it, and
/// is anyone using it right now. Splitting them would duplicate the one-time-ness, the uid check
/// and the in-flight interlock — and a second copy of an interlock is a second chance to get it
/// wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// The client sends; the agent appends to a staging file.
    Receive,
    /// The agent sends; the client reads a published file.
    Send,
}

pub struct PendingTransfer {
    pub file: std::fs::File,
    pub direction: Direction,
    pub share: String,
    /// The registry key inside the share.
    ///
    /// For `Receive` this is the staging file's own name, one component under `.depsis/staging/`.
    /// For `Send` it is the published file's path relative to the share root, joined with `/` —
    /// a download has no staging file, and its natural key is the thing being read. The two can
    /// never collide: a staging name is a single component and therefore contains no separator.
    pub staging_name: String,
    /// Who opened it. The data connection must present the same uid: without this, a token seen in
    /// a log line or a traced response becomes a transferable bearer write into a tenant's share.
    pub opened_by: PeerIdentity,
    /// Carried from the control envelope so the data connection's audit entry can be tied to the
    /// HTTP request that caused it. Taken from here, NEVER from the data wire — accepting it there
    /// would let the unprivileged side write its own audit metadata (§16).
    pub correlation_id: String,
    pub reason: String,
    pub opened_at: Instant,
}

/// A transfer whose data connection is live.
struct InFlight {
    since: Instant,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ClaimError {
    /// No such token, or it was already used. Deliberately one outcome: telling them apart would
    /// say whether a token ever existed, and a token is a secret.
    Unknown,
    Expired,
    /// The right token, presented by the wrong uid.
    NotYours,
}

/// What `abandon` found.
#[derive(Debug, PartialEq, Eq)]
pub enum Abandoned {
    /// There was a pending transfer and it is gone; the file can now be removed.
    Released,
    /// A data connection is writing to it right now. Nothing was changed.
    Streaming,
    /// No transfer named this file. The file may still exist — an abandoned one from before a
    /// restart, say — so this is not by itself a reason to refuse the caller.
    NotKnown,
}

#[derive(Debug, PartialEq, Eq)]
pub enum InsertError {
    /// Another transfer already names this file — pending, or currently streaming.
    Occupied,
    /// The registry is at `MAX_PENDING_TRANSFERS`.
    Full,
}

/// Held for as long as a data connection is streaming.
///
/// Its `Drop` clears the in-flight mark, so a thread that panics mid-transfer cannot leave the
/// staging name permanently unpublishable. An explicit "release" call would be a call somebody can
/// fail to reach on an error path — which is the same argument that put the directory fsync inside
/// `SafePath::publish` rather than beside it.
pub struct InFlightGuard<'a> {
    registry: &'a std::sync::Mutex<TransferRegistry>,
    key: (String, String),
}

impl Drop for InFlightGuard<'_> {
    fn drop(&mut self) {
        // Poison is recovered rather than propagated: refusing to clear an in-flight mark because
        // another thread panicked would make the name unpublishable forever.
        let mut registry = self
            .registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        registry.in_flight.remove(&self.key);
    }
}

#[derive(Default)]
pub struct TransferRegistry {
    /// token → the open file it names.
    pending: HashMap<String, PendingTransfer>,
    /// (share, staging_name) → the token holding it, so a second OpenTransfer on one file is
    /// refused rather than silently racing.
    by_name: HashMap<(String, String), String>,
    /// (share, staging_name) → a live data connection. Publishing is refused while this exists.
    in_flight: HashMap<(String, String), InFlight>,
}

impl TransferRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register an opened file under a token.
    ///
    /// Fallible, and both refusals matter: `Occupied` is the interlock that stops two transfers
    /// sharing one file, and `Full` is the descriptor budget.
    pub fn insert(&mut self, token: String, transfer: PendingTransfer) -> Result<(), InsertError> {
        self.expire_old();
        let key = (transfer.share.clone(), transfer.staging_name.clone());
        let reserves = transfer.direction == Direction::Receive;

        // A READ takes no reservation, and that is a correction rather than an omission. The first
        // version reserved for both directions and produced two wrong behaviours at once: two
        // people could not download one file at the same time, and any request that opened a
        // download and then declined to use the token — an unsatisfiable Range answers 416 without
        // ever connecting to the data socket — left the file locked for the whole TRANSFER_TTL.
        // Measured in P1-D: the 416 case made the next download of that file fail with "this file
        // already has a reader" for five minutes.
        //
        // The interlock exists to stop a publish renaming over a file being WRITTEN. A reader needs
        // nothing from it: a rename into an occupied name is refused by RENAME_NOREPLACE anyway,
        // and an open descriptor keeps its inode alive regardless of what happens to the name. The
        // token alone still gives one-time-ness and binds the transfer to the uid that opened it.
        if reserves && (self.by_name.contains_key(&key) || self.in_flight.contains_key(&key)) {
            return Err(InsertError::Occupied);
        }
        if self.pending.len() >= MAX_PENDING_TRANSFERS {
            return Err(InsertError::Full);
        }
        if reserves {
            self.by_name.insert(key, token.clone());
        }
        self.pending.insert(token, transfer);
        Ok(())
    }

    /// Take a transfer, if the token names a live one opened by this peer.
    ///
    /// Remove FIRST, decide second, sweep last. An earlier version swept before looking, which
    /// deleted the very entry the `Expired` branch needed and made every timed-out transfer report
    /// `Unknown` — the branch was unreachable, and an honest slow client would have been told its
    /// token never existed.
    pub fn claim(
        &mut self,
        token: &str,
        peer: PeerIdentity,
    ) -> Result<(PendingTransfer, (String, String)), ClaimError> {
        let claimed = self.pending.remove(token);
        self.expire_old();

        let transfer = match claimed {
            None => return Err(ClaimError::Unknown),
            Some(t) if t.opened_at.elapsed() > TRANSFER_TTL => {
                self.by_name
                    .remove(&(t.share.clone(), t.staging_name.clone()));
                return Err(ClaimError::Expired);
            }
            Some(t) => t,
        };

        let key = (transfer.share.clone(), transfer.staging_name.clone());

        if transfer.opened_by.uid != peer.uid {
            // Put it back: a wrong peer must not be able to burn somebody else's live token by
            // guessing at it. The name stays reserved too.
            self.pending.insert(token.to_string(), transfer);
            return Err(ClaimError::NotYours);
        }

        // The name moves from "reserved by a token" to "being written". It is never unreserved in
        // between, so a PublishTransfer cannot slip through the gap.
        //
        // A read marks nothing, for the reason given on `insert`: it never reserved the name, and
        // marking it in flight here would block a publish for the length of a download.
        if transfer.direction == Direction::Receive {
            self.by_name.remove(&key);
            self.in_flight.insert(
                key.clone(),
                InFlight {
                    since: Instant::now(),
                },
            );
        }
        Ok((transfer, key))
    }

    /// Give up on a transfer that has not started streaming.
    ///
    /// Without this, an API that opens a transfer and then decides against it — the user cancelled,
    /// the tus upload was terminated, a validation failed — has no way back: the name stays
    /// reserved for `TRANSFER_TTL` and the staging file cannot be deleted while it is, because
    /// `DiscardTransfer` refuses a reserved name. Five minutes of a name being unusable after every
    /// cancelled upload is the kind of thing that gets "fixed" by removing the interlock.
    ///
    /// A STREAMING transfer is never cancelled from here. Dropping the registry entry under a live
    /// data connection would let the file be unlinked while a worker is still appending to it, and
    /// the worker would go on writing to an unlinked inode and report success.
    pub fn abandon(&mut self, share: &str, staging_name: &str) -> Abandoned {
        let key = (share.to_string(), staging_name.to_string());
        if self.in_flight.contains_key(&key) {
            return Abandoned::Streaming;
        }
        match self.by_name.remove(&key) {
            Some(token) => {
                self.pending.remove(&token);
                Abandoned::Released
            }
            None => Abandoned::NotKnown,
        }
    }

    /// Is this staging file spoken for — waiting for data, or being written right now?
    ///
    /// `PublishTransfer` asks before it renames. Renaming a file that is still being appended to is
    /// the half-written file in the user's tree that atomic publish exists to prevent.
    pub fn is_busy(&self, share: &str, staging_name: &str) -> bool {
        let key = (share.to_string(), staging_name.to_string());
        self.by_name.contains_key(&key) || self.in_flight.contains_key(&key)
    }

    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    pub fn in_flight_count(&self) -> usize {
        self.in_flight.len()
    }

    /// Drop anything past its lifetime.
    ///
    /// Two clocks, because the two states mean different things: a transfer waiting for pickup is
    /// abandoned after `TRANSFER_TTL`, while one that is streaming is bounded by its own connection
    /// and only reclaimed after `CLAIMED_TTL` as a backstop for a thread that vanished.
    fn expire_old(&mut self) {
        let pending = &mut self.pending;
        let by_name = &mut self.by_name;
        pending.retain(|_, t| {
            let alive = t.opened_at.elapsed() <= TRANSFER_TTL;
            if !alive {
                by_name.remove(&(t.share.clone(), t.staging_name.clone()));
            }
            alive
        });
        self.in_flight
            .retain(|_, f| f.since.elapsed() <= CLAIMED_TTL);
    }
}

/// Mark a claimed transfer as streaming until the guard is dropped.
///
/// Free function rather than a method because the guard borrows the mutex, not the registry inside
/// it — the lock must be released while the bytes flow, or one upload would serialise every other
/// operation in the agent.
pub fn guard_in_flight<'a>(
    registry: &'a std::sync::Mutex<TransferRegistry>,
    key: (String, String),
) -> InFlightGuard<'a> {
    InFlightGuard { registry, key }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "The crate-level denials exist because a panic in a root daemon is a denial of \
              service on the one component that cannot be restarted casually. In tests the \
              opposite is true: a failed assertion SHOULD panic."
)]
mod tests {
    use super::*;

    const API: PeerIdentity = PeerIdentity {
        uid: 999,
        gid: 999,
        pid: 1234,
    };
    const OTHER: PeerIdentity = PeerIdentity {
        uid: 1000,
        gid: 1000,
        pid: 5678,
    };

    fn pending_named(share: &str, name: &str, age: Duration) -> PendingTransfer {
        PendingTransfer {
            file: tempfile::tempfile().expect("tempfile"),
            direction: Direction::Receive,
            share: share.into(),
            staging_name: name.into(),
            opened_by: API,
            correlation_id: "c-1".into(),
            reason: "upload".into(),
            opened_at: Instant::now()
                .checked_sub(age)
                .expect("Instant far enough from the epoch"),
        }
    }

    fn pending(age: Duration) -> PendingTransfer {
        pending_named("share", "x.part", age)
    }

    #[test]
    fn a_token_works_once() {
        let mut r = TransferRegistry::new();
        r.insert("t".into(), pending(Duration::ZERO))
            .expect("insert");

        assert!(r.claim("t", API).is_ok());
        // A reusable token means a stale retry can append to a file the first connection already
        // published — corruption of something the user can see.
        //
        // `matches!` rather than `assert_eq!`: a PendingTransfer holds an open descriptor and
        // deriving Debug on it would put a file handle in a panic message.
        assert!(matches!(r.claim("t", API), Err(ClaimError::Unknown)));
    }

    #[test]
    fn an_unknown_token_and_a_used_one_are_the_same_answer() {
        let mut r = TransferRegistry::new();
        r.insert("used".into(), pending(Duration::ZERO))
            .expect("insert");
        r.claim("used", API).expect("first claim");

        // Telling them apart would say whether a token ever existed, and a token is a secret.
        assert!(matches!(r.claim("used", API), Err(ClaimError::Unknown)));
        assert!(matches!(
            r.claim("never-existed", API),
            Err(ClaimError::Unknown)
        ));
    }

    #[test]
    fn an_expired_token_is_refused_and_says_so() {
        let mut r = TransferRegistry::new();
        r.insert("old".into(), pending(TRANSFER_TTL + Duration::from_secs(1)))
            .expect("insert");
        // Distinct from Unknown on purpose: this one is reachable by an honest slow client, and
        // "your upload window closed" is a different thing to tell them than "no such token".
        assert!(matches!(r.claim("old", API), Err(ClaimError::Expired)));
    }

    fn readable_named(share: &str, name: &str) -> PendingTransfer {
        let mut t = pending_named(share, name, Duration::from_secs(0));
        t.direction = Direction::Send;
        t
    }

    #[test]
    fn two_readers_of_one_file_are_both_allowed() {
        // Reading is not exclusive, and treating it as though it were is not a harmless extra
        // safeguard: two people opening the same document at once is ordinary use of a NAS.
        let mut registry = TransferRegistry::new();
        registry
            .insert("r1".into(), readable_named("alice", "Belgeler/rapor.txt"))
            .expect("the first reader");
        registry
            .insert("r2".into(), readable_named("alice", "Belgeler/rapor.txt"))
            .expect("the second reader must not be refused");
        assert_eq!(registry.pending_count(), 2);
    }

    #[test]
    fn an_unused_download_token_does_not_lock_the_file() {
        // The failure this prevents was measured in P1-D. An unsatisfiable Range answers 416
        // without ever opening a data connection, so its token is never claimed — and while the
        // read still took a reservation, the next download of that file was refused as "already
        // has a reader" for the whole TRANSFER_TTL.
        let mut registry = TransferRegistry::new();
        registry
            .insert("abandoned".into(), readable_named("alice", "rapor.txt"))
            .expect("insert");
        assert!(
            !registry.is_busy("alice", "rapor.txt"),
            "an open read must not make the name busy"
        );
        registry
            .insert("next".into(), readable_named("alice", "rapor.txt"))
            .expect("a later reader must not be blocked by an abandoned token");
    }

    #[test]
    fn a_read_never_blocks_a_publish() {
        // The in-flight mark exists to stop a rename landing on a file being APPENDED to. A reader
        // does not need it: an open descriptor keeps its inode whatever happens to the name, and
        // RENAME_NOREPLACE refuses an occupied destination on its own.
        let mut registry = TransferRegistry::new();
        registry
            .insert("r".into(), readable_named("alice", "rapor.txt"))
            .expect("insert");
        let (_transfer, _key) = registry.claim("r", API).expect("claim");
        assert!(!registry.is_busy("alice", "rapor.txt"));
        assert_eq!(registry.in_flight_count(), 0);
    }

    #[test]
    fn a_token_belongs_to_the_uid_that_opened_it() {
        // Without this, a token seen in a log line or a traced response is a bearer write into
        // somebody else's share — and depsis-worker runs as the same user as the API, so DAC on the
        // socket does not separate them either.
        let mut r = TransferRegistry::new();
        r.insert("mine".into(), pending(Duration::ZERO))
            .expect("insert");

        assert!(matches!(r.claim("mine", OTHER), Err(ClaimError::NotYours)));
        // And the refusal must not have burned it: the rightful owner can still redeem it.
        assert!(r.claim("mine", API).is_ok());
    }

    #[test]
    fn two_transfers_cannot_name_one_file() {
        // The interlock. Both would sit at the same offset and their data connections would
        // overwrite each other, with no error at any layer.
        let mut r = TransferRegistry::new();
        r.insert(
            "first".into(),
            pending_named("alice", "u.part", Duration::ZERO),
        )
        .expect("first insert");

        assert_eq!(
            r.insert(
                "second".into(),
                pending_named("alice", "u.part", Duration::ZERO)
            ),
            Err(InsertError::Occupied)
        );
        // A DIFFERENT file in the same share is fine.
        assert!(r
            .insert(
                "third".into(),
                pending_named("alice", "v.part", Duration::ZERO)
            )
            .is_ok());
        // And the same name in a different share is a different file.
        assert!(r
            .insert(
                "fourth".into(),
                pending_named("bob", "u.part", Duration::ZERO)
            )
            .is_ok());
    }

    #[test]
    fn a_file_being_written_cannot_be_claimed_again_or_published() {
        let mutex = std::sync::Mutex::new(TransferRegistry::new());
        {
            let mut r = mutex.lock().expect("lock");
            r.insert("t".into(), pending_named("alice", "u.part", Duration::ZERO))
                .expect("insert");
            let (_transfer, key) = r.claim("t", API).expect("claim");
            assert_eq!(key, ("alice".to_string(), "u.part".to_string()));

            // The name never became free between "reserved" and "streaming".
            assert!(
                r.is_busy("alice", "u.part"),
                "a streaming file must read as busy"
            );
            assert_eq!(
                r.insert(
                    "again".into(),
                    pending_named("alice", "u.part", Duration::ZERO)
                ),
                Err(InsertError::Occupied)
            );
            assert_eq!(r.in_flight_count(), 1);
        }

        // The guard releases it, so a crashed thread cannot leave the name unpublishable.
        {
            let _guard = guard_in_flight(&mutex, ("alice".into(), "u.part".into()));
        }
        let r = mutex.lock().expect("lock");
        assert!(
            !r.is_busy("alice", "u.part"),
            "the guard must clear the mark"
        );
    }

    #[test]
    fn the_registry_has_a_ceiling() {
        // Every entry is a descriptor held by a root daemon. Without a cap, a burst of opens
        // exhausts RLIMIT_NOFILE and takes the control socket down with it.
        let mut r = TransferRegistry::new();
        for i in 0..MAX_PENDING_TRANSFERS {
            r.insert(
                format!("t{i}"),
                pending_named("alice", &format!("{i}.part"), Duration::ZERO),
            )
            .expect("insert within the cap");
        }
        assert_eq!(
            r.insert(
                "one-too-many".into(),
                pending_named("alice", "extra.part", Duration::ZERO)
            ),
            Err(InsertError::Full)
        );
    }

    #[test]
    fn abandoned_transfers_do_not_accumulate() {
        // Five abandoned uploads must not end up holding five descriptors and five half-written
        // files open forever. The mechanism is a sweep on every insert, so they never pile up.
        let mut r = TransferRegistry::new();
        for i in 0..5 {
            let _ = r.insert(
                format!("stale{i}"),
                pending_named("alice", &format!("{i}.part"), TRANSFER_TTL * 2),
            );
        }
        assert_eq!(r.pending_count(), 1, "stale transfers must not accumulate");

        r.insert(
            "fresh".into(),
            pending_named("alice", "fresh.part", Duration::ZERO),
        )
        .expect("insert");
        assert_eq!(
            r.pending_count(),
            1,
            "and the last stale one goes on the next insert"
        );
        assert!(r.claim("fresh", API).is_ok());
    }

    #[test]
    fn expiring_a_transfer_frees_its_file_name() {
        // Otherwise an abandoned upload makes its own staging name permanently unusable: the token
        // is gone but the reservation outlives it, and every retry is refused as Occupied.
        let mut r = TransferRegistry::new();
        r.insert(
            "old".into(),
            pending_named("alice", "u.part", TRANSFER_TTL * 2),
        )
        .expect("insert");
        assert!(r.is_busy("alice", "u.part"));

        // Any operation sweeps.
        let _ = r.claim("nothing", API);
        assert!(
            !r.is_busy("alice", "u.part"),
            "an expired reservation must release the name"
        );
        assert!(r
            .insert(
                "retry".into(),
                pending_named("alice", "u.part", Duration::ZERO)
            )
            .is_ok());
    }
}
