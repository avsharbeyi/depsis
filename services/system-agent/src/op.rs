//! The operation surface. This file IS the trust boundary's contract.
//!
//! ADR-0006: the schema is owned by Rust, not by TypeScript. The side that *enforces* a
//! boundary must define it — otherwise the privileged side conforms to a definition written
//! by the unprivileged side, and a relaxed zod schema on the API silently widens what the
//! agent accepts.
//!
//! Two properties matter more than anything else here:
//!
//!   1. The enum is CLOSED. There is no `Raw(String)`, no `Passthrough`, no escape hatch that
//!      accepts a command line. Adding an operation is a deliberate act visible in a diff.
//!   2. Every operand is TYPED. A dataset name is not a string the caller can fill with
//!      `--force`; it is a `DatasetName` that rejects anything a ZFS command could misread as
//!      a flag. Validation happens here, before any of it reaches a process.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Why an operand was rejected. Kept separate from execution errors: these are refusals at the
/// boundary, and they are the ones worth alerting on.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ValidationError {
    #[error("empty value")]
    Empty,
    #[error("too long: {len} > {max}")]
    TooLong { len: usize, max: usize },
    #[error("starts with '-', which a command-line tool would read as a flag")]
    LeadingDash,
    #[error("contains a NUL byte")]
    ContainsNul,
    #[error("contains a path separator")]
    ContainsSeparator,
    #[error("contains '..'")]
    ContainsDotDot,
    #[error("character {0:?} is not allowed here")]
    IllegalChar(char),
}

/// A ZFS dataset name, e.g. `tank/depsis/users/1001`.
///
/// The leading-dash check is not paranoia: P0-E's whole point is that `zfs`, `zpool`,
/// `smbcacls` and `smartctl` parse their own argv, so an operand that begins with `-` becomes a
/// flag even when it arrives as a separate argument. Inserting `--` helps but is not sufficient
/// because these tools do not all honour it consistently, so the value is rejected outright.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(try_from = "String", into = "String")]
pub struct DatasetName(String);

impl DatasetName {
    const MAX: usize = 255;

    pub fn parse(raw: impl Into<String>) -> Result<Self, ValidationError> {
        let s: String = raw.into();
        if s.is_empty() {
            return Err(ValidationError::Empty);
        }
        if s.len() > Self::MAX {
            return Err(ValidationError::TooLong {
                len: s.len(),
                max: Self::MAX,
            });
        }
        if s.starts_with('-') {
            return Err(ValidationError::LeadingDash);
        }
        if s.contains('\0') {
            return Err(ValidationError::ContainsNul);
        }
        for component in s.split('/') {
            if component.is_empty() || component == "." || component == ".." {
                return Err(ValidationError::ContainsDotDot);
            }
        }
        // ZFS permits a restricted set; anything outside it cannot name a real dataset, so
        // accepting it would only widen the surface.
        if let Some(bad) = s
            .chars()
            .find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '.' | ':')))
        {
            return Err(ValidationError::IllegalChar(bad));
        }
        Ok(Self(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for DatasetName {
    type Error = ValidationError;
    fn try_from(v: String) -> Result<Self, Self::Error> {
        Self::parse(v)
    }
}

impl From<DatasetName> for String {
    fn from(v: DatasetName) -> Self {
        v.0
    }
}

/// A single path component under a share root — never a path, never absolute.
///
/// ADR-0005 forbids treating a path as identity, and ADR-0006 confines every filesystem access
/// to `openat2(RESOLVE_BENEATH)` from a long-lived root fd. Both break if a caller can smuggle
/// `/` or `..` through, so this type refuses them rather than sanitising.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(try_from = "String", into = "String")]
pub struct SafeComponent(String);

impl SafeComponent {
    const MAX: usize = 255;

    pub fn parse(raw: impl Into<String>) -> Result<Self, ValidationError> {
        let s: String = raw.into();
        if s.is_empty() {
            return Err(ValidationError::Empty);
        }
        if s.len() > Self::MAX {
            return Err(ValidationError::TooLong {
                len: s.len(),
                max: Self::MAX,
            });
        }
        if s.starts_with('-') {
            return Err(ValidationError::LeadingDash);
        }
        if s.contains('\0') {
            return Err(ValidationError::ContainsNul);
        }
        if s.contains('/') || s.contains('\\') {
            return Err(ValidationError::ContainsSeparator);
        }
        if s == "." || s == ".." {
            return Err(ValidationError::ContainsDotDot);
        }
        Ok(Self(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for SafeComponent {
    type Error = ValidationError;
    fn try_from(v: String) -> Result<Self, Self::Error> {
        Self::parse(v)
    }
}

impl From<SafeComponent> for String {
    fn from(v: SafeComponent) -> Self {
        v.0
    }
}

/// Why a POSIX id was rejected.
///
/// Two variants rather than one, because 0 is the common mistake and deserves the sentence that
/// names it. Everything else is the same fault seen from further away — a number the API mapped
/// wrongly — but "root" points at a specific missing step.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PosixIdError {
    #[error(
        "0 is root; supply the user's mapped uid and gid. A directory owned by root at 0750 is          one the tenant cannot enter, and an entry for the root group grants nothing while          READING as a grant"
    )]
    Root,
    #[error(
        "{got} is outside the reserved DEPSIS range {min}-{max}: it belongs to the host's own          accounts, and handing a tenant's data to one of them (33 is www-data, 27 is sudo, 42 is          shadow) is what the reserved range exists to prevent"
    )]
    OutOfRange { got: u32, min: u32, max: u32 },
}

/// A numeric POSIX uid or gid, inside the range migration 0015 reserved for DEPSIS.
///
/// A type rather than a comparison, for the reason `AclType` is a type: the agent exists not to
/// trust the API, and a rule the API is asked to follow is not a rule the agent enforces. Before
/// this, the privileged side refused the value 0 and nothing else — so uid 33 (`www-data`), gid 27
/// (`sudo`), gid 42 (`shadow`) and the appliance's own service accounts were all accepted operands
/// of `PublishTransfer`, `CreateDirectory` and `AclEntry`. The 300000-399999 range that 0015
/// introduced *precisely* so that "sistem gruplarıyla çakışan bir gid, cihazdaki bir servis
/// hesabına kullanıcının dosyalarını açmaktır" was enforced in exactly two places, both
/// unprivileged: the `CHECK` constraints and `assertUsable` in `posix.service.ts`.
///
/// The agent's own stated reason for refusing 0 — an API that skipped the uid mapping must fail
/// loudly here — applies with the same force to an API that mapped it to the WRONG number, and
/// that was the case being waved through. Now a system id cannot be expressed in a request at all,
/// the same way `nfsv4` cannot be expressed at dataset creation.
///
/// The bounds are duplicated from `0015_teams_and_grants.sql` rather than read from anywhere. That
/// is deliberate and it is the point: the agent must not depend on the database to know what it
/// will accept, because the database is on the unprivileged side of the boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(try_from = "u32", into = "u32")]
pub struct PosixId(u32);

impl PosixId {
    pub const MIN: u32 = 300_000;
    pub const MAX: u32 = 399_999;

    pub fn parse(value: u32) -> Result<Self, PosixIdError> {
        if value == 0 {
            return Err(PosixIdError::Root);
        }
        if !(Self::MIN..=Self::MAX).contains(&value) {
            return Err(PosixIdError::OutOfRange {
                got: value,
                min: Self::MIN,
                max: Self::MAX,
            });
        }
        Ok(Self(value))
    }

    pub fn get(self) -> u32 {
        self.0
    }
}

impl TryFrom<u32> for PosixId {
    type Error = PosixIdError;
    fn try_from(v: u32) -> Result<Self, Self::Error> {
        Self::parse(v)
    }
}

impl From<PosixId> for u32 {
    fn from(v: PosixId) -> Self {
        v.0
    }
}

/// Why a network id was rejected.
///
/// Its own enum rather than a reuse of `ValidationError`, because the two describe different
/// kinds of value. A dataset name is a name with forbidden characters; a network id is a
/// fixed-width number. Folding them together would make a fifteen-digit id report "character is
/// not allowed here", which points the operator at the wrong half of their input.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NetworkIdError {
    #[error("empty value")]
    Empty,
    #[error("a network id is exactly {expected} hex digits; this one is {len} bytes")]
    WrongLength { len: usize, expected: usize },
    #[error("uppercase hex digit {ch:?} at byte {at}; a network id is written in lowercase")]
    Uppercase { at: usize, ch: char },
    #[error("byte {at} is {ch:?}, which is not a hex digit")]
    NotHex { at: usize, ch: char },
}

/// A ZeroTier network id: exactly sixteen lowercase hexadecimal digits.
///
/// Its own type, next to `SafeComponent`, for the same reason and one more. The value is
/// CONCATENATED INTO A REQUEST PATH (`/network/<id>`) and into an HTTP request line, so a
/// `String` here would have to be remembered at every call site — and the site that forgot
/// would be the one that let `../` reach the local API's router, or a `\r\n` split one request
/// into two. A type is a validation nobody can skip.
///
/// Uppercase is REFUSED rather than folded to lowercase. ZeroTier prints ids in lowercase and
/// the same value is a key in `public.remote_networks`, so accepting two spellings for one
/// network means the audit trail and the table can end up holding both, and "is this the
/// network we joined?" stops being a string comparison.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(try_from = "String", into = "String")]
pub struct NetworkId(String);

impl NetworkId {
    /// A ZeroTier network id is a 64-bit number written as 16 hex digits. Not a maximum — the
    /// exact width, which is why the check is `!=` rather than `>`.
    pub const LEN: usize = 16;

    pub fn parse(raw: impl Into<String>) -> Result<Self, NetworkIdError> {
        let s: String = raw.into();
        if s.is_empty() {
            return Err(NetworkIdError::Empty);
        }
        // Bytes, deliberately. A multi-byte string that happens to be 16 bytes long passes this
        // check and is then caught digit by digit below, so nothing gets in on a technicality.
        if s.len() != Self::LEN {
            return Err(NetworkIdError::WrongLength {
                len: s.len(),
                expected: Self::LEN,
            });
        }
        for (at, ch) in s.char_indices() {
            if matches!(ch, '0'..='9' | 'a'..='f') {
                continue;
            }
            if matches!(ch, 'A'..='F') {
                return Err(NetworkIdError::Uppercase { at, ch });
            }
            return Err(NetworkIdError::NotHex { at, ch });
        }
        Ok(Self(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for NetworkId {
    type Error = NetworkIdError;
    fn try_from(v: String) -> Result<Self, Self::Error> {
        Self::parse(v)
    }
}

impl From<NetworkId> for String {
    fn from(v: NetworkId) -> Self {
        v.0
    }
}

/// The ACL type a dataset may be created with.
///
/// `Nfsv4` is deliberately ABSENT and unrepresentable. P0-B measured what happens on
/// ZFS-on-Linux: `zfs set acltype=nfsv4` succeeds, `zfs get` reports `nfsv4`, and ACLs do not
/// work at all — with no error anywhere. A validation that merely checks "acltype is not empty"
/// or "is not off" walks straight into it. Making the value impossible to express is stronger
/// than checking for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AclType {
    /// The only type the Linux kernel actually enforces on ZFS (ADR-0004).
    Posixacl,
}

/// The closed operation set.
///
/// Every variant is something the API cannot do for itself because it needs root. Nothing here
/// takes a command, a shell fragment, or a free-form argument list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
// `deny_unknown_fields` is not pedantry here. Serde's default is to ignore a field it does not
// recognise, so an API that sends `refquota` instead of `refquota_bytes` would get a dataset with
// no quota at all, successfully, with no error anywhere — the exact silent-failure shape Phase 0
// kept measuring. Refusing the request turns a typo into a startup-time integration failure
// instead of an unbounded share discovered when the pool fills.
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    /// Liveness plus a schema-version handshake, so a mismatched API build fails loudly at
    /// startup instead of on the first privileged call.
    /// An empty struct variant, not a unit variant, and the braces are load-bearing.
    /// `deny_unknown_fields` has no effect on a unit variant of an internally tagged enum —
    /// serde deserializes it by ignoring the rest of the map — so `{"op":"ping","x":1}` would
    /// parse. Every other variant refuses unknown fields; a rule with one silent exception is
    /// the kind of thing that is forgotten the day a second unit variant is added.
    Ping {},

    /// Report pool health and capacity. Reads `zfs get`, never `statvfs` — P0-G measured
    /// statvfs disagreeing with the dataset by ~131 kB on a 32 MB dataset (ADR-0008).
    PoolStatus { pool: DatasetName },

    CreateDataset {
        dataset: DatasetName,
        /// Only `posixacl` is expressible. See `AclType`.
        acltype: AclType,
        /// Per-user visible limit. `refquota` excludes snapshots, so admin snapshot policy
        /// cannot block a user out of their own space (ADR-0008).
        refquota_bytes: Option<u64>,
    },

    CreateSnapshot {
        dataset: DatasetName,
        name: SafeComponent,
    },

    /// Diff two snapshots for reconciliation (ADR-0011 layer 3). Runs unprivileged via
    /// `zfs allow` — P0-D disproved the earlier belief that this needed root.
    DiffSnapshots {
        dataset: DatasetName,
        from: SafeComponent,
        to: SafeComponent,
    },

    ReadSmartSummary {
        /// Stable device identity only. `/dev/sdX` is rejected by construction because a
        /// by-id name is a `SafeComponent` under `/dev/disk/by-id` (risk R1).
        disk_by_id: SafeComponent,
    },

    /// Validate and atomically publish a Samba configuration.
    ///
    /// P0-B measured why `testparm` alone is not a sufficient gate: an invalid
    /// `full_audit:success` opname passes `testparm` cleanly and then makes smbd refuse every
    /// connection. The implementation must follow validation with a live connection smoke test
    /// and roll back on failure (ADR-0011, §17).
    PublishSambaConfig { shares: Vec<ShareSpec> },

    /// Open a staging file and hand back a one-time token for the bulk data channel.
    ///
    /// The API cannot write into a share itself. ADR-0008 says the durability sequence belongs
    /// to the agent, and the cleanest way to honour that — the agent opens with `openat2` and
    /// passes the descriptor over — is unreachable, because Node's `net` module has no
    /// ancillary-data support and therefore cannot receive an `SCM_RIGHTS` descriptor from a
    /// non-Node peer (checked against the Node documentation, not assumed).
    ///
    /// So the bytes travel instead. This operation resolves and opens the staging file under
    /// `openat2(RESOLVE_BENEATH)`, keeps the descriptor, and returns a token. The API then
    /// connects to the data socket, presents the token, and streams. The token names an
    /// ALREADY-RESOLVED file: nothing the API sends on the data socket can change which file it
    /// is writing to, which is what keeps the confinement meaningful across two connections.
    OpenTransfer {
        /// The share root this transfer is confined to.
        share: SafeComponent,
        /// The staging file, under `.depsis/staging/` inside that share.
        staging_name: SafeComponent,
    },

    /// Move a completed staging file into its place, durably.
    ///
    /// ADR-0008's sequence, steps 4 and 5: rename, then `fsync` the DESTINATION DIRECTORY. The
    /// second one is not optional — without it a power cut can lose the rename even though the
    /// file's own contents survived, which is the worst outcome available: the data is on disk
    /// and nothing points at it.
    ///
    /// Refuses if the destination exists. `RENAME_NOREPLACE` was measured working on ZFS 2.3.2
    /// in P0-G; the `linkat` + `unlink` form is the portable fallback. Either way a publish
    /// never silently overwrites a file the user already has.
    PublishTransfer {
        share: SafeComponent,
        staging_name: SafeComponent,
        /// Where it lands, relative to the share root. Components are validated individually.
        destination: Vec<SafeComponent>,
        /// How many bytes the caller believes are staged.
        ///
        /// Checked, not trusted. The agent must not rest on the API's belief that an upload
        /// finished (ADR-0006): a client that dies at 90% plus a buggy API would otherwise rename a
        /// short file to the user's chosen name, and RENAME_NOREPLACE then makes that name
        /// permanently unavailable to the good copy.
        expected_bytes: u64,
        /// Who owns the file once it lands.
        ///
        /// On PUBLISH rather than on `OpenTransfer`, deliberately. Staging happens inside the share
        /// — `.depsis/staging/` — so a staging file owned by the tenant is a file the tenant can
        /// reach over SMB and rewrite while the agent is still appending to it. Root-owned until
        /// the moment it becomes visible under its real name is the only window that closes.
        ///
        /// `PosixId` refuses 0 and refuses anything outside the reserved range. Not because a
        /// root-owned file in a share is a privilege escalation — it is not, the mode is 0600 and
        /// nothing is setuid — but because it is precisely the broken state these two fields exist
        /// to fix, and an API that omits or mis-maps the identity should fail loudly rather than
        /// hand a tenant's file to one of the host's own accounts.
        owner_uid: PosixId,
        owner_gid: PosixId,
    },

    /// Open a published file for reading, and hand back a one-time token for the data socket.
    ///
    /// The mirror of `OpenTransfer`, and it exists for the same reason: the unprivileged API cannot
    /// open a file inside a share. It has no descriptor and the file is not readable by its uid in
    /// the general case — a tenant's file belongs to the tenant — so the bytes have to come back
    /// through the agent, on the same socket they went out on.
    ///
    /// The token names an ALREADY-RESOLVED descriptor. Nothing on the data wire names a path, so a
    /// caller cannot widen a download into a file the control call did not confine, and the range
    /// it asks for is checked against the file the agent itself opened.
    OpenDownload {
        share: SafeComponent,
        /// Where the file is, relative to the share root. Components are validated individually,
        /// so no element can be `..`, a separator or an absolute-looking string.
        path: Vec<SafeComponent>,
    },

    /// Throw a staging file away.
    ///
    /// The missing half of the upload path, and its absence was a dead end rather than a gap:
    /// `.depsis/staging` counts against the user's `refquota`, Samba vetoes `/.depsis/` and the API
    /// filters the prefix server-side, so abandoned chunks are invisible to the user, undeletable
    /// by the user, undeletable by the API — which cannot write inside a share at all — and, until
    /// now, undeletable by the agent. Every failed checksum, every cancelled upload and every
    /// `EDQUOT` was permanent.
    ///
    /// Refused while a data connection is streaming. Unlinking a file a worker is still appending
    /// to leaves the worker writing to an unlinked inode and reporting success.
    DiscardTransfer {
        share: SafeComponent,
        staging_name: SafeComponent,
    },

    /// Move one entry to another name, inside one share.
    ///
    /// The same `renameat2(RENAME_NOREPLACE)` plus destination-directory `fsync` that
    /// `PublishTransfer` uses, aimed at a file the user already owns rather than at a staged one.
    /// Refusing to overwrite is not a convenience: a move that silently replaces the file already
    /// sitting at the destination destroys data the user never named, and there is no undo in this
    /// product.
    ///
    /// ONE share, not two, and the single `share` field is what enforces it. A rename across
    /// datasets returns `EXDEV` (ADR-0008) because every DEPSIS share is its own ZFS dataset, so a
    /// cross-share `MoveEntry` could only ever be a copy-then-delete — a different operation, with
    /// a different failure mode and a different cost, which therefore deserves its own name rather
    /// than a surprise inside this one.
    MoveEntry {
        share: SafeComponent,
        /// Where it is now, relative to the share root. The last element is the entry's own name.
        from: Vec<SafeComponent>,
        /// Where it goes, relative to the same share root. The last element is the new name; the
        /// elements before it must already exist and be directories.
        to: Vec<SafeComponent>,
    },

    /// Delete exactly ONE entry inside a share. Never a tree.
    ///
    /// `directory` is a required operand rather than something the agent works out by stat-ing the
    /// path, and that is deliberate twice over. `unlinkat` needs `AT_REMOVEDIR` or not, so the
    /// distinction has to be made somewhere; making the CALLER state it means a caller that
    /// believes it is deleting a file and finds a directory gets a refusal instead of a surprise.
    /// Deciding it from a stat would also be check-then-use on the one operation that cannot be
    /// undone.
    ///
    /// There is no recursive variant and there will not be one. A non-empty directory comes back
    /// as an error (`ENOTEMPTY`) and the API walks the tree itself. The reason is §2.2 and
    /// ADR-0006: the closed operation set exists so that no single call the agent accepts has a
    /// blast radius the caller chooses. "Delete this subtree" is `rm -rf` behind a typed name — one
    /// bug in the unprivileged side, or one confused-deputy request, and it is the whole share.
    /// The API knows the tree because the API stores the tree; the agent only needs to be able to
    /// remove a leaf.
    RemoveEntry {
        share: SafeComponent,
        path: Vec<SafeComponent>,
        /// Is the entry a directory? The caller knows and has to say.
        directory: bool,
    },

    /// Create ONE directory inside a share.
    ///
    /// Its absence was not a gap in the operation set, it was a hole under the product. The API
    /// could write a `folders` row and nothing else, because the closed set had no operation that
    /// makes a directory — so a folder existed in Postgres and did not exist on disk. Everything
    /// downstream inherited that: `MoveEntry` on a folder could only ever return 409 because there
    /// was no directory to rename, a publish into a folder failed because the destination parent
    /// was not there, and somebody browsing the share over SMB — which is the entire reason a NAS
    /// exists — saw no folders at all.
    ///
    /// ONE node, never `mkdir -p`. The intermediate components must already exist and a missing
    /// one comes back as `NotFound`, for the same reason `MoveEntry` refuses to create its
    /// destination parent: an implicit mkdir turns a typo into a directory the user never asked
    /// for, holding a file they can no longer find. It is also what keeps the disk and the
    /// database one-to-one — each directory is one call and one row, so a partially-created tree
    /// cannot leave rows with no parent behind.
    CreateDirectory {
        share: SafeComponent,
        /// Relative to the share root; the LAST element is the name of the directory to create.
        /// Every element before it must already exist and be a directory.
        path: Vec<SafeComponent>,
        /// Who owns the directory. The same pair as `PublishTransfer` and the same type, for the
        /// same reason: a directory owned by root at 0750 is one the user cannot enter, and one
        /// owned by a host service account is one the wrong process can, so an API that skipped or
        /// botched the uid mapping must fail loudly here rather than produce a folder that appears
        /// in the listing and cannot be opened.
        owner_uid: PosixId,
        owner_gid: PosixId,
    },

    /// Close a share root to everybody the ACL does not name.
    ///
    /// WHAT WAS WRONG. `zfs create` leaves a dataset's mountpoint at ZFS's default, which is
    /// `0755 root:root` — `other::r-x`. `ApplyFolderAcl` cannot fix it and must not try: that
    /// operation deliberately never touches the `user::`/`group::`/`other::` triple, and refuses
    /// outright if it changes underneath, because a "permissions applied" reply that had quietly
    /// rewritten the three entries every access falls back to would be the worst kind of lie.
    ///
    /// So nothing in the product had ever set the mode of a share root, and every share on every
    /// appliance was traversable by anyone: an authenticated SMB principal could list the
    /// top-level names and enter the root however narrow `folder_grants` was. Descent past it was
    /// still gated, because agent-created folders are 0750 with an ACL of their own — so the leak
    /// is enumeration and traversal of ONE directory, not the contents below it. That is a smaller
    /// hole than it first reads as, and still one that makes a "private" share list its folder
    /// names to the whole appliance.
    ///
    /// AN OPERATION OF ITS OWN, not a field on `CreateDataset`. Shares that already exist are open
    /// too, and an operand at creation time would only ever fix the next one. This can be aimed at
    /// any share, is idempotent, and the API runs it immediately before writing the root's ACL.
    ///
    /// THE ORDER IS LOAD-BEARING AND IT IS A POSIX RULE, not a local convention: `chmod` on a file
    /// that already carries an ACL sets the MASK from the group bits rather than the `group::`
    /// entry. Running this AFTER an ACL would silently clamp every named entry to `r-x`. Run
    /// before, the `setfacl` that follows recomputes the mask correctly — and the gap between them
    /// narrows rather than widens, which is the direction to be wrong in.
    ///
    /// No owner operand. The root stays `root:root` and that is the right answer rather than a
    /// missing one: root bypasses every ACL anyway, no DEPSIS principal should own the top of a
    /// share, and giving it to the administrator who happened to create it would bake one person's
    /// account into the filesystem. With `0750` and root ownership, `user::` and `group::` reach
    /// nobody the appliance maps, `other::` reaches nobody at all, and every real grant arrives as
    /// a named ACL entry — which is exactly the model ADR-0004 describes.
    SecureShareRoot { share: SafeComponent },

    /// Rewrite the POSIX ACL of ONE folder inside a share — access ACL and default ACL both.
    ///
    /// The operation the access-control model rests on. `folder_grants` in the database says who
    /// may read a folder; until this runs, the kernel has never been told, and SMB — which does not
    /// go through the API at all — enforces the mode bits and nothing else. A grant that exists
    /// only in Postgres is not a permission, it is a note about one.
    ///
    /// The entry list is COMPLETE, never a delta. The agent clears the extended entries before it
    /// writes, because a merge leaves a group the caller has just removed still holding its old
    /// permission: `setfacl -m` only ever adds and overwrites, so an entry that is no longer
    /// mentioned survives. "Here is who may reach this folder" is a statement the caller can make
    /// correctly; "here is what changed" is one it would have to reconstruct from a disk it cannot
    /// read.
    /// ONE folder, never a subtree. There was a `recursive: bool` here and it is gone.
    ///
    /// It was the shape §2.2/ADR-0006 rejects everywhere else in this enum — `RemoveEntry` and
    /// `SafePath::remove_dir` both say it outright about `rm -rf`: one call whose blast radius the
    /// caller chooses, in the one process that can reach every tenant's data. The ACL variant was
    /// the same primitive with a different verb, and it was destructive in a way its own comment
    /// did not admit, because the recursive pass began with `setfacl -R -b`. Measured: a sub-folder
    /// carrying §6.2's documented narrower grant (`İstisna: daha dar izin` — the entire reason
    /// `folder_grants` has per-folder rows) lost it and inherited the parent's wider one, while the
    /// `folder_grants` row went on saying the narrow thing. Two realities, widening.
    ///
    /// It also could not survive the fix to the TOCTOU above it: `setfacl -R` does not descend
    /// through `/proc/self/fd/N`, so keeping recursion meant keeping the joined path that let a
    /// symlink swap redirect a root-owned `setfacl` onto `/etc`. See the `acl` module note.
    ///
    /// A mass re-apply is therefore a loop on the API's side, which is where it belongs: the API
    /// stores the tree and holds a grant row per folder, so one call per folder writes each row's
    /// own grant instead of stamping one answer over descendants that disagree with it.
    ApplyFolderAcl {
        share: SafeComponent,
        /// Relative to the share root. EMPTY names the share root itself, which is the ordinary
        /// case for a share-wide grant. Unlike `CreateDirectory` — where an empty path would mean
        /// creating the share — there is nothing to lose here: the caller already named the share,
        /// and granting on the root of the tree it named is the point.
        ///
        /// `.depsis/` is refused, like everywhere else a caller-supplied path is accepted.
        path: Vec<SafeComponent>,
        entries: Vec<AclEntry>,
    },

    // ── ZeroTier (ADR-0020) ──
    //
    // Four operations, and the set is closed for the same reason the enum as a whole is. A
    // `ZeroTierRequest { method, path, body }` pass-through would be one variant instead of
    // four and would cover every future endpoint — which is exactly the argument §2.2 rejects
    // for shell commands. The agent holds the local API token precisely because that token
    // grants network control; handing the caller a general way to spend it puts the API back in
    // charge of what the privileged side does.
    //
    // The explicit `rename`s exist because serde's snake_case of `ZeroTierStatus` is
    // `zero_tier_status`, which reads as a typo in every consumer that has to type it.
    /// The local node's own identity and reachability: node id, online, daemon version.
    ///
    /// Readable by any signed-in user (ADR-0020): a device knowing its own id is not a secret.
    #[serde(rename = "zerotier_status")]
    ZeroTierStatus {},

    /// The networks this node has joined, with the authorization status of each.
    ///
    /// `ACCESS_DENIED` is the interesting one and it is not an error: it means the device has
    /// joined and the network's administrator has not ticked the box yet. Reporting that as
    /// "connecting" is how a user concludes the product is broken.
    #[serde(rename = "zerotier_networks")]
    ZeroTierNetworks {},

    /// Join a network. Admin-only at the API (ADR-0020): joining makes the device visible to
    /// everyone on that network.
    #[serde(rename = "zerotier_join")]
    ZeroTierJoin { network_id: NetworkId },

    #[serde(rename = "zerotier_leave")]
    ZeroTierLeave { network_id: NetworkId },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ShareSpec {
    pub name: SafeComponent,
    pub dataset: DatasetName,
    pub read_only: bool,
}

/// One POSIX ACL entry: a GROUP and the three permission bits.
///
/// There is no `uid` field and there must not be one. ADR-0004 chose the grant model, and this
/// struct is where the choice is enforced rather than remembered: POSIX ACLs become unwieldy past
/// roughly thirty entries and the mask semantics start biting, so a share-role is a POSIX group and
/// users join groups. A per-user entry is expressible in the syscall and wrong in the design — so
/// it is not expressible here, the same way `AclType` makes `nfsv4` unrepresentable rather than
/// checking for it.
///
/// The bits are three booleans rather than a mode number for the same reason every other operand in
/// this file is typed: `0o755` reaching the wrong field is a silent widening, while a missing
/// `execute` is a parse error. On a directory `execute` is the bit that permits *entering* it, so a
/// read-only grant is `r-x` and not `r--`; the API decides that, because the agent does not know
/// whether the target is a directory and must not guess.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AclEntry {
    /// The POSIX group id. Numeric, and no identity database is consulted — `setfacl` takes a
    /// number and `/etc/passwd` is a separate decision about the appliance's identity store.
    ///
    /// `PosixId`, so 0 and the host's own groups are unrepresentable rather than checked. Root
    /// bypasses every ACL already, so an entry for the root group grants nothing and *reads* as a
    /// grant; an entry for gid 27 or 42 grants a great deal and reads the same way. Both are an API
    /// that got the group mapping wrong, and the agent must not be the side that trusts it.
    pub gid: PosixId,
    pub read: bool,
    pub write: bool,
    /// On a directory this is the bit that permits entering it, not executing anything.
    pub execute: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Response {
    Ok {
        schema_version: u32,
    },
    PoolStatus {
        health: String,
        used_bytes: u64,
        available_bytes: u64,
    },
    Created {
        dataset: String,
    },
    Snapshot {
        full_name: String,
    },
    Diff {
        lines: Vec<String>,
    },
    Smart {
        healthy: bool,
        temperature_celsius: Option<i32>,
        raw: String,
    },
    /// The Samba configuration was written AND proved.
    ///
    /// `verified` is not decoration. `testparm` passing means the file parses; P0-B measured an
    /// invalid `full_audit` opname passing it cleanly and then making smbd refuse every
    /// connection, so this flag reports the live connection attempt that followed. The agent only
    /// ever returns it `true` — a publish that cannot be proved rolls back and comes back as
    /// `refused` — but the contract carries the field because a client must be able to tell
    /// "shares are served" from "a file was written".
    Published {
        shares: usize,
        verified: bool,
    },
    /// A transfer is open. `offset` is how many bytes the staging file already holds, so a
    /// resumed upload knows where to continue without asking the filesystem itself.
    Transfer {
        token: String,
        offset: u64,
    },
    /// The staged file is in place and the destination directory has been fsynced.
    Publish {
        bytes: u64,
    },
    /// A file is open for reading. `size` is the file's own length, read from the descriptor the
    /// agent holds rather than from anything the caller supplied — so a Range can be validated
    /// against the object that will actually be read.
    Download {
        token: String,
        size: u64,
    },
    /// A staging file was thrown away. `existed` is false when there was nothing there, which is a
    /// success: a caller retrying a discard must not have to tell "already clean" apart from a
    /// fault.
    Discarded {
        existed: bool,
    },
    /// The entry is at its new name and the destination directory has been fsynced.
    ///
    /// No payload. The caller named both ends of the move and nothing about them changed, so
    /// echoing them back would only invite a consumer to believe the agent had normalised
    /// something.
    Moved {},
    /// The entry is gone.
    ///
    /// No `existed` flag, unlike `Discarded`. Discarding a staging file races the sweeper, so
    /// "already clean" is a success there. Removing an entry the user asked to remove is different:
    /// if it is not there, the caller's view of the tree disagrees with the disk, and answering
    /// "done" would hide that. That case is `NotFound`.
    Removed {},
    /// The directory is on disk, owned by the uid and gid the caller named, and the entry has been
    /// made durable by an `fsync` of its parent.
    ///
    /// No payload, like `Moved`. The caller named the path and the agent normalised nothing, so
    /// echoing it back would only invite a consumer to believe otherwise. What the caller needs to
    /// know is that the next call — the database row, or a publish into this directory — may now
    /// proceed, and the status alone says that.
    DirectoryCreated {},
    /// The share root is closed to everyone the ACL does not name.
    ///
    /// `mode` is echoed rather than omitted, unlike `DirectoryCreated`, and for the same reason
    /// `AclApplied` echoes its count: the caller did not choose it. The number is the agent's,
    /// fixed in `SHARE_ROOT_MODE`, so sending it back is the only way an operator reading an audit
    /// line can see what was actually applied without going to read the source.
    #[serde(rename = "share_root_secured")]
    ShareRootSecured {
        mode: u32,
    },

    /// The folder's POSIX ACL is what the caller asked for, access ACL and DEFAULT ACL both.
    ///
    /// `entries` is how many group entries the folder now carries, and it is here rather than
    /// omitted — unlike `Moved` and `DirectoryCreated`, which echo nothing — because the number the
    /// agent wrote is the one thing about this operation the caller cannot derive from its own
    /// request. It sent a list; a list containing a duplicate or a root group is refused rather
    /// than trimmed, so the count coming back equal to the count sent is the caller's confirmation
    /// that nothing was quietly dropped.
    #[serde(rename = "acl_applied")]
    AclApplied {
        entries: usize,
    },
    /// The `acl` package is not installed on this box.
    ///
    /// The same shape as `SmbUnavailable` and `ZeroTierUnavailable`, and for the same reason: DEPSIS
    /// packages none of the three, so "absent" is an ordinary configuration state the API turns
    /// into 503 with a card that names the package. Folding it into `Failed` would send an operator
    /// hunting a broken agent instead of running `apt install acl`.
    ///
    /// A dataset with no working ACL layer is deliberately NOT this. That one is a `Failed` whose
    /// message names `acltype` — the tools are present and working, and what they are reporting is
    /// that the kernel enforces no access control on that dataset at all (ADR-0004).
    #[serde(rename = "acl_unavailable")]
    AclUnavailable {
        reason: String,
    },
    /// The path the operation named is not there.
    ///
    /// Its own variant rather than `Refused`, because the API turns exactly this into 404 and
    /// everything else in `Refused` into something else entirely. Collapsing them would put the
    /// API back to matching on prose.
    NotFound {
        reason: String,
    },
    /// The operation would have collided with something that is already there: a destination name
    /// that is taken, or a directory that still has children. 409, not 404 and not 500 — the caller
    /// can fix both by doing something different.
    Conflict {
        reason: String,
    },
    /// The local node. `node_id` is ZeroTier's own address for this machine.
    #[serde(rename = "zerotier_status")]
    ZeroTierStatus {
        node_id: String,
        online: bool,
        version: String,
    },
    #[serde(rename = "zerotier_networks")]
    ZeroTierNetworks {
        networks: Vec<ZeroTierNetwork>,
    },
    /// Joined. The network comes back with it because the state right after a join is the one
    /// the user most needs to see: usually `REQUESTING_CONFIGURATION`, then `ACCESS_DENIED`
    /// until somebody authorizes the device.
    #[serde(rename = "zerotier_joined")]
    ZeroTierJoined {
        network: ZeroTierNetwork,
    },
    #[serde(rename = "zerotier_left")]
    ZeroTierLeft {
        network_id: String,
    },
    /// zerotier-one is not installed here, or is not running.
    ///
    /// Its own variant rather than `Failed`, and the distinction is the whole point of the
    /// operation set: DEPSIS does not package ZeroTier (ADR-0020), so "absent" is an ordinary
    /// configuration state the UI must be able to name — and the API turns this into 503, not
    /// 500. A fault the operator caused and a fault the operator must fix look nothing alike.
    #[serde(rename = "zerotier_unavailable")]
    ZeroTierUnavailable {
        reason: String,
    },
    /// Samba is not installed on this box.
    ///
    /// The same shape as `ZeroTierUnavailable` and for the same reason: DEPSIS packages neither,
    /// so "absent" is an ordinary state of a machine that the API turns into 503 and the UI names
    /// in a card. Collapsing it into `Failed` would send an operator hunting a broken agent
    /// instead of installing a package, and it is what `SharePage.smbAvailable` reports.
    #[serde(rename = "smb_unavailable")]
    SmbUnavailable {
        reason: String,
    },
    Refused {
        reason: String,
    },
    Failed {
        reason: String,
    },
}

/// One joined network, as the agent reports it.
///
/// A typed projection, not the daemon's JSON. Passing the raw object through would make every
/// field ZeroTier ever adds part of the DEPSIS contract, and would put the agent in the position
/// of forwarding something it has not read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ZeroTierNetwork {
    pub network_id: String,
    pub name: Option<String>,
    pub status: ZeroTierNetworkStatus,
    /// The addresses this network assigned to the node, in CIDR form. Empty until the network
    /// authorizes the device, which is what makes an empty list here meaningful rather than a
    /// missing value.
    pub addresses: Vec<String>,
}

/// A joined network's membership state, as ZeroTier reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ZeroTierNetworkStatus {
    Ok,
    /// Joined, NOT authorized. No traffic flows. The user has to tick a box in ZeroTier
    /// Central; until then this is the honest state and it is not a failure.
    AccessDenied,
    NotFound,
    RequestingConfiguration,
    PortError,
    AuthenticationRequired,
    /// A status this build does not know. Present so that a newer daemon cannot be mapped onto
    /// `Ok` — showing an operator a false green is the shortest route to a device that is
    /// reported connected and is not.
    Unknown,
}

/// Bumped whenever `Request` or `Response` changes shape. The API checks it on connect.
///
/// 4 as of `CreateDirectory`/`ApplyFolderAcl`: `Request` gained two variants, `Response` three, and
/// `AclEntry` is a new operand type. The point of the check is that a NEW API against an OLD agent
/// fails at the handshake, while someone is watching a deployment. Without the bump the pair shakes
/// hands cleanly and the mismatch surfaces on the first call as a generic refusal — a message from
/// which nobody concludes "the agent binary is stale". Here that would be worse than a puzzling
/// error: an `ApplyFolderAcl` an old agent does not understand leaves the folder carrying whatever
/// ACL it had before, so the API would record a grant in `folder_grants` that the kernel is not
/// enforcing, and a share would look restricted while SMB let everyone in.
/// `EXPECTED_SCHEMA_VERSION` in `packages/agent-protocol` moves with it; they are one number in two
/// languages.
pub const SCHEMA_VERSION: u32 = 5;

/// The mode `SecureShareRoot` writes: `rwx` for the owner, `r-x` for the group, nothing for other.
///
/// `0o750` and not `0o700`. The owner and group are both root, which the appliance maps to nobody,
/// so neither triple reaches a DEPSIS principal either way — but `0o750` is what every directory
/// the agent creates already uses (`create_dir`), and one mode across the tree is one fewer thing
/// for an operator comparing `ls -l` output to wonder about.
///
/// What closes the share is the last digit. `other::---` is the difference between a share whose
/// top-level names every authenticated SMB principal can read and one where only a named ACL entry
/// gets in.
pub const SHARE_ROOT_MODE: u32 = 0o750;

#[cfg(test)]
mod deny_unknown_tests {
    use super::*;

    #[test]
    fn an_unrecognised_field_is_refused_rather_than_ignored() {
        // The failure this prevents: `refquota` for `refquota_bytes` producing a quota-less
        // dataset that reports success.
        let typo =
            r#"{"op":"create_dataset","dataset":"tank/a","acltype":"posixacl","refquota":100}"#;
        assert!(
            serde_json::from_str::<Request>(typo).is_err(),
            "a misspelled field was silently ignored"
        );

        let correct = r#"{"op":"create_dataset","dataset":"tank/a","acltype":"posixacl","refquota_bytes":100}"#;
        assert!(serde_json::from_str::<Request>(correct).is_ok());
    }

    #[test]
    fn a_smuggled_extra_field_is_refused() {
        assert!(serde_json::from_str::<Request>(r#"{"op":"ping","extra":"; id"}"#).is_err());
        assert!(serde_json::from_str::<Request>(r#"{"op":"ping"}"#).is_ok());
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

    #[test]
    fn dataset_name_accepts_a_realistic_name() {
        assert!(DatasetName::parse("tank/depsis/users/1001").is_ok());
    }

    #[test]
    fn dataset_name_rejects_a_leading_dash() {
        // The whole point: `zfs` would read this as a flag even as a separate argv entry.
        assert_eq!(DatasetName::parse("-o"), Err(ValidationError::LeadingDash));
        assert_eq!(
            DatasetName::parse("--force"),
            Err(ValidationError::LeadingDash)
        );
    }

    #[test]
    fn dataset_name_rejects_traversal_and_nul() {
        assert_eq!(
            DatasetName::parse("tank/../etc"),
            Err(ValidationError::ContainsDotDot)
        );
        assert_eq!(
            DatasetName::parse("tank//users"),
            Err(ValidationError::ContainsDotDot)
        );
        assert_eq!(
            DatasetName::parse("tank\0evil"),
            Err(ValidationError::ContainsNul)
        );
    }

    #[test]
    fn dataset_name_rejects_shell_metacharacters() {
        // There is no shell in the execution path, but accepting these would widen the surface
        // for the tools that do their own parsing.
        for bad in ["tank;rm", "tank$(x)", "tank|y", "tank y", "tank&z"] {
            assert!(
                DatasetName::parse(bad).is_err(),
                "should have rejected {bad:?}"
            );
        }
    }

    #[test]
    fn safe_component_refuses_to_be_a_path() {
        assert_eq!(
            SafeComponent::parse("a/b"),
            Err(ValidationError::ContainsSeparator)
        );
        assert_eq!(
            SafeComponent::parse("..\\windows"),
            Err(ValidationError::ContainsSeparator)
        );
        assert_eq!(
            SafeComponent::parse(".."),
            Err(ValidationError::ContainsDotDot)
        );
    }

    // ── NetworkId ──
    //
    // Every rejection below has its own case, because this value is concatenated into a request
    // path and an HTTP request line. A single "invalid" test would pass just as happily with a
    // parser that only checked the length.

    #[test]
    fn network_id_accepts_a_real_id() {
        let id = NetworkId::parse("8056c2e21c000001").expect("a real ZeroTier network id");
        assert_eq!(id.as_str(), "8056c2e21c000001");
        assert!(NetworkId::parse("ffffffffffffffff").is_ok());
        assert!(NetworkId::parse("0000000000000000").is_ok());
    }

    #[test]
    fn network_id_rejects_empty() {
        assert_eq!(NetworkId::parse(""), Err(NetworkIdError::Empty));
    }

    #[test]
    fn network_id_rejects_fifteen_and_seventeen_digits() {
        assert_eq!(
            NetworkId::parse("8056c2e21c00000"),
            Err(NetworkIdError::WrongLength {
                len: 15,
                expected: 16
            })
        );
        assert_eq!(
            NetworkId::parse("8056c2e21c0000011"),
            Err(NetworkIdError::WrongLength {
                len: 17,
                expected: 16
            })
        );
    }

    #[test]
    fn network_id_rejects_uppercase_rather_than_folding_it() {
        // Not a style rule. Two spellings of one id mean two rows in `remote_networks` and an
        // audit trail where "did we join this?" is no longer a string comparison.
        assert_eq!(
            NetworkId::parse("8056C2E21C000001"),
            Err(NetworkIdError::Uppercase { at: 4, ch: 'C' })
        );
    }

    #[test]
    fn network_id_rejects_non_hex_digits() {
        assert_eq!(
            NetworkId::parse("8056c2e21c00000g"),
            Err(NetworkIdError::NotHex { at: 15, ch: 'g' })
        );
        // Sixteen bytes of multi-byte text: the length check passes and the digit check is what
        // catches it, which is the case a `len() == 16` parser gets wrong.
        assert!(matches!(
            NetworkId::parse("ααααααββββββγγγγ".get(..16).unwrap_or_default()),
            Err(NetworkIdError::NotHex { .. })
        ));
    }

    #[test]
    fn network_id_rejects_a_path_fragment_and_a_nul() {
        // Both are exactly sixteen bytes, so only the digit check stands between them and a
        // request path. `../` in an id would address a different endpoint of the local API;
        // a NUL would be truncated by whatever C string it eventually reached.
        assert_eq!(
            NetworkId::parse("../../../etc/pas"),
            Err(NetworkIdError::NotHex { at: 0, ch: '.' })
        );
        assert_eq!(
            NetworkId::parse("0123456789abcd\0f"),
            Err(NetworkIdError::NotHex { at: 14, ch: '\0' })
        );
        // And a header split, which is what a request line concatenation is really exposed to.
        assert!(NetworkId::parse("0123456789ab\r\ncd").is_err());
        assert!(NetworkId::parse("0123456789abc de").is_err());
    }

    #[test]
    fn a_request_carrying_a_bad_network_id_does_not_deserialize() {
        for json in [
            r#"{"op":"zerotier_join","network_id":"../../../etc/pas"}"#,
            r#"{"op":"zerotier_join","network_id":"8056C2E21C000001"}"#,
            r#"{"op":"zerotier_join","network_id":""}"#,
            r#"{"op":"zerotier_leave","network_id":"8056c2e21c00000"}"#,
        ] {
            assert!(
                serde_json::from_str::<Request>(json).is_err(),
                "{json} must not deserialize"
            );
        }
        assert!(serde_json::from_str::<Request>(
            r#"{"op":"zerotier_join","network_id":"8056c2e21c000001"}"#
        )
        .is_ok());
    }

    #[test]
    fn there_is_no_general_zerotier_proxy_variant() {
        // The network-shaped version of `there_is_no_raw_command_variant`. If somebody adds a
        // pass-through to the local API, one of these starts parsing and this test fails.
        for json in [
            r#"{"op":"zerotier_request","path":"/controller/network"}"#,
            r#"{"op":"zerotier","method":"POST","path":"/moon","body":"{}"}"#,
            r#"{"op":"zerotier_status","path":"/status"}"#,
        ] {
            assert!(
                serde_json::from_str::<Request>(json).is_err(),
                "{json} must not deserialize"
            );
        }
        assert!(serde_json::from_str::<Request>(r#"{"op":"zerotier_status"}"#).is_ok());
    }

    #[test]
    fn an_unknown_network_status_stays_unknown_on_the_wire() {
        let json = serde_json::to_string(&ZeroTierNetworkStatus::AccessDenied).expect("serialize");
        assert_eq!(json, r#""ACCESS_DENIED""#);
        assert_eq!(
            serde_json::to_string(&ZeroTierNetworkStatus::Ok).expect("serialize"),
            r#""OK""#
        );
    }

    #[test]
    fn nfsv4_acltype_is_not_expressible() {
        // Not a runtime check — a parse failure. ADR-0004's most dangerous configuration
        // cannot be constructed, so no code path can accidentally request it.
        let json = r#"{"op":"create_dataset","dataset":"tank/x","acltype":"nfsv4"}"#;
        let parsed: Result<Request, _> = serde_json::from_str(json);
        assert!(parsed.is_err(), "acltype=nfsv4 must not deserialize");
    }

    #[test]
    fn a_request_carrying_a_flag_as_a_dataset_is_rejected_at_parse_time() {
        let json = r#"{"op":"create_snapshot","dataset":"-R","name":"s1"}"#;
        let parsed: Result<Request, _> = serde_json::from_str(json);
        assert!(parsed.is_err());
    }

    // ── MoveEntry / RemoveEntry ──

    #[test]
    fn a_traversing_component_cannot_be_expressed_in_a_move_or_a_remove() {
        // The type test the brief asks for, and it is a PARSE failure rather than a runtime check:
        // `Vec<SafeComponent>` has no inhabitant spelled `..`, so no dispatch code path can be
        // reached with one. Nothing downstream has to remember to look, which is the whole reason
        // the operand is a type instead of a string.
        assert_eq!(
            SafeComponent::parse(".."),
            Err(ValidationError::ContainsDotDot)
        );
        for json in [
            r#"{"op":"move_entry","share":"alice","from":["..","etc"],"to":["x"]}"#,
            r#"{"op":"move_entry","share":"alice","from":["a"],"to":["..","..","etc","passwd"]}"#,
            r#"{"op":"move_entry","share":"alice","from":["a/b"],"to":["c"]}"#,
            r#"{"op":"move_entry","share":"..","from":["a"],"to":["b"]}"#,
            r#"{"op":"remove_entry","share":"alice","path":["..","etc"],"directory":false}"#,
            r#"{"op":"remove_entry","share":"alice","path":["a\\b"],"directory":false}"#,
            r#"{"op":"remove_entry","share":"alice","path":["-rf"],"directory":false}"#,
            r#"{"op":"remove_entry","share":"alice","path":[""],"directory":false}"#,
        ] {
            assert!(
                serde_json::from_str::<Request>(json).is_err(),
                "{json} must not deserialize"
            );
        }
    }

    #[test]
    fn a_well_formed_move_and_remove_do_parse() {
        // The negative test above is worth nothing without this one: a parser that rejected
        // everything would pass it.
        assert!(serde_json::from_str::<Request>(
            r#"{"op":"move_entry","share":"alice","from":["docs","a.txt"],"to":["archive","a.txt"]}"#
        )
        .is_ok());
        assert!(serde_json::from_str::<Request>(
            r#"{"op":"remove_entry","share":"alice","path":["docs","a.txt"],"directory":false}"#
        )
        .is_ok());
    }

    #[test]
    fn remove_entry_will_not_default_its_directory_flag() {
        // Omitting `directory` must fail rather than mean `false`. A caller that forgot the field
        // and got "file" by default would hit EISDIR on every directory — recoverable — but the
        // reverse default would be worse, and neither belongs in an operation with no undo. The
        // caller states what it thinks it is deleting.
        assert!(serde_json::from_str::<Request>(
            r#"{"op":"remove_entry","share":"alice","path":["d"]}"#
        )
        .is_err());
    }

    #[test]
    fn there_is_no_recursive_delete_variant() {
        // The filesystem-shaped version of `there_is_no_raw_command_variant`. If someone adds an
        // operation whose blast radius the caller chooses, one of these starts parsing.
        for json in [
            r#"{"op":"remove_entry","share":"alice","path":["d"],"directory":true,"recursive":true}"#,
            r#"{"op":"remove_tree","share":"alice","path":["d"]}"#,
            r#"{"op":"remove_entry","share":"alice","path":[],"directory":true,"force":true}"#,
        ] {
            assert!(
                serde_json::from_str::<Request>(json).is_err(),
                "{json} must not deserialize"
            );
        }
    }

    #[test]
    fn a_move_names_one_share_and_cannot_name_two() {
        // Cross-dataset rename is EXDEV (ADR-0008), so a two-share move would be a copy wearing a
        // move's name. The schema has one `share` field; a request carrying a second is refused.
        assert!(serde_json::from_str::<Request>(
            r#"{"op":"move_entry","share":"alice","to_share":"bob","from":["a"],"to":["a"]}"#
        )
        .is_err());
    }

    // ── CreateDirectory ──

    #[test]
    fn a_traversing_component_cannot_be_expressed_in_a_create_directory() {
        // The type test the brief asks for, and it is a PARSE failure rather than a runtime check.
        // `Vec<SafeComponent>` has no inhabitant spelled `..`, so no code path in `create_directory`
        // can be reached with one — the `mkdirat` below it never has to remember to look, which is
        // the whole reason the operand is a type instead of a string. The same holds for the
        // `share` field: a share named `..` would be the parent of the share root.
        assert_eq!(
            SafeComponent::parse(".."),
            Err(ValidationError::ContainsDotDot)
        );
        for json in [
            r#"{"op":"create_directory","share":"alice","path":["..","etc"],"owner_uid":1,"owner_gid":1}"#,
            r#"{"op":"create_directory","share":"alice","path":["docs","..",".."],"owner_uid":1,"owner_gid":1}"#,
            r#"{"op":"create_directory","share":"alice","path":["a/b"],"owner_uid":1,"owner_gid":1}"#,
            r#"{"op":"create_directory","share":"alice","path":["a\\b"],"owner_uid":1,"owner_gid":1}"#,
            r#"{"op":"create_directory","share":"alice","path":["/etc"],"owner_uid":1,"owner_gid":1}"#,
            r#"{"op":"create_directory","share":"..","path":["docs"],"owner_uid":1,"owner_gid":1}"#,
            r#"{"op":"create_directory","share":"alice","path":[""],"owner_uid":1,"owner_gid":1}"#,
            r#"{"op":"create_directory","share":"alice","path":["-p"],"owner_uid":1,"owner_gid":1}"#,
        ] {
            assert!(
                serde_json::from_str::<Request>(json).is_err(),
                "{json} must not deserialize"
            );
        }
    }

    #[test]
    fn a_well_formed_create_directory_does_parse() {
        // The negative test above is worth nothing without this one: a parser that rejected
        // everything would pass it.
        assert!(serde_json::from_str::<Request>(
            r#"{"op":"create_directory","share":"alice","path":["docs","2026"],"owner_uid":300101,"owner_gid":302001}"#
        )
        .is_ok());
    }

    #[test]
    fn create_directory_will_not_default_its_owner_or_grow_a_recursive_flag() {
        // Omitting the owner must fail rather than mean 0. Serde would not default a `u32` here
        // anyway, but that is a property of the field's type rather than a stated intent, and this
        // is the pair whose absence produced root-owned objects the tenant cannot use.
        //
        // The `parents`/`recursive` cases are the filesystem-shaped version of
        // `there_is_no_raw_command_variant`: if somebody turns this into `mkdir -p`, one of them
        // starts parsing. `mkdir -p` would create nodes the API has no rows for.
        for json in [
            r#"{"op":"create_directory","share":"alice","path":["d"]}"#,
            r#"{"op":"create_directory","share":"alice","path":["d"],"owner_uid":300101}"#,
            r#"{"op":"create_directory","share":"alice","path":["a","b"],"owner_uid":1,"owner_gid":1,"parents":true}"#,
            r#"{"op":"create_directory","share":"alice","path":["a","b"],"owner_uid":1,"owner_gid":1,"recursive":true}"#,
            r#"{"op":"create_directory","share":"alice","path":["d"],"owner_uid":1,"owner_gid":1,"mode":511}"#,
        ] {
            assert!(
                serde_json::from_str::<Request>(json).is_err(),
                "{json} must not deserialize"
            );
        }
    }

    // ── ApplyFolderAcl ──

    #[test]
    fn an_acl_entry_cannot_name_a_user() {
        // ADR-0004's grant model, as a parse failure rather than a runtime check. If somebody adds
        // a `uid` to `AclEntry`, the first of these starts deserializing and this test fails —
        // which is the only way the decision survives the person who made it.
        for json in [
            r#"{"op":"apply_folder_acl","share":"alice","path":[],"entries":[{"uid":1001,"read":true,"write":false,"execute":true}]}"#,
            r#"{"op":"apply_folder_acl","share":"alice","path":[],"entries":[{"gid":301200,"uid":1001,"read":true,"write":false,"execute":true}]}"#,
            // A mode number instead of the three bits: silent widening if it were accepted.
            r#"{"op":"apply_folder_acl","share":"alice","path":[],"entries":[{"gid":301200,"mode":511}]}"#,
            // Every bit is required. A missing `execute` on a directory is the difference between
            // a folder the group can enter and one it cannot, so it must not default.
            r#"{"op":"apply_folder_acl","share":"alice","path":[],"entries":[{"gid":301200,"read":true,"write":false}]}"#,
            // And the path is components, not a path.
            r#"{"op":"apply_folder_acl","share":"alice","path":["..","etc"],"entries":[]}"#,
            r#"{"op":"apply_folder_acl","share":"alice","path":["a/b"],"entries":[]}"#,
            r#"{"op":"apply_folder_acl","share":"..","path":[],"entries":[]}"#,
        ] {
            assert!(
                serde_json::from_str::<Request>(json).is_err(),
                "{json} must not deserialize"
            );
        }
    }

    /// A caller that still sends `recursive` must be REFUSED, not quietly obeyed for one folder.
    ///
    /// This is the compatibility half of removing the operand, and it is a security property
    /// rather than tidiness. An API that believes it asked for a subtree and is answered
    /// `acl_applied` for a single directory records every descendant as enforced when the kernel
    /// has been told nothing about them — a grant that exists only in Postgres, which is the exact
    /// failure `ApplyFolderAcl` was added to end. `deny_unknown_fields` turns it into a parse
    /// error instead; the test exists so nobody "fixes" that by adding `#[serde(default)]`.
    #[test]
    fn the_removed_recursive_operand_is_refused_rather_than_ignored() {
        for json in [
            r#"{"op":"apply_folder_acl","share":"alice","path":["docs"],"entries":[],"recursive":true}"#,
            r#"{"op":"apply_folder_acl","share":"alice","path":["docs"],"entries":[],"recursive":false}"#,
        ] {
            assert!(
                serde_json::from_str::<Request>(json).is_err(),
                "{json} must not deserialize: a caller asking for a subtree cannot be told yes for                  one folder"
            );
        }
    }

    #[test]
    fn a_well_formed_apply_folder_acl_does_parse() {
        // The negative test above is worth nothing without this one.
        let parsed: Request = serde_json::from_str(
            r#"{"op":"apply_folder_acl","share":"alice","path":["docs"],"entries":[{"gid":301200,"read":true,"write":false,"execute":true}]}"#,
        )
        .expect("a well-formed grant");
        assert_eq!(
            parsed,
            Request::ApplyFolderAcl {
                share: SafeComponent::parse("alice").expect("valid"),
                path: vec![SafeComponent::parse("docs").expect("valid")],
                entries: vec![AclEntry {
                    gid: PosixId::parse(301_200).expect("reserved range"),
                    read: true,
                    write: false,
                    execute: true,
                }],
            }
        );
        // An empty path names the share root — a share-wide grant, which is the ordinary case.
        assert!(serde_json::from_str::<Request>(
            r#"{"op":"apply_folder_acl","share":"alice","path":[],"entries":[]}"#
        )
        .is_ok());
    }

    #[test]
    fn there_is_no_raw_command_variant() {
        // A guard against the surface being widened by accident: if someone adds a variant that
        // takes a command line, the JSON below starts parsing and this test fails.
        for json in [
            r#"{"op":"raw","command":"rm -rf /"}"#,
            r#"{"op":"exec","argv":["sh","-c","x"]}"#,
            r#"{"op":"shell","line":"zpool destroy tank"}"#,
        ] {
            let parsed: Result<Request, _> = serde_json::from_str(json);
            assert!(parsed.is_err(), "{json} must not deserialize");
        }
    }

    #[test]
    fn round_trips_through_json() {
        let req = Request::CreateDataset {
            dataset: DatasetName::parse("tank/depsis/users/1001").expect("valid"),
            acltype: AclType::Posixacl,
            refquota_bytes: Some(64 * 1024 * 1024),
        };
        let s = serde_json::to_string(&req).expect("serialize");
        let back: Request = serde_json::from_str(&s).expect("deserialize");
        assert_eq!(req, back);
    }
}
