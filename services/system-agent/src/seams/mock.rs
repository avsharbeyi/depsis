//! Portable mock seams. These compile and run everywhere, including Windows.
//!
//! Deliberately NOT a simulation. `MockSafePath` uses a real temporary directory and real
//! filesystem calls; it only differs in where the root is. Writing a fake filesystem would let
//! tests verify behaviour the real system does not have — which is worse than no test, because
//! it reads as coverage.
//!
//! `MockCommandRunner` is the exception, and for a reason: it records argv instead of executing
//! it. The thing worth asserting is *what would have been run*, and running `zpool` for real is
//! exactly what the mock exists to avoid.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::path::PathBuf;

use super::{CommandRunner, OpenIntent, PeerIdentity, SafePath, SeamError, TokenSource, Transport};
use crate::op::Response;

/// An in-memory transport: requests are queued up front, responses are collected.
pub struct MockTransport {
    incoming: VecDeque<String>,
    pub sent: Vec<Response>,
    peer: PeerIdentity,
}

impl MockTransport {
    pub fn new(requests: impl IntoIterator<Item = String>, peer: PeerIdentity) -> Self {
        Self {
            incoming: requests.into_iter().collect(),
            sent: Vec::new(),
            peer,
        }
    }
}

impl Transport for MockTransport {
    fn recv(&mut self) -> Result<Option<String>, SeamError> {
        Ok(self.incoming.pop_front())
    }

    fn send(&mut self, response: &Response) -> Result<(), SeamError> {
        self.sent.push(response.clone());
        Ok(())
    }

    fn peer(&self) -> Result<PeerIdentity, SeamError> {
        Ok(self.peer)
    }
}

/// Real filesystem, rooted at a caller-supplied directory.
///
/// The containment check here is weaker than `openat2(RESOLVE_BENEATH)` — it is a
/// lexical/canonicalisation check, not a kernel-enforced one, and it cannot defend against a
/// symlink swapped in between the check and the open. That TOCTOU gap is precisely why the real
/// implementation uses `openat2`, and why storage claims are only ever accepted from the Debian
/// VM (ADR-0007: "mock backend ile alınan sonuçlar depolama davranışının kanıtı sayılamaz").
pub struct MockSafePath {
    root: PathBuf,
    /// Every `set_owner` call, in order.
    ///
    /// Recorded rather than performed. A real `chown` needs CAP_CHOWN, so a portable test running
    /// as an ordinary user could only ever assert "it failed" — which is indistinguishable from
    /// the call never being made. Recording lets the dispatcher tests assert that the publish path
    /// asks for the right owner; that it actually takes effect is measured against a real kernel
    /// in `unix.rs` and end to end in P1-D.
    /// A `Mutex` rather than a `RefCell`, and not for concurrency inside the mock — nothing here
    /// is shared between threads. It is so `MockSafePath` is `Sync`, which the sweeper requires of
    /// any `SafePath` because it runs on its own thread. A `RefCell` here would mean the sweeper
    /// could not be tested against the mock at all, and the untested path in a root daemon would be
    /// the one that deletes user files.
    owners: std::sync::Mutex<Vec<(u32, u32)>>,
    /// Every mode `set_mode` was asked for, in order. Recorded rather than performed, like
    /// `owners`: a real mode change is measured against a kernel in `unix.rs`, and what the
    /// portable tests can pin is that the dispatcher asked for the right one.
    modes: std::sync::Mutex<Vec<u32>>,
    /// The path of the most recent `open_dir`, so `command_path` can answer with a real one.
    ///
    /// The real implementation asks the kernel for `/proc/self/fd/N` and needs no bookkeeping. The
    /// mock cannot: recovering a path from a `std::fs::File` portably is not possible, and putting
    /// a `cfg` here to use procfs on Linux would break the Windows cross-check that keeps this
    /// crate honest.
    ///
    /// "Most recent" is sound for what this is for and nothing more. `Applier::apply` opens exactly
    /// one directory and then asks for its command path, in that order, on one thread — the pairing
    /// is immediate. Nothing else calls `command_path`. It is emphatically NOT a general
    /// descriptor-to-path map, and a second concurrent caller would read the wrong one; that is
    /// acceptable in a mock whose own doc comment already says storage claims come from the VM.
    last_dir: std::sync::Mutex<Option<PathBuf>>,
    /// How many times `command_path` was asked, so a caller can be held to USING it.
    ///
    /// The mock necessarily answers `command_path` with the same string a naive join would
    /// produce — it has no procfs to point at — so a test that only compares the argv cannot tell
    /// the descriptor form from the re-joined path it replaced. Verified: reverting
    /// `Applier::apply` to the joined path left every argv assertion passing. Counting the call is
    /// the part that does discriminate; that what it returns is swap-proof is asserted against a
    /// real kernel in `unix.rs`.
    command_paths: std::sync::Mutex<usize>,
}

impl MockSafePath {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            owners: std::sync::Mutex::new(Vec::new()),
            modes: std::sync::Mutex::new(Vec::new()),
            last_dir: std::sync::Mutex::new(None),
            command_paths: std::sync::Mutex::new(0),
        }
    }

    /// How many times `command_path` was called. See the field.
    pub fn command_paths(&self) -> usize {
        *self
            .command_paths
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The `(uid, gid)` pairs `set_owner` was called with.
    pub fn modes(&self) -> Vec<u32> {
        self.modes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub fn owners(&self) -> Vec<(u32, u32)> {
        self.owners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

impl MockSafePath {
    /// String inspection, which is exactly what the real implementation does NOT rely on —
    /// see the note on this struct. It is here so the portable tests can drive the
    /// dispatcher, not so anyone believes it confines anything.
    fn join(&self, relative: &[&str]) -> Result<PathBuf, SeamError> {
        let mut p = self.root.clone();
        for component in relative {
            if component.is_empty()
                || *component == "."
                || *component == ".."
                || component.contains('/')
                || component.contains('\\')
            {
                return Err(SeamError::PathEscape((*component).to_string()));
            }
            p.push(component);
        }
        Ok(p)
    }
}

impl SafePath for MockSafePath {
    fn open(&self, relative: &[&str], intent: OpenIntent) -> Result<std::fs::File, SeamError> {
        let path = self.join(relative)?;
        let mut options = std::fs::OpenOptions::new();
        match intent {
            OpenIntent::Read => options.read(true),
            OpenIntent::CreateNew => options.write(true).create_new(true),
            OpenIntent::Append => options.write(true).create(true),
        };
        options
            .open(&path)
            .map_err(|e| SeamError::Io(format!("{}: {e}", path.display())))
    }

    fn open_dir(&self, relative: &[&str]) -> Result<std::fs::File, SeamError> {
        let path = self.join(relative)?;
        // `NotFound`/`NotADirectory` rather than a blanket `Io`, so the dispatcher arms that turn
        // those into a 404 and a refusal are reachable from a portable test at all. Before this the
        // mock reported both as `Io`, and every such arm was only ever exercised against a kernel.
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|_| SeamError::NotFound(path.display().to_string()))?;
        if !metadata.is_dir() {
            return Err(SeamError::NotADirectory(path.display().to_string()));
        }
        let file = std::fs::File::open(&path)
            .map_err(|e| SeamError::Io(format!("{}: {e}", path.display())))?;
        *self
            .last_dir
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(path);
        Ok(file)
    }

    /// A real path under the temp root — see the field note on `last_dir`.
    fn command_path(&self, _dir: &std::fs::File) -> Result<String, SeamError> {
        *self
            .command_paths
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) += 1;
        let held = self
            .last_dir
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match held.as_ref() {
            Some(path) => path
                .to_str()
                .map(str::to_string)
                .ok_or_else(|| SeamError::Io("temp root is not utf-8".to_string())),
            // Not reachable through `Applier`, which opens before it asks. Reported rather than
            // defaulted to the root, because a mock that quietly names the wrong directory would
            // make an ACL test pass while asserting nothing.
            None => Err(SeamError::Io(
                "command_path called before any open_dir".to_string(),
            )),
        }
    }

    fn publish(
        &self,
        from_dir: &[&str],
        from: &str,
        to_dir: &[&str],
        to: &str,
    ) -> Result<(), SeamError> {
        let source = self.join(from_dir)?.join(from);
        let destination = self.join(to_dir)?.join(to);
        // `std::fs::rename` OVERWRITES, which is the opposite of what the real one does, so the
        // refusal is checked here first. That check is racy — which is the point of the note on
        // this struct: the mock exercises the dispatcher, and storage claims come from the VM.
        //
        // `symlink_metadata`, not `exists()`: a dangling symlink at the destination is a name that
        // is TAKEN, and `exists()` follows the link and reports it free. Overwriting it would be
        // the same data loss the NOREPLACE flag exists to prevent, arrived at through the mock.
        if destination.symlink_metadata().is_ok() {
            return Err(SeamError::AlreadyExists(to.to_string()));
        }
        match std::fs::rename(&source, &destination) {
            Ok(()) => Ok(()),
            // The typed variants the trait asks for. `MoveEntry` turns these into 404 and 409, and
            // the dispatcher tests that assert that run against this implementation.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Err(SeamError::NotFound(from.to_string()))
            }
            Err(e) => Err(SeamError::Io(format!("rename {from} -> {to}: {e}"))),
        }
    }

    fn create_dir(&self, dir: &[&str], name: &str, uid: u32, gid: u32) -> Result<(), SeamError> {
        let parent = self.join(dir)?;
        // `join` again with the name as its own component, so a name the dispatcher somehow let
        // through as a path is refused here too rather than pushed onto a PathBuf.
        let mut full: Vec<&str> = dir.to_vec();
        full.push(name);
        let path = self.join(&full)?;

        // A missing parent must be `NotFound` and not `Io`, because the dispatcher turns exactly
        // that into a 404. `std::fs::create_dir` reports ENOENT for it, but it reports the same
        // kind for other things on other platforms, so the parent is checked first and the
        // distinction is not left to an errno translation this mock does not control.
        if !parent.is_dir() {
            return Err(SeamError::NotFound(dir.join("/")));
        }
        match std::fs::create_dir(&path) {
            Ok(()) => {}
            // `symlink_metadata` is what `create_dir` effectively checks: a dangling symlink at
            // the name is a name that is TAKEN, and the real `mkdirat` returns EEXIST for it.
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(SeamError::AlreadyExists(name.to_string()));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(SeamError::NotFound(dir.join("/")));
            }
            Err(e) => return Err(SeamError::Io(format!("mkdir {name}: {e}"))),
        }

        // Recorded, not performed — see the note on `owners`. A real chown needs CAP_CHOWN and a
        // real 0750 needs a Unix mode, so both claims are measured against a kernel in `unix.rs`;
        // what the portable tests can pin is that the dispatcher asked for the right owner.
        self.owners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((uid, gid));
        Ok(())
    }

    fn set_owner(&self, _file: &std::fs::File, uid: u32, gid: u32) -> Result<(), SeamError> {
        self.owners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((uid, gid));
        Ok(())
    }

    fn set_mode(&self, _file: &std::fs::File, mode: u32) -> Result<(), SeamError> {
        self.modes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(mode);
        Ok(())
    }

    fn list_dirs(&self, relative: &[&str]) -> Result<Vec<String>, SeamError> {
        let path = self.join(relative)?;
        let mut names = Vec::new();
        for entry in std::fs::read_dir(&path)
            .map_err(|e| SeamError::Io(format!("{}: {e}", path.display())))?
        {
            let entry = entry.map_err(|e| SeamError::Io(format!("readdir: {e}")))?;
            // `symlink_metadata`, so a symlink to a directory is not reported as one.
            let meta = entry
                .path()
                .symlink_metadata()
                .map_err(|e| SeamError::Io(format!("stat: {e}")))?;
            if meta.is_dir() {
                names.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
        names.sort();
        Ok(names)
    }

    fn list_stale_files(
        &self,
        relative: &[&str],
        older_than: std::time::Duration,
    ) -> Result<Vec<String>, SeamError> {
        let path = self.join(relative)?;
        let now = std::time::SystemTime::now();
        let mut names = Vec::new();
        for entry in std::fs::read_dir(&path)
            .map_err(|e| SeamError::Io(format!("{}: {e}", path.display())))?
        {
            let entry = entry.map_err(|e| SeamError::Io(format!("readdir: {e}")))?;
            let meta = entry
                .path()
                .symlink_metadata()
                .map_err(|e| SeamError::Io(format!("stat: {e}")))?;
            if !meta.is_file() {
                continue;
            }
            let modified = meta
                .modified()
                .map_err(|e| SeamError::Io(format!("mtime: {e}")))?;
            // A file from the future is treated as fresh. Clock skew must never make the sweeper
            // MORE eager: the cost of keeping a stale file one cycle longer is disk, and the cost
            // of deleting a live upload is the user's data.
            if now.duration_since(modified).unwrap_or_default() > older_than {
                names.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
        names.sort();
        Ok(names)
    }

    fn remove_file(&self, dir: &[&str], name: &str) -> Result<bool, SeamError> {
        let path = self.join(dir)?.join(name);
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(SeamError::Io(format!("unlink {name}: {e}"))),
        }
    }

    fn remove_dir(&self, dir: &[&str], name: &str) -> Result<bool, SeamError> {
        let path = self.join(dir)?.join(name);
        // `remove_dir`, never `remove_dir_all`. The real implementation cannot recurse — one
        // `unlinkat(AT_REMOVEDIR)` either succeeds or returns ENOTEMPTY — and a mock that quietly
        // could would let a test assert a tree delete the agent is incapable of. That is worse than
        // no test: it reads as coverage for behaviour the product deliberately does not have.
        match std::fs::remove_dir(&path) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) if e.kind() == std::io::ErrorKind::DirectoryNotEmpty => {
                Err(SeamError::NotEmpty(name.to_string()))
            }
            Err(e) => Err(SeamError::Io(format!("rmdir {name}: {e}"))),
        }
    }
}

/// Predictable tokens, for tests only.
///
/// Deliberately NOT random: a test that cannot name the token it expects has to fish it out of a
/// response and then proves less. Nothing constructs this outside tests, and the real source is
/// `unix::KernelTokens`.
#[derive(Default)]
pub struct MockTokenSource {
    next: RefCell<u32>,
}

impl TokenSource for MockTokenSource {
    fn token(&self) -> String {
        let mut n = self.next.borrow_mut();
        *n += 1;
        format!("token-{n}")
    }
}

/// Records what would have been executed. Nothing is spawned.
#[derive(Default)]
pub struct MockCommandRunner {
    pub calls: RefCell<Vec<Vec<String>>>,
    responses: RefCell<VecDeque<String>>,
}

impl MockCommandRunner {
    pub fn with_responses(responses: impl IntoIterator<Item = String>) -> Self {
        Self {
            calls: RefCell::new(Vec::new()),
            responses: RefCell::new(responses.into_iter().collect()),
        }
    }

    /// The argv of the nth recorded call, for assertions.
    pub fn call(&self, n: usize) -> Option<Vec<String>> {
        self.calls.borrow().get(n).cloned()
    }
}

impl CommandRunner for MockCommandRunner {
    fn run(&self, program: &str, args: &[&str]) -> Result<String, SeamError> {
        let mut argv = vec![program.to_string()];
        argv.extend(args.iter().map(|a| (*a).to_string()));
        self.calls.borrow_mut().push(argv);
        Ok(self.responses.borrow_mut().pop_front().unwrap_or_default())
    }
}
