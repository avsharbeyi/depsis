//! The four seams (ADR-0006).
//!
//! The agent core — request dispatch, authorization, audit — contains ZERO `cfg` attributes and
//! compiles everywhere. Everything platform-specific lives behind one of these four traits, so
//! the core can be exercised on a Windows developer machine against mocks while the real
//! implementations exist only on Unix.
//!
//! This is not abstraction for its own sake. Each trait marks a place where the agent touches
//! something that can hurt: the socket that decides *who* is talking, the path resolution that
//! decides *what* can be reached, and the process spawn that decides *what runs*.

use crate::op::Response;

pub mod mock;

/// Who is on the other end of the connection.
///
/// On Unix this comes from `SO_PEERCRED`, which the kernel fills in — the caller cannot forge
/// it. That property is the reason authorization can be decided here at all, and it is exactly
/// what a TCP transport would throw away.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerIdentity {
    pub uid: u32,
    pub gid: u32,
    pub pid: i32,
}

#[derive(Debug, thiserror::Error)]
pub enum SeamError {
    #[error("peer credentials unavailable: {0}")]
    NoPeerCred(String),
    #[error("path escapes the share root: {0}")]
    PathEscape(String),
    #[error("io: {0}")]
    Io(String),
    #[error("command {program} failed with status {status}: {stderr}")]
    Command {
        program: String,
        status: i32,
        stderr: String,
    },
}

/// Resolve a caller-supplied relative path underneath a fixed root, or refuse.
///
/// The real implementation uses `openat2` with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
/// RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV` from a root fd held open for the process lifetime.
///
/// `BENEATH` rather than `IN_ROOT` is a deliberate choice: `IN_ROOT` silently clamps an escape
/// attempt to the root, which means a traversal attempt succeeds quietly. `BENEATH` refuses,
/// which turns it into an audit event. A traversal that is silently corrected is a traversal
/// nobody ever finds out about.
pub trait SafePath {
    /// `relative` is a sequence of already-validated single components (see `SafeComponent`).
    fn resolve(&self, relative: &[&str]) -> Result<std::path::PathBuf, SeamError>;
}

/// Run one of a fixed set of external programs.
///
/// Implementations must:
///   - use an ABSOLUTE program path (never a PATH lookup — `execvp` falls back to `/bin:/usr/bin`),
///   - pass an explicit argv vector with no shell anywhere,
///   - clear the environment and re-add only a fixed allowlist.
pub trait CommandRunner {
    fn run(&self, program: &str, args: &[&str]) -> Result<String, SeamError>;
}

/// Where requests arrive from. Real: a Unix socket. Mock: an in-memory pipe.
///
/// The mock is in-memory rather than TCP-on-loopback on purpose. TCP would carry no peer
/// credentials, so `PeerIdentity` would have to be stubbed anyway — and in exchange you pay
/// port allocation, flaky parallel tests, and a real listening socket on a developer's machine.
pub trait Transport {
    /// Read one newline-delimited request, or `None` at end of stream.
    fn recv(&mut self) -> Result<Option<String>, SeamError>;
    fn send(&mut self, response: &Response) -> Result<(), SeamError>;
    fn peer(&self) -> Result<PeerIdentity, SeamError>;
}
