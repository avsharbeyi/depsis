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
    /// The path resolved cleanly and nothing is there.
    ///
    /// Its own variant because the alternative was measured to be actively misleading: every
    /// `openat2` errno used to become `PathEscape`, so a download of a file that simply is not
    /// there reported "path escapes the share root" — a containment violation, which is what a
    /// caller trying to break out looks like. The same collapse hid an ENOSYS for a whole
    /// bisection (ADR-0017).
    #[error("no such file: {0}")]
    NotFound(String),
    /// A component of the path is a regular file where a directory was required.
    ///
    /// Its own variant for the same reason `NotFound` got one, and after the same mistake. Every
    /// errno `openat2` returned other than ENOENT/ENOSYS used to collapse into `PathEscape`, so
    /// opening `alice/notes.txt` as a directory reported "path escapes the share root" — a
    /// containment violation, which is what a caller trying to break out looks like, for a caller
    /// who merely had a file in the way. ADR-0017 was written about that class of misdiagnosis
    /// after P1-D lost a bisection to it.
    ///
    /// `PathEscape` is now reserved for the errnos `openat2` actually uses to refuse containment.
    #[error("not a directory: {0}")]
    NotADirectory(String),
    /// `RENAME_NOREPLACE` refused rather than overwrote.
    ///
    /// Its own variant for the same reason `NotFound` is: the caller has to tell "your file is not
    /// there" from "the name you asked for is taken", because those are a 404 and a 409 and the
    /// user does something different about each. Before this, both arrived as `Io` and the only
    /// way to separate them was to match on the message text — which is a contract nobody declared
    /// and the next person to reword an error would have broken silently.
    #[error("already exists: {0}")]
    AlreadyExists(String),
    /// A directory removal found children.
    ///
    /// Not a failure of the agent. The agent removes ONE entry and never a tree (see
    /// `SafePath::remove_dir`), so this is the ordinary answer when the caller has not finished
    /// walking, and the caller can act on it.
    #[error("directory is not empty: {0}")]
    NotEmpty(String),
    #[error("io: {0}")]
    Io(String),
    #[error("command {program} failed with status {status}: {stderr}")]
    Command {
        program: String,
        status: i32,
        stderr: String,
    },
}

/// One thing in a directory, as the kernel reports it.
///
/// `size` is zero for a directory, matching `file_entries_folder_has_no_size` — the database
/// constraint and the filesystem answer have to agree or every reconciliation would report a
/// difference that is not one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirEntryInfo {
    pub name: String,
    pub directory: bool,
    pub size: u64,
    /// Seconds since the epoch. Used to fill `updated_at` for a row DEPSIS is learning about.
    pub modified_unix: i64,
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

    /// A name for an ALREADY-RESOLVED directory that an external program can be given.
    ///
    /// The escape hatch for the one thing a descriptor cannot do: `setfacl` is a separate process,
    /// so it cannot inherit our `openat2` result the way `renameat2` and `fchown` do. Handing it a
    /// re-joined path would resolve every component a second time with an ORDINARY resolution —
    /// none of the `RESOLVE_` flags, no root fd — which turns the confinement into a check and
    /// re-introduces exactly the TOCTOU shape the note on this trait describes. It is not
    /// theoretical: `setfacl 2.3.2` dereferences a symlink passed as an argument (there is no `-P`
    /// in our argv, and `-P` cannot be added — see below), so an attacker with create rights in the
    /// share tree who swaps the named directory for a symlink between our resolve and the exec gets
    /// a root-owned process writing a group grant onto a directory of their choosing.
    ///
    /// The real implementation answers `/proc/self/fd/N`. That is the same INODE the kernel already
    /// confined — the descriptor pins it, so the name cannot be pointed anywhere else no matter
    /// what happens to the directory entries above it. Every path component is re-resolved by the
    /// kernel's procfs, not by walking the share tree.
    ///
    /// Two measured facts about `setfacl` shape this seam and are worth stating where the next
    /// person will read them:
    ///
    ///   - `-P` must NOT be combined with this. `/proc/self/fd/N` is itself a magic symlink, and
    ///     `setfacl -P` skips symlink arguments — it exits 0 and applies nothing, which is the one
    ///     failure mode worse than an error.
    ///   - `-R` does not work through it either. `setfacl -R /proc/self/fd/N` applies to the
    ///     directory and does not descend, because the tree walk refuses to recurse into a symlink.
    ///     That is a reason the ACL operation is single-folder and not a reason to go back to a
    ///     joined path; see `op::Request::ApplyFolderAcl`.
    ///
    /// Returning a `String` rather than the raw descriptor number keeps the core free of `cfg`:
    /// `AsRawFd` does not exist on Windows, and CI cross-checks this crate against that target.
    fn command_path(&self, dir: &std::fs::File) -> Result<String, SeamError>;

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
    ///
    /// TWO callers, not one, and the second is why the error variants below are typed.
    /// `PublishTransfer` moves a staged upload into place; `MoveEntry` moves a file the user
    /// already owns. They are the same syscall pair — `renameat2(RENAME_NOREPLACE)` followed by an
    /// `fsync` of the destination directory — and giving the second one its own seam method would
    /// have meant two implementations of the step people skip. Implementations must report a
    /// missing source as `NotFound` and a taken destination as `AlreadyExists`.
    fn publish(
        &self,
        from_dir: &[&str],
        from: &str,
        to_dir: &[&str],
        to: &str,
    ) -> Result<(), SeamError>;

    /// Create ONE directory under `dir`, give it to `uid`/`gid`, and make the entry durable.
    ///
    /// One method rather than a `mkdir` the caller then has to remember to chown and fsync, for the
    /// same reason `publish` bundles its directory fsync: the steps people skip are the last ones,
    /// and the failures they cause are invisible until something else goes wrong. A directory left
    /// root-owned is a folder the tenant cannot enter; a directory entry left unsynced is a folder
    /// that disappears after a power cut, along with any file published into it.
    ///
    /// Must create exactly one node. No `mkdir -p` — a missing intermediate component is
    /// `SeamError::NotFound`, which the caller turns into a 404 rather than papering over.
    ///
    /// Must REFUSE a name that is already taken (`SeamError::AlreadyExists`) rather than returning
    /// success. `mkdir` is idempotent-looking and this operation must not be: the API writes one
    /// row per call, so a silent success on an existing directory is how two rows come to describe
    /// one directory on disk.
    ///
    /// `uid` and `gid` are numeric and no identity database is consulted. `fchown` takes numbers;
    /// creating a `/etc/passwd` entry is a separate decision about the appliance's identity store,
    /// and the visible cost of not making it is that `ls -l` prints numbers instead of names.
    fn create_dir(&self, dir: &[&str], name: &str, uid: u32, gid: u32) -> Result<(), SeamError>;

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
    /// Bir dizinin sahibinin uid'i.
    ///
    /// SEAM'DE, çünkü `dispatch` platformdan bağımsız kalmak zorunda (ADR-0006) ve `MetadataExt`
    /// Unix'e ait. İlk hâli `prepare_app_data_dir` içinde doğrudan `std::os::unix`'i çağırıyordu;
    /// Windows çapraz denetimi onu yakaladı — `identity.rs`'in aynı ihlalini yakaladığı gibi.
    /// Sahiplik testi burada yapılamaz: çağıran onu bir REDDE çeviriyor, ve reddin gerekçesi
    /// (uid) cümlenin içinde geçiyor.
    fn owner_of(&self, relative: &[&str]) -> Result<u32, SeamError>;

    fn set_owner(&self, file: &std::fs::File, uid: u32, gid: u32) -> Result<(), SeamError>;

    /// Set the mode of an already-open directory.
    ///
    /// Takes the FILE for the reason `set_owner` does: a path would be re-resolved, and a chmod
    /// aimed at a path can be pointed elsewhere between the resolution and the call.
    ///
    /// It exists for exactly one thing — the share root. `zfs create` leaves a dataset's mountpoint
    /// at ZFS's default 0755 root:root, and `ApplyFolderAcl` will not fix it: that operation
    /// deliberately never touches the user::/group::/other:: triple and refuses outright if it
    /// changes underneath. So a share root has always been world-traversable, and every principal
    /// SMB authenticates could enumerate its top-level names however narrow the grants were.
    ///
    /// ORDER MATTERS AT THE CALL SITE and it is a POSIX property, not a local one: `chmod` on a
    /// file that already carries an ACL sets the MASK from the group bits rather than the
    /// `group::` entry. Running this after an ACL has been written would silently narrow every
    /// named entry to the mask. It must therefore run BEFORE the ACL that follows it, which
    /// recomputes the mask correctly — narrowing in the gap, which is the safe direction.
    fn set_mode(&self, file: &std::fs::File, mode: u32) -> Result<(), SeamError>;

    /// The names of the SHARE DIRECTORIES — everything that is a directory in the shares root.
    ///
    /// Symlinks are NOT followed and do not appear: a symlink in the share root pointing at `/`
    /// would otherwise turn the sweeper below into a recursive delete of the whole filesystem,
    /// which is the single worst thing a root daemon can be talked into.
    ///
    /// ── NEDEN OPERANDSIZ ─────────────────────────────────────────────────────────────────
    ///
    /// Bunun eski hâli `list_dirs(relative: &[&str])` idi ve TEK çağıranı `&[]` geçiyordu — yani
    /// operand hiçbir zaman bir şey seçmiyor, yalnızca yanlış yazılabiliyordu. Ve yanlış yazıldı:
    /// gerçek mühür boş bileşen listesini `Io("empty path")` ile reddediyor (ilk bileşen
    /// PAYLAŞIMIN ADI, çünkü her paylaşım kendi veri kümesi), sahte mühür ise geçici kökün
    /// kendisini listeleyip başarıyla dönüyordu. Süpürücünün dört testi de yeşildi ve süpürücü
    /// gerçek bir cihazda İLK SATIRINDA, her turda düşüyordu.
    ///
    /// Aynı hata `share_root_status` ve `prepare_share_root`'ta da vardı ve `root_is_empty` ile
    /// düzeltildi. Bu metot onun kardeşi: soruyu operandsız sorduğu için yanlış sorulamıyor.
    fn list_share_dirs(&self) -> Result<Vec<String>, SeamError>;

    /// Everything directly under `relative`: name, kind and size.
    ///
    /// The primitive the indexer needs and the two above cannot serve. `list_dirs` drops files and
    /// `list_stale_files` drops directories and sizes, and a reconciliation has to see both kinds
    /// together — a name that is a file in the database and a directory on disk is exactly the
    /// divergence it exists to find.
    ///
    /// SYMLINKS ARE DROPPED, as they are for `list_dirs` and for the same reason: the stat is an
    /// `fstatat` with `SYMLINK_NOFOLLOW`, so a link pointing out of the share is neither followed
    /// nor reported. An indexer that recorded one would put a row in `file_entries` naming
    /// something the agent will refuse to open, and the user would see a file that cannot be
    /// downloaded, moved or deleted.
    ///
    /// Anything that is neither a regular file nor a directory — a socket, a fifo, a device node
    /// somebody dropped in over SSH — is dropped too. DEPSIS has no representation for them and a
    /// row that claimed otherwise would be a lie the interface then has to act on.
    fn list_entries(&self, relative: &[&str]) -> Result<Vec<DirEntryInfo>, SeamError>;

    /// Is the shares ROOT ITSELF empty — the directory every share is created under.
    ///
    /// ── NEDEN AYRI BİR METOT, `list_entries(&[])` DEĞİL ──────────────────────────────────
    ///
    /// Çağıran taraf tam olarak bunu istiyordu ve boş bir bileşen listesiyle sordu. Sahte mühür
    /// buna geçici kökü listeleyerek cevap verdi; gerçek mühür ise `openat2`'yi ilk bileşen
    /// PAYLAŞIMIN ADI olacak şekilde kuruyor ve boş listeyi `Io("empty path")` ile reddediyor.
    /// İki taraf da kendi içinde tutarlıydı, ve aradaki fark bir sürüm boyunca sahada durdu:
    /// birim testleri yeşil, gerçek cihaz depolamayı hiç kuramıyor.
    ///
    /// Boş listeyi gerçek mühürde de kabul etmek, düzeltmenin YANLIŞ biçimi olurdu. `open_dir`
    /// yalnız listelemek için değil; `remove_file`, `remove_dir` ve `create_dir` de ebeveyn
    /// dizini onunla açıyor. Boş listenin oraya kadar "kök" diye ulaşması, kök yetkiyle koşan bir
    /// süreçte paylaşım kökünün kendisini silme yoluna bir kapı açmak demekti — bugün dispatch
    /// katmanı bunu ayrıca reddediyor, ama iki savunmadan birini gerekmeden kaldırmak için sebep
    /// yok.
    ///
    /// Bu metot bunun yerine SORUNUN KENDİSİNİ soruyor. Bir tanıtıcı dışarı vermiyor, tek bir
    /// `bool` dönüyor, ve yanlış kullanılabileceği bir biçimi yok.
    ///
    /// Hata YUTULMUYOR — dönen tip `Result`. Önceki hâli `.unwrap_or(false)` ile "boş değil"e
    /// çeviriyordu, ve "soramadım" ile "dolu" aynı cevaba indiğinde sihirbaz onay kutusunu
    /// sonsuza kadar gizliyordu: kullanıcının gördüğü şey, sebebi hiçbir yerde yazmayan bir
    /// eksiklik oldu.
    fn root_is_empty(&self) -> Result<bool, SeamError>;

    /// Everything directly under `relative` INSIDE one snapshot of one share.
    ///
    /// This is the method that made per-file restore possible, and it is the only place in this
    /// trait that is allowed to cross a mount boundary — so the argument for it belongs here,
    /// where the next person will read it before implementing another one.
    ///
    /// WHY A CROSSING IS NEEDED AT ALL. On ZFS a snapshot appears under `<dataset>/.zfs/snapshot/
    /// <name>/` as a SEPARATE MOUNT, materialised by the kernel module on first access. Every
    /// other resolution in this file runs with `RESOLVE_NO_XDEV`, which refuses exactly that —
    /// and it has to, because on a box where every share is a dataset, a nested dataset's
    /// mountpoint is otherwise a way out of the share the caller was confined to.
    ///
    /// HOW IT STAYS CLOSED ANYWAY. The walk is four steps and only the third-to-fourth crosses:
    ///
    ///   1. `<share>` — resolved from the root fd with the FULL flag set. Same mount as always.
    ///   2. `.zfs` and `snapshot` — still the share's own mount; ZFS's control directory is not a
    ///      mount of its own. Still the full flag set, so a share that somehow contained a real
    ///      symlink or a nested dataset called `.zfs` is refused here.
    ///   3. `<snapshot>` — ONE component, resolved with `NO_XDEV` dropped and `BENEATH`,
    ///      `NO_SYMLINKS` and `NO_MAGICLINKS` still on. This is the crossing, and it can only land
    ///      in a mount that ZFS itself created under that directory.
    ///   4. `relative` — resolved from the snapshot's root with the FULL flag set again. A nested
    ///      dataset is NOT part of its parent's snapshot, so there is nothing further to cross
    ///      into, and if there were, this step refuses it.
    ///
    /// WHAT IS STILL TRUSTED. That only root can create a mount, and that the only thing mounting
    /// anything under `<share>/.zfs/snapshot/` is ZFS. An attacker who can already mount over that
    /// directory is root on the appliance and has no need of this method.
    ///
    /// READ-ONLY BY CONSTRUCTION. There is no snapshot-rooted write method and there must not be:
    /// a ZFS snapshot is immutable, so a write path could only ever fail, and restoring a file
    /// means READING it here and writing through the ordinary confined path.
    fn list_snapshot_entries(
        &self,
        share: &str,
        snapshot: &str,
        relative: &[&str],
    ) -> Result<Vec<DirEntryInfo>, SeamError>;

    /// One file inside one snapshot, opened read-only. See `list_snapshot_entries` for the walk
    /// and the argument; this method takes the same four steps and ends at a regular file.
    fn open_snapshot(
        &self,
        share: &str,
        snapshot: &str,
        relative: &[&str],
    ) -> Result<std::fs::File, SeamError>;

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

    /// Remove one EMPTY directory under `dir`. `Ok(false)` if it was already gone.
    ///
    /// `unlinkat` with `AT_REMOVEDIR`, relative to a descriptor resolved under the same
    /// confinement as everything else here — never a joined path, because this runs as root.
    ///
    /// Empty is the point, not a limitation to be worked around later. A directory with children
    /// comes back as `SeamError::NotEmpty` and the caller walks the tree itself. A recursive
    /// variant would be `rm -rf` wearing a typed name: one call whose blast radius the caller
    /// chooses, in the one process that can reach every tenant's data. §2.2 and ADR-0006 keep the
    /// operation set closed precisely so that no such call exists to be confused into.
    ///
    /// Separate from `remove_file` rather than a `bool` on it, because the two differ by a syscall
    /// flag and by what a mistake costs: `unlinkat` without `AT_REMOVEDIR` on a directory is
    /// `EISDIR` and harmless, while a caller that meant "file" and reached a directory should hear
    /// about it rather than have the agent guess.
    fn remove_dir(&self, dir: &[&str], name: &str) -> Result<bool, SeamError>;
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

    /// Run two programs with the first's stdout wired to the second's stdin.
    ///
    /// NO SHELL, and that is the entire reason this is a seam method rather than one `run` call
    /// with a `sh -c` in it. ADR-0006 forbids a shell in the privileged process, and a pipeline is
    /// exactly the shape that tempts one: `zfs send a@s | zfs recv -F b` is one line of shell and
    /// two `Command`s with `Stdio::piped()` in Rust. The shell version would also re-introduce
    /// word-splitting on every operand, which is what the validated `DatasetName` type exists to
    /// make impossible.
    ///
    /// BOTH EXIT STATUSES MATTER, and the reader half's matters more. A pipeline reports the LAST
    /// command's status by default, so a `zfs send` that dies half way through — a disk error, a
    /// destroyed snapshot — leaves `zfs recv` succeeding on a TRUNCATED stream. On a replication
    /// that is the worst possible outcome: the target dataset exists, looks like a backup, and is
    /// missing an arbitrary tail. Implementations must wait for both and fail if EITHER failed.
    ///
    /// The output of the writer is discarded and the reader's stdout is returned: `zfs send`
    /// writes the stream itself to stdout, which must never be buffered into memory, and `zfs recv`
    /// writes only a short summary.
    ///
    /// THE DEFAULT REFUSES rather than doing nothing. Most implementations of this trait are test
    /// doubles for code paths that never replicate, and requiring each to write out a pipeline it
    /// will not use is noise. But the default cannot be a silent success: a runner that returned
    /// `Ok("")` here would make a replication report success while nothing was sent, which is the
    /// one outcome a backup feature must never produce.
    fn run_piped(
        &self,
        writer: &str,
        _writer_args: &[&str],
        reader: &str,
        _reader_args: &[&str],
    ) -> Result<String, SeamError> {
        Err(SeamError::Io(format!(
            "this runner cannot pipe {writer} into {reader}"
        )))
    }
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
