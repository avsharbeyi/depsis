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

/// What a caller intends to do with a path, so the open can say so up front.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenIntent {
    /// An existing file, read-only.
    Read,
    /// A file that must NOT already exist. The exclusive create is the atomic part: two callers
    /// racing to claim the same staging name cannot both win.
    CreateNew,
    /// Write, creating if absent, with the kernel resolving the write position at EVERY write
    /// (`O_APPEND`). For resuming an upload into a `.part` that already exists.
    ///
    /// The atomicity matters: a cached offset is a number that can disagree with the file by the
    /// time it is used, and this variant is the one the upload path writes through.
    Append,
}

/// Open a caller-supplied relative path underneath a fixed root, or refuse.
///
/// This hands back the OPEN FILE, never a path, and the difference is the whole point.
///
/// An earlier version resolved with `openat2`, dropped the descriptor, and returned a joined
/// `PathBuf` for somebody else to open later. That uses `openat2` as a CHECK rather than as the
/// operation, and check-then-use is the shape of every TOCTOU bug: between the check and the
/// reopen, a component can be replaced with a symlink and the second resolution — an ordinary one,
/// with none of the RESOLVE_ flags — follows it out of the root. Nothing called it yet, so nothing
/// was exploitable, but the upload path was about to be built directly on top of it, which would
/// have made the confinement decorative in the one operation that writes user data.
///
/// Returning `std::fs::File` rather than a raw descriptor keeps the core free of `cfg`: the type
/// exists on every platform, the real implementation converts the `openat2` result into one, and
/// the mock opens a real file under a temporary root.
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
    fn open(&self, relative: &[&str], intent: OpenIntent) -> Result<std::fs::File, SeamError>;

    /// The DIRECTORY at `relative`, opened under the same confinement.
    ///
    /// Needed because durability is not finished when the data is written: ADR-0008 step 5 is an
    /// `fsync` on the destination directory, and without it a power cut can lose the rename even
    /// though the file's own contents survived.
    fn open_dir(&self, relative: &[&str]) -> Result<std::fs::File, SeamError>;

    /// Move a staged file into place and make the move durable.
    ///
    /// ONE method rather than a rename the caller then has to remember to fsync. ADR-0008 step 5
    /// is precisely the step people skip, and a two-call API is an invitation to skip it — the
    /// failure is invisible until a power cut, and then the data is on disk with nothing pointing
    /// at it.
    ///
    /// Must refuse rather than overwrite. `RENAME_NOREPLACE` was measured working on ZFS 2.3.2 in
    /// P0-G; `linkat` + `unlink` is the portable fallback. Either way, publishing never silently
    /// destroys a file the user already has.
    fn publish(
        &self,
        from_dir: &[&str],
        from: &str,
        to_dir: &[&str],
        to: &str,
    ) -> Result<(), SeamError>;

    /// Give an already-open file to a uid and gid.
    ///
    /// Takes the FILE, not a path, for the same reason `open` returns one: a path would be
    /// re-resolved, and a chown aimed at a path is a chown that can be pointed somewhere else
    /// between the resolution and the call. Aimed at the descriptor, it changes the object
    /// `openat2` confined and nothing else — even if every component of the path it came from has
    /// since been replaced.
    ///
    /// Why this exists at all: without it a published file stays root-owned at 0600, so the user
    /// who uploaded it cannot read it back over SMB or through the API. That presents as "uploads
    /// are broken", and the fastest-looking repair is to widen the mode — which is exactly the
    /// cross-tenant read the threat model exists to prevent. Ownership is the correct axis.
    fn set_owner(&self, file: &std::fs::File, uid: u32, gid: u32) -> Result<(), SeamError>;

    /// The names of the directories directly under `relative`.
    ///
    /// For finding the shares. Symlinks are NOT followed and do not appear: a symlink in the share
    /// root pointing at `/` would otherwise turn the sweeper below into a recursive delete of the
    /// whole filesystem, which is the single worst thing a root daemon can be talked into.
    fn list_dirs(&self, relative: &[&str]) -> Result<Vec<String>, SeamError>;

    /// The names of the regular files directly under `relative` last modified more than
    /// `older_than` ago.
    ///
    /// Regular files only, and the age comes from the kernel rather than from anything the caller
    /// sent. Both halves matter: this feeds a delete loop in a process running as root.
    fn list_stale_files(
        &self,
        relative: &[&str],
        older_than: std::time::Duration,
    ) -> Result<Vec<String>, SeamError>;

    /// Unlink one file under `dir`. `Ok(false)` if it was already gone.
    ///
    /// "Already gone" is a normal outcome, not an error: the sweeper and an explicit
    /// `DiscardTransfer` can race for the same abandoned file, and turning that into a failure
    /// would make a successful cleanup look like a fault.
    fn remove_file(&self, dir: &[&str], name: &str) -> Result<bool, SeamError>;
}

/// Where unguessable values come from.
///
/// A seam for the same reason the other four are: this marks a place where the agent touches
/// something that can hurt. A transfer token authorizes writing to an already-chosen file, so a
/// predictable one lets a process that has passed SO_PEERCRED — but was meant to be writing to
/// its OWN upload — write into somebody else's. Putting it behind a trait keeps the core free of
/// a randomness dependency and makes the real source a single, reviewable place.
///
/// A trait object rather than a generic parameter: this is called once per transfer, never in a
/// loop, and a fifth type parameter on `Agent` would cost every call site more than it is worth.
pub trait TokenSource {
    /// A fresh, unguessable, printable token.
    fn token(&self) -> String;
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
