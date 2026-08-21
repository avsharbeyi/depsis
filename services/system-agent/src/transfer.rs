//! The registry that ties a one-time token to an already-resolved staging file.
//!
//! This exists because the bulk data path needs two connections and a capability has to survive
//! between them. The control socket resolves the path under `openat2(RESOLVE_BENEATH)` and keeps
//! the descriptor here; the data socket presents a token and gets that descriptor back. Nothing
//! the caller sends on the data socket names a path, so the second connection cannot widen what
//! the first one was confined to — which is the whole reason the token exists rather than simply
//! repeating the file name on the data channel.
//!
//! Platform-neutral by construction: it holds `std::fs::File`, which exists everywhere, so the
//! core keeps its zero-`cfg` property (ADR-0006).

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// How long an opened transfer waits for its data connection.
///
/// Long enough for a client to be slow, short enough that an abandoned upload does not hold a
/// descriptor and a partially written file open indefinitely. ADR-0008 also has a `expiration`
/// reaper for the `.part` files themselves; this is the narrower in-process lifetime.
pub const TRANSFER_TTL: Duration = Duration::from_secs(300);

/// A token's length in bytes before hex encoding.
///
/// 32 bytes. The token authorizes writing to an already-chosen file, so guessing one is only
/// useful to a process that already passed SO_PEERCRED — but "only useful to an attacker who is
/// already inside" is exactly the reasoning that turns a small number into a real one later.
pub const TOKEN_BYTES: usize = 32;

pub struct PendingTransfer {
    pub file: std::fs::File,
    /// Kept for the audit line when the data connection arrives, so the two halves of one upload
    /// can be tied together by something other than timing.
    pub share: String,
    pub staging_name: String,
    pub opened_at: Instant,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ClaimError {
    /// No such token, or it was already used. Deliberately one outcome: telling them apart would
    /// say whether a token ever existed, and a token is a secret.
    Unknown,
    Expired,
}

#[derive(Default)]
pub struct TransferRegistry {
    pending: HashMap<String, PendingTransfer>,
}

impl TransferRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register an opened file and return its token.
    ///
    /// The token is supplied rather than generated here so the core stays free of a random-number
    /// dependency and tests can pin one. Callers in production must pass a
    /// cryptographically-random value; `unix::random_token` is the one that does.
    pub fn insert(&mut self, token: String, transfer: PendingTransfer) {
        self.expire_old();
        self.pending.insert(token, transfer);
    }

    /// Take a transfer, if the token names a live one.
    ///
    /// Removes it: a token is ONE-TIME. Leaving it usable would mean a second data connection
    /// could append to a file the first one already finished and published, which turns a stale
    /// retry into corruption of a file the user can already see.
    pub fn claim(&mut self, token: &str) -> Result<PendingTransfer, ClaimError> {
        // Remove FIRST, decide second, sweep last. An earlier version swept before looking, which
        // deleted the very entry the `Expired` branch needed and made every timed-out transfer
        // report `Unknown` — the branch was unreachable, and an honest slow client would have been
        // told its token never existed. The test caught it.
        let claimed = self.pending.remove(token);
        self.expire_old();
        match claimed {
            None => Err(ClaimError::Unknown),
            Some(t) if t.opened_at.elapsed() > TRANSFER_TTL => Err(ClaimError::Expired),
            Some(t) => Ok(t),
        }
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// Drop anything past its lifetime.
    ///
    /// Called on every insert and claim rather than from a timer: a timer is another thread and
    /// another failure mode, and the registry only changes size when one of these two runs. An
    /// abandoned transfer therefore holds its descriptor until the next operation touches the
    /// registry, which on an idle agent is the correct amount of work — none.
    fn expire_old(&mut self) {
        self.pending
            .retain(|_, t| t.opened_at.elapsed() <= TRANSFER_TTL);
    }
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

    fn a_file() -> std::fs::File {
        tempfile::tempfile().expect("tempfile")
    }

    fn pending(age: Duration) -> PendingTransfer {
        PendingTransfer {
            file: a_file(),
            share: "share".into(),
            staging_name: "x.part".into(),
            opened_at: Instant::now()
                .checked_sub(age)
                .expect("Instant far enough from the epoch"),
        }
    }

    #[test]
    fn a_token_works_once() {
        let mut r = TransferRegistry::new();
        r.insert("t".into(), pending(Duration::ZERO));

        assert!(r.claim("t").is_ok());
        // The second attempt must fail. A reusable token means a stale retry can append to a file
        // the first connection already published — corruption of something the user can see.
        //
        // `matches!` rather than `assert_eq!`: a PendingTransfer holds an open descriptor and
        // deriving Debug on it would put a file handle in a panic message. Not comparing it is
        // the point — the interesting half is the error.
        assert!(matches!(r.claim("t"), Err(ClaimError::Unknown)));
    }

    #[test]
    fn an_unknown_token_and_a_used_one_are_the_same_answer() {
        let mut r = TransferRegistry::new();
        r.insert("used".into(), pending(Duration::ZERO));
        r.claim("used").expect("first claim");

        // Telling them apart would say whether a token ever existed, and a token is a secret.
        assert!(matches!(r.claim("used"), Err(ClaimError::Unknown)));
        assert!(matches!(r.claim("never-existed"), Err(ClaimError::Unknown)));
    }

    #[test]
    fn an_expired_token_is_refused_and_says_so() {
        let mut r = TransferRegistry::new();
        r.insert("old".into(), pending(TRANSFER_TTL + Duration::from_secs(1)));
        // Distinct from Unknown on purpose: this one is reachable by an honest slow client, and
        // "your upload window closed" is a different thing to tell them than "no such token".
        assert!(matches!(r.claim("old"), Err(ClaimError::Expired)));
    }

    #[test]
    fn abandoned_transfers_do_not_accumulate() {
        // The property: five abandoned uploads must not end up holding five descriptors and five
        // half-written files open forever.
        //
        // The mechanism is a sweep on every insert, so they never pile up in the first place —
        // each insert reaps the ones before it and only the newest survives its own call. An
        // earlier version of this test asserted len() == 5 after the loop, which was asserting the
        // absence of the behaviour it was written to check.
        let mut r = TransferRegistry::new();
        for i in 0..5 {
            r.insert(format!("stale{i}"), pending(TRANSFER_TTL * 2));
        }
        assert_eq!(r.len(), 1, "stale transfers must not accumulate");

        r.insert("fresh".into(), pending(Duration::ZERO));
        assert_eq!(r.len(), 1, "and the last stale one goes on the next insert");
        assert!(r.claim("fresh").is_ok());
        assert!(r.is_empty());
    }
}
