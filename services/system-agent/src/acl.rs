//! POSIX ACL application — the one authorization substrate the kernel actually enforces.
//!
//! ADR-0004 decided three things and this module is all three of them:
//!
//!   1. **POSIX ACL, not NFSv4.** P0-B measured that `acltype=nfsv4` on ZFS-on-Linux *sets
//!      cleanly*, *reports itself back as configured*, and enforces nothing at all. There is no
//!      signal. `AclType` in `op` makes the value unrepresentable at dataset creation; this module
//!      is the other half — when a dataset slipped through anyway, `setfacl` answers `Operation
//!      not supported`, and that answer gets its own error variant rather than being folded into
//!      "a command failed". An operator reading it must be told the dataset property is wrong, not
//!      sent looking for a broken agent.
//!
//!   2. **Entries go to GROUPS, never to users.** `AclEntry` carries a `gid` and nothing else.
//!      POSIX ACLs become unwieldy past ~30 entries and the mask semantics start biting, so the
//!      grant model is one POSIX group per share-role and users join groups. A per-user entry
//!      would be expressible in the syscall and wrong in the design, so it is not expressible
//!      here.
//!
//!   3. **Inheritance is the default ACL and nothing else.** Every application writes TWICE: the
//!      access ACL (`-m`) and the default ACL (`-d -m`). Without the second one, the folder is
//!      granted and everything created inside it afterwards is not — which is the failure that
//!      looks like it worked. `aclinherit`/`aclmode` do not help: they are NFSv4 properties and
//!      shape nothing on Linux.
//!
//! ## Why there is no injection surface
//!
//! The argv is a FIXED shape built from typed values. The share and every path component are
//! `SafeComponent` (no `/`, no `\`, no `..`, no NUL, no leading dash); a gid is a `u32`, so
//! `format!("g:{gid}:rwx")` cannot produce anything but digits and the three permission letters.
//! There is no shell anywhere — `CommandRunner` execs an absolute program path with an explicit
//! vector — so an argument cannot be re-split, and the path is passed after `--` so it cannot be
//! read as an option even if a component somehow began with one. Injection is impossible at the
//! type level rather than filtered at the string level.
//!
//! ## Why `setfacl` is given `/proc/self/fd/N` and never a joined path
//!
//! Because handing it a joined path re-resolves every component a second time, outside the
//! confinement, and that is not a residual window — it is the whole attack. This module used to
//! do it, with a comment calling the remainder "a rename of an intermediate directory". The
//! comment understated it twice: the FINAL component is equally swappable (the held descriptor
//! pins the inode, not the name), and `setfacl 2.3.2` was measured DEREFERENCING a symlink handed
//! to it as an argument. So an attacker with create rights anywhere in the share tree — any SMB
//! user in the parent folder — could `mv folder folder.bak && ln -s /etc folder` between our
//! `openat2` and the exec, and a root process would write `g:<their own team's gid>:rwx` plus the
//! matching default ACL onto `/etc`. Both halves of that are attacker-chosen. It was a complete
//! local privilege escalation and it is closed here rather than documented.
//!
//! `SafePath::command_path` answers `/proc/self/fd/N` for the descriptor `open_dir` returned. That
//! names the inode the kernel already confined, so there is no second resolution to lose: whatever
//! happens to the directory entries above it, the name still points at the object that passed
//! `RESOLVE_BENEATH | NO_SYMLINKS`. The joined path survives only as a DISPLAY string in errors —
//! `target()` builds it, nothing passes it to a program.
//!
//! `-P` is deliberately absent and must stay absent: `/proc/self/fd/N` is itself a magic symlink,
//! and `setfacl -P` skips symlink arguments silently — exit 0, nothing applied. The two mitigations
//! are mutually exclusive and this is the stronger one.
//!
//! ## Why there is no recursion
//!
//! There was, and it was wrong on three counts, so the operand is gone (see
//! `op::Request::ApplyFolderAcl`):
//!
//!   1. `setfacl -R` does not descend through `/proc/self/fd/N` — measured: it applies to the
//!      directory and stops, because the walk will not recurse into a symlink. Keeping recursion
//!      would have meant keeping the joined path, i.e. keeping the escalation above.
//!   2. `-R -b` clears every extended ACL in the subtree, so a sub-folder carrying §6.2's
//!      documented narrower grant lost it and inherited the parent's wider one — measured. The
//!      `folder_grants` row still said the narrow thing. That is the two-realities failure
//!      ADR-0004 forbids, in the widening direction.
//!   3. It is the shape §2.2/ADR-0006 rejects everywhere else in the operation set: one call whose
//!      blast radius the caller chooses, in the one process that can reach every tenant's data.
//!      `SafePath::remove_dir` says it outright about `rm -rf`, and this was the same primitive
//!      with a different verb. `-R` also walked straight into `<share>/.depsis/staging`, where it
//!      overrode the 0600 that keeps a half-uploaded file from being read — and, worse, made it
//!      group-WRITABLE, so a `.part` could be substituted in flight for content of equal length,
//!      which is all `PublishTransfer` checks.
//!
//! The API stores the tree, so a mass re-apply is a loop of these calls on the API's side, where
//! each folder's own grant row is the thing being written.
//!
//! ## Nothing calls this yet
//!
//! Stated plainly because two comments here used to describe an API that does not exist. No
//! controller sends `apply_folder_acl` and nothing writes `folder_grants` — the operation is
//! dispatchable and complete, and it has no caller. The practical consequence, since every folder
//! is created 0750 owned by its creator's private group, is that a second user in a share cannot
//! reach another's folder over SMB at all: the grant model is written, the kernel has not been
//! told, and until an API caller exists §6.2's per-folder permissions live only in Postgres.
//!
//! When that caller is written it must route the errors below through the API's `logged()` helper,
//! the way `files.controller.ts` already does for agent prose. Several variants embed absolute
//! host paths and raw `setfacl`/`getfacl` stderr, which is journal material and not a sentence for
//! a client — `shares.service.ts` and `smb.controller.ts` pass agent reasons straight through, and
//! that is the nearest pattern for someone to copy by mistake.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::op::AclEntry;
use crate::seams::{CommandRunner, SafePath, SeamError};

/// Absolute, for the reason `dispatch::bin` gives: `execvp` falls back to searching
/// `/bin:/usr/bin` when `PATH` is unset, so a bare program name is a supply-chain question.
///
/// Both come from Debian's `acl` package. DEPSIS does not ship it, so its absence is an ordinary
/// state of a machine — see `AclError::NotInstalled`.
pub const SETFACL: &str = "/usr/bin/setfacl";
pub const GETFACL: &str = "/usr/bin/getfacl";

/// Where the share tree is, on the same footing as `samba::CONFIG_PATH_ENV`: operator
/// configuration from systemd's `EnvironmentFile`, never an operand of a request. "Which tree
/// does the privileged daemon rewrite the permissions of" is not a question an unprivileged
/// caller may answer.
///
/// The same variable `main` opens the confined root from, read the same way, so the string this
/// yields and the root `SafePath` enforces are the same directory in the same process.
pub const SHARES_ROOT_ENV: &str = "DEPSIS_SHARES_ROOT";

/// One folder, and there is no other case. `setfacl` on a single directory is three `setxattr`
/// calls, so this is generous by three orders of magnitude and exists to bound a hung child rather
/// than to pace real work.
pub const TIMEOUT: Duration = Duration::from_secs(30);

/// ADR-0004's number, turned into a refusal.
///
/// "POSIX ACL'ler ~30 girdiden sonra hantallaşır ve mask semantiği ısırır" is the reason the grant
/// model is group-based at all. Past this point the ACL still *applies* and starts behaving in
/// ways the UI cannot explain, which is worse than being told no.
pub const MAX_ENTRIES: usize = 32;

#[derive(Debug, thiserror::Error)]
pub enum AclError {
    /// The `acl` package is not installed. NOT a fault.
    ///
    /// The same split ADR-0020 draws for ZeroTier and `samba::SambaError::NotInstalled` draws for
    /// Samba: DEPSIS packages none of them, so "absent" is a configuration state the API turns
    /// into 503 with a card that names the package. Reporting it as a failure sends an operator
    /// hunting a broken agent instead of running `apt install acl`.
    #[error("posix acl tools are not installed: {0} is not present")]
    NotInstalled(String),

    /// `setfacl` said `Operation not supported`, which on ZFS means one thing.
    ///
    /// Its own variant because the message an operator needs is not "a command failed" — it is
    /// "this dataset has no working ACL layer". ADR-0004 measured exactly how this happens:
    /// `acltype` defaults to `off` on Linux and `acltype=nfsv4` sets successfully, reads back as
    /// `nfsv4`, and disables ACLs completely. Both look configured from the outside and neither
    /// enforces anything.
    #[error(
        "{path}: the filesystem refused the ACL — the dataset is not acltype=posixacl, so the \
         kernel enforces NO access control here at all. On Linux `acltype=off` is the default and \
         `acltype=nfsv4` sets successfully while silently disabling ACLs (ADR-0004); check `zfs \
         get acltype` on this dataset and expect `posixacl` or `posix`. setfacl said: {stderr}"
    )]
    AclTypeNotPosix { path: String, stderr: String },

    /// The budget ran out. The folder may be HALF DONE.
    ///
    /// Its own variant, and the message says "partially applied", because a silently truncated ACL
    /// application is two realities: the database says one thing about who may read this folder and
    /// the disk says another. The window is narrow now that there is no recursive pass — three
    /// `setxattr` calls against a 30s budget — but it is not zero: the clear can land and the
    /// access pass not, which leaves the folder with FEWER grants than either side believes. The
    /// caller must retry rather than record success; `apply` is idempotent (it clears first), so a
    /// retry converges.
    #[error(
        "{path}: the {stage} ACL pass exceeded its {budget_secs}s budget ({elapsed_secs}s \
         elapsed). THE FOLDER MAY BE PARTIALLY APPLIED — retry this job; the application is \
         idempotent"
    )]
    TimedOut {
        path: String,
        stage: &'static str,
        budget_secs: u64,
        elapsed_secs: u64,
    },

    /// The access ACL landed and the DEFAULT ACL did not.
    ///
    /// The worst outcome that is not an error anywhere else, which is why it is named here: the
    /// folder now shows the right permissions and everything created inside it from this moment on
    /// gets none of them. ADR-0004 is explicit that the default ACL *is* the inheritance mechanism
    /// on Linux, so half of this operation is not a degraded success.
    #[error(
        "{path}: the access ACL was applied but the DEFAULT ACL was not, so nothing created in \
         this folder from now on will inherit it (ADR-0004: the default ACL is the only \
         inheritance mechanism on Linux). {cause}"
    )]
    DefaultAclFailed { path: String, cause: String },

    /// `setfacl -b` was supposed to leave the owner/group/other triple alone and did not.
    ///
    /// Verified rather than trusted. `-b` removes extended entries and the mask; the base triple
    /// is meant to survive untouched, and if it ever does not, a "permissions applied" reply would
    /// be hiding a change to the three entries every access falls back to.
    #[error(
        "{path}: the owner/group/other triple changed under the ACL write: {before} -> {after}"
    )]
    BaseTripleChanged {
        path: String,
        before: String,
        after: String,
    },

    /// `getfacl` produced something with no base triple in it.
    ///
    /// A refusal rather than a skipped check. Quietly not verifying is how a verification stops
    /// being one.
    #[error("{path}: getfacl produced no user::/group::/other:: triple to verify against: {got}")]
    BaseTripleUnreadable { path: String, got: String },

    /// Two entries name the same group.
    ///
    /// `setfacl` would take the last one and report success, so the caller would get an ACL that
    /// is not the one it sent, with no signal. Refusing is the only answer that cannot be wrong.
    #[error("two entries name group {gid}; setfacl would silently keep only the last")]
    DuplicateGroup { gid: u32 },

    #[error("{count} acl entries exceeds the {max} this product will write; POSIX ACLs become unwieldy and the mask semantics start biting past roughly thirty (ADR-0004)")]
    TooManyEntries { count: usize, max: usize },

    #[error("no share root is configured ({SHARES_ROOT_ENV} is unset); storage is not set up")]
    NoSharesRoot,

    /// The joined path left the share root. Should be unreachable — every component is a
    /// `SafeComponent` — which is exactly why reaching it is an error and not a clamp.
    #[error("{0} is not underneath the share root")]
    Escape(String),

    #[error("the share path is not valid UTF-8 and cannot be passed as an argument")]
    NonUtf8Path,

    #[error("{0}")]
    Path(#[from] SeamError),

    #[error("{0}")]
    Command(String),
}

impl AclError {
    /// Is this "the tools are not here" rather than "the tools said no"?
    ///
    /// The API turns `true` into 503 and everything else into a fault someone must read.
    pub fn is_unavailable(&self) -> bool {
        matches!(self, Self::NotInstalled(_))
    }
}

/// Did the filesystem answer ENOTSUP?
///
/// Matching on message text is normally a contract nobody declared, and here it is the only
/// contract available: `setfacl` exits 1 for every failure and distinguishes them in prose. Two
/// things make it safe enough to rely on. `ExecRunner` sets `LC_ALL=C`, so the string is the
/// untranslated one; and the consequence of a miss is a generic error instead of a specific one,
/// never a success.
fn is_not_supported(stderr: &str) -> bool {
    stderr.contains("Operation not supported")
}

/// `rwx`, with `-` where the bit is not granted.
fn permissions(entry: &AclEntry) -> String {
    let mut out = String::with_capacity(3);
    out.push(if entry.read { 'r' } else { '-' });
    out.push(if entry.write { 'w' } else { '-' });
    out.push(if entry.execute { 'x' } else { '-' });
    out
}

/// The `-m` operand: `g:<gid>:<perms>` per entry, comma separated.
///
/// Note what is NOT here: a `m::` mask entry. `setfacl` recalculates the mask as the union of the
/// entries it wrote, which is the behaviour we want — a hand-written mask that is narrower than an
/// entry produces the `#effective:` downgrade that ADR-0004 calls "mask semantiği ısırıyor", and
/// it does it silently.
fn spec(entries: &[AclEntry]) -> String {
    entries
        .iter()
        .map(|e| format!("g:{}:{}", e.gid.get(), permissions(e)))
        .collect::<Vec<_>>()
        .join(",")
}

/// The `setfacl` invocations one application performs, in order, as `(stage, args)`.
///
/// A pure function so the argv can be asserted without running anything — the thing worth
/// checking here is the shape of the command line, and executing it proves less about that than
/// reading it does.
///
/// Three passes, and the order is the point:
///
///   1. `-b` clears every extended entry AND the default ACL. Merging instead would leave a
///      permission the caller has just removed still in force, because `-m` only ever adds and
///      overwrites — the entry for a group that is no longer in the list is not mentioned, so it
///      survives. `-b` does not touch the owner/group/other triple; `apply` verifies that rather
///      than trusting it.
///   2. `-m` writes the access ACL: who may reach what is already there.
///   3. `-d -m` writes the default ACL: who may reach what is created here later. ADR-0004 is
///      explicit that this is the only inheritance mechanism Linux has.
///
/// With no entries the plan is the clear alone, which is the honest reading of "this folder now
/// grants nothing beyond its owner triple".
///
/// `--` before the path so that a path can never be parsed as an option. `SafeComponent` already
/// refuses a leading dash, and `target` is now `/proc/self/fd/N`, so this is the third lock on a
/// door that was already bolted twice.
///
/// `-P` is NOT here and must not be added. It would make `setfacl` refuse to follow a symlink
/// argument, which sounds like exactly the hardening this module wants — but the argument IS a
/// symlink now (`/proc/self/fd/N` is a magic link), and `setfacl -P` skips such an argument
/// silently: exit 0, ACL unwritten. Measured. The descriptor is the stronger mitigation and it
/// excludes this one.
///
/// `-R` is not here either and there is no operand that could put it here; see the module note.
fn plan(target: &str, entries: &[AclEntry]) -> Vec<(&'static str, Vec<String>)> {
    let mut passes: Vec<(&'static str, Vec<String>)> = Vec::with_capacity(3);

    passes.push((
        "clear",
        vec!["-b".to_string(), "--".to_string(), target.to_string()],
    ));

    if !entries.is_empty() {
        let rendered = spec(entries);
        passes.push((
            "access",
            vec![
                "-m".to_string(),
                rendered.clone(),
                "--".to_string(),
                target.to_string(),
            ],
        ));
        passes.push((
            "default",
            vec![
                "-d".to_string(),
                "-m".to_string(),
                rendered,
                "--".to_string(),
                target.to_string(),
            ],
        ));
    }

    passes
}

fn check_entries(entries: &[AclEntry]) -> Result<(), AclError> {
    if entries.len() > MAX_ENTRIES {
        return Err(AclError::TooManyEntries {
            count: entries.len(),
            max: MAX_ENTRIES,
        });
    }
    // No gid range check here, and its absence is the point rather than an omission. `AclEntry`
    // carries a `PosixId`, which refuses 0 and everything outside DEPSIS's reserved range while the
    // request is being parsed — so an entry for the root group, for `sudo` (27) or for `shadow`
    // (42) cannot be constructed, over the socket or in this process. A duplicated re-check here
    // would be a branch no test could reach, which in a root daemon is worse than no branch.
    for (i, entry) in entries.iter().enumerate() {
        if entries.iter().skip(i + 1).any(|o| o.gid == entry.gid) {
            return Err(AclError::DuplicateGroup {
                gid: entry.gid.get(),
            });
        }
    }
    Ok(())
}

/// Where the share tree lives, from the environment.
pub fn shares_root_from_env() -> Result<PathBuf, AclError> {
    match std::env::var(SHARES_ROOT_ENV) {
        Ok(root) if !root.trim().is_empty() => Ok(PathBuf::from(root.trim())),
        _ => Err(AclError::NoSharesRoot),
    }
}

fn installed(program: &str) -> bool {
    Path::new(program).exists()
}

/// Applies POSIX ACLs to one folder in one share.
pub struct Applier<'a, R: CommandRunner> {
    runner: &'a R,
    shares_root: PathBuf,
    /// How presence of the `acl` tools is decided. A field rather than a direct
    /// `Path::exists` call so the portable tests can drive every branch below on a box that has
    /// no `setfacl` — which is every developer box on this project, and would otherwise mean the
    /// entire module is only ever exercised by its first early return.
    present: fn(&str) -> bool,
    timeout: Duration,
}

impl<'a, R: CommandRunner> Applier<'a, R> {
    pub fn new(runner: &'a R, shares_root: PathBuf) -> Self {
        Self {
            runner,
            shares_root,
            present: installed,
            timeout: TIMEOUT,
        }
    }

    /// Replace the "are the tools here?" probe.
    ///
    /// Public rather than test-only, because the caller that needs it is in another module: the
    /// dispatch tests drive this arm on developer boxes that have no `acl` package, and without an
    /// override every one of them would stop at the first early return and assert nothing about the
    /// argv, the default ACL pass, or the error mapping — the three things worth pinning. Nothing
    /// outside a test calls it; `new` gives production the real filesystem probe.
    #[must_use]
    pub fn with_probe(mut self, present: fn(&str) -> bool) -> Self {
        self.present = present;
        self
    }

    fn ensure_installed(&self) -> Result<(), AclError> {
        for program in [SETFACL, GETFACL] {
            if !(self.present)(program) {
                return Err(AclError::NotInstalled(program.to_string()));
            }
        }
        Ok(())
    }

    /// The absolute path, for DISPLAY in errors. Nothing passes this to a program.
    ///
    /// It used to be the `setfacl` argument, and the `starts_with` below was presented as the
    /// containment backstop. It never was one: `Path::starts_with` is documented as
    /// non-normalizing and compares components literally, so `PathBuf::from("/srv").push("..")`
    /// yields `/srv/..`, whose `starts_with("/srv")` is `true` — verified. The only thing that
    /// actually kept a `/`- or `..`-bearing component out of the argv was that `open_dir` ran first
    /// and `RESOLVE_BENEATH` refused it, which is load-bearing ordering nobody had written down.
    ///
    /// So each component is now checked here explicitly, rather than the check being inherited from
    /// an invariant (`SafeComponent` at the one dispatch call site) enforced in another module. A
    /// containment check that only holds because of an invariant enforced somewhere else is a check
    /// that disappears the day the invariant moves — and this is a string that ends up in an
    /// operator's journal, so it should not be able to claim a path the agent never touched.
    fn target(&self, relative: &[&str]) -> Result<String, AclError> {
        let mut path = self.shares_root.clone();
        for component in relative {
            if component.is_empty()
                || *component == "."
                || *component == ".."
                || component.contains('/')
                || component.contains('\\')
            {
                return Err(AclError::Escape((*component).to_string()));
            }
            path.push(component);
        }
        path.to_str()
            .map(str::to_string)
            .ok_or(AclError::NonUtf8Path)
    }

    /// The `user::`/`group::`/`other::` entries, as one comparable string.
    ///
    /// The `#effective:` annotation is stripped: it reports the entry as narrowed by the mask, and
    /// the mask is precisely what `-b` removes, so leaving it in would make every clear look like
    /// a change to the base triple.
    fn base_triple(&self, aimed: &str, shown: &str) -> Result<String, AclError> {
        let out = match self
            .runner
            .run(GETFACL, &["-c", "--absolute-names", "--", aimed])
        {
            Ok(out) => out,
            Err(SeamError::Command { stderr, .. }) if is_not_supported(&stderr) => {
                return Err(AclError::AclTypeNotPosix {
                    path: shown.to_string(),
                    stderr,
                });
            }
            Err(SeamError::Command { status, stderr, .. }) => {
                return Err(AclError::Command(format!(
                    "getfacl {shown} failed with status {status}: {stderr}"
                )));
            }
            Err(other) => return Err(AclError::Path(other)),
        };

        let mut triple: Vec<String> = Vec::with_capacity(3);
        for line in out.lines() {
            let line = line.split('#').next().unwrap_or("").trim();
            if line.starts_with("user::")
                || line.starts_with("group::")
                || line.starts_with("other::")
            {
                triple.push(line.to_string());
            }
        }
        if triple.len() != 3 {
            return Err(AclError::BaseTripleUnreadable {
                path: shown.to_string(),
                got: out.trim().to_string(),
            });
        }
        Ok(triple.join(","))
    }

    /// One `setfacl` pass, inside the budget.
    ///
    /// The budget is checked around the call and NOT enforced during it. `CommandRunner::run`
    /// spawns and waits; it has no cancellation, so the child is not killed when the deadline
    /// passes. That is why `TimedOut` says the subtree may be partially applied instead of
    /// pretending the operation was stopped cleanly — the caller retries, and because every
    /// application clears before it writes, a retry converges rather than accumulating.
    /// `shown` is the human-readable path from `target()`; the argv inside `args` carries
    /// `/proc/self/fd/N`. The split is deliberate: an operator reading `TimedOut` needs to know
    /// which folder is half-applied, and a descriptor number tells them nothing.
    fn run_pass(
        &self,
        stage: &'static str,
        args: &[String],
        shown: &str,
        started: Instant,
        budget: Duration,
    ) -> Result<(), AclError> {
        let timed_out = |elapsed: Duration| AclError::TimedOut {
            path: shown.to_string(),
            stage,
            budget_secs: budget.as_secs(),
            elapsed_secs: elapsed.as_secs(),
        };

        let before = started.elapsed();
        if before >= budget {
            return Err(timed_out(before));
        }

        let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
        let outcome = self.runner.run(SETFACL, &borrowed);

        match outcome {
            Ok(_) => {
                let after = started.elapsed();
                if after >= budget {
                    return Err(timed_out(after));
                }
                Ok(())
            }
            Err(SeamError::Command { stderr, .. }) if is_not_supported(&stderr) => {
                Err(AclError::AclTypeNotPosix {
                    path: shown.to_string(),
                    stderr,
                })
            }
            Err(SeamError::Command { status, stderr, .. }) if stage == "default" => {
                Err(AclError::DefaultAclFailed {
                    path: shown.to_string(),
                    cause: format!("setfacl exited {status}: {stderr}"),
                })
            }
            Err(SeamError::Command { status, stderr, .. }) => Err(AclError::Command(format!(
                "setfacl {stage} pass on {shown} failed with status {status}: {stderr}"
            ))),
            Err(other) if stage == "default" => Err(AclError::DefaultAclFailed {
                path: shown.to_string(),
                cause: other.to_string(),
            }),
            Err(other) => Err(AclError::Path(other)),
        }
    }

    /// Apply `entries` to one folder, access ACL and default ACL both. Returns how many group
    /// entries the folder now carries.
    ///
    /// `path` empty names the share root, which is the ordinary case for a share-wide grant.
    ///
    /// The `openat2` resolution happens FIRST and its descriptor is held until the last pass has
    /// returned — and, unlike the version this replaces, the descriptor is what every `setfacl` and
    /// `getfacl` in here is actually aimed at, via `SafePath::command_path`. So the confinement is
    /// the operation rather than a check standing next to it: traversal, symlinks and crossed
    /// mounts are refused by the kernel before anything is spawned, a missing folder is a
    /// `NotFound` instead of a `setfacl` error, and the inode is pinned for the whole application
    /// with no name for anyone to swap underneath it. See the module note.
    ///
    /// One folder. There is no recursive form and the module note says why.
    pub fn apply<P: SafePath + ?Sized>(
        &self,
        paths: &P,
        share: &str,
        path: &[&str],
        entries: &[AclEntry],
    ) -> Result<usize, AclError> {
        // Before anything is spawned and before the folder is touched: a request that cannot be
        // written correctly must not clear the ACL that is already there.
        check_entries(entries)?;
        self.ensure_installed()?;

        let mut relative: Vec<&str> = Vec::with_capacity(path.len() + 1);
        relative.push(share);
        relative.extend_from_slice(path);

        // `shown` is for humans and errors; `aimed` is what the programs receive. Building the
        // display string also re-validates the components, so a `/` or a `..` that somehow reached
        // this far is refused here rather than only by `open_dir` above.
        let confined = paths.open_dir(&relative)?;
        let shown = self.target(&relative)?;
        let aimed = paths.command_path(&confined).map_err(AclError::Path)?;

        // Read the triple before the clear, and read it through `getfacl` rather than a mode bit,
        // so the comparison afterwards is against the same view. Aimed at the descriptor too — a
        // before/after comparison of two DIFFERENT objects would be worse than no comparison.
        let before = self.base_triple(&aimed, &shown)?;

        let started = Instant::now();
        for (stage, args) in plan(&aimed, entries) {
            self.run_pass(stage, &args, &shown, started, self.timeout)?;
        }

        let after = self.base_triple(&aimed, &shown)?;
        if before != after {
            return Err(AclError::BaseTripleChanged {
                path: shown,
                before,
                after,
            });
        }

        // Explicit, so that a later edit cannot shorten the descriptor's life without saying so.
        // The lifetime is now load-bearing rather than merely prudent: `aimed` is a name in
        // `/proc/self/fd`, and closing the descriptor early would not make it resolve elsewhere —
        // it would make it resolve to whatever the next `open` in this process is handed.
        drop(confined);
        Ok(entries.len())
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
    use crate::seams::mock::{MockCommandRunner, MockSafePath};
    use std::cell::RefCell;

    /// A plausible `getfacl -c` reply for a directory nobody has touched yet.
    const PLAIN: &str = "user::rwx\ngroup::r-x\nother::r-x\n";

    fn entry(gid: u32, read: bool, write: bool, execute: bool) -> AclEntry {
        AclEntry {
            gid: crate::op::PosixId::parse(gid).expect("test gids live in the reserved range"),
            read,
            write,
            execute,
        }
    }

    fn always_present(_: &str) -> bool {
        true
    }

    /// A runner whose `run` can be made to fail, which `MockCommandRunner` cannot.
    ///
    /// Same reasoning as `samba.rs`'s fake host: the mock always succeeds, so it cannot reach a
    /// single line of the error mapping below — and the error mapping is the part of this module
    /// an operator actually reads.
    struct ScriptedRunner {
        calls: RefCell<Vec<Vec<String>>>,
        /// `Ok` stdout or an argv-substring-triggered failure.
        fail_when: Vec<(&'static str, SeamError)>,
        getfacl_reply: String,
    }

    impl ScriptedRunner {
        fn new(fail_when: Vec<(&'static str, SeamError)>) -> Self {
            Self {
                calls: RefCell::new(Vec::new()),
                fail_when,
                getfacl_reply: PLAIN.to_string(),
            }
        }
    }

    impl CommandRunner for ScriptedRunner {
        fn run(&self, program: &str, args: &[&str]) -> Result<String, SeamError> {
            let mut argv = vec![program.to_string()];
            argv.extend(args.iter().map(|a| (*a).to_string()));
            let joined = argv.join(" ");
            self.calls.borrow_mut().push(argv);
            for (needle, error) in &self.fail_when {
                if joined.contains(needle) {
                    return Err(match error {
                        SeamError::Command {
                            program,
                            status,
                            stderr,
                        } => SeamError::Command {
                            program: program.clone(),
                            status: *status,
                            stderr: stderr.clone(),
                        },
                        other => SeamError::Io(other.to_string()),
                    });
                }
            }
            if program == GETFACL {
                return Ok(self.getfacl_reply.clone());
            }
            Ok(String::new())
        }
    }

    fn enotsup() -> SeamError {
        SeamError::Command {
            program: SETFACL.to_string(),
            status: 1,
            stderr: "setfacl: /srv/depsis/belgeler: Operation not supported".to_string(),
        }
    }

    struct Fixture {
        root: tempfile::TempDir,
        paths: MockSafePath,
    }

    impl Fixture {
        /// A share root with `<share>/<folder>` already on disk, because `open_dir` resolves for
        /// real — the mock uses a real temporary directory, not a simulation.
        fn with_folder(share: &str, folder: &str) -> Self {
            let root = tempfile::tempdir().expect("tempdir");
            std::fs::create_dir_all(root.path().join(share).join(folder)).expect("mkdir");
            let paths = MockSafePath::new(root.path());
            Self { root, paths }
        }

        fn applier<'a, R: CommandRunner>(&self, runner: &'a R) -> Applier<'a, R> {
            let mut applier = Applier::new(runner, self.root.path().to_path_buf());
            applier.present = always_present;
            applier
        }

        fn target(&self, parts: &[&str]) -> String {
            let mut p = self.root.path().to_path_buf();
            for part in parts {
                p.push(part);
            }
            p.to_str().expect("utf-8 tempdir").to_string()
        }
    }

    // ── the argv, without running anything ──

    #[test]
    fn the_plan_clears_then_writes_access_then_default() {
        let passes = plan("/srv/depsis/belgeler", &[entry(301200, true, true, true)]);
        let stages: Vec<&str> = passes.iter().map(|(stage, _)| *stage).collect();
        assert_eq!(
            stages,
            vec!["clear", "access", "default"],
            "the clear must come first, and the default ACL must be written as well as the access \
             ACL — without it nothing created in the folder later inherits anything"
        );
        assert_eq!(
            passes[0].1,
            vec!["-b", "--", "/srv/depsis/belgeler"],
            "a merge would leave a permission the caller just removed still in force"
        );
        assert_eq!(
            passes[1].1,
            vec!["-m", "g:301200:rwx", "--", "/srv/depsis/belgeler"]
        );
        assert_eq!(
            passes[2].1,
            vec!["-d", "-m", "g:301200:rwx", "--", "/srv/depsis/belgeler"],
            "the default ACL pass is the inheritance mechanism (ADR-0004)"
        );
    }

    #[test]
    fn permission_bits_become_letters_and_dashes() {
        assert_eq!(
            spec(&[
                entry(301200, true, false, true),
                entry(301201, true, true, true),
                entry(301202, false, false, false),
            ]),
            "g:301200:r-x,g:301201:rwx,g:301202:---"
        );
    }

    /// The operand is gone, and the argv must never grow the flag back by another route.
    ///
    /// `-R -b` was measured erasing a sub-folder's deliberately narrower §6.2 grant and replacing
    /// it with the parent's wider one while `folder_grants` went on holding the narrow row — two
    /// realities, widening. `-R` also cannot descend through `/proc/self/fd/N` (measured), so a
    /// recursive flag here would silently apply to one directory while the caller believed it had
    /// asked for a subtree. Both failures are silent, which is why this is asserted rather than
    /// left to the type change.
    #[test]
    fn no_pass_ever_recurses() {
        let passes = plan("/srv/depsis/belgeler", &[entry(301200, true, false, true)]);
        assert_eq!(passes.len(), 3, "clear, access, default");
        for (stage, args) in &passes {
            assert!(
                !args.iter().any(|a| a == "-R" || a == "--recursive"),
                "the {stage} pass must not recurse: `-R -b` erases sub-folder grants, and `-R`                  does not descend through the descriptor form anyway"
            );
        }
    }

    /// `-P` looks like the obvious hardening and is a silent no-op here.
    ///
    /// Measured on setfacl 2.3.2: `/proc/self/fd/N` is a magic symlink, and `-P` makes setfacl skip
    /// a symlink argument — exit 0, ACL unwritten. A future reader adding `-P` "to be safe" would
    /// turn every ACL application into a success that applied nothing, and no test that only checks
    /// the exit status would notice.
    #[test]
    fn no_pass_refuses_to_follow_symlinks() {
        let passes = plan("/proc/self/fd/7", &[entry(301200, true, false, true)]);
        for (stage, args) in &passes {
            assert!(
                !args.iter().any(|a| a == "-P" || a == "--physical"),
                "the {stage} pass must not pass -P: the target IS a magic symlink, and -P would                  make setfacl skip it and exit 0"
            );
        }
    }

    #[test]
    fn an_empty_entry_list_clears_and_writes_nothing() {
        let passes = plan("/srv/depsis/belgeler", &[]);
        assert_eq!(passes.len(), 1);
        assert_eq!(passes[0].0, "clear");
    }

    #[test]
    fn the_path_is_always_last_and_always_after_a_double_dash() {
        for (_, args) in plan("/srv/depsis/x", &[entry(300009, true, true, true)]) {
            let last = args.len() - 1;
            assert_eq!(args[last], "/srv/depsis/x");
            assert_eq!(
                args[last - 1],
                "--",
                "without `--` a path could be read as an option"
            );
        }
    }

    // ── the dispatch-level behaviour ──

    #[test]
    fn both_acls_reach_setfacl_for_the_resolved_path() {
        let f = Fixture::with_folder("belgeler", "faturalar");
        let runner = MockCommandRunner::with_responses([
            PLAIN.to_string(),
            String::new(),
            String::new(),
            String::new(),
            PLAIN.to_string(),
        ]);
        let written = f
            .applier(&runner)
            .apply(
                &f.paths,
                "belgeler",
                &["faturalar"],
                &[entry(301200, true, true, true)],
            )
            .expect("apply");
        assert_eq!(written, 1);

        let target = f.target(&["belgeler", "faturalar"]);
        let calls = runner.calls.borrow().clone();
        assert_eq!(calls.len(), 5, "getfacl, three setfacl passes, getfacl");
        assert_eq!(calls[0][0], GETFACL);
        assert_eq!(calls[1], vec![SETFACL, "-b", "--", &target]);
        assert_eq!(
            calls[2],
            vec![SETFACL, "-m", "g:301200:rwx", "--", &target],
            "the access ACL"
        );
        assert_eq!(
            calls[3],
            vec![SETFACL, "-d", "-m", "g:301200:rwx", "--", &target],
            "the default ACL — without it the folder is granted and its future contents are not"
        );
        assert_eq!(calls[4][0], GETFACL);
    }

    #[test]
    fn an_empty_path_names_the_share_root() {
        let f = Fixture::with_folder("belgeler", "faturalar");
        let runner = MockCommandRunner::with_responses([
            PLAIN.to_string(),
            String::new(),
            String::new(),
            String::new(),
            PLAIN.to_string(),
        ]);
        f.applier(&runner)
            .apply(
                &f.paths,
                "belgeler",
                &[],
                &[entry(301200, true, false, true)],
            )
            .expect("apply");
        let target = f.target(&["belgeler"]);
        assert_eq!(
            runner.call(1),
            Some(vec![
                SETFACL.to_string(),
                "-b".to_string(),
                "--".to_string(),
                target
            ])
        );
    }

    #[test]
    fn a_missing_folder_never_reaches_setfacl() {
        let f = Fixture::with_folder("belgeler", "faturalar");
        let runner = MockCommandRunner::default();
        let err = f
            .applier(&runner)
            .apply(
                &f.paths,
                "belgeler",
                &["yok"],
                &[entry(301200, true, true, true)],
            )
            .expect_err("a folder that is not there cannot be granted");
        assert!(matches!(err, AclError::Path(_)), "got {err}");
        assert!(
            runner.calls.borrow().is_empty(),
            "the openat2 resolution refuses before anything is spawned"
        );
    }

    #[test]
    fn a_traversal_is_refused_by_the_path_seam_before_anything_runs() {
        let f = Fixture::with_folder("belgeler", "faturalar");
        let runner = MockCommandRunner::default();
        let err = f
            .applier(&runner)
            .apply(
                &f.paths,
                "belgeler",
                &[".."],
                &[entry(301200, true, true, true)],
            )
            .expect_err("`..` must not resolve");
        assert!(
            matches!(err, AclError::Path(SeamError::PathEscape(_))),
            "got {err}"
        );
        assert!(runner.calls.borrow().is_empty());
    }

    #[test]
    fn missing_setfacl_is_its_own_answer_and_not_a_failure() {
        let f = Fixture::with_folder("belgeler", "faturalar");
        let runner = MockCommandRunner::default();
        // The real probe, on a box that has no acl package — which is the point of the test.
        let applier = Applier::new(&runner, f.root.path().to_path_buf());
        if installed(SETFACL) && installed(GETFACL) {
            eprintln!(
                "SKIPPED missing_setfacl_is_its_own_answer_and_not_a_failure: {SETFACL} is \
                 installed here, so absence cannot be observed with the real probe."
            );
            return;
        }
        let err = applier
            .apply(
                &f.paths,
                "belgeler",
                &["faturalar"],
                &[entry(301200, true, true, true)],
            )
            .expect_err("no acl package");
        assert!(matches!(err, AclError::NotInstalled(_)), "got {err}");
        assert!(
            err.is_unavailable(),
            "the API turns this into 503 and a card naming the package, not a 500"
        );
        assert!(runner.calls.borrow().is_empty());
    }

    #[test]
    fn operation_not_supported_becomes_the_acltype_error() {
        let f = Fixture::with_folder("belgeler", "faturalar");
        let runner = ScriptedRunner::new(vec![("-b", enotsup())]);
        let err = f
            .applier(&runner)
            .apply(
                &f.paths,
                "belgeler",
                &["faturalar"],
                &[entry(301200, true, true, true)],
            )
            .expect_err("ENOTSUP");
        match err {
            AclError::AclTypeNotPosix { .. } => {}
            other => panic!("got {other}"),
        }
        let message = err_text(&f, &runner);
        assert!(
            message.contains("acltype=posixacl"),
            "the message must send the operator to `zfs get acltype`, which is where the fault \
             actually is (ADR-0004): {message}"
        );
        assert!(
            !err.is_unavailable(),
            "a misconfigured dataset is a fault, not an absent package"
        );
    }

    /// The rendered message of the same failure, so the assertion above reads the operator's text.
    fn err_text<R: CommandRunner>(f: &Fixture, runner: &R) -> String {
        f.applier(runner)
            .apply(
                &f.paths,
                "belgeler",
                &["faturalar"],
                &[entry(301200, true, true, true)],
            )
            .expect_err("ENOTSUP")
            .to_string()
    }

    #[test]
    fn a_failing_default_pass_is_not_a_generic_error() {
        let f = Fixture::with_folder("belgeler", "faturalar");
        let runner = ScriptedRunner::new(vec![(
            "-d",
            SeamError::Command {
                program: SETFACL.to_string(),
                status: 1,
                stderr: "setfacl: Only directories can have default ACLs".to_string(),
            },
        )]);
        let err = f
            .applier(&runner)
            .apply(
                &f.paths,
                "belgeler",
                &["faturalar"],
                &[entry(301200, true, true, true)],
            )
            .expect_err("default pass failed");
        assert!(
            matches!(err, AclError::DefaultAclFailed { .. }),
            "got {err}"
        );
        assert!(
            err.to_string().contains("inherit"),
            "the message has to name the consequence: nothing created here later inherits anything"
        );
    }

    #[test]
    fn the_owner_group_other_triple_is_verified_rather_than_assumed() {
        let f = Fixture::with_folder("belgeler", "faturalar");
        let runner = MockCommandRunner::with_responses([
            "user::rwx\ngroup::r-x\nother::r-x\n".to_string(),
            String::new(),
            String::new(),
            String::new(),
            "user::rwx\ngroup::---\nother::---\n".to_string(),
        ]);
        let err = f
            .applier(&runner)
            .apply(
                &f.paths,
                "belgeler",
                &["faturalar"],
                &[entry(301200, true, true, true)],
            )
            .expect_err("the triple moved");
        assert!(
            matches!(err, AclError::BaseTripleChanged { .. }),
            "got {err}"
        );
    }

    #[test]
    fn the_effective_annotation_is_not_mistaken_for_a_changed_triple() {
        let f = Fixture::with_folder("belgeler", "faturalar");
        let runner = MockCommandRunner::with_responses([
            "user::rwx\ngroup::rwx\t#effective:r-x\nmask::r-x\nother::r-x\n".to_string(),
            String::new(),
            String::new(),
            String::new(),
            "user::rwx\ngroup::rwx\nother::r-x\n".to_string(),
        ]);
        f.applier(&runner)
            .apply(
                &f.paths,
                "belgeler",
                &["faturalar"],
                &[entry(301200, true, true, true)],
            )
            .expect("the mask disappearing with -b is not a change to the base triple");
    }

    #[test]
    fn a_duplicate_group_is_refused_before_the_acl_is_cleared() {
        let f = Fixture::with_folder("belgeler", "faturalar");
        let runner = MockCommandRunner::default();
        let err = f
            .applier(&runner)
            .apply(
                &f.paths,
                "belgeler",
                &["faturalar"],
                &[
                    entry(301200, true, false, true),
                    entry(301200, true, true, true),
                ],
            )
            .expect_err("setfacl would silently keep the last one");
        assert!(
            matches!(err, AclError::DuplicateGroup { gid: 301_200 }),
            "got {err}"
        );
        assert!(
            runner.calls.borrow().is_empty(),
            "a request that cannot be written correctly must not clear what is already there"
        );
    }

    /// Root and the host's own groups are unrepresentable, not merely refused.
    ///
    /// This used to be a runtime check for `gid == 0` inside `check_entries`, and 0 was the ONLY
    /// value it caught — gid 27 (`sudo`), gid 42 (`shadow`), uid 33 (`www-data`) and the
    /// appliance's own service accounts were all accepted. The reserved range that migration 0015
    /// introduced for exactly this reason was enforced only on the unprivileged side, by the
    /// caller the agent exists not to trust.
    ///
    /// Asserted at the type, because that is now where the refusal lives; `check_entries` has no
    /// gid branch left to test.
    #[test]
    fn a_system_gid_cannot_be_built_into_an_acl_entry() {
        use crate::op::{PosixId, PosixIdError};
        assert!(matches!(PosixId::parse(0), Err(PosixIdError::Root)));
        for gid in [
            27,
            42,
            33,
            1,
            1200,
            65534,
            PosixId::MIN - 1,
            PosixId::MAX + 1,
        ] {
            assert!(
                matches!(PosixId::parse(gid), Err(PosixIdError::OutOfRange { .. })),
                "{gid} is not a DEPSIS identity and must not be expressible in a grant"
            );
        }
        for gid in [PosixId::MIN, 350_000, PosixId::MAX] {
            assert_eq!(
                PosixId::parse(gid)
                    .expect("inside the reserved range")
                    .get(),
                gid
            );
        }
    }

    #[test]
    fn too_many_entries_is_refused_with_the_adr_reason() {
        let f = Fixture::with_folder("belgeler", "faturalar");
        let runner = MockCommandRunner::default();
        let entries: Vec<AclEntry> = (1..=(MAX_ENTRIES as u32 + 1))
            .map(|gid| entry(crate::op::PosixId::MIN + gid, true, false, true))
            .collect();
        let err = f
            .applier(&runner)
            .apply(&f.paths, "belgeler", &["faturalar"], &entries)
            .expect_err("past the point where POSIX ACLs behave");
        assert!(matches!(err, AclError::TooManyEntries { .. }), "got {err}");
    }

    #[test]
    fn an_exhausted_budget_says_the_folder_may_be_half_applied() {
        let f = Fixture::with_folder("belgeler", "faturalar");
        let runner = MockCommandRunner::with_responses([PLAIN.to_string()]);
        let mut applier = f.applier(&runner);
        // Zero budget: the first pass is over the line before it starts, which is the only way to
        // reach this branch without making a test wait twenty minutes.
        applier.timeout = Duration::from_secs(0);
        let err = applier
            .apply(
                &f.paths,
                "belgeler",
                &["faturalar"],
                &[entry(301200, true, true, true)],
            )
            .expect_err("budget exhausted");
        match &err {
            AclError::TimedOut { stage, .. } => assert_eq!(*stage, "clear"),
            other => panic!("got {other}"),
        }
        assert!(
            err.to_string().contains("PARTIALLY APPLIED"),
            "a caller must not record success for a folder that may be half done: {err}"
        );
    }

    // ── against a real setfacl, when it is here ──

    /// The real thing, so the argv above is not merely self-consistent.
    struct RealRunner;

    impl CommandRunner for RealRunner {
        fn run(&self, program: &str, args: &[&str]) -> Result<String, SeamError> {
            let out = std::process::Command::new(program)
                .args(args)
                .env_clear()
                .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
                .env("LC_ALL", "C")
                .output()
                .map_err(|e| SeamError::Io(format!("spawn {program}: {e}")))?;
            if out.status.success() {
                Ok(String::from_utf8_lossy(&out.stdout).into_owned())
            } else {
                Err(SeamError::Command {
                    program: program.to_string(),
                    status: out.status.code().unwrap_or(-1),
                    stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
                })
            }
        }
    }

    #[test]
    fn a_real_setfacl_writes_both_the_access_and_the_default_acl() {
        if !installed(SETFACL) || !installed(GETFACL) {
            eprintln!(
                "SKIPPED a_real_setfacl_writes_both_the_access_and_the_default_acl: {SETFACL} is \
                 not installed on this box, so both ACLs are asserted only against the shape of \
                 the argv. Run this on a machine with the `acl` package on an acltype=posixacl \
                 dataset."
            );
            return;
        }

        let f = Fixture::with_folder("belgeler", "faturalar");
        // A file inside the folder. Nothing walks past it any more, but it stays: it is the
        // fixture the ENOTDIR arm and any future walk would need, and its presence proves the
        // single-folder pass does not touch what is inside.
        std::fs::write(
            f.root
                .path()
                .join("belgeler")
                .join("faturalar")
                .join("a.txt"),
            b"x",
        )
        .expect("write");

        let runner = RealRunner;
        let applier = Applier::new(&runner, f.root.path().to_path_buf());
        const GID: u32 = 365_533;
        let outcome = applier.apply(
            &f.paths,
            "belgeler",
            &["faturalar"],
            &[entry(GID, true, false, true)],
        );
        match outcome {
            Ok(count) => assert_eq!(count, 1),
            Err(AclError::AclTypeNotPosix { .. }) => {
                eprintln!(
                    "SKIPPED a_real_setfacl_writes_both_the_access_and_the_default_acl: the \
                     temporary directory is on a filesystem with no POSIX ACL support, which is \
                     the condition this module reports rather than a result it can assert."
                );
                return;
            }
            Err(other) => panic!("apply failed: {other}"),
        }

        let target = f.target(&["belgeler", "faturalar"]);
        let dumped = RealRunner
            .run(GETFACL, &["-c", "--absolute-names", "--", &target])
            .expect("getfacl");
        assert!(
            dumped.contains(&format!("group:{GID}:r-x")),
            "the access ACL is not there: {dumped}"
        );
        assert!(
            dumped.contains(&format!("default:group:{GID}:r-x")),
            "the DEFAULT ACL is not there, so nothing created in this folder later inherits it: \
             {dumped}"
        );
        assert!(
            dumped.contains("user::"),
            "the owner triple must survive -b: {dumped}"
        );
    }
}
