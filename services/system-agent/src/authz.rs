//! Who may ask for what.
//!
//! The agent trusts `SO_PEERCRED` and nothing else. It does not trust a uid carried inside the
//! request body, because the request body is written by the caller; the credentials are written
//! by the kernel.

use crate::op::Request;
use crate::seams::PeerIdentity;

/// The uid the DEPSIS API is expected to run as. Configured at startup, never inferred from a
/// request.
#[derive(Debug, Clone, Copy)]
pub struct Policy {
    pub api_uid: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Deny(&'static str),
}

impl Policy {
    /// Authorize a request from a peer.
    ///
    /// The check is intentionally coarse: one caller, the API. There is no per-operation role
    /// matrix here because that would duplicate the application's authorization model in a
    /// second place, and two authorization models drift. The application decides *whether a
    /// user may do a thing*; the agent decides *whether the caller is the application*.
    pub fn authorize(&self, peer: PeerIdentity, _request: &Request) -> Decision {
        if peer.uid == self.api_uid {
            Decision::Allow
        } else if peer.uid == 0 {
            // Root could bypass the socket entirely, so refusing is not a security control —
            // but accepting would let a stray root script drive privileged ZFS operations
            // without appearing in the audit trail as the API. Refuse and make it visible.
            Decision::Deny("root is not the API; use the API's uid")
        } else {
            Decision::Deny("caller uid is not the configured API uid")
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
    use crate::op::Request;

    const POLICY: Policy = Policy { api_uid: 999 };

    fn peer(uid: u32) -> PeerIdentity {
        PeerIdentity {
            uid,
            gid: uid,
            pid: 1234,
        }
    }

    #[test]
    fn the_api_uid_is_allowed() {
        assert_eq!(
            POLICY.authorize(peer(999), &Request::Ping {}),
            Decision::Allow
        );
    }

    #[test]
    fn another_users_uid_is_denied() {
        assert!(matches!(
            POLICY.authorize(peer(1000), &Request::Ping {}),
            Decision::Deny(_)
        ));
    }

    #[test]
    fn root_is_denied_so_that_privileged_calls_stay_attributable() {
        assert!(matches!(
            POLICY.authorize(peer(0), &Request::Ping {}),
            Decision::Deny(_)
        ));
    }
}
