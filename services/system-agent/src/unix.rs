//! Real Unix seam implementations.
//!
//! The `#[cfg(unix)]` lives on the MODULE DECLARATION in `main.rs`, not inside this file
//! (ADR-0006). Scattering `cfg` through function bodies is how a core stops being portable
//! without anyone noticing; keeping it at one declaration means the boundary is visible.

use std::ffi::OsStr;
use std::io::{Read, Write};
use std::os::fd::{FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use depsis_agent::audit::Sink;
use depsis_agent::data::DataChannel;
use depsis_agent::dispatch::Agent;
use depsis_agent::op::Response;
use depsis_agent::seams::{
    CommandRunner, DirEntryInfo, OpenIntent, PeerIdentity, SafePath, SeamError, TokenSource,
};

/// Path resolution confined by the kernel, not by string inspection.
///
/// The root is RE-OPENED FROM ITS PATH ON EVERY CALL, and that is a field-taught reversal of the
/// first design. The fd-for-life version argued that re-resolving a string reintroduces a race --
/// but the string here is the agent's OWN configuration (`DEPSIS_SHARES_ROOT`), not caller input,
/// and only root can change what it names. What the long-lived fd actually did in the field was
/// go stale: `PrepareShareRoot` mounts a dataset OVER the shares root, and an agent holding the
/// pre-mount descriptor kept serving the shadowed, empty directory underneath -- every share
/// "missing" while `ls` showed them plainly. A per-call open lands on whatever is mounted NOW,
/// which is the only correct answer on a box whose root is, by design, mounted over once.
// Not constructed outside tests yet, and that is the honest state rather than an oversight: no
// operation in `Request` takes a caller-supplied path inside a share. Phase 1 introduces the
// first ones (upload publish, move), and this is deliberately in place and kernel-tested before
// then rather than written under time pressure alongside the feature that needs it. See lib.rs.
#[allow(
    dead_code,
    reason = "wired into dispatch in Phase 1; kernel-tested now so the confinement is not               designed in a hurry next to the first operation that depends on it"
)]
pub struct Openat2SafePath {
    root_display: PathBuf,
}

#[allow(
    dead_code,
    reason = "same as the struct above: constructed only by tests until Phase 1 wires path-taking operations into dispatch"
)]
impl Openat2SafePath {
    pub fn open_root(path: impl Into<PathBuf>) -> Result<Self, SeamError> {
        let confined = Self {
            root_display: path.into(),
        };
        // Acilabildigini ve openat2'nin calistigini BASLANGICTA bir kez kanitla; sonrasi her
        // cagrida taze bir acilis.
        confined.root_fd()?;
        confined.prove_openat2_works()?;
        Ok(confined)
    }

    /// The shares root, opened fresh. See the struct comment for why this is per-call.
    fn root_fd(&self) -> Result<rustix::fd::OwnedFd, SeamError> {
        rustix::fs::open(
            &self.root_display,
            rustix::fs::OFlags::RDONLY
                | rustix::fs::OFlags::DIRECTORY
                | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
        )
        .map_err(|e| SeamError::Io(format!("open root {}: {e}", self.root_display.display())))
    }

    /// Resolve `.` under the root, once, at startup.
    ///
    /// Not a formality. `openat2` is the entire containment mechanism — everything else in this
    /// file assumes the kernel is enforcing RESOLVE_BENEATH — and it can be absent for two reasons
    /// that have nothing to do with the code: a kernel older than 5.6, or a seccomp filter.
    ///
    /// The second one is not hypothetical and was not predictable from the documentation. P1-D
    /// measured `RestrictSUIDSGID=yes` in the agent's own unit blocking `openat2` outright: systemd
    /// implements that directive by filtering the mode argument of every file-creating syscall, and
    /// for `openat2` the mode lives inside a `struct open_how` in userspace memory, which seccomp
    /// cannot dereference — so it denies the call rather than let a setuid file through. The unit
    /// now sets `RestrictSUIDSGID=no` and says why, but a unit file is edited by people, and the
    /// failure mode without this probe is every upload failing individually with a containment
    /// error while the agent reports itself healthy.
    ///
    /// Failing at startup instead means the journal says it once, plainly, and the service does not
    /// come up pretending it can confine anything.
    fn prove_openat2_works(&self) -> Result<(), SeamError> {
        rustix::fs::openat2(
            &self.root_fd()?,
            OsStr::new(".").as_bytes(),
            rustix::fs::OFlags::RDONLY
                | rustix::fs::OFlags::DIRECTORY
                | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
            Self::resolve_flags(),
        )
        .map(drop)
        .map_err(|e| classify_openat2(".", e))
    }
}

#[allow(
    dead_code,
    reason = "same as the struct: the helpers are exercised by the kernel tests below and are \
              wired into dispatch with the first path-taking operation"
)]
impl Openat2SafePath {
    /// The flag set, in one place so the two entry points cannot drift apart.
    ///
    /// BENEATH, not IN_ROOT. IN_ROOT would silently clamp an escape attempt to the root, which
    /// means a traversal succeeds quietly and nobody ever learns it was attempted. BENEATH
    /// refuses, and a refusal is an audit event.
    ///
    /// NO_XDEV matters specifically on a ZFS box: every dataset is its own mount, so without it a
    /// nested mountpoint INSIDE a share is a way out of the tree the caller was confined to.
    ///
    /// It applies to the walk INSIDE a share. The one hop it cannot apply to is root -> share,
    /// because the product's own design puts every share on its own dataset -- its own mount --
    /// and the first real ZFS box refused every operation on every share with EXDEV before this
    /// was split. That hop uses `crossing_flags()`; everything after it is back under the full
    /// set.
    fn resolve_flags() -> rustix::fs::ResolveFlags {
        rustix::fs::ResolveFlags::BENEATH
            | rustix::fs::ResolveFlags::NO_SYMLINKS
            | rustix::fs::ResolveFlags::NO_MAGICLINKS
            | rustix::fs::ResolveFlags::NO_XDEV
    }

    /// The flags for the ONE resolution step that is allowed to cross a mount boundary.
    ///
    /// `resolve_flags()` minus `NO_XDEV`, and nothing else changes: `BENEATH` still refuses to
    /// climb out, `NO_SYMLINKS` still refuses to follow a link, `NO_MAGICLINKS` still refuses
    /// `/proc/*/fd`. Written as a subtraction from the real set rather than as its own list so
    /// that a flag added to the main set is inherited here instead of being silently omitted.
    fn crossing_flags() -> rustix::fs::ResolveFlags {
        Self::resolve_flags() - rustix::fs::ResolveFlags::NO_XDEV
    }

    /// `<share>/.zfs/snapshot/<snapshot>`, as a directory descriptor.
    ///
    /// Steps 1 to 3 of the walk documented on `SafePath::list_snapshot_entries`. The first three
    /// components go through the ordinary confined resolution — same mount, full flags — and only
    /// the snapshot's own name is resolved with the crossing flag set, from a descriptor that is
    /// already inside the share.
    fn snapshot_dir(&self, share: &str, snapshot: &str) -> Result<std::fs::File, SeamError> {
        let control = self.openat2(
            &[share, ".zfs", "snapshot"],
            rustix::fs::OFlags::RDONLY | rustix::fs::OFlags::DIRECTORY,
            rustix::fs::Mode::empty(),
        )?;

        let fd = rustix::fs::openat2(
            &control,
            OsStr::new(snapshot).as_bytes(),
            rustix::fs::OFlags::RDONLY
                | rustix::fs::OFlags::DIRECTORY
                | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
            Self::crossing_flags(),
        )
        .map_err(|e| classify_openat2(snapshot, e))?;
        Ok(std::fs::File::from(fd))
    }

    /// Step 4: `relative`, from inside the snapshot, under the FULL flag set again.
    fn under_snapshot(
        &self,
        share: &str,
        snapshot: &str,
        relative: &[&str],
        oflags: rustix::fs::OFlags,
    ) -> Result<std::fs::File, SeamError> {
        let snap = self.snapshot_dir(share, snapshot)?;
        if relative.is_empty() {
            // The snapshot's own root. Only a directory listing asks for this; `open_snapshot`
            // refuses an empty path before it gets here, because "read the file at no path" has
            // no meaning and returning the directory would be a silent substitution.
            return Ok(snap);
        }
        let joined = relative.join("/");
        let fd = rustix::fs::openat2(
            &snap,
            OsStr::new(&joined).as_bytes(),
            oflags | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
            Self::resolve_flags(),
        )
        .map_err(|e| classify_openat2(&joined, e))?;
        Ok(std::fs::File::from(fd))
    }

    /// Name, kind and size of everything directly under an ALREADY-RESOLVED directory.
    ///
    /// Factored out of `list_entries` when the snapshot listing needed the same loop. One copy,
    /// because the rules it enforces — symlinks dropped, device nodes dropped, non-UTF-8 names
    /// dropped, a racing removal not an error — are rules about what DEPSIS can represent, and two
    /// copies would eventually disagree about them.
    fn entries_of(dir_fd: &std::fs::File) -> Result<Vec<DirEntryInfo>, SeamError> {
        let mut reader = rustix::fs::Dir::read_from(dir_fd)
            .map_err(|e| SeamError::Io(format!("open directory stream: {e}")))?;
        let mut found = Vec::new();

        while let Some(entry) = reader.read() {
            let entry = entry.map_err(|e| SeamError::Io(format!("readdir: {e}")))?;
            let raw = entry.file_name();
            if raw.to_bytes() == b"." || raw.to_bytes() == b".." {
                continue;
            }
            let stat = match rustix::fs::statat(dir_fd, raw, rustix::fs::AtFlags::SYMLINK_NOFOLLOW)
            {
                Ok(stat) => stat,
                // Raced with something removing it between the readdir and the stat. Not an error:
                // a reconciliation is a snapshot, and the next one will see the same absence.
                Err(rustix::io::Errno::NOENT) => continue,
                Err(e) => return Err(SeamError::Io(format!("stat entry: {e}"))),
            };
            let kind = rustix::fs::FileType::from_raw_mode(stat.st_mode);
            let directory = kind == rustix::fs::FileType::Directory;
            // Regular files and directories only. A symlink, a socket, a device node — DEPSIS has
            // no row shape for any of them, and inventing one would produce an entry the agent
            // itself refuses to open.
            if !directory && kind != rustix::fs::FileType::RegularFile {
                continue;
            }
            let Ok(name) = raw.to_str() else {
                // A name that is not UTF-8 cannot be a `SafeComponent`, so nothing downstream
                // could ever address it. Reported as absent rather than as a fault: it is a real
                // file, and the honest thing is that DEPSIS cannot represent it.
                continue;
            };
            found.push(DirEntryInfo {
                name: name.to_string(),
                directory,
                size: if directory {
                    0
                } else {
                    stat.st_size.unsigned_abs()
                },
                modified_unix: stat.st_mtime as i64,
            });
        }
        Ok(found)
    }

    fn openat2(
        &self,
        relative: &[&str],
        oflags: rustix::fs::OFlags,
        mode: rustix::fs::Mode,
    ) -> Result<std::fs::File, SeamError> {
        let root = self.root_fd()?;

        // IKI ASAMA, ve ayrimin kendisi tasarim: ilk bilesen PAYLASIMIN ADI, ve her paylasim
        // kendi veri kumesi -- yani kendi baglama noktasi. O tek sekmede sinir gecisi serbest
        // (`crossing_flags`: BENEATH hala disari cikarmaz, NO_SYMLINKS hala bag izlemez);
        // paylasimin ICINDEKI her adim tam kumeyle, NO_XDEV dahil, yurur. Ilk gercek ZFS kutusu
        // bu ayrim yokken her paylasim islemini EXDEV ile reddetti -- test ortamlarinin
        // hicbirinde paylasimlar gercek dataset degildi.
        let Some((share, rest)) = relative.split_first() else {
            return Err(SeamError::Io("empty path".to_string()));
        };
        if rest.is_empty() {
            let fd = rustix::fs::openat2(
                &root,
                OsStr::new(share).as_bytes(),
                oflags | rustix::fs::OFlags::CLOEXEC,
                mode,
                Self::crossing_flags(),
            )
            .map_err(|e| classify_openat2(share, e))?;
            return Ok(std::fs::File::from(fd));
        }

        let share_fd = rustix::fs::openat2(
            &root,
            OsStr::new(share).as_bytes(),
            rustix::fs::OFlags::RDONLY
                | rustix::fs::OFlags::DIRECTORY
                | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
            Self::crossing_flags(),
        )
        .map_err(|e| classify_openat2(share, e))?;

        let joined = rest.join("/");
        let fd = rustix::fs::openat2(
            &share_fd,
            OsStr::new(&joined).as_bytes(),
            oflags | rustix::fs::OFlags::CLOEXEC,
            mode,
            Self::resolve_flags(),
        )
        .map_err(|e| classify_openat2(&joined, e))?;

        // The descriptor IS the result. It is not dropped and no path is handed back: whoever
        // holds this file holds the object the kernel just confined, and no second resolution
        // happens anywhere.
        Ok(std::fs::File::from(fd))
    }
}

impl Openat2SafePath {
    /// Read one directory, keeping the entries of a given kind and — optionally — only those older
    /// than a cutoff.
    ///
    /// Everything here is relative to a descriptor this call resolved under RESOLVE_BENEATH: the
    /// directory is opened with `open_dir`, the entries come from that descriptor, and each `stat`
    /// is an `fstatat` against it. Nothing is a path, because the one consumer of this is a loop
    /// that unlinks files as root.
    ///
    /// `SYMLINK_NOFOLLOW` on the stat, and the kind check that follows it, are what stop a symlink
    /// in the share root being reported as a directory to descend into or a file to delete.
    fn entries(
        &self,
        relative: &[&str],
        keep: impl Fn(rustix::fs::FileType) -> bool,
        older_than: Option<Duration>,
    ) -> Result<Vec<String>, SeamError> {
        let dir_fd = self.open_dir(relative)?;
        let mut reader = rustix::fs::Dir::read_from(&dir_fd)
            .map_err(|e| SeamError::Io(format!("open directory stream: {e}")))?;
        let now = std::time::SystemTime::now();
        let mut names = Vec::new();

        while let Some(entry) = reader.read() {
            let entry = entry.map_err(|e| SeamError::Io(format!("readdir: {e}")))?;
            let raw = entry.file_name();
            if raw.to_bytes() == b"." || raw.to_bytes() == b".." {
                continue;
            }
            let stat = match rustix::fs::statat(&dir_fd, raw, rustix::fs::AtFlags::SYMLINK_NOFOLLOW)
            {
                Ok(stat) => stat,
                // Raced with something else removing it. Not an error: this exists to clean up
                // abandoned files, and losing that race means the job is already done.
                Err(rustix::io::Errno::NOENT) => continue,
                Err(e) => return Err(SeamError::Io(format!("stat entry: {e}"))),
            };
            if !keep(rustix::fs::FileType::from_raw_mode(stat.st_mode)) {
                continue;
            }

            if let Some(cutoff) = older_than {
                let mtime = std::time::UNIX_EPOCH
                    + Duration::from_secs(u64::try_from(stat.st_mtime).unwrap_or(u64::MAX));
                // A file dated in the future counts as fresh. Clock skew must never make this MORE
                // eager: keeping a stale file one cycle longer costs disk, deleting a live upload
                // costs the user's data.
                if now.duration_since(mtime).unwrap_or_default() <= cutoff {
                    continue;
                }
            }

            let name = String::from_utf8_lossy(raw.to_bytes()).into_owned();
            names.push(name);
        }
        names.sort();
        Ok(names)
    }
}

/// Turn an `openat2` errno into the right kind of `SeamError`.
///
/// ENOSYS gets its own branch because reporting it as a path escape is a false diagnosis at the
/// worst possible moment. P1-D measured exactly that: every transfer failed with "path escapes the
/// share root: alice/.depsis/staging/probe.part", which reads as a containment violation — a
/// caller trying to break out — when the truth was that the syscall had been switched off by a
/// line in a unit file. It took a directive-by-directive bisection to find, and the misleading
/// message is what made the bisection necessary.
fn classify_openat2(joined: &str, e: rustix::io::Errno) -> SeamError {
    if e == rustix::io::Errno::NOENT {
        return SeamError::NotFound(joined.to_string());
    }
    if e == rustix::io::Errno::NOSYS {
        return SeamError::Io(format!(
            "openat2 is unavailable ({joined}): the kernel is older than 5.6, or a seccomp filter \
             is blocking it — RestrictSUIDSGID=yes does exactly that"
        ));
    }
    // The same misdiagnosis one step further out. `open_dir` passes `OFlags::DIRECTORY`, so any
    // path whose target or whose parent is a regular file comes back ENOTDIR — an ordinary state
    // of a share somebody uploaded a file into, not an escape attempt. Reporting "path escapes the
    // share root: alice/notes.txt/x" sends whoever reads the journal looking for an attacker.
    if e == rustix::io::Errno::NOTDIR {
        return SeamError::NotADirectory(joined.to_string());
    }
    // The third misdiagnosis of the same kind, and the one with the loudest false alarm.
    // `OpenIntent::CreateNew` passes `O_EXCL`, so a staging name that is already taken comes back
    // EEXIST — which is an ordinary outcome of two jobs choosing one name, and was being reported
    // as "path escapes the share root". A collision is a conflict, not an attack, and the caller
    // needs to tell them apart because one is answered with a retry and the other with an alarm.
    if e == rustix::io::Errno::EXIST {
        return SeamError::AlreadyExists(joined.to_string());
    }
    SeamError::PathEscape(format!("{joined}: {e}"))
}

impl SafePath for Openat2SafePath {
    fn open(&self, relative: &[&str], intent: OpenIntent) -> Result<std::fs::File, SeamError> {
        let (oflags, mode) = match intent {
            OpenIntent::Read => (rustix::fs::OFlags::RDONLY, rustix::fs::Mode::empty()),
            // EXCL is the atomic part: two callers racing to claim the same staging name cannot
            // both win, and the loser finds out rather than silently sharing a file.
            OpenIntent::CreateNew => (
                rustix::fs::OFlags::WRONLY | rustix::fs::OFlags::CREATE | rustix::fs::OFlags::EXCL,
                // 0600 while it is being written: a staging file readable by everyone on the box
                // is a cross-tenant read of data that has not even landed yet.
                //
                // It stays 0600 after publish too, and that is the intent rather than an oversight.
                // The file becomes the uploader's by OWNERSHIP, not by a wider mode —
                // `SafePath::set_owner` runs on the held descriptor before the rename. Widening the
                // mode instead would be the obvious-looking fix and the wrong one: it would make
                // every uploaded file readable by every other tenant on the box.
                //
                // This comment has been wrong once already. An earlier version said ownership "is
                // fixed up at publish" when nothing did that, so P1-D now asserts the owner of a
                // published file directly rather than trusting either the code or this paragraph.
                rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
            ),
            // APPEND, and the flag is load-bearing. Without it the write position comes only from
            // the one `seek(End(0))` the caller does at open time — a number captured then and
            // trusted up to TRANSFER_TTL later, which is exactly the "a number kept beside the data
            // can disagree with it" failure the caller's own comment claims to avoid. With O_APPEND
            // the kernel resolves the position at every write, so a writer that slips past the
            // registry's interlock degrades to interleaving rather than to silent mutual overwrite.
            //
            // The variant was named `Append` and did not append. A name that promises semantics the
            // implementation does not have is worse than a wrong name.
            OpenIntent::Append => (
                rustix::fs::OFlags::WRONLY
                    | rustix::fs::OFlags::CREATE
                    | rustix::fs::OFlags::APPEND,
                rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
            ),
        };
        self.openat2(relative, oflags, mode)
    }

    fn open_dir(&self, relative: &[&str]) -> Result<std::fs::File, SeamError> {
        self.openat2(
            relative,
            rustix::fs::OFlags::RDONLY | rustix::fs::OFlags::DIRECTORY,
            rustix::fs::Mode::empty(),
        )
    }

    /// `/proc/<AJANIN PID'İ>/fd/N` — see the note on the trait for why a descriptor and not a
    /// joined path.
    ///
    /// `self` DEĞİL, ve fark ilk gerçek kutuda ödendi: her tanıtıcı CLOEXEC ile açılır (doğru —
    /// hiçbir çocuk ajanın tanıtıcı tablosunu miras almamalı), yani exec olan `setfacl` kendi
    /// `/proc/self/fd`'sinde N'yi BULAMAZ ve "No such file or directory" der. Sayıyla yazılan
    /// pid ise ajanın tablosunu adresler: sihirli bağ, ajanın hâlâ açık tuttuğu inode'a çözülür,
    /// tanıtıcı çocuğa hiç geçmeden. Çocuk ajanla aynı kullanıcı (root) olduğu için /proc bu
    /// okumaya izin verir.
    ///
    /// No existence check on `/proc`. If procfs is not mounted the `setfacl` that receives this
    /// fails with ENOENT and the operator reads a missing-path error, which is the truth; a probe
    /// here would only move the same failure earlier while adding a stat to every call.
    fn command_path(&self, dir: &std::fs::File) -> Result<String, SeamError> {
        use std::os::fd::AsRawFd;
        Ok(format!(
            "/proc/{}/fd/{}",
            std::process::id(),
            dir.as_raw_fd()
        ))
    }

    fn owner_of(&self, relative: &[&str]) -> Result<u32, SeamError> {
        use std::os::unix::fs::MetadataExt as _;
        let dir = self.open_dir(relative)?;
        let meta = dir
            .metadata()
            .map_err(|e| SeamError::Io(format!("stat {}: {e}", relative.join("/"))))?;
        Ok(meta.uid())
    }

    fn publish(
        &self,
        from_dir: &[&str],
        from: &str,
        to_dir: &[&str],
        to: &str,
    ) -> Result<(), SeamError> {
        let source = self.open_dir(from_dir)?;
        let destination = self.open_dir(to_dir)?;

        // renameat2 with NOREPLACE, aimed at two directory descriptors this call just resolved.
        // Neither side is a path, so nothing re-resolves between the check and the move.
        //
        // P0-G measured this working on ZFS 2.3.2 and returning EEXIST when the destination is
        // taken — the point of the measurement being that a silently-ignored flag would turn
        // "refuse to overwrite" into "overwrite", which is the worst possible way for a flag to
        // fail.
        match rustix::fs::renameat_with(
            &source,
            from,
            &destination,
            to,
            rustix::fs::RenameFlags::NOREPLACE,
        ) {
            Ok(()) => {}
            // Typed, not prose. `MoveEntry` has to answer 404 for a source that is not there and
            // 409 for a destination that is taken, and matching on a message string to tell them
            // apart would be a contract nobody declared.
            Err(rustix::io::Errno::EXIST) => {
                return Err(SeamError::AlreadyExists(to.to_string()));
            }
            Err(rustix::io::Errno::NOENT) => {
                return Err(SeamError::NotFound(from.to_string()));
            }
            Err(e) => return Err(SeamError::Io(format!("rename {from} -> {to}: {e}"))),
        }

        // ADR-0008 step 5, in the same call as the rename so it cannot be forgotten separately.
        destination
            .sync_all()
            .map_err(|e| SeamError::Io(format!("fsync destination directory: {e}")))
    }

    fn create_dir(&self, dir: &[&str], name: &str, uid: u32, gid: u32) -> Result<(), SeamError> {
        // The parent, resolved once under RESOLVE_BENEATH. Everything below is relative to THIS
        // descriptor: the mkdir, the reopen, and the fsync. No path is joined and nothing is
        // re-resolved, so a component swapped for a symlink after this line cannot redirect any of
        // it — the same reason `remove_file` and `publish` work from a directory fd.
        //
        // A missing intermediate component surfaces here, as `NotFound` from `classify_openat2`,
        // which is the honest answer and the one the caller turns into a 404. There is no
        // `mkdir -p` anywhere in this function.
        let parent = self.open_dir(dir)?;

        // 0750, not 0755. A share folder is not a public place: the group bit is what an ACL entry
        // has to have something to grant through (ADR-0004 puts the grants on the GROUP, so the
        // group triad is the mask that bounds them), and the world triad is the one that cannot be
        // narrowed again by any ACL. A world-readable directory in a multi-tenant share is a
        // cross-tenant listing regardless of what the ACLs say, and `0750` costs nothing because
        // nobody outside the owning group is meant to traverse it.
        //
        // The mode argument is masked by the process umask, so it is NOT the final word — see the
        // `fchmod` below, which is.
        let mode = rustix::fs::Mode::from_raw_mode(0o750);
        match rustix::fs::mkdirat(&parent, name, mode) {
            Ok(()) => {}
            // Refused, never reported as success. `mkdir` looks idempotent and this operation is
            // not: the API writes one row per call, so a quiet success on a directory that is
            // already there is how two rows come to describe one directory. Typed, because the
            // caller answers 409 for this and 404 for the case below it.
            Err(rustix::io::Errno::EXIST) => {
                return Err(SeamError::AlreadyExists(name.to_string()))
            }
            Err(rustix::io::Errno::NOENT) => return Err(SeamError::NotFound(name.to_string())),
            Err(e) => return Err(SeamError::Io(format!("mkdir {name}: {e}"))),
        }

        // From here on a failure leaves a directory on disk that the caller will be told does not
        // exist, so each step undoes the mkdir before returning. Without that, a transient chown
        // failure would poison the name permanently: the retry hits the EEXIST branch above and
        // the user can never create their folder, with no way to remove the one that is in the way
        // because the API has no row for it.
        let finish = || -> Result<(), SeamError> {
            // Reopened through `openat2` from the parent fd rather than kept from `mkdirat`, which
            // hands back nothing. NO_SYMLINKS is what makes the reopen safe: if the directory just
            // created were replaced by a symlink in this window, the resolution is refused rather
            // than followed, and the chown below lands on the object this call made or on nothing.
            let mut child: Vec<&str> = dir.to_vec();
            child.push(name);
            let created = self.open_dir(&child)?;

            // Owner BEFORE mode, and the order is load-bearing. `chown` clears the setuid and
            // setgid bits, so doing it last would silently drop part of whatever mode was just
            // set. 0750 carries neither bit today — this order costs nothing now and is the one
            // that stays correct if a setgid group-inheritance bit is ever wanted here.
            //
            // `fchown` on the descriptor, never a path: a chown aimed at a name can be redirected
            // between the resolution and the call, which is the check-then-use shape the whole
            // seam exists to avoid.
            rustix::fs::fchown(
                &created,
                Some(rustix::fs::Uid::from_raw(uid)),
                Some(rustix::fs::Gid::from_raw(gid)),
            )
            .map_err(|e| SeamError::Io(format!("fchown directory to {uid}:{gid}: {e}")))?;

            // The umask is the reason this is not left to `mkdirat`'s mode argument. The kernel
            // masks that argument with the process umask, so a daemon started under umask 077
            // would create 0700 — no group bit for an ACL to grant through — and a daemon started
            // under umask 002 would create 0752. Neither is a decision anyone made, and both
            // depend on how systemd was configured rather than on this file. `fchmod` is not
            // masked, so the directory ends up at exactly 0750 whatever the unit says.
            rustix::fs::fchmod(&created, mode)
                .map_err(|e| SeamError::Io(format!("fchmod directory to 0750: {e}")))?;

            // A new directory entry is a metadata change in the PARENT, and metadata changes are
            // exactly what a power cut loses while the file data survives. ADR-0008's step 5 for a
            // rename is the same syscall for the same reason: without it the folder can be gone
            // after a crash, and anything published into it goes with it.
            parent
                .sync_all()
                .map_err(|e| SeamError::Io(format!("fsync parent directory: {e}")))
        };

        match finish() {
            Ok(()) => Ok(()),
            Err(e) => {
                // Best effort, and deliberately not reported. The caller needs the reason the
                // create failed, not the reason the cleanup did; if the rmdir also fails the
                // original error is still the actionable one.
                let _ = rustix::fs::unlinkat(&parent, name, rustix::fs::AtFlags::REMOVEDIR);
                Err(e)
            }
        }
    }

    fn set_owner(&self, file: &std::fs::File, uid: u32, gid: u32) -> Result<(), SeamError> {
        // `fchown`, on the descriptor. The path-taking form would re-resolve, and a chown aimed at
        // a path can be redirected between the resolution and the call — the same check-then-use
        // shape that made `SafePath` return a file in the first place.
        //
        // Note what the kernel does for free here: chown clears any setuid and setgid bits. The
        // agent never sets them, so this changes nothing today; it is worth knowing because the
        // unit deliberately does not enable `RestrictSUIDSGID=` (it would disable `openat2`), and
        // this is one of the reasons that is affordable.
        rustix::fs::fchown(
            file,
            Some(rustix::fs::Uid::from_raw(uid)),
            Some(rustix::fs::Gid::from_raw(gid)),
        )
        .map_err(|e| SeamError::Io(format!("fchown to {uid}:{gid}: {e}")))
    }

    fn set_mode(&self, file: &std::fs::File, mode: u32) -> Result<(), SeamError> {
        // `fchmod`, on the descriptor, for the reason `set_owner` uses `fchown`: the path-taking
        // form re-resolves and can be redirected between the resolution and the call.
        //
        // `from_bits_truncate` rather than a fallible parse: the only caller is the share-root
        // operation and the value it passes is a constant in `op.rs`, so a bit outside the mask
        // would be a programming error rather than input. Truncating keeps a stray high bit from
        // becoming a setuid directory.
        rustix::fs::fchmod(file, rustix::fs::Mode::from_bits_truncate(mode))
            .map_err(|e| SeamError::Io(format!("fchmod to {mode:o}: {e}")))
    }

    /// The shares, read from the root descriptor rather than through `open_dir(&[])`.
    ///
    /// The old shape took a `relative` slice and its only caller passed `&[]`, which this file
    /// refuses: `openat2` takes the first component as the SHARE NAME. So the sweeper failed on
    /// its first line on every real box, every ten minutes, while its four tests — all against
    /// the mock, which resolves an empty slice to the temp root — stayed green.
    ///
    /// `root_is_empty` above says why the fix is not to special-case the empty slice inside
    /// `open_dir`: `remove_file`, `remove_dir` and `create_dir` resolve their parent through that
    /// same method, and the shares root must not become a deletable parent in a process running
    /// as root.
    fn list_share_dirs(&self) -> Result<Vec<String>, SeamError> {
        let root = std::fs::File::from(self.root_fd()?);
        let mut reader = rustix::fs::Dir::read_from(&root)
            .map_err(|e| SeamError::Io(format!("open directory stream: {e}")))?;
        let mut names = Vec::new();

        while let Some(entry) = reader.read() {
            let entry = entry.map_err(|e| SeamError::Io(format!("readdir: {e}")))?;
            let raw = entry.file_name();
            if raw.to_bytes() == b"." || raw.to_bytes() == b".." {
                continue;
            }
            // `SYMLINK_NOFOLLOW`, and it is the load-bearing flag here rather than a precaution:
            // a symlink in the share root pointing at `/` would otherwise be reported as a share,
            // and the sweeper walks what this returns deleting stale files as root.
            let stat = match rustix::fs::statat(&root, raw, rustix::fs::AtFlags::SYMLINK_NOFOLLOW) {
                Ok(stat) => stat,
                // Raced with a removal between the readdir and the stat. Not an error: the next
                // sweep sees the same absence.
                Err(rustix::io::Errno::NOENT) => continue,
                Err(e) => return Err(SeamError::Io(format!("stat entry: {e}"))),
            };
            if rustix::fs::FileType::from_raw_mode(stat.st_mode) != rustix::fs::FileType::Directory
            {
                continue;
            }
            let Ok(name) = raw.to_str() else {
                // Not addressable as a `SafeComponent`, so nothing downstream could name it.
                continue;
            };
            names.push(name.to_string());
        }
        names.sort();
        Ok(names)
    }

    /// One `getdents` pass plus one `fstatat` per entry, all against a confined descriptor.
    ///
    /// The same shape as `entries` above and deliberately not built on it: that one returns names
    /// only, and threading a second return type through its `keep` predicate would make the
    /// sweeper's loop — which deletes as root — read less clearly for the sake of sharing twenty
    /// lines.
    fn list_entries(&self, relative: &[&str]) -> Result<Vec<DirEntryInfo>, SeamError> {
        Self::entries_of(&self.open_dir(relative)?)
    }

    /// The shares root itself, read through the SAME descriptor everything else is anchored to.
    ///
    /// `open_dir(&[])` is deliberately NOT the route. `openat2` here always takes the first
    /// component as the SHARE NAME — each share is its own dataset and therefore its own mount —
    /// so an empty component list has no meaning down there and is refused. Special-casing it
    /// inside `open_dir` would also reach `remove_file`, `remove_dir` and `create_dir`, which
    /// resolve their parent through the same method: the root would become a deletable parent in
    /// a process running as root. This asks the question instead of handing out the descriptor.
    ///
    /// `root_fd()` is not a second route into the tree. It is the anchor `openat2` already uses
    /// as its `dirfd` on every call in this file, opened with `DIRECTORY` and `CLOEXEC`, and it
    /// is read here and nowhere else.
    fn root_is_empty(&self) -> Result<bool, SeamError> {
        let root = std::fs::File::from(self.root_fd()?);
        let mut reader = rustix::fs::Dir::read_from(&root)
            .map_err(|e| SeamError::Io(format!("open directory stream: {e}")))?;

        // `.` ve `..` DIŞINDA HER ŞEY sayılıyor — `entries_of` DEĞİL, ve fark burada önemli.
        //
        // O yardımcı, sembolik bağları, soketleri, aygıt düğümlerini ve UTF-8 olmayan adları
        // ATIYOR, çünkü DEPSIS'in onlar için bir satır biçimi yok. Bir LİSTELEME için doğru olan
        // bu filtre, bir BOŞLUK sorusu için yanlış: bu cevaba bakan işlem, dizinin üstüne bir veri
        // kümesi bağlıyor, ve bağlanan bir dizinin altındaki her şey silinmeden görünmez oluyor.
        // İçinde yalnız bir sembolik bağ olan bir kökü "boş" saymak, tam olarak bu işlemin
        // engellemek için var olduğu şeyi yapardı.
        while let Some(entry) = reader.read() {
            let entry = entry.map_err(|e| SeamError::Io(format!("readdir: {e}")))?;
            let raw = entry.file_name().to_bytes();
            if raw == b"." || raw == b".." {
                continue;
            }
            return Ok(false);
        }
        Ok(true)
    }

    fn list_snapshot_entries(
        &self,
        share: &str,
        snapshot: &str,
        relative: &[&str],
    ) -> Result<Vec<DirEntryInfo>, SeamError> {
        let dir = self.under_snapshot(
            share,
            snapshot,
            relative,
            rustix::fs::OFlags::RDONLY | rustix::fs::OFlags::DIRECTORY,
        )?;
        Self::entries_of(&dir)
    }

    fn open_snapshot(
        &self,
        share: &str,
        snapshot: &str,
        relative: &[&str],
    ) -> Result<std::fs::File, SeamError> {
        if relative.is_empty() {
            // A refusal rather than the snapshot's root directory: "read the file at no path" has
            // no meaning, and answering with a directory would be a silent substitution the caller
            // would then try to stream bytes from.
            return Err(SeamError::NotFound(
                "no file named inside the snapshot".into(),
            ));
        }
        self.under_snapshot(share, snapshot, relative, rustix::fs::OFlags::RDONLY)
    }

    fn list_stale_files(
        &self,
        relative: &[&str],
        older_than: Duration,
    ) -> Result<Vec<String>, SeamError> {
        self.entries(
            relative,
            |kind| kind == rustix::fs::FileType::RegularFile,
            Some(older_than),
        )
    }

    fn remove_file(&self, dir: &[&str], name: &str) -> Result<bool, SeamError> {
        // Relative to a directory descriptor this call just resolved under RESOLVE_BENEATH. An
        // `unlink` on a joined path would re-resolve every component, and this one runs as root in
        // a loop over names the agent did not choose.
        let parent = self.open_dir(dir)?;
        match rustix::fs::unlinkat(&parent, name, rustix::fs::AtFlags::empty()) {
            Ok(()) => Ok(true),
            Err(rustix::io::Errno::NOENT) => Ok(false),
            Err(e) => Err(SeamError::Io(format!("unlink {name}: {e}"))),
        }
    }

    fn remove_dir(&self, dir: &[&str], name: &str) -> Result<bool, SeamError> {
        // Same shape as `remove_file` and for the same reason: relative to a descriptor this call
        // resolved under RESOLVE_BENEATH, never a joined path, because this runs as root.
        let parent = self.open_dir(dir)?;
        match rustix::fs::unlinkat(&parent, name, rustix::fs::AtFlags::REMOVEDIR) {
            Ok(()) => Ok(true),
            Err(rustix::io::Errno::NOENT) => Ok(false),
            // The kernel is what stops this from becoming a tree delete. There is no loop here and
            // no `-r`: a directory with children comes back as an error and the caller walks the
            // tree itself (§2.2, ADR-0006). POSIX permits either errno for a non-empty directory
            // and Linux uses ENOTEMPTY, but a `#[forbid(unsafe_code)]` daemon that deletes user
            // data should not depend on which one this kernel picked.
            Err(rustix::io::Errno::NOTEMPTY | rustix::io::Errno::EXIST) => {
                Err(SeamError::NotEmpty(name.to_string()))
            }
            Err(e) => Err(SeamError::Io(format!("rmdir {name}: {e}"))),
        }
    }
}

/// Tokens from the kernel's CSPRNG.
///
/// `getrandom(2)`, not `/dev/urandom`: no descriptor to run out of, no path that can be replaced
/// on a compromised box, and it cannot fail for want of an open file. The agent runs as root and
/// mints values that authorize writes, so this is not a place for a userspace generator seeded
/// once at startup.
pub struct KernelTokens;

impl TokenSource for KernelTokens {
    fn token(&self) -> String {
        let mut bytes = [0u8; depsis_agent::transfer::TOKEN_BYTES];
        // On failure this loops rather than returning a weak value. getrandom only fails for
        // EINTR or an unavailable pool, and a token is exactly the wrong thing to degrade: a
        // predictable one lets a caller write into somebody else's upload.
        while rustix::rand::getrandom(&mut bytes, rustix::rand::GetRandomFlags::empty()).is_err() {
            std::thread::yield_now();
        }
        let mut out = String::with_capacity(bytes.len() * 2);
        for b in bytes {
            use std::fmt::Write as _;
            let _ = write!(out, "{b:02x}");
        }
        out
    }
}

/// Is this an "out of file descriptors" error rather than a real fault?
///
/// EMFILE (this process's limit) and ENFILE (the system's). Neither has a `std::io::ErrorKind`, so
/// they can only be told apart by errno — and without telling them apart an accept loop treats a
/// momentary shortage the same as a broken socket and exits.
fn is_descriptor_shortage(e: &std::io::Error) -> bool {
    matches!(
        e.raw_os_error(),
        Some(n) if n == rustix::io::Errno::MFILE.raw_os_error()
                || n == rustix::io::Errno::NFILE.raw_os_error()
    )
}

/// Peer credentials straight from the kernel.
pub fn peer_of(stream: &std::os::unix::net::UnixStream) -> Result<PeerIdentity, SeamError> {
    let creds = rustix::net::sockopt::socket_peercred(stream)
        .map_err(|e| SeamError::NoPeerCred(e.to_string()))?;
    Ok(PeerIdentity {
        uid: creds.uid.as_raw(),
        gid: creds.gid.as_raw(),
        pid: creds.pid.as_raw_nonzero().get(),
    })
}

/// argv-only execution. No shell exists anywhere in this path.
pub struct ExecRunner;

impl ExecRunner {
    /// How long a finished pipeline is given to be reaped before the writer is killed.
    ///
    /// Not a transfer timeout: by the time this runs the reader has already exited, so the only
    /// thing being waited for is the writer noticing. Two seconds is far longer than a process
    /// needs to see EOF and far shorter than anyone would call a hang.
    const REAP_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

    /// Tek bir komutun en fazla ne kadar koşabileceği; gerekçe `run` içinde.
    const RUN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

    /// The writer's output if it finishes within the grace, `None` if it is still running.
    fn reap(
        child: &mut std::process::Child,
        program: &str,
    ) -> Result<Option<std::process::Output>, SeamError> {
        let until = std::time::Instant::now() + Self::REAP_GRACE;
        loop {
            match child.try_wait() {
                Err(e) => return Err(SeamError::Io(format!("wait {program}: {e}"))),
                Ok(Some(_)) => break,
                Ok(None) if std::time::Instant::now() >= until => return Ok(None),
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
            }
        }
        // `wait_with_output` after the child has exited collects the pipes it already filled; the
        // status it reports is the one `try_wait` observed.
        child
            .stdout
            .take()
            .map_or(Ok(()), |_| Ok::<(), SeamError>(()))?;
        let mut stderr = Vec::new();
        if let Some(mut pipe) = child.stderr.take() {
            use std::io::Read;
            pipe.read_to_end(&mut stderr)
                .map_err(|e| SeamError::Io(format!("read {program} stderr: {e}")))?;
        }
        let status = child
            .wait()
            .map_err(|e| SeamError::Io(format!("wait {program}: {e}")))?;
        Ok(Some(std::process::Output {
            status,
            stdout: Vec::new(),
            stderr,
        }))
    }

    /// A `Command` with the environment already stripped.
    ///
    /// Shared by `run` and `run_piped` so the hardening cannot drift between them: a pipeline that
    /// inherited the caller's `LD_PRELOAD` while the single-command path did not would be a hole
    /// nobody reading either function alone could see.
    fn hardened(program: &str, args: &[&str]) -> Command {
        debug_assert!(program.starts_with('/'), "program path must be absolute");
        let mut cmd = Command::new(program);
        cmd.args(args);
        // Inherit nothing. A privileged process that inherits its caller's environment inherits
        // whatever the caller decided LD_PRELOAD, PATH or IFS should be.
        cmd.env_clear();
        cmd.env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin");
        // Output of zfs/zpool/smartctl is parsed; a locale-dependent format would make the
        // parser wrong in a way that only shows up on someone else's machine.
        cmd.env("LC_ALL", "C");
        cmd.env("TZ", "UTC");
        cmd
    }
}

impl CommandRunner for ExecRunner {
    fn run(&self, program: &str, args: &[&str]) -> Result<String, SeamError> {
        self.run_with_timeout(program, args, Self::RUN_TIMEOUT)
    }

    /// Ayni govde, sureyi CAGIRAN veriyor.
    ///
    /// `run` bunu varsayilan tavanla cagiriyor; ayri bir sure isteyen tek yer `zfs diff`, ve
    /// gerekcesi seam'in kendi belgesinde. Ikinci bir govde YAZILMADI: zaman asiminin dogru
    /// islemesi (cocugu oldurmek, beklemek, neyin dolduğunu soylemek) tek bir yerde durmali.
    fn run_with_timeout(
        &self,
        program: &str,
        args: &[&str],
        timeout: std::time::Duration,
    ) -> Result<String, SeamError> {
        // ZAMAN AŞIMI, ve sahada ödenmiş bedeli var: USB'deki disk bir anlığına düşünce ZFS
        // havuzu ASKIYA aldı, askıdaki havuza dokunan `zfs` komutu D durumunda asılı kaldı, ve
        // ajanın SIRALI kontrol soketi o tek komutun arkasında sonsuza dek bekledi — sahibin
        // gördüğü şey "depolama ve sistem ajanları yanıt vermiyor"du, oysa asılı olan tek bir
        // alt süreçti. Bir komutun asılması artık O KOMUTUN hatasıdır, cihazın felci değil.
        //
        // İki dakika: dkms kurulumları buradan geçmiyor (onlar firstboot'un işi) ve buradan
        // geçen en uzun meşru iş — büyük bir `zfs send` dilimi, bir scrub başlatması — on
        // saniyeler mertebesinde. Süre dolunca çocuk öldürülür ve hata, neyin dolduğunu söyler.
        let mut child = Self::hardened(program, args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| SeamError::Io(format!("spawn {program}: {e}")))?;

        let until = std::time::Instant::now() + timeout;
        loop {
            match child.try_wait() {
                Err(e) => return Err(SeamError::Io(format!("wait {program}: {e}"))),
                Ok(Some(_)) => break,
                Ok(None) if std::time::Instant::now() >= until => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(SeamError::Io(format!(
                        "{program} {} saniyede yanıt vermedi ve öldürüldü — askıya alınmış bir                          havuz (zpool status: SUSPENDED) en bilinen sebep",
                        timeout.as_secs()
                    )));
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(25)),
            }
        }
        let out = child
            .wait_with_output()
            .map_err(|e| SeamError::Io(format!("wait {program}: {e}")))?;

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

    /// Bir sırrı stdin'den geçirerek koşar — `zfs load-key` ve `zfs create -o keyformat=passphrase`.
    ///
    /// Sır ARGV'YE KONMUYOR ve DOSYAYA YAZILMIYOR, gerekçesi seam'in belgesinde. Buradaki iş
    /// yalnız onu doğru yazmak, ve iki tuzağı var.
    ///
    /// SATIR SONU ŞART. `zfs`, parolayı bir SATIR olarak okuyor; sonlandırıcı gelmezse okuma
    /// tamamlanmaz ve süreç stdin kapanana kadar bekler. `Passphrase` içinde satır sonu
    /// bulundurmuyor (o da bu yüzden), yani burada eklenen tek satır sonu sonlandırıcının
    /// kendisi.
    ///
    /// STDIN'İ KAPATMAK DA ŞART. `zfs create -o keyformat=passphrase` parolayı İKİ KEZ okuyor
    /// (giriş ve doğrulama); kapanmayan bir stdin, ikinci okumanın sonsuza kadar beklemesi
    /// demek — yani bu yüzden değer iki kez yazılıp tanıtıcı bırakılıyor.
    fn run_with_stdin(
        &self,
        program: &str,
        args: &[&str],
        stdin: &str,
    ) -> Result<String, SeamError> {
        use std::io::Write as _;
        debug_assert!(program.starts_with('/'), "program path must be absolute");

        let mut child = Self::hardened(program, args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| SeamError::Io(format!("spawn {program}: {e}")))?;

        {
            let mut pipe = child
                .stdin
                .take()
                .ok_or_else(|| SeamError::Io(format!("{program} stdin alınamadı")))?;
            // İKİ KEZ. `zfs create -o keyformat=passphrase` doğrulama için ikinci kez okuyor;
            // `zfs load-key` ikinciyi hiç okumadan çıkıyor ve fazlalık kimseye ulaşmıyor.
            let written = pipe
                .write_all(stdin.as_bytes())
                .and_then(|()| pipe.write_all(b"\n"))
                .and_then(|()| pipe.write_all(stdin.as_bytes()))
                .and_then(|()| pipe.write_all(b"\n"));
            // EPIPE bir hata DEĞİL: `load-key` ilk satırı okuyup çıkabilir. Yazamamanın gerçek
            // sonucu aşağıdaki çıkış durumunda görünür, ve orada `zfs`in kendi cümlesi var.
            if let Err(e) = written {
                if e.kind() != std::io::ErrorKind::BrokenPipe {
                    return Err(SeamError::Io(format!("{program} stdin yazılamadı: {e}")));
                }
            }
            // `pipe` burada düşüyor: EOF olmadan ikinci okuma sonsuza kadar beklerdi.
        }

        let out = child
            .wait_with_output()
            .map_err(|e| SeamError::Io(format!("wait {program}: {e}")))?;

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

    fn run_piped(
        &self,
        writer: &str,
        writer_args: &[&str],
        reader: &str,
        reader_args: &[&str],
    ) -> Result<String, SeamError> {
        debug_assert!(writer.starts_with('/'), "program path must be absolute");
        debug_assert!(reader.starts_with('/'), "program path must be absolute");

        let mut left = Self::hardened(writer, writer_args);
        left.stdout(Stdio::piped());
        // The writer's stderr is kept: when a send fails, its message is the only description of
        // why, and the reader's own stderr will only say the stream ended early.
        left.stderr(Stdio::piped());
        let mut sending = left
            .spawn()
            .map_err(|e| SeamError::Io(format!("spawn {writer}: {e}")))?;

        // Taken, not borrowed: the child's stdout has to MOVE into the reader's stdin, and leaving
        // a copy in `sending` would hold the pipe open after the writer exits — the reader would
        // then wait forever for an EOF that never comes.
        let pipe = sending
            .stdout
            .take()
            .ok_or_else(|| SeamError::Io(format!("{writer} produced no stdout")))?;

        let mut right = Self::hardened(reader, reader_args);
        right.stdin(Stdio::from(pipe));
        right.stdout(Stdio::piped());
        right.stderr(Stdio::piped());
        let receiving = right
            .spawn()
            .map_err(|e| SeamError::Io(format!("spawn {reader}: {e}")))?;

        // THE READER FIRST. Waiting on the writer first deadlocks whenever the stream is larger
        // than the pipe buffer: the writer blocks writing, we block waiting for it, and nothing
        // drains the pipe. Collecting the reader's output drains it.
        let read_out = receiving
            .wait_with_output()
            .map_err(|e| SeamError::Io(format!("wait {reader}: {e}")))?;

        // AND THEN THE WRITER, BUT NOT FOREVER.
        //
        // Measured, and it wedged the agent: with `/usr/bin/yes` writing into a `head` that had
        // already exited, this call never returned. Rust sets SIGPIPE to SIG_IGN at startup and
        // children INHERIT that disposition, so a writer whose reader is gone is not killed by the
        // kernel — it sees EPIPE and, depending on the program, spins.
        //
        // The cost is not one stuck process. The agent's control socket is SERIALISED — one
        // connection at a time — so a wedged pipeline stops the privileged process answering
        // anything at all. A failed `zfs recv` would take the whole appliance's storage control
        // with it.
        //
        // Killing is correct rather than merely expedient: the reader has exited, so nothing will
        // ever read another byte, and a writer still alive is by definition unable to finish. The
        // short grace exists only for the ordinary case where the writer has already finished and
        // simply has not been reaped yet.
        let write_out = match Self::reap(&mut sending, writer)? {
            Some(out) => out,
            None => {
                let _ = sending.kill();
                let _ = sending.wait();
                return Err(SeamError::Command {
                    program: writer.to_string(),
                    status: -1,
                    stderr: "the writer did not finish after its reader exited; it was killed"
                        .to_string(),
                });
            }
        };

        // THE WRITER IS CHECKED FIRST, and this order is the point of the whole method. A shell
        // pipeline reports the last command's status, so a `zfs send` that died half way through
        // would leave a `zfs recv` that succeeded on a truncated stream — a target dataset that
        // exists, looks like a backup, and is missing an arbitrary tail.
        if !write_out.status.success() {
            return Err(SeamError::Command {
                program: writer.to_string(),
                status: write_out.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&write_out.stderr)
                    .trim()
                    .to_string(),
            });
        }
        if !read_out.status.success() {
            return Err(SeamError::Command {
                program: reader.to_string(),
                status: read_out.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&read_out.stderr).trim().to_string(),
            });
        }
        Ok(String::from_utf8_lossy(&read_out.stdout).into_owned())
    }
}

// ─── socket activation ────────────────────────────────────────────────────────

/// Number of the first file descriptor systemd hands over (`SD_LISTEN_FDS_START`).
const SD_LISTEN_FDS_START: RawFd = 3;

/// Largest request line the agent will read, in bytes.
///
/// A privileged process reading an unbounded line from a socket is a memory-exhaustion
/// primitive. The largest legitimate request is `PublishSambaConfig` carrying every share in the
/// deployment, and 256 kB is far above any plausible one.
const MAX_REQUEST_BYTES: u64 = 256 * 1024;

/// How long one connection may take. A client that opens the socket and then goes quiet must not
/// be able to wedge the agent, which serves one caller at a time.
const IO_TIMEOUT: Duration = Duration::from_secs(30);

/// Take the listening socket systemd created for us.
///
/// The agent does NOT create its own socket. systemd owns it, which means the socket file's
/// ownership and mode are the first authorization gate — enforced by the kernel before the agent
/// has read a single byte, and declared in a unit file reviewable independently of this code
/// (ADR-0006).
///
/// This implements the `sd_listen_fds` protocol directly rather than pulling in a crate. The
/// protocol is three environment variables; a dependency would add an unaudited transitive tree
/// to a process running as root, which is a worse trade than the lines below.
#[allow(
    unsafe_code,
    reason = "The one unavoidable unsafe in the binary: adopting a descriptor from systemd means \
              asserting ownership of an integer, which no safe API can express. The assertion is \
              discharged by the LISTEN_PID check — the descriptor was passed to *this* pid — and \
              by this function being called once, from main. The core crate `depsis_agent` \
              remains forbid(unsafe_code)."
)]
/// The two listening sockets systemd hands over, taken BY NAME.
///
/// A struct rather than a `Vec`, because a positional list is exactly the bug this exists to
/// prevent. Two `.socket` units pointing at one service produce two descriptors, and their order
/// is systemd's business, not ours — it depends on unit load order and can change when a unit is
/// renamed, reordered or restarted. Reading fd 3 as "the control socket" is therefore a coin
/// flip, and losing it means the agent answers control requests on the socket the API streams
/// user data into, and reads file bytes as if they were JSON commands.
#[derive(Debug)]
pub struct Listeners {
    pub control: UnixListener,
    pub data: UnixListener,
}

/// The names the units declare via `FileDescriptorName=`.
pub const CONTROL_FD_NAME: &str = "control";
pub const DATA_FD_NAME: &str = "data";

/// Map `LISTEN_FDNAMES` onto descriptor offsets, or refuse.
///
/// Split out from the adoption below so it can be tested without conjuring real listening sockets
/// at fixed descriptor numbers. Everything that can go wrong lives here; the adoption itself is
/// three lines with no decisions in it.
///
/// Fails closed at every step. An agent that starts with a socket it cannot name is an agent whose
/// attack surface nobody can review, and one that starts with only the control socket accepts
/// `OpenTransfer` calls whose data connections can never arrive — the API would mint tokens,
/// stage files and time them out, reporting a plausible-looking upload failure every time.
fn socket_offsets(fdnames: Option<&str>, listen_fds: i32) -> Result<(i32, i32), SeamError> {
    let Some(fdnames) = fdnames else {
        return Err(SeamError::Io(
            "LISTEN_FDNAMES unset: the socket units must declare FileDescriptorName=".into(),
        ));
    };

    let names: Vec<&str> = fdnames.split(':').collect();
    if i32::try_from(names.len()).unwrap_or(i32::MAX) != listen_fds {
        // Without a name per descriptor there is no mapping at all, only a guess.
        return Err(SeamError::Io(format!(
            "LISTEN_FDS is {listen_fds} but LISTEN_FDNAMES names {} sockets",
            names.len()
        )));
    }

    let mut control: Option<i32> = None;
    let mut data: Option<i32> = None;
    for (index, name) in names.iter().enumerate() {
        let offset = i32::try_from(index).unwrap_or(i32::MAX);
        let slot = match *name {
            CONTROL_FD_NAME => &mut control,
            DATA_FD_NAME => &mut data,
            other => {
                return Err(SeamError::Io(format!(
                    "systemd passed a socket named {other:?}, which this agent does not serve"
                )))
            }
        };
        if slot.is_some() {
            // Two units with the same FileDescriptorName=. Picking either one would leave a
            // listening root socket that nothing ever accepts on.
            return Err(SeamError::Io(format!(
                "two sockets are both named {name:?}"
            )));
        }
        *slot = Some(offset);
    }

    match (control, data) {
        (Some(c), Some(d)) => Ok((c, d)),
        (None, _) => Err(SeamError::Io(format!(
            "no socket named {CONTROL_FD_NAME:?}; is depsis-agent.socket running?"
        ))),
        (_, None) => Err(SeamError::Io(format!(
            "no socket named {DATA_FD_NAME:?}; is depsis-agent-data.socket running?"
        ))),
    }
}

/// Adopt the listening sockets systemd created.
///
/// The agent does NOT create its own sockets. systemd owning them is what makes each socket file's
/// ownership and mode the first authorization gate — enforced by the kernel before the agent has
/// read a single byte, and declared in a unit file reviewable independently of this code
/// (ADR-0006).
///
/// This implements the `sd_listen_fds` protocol directly rather than pulling in a crate. The
/// protocol is three environment variables; a dependency would add an unaudited transitive tree to
/// a process running as root, which is a worse trade than the lines below.
#[allow(
    unsafe_code,
    reason = "The one unavoidable unsafe in the binary: adopting a descriptor from systemd means               asserting ownership of an integer, which no safe API can express. The assertion is               discharged by the LISTEN_PID check — the descriptors were passed to *this* pid — by               `socket_offsets` refusing duplicate names so neither is adopted twice, and by this               function being called once, from main. The core crate `depsis_agent` remains               forbid(unsafe_code)."
)]
pub fn listeners_from_systemd() -> Result<Listeners, SeamError> {
    // LISTEN_PID guards against a descriptor inherited by a process that was never meant to have
    // it: systemd stamps the pid it activated, so anything forked from us sees a mismatch.
    let listen_pid: u32 = std::env::var("LISTEN_PID")
        .map_err(|_| SeamError::Io("LISTEN_PID unset: not socket-activated".into()))?
        .parse()
        .map_err(|_| SeamError::Io("LISTEN_PID is not a number".into()))?;
    if listen_pid != std::process::id() {
        return Err(SeamError::Io(format!(
            "LISTEN_PID is {listen_pid}, this process is {}; refusing an fd meant for someone else",
            std::process::id()
        )));
    }

    let listen_fds: i32 = std::env::var("LISTEN_FDS")
        .map_err(|_| SeamError::Io("LISTEN_FDS unset".into()))?
        .parse()
        .map_err(|_| SeamError::Io("LISTEN_FDS is not a number".into()))?;

    let fdnames = std::env::var("LISTEN_FDNAMES").ok();
    let (control_offset, data_offset) = socket_offsets(fdnames.as_deref(), listen_fds)?;

    // Clear the variables so nothing spawned later can mistake itself for the activated service.
    // `ExecRunner` calls `env_clear` as well, so this is belt and braces — but leaving pid-stamped
    // variables lying in the environment is the kind of thing that becomes a bug two refactors on.
    std::env::remove_var("LISTEN_PID");
    std::env::remove_var("LISTEN_FDS");
    std::env::remove_var("LISTEN_FDNAMES");

    // SAFETY: systemd passed these descriptors to this pid (verified above), nothing else in the
    // process owns them, and this function runs exactly once. The two offsets are distinct because
    // `socket_offsets` refuses duplicate names, so neither descriptor is adopted twice.
    let (control, data) = unsafe {
        (
            OwnedFd::from_raw_fd(SD_LISTEN_FDS_START + control_offset),
            OwnedFd::from_raw_fd(SD_LISTEN_FDS_START + data_offset),
        )
    };

    Ok(Listeners {
        control: UnixListener::from(expect_stream_socket(control, CONTROL_FD_NAME)?),
        data: UnixListener::from(expect_stream_socket(data, DATA_FD_NAME)?),
    })
}

/// Confirm an adopted descriptor really is a stream socket.
///
/// A misconfigured unit (`ListenDatagram=`, say) then fails here with a clear message rather than
/// producing baffling behaviour at accept time.
fn expect_stream_socket(fd: OwnedFd, name: &str) -> Result<OwnedFd, SeamError> {
    let kind = rustix::net::sockopt::socket_type(&fd)
        .map_err(|e| SeamError::Io(format!("the {name} fd is not a socket: {e}")))?;
    if kind != rustix::net::SocketType::STREAM {
        return Err(SeamError::Io(format!(
            "the {name} fd is a socket but not SOCK_STREAM ({kind:?})"
        )));
    }
    Ok(fd)
}

/// Serve requests until the listener closes.
///
/// Connections are handled ONE AT A TIME, deliberately. Agent operations mutate global system
/// state — a pool, a dataset, `smb.conf` — so concurrency would demand a lock around nearly
/// everything anyway. Serialising at the accept loop makes that lock unnecessary and makes the
/// audit log a true serial history of privileged actions. The call rate is a handful per minute;
/// there is nothing to win by overlapping them.
pub fn serve_loop<R: CommandRunner, S: Sink, P: SafePath>(
    listener: &UnixListener,
    agent: &Agent<'_, R, S, P>,
) -> Result<(), SeamError> {
    loop {
        let stream = match listener.accept() {
            Ok((stream, _addr)) => stream,
            // A client that vanished between the kernel queueing the connection and our accept is
            // routine, not something to die over.
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::ConnectionAborted | std::io::ErrorKind::Interrupted
                ) =>
            {
                continue
            }
            // EMFILE/ENFILE is a TRANSIENT shortage, not a reason to exit. There is no
            // `std::io::ErrorKind` for either, so without this arm they fall through to the fatal
            // one and the process dies — and StartLimitBurst=5/StartLimitIntervalSec=60, which
            // P1-D moved into [Unit] and therefore actually put in effect, turns five of those into
            // a permanently failed unit needing `systemctl reset-failed` at the console. An accept
            // loop that exits on a transient errno is a crash primitive, not a safety measure.
            Err(e) if is_descriptor_shortage(&e) => {
                eprintln!("depsis-agent: out of descriptors on accept ({e}); retrying");
                std::thread::sleep(std::time::Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(SeamError::Io(format!("accept: {e}"))),
        };

        // One bad connection must never take the agent down.
        if let Err(e) = serve_one(&stream, agent) {
            eprintln!("depsis-agent: connection failed: {e}");
        }
    }
}

fn serve_one<R: CommandRunner, S: Sink, P: SafePath>(
    stream: &UnixStream,
    agent: &Agent<'_, R, S, P>,
) -> Result<(), SeamError> {
    stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .and_then(|()| stream.set_write_timeout(Some(IO_TIMEOUT)))
        .map_err(|e| SeamError::Io(format!("set timeouts: {e}")))?;

    // Identity comes from the kernel, before a single byte of the request is read or trusted.
    // Nothing on the wire can influence it (ADR-0006, threat model TB4).
    let peer = peer_of(stream)?;

    let line = read_request_line(stream)?;

    if line.is_empty() {
        // Peer closed without sending anything — a liveness probe, typically.
        return Ok(());
    }

    // `read_line` returns a line with no trailing newline in two situations that could hardly be
    // more different: the peer sent a complete request and closed its write side, which is what
    // any ordinary request/response client does; or the request hit the size cap and was cut off
    // mid-line. An earlier version told them apart by the missing newline alone and therefore
    // answered every well-behaved client with "request exceeds 262144 bytes" — P0-E measured it
    // on its first run, and it was invisible in unit tests because the mock transport is
    // line-oriented and never closes a stream mid-request.
    //
    // The byte count is what actually distinguishes them. A line at or over the cap is refused;
    // anything shorter is a complete request whether or not it ends in a newline.
    if line.len() as u64 >= MAX_REQUEST_BYTES {
        return respond(
            stream,
            &Response::Refused {
                reason: format!("request exceeds {MAX_REQUEST_BYTES} bytes"),
            },
        );
    }

    let (correlation_id, reason, request_json) = match split_envelope(line.trim_end()) {
        Ok(v) => v,
        Err(why) => return respond(stream, &Response::Failed { reason: why }),
    };

    let response = agent.handle(&request_json, peer, &correlation_id, &reason);
    respond(stream, &response)
}

/// How many data connections may be in flight at once.
///
/// A FIXED pool, not a thread per connection. The control loop can be serial because its
/// operations are short and mutate global state; a data connection is neither — it holds a worker
/// for as long as a client takes to send a chunk, so serialising it would let one slow uploader
/// stall every other one. Spawning per connection is the other extreme and is worse: connection
/// rate would become thread count on a root daemon, which is a denial-of-service primitive handed
/// to anyone in the `depsis-api` group.
///
/// Sixteen because the memory ceiling is this times `data::COPY_BUFFER` (1 MiB in total) and the
/// descriptor ceiling is this plus `MAX_PENDING_TRANSFERS`, both small enough to state out loud.
pub const MAX_DATA_CONNECTIONS: usize = 16;

/// Serve data connections until the listener closes.
///
/// The queue is a RENDEZVOUS channel — capacity zero — so a connection is only accepted once a
/// worker is free to take it. Any buffer here would be a place for connections to pile up out of
/// sight of the kernel's own `Backlog=`, and the honest backpressure is to leave them queued where
/// the socket unit already bounds them.
pub fn serve_data_loop<S: Sink>(
    listener: &UnixListener,
    channel: &DataChannel<'_, S>,
) -> Result<(), SeamError> {
    let (tx, rx) = std::sync::mpsc::sync_channel::<UnixStream>(0);
    let rx = std::sync::Mutex::new(rx);

    std::thread::scope(|scope| {
        for _ in 0..MAX_DATA_CONNECTIONS {
            let rx = &rx;
            scope.spawn(move || data_worker(rx, channel));
        }

        let result = accept_into(listener, &tx);
        // Dropping the last sender is what lets the workers finish; without it the scope would
        // join on threads still blocked in `recv`.
        drop(tx);
        result
    })
}

/// Hand every accepted connection to whichever worker is free.
fn accept_into(
    listener: &UnixListener,
    tx: &std::sync::mpsc::SyncSender<UnixStream>,
) -> Result<(), SeamError> {
    loop {
        let stream = match listener.accept() {
            Ok((stream, _addr)) => stream,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::ConnectionAborted | std::io::ErrorKind::Interrupted
                ) =>
            {
                continue
            }
            // Same reasoning as the control loop: EMFILE/ENFILE is transient and has no
            // `std::io::ErrorKind`, so without this arm it falls through to the fatal one and an
            // exhausted descriptor table becomes a crash.
            Err(e) if is_descriptor_shortage(&e) => {
                eprintln!("depsis-agent: out of descriptors on data accept ({e}); retrying");
                std::thread::sleep(std::time::Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(SeamError::Io(format!("data accept: {e}"))),
        };

        if tx.send(stream).is_err() {
            // Every worker is gone. Continuing would accept connections nothing will ever read.
            return Err(SeamError::Io("all data workers have exited".into()));
        }
    }
}

fn data_worker<S: Sink>(
    rx: &std::sync::Mutex<std::sync::mpsc::Receiver<UnixStream>>,
    channel: &DataChannel<'_, S>,
) {
    loop {
        let stream = {
            // Poison is recovered rather than propagated: one worker panicking must not take the
            // whole data channel down with it, which is what `unwrap` here would do to all sixteen.
            let guard = rx.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            match guard.recv() {
                Ok(stream) => stream,
                Err(_) => return,
            }
        };
        if let Err(e) = serve_data_one(&stream, channel) {
            eprintln!("depsis-agent: data connection failed: {e}");
        }
    }
}

fn serve_data_one<S: Sink>(
    stream: &UnixStream,
    channel: &DataChannel<'_, S>,
) -> Result<(), SeamError> {
    stream
        .set_write_timeout(Some(IO_TIMEOUT))
        .map_err(|e| SeamError::Io(format!("set data write timeout: {e}")))?;

    // Identity comes from the kernel, before a single byte of the preamble is read or trusted.
    let peer = peer_of(stream)?;

    // `&UnixStream` implements both `Read` and `Write`, which is what lets the closure below keep
    // its own shared borrow for `set_read_timeout` while the channel reads through this one. A
    // `&mut UnixStream` would have made the two mutually exclusive and forced a `try_clone`.
    let mut io = stream;
    channel.serve(&mut io, peer, |budget| {
        stream
            .set_read_timeout(Some(budget))
            .map_err(|e| SeamError::Io(format!("arm the data read timeout: {e}")))
    })
}

/// Read one newline-terminated request under an ABSOLUTE deadline.
///
/// `set_read_timeout` arms `SO_RCVTIMEO`, which bounds a single `recv(2)` — not a connection. A
/// peer that sends one byte every twenty-nine seconds re-arms the window on every byte, so
/// `read_line` returns only on a newline or at the size cap. With a 30-second timeout and a 256 kB
/// cap that is a single connection holding the agent for roughly 88 days, and because `serve_loop`
/// handles one connection at a time, nothing else is served for the duration. Any member of the
/// `depsis-api` group can do it, which under threat-model TB4 includes a compromised API.
///
/// The fix is a deadline the peer cannot push back: the socket timeout is re-armed before every
/// read to whatever remains of the budget, and the budget is checked between reads. A slow client
/// is then bounded by `IO_TIMEOUT` in total rather than per syscall.
///
/// Reading by hand rather than through `BufRead::read_line` is what makes that possible — the
/// buffered reader owns its own loop and offers no place to re-arm.
fn read_request_line(stream: &UnixStream) -> Result<String, SeamError> {
    read_request_line_within(stream, IO_TIMEOUT)
}

/// The budget is a parameter so a test can use one short enough to run. `IO_TIMEOUT` is thirty
/// seconds, and a test that waits thirty seconds to prove a timeout works is a test that gets
/// deleted.
fn read_request_line_within(stream: &UnixStream, budget: Duration) -> Result<String, SeamError> {
    let deadline = Instant::now() + budget;
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut chunk = [0u8; 8192];
    let mut reader = stream;

    let expired = || SeamError::Io(format!("request not complete within {budget:?}"));

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(expired());
        }
        // A zero Duration means "no timeout" to setsockopt, which would be the opposite of what is
        // wanted; `remaining` is known non-zero here.
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|e| SeamError::Io(format!("re-arm read timeout: {e}")))?;

        // Stop at the cap rather than growing without bound. The cap is the memory-exhaustion
        // guard and has to hold even though the caller is authenticated.
        let room = (MAX_REQUEST_BYTES as usize).saturating_sub(buf.len());
        if room == 0 {
            break;
        }

        // `.get_mut(..n)` rather than `&mut chunk[..n]`: the crate denies indexing_slicing because
        // a panic in a root daemon is a denial of service on the one component that cannot be
        // restarted casually. `want` is bounded by `chunk.len()` so this cannot actually be None,
        // and the error path says so rather than unwrapping.
        let want = room.min(chunk.len());
        let target = chunk
            .get_mut(..want)
            .ok_or_else(|| SeamError::Io("read buffer window out of range".into()))?;

        let read = match reader.read(target) {
            Ok(0) => break, // peer closed its write side; whatever we have is the request
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            // A timeout here IS the deadline expiring, because the window was armed from it.
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                return Err(expired())
            }
            Err(e) => return Err(SeamError::Io(format!("read request: {e}"))),
        };

        let data = chunk
            .get(..read)
            .ok_or_else(|| SeamError::Io("short read window out of range".into()))?;
        let saw_newline = data.contains(&b'\n');
        buf.extend_from_slice(data);
        if saw_newline {
            break;
        }
    }

    // Lossy rather than strict: invalid UTF-8 should be refused by the JSON parser as a malformed
    // request, with the audit entry that goes with it, not dropped as an IO error before the
    // dispatcher ever sees it.
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn respond(stream: &UnixStream, response: &Response) -> Result<(), SeamError> {
    let mut body = serde_json::to_string(response)
        .map_err(|e| SeamError::Io(format!("serialize response: {e}")))?;
    body.push('\n');
    let mut w = stream;
    w.write_all(body.as_bytes())
        .and_then(|()| w.flush())
        .map_err(|e| SeamError::Io(format!("write response: {e}")))
}

/// Split the wire envelope into `(correlation_id, reason, request_json)`.
///
/// The envelope exists because `correlation_id` and `reason` are audit metadata, not parameters
/// of an operation. Putting them inside `Request` would mean every variant carried two fields no
/// operation uses, and would let a future variant quietly omit them.
///
/// Both are bounded and sanitised here rather than trusted, because they are written to the audit
/// log: an unbounded `reason` containing newlines is a log-injection primitive that lets a caller
/// forge audit entries.
fn split_envelope(line: &str) -> Result<(String, String, String), String> {
    const MAX_CORRELATION: usize = 64;
    const MAX_REASON: usize = 200;

    let value: serde_json::Value =
        serde_json::from_str(line).map_err(|e| format!("malformed envelope: {e}"))?;
    let obj = value
        .as_object()
        .ok_or_else(|| "envelope must be a JSON object".to_string())?;

    let field = |key: &str, max: usize| -> Result<String, String> {
        let raw = obj
            .get(key)
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| format!("envelope field '{key}' missing or not a string"))?;
        if raw.chars().count() > max {
            return Err(format!("envelope field '{key}' exceeds {max} characters"));
        }
        if raw.chars().any(char::is_control) {
            return Err(format!(
                "envelope field '{key}' contains control characters"
            ));
        }
        Ok(raw.to_string())
    };

    let correlation_id = field("correlation_id", MAX_CORRELATION)?;
    let reason = field("reason", MAX_REASON)?;

    let request = obj
        .get("request")
        .ok_or_else(|| "envelope field 'request' missing".to_string())?;
    let request_json =
        serde_json::to_string(request).map_err(|e| format!("re-encode request: {e}"))?;

    Ok((correlation_id, reason, request_json))
}

/// Write a file only its owner can read, mode BEFORE content.
///
/// The Unix half of [`crate::identity::PrivateWriter`]. It lives here because this file is where
/// every platform-specific thing in the agent lives — ADR-0006's claim about the core — and it did
/// not, until CI's Windows cross-check said so: `identity.rs` called
/// `std::os::unix::fs::OpenOptionsExt` inline, and the library therefore did not compile for
/// Windows. `cargo test` on Linux cannot notice that, which is the whole reason the cross-check is
/// in `ci.yml`.
///
/// THE ORDERING IS THE POINT and is unchanged: `mode` is passed to `open`, not applied afterwards.
/// Creating the file world-readable and chmodding it once the hashes are in leaves a window in
/// which they can be read, and a window is all an attacker on the box needs.
pub fn write_private(path: &Path, body: &str) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(body.as_bytes())
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test code: a failed assertion should panic loudly"
)]
mod tests {

    /// The pipeline mechanism, exercised with programs every box has.
    ///
    /// ZFS IS NOT NEEDED TO MEASURE THIS, and that is the point of putting the mechanism in the
    /// seam. What `zfs send | zfs recv` needs from this method is exactly what `/bin/echo | /bin/cat`
    /// needs: both children spawned, the pipe moved rather than copied, the reader drained before
    /// the writer is waited on, and BOTH exit statuses checked. Those are the parts that can be
    /// wrong; the ZFS semantics on top of them can only be measured on a box with a pool.
    mod piped {
        use super::*;

        fn runner() -> ExecRunner {
            ExecRunner
        }

        #[test]
        fn moves_the_writer_output_into_the_reader() {
            let out = runner()
                .run_piped("/bin/echo", &["depsis"], "/bin/cat", &[])
                .expect("a pipeline of echo into cat must succeed");
            assert_eq!(out.trim(), "depsis");
        }

        #[test]
        fn returns_the_reader_stdout_and_not_the_writer_s() {
            // `zfs send` writes the STREAM to stdout and `zfs recv` writes a short summary. Getting
            // this backwards would return a whole dataset's bytes to a caller expecting one line.
            let out = runner()
                .run_piped("/bin/echo", &["ham"], "/usr/bin/wc", &["-c"])
                .expect("wc must read what echo wrote");
            assert_eq!(out.trim(), "4", "wc should count 'ham' plus its newline");
        }

        #[test]
        fn fails_when_the_writer_fails_even_though_the_reader_succeeded() {
            // THE CASE A SHELL PIPELINE GETS WRONG. `sh -c 'a | b'` reports b's status, so a send
            // that died half way through would look like a successful replication onto a
            // TRUNCATED target — a dataset that exists, looks like a backup, and is missing a tail.
            let error = runner()
                .run_piped("/bin/false", &[], "/bin/cat", &[])
                .expect_err("a failed writer must fail the pipeline");
            match error {
                SeamError::Command { program, .. } => {
                    assert_eq!(program, "/bin/false", "the WRITER must be blamed");
                }
                other => panic!("expected a command failure, got {other:?}"),
            }
        }

        #[test]
        fn fails_when_the_reader_fails() {
            let error = runner()
                .run_piped("/bin/echo", &["x"], "/bin/false", &[])
                .expect_err("a failed reader must fail the pipeline");
            match error {
                SeamError::Command { program, .. } => assert_eq!(program, "/bin/false"),
                other => panic!("expected a command failure, got {other:?}"),
            }
        }

        #[test]
        fn does_not_deadlock_on_a_stream_larger_than_the_pipe_buffer() {
            // A pipe buffer is 64 kB on Linux. Waiting on the writer BEFORE draining the reader
            // deadlocks the moment the stream exceeds it: the writer blocks on write, the parent
            // blocks on wait, and nothing reads. A real `zfs send` is gigabytes, so this is not a
            // corner — it is the ordinary case, and the smallest test that would notice.
            let out = runner()
                .run_piped(
                    "/usr/bin/head",
                    &["-c", "1000000", "/dev/zero"],
                    "/usr/bin/wc",
                    &["-c"],
                )
                .expect("a megabyte through the pipe must not hang");
            assert_eq!(out.trim(), "1000000");
        }

        #[test]
        fn kills_a_writer_whose_reader_exited_instead_of_waiting_for_ever() {
            // THE ONE THAT WEDGED THE AGENT. Rust sets SIGPIPE to SIG_IGN and children inherit it,
            // so `yes` writing into an exited `head` is never killed by the kernel — it sees EPIPE
            // and spins, and the parent's `wait` never returns. The control socket is serialised,
            // so that stops the privileged process answering anything at all.
            //
            // Bounded on the test side too: if the fix regresses, this hangs, and a hanging test
            // is a louder failure than a wrong assertion.
            let started = std::time::Instant::now();
            let error = runner()
                .run_piped("/usr/bin/yes", &["depsis"], "/usr/bin/head", &["-c", "8"])
                .expect_err("a writer that cannot finish must be reported, not waited on");
            assert!(
                started.elapsed() < std::time::Duration::from_secs(30),
                "the pipeline must give up rather than hang"
            );
            match error {
                SeamError::Command { program, .. } => assert_eq!(program, "/usr/bin/yes"),
                other => panic!("expected the writer to be blamed, got {other:?}"),
            }
        }

        #[test]
        fn the_reader_inherits_no_environment_from_this_process() {
            // `env_clear` on both halves. A privileged pipeline that inherited the caller's
            // LD_PRELOAD would be a hole neither half's code shows on its own.
            std::env::set_var("DEPSIS_PIPED_LEAK", "1");
            let out = runner()
                .run_piped("/usr/bin/env", &[], "/bin/cat", &[])
                .expect("env must run");
            std::env::remove_var("DEPSIS_PIPED_LEAK");
            assert!(
                !out.contains("DEPSIS_PIPED_LEAK"),
                "the writer half must start from a cleared environment"
            );
            // And the allowlist is actually applied rather than the environment merely being empty.
            assert!(out.contains("LC_ALL=C"), "the fixed locale must be set");
        }

        #[test]
        fn a_program_that_does_not_exist_is_an_io_error_not_a_panic() {
            let error = runner()
                .run_piped("/nonexistent/depsis-writer", &[], "/bin/cat", &[])
                .expect_err("a missing program must be reported");
            assert!(matches!(error, SeamError::Io(_)), "got {error:?}");
        }
    }

    use super::*;
    use depsis_agent::audit::MemorySink;
    use depsis_agent::authz::Policy;
    use depsis_agent::seams::mock::{MockCommandRunner, MockSafePath, MockTokenSource};
    use depsis_agent::transfer::TransferRegistry;
    use std::sync::Mutex;

    // ── SO_PEERCRED ──
    //
    // These need a real socket and a real kernel; the mock seam cannot demonstrate them, and
    // ADR-0007 forbids treating mock results as evidence of system behaviour. They are the
    // load-bearing half of threat-model boundary TB4: if `peer_of` were wrong or spoofable, the
    // agent's entire authorization model would rest on nothing.

    fn socket_pair() -> (UnixStream, UnixStream) {
        UnixStream::pair().expect("socketpair")
    }

    #[test]
    fn peer_credentials_report_this_process() {
        let (a, _b) = socket_pair();
        let peer = peer_of(&a).expect("peercred");

        assert_eq!(peer.uid, rustix::process::getuid().as_raw(), "uid");
        assert_eq!(peer.gid, rustix::process::getgid().as_raw(), "gid");
        assert_eq!(
            u32::try_from(peer.pid).unwrap(),
            std::process::id(),
            "pid must be the peer's, and for a socketpair that is us"
        );
    }

    #[test]
    fn peer_identity_is_not_derived_from_anything_on_the_wire() {
        // The attack: a caller writes a request claiming to be uid 0. `peer_of` must be
        // unaffected — it reads the kernel's record of who opened the socket, and there is no
        // code path from bytes to identity.
        let (mut a, b) = socket_pair();
        a.write_all(br#"{"uid":0,"gid":0,"pid":1}"#).expect("write");

        // The claim is that the uid comes from the kernel's record of the peer, not from the
        // bytes. Comparing against `getuid()` states exactly that and holds whoever runs the
        // suite. An earlier version additionally asserted `uid != 0` to prove the wire had not
        // won — but P0-E runs `cargo test` as root, where that assertion fails for a reason
        // that has nothing to do with the property under test.
        let peer = peer_of(&b).expect("peercred");
        assert_eq!(
            peer.uid,
            rustix::process::getuid().as_raw(),
            "peer uid must be the kernel's, not the one asserted in the payload"
        );
        // When the suite is NOT run as root, the payload's claim of uid 0 is also directly
        // contradicted, which is the sharper version of the same statement.
        if rustix::process::getuid().as_raw() != 0 {
            assert_ne!(
                peer.uid, 0,
                "the wire's claim of uid 0 must not be honoured"
            );
        }
    }

    // ── envelope parsing ──
    //
    // Everything below is reached BEFORE dispatch, so a bug here is a bug in front of the
    // authorization check.

    #[test]
    fn a_well_formed_envelope_splits() {
        let (c, r, req) = split_envelope(
            r#"{"correlation_id":"abc123","reason":"user requested","request":{"op":"ping"}}"#,
        )
        .expect("split");
        assert_eq!(c, "abc123");
        assert_eq!(r, "user requested");
        assert_eq!(req, r#"{"op":"ping"}"#);
    }

    #[test]
    fn a_reason_containing_a_newline_is_refused() {
        // Log injection: without this check a caller could append a forged line to the audit
        // trail, e.g. a fabricated entry attributing an action to another operator.
        let err = split_envelope(
            "{\"correlation_id\":\"a\",\"reason\":\"ok\\ndepsis-audit: allow root\",\"request\":{\"op\":\"ping\"}}",
        )
        .expect_err("must refuse control characters");
        assert!(err.contains("control characters"), "got: {err}");
    }

    #[test]
    fn an_overlong_reason_is_refused() {
        let long = "x".repeat(500);
        let line =
            format!(r#"{{"correlation_id":"a","reason":"{long}","request":{{"op":"ping"}}}}"#);
        let err = split_envelope(&line).expect_err("must refuse");
        assert!(err.contains("exceeds"), "got: {err}");
    }

    #[test]
    fn a_missing_request_field_is_refused_not_defaulted() {
        let err =
            split_envelope(r#"{"correlation_id":"a","reason":"b"}"#).expect_err("must refuse");
        assert!(err.contains("'request' missing"), "got: {err}");
    }

    #[test]
    fn a_bare_request_without_an_envelope_is_refused() {
        // There is exactly one wire format. Accepting a bare request "helpfully" would mean
        // privileged calls that carry no reason and no correlation id — unattributable in the
        // audit log, which is the one thing the audit log exists to prevent.
        let err = split_envelope(r#"{"op":"ping"}"#).expect_err("must refuse");
        assert!(err.contains("correlation_id"), "got: {err}");
    }

    #[test]
    fn malformed_json_is_refused_without_panicking() {
        assert!(split_envelope("{not json").is_err());
        assert!(split_envelope("").is_err());
        assert!(split_envelope("[]").is_err());
        assert!(split_envelope("null").is_err());
    }

    /// The shares root's own emptiness, against a real kernel — the question the appliance could
    /// not answer for a whole release.
    ///
    /// WHAT THIS REPLACES. The two operations that need this asked `list_entries(&[])`. The mock
    /// answered it by listing the temp root; `openat2` refuses an empty component list outright,
    /// because the first component is always the SHARE NAME. So `share_root_status` reported
    /// "not empty" on every real box (the error was swallowed with `.unwrap_or(false)`) and
    /// `prepare_share_root` failed with `io: empty path`. The wizard hid its own checkbox, the
    /// recovery button answered 503, and the box could not open a single share.
    ///
    /// A dispatcher test could not have caught it: the seam it runs against is the one that
    /// answered. Only a test against the kernel can.
    #[test]
    fn the_shares_root_can_be_asked_whether_it_is_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Openat2SafePath::open_root(dir.path()).expect("root");

        assert!(
            paths.root_is_empty().expect("a fresh root answers"),
            "a directory with nothing in it is empty"
        );

        std::fs::create_dir(dir.path().join("belgeler")).expect("seed");
        assert!(
            !paths.root_is_empty().expect("answers with a share in it"),
            "a root holding a share directory is not empty"
        );
    }

    /// A symlink counts. It is the case the listing filter would have dropped.
    ///
    /// `entries_of` — which every other listing goes through — omits symlinks, sockets and
    /// non-UTF-8 names, because DEPSIS has no row shape for them. Reusing that filter for an
    /// EMPTINESS answer would be a quiet data-hiding bug: the one caller that reads this answer
    /// goes on to `zfs create -o mountpoint=<root>`, and a mount over a non-empty directory makes
    /// everything under it invisible while it still occupies the disk. The refusal exists for
    /// exactly that, so the question has to count everything the kernel reports.
    #[test]
    fn a_root_holding_only_a_symlink_is_not_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("hedef");
        std::fs::create_dir(&target).expect("seed");

        let root = dir.path().join("paylasimlar");
        std::fs::create_dir(&root).expect("mkdir");
        std::os::unix::fs::symlink(&target, root.join("bag")).expect("symlink");

        let paths = Openat2SafePath::open_root(&root).expect("root");
        assert!(
            !paths.root_is_empty().expect("answers"),
            "a symlink is something; mounting a dataset over it would hide where it points"
        );
    }

    /// The sweeper's first line, against a real kernel.
    ///
    /// This is the same defect as `root_is_empty`'s and it survived the first fix: `sweep_once`
    /// asked `list_dirs(&[])`, the mock answered by listing the temp root, and `openat2` refused
    /// it. On a real appliance the storage sweeper therefore failed on its first line every ten
    /// minutes — abandoned upload fragments under `<share>/.depsis/staging` were never removed,
    /// while counting against the user's quota and being invisible to them over SMB.
    ///
    /// The symlink half is not decoration. What this returns is walked by a root process that
    /// deletes stale files inside each name; a symlink to `/` reported as a share is how that
    /// becomes a delete of somewhere else.
    #[test]
    fn the_shares_are_listed_from_the_root_and_a_symlink_is_not_one_of_them() {
        let dir = tempfile::tempdir().expect("tempdir");
        // The stand-in for somewhere off the appliance's share tree — outside the root, so that
        // the symlink below genuinely points out of it.
        let outside = dir.path().join("disarisi");
        std::fs::create_dir(&outside).expect("mkdir");

        let root = dir.path().join("paylasimlar");
        std::fs::create_dir(&root).expect("mkdir");
        std::fs::create_dir(root.join("belgeler")).expect("share");
        std::fs::create_dir(root.join("yedek")).expect("share");
        std::fs::write(root.join("not.txt"), b"x").expect("file");
        std::os::unix::fs::symlink(&outside, root.join("kacis")).expect("symlink");

        let paths = Openat2SafePath::open_root(&root).expect("root");
        let shares = paths.list_share_dirs().expect("the shares are listable");

        assert_eq!(
            shares,
            vec!["belgeler".to_string(), "yedek".to_string()],
            "only real directories are shares: a file is not one, and a symlink must not be one"
        );
    }

    /// The refusal that made `list_entries(&[])` the wrong route, kept measured.
    ///
    /// If a later change ever made an empty component list resolve to the root inside `open_dir`,
    /// it would also reach `remove_file`, `remove_dir` and `create_dir` — they resolve their
    /// parent through the same method — and the shares root would become a deletable parent in a
    /// process running as root. This test is what makes that change loud instead of silent.
    #[test]
    fn an_empty_component_list_is_still_refused_by_the_directory_opener() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Openat2SafePath::open_root(dir.path()).expect("root");
        assert!(
            paths.open_dir(&[]).is_err(),
            "open_dir(&[]) must stay a refusal; root_is_empty is the sanctioned way to ask"
        );
    }

    #[test]
    fn set_mode_changes_the_directory_the_descriptor_pins() {
        // Against a real kernel, unlike the dispatcher's test: `fchmod` needs no capability when
        // the caller owns the file, so this runs for anybody and measures the actual bits.
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(dir.path().join("share")).expect("seed");
        let paths = Openat2SafePath::open_root(dir.path()).expect("root");
        let opened = paths.open_dir(&["share"]).expect("open_dir");

        // Deliberately world-traversable first, which is what `zfs create` leaves behind.
        paths.set_mode(&opened, 0o755).expect("chmod 0755");
        assert_eq!(mode_of(&dir.path().join("share")), 0o755);

        paths.set_mode(&opened, 0o750).expect("chmod 0750");
        // The last digit is the whole fix: `other` loses `r-x`, so a principal the ACL does not
        // name cannot enumerate or enter the share root.
        assert_eq!(mode_of(&dir.path().join("share")), 0o750);
    }

    #[test]
    fn set_owner_aims_at_the_descriptor_and_not_at_a_path() {
        // Two assertions in one, because only one of them can run without CAP_CHOWN.
        //
        // Always: chowning to the CURRENT owner is permitted for anyone, so the call itself is
        // exercised — a `set_owner` that was never wired to `fchown` would fail here.
        //
        // Only as root: the ownership actually changes. Skipped otherwise rather than asserted
        // loosely, because a test that passes for an ordinary user by expecting EPERM would also
        // pass if the implementation did nothing at all.
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("f"), b"x").expect("seed");
        let paths = Openat2SafePath::open_root(dir.path()).expect("root");
        let file = paths.open(&["f"], OpenIntent::Read).expect("open");

        let me = rustix::process::getuid().as_raw();
        let my_group = rustix::process::getgid().as_raw();
        paths
            .set_owner(&file, me, my_group)
            .expect("chowning a file to its existing owner is always permitted");

        if me != 0 {
            return;
        }
        paths.set_owner(&file, 1000, 1001).expect("fchown as root");
        let after = std::fs::metadata(dir.path().join("f")).expect("stat");
        assert_eq!(
            (
                std::os::unix::fs::MetadataExt::uid(&after),
                std::os::unix::fs::MetadataExt::gid(&after)
            ),
            (1000, 1001),
            "the file the descriptor names must be the file that changed hands"
        );
    }

    // ── socket activation ──

    #[test]
    fn a_listen_pid_for_another_process_is_refused() {
        // Guards the SAFETY assertion above. If this check regressed, the unsafe block would be
        // adopting a descriptor that may belong to another process's socket.
        temp_env(
            &[
                ("LISTEN_PID", Some("1")),
                ("LISTEN_FDS", Some("2")),
                ("LISTEN_FDNAMES", Some("control:data")),
            ],
            || {
                let err = listeners_from_systemd().expect_err("must refuse a foreign LISTEN_PID");
                assert!(
                    err.to_string().contains("meant for someone else"),
                    "got: {err}"
                );
            },
        );
    }

    #[test]
    fn running_without_socket_activation_is_refused() {
        temp_env(&[("LISTEN_PID", None), ("LISTEN_FDS", None)], || {
            let err = listeners_from_systemd().expect_err("must refuse");
            assert!(err.to_string().contains("LISTEN_PID unset"), "got: {err}");
        });
    }

    // ── which descriptor is which ──
    //
    // These drive `socket_offsets` directly rather than `listeners_from_systemd`, because the
    // latter would need two real listening sockets sitting at fixed descriptor numbers. Every
    // decision lives in the pure function; the adoption around it has none. The end-to-end proof
    // that systemd really sets these variables is in the P1-D deployment probe, against pid 1.

    #[test]
    fn the_control_socket_is_found_by_name_and_not_by_position() {
        // The whole reason `Listeners` is a struct. systemd's descriptor order follows unit load
        // order, so `data` arriving first is not a hypothetical — and reading fd 3 as the control
        // socket would make the agent parse uploaded file bytes as JSON commands and stream a
        // user's data into whatever answered the control connection.
        assert_eq!(
            socket_offsets(Some("control:data"), 2).expect("both named"),
            (0, 1)
        );
        assert_eq!(
            socket_offsets(Some("data:control"), 2).expect("both named"),
            (1, 0)
        );
    }

    #[test]
    fn a_descriptor_nobody_named_is_refused() {
        // systemd always sets LISTEN_FDNAMES when it passes descriptors, so an absent value means
        // something other than systemd handed them over.
        let err = socket_offsets(None, 2).expect_err("must refuse");
        assert!(
            err.to_string().contains("LISTEN_FDNAMES unset"),
            "got: {err}"
        );
    }

    #[test]
    fn a_name_this_agent_does_not_serve_is_refused() {
        // Fail closed. A listening root socket nobody accepts on is worse than not starting.
        let err = socket_offsets(Some("control:data:debug"), 3).expect_err("must refuse");
        assert!(err.to_string().contains("\"debug\""), "got: {err}");
    }

    #[test]
    fn the_control_socket_alone_is_not_enough_to_start() {
        // Starting here would be the worst of both worlds: the API mints transfer tokens and
        // stages files for data connections that can never arrive, so every upload fails after a
        // five-minute timeout and looks like a network problem.
        let err = socket_offsets(Some("control"), 1).expect_err("must refuse");
        assert!(
            err.to_string().contains("depsis-agent-data.socket"),
            "got: {err}"
        );
    }

    #[test]
    fn the_data_socket_alone_is_not_enough_to_start() {
        let err = socket_offsets(Some("data"), 1).expect_err("must refuse");
        assert!(
            err.to_string().contains("depsis-agent.socket"),
            "got: {err}"
        );
    }

    #[test]
    fn two_sockets_sharing_a_name_are_refused() {
        let err = socket_offsets(Some("control:control"), 2).expect_err("must refuse");
        assert!(err.to_string().contains("both named"), "got: {err}");
    }

    #[test]
    fn a_name_list_that_does_not_match_the_descriptor_count_is_refused() {
        // Without one name per descriptor there is no mapping, only a guess — and a guess here
        // picks a socket for the agent to trust.
        let err = socket_offsets(Some("control:data"), 3).expect_err("must refuse");
        assert!(err.to_string().contains("names 2 sockets"), "got: {err}");
        let err = socket_offsets(Some("control:data:extra"), 2).expect_err("must refuse");
        assert!(err.to_string().contains("names 3 sockets"), "got: {err}");
    }

    /// Set environment variables for the duration of `f`, then restore them.
    ///
    /// `std::env::set_var` is process-global and Rust runs tests in threads, so these three tests
    /// must not run concurrently with each other. A mutex, not `--test-threads=1`, because the
    /// constraint belongs with the code that has it rather than in a CI invocation someone will
    /// eventually copy without it.
    fn temp_env(vars: &[(&str, Option<&str>)], f: impl FnOnce()) {
        use std::sync::Mutex;
        static LOCK: Mutex<()> = Mutex::new(());
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let saved: Vec<(String, Option<String>)> = vars
            .iter()
            .map(|(k, _)| ((*k).to_string(), std::env::var(k).ok()))
            .collect();
        for (k, v) in vars {
            match v {
                Some(val) => std::env::set_var(k, val),
                None => std::env::remove_var(k),
            }
        }

        f();

        for (k, v) in saved {
            match v {
                Some(val) => std::env::set_var(&k, val),
                None => std::env::remove_var(&k),
            }
        }
    }

    // ── openat2 containment ──
    //
    // These exercise `Openat2SafePath` itself, against a real kernel. They lived in
    // `tests/openat2_containment.rs` for one build, which was a mistake: an integration test
    // cannot import a binary's modules, so it had to re-declare the flag set and was therefore
    // testing a copy that could drift from the real one. Here they drive the actual struct.
    //
    // A mock cannot stand in for any of this — the confinement is the kernel's, and ADR-0007 is
    // explicit that mock results are not evidence of filesystem behaviour. Risk R3 (path
    // traversal and symlink TOCTOU) is what they defend.

    #[test]
    fn a_file_inside_the_root_resolves() {
        let tmp = tempfile::tempdir().expect("tempdir");
        std::fs::write(tmp.path().join("inside.txt"), b"hello").expect("write");

        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");
        assert!(sp.open(&["inside.txt"], OpenIntent::Read).is_ok());
    }

    #[test]
    fn dotdot_cannot_climb_out_of_the_root() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().join("share");
        std::fs::create_dir(&root).expect("mkdir");
        std::fs::write(tmp.path().join("secret.txt"), b"not yours").expect("write");

        let sp = Openat2SafePath::open_root(&root).expect("open root");
        assert!(
            sp.open(&["..", "secret.txt"], OpenIntent::Read).is_err(),
            "RESOLVE_BENEATH must refuse .. — it escaped instead"
        );
    }

    #[test]
    fn a_symlink_pointing_outside_is_refused_rather_than_followed() {
        // The attack: a user creates a symlink inside their own share pointing at /etc/shadow,
        // then asks the agent to read it. Without NO_SYMLINKS the agent, running as root, would
        // follow it happily.
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().join("share");
        std::fs::create_dir(&root).expect("mkdir");
        std::fs::write(tmp.path().join("secret.txt"), b"not yours").expect("write");
        std::os::unix::fs::symlink(tmp.path().join("secret.txt"), root.join("link"))
            .expect("symlink");

        let sp = Openat2SafePath::open_root(&root).expect("open root");
        assert!(
            sp.open(&["link"], OpenIntent::Read).is_err(),
            "RESOLVE_NO_SYMLINKS must refuse a symlink even before asking where it points"
        );
    }

    /// The escalation test: the name handed to `setfacl` must survive a swap of the directory.
    ///
    /// This is the kernel half of `acl::Applier::apply`. The module used to give `setfacl` a
    /// re-joined absolute path, which an ordinary resolution walks a second time — and `setfacl
    /// 2.3.2` follows a symlink passed as an argument. So an SMB user with create rights in the
    /// parent could `mv folder folder.bak && ln -s /etc folder` in the window between the agent's
    /// `openat2` and the exec, and a root process would write their own team's gid at rwx, plus the
    /// matching default ACL, onto `/etc`. Both the target and the gid are attacker-chosen.
    ///
    /// Here the directory is renamed away and a symlink to somewhere else is put in its place,
    /// exactly as the attack does, AFTER `open_dir` has returned. `command_path` must still name
    /// the original inode. A joined path would name the attacker's symlink.
    #[test]
    fn the_command_path_still_names_the_confined_directory_after_the_name_is_swapped() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().join("share");
        std::fs::create_dir(&root).expect("mkdir");
        std::fs::create_dir(root.join("faturalar")).expect("mkdir");
        // The stand-in for /etc: somewhere outside the share that the attacker wants the ACL on.
        let elsewhere = tmp.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).expect("mkdir");
        // A file only inside the real folder, so the two directories can be told apart by looking.
        std::fs::write(root.join("faturalar").join("marker"), b"x").expect("write");

        let sp = Openat2SafePath::open_root(&root).expect("open root");
        let confined = sp.open_dir(&["faturalar"]).expect("open the folder");

        // The swap, after the check and before the "exec".
        std::fs::rename(root.join("faturalar"), tmp.path().join("faturalar.bak")).expect("rename");
        std::os::unix::fs::symlink(&elsewhere, root.join("faturalar")).expect("symlink");

        let aimed = sp.command_path(&confined).expect("a command path");
        assert!(
            std::path::Path::new(&aimed).join("marker").exists(),
            "{aimed} must still resolve to the directory openat2 confined; it resolved somewhere              without the marker, which is the escalation"
        );
        assert!(
            !std::path::Path::new(&aimed)
                .canonicalize()
                .expect("canonicalize")
                .starts_with(&elsewhere),
            "the command path followed the attacker's symlink"
        );
    }

    /// The command path must survive an EXEC — the entire point of it is to be handed to
    /// `setfacl`/`getfacl`, which are child processes.
    ///
    /// The blind spot this closes: the test above resolves the path in the SAME process, where
    /// `/proc/self/fd/N` works fine. Every descriptor is opened CLOEXEC, so in a child that same
    /// spelling names a descriptor the exec just closed — the first real box answered
    /// "getfacl /proc/self/fd/9: No such file or directory" for every ACL in every share, and no
    /// test had ever put a real child process between `open_dir` and the resolution.
    #[test]
    fn the_command_path_resolves_in_a_child_process_after_exec() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().join("share");
        std::fs::create_dir(&root).expect("mkdir");
        std::fs::create_dir(root.join("faturalar")).expect("mkdir");

        let sp = Openat2SafePath::open_root(&root).expect("open root");
        let confined = sp.open_dir(&["faturalar"]).expect("open the folder");
        let aimed = sp.command_path(&confined).expect("a command path");

        let status = std::process::Command::new("/usr/bin/test")
            .arg("-d")
            .arg(&aimed)
            .status()
            .expect("spawn /usr/bin/test");
        assert!(
            status.success(),
            "{aimed} did not resolve to a directory inside a child process; a CLOEXEC'd \
             /proc/self spelling fails exactly here while passing every same-process test"
        );
    }

    /// A file where a directory was named is ENOTDIR, and ENOTDIR is not a containment violation.
    ///
    /// It used to be reported as one — every errno but ENOENT/ENOSYS became `PathEscape`, so
    /// `alice/notes.txt/x` came back as "path escapes the share root", which reads as a caller
    /// trying to break out. ADR-0017 exists because that class of misdiagnosis cost a bisection.
    /// The dispatcher also depends on the split: `create_directory` answers 404 for this and would
    /// otherwise fall through to a 500 the caller cannot act on.
    #[test]
    fn a_file_in_the_path_is_not_reported_as_an_escape() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().join("share");
        std::fs::create_dir(&root).expect("mkdir");
        std::fs::write(root.join("notes.txt"), b"x").expect("write");

        let sp = Openat2SafePath::open_root(&root).expect("open root");
        for relative in [&["notes.txt"][..], &["notes.txt", "child"][..]] {
            match sp.open_dir(relative) {
                Err(SeamError::NotADirectory(_)) => {}
                other => panic!(
                    "{relative:?} must be NotADirectory, not an escape or a fault; got {other:?}"
                ),
            }
        }
    }

    #[test]
    fn an_absolute_looking_component_cannot_reset_the_root() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");

        // Under a plain `join`, an absolute component discards everything before it. BENEATH
        // refuses instead. `SafeComponent` also rejects this earlier — belt and braces, because
        // the two defences fail for different reasons.
        assert!(sp.open(&["/etc/passwd"], OpenIntent::Read).is_err());
    }

    #[test]
    fn what_comes_back_is_the_object_that_was_checked_not_a_path_to_re_resolve() {
        // The TOCTOU test, and the reason this trait hands back a File.
        //
        // The old implementation resolved with openat2, dropped the descriptor and returned a
        // joined path for somebody else to open later. Between those two moments the name can be
        // repointed — and the second open is an ordinary resolution with none of the RESOLVE_
        // flags, so it follows the new target straight out of the root.
        //
        // Here the name is repointed at a file outside the root AFTER the open. Holding the
        // descriptor, the agent still reads what it was given; a path would have read the
        // attacker's file.
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().join("share");
        std::fs::create_dir(&root).expect("mkdir");
        std::fs::write(root.join("upload.part"), b"the real contents").expect("write");
        std::fs::write(tmp.path().join("secret.txt"), b"not yours").expect("write");

        let sp = Openat2SafePath::open_root(&root).expect("open root");
        let mut held = sp.open(&["upload.part"], OpenIntent::Read).expect("open");

        // The swap, after the check.
        std::fs::remove_file(root.join("upload.part")).expect("unlink");
        std::os::unix::fs::symlink(tmp.path().join("secret.txt"), root.join("upload.part"))
            .expect("symlink");

        let mut got = String::new();
        std::io::Read::read_to_string(&mut held, &mut got).expect("read");
        assert_eq!(
            got, "the real contents",
            "the open descriptor must still be the file that was confined, not whatever the name \
             now points at"
        );

        // And a fresh open of the same name is refused outright, because it is now a symlink.
        assert!(
            sp.open(&["upload.part"], OpenIntent::Read).is_err(),
            "the swapped-in symlink must be refused on the next open"
        );
    }

    #[test]
    fn two_appenders_do_not_overwrite_each_other() {
        // What O_APPEND buys, made observable. Without it each descriptor writes at its OWN cached
        // position, so the second writer lands on top of the first and the file ends up the length
        // of one write instead of two — silently, with no error at any layer. With it the kernel
        // resolves the position at every write and the worst case degrades to interleaving.
        //
        // A flag nothing tests is a flag that gets removed in a cleanup.
        let tmp = tempfile::tempdir().expect("tempdir");
        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");

        let mut first = sp
            .open(&["shared.part"], OpenIntent::Append)
            .expect("open a");
        let mut second = sp
            .open(&["shared.part"], OpenIntent::Append)
            .expect("open b");

        use std::io::Write as _;
        first.write_all(b"AAAA").expect("write a");
        second.write_all(b"BBBB").expect("write b");
        first.write_all(b"CCCC").expect("write a again");

        let got = std::fs::read(tmp.path().join("shared.part")).expect("read");
        assert_eq!(
            got.len(),
            12,
            "every write must land at the end; got {:?}",
            String::from_utf8_lossy(&got)
        );
        // Order between the two writers is not guaranteed, but no byte may be lost.
        for needle in [&b"AAAA"[..], &b"BBBB"[..], &b"CCCC"[..]] {
            assert!(
                got.windows(4).any(|w| w == needle),
                "{:?} was overwritten",
                String::from_utf8_lossy(needle)
            );
        }
    }

    #[test]
    fn create_new_refuses_a_name_that_already_exists() {
        // Two callers racing to claim the same staging name must not both win. EXCL is what makes
        // the claim atomic; without it the loser silently shares a file with the winner and the
        // upload is interleaved garbage.
        let tmp = tempfile::tempdir().expect("tempdir");
        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");

        assert!(sp.open(&["claim.part"], OpenIntent::CreateNew).is_ok());
        assert!(
            sp.open(&["claim.part"], OpenIntent::CreateNew).is_err(),
            "the second claim on the same name must lose"
        );
    }

    #[test]
    fn a_created_file_is_not_readable_by_everyone_while_it_is_written() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().expect("tempdir");
        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");
        sp.open(&["private.part"], OpenIntent::CreateNew)
            .expect("create");

        let mode = std::fs::metadata(tmp.path().join("private.part"))
            .expect("stat")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            mode, 0o600,
            "staging data must not be world-readable while it is being written"
        );
    }

    #[test]
    fn a_directory_can_be_opened_for_its_own_fsync() {
        // ADR-0008 step 5: the destination DIRECTORY is fsynced after the rename. Skipping it can
        // lose the rename in a power cut even though the file's contents survived, so the
        // confinement has to be able to hand back a directory too.
        let tmp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(tmp.path().join("dest")).expect("mkdir");
        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");

        let dir = sp.open_dir(&["dest"]).expect("open dir");
        dir.sync_all()
            .expect("fsync on a directory fd must succeed");

        // And a FILE must not come back from open_dir, or an fsync would be aimed at the wrong
        // object and report success having flushed nothing relevant.
        std::fs::write(tmp.path().join("plain.txt"), b"x").expect("write");
        assert!(sp.open_dir(&["plain.txt"]).is_err());
    }

    // ── move and remove, against a real kernel ──
    //
    // The dispatcher tests for `MoveEntry`/`RemoveEntry` run against `MockSafePath`, whose
    // containment is lexical and whose `rename` is `std::fs::rename`. That is enough to pin what
    // the dispatcher DECIDES and nothing at all about what the syscalls DO, so the three claims
    // that matter — the rename refuses to replace, the rmdir refuses to recurse, and neither can
    // be aimed through a symlink — are measured here.

    #[test]
    fn a_move_refuses_to_replace_and_leaves_both_sides_alone() {
        // RENAME_NOREPLACE, on this kernel and this filesystem. A silently-ignored flag would turn
        // "refuse to overwrite" into "overwrite" — the worst possible way for a flag to fail, and
        // in this product the way a user loses a file they never named.
        let tmp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(tmp.path().join("a")).expect("mkdir a");
        std::fs::create_dir(tmp.path().join("b")).expect("mkdir b");
        std::fs::write(tmp.path().join("a/note.txt"), b"the one being moved").expect("write src");
        std::fs::write(tmp.path().join("b/note.txt"), b"the one already there").expect("write dst");

        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");
        match sp.publish(&["a"], "note.txt", &["b"], "note.txt") {
            Err(SeamError::AlreadyExists(_)) => {}
            Err(other) => panic!("expected AlreadyExists, got {other:?}"),
            Ok(()) => panic!("RENAME_NOREPLACE did not hold: the destination was overwritten"),
        }

        assert_eq!(
            std::fs::read(tmp.path().join("b/note.txt")).expect("read dst"),
            b"the one already there",
            "the file the user already had was destroyed"
        );
        assert_eq!(
            std::fs::read(tmp.path().join("a/note.txt")).expect("read src"),
            b"the one being moved",
            "a refused move must be all-or-nothing; the source vanished"
        );
    }

    #[test]
    fn a_move_of_something_that_is_not_there_is_not_a_path_escape() {
        // ADR-0017's lesson, applied to the new operation: every errno collapsing into
        // `PathEscape` made an ordinary miss read as a containment violation. The API turns this
        // one into 404, so it has to arrive as `NotFound`.
        let tmp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(tmp.path().join("a")).expect("mkdir a");
        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");

        match sp.publish(&["a"], "ghost.txt", &["a"], "other.txt") {
            Err(SeamError::NotFound(_)) => {}
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn a_move_preserves_the_contents_and_fsyncs_the_destination_directory() {
        let tmp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(tmp.path().join("a")).expect("mkdir a");
        std::fs::create_dir(tmp.path().join("b")).expect("mkdir b");
        std::fs::write(tmp.path().join("a/note.txt"), b"contents must survive").expect("write");

        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");
        sp.publish(&["a"], "note.txt", &["b"], "renamed.txt")
            .expect("the move must succeed");

        assert!(!tmp.path().join("a/note.txt").exists());
        assert_eq!(
            std::fs::read(tmp.path().join("b/renamed.txt")).expect("read"),
            b"contents must survive"
        );
    }

    #[test]
    fn a_populated_directory_cannot_be_removed() {
        // The property the closed operation set is FOR. There is no recursive delete to reach: a
        // directory with a child comes back as an error and the child is still there afterwards.
        // The parent is a named directory rather than the root itself, because that is how the
        // dispatcher always calls it: the first component is the share.
        let tmp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(tmp.path().join("share/full")).expect("mkdir");
        std::fs::write(tmp.path().join("share/full/child.txt"), b"still mine").expect("write");

        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");
        match sp.remove_dir(&["share"], "full") {
            Err(SeamError::NotEmpty(_)) => {}
            Err(other) => panic!("expected NotEmpty, got {other:?}"),
            Ok(_) => panic!("a populated directory was removed: the agent can delete a tree"),
        }
        assert!(
            tmp.path().join("share/full/child.txt").exists(),
            "the child was deleted on the way to failing"
        );
    }

    #[test]
    fn an_empty_directory_is_removed_and_a_missing_one_is_reported_as_such() {
        let tmp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(tmp.path().join("share/empty")).expect("mkdir");
        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");

        assert!(
            matches!(sp.remove_dir(&["share"], "empty"), Ok(true)),
            "an empty directory must come away"
        );
        assert!(!tmp.path().join("share/empty").exists());
        assert!(
            matches!(sp.remove_dir(&["share"], "empty"), Ok(false)),
            "a second removal must report that there was nothing there"
        );
    }

    #[test]
    fn remove_dir_will_not_unlink_a_file_and_remove_file_will_not_unlink_a_directory() {
        // AT_REMOVEDIR is not decoration. Without the flag the two operations would blur, and a
        // caller that said "file" while meaning a directory — or the reverse — would find out by
        // its effect rather than by an error.
        let tmp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(tmp.path().join("share")).expect("mkdir share");
        std::fs::write(tmp.path().join("share/plain.txt"), b"x").expect("write");
        std::fs::create_dir(tmp.path().join("share/dir")).expect("mkdir");
        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");

        assert!(sp.remove_dir(&["share"], "plain.txt").is_err());
        assert!(tmp.path().join("share/plain.txt").exists());
        assert!(sp.remove_file(&["share"], "dir").is_err());
        assert!(tmp.path().join("share/dir").exists());
    }

    #[test]
    fn neither_a_move_nor_a_remove_can_be_aimed_through_a_symlink() {
        // The attack the whole flag set exists for, on the two operations that destroy data: a
        // user drops a symlink inside their own share pointing at a directory outside it, then
        // asks the agent — running as root — to move a file into it, or to delete something in it.
        // NO_SYMLINKS refuses the component before the kernel ever asks where it points.
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().join("root");
        let inside = root.join("share");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&inside).expect("mkdir share");
        std::fs::create_dir(&outside).expect("mkdir outside");
        std::fs::write(outside.join("victim.txt"), b"not yours").expect("write victim");
        std::fs::write(inside.join("payload.txt"), b"mine").expect("write payload");
        std::os::unix::fs::symlink(&outside, inside.join("escape")).expect("symlink");

        let sp = Openat2SafePath::open_root(&root).expect("open root");

        // A same-directory move still works, so a blanket failure cannot make this test pass for
        // the wrong reason.
        sp.publish(&["share"], "payload.txt", &["share"], "moved.txt")
            .expect("an ordinary move inside the root must still work");

        assert!(
            sp.publish(&["share"], "moved.txt", &["share", "escape"], "moved.txt")
                .is_err(),
            "a move landed outside the root through a symlinked directory"
        );
        assert!(
            sp.remove_file(&["share", "escape"], "victim.txt").is_err(),
            "a delete reached outside the root through a symlinked directory"
        );
        assert!(
            sp.remove_dir(&[".."], "outside").is_err(),
            "a directory outside the root was removable"
        );

        assert!(
            outside.join("victim.txt").exists(),
            "the file outside the root was deleted"
        );
        assert!(
            inside.join("moved.txt").exists(),
            "the payload left the root"
        );
    }

    // ── create_dir ──
    //
    // Against a real kernel, because every claim here is one a mock cannot make: the mode survives
    // the umask, `fchown` actually moves the directory, `mkdirat` actually returns EEXIST, and
    // NO_SYMLINKS actually refuses a symlinked parent.

    fn mode_of(path: &std::path::Path) -> u32 {
        let meta = std::fs::metadata(path).expect("stat");
        std::os::unix::fs::PermissionsExt::mode(&meta.permissions()) & 0o7777
    }

    #[test]
    fn a_created_directory_is_0750_whatever_the_umask_says() {
        // The umask is the reason `fchmod` follows the `mkdirat`. A daemon started under umask 077
        // would otherwise get 0700 — no group triad for an ACL to grant through (ADR-0004 puts the
        // grants on the group) — and one under 002 would get 0752, which is a share directory
        // every tenant on the box can list. Neither is a decision anyone made.
        //
        // The umask is process-wide, so this test sets it and puts it back. Nothing here runs in
        // parallel with another umask-sensitive test.
        let tmp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(tmp.path().join("share")).expect("mkdir share");
        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");

        let me = rustix::process::getuid().as_raw();
        let my_group = rustix::process::getgid().as_raw();

        let saved = rustix::process::umask(rustix::fs::Mode::from_raw_mode(0o077));
        sp.create_dir(&["share"], "narrow", me, my_group)
            .expect("create under a hostile umask");
        rustix::process::umask(rustix::fs::Mode::from_raw_mode(0o002));
        sp.create_dir(&["share"], "wide", me, my_group)
            .expect("create under a permissive umask");
        rustix::process::umask(saved);

        assert_eq!(
            mode_of(&tmp.path().join("share").join("narrow")),
            0o750,
            "umask 077 narrowed the group triad an ACL has to grant through"
        );
        assert_eq!(
            mode_of(&tmp.path().join("share").join("wide")),
            0o750,
            "umask 002 left the share directory readable by every tenant on the box"
        );
    }

    #[test]
    fn a_created_directory_changes_hands_to_the_uid_and_gid_it_was_given() {
        // Two assertions in one, because only one of them can run without CAP_CHOWN — the same
        // shape as `set_owner_aims_at_the_descriptor_and_not_at_a_path` above.
        //
        // Always: creating with the CURRENT owner exercises the `fchown` call itself, so an
        // implementation that never wired it up would fail here.
        //
        // Only as root: the ownership actually changes. SKIPPED otherwise, loudly, rather than
        // asserted loosely — a test that passed by expecting EPERM would also pass if the
        // implementation did nothing at all.
        let tmp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(tmp.path().join("share")).expect("mkdir share");
        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");

        let me = rustix::process::getuid().as_raw();
        let my_group = rustix::process::getgid().as_raw();
        sp.create_dir(&["share"], "mine", me, my_group)
            .expect("chowning to the existing owner is always permitted");

        if me != 0 {
            eprintln!(
                "SKIPPED: the ownership half of this test needs CAP_CHOWN and this process is \
                 uid {me}. The 0750 mode and the EEXIST refusal above are still measured; that a \
                 directory actually changes hands is only proved when the suite runs as root."
            );
            return;
        }

        sp.create_dir(&["share"], "theirs", 1001, 2001)
            .expect("create as root");
        let meta = std::fs::metadata(tmp.path().join("share").join("theirs")).expect("stat");
        assert_eq!(
            (
                std::os::unix::fs::MetadataExt::uid(&meta),
                std::os::unix::fs::MetadataExt::gid(&meta)
            ),
            (1001, 2001),
            "the directory stayed with the service account"
        );
        assert_eq!(
            mode_of(&tmp.path().join("share").join("theirs")),
            0o750,
            "chown must not have cleared bits the mode was meant to carry"
        );
    }

    #[test]
    fn creating_a_directory_that_is_already_there_is_refused_and_distinguishable() {
        // EEXIST must arrive as `AlreadyExists`, not as `Io`. The caller answers 409 for this and
        // 404 for a missing parent, and telling them apart by matching on a message string is a
        // contract nobody declared.
        let tmp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(tmp.path().join("share")).expect("mkdir share");
        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");
        let me = rustix::process::getuid().as_raw();
        let my_group = rustix::process::getgid().as_raw();

        sp.create_dir(&["share"], "docs", me, my_group)
            .expect("create");
        assert!(
            matches!(
                sp.create_dir(&["share"], "docs", me, my_group),
                Err(SeamError::AlreadyExists(_))
            ),
            "a second create reported success, so two rows now describe one directory"
        );

        // A FILE holding the name is the same refusal. `mkdirat` returns EEXIST for it and the
        // file must be untouched.
        std::fs::write(tmp.path().join("share").join("notes.txt"), b"mine").expect("write");
        assert!(matches!(
            sp.create_dir(&["share"], "notes.txt", me, my_group),
            Err(SeamError::AlreadyExists(_))
        ));
        assert_eq!(
            std::fs::read(tmp.path().join("share").join("notes.txt")).expect("read"),
            b"mine"
        );
    }

    #[test]
    fn a_missing_parent_is_not_found_and_no_intermediate_is_created() {
        // `NotFound`, not `PathEscape`: a folder that is not there is an ordinary 404, and
        // reporting it as a containment violation is the false diagnosis `classify_openat2` exists
        // to prevent. And there is no `mkdir -p` — every node is one call and one database row.
        let tmp = tempfile::tempdir().expect("tempdir");
        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");
        let me = rustix::process::getuid().as_raw();
        let my_group = rustix::process::getgid().as_raw();

        assert!(
            matches!(
                sp.create_dir(&["nope"], "deep", me, my_group),
                Err(SeamError::NotFound(_))
            ),
            "a missing parent must be distinguishable from a taken name"
        );
        assert!(
            !tmp.path().join("nope").exists(),
            "the intermediate directory was created for the caller"
        );
    }

    #[test]
    fn a_directory_cannot_be_created_outside_the_root_through_a_symlink_or_a_dotdot() {
        // The attack: a user drops a symlink inside their own share pointing at a directory
        // outside it, then asks the agent — running as root — to create a folder in it. Every
        // component of the parent is resolved by `openat2` with NO_SYMLINKS, which refuses the
        // component before the kernel ever asks where it points.
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().join("share");
        let outside = tmp.path().join("outside");
        std::fs::create_dir(&root).expect("mkdir share");
        std::fs::create_dir(&outside).expect("mkdir outside");
        std::os::unix::fs::symlink(&outside, root.join("escape")).expect("symlink");

        let sp = Openat2SafePath::open_root(&root).expect("open root");
        let me = rustix::process::getuid().as_raw();
        let my_group = rustix::process::getgid().as_raw();

        // An ordinary create inside the root still works, so a blanket failure cannot make this
        // test pass for the wrong reason.
        sp.create_dir(&["."], "docs", me, my_group)
            .expect("an ordinary create inside the root must still work");

        assert!(
            sp.create_dir(&["escape"], "planted", me, my_group).is_err(),
            "a directory was created outside the root through a symlinked parent"
        );
        assert!(
            !outside.join("planted").exists(),
            "the escape succeeded even though the call reported an error"
        );

        // `..` is unrepresentable in `SafeComponent`, so this can only be reached by a bug that
        // bypasses the type — belt and braces, because the two defences fail for different
        // reasons.
        assert!(
            sp.create_dir(&[".."], "planted", me, my_group).is_err(),
            "RESOLVE_BENEATH must refuse .. — it escaped instead"
        );
        assert!(!tmp.path().join("planted").exists());
    }

    #[test]
    fn a_created_directory_is_usable_immediately_by_the_operations_that_follow_it() {
        // The point of the whole operation. A folder that exists only as a row is one a publish
        // cannot land in and a move cannot enter, which is how folder support was broken end to
        // end. This is the integration claim in one place: create, then move a file into it.
        let tmp = tempfile::tempdir().expect("tempdir");
        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");
        let me = rustix::process::getuid().as_raw();
        let my_group = rustix::process::getgid().as_raw();

        std::fs::create_dir(tmp.path().join("share")).expect("mkdir share");
        std::fs::write(tmp.path().join("share").join("a.txt"), b"keep me").expect("write");
        sp.create_dir(&["share"], "archive", me, my_group)
            .expect("create");
        sp.publish(&["share"], "a.txt", &["share", "archive"], "a.txt")
            .expect("a move into the new directory must work");

        assert_eq!(
            std::fs::read(tmp.path().join("share").join("archive").join("a.txt")).expect("read"),
            b"keep me"
        );
    }

    /// NO_XDEV, against a real mount boundary.
    ///
    /// Ignored by default because a tempdir on ext4 has no mount boundary to cross, so the test
    /// would pass without demonstrating anything. P0-E creates a nested ZFS dataset — which on
    /// ZFS is a separate mount, not merely a subdirectory — and runs this with the two paths in
    /// the environment. That distinction is the whole reason NO_XDEV is in the flag set: on a
    /// box where every share is a dataset, a nested dataset's mountpoint is a way out of the
    /// share the caller was confined to, and BENEATH alone does not stop it.
    #[test]
    #[ignore = "needs a real nested mount; P0-E supplies DEPSIS_XDEV_ROOT and DEPSIS_XDEV_CHILD"]
    fn no_xdev_refuses_crossing_into_a_nested_mount() {
        let root = std::env::var("DEPSIS_XDEV_ROOT").expect("DEPSIS_XDEV_ROOT");
        let child = std::env::var("DEPSIS_XDEV_CHILD").expect("DEPSIS_XDEV_CHILD");

        let sp = Openat2SafePath::open_root(&root).expect("open root");

        // A plain subdirectory of the same mount still resolves — otherwise this test would pass
        // for the wrong reason on any filesystem.
        std::fs::create_dir_all(format!("{root}/plain")).expect("mkdir");
        assert!(
            sp.open_dir(&["plain"]).is_ok(),
            "a same-mount subdirectory must still resolve"
        );

        match sp.open_dir(&[&child]) {
            Err(SeamError::PathEscape(_)) => {}
            Err(other) => panic!("expected PathEscape crossing into {child}, got {other:?}"),
            Ok(_) => panic!("NO_XDEV did not stop the crossing: the nested mount opened"),
        }
    }

    // ── the snapshot walk, against a real mount boundary ──
    //
    // These are the tests the limitations document said had to exist before this seam was written:
    // "körlemesine yazılmış bir kapı, açık olduğunu sanılan bir kapı" — a door written blind is a
    // door only believed to be shut.
    //
    // There is no ZFS on any machine this suite runs on, so the snapshot is a `mount --bind` at
    // `<share>/.zfs/snapshot/<name>`. That substitution is honest for exactly the property under
    // test: `RESOLVE_NO_XDEV` compares MOUNTS, not filesystem types, so a bind mount crosses a
    // boundary in precisely the way a ZFS snapshot does.
    //
    // WHAT REMAINS UNMEASURED, stated plainly rather than left to be assumed: ZFS materialises a
    // snapshot mount on first access, and whether that automount triggers under `openat2` is not
    // something a bind mount can answer. If it does not, `snapshot_dir` fails with `NotFound` —
    // loudly, at the operation, naming the snapshot — rather than returning an empty listing.

    /// Make a bind mount, or say why not.
    ///
    /// Returns `false` when the process cannot mount, which is the normal case for an unprivileged
    /// CI runner. Set `DEPSIS_REQUIRE_MOUNT_TESTS=1` to turn that skip into a failure — the WSL
    /// runner does, so the crossing is measured somewhere on every change rather than nowhere.
    #[cfg(target_os = "linux")]
    fn bind_mount(source: &std::path::Path, target: &std::path::Path) -> bool {
        let status = std::process::Command::new("mount")
            .arg("--bind")
            .arg(source)
            .arg(target)
            .status();
        let mounted = matches!(status, Ok(s) if s.success());
        if !mounted && std::env::var("DEPSIS_REQUIRE_MOUNT_TESTS").as_deref() == Ok("1") {
            panic!("DEPSIS_REQUIRE_MOUNT_TESTS=1 but `mount --bind` failed: {status:?}");
        }
        if !mounted {
            eprintln!(
                "SKIPPING the snapshot crossing test: `mount --bind` failed ({status:?}). \
                 This test is the only measurement of the one place the agent crosses a mount \
                 boundary; run it as root, or set DEPSIS_REQUIRE_MOUNT_TESTS=1 to make the skip \
                 a failure."
            );
        }
        mounted
    }

    /// Take the mount back down, and do not leave one behind if the polite form fails.
    ///
    /// The lazy fallback is not tidiness. A `umount` that reports "target is busy" leaves a real
    /// mount inside a temporary directory that is about to be deleted, and the next run of this
    /// suite finds it still there — so the test that measures a mount boundary starts depending on
    /// which mounts a previous run happened to leak. `-l` detaches it from the tree immediately
    /// and lets the kernel finish when the last reference goes.
    #[cfg(target_os = "linux")]
    fn unmount(target: &std::path::Path) {
        let polite = std::process::Command::new("umount").arg(target).status();
        if matches!(polite, Ok(status) if status.success()) {
            return;
        }
        let _ = std::process::Command::new("umount")
            .arg("-l")
            .arg(target)
            .status();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_snapshot_is_readable_through_the_one_permitted_crossing() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();

        // The live share, and a directory standing in for the snapshot's contents.
        std::fs::create_dir_all(root.join("share/.zfs/snapshot/daily-1")).expect("mkdir control");
        let backing = root.join("backing");
        std::fs::create_dir_all(backing.join("belgeler")).expect("mkdir backing");
        std::fs::write(backing.join("belgeler/rapor.txt"), b"the old copy").expect("write");

        let target = root.join("share/.zfs/snapshot/daily-1");
        if !bind_mount(&backing, &target) {
            return;
        }

        let sp = Openat2SafePath::open_root(root).expect("open root");

        // The ordinary resolution REFUSES the same directory, which is what makes the rest of this
        // test mean something: without the refusal, the crossing method would be proving nothing
        // that `open_dir` could not already do.
        match sp.open_dir(&["share", ".zfs", "snapshot", "daily-1"]) {
            Err(SeamError::PathEscape(_)) => {}
            other => {
                unmount(&target);
                panic!("NO_XDEV should have refused the snapshot mount, got {other:?}");
            }
        }

        let listed = sp.list_snapshot_entries("share", "daily-1", &[]);
        let nested = sp.list_snapshot_entries("share", "daily-1", &["belgeler"]);
        let opened = sp.open_snapshot("share", "daily-1", &["belgeler", "rapor.txt"]);
        let empty = sp.open_snapshot("share", "daily-1", &[]);
        let escape = sp.open_snapshot("share", "daily-1", &["..", "..", "..", "etc"]);
        unmount(&target);

        let listed = listed.expect("the snapshot root must list");
        assert_eq!(
            listed.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            vec!["belgeler"]
        );

        let nested = nested.expect("a directory inside the snapshot must list");
        assert_eq!(nested.len(), 1);
        let entry = nested.first().expect("one entry");
        assert_eq!(entry.name, "rapor.txt");
        assert_eq!(entry.size, 12);

        let mut buffer = String::new();
        std::io::Read::read_to_string(&mut opened.expect("the file must open"), &mut buffer)
            .expect("read");
        assert_eq!(buffer, "the old copy");

        // An empty path is a refusal and not the snapshot's own directory: answering with a
        // directory would be a silent substitution the caller then streams bytes from.
        assert!(
            matches!(empty, Err(SeamError::NotFound(_))),
            "an empty path inside a snapshot must be refused, got {empty:?}"
        );

        // And BENEATH still holds INSIDE the snapshot. This is the half that would be easy to lose:
        // the crossing step drops NO_XDEV, and dropping the rest of the flag set with it would be
        // a single-line mistake that opens the whole filesystem to a read-only browser.
        assert!(
            matches!(escape, Err(SeamError::PathEscape(_))),
            "traversal out of a snapshot must be refused, got {escape:?}"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_crossing_is_permitted_at_exactly_one_component() {
        // The flag set is dropped for the snapshot's own name and NOWHERE ELSE. Measured by
        // putting a second mount one level deeper, where a ZFS box would have a nested dataset,
        // and requiring it to be refused.
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();

        std::fs::create_dir_all(root.join("share/.zfs/snapshot/daily-1")).expect("mkdir");
        let outer = root.join("outer");
        std::fs::create_dir_all(outer.join("nested")).expect("mkdir outer");
        let inner = root.join("inner");
        std::fs::create_dir_all(&inner).expect("mkdir inner");
        std::fs::write(inner.join("secret.txt"), b"another dataset").expect("write");

        let snap = root.join("share/.zfs/snapshot/daily-1");
        if !bind_mount(&outer, &snap) {
            return;
        }
        let deeper = snap.join("nested");
        if !bind_mount(&inner, &deeper) {
            unmount(&snap);
            return;
        }

        let sp = Openat2SafePath::open_root(root).expect("open root");
        let deeper_listing = sp.list_snapshot_entries("share", "daily-1", &["nested"]);
        let deeper_file = sp.open_snapshot("share", "daily-1", &["nested", "secret.txt"]);
        unmount(&deeper);
        unmount(&snap);

        assert!(
            matches!(deeper_listing, Err(SeamError::PathEscape(_))),
            "a second mount inside the snapshot must be refused, got {deeper_listing:?}"
        );
        assert!(
            matches!(deeper_file, Err(SeamError::PathEscape(_))),
            "a file behind a second mount must be refused, got {deeper_file:?}"
        );
    }

    #[test]
    fn a_snapshot_that_is_not_there_is_not_found_rather_than_empty() {
        // The failure mode this guards against is the one the limitations document called a door
        // believed to be shut: if the control directory or the snapshot cannot be opened, the
        // answer must be an error naming it, not an empty listing that reads as "this snapshot
        // holds nothing" — which is what a user would act on by concluding their file is gone.
        let tmp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(tmp.path().join("share")).expect("mkdir");
        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");

        assert!(matches!(
            sp.list_snapshot_entries("share", "daily-1", &[]),
            Err(SeamError::NotFound(_))
        ));
        assert!(matches!(
            sp.open_snapshot("share", "daily-1", &["a.txt"]),
            Err(SeamError::NotFound(_))
        ));
    }

    #[test]
    fn refusal_is_an_error_not_a_silent_clamp() {
        // Why ADR-0006 chose BENEATH over IN_ROOT. IN_ROOT resolves `../../etc` to the root and
        // succeeds, so a traversal attempt looks like an ordinary read and never reaches the
        // audit trail. This pins the loud behaviour.
        let tmp = tempfile::tempdir().expect("tempdir");
        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");

        match sp.open_dir(&["..", "..", "etc"]) {
            Err(SeamError::PathEscape(_)) => {}
            Err(other) => panic!("expected PathEscape, got {other:?}"),
            Ok(_) => panic!("traversal silently succeeded: /etc opened from inside the root"),
        }
    }

    // ── serve_one over a real socket ──
    //
    // These drive the actual read path rather than `split_envelope` in isolation, because the
    // bug they pin lived between the two: the framing, not the parsing. A socketpair is a real
    // AF_UNIX stream socket, so SO_PEERCRED works and `shutdown` behaves as it does in
    // production — which is precisely what the in-memory mock transport cannot reproduce.

    /// The collaborators the framing tests need, owned by the caller so the borrows outlive the
    /// `Agent`. None of these tests exercise transfers — they are about the read path — so the
    /// share root is absent and the registry stays empty.
    #[derive(Default)]
    struct ServeFixtures {
        transfers: Mutex<TransferRegistry>,
        tokens: MockTokenSource,
    }

    fn serving_agent<'a>(
        runner: &'a MockCommandRunner,
        sink: &'a MemorySink,
        fixtures: &'a ServeFixtures,
    ) -> Agent<'a, MockCommandRunner, MemorySink, MockSafePath> {
        // The tests below connect to themselves, so the peer uid is this process's uid. Telling
        // the policy that this uid is the API is what lets the request through to the framing
        // code, which is what is under test here.
        Agent::new(
            Policy {
                api_uid: rustix::process::getuid().as_raw(),
            },
            runner,
            sink,
            None,
            None,
            &fixtures.tokens,
            &fixtures.transfers,
            write_private,
        )
    }

    /// Run `serve_one` against one side of a socketpair while `payload` is written to the other,
    /// and return the response line.
    fn round_trip(payload: &[u8], shutdown_write: bool) -> String {
        let (client, server) = socket_pair();
        let payload = payload.to_vec();

        let writer = std::thread::spawn(move || {
            let mut c = client;
            c.write_all(&payload).expect("write payload");
            if shutdown_write {
                c.shutdown(std::net::Shutdown::Write).expect("shutdown");
            }
            let mut out = String::new();
            let _ = c.read_to_string(&mut out);
            out
        });

        let runner = MockCommandRunner::default();
        let sink = MemorySink::default();
        let fixtures = ServeFixtures::default();
        let agent = serving_agent(&runner, &sink, &fixtures);
        serve_one(&server, &agent).expect("serve_one");
        drop(server);

        writer.join().expect("writer thread")
    }

    #[test]
    fn a_request_without_a_trailing_newline_is_answered_not_called_oversized() {
        // The regression. A client that sends a complete request and shuts down its write side
        // is behaving correctly; answering it with "request exceeds 262144 bytes" is both wrong
        // and actively misleading to whoever has to debug it.
        let out = round_trip(
            br#"{"correlation_id":"t1","reason":"no newline","request":{"op":"ping"}}"#,
            true,
        );
        assert!(out.contains(r#""status":"ok""#), "expected ok, got: {out}");
        assert!(
            !out.contains("exceeds"),
            "a complete request was reported as oversized: {out}"
        );
    }

    #[test]
    fn a_request_with_a_trailing_newline_is_answered_too() {
        let out = round_trip(
            b"{\"correlation_id\":\"t2\",\"reason\":\"newline\",\"request\":{\"op\":\"ping\"}}\n",
            false,
        );
        assert!(out.contains(r#""status":"ok""#), "got: {out}");
    }

    #[test]
    fn a_dribbling_client_is_cut_off_by_the_deadline() {
        // The regression: `set_read_timeout` arms SO_RCVTIMEO, which bounds ONE recv(2), not a
        // connection. A peer that sends a byte just under the timeout re-arms the window forever,
        // and because the agent serves one connection at a time that wedges the whole daemon.
        //
        // The writer end is held open for the duration, so `read` cannot see EOF — only the
        // deadline can end this. With the per-syscall behaviour the call would never return.
        let (client, server) = socket_pair();
        let mut c = client;
        c.write_all(b"{\"correlation_id\":\"d\"")
            .expect("partial write");

        let budget = Duration::from_millis(250);
        let started = Instant::now();
        let result = read_request_line_within(&server, budget);
        let elapsed = started.elapsed();

        match result {
            Err(SeamError::Io(msg)) => assert!(
                msg.contains("not complete"),
                "expected a deadline error, got: {msg}"
            ),
            Ok(partial) => panic!("a partial request was accepted as complete: {partial:?}"),
            Err(other) => panic!("unexpected error kind: {other:?}"),
        }
        assert!(
            elapsed < budget * 8,
            "the read ran for {elapsed:?}, far past its {budget:?} budget"
        );

        drop(c);
    }

    #[test]
    fn a_complete_request_still_arrives_well_inside_the_budget() {
        // The other half: bounding the read must not have broken the normal path.
        let (client, server) = socket_pair();
        let mut c = client;
        c.write_all(
            b"{\"correlation_id\":\"ok\",\"reason\":\"r\",\"request\":{\"op\":\"ping\"}}\n",
        )
        .expect("write");

        let line = read_request_line_within(&server, Duration::from_secs(5)).expect("read");
        assert!(line.contains("\"op\":\"ping\""), "got: {line}");
        drop(c);
    }

    #[test]
    fn a_request_at_the_size_cap_is_still_refused() {
        // The check the regression fix must not have removed.
        let mut payload =
            br#"{"correlation_id":"t3","reason":"big","request":{"op":"ping","pad":""#.to_vec();
        payload.resize(MAX_REQUEST_BYTES as usize + 64, b'x');
        let out = round_trip(&payload, true);
        assert!(
            out.contains("exceeds"),
            "oversized request not refused: {out}"
        );
    }
}
