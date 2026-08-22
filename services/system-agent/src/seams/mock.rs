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
    owners: RefCell<Vec<(u32, u32)>>,
}

impl MockSafePath {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            owners: RefCell::new(Vec::new()),
        }
    }

    /// The `(uid, gid)` pairs `set_owner` was called with.
    pub fn owners(&self) -> Vec<(u32, u32)> {
        self.owners.borrow().clone()
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
        std::fs::File::open(&path).map_err(|e| SeamError::Io(format!("{}: {e}", path.display())))
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
        if destination.exists() {
            return Err(SeamError::Io(format!("{to}: already exists")));
        }
        std::fs::rename(&source, &destination)
            .map_err(|e| SeamError::Io(format!("rename {from} -> {to}: {e}")))
    }

    fn set_owner(&self, _file: &std::fs::File, uid: u32, gid: u32) -> Result<(), SeamError> {
        self.owners.borrow_mut().push((uid, gid));
        Ok(())
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
