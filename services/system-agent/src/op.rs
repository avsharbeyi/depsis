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
        /// The agent refuses uid or gid 0. Not because a root-owned file in a share is a privilege
        /// escalation — it is not, the mode is 0600 and nothing is setuid — but because it is
        /// precisely the broken state these two fields exist to fix, and an API that omits the
        /// mapping should fail loudly rather than reproduce the bug.
        owner_uid: u32,
        owner_gid: u32,
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
    Published {
        shares: usize,
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
/// 2 as of the ZeroTier work: `Request` gained four variants and `Response` five, and the point of
/// the check is that a NEW API against an OLD agent fails at the handshake, while someone is
/// watching a deployment. Without the bump the pair shakes hands cleanly and the mismatch surfaces
/// on the first `ZeroTierJoin` as a generic refusal — a message from which nobody concludes "the
/// agent binary is stale". `EXPECTED_SCHEMA_VERSION` in `packages/agent-protocol` moves with it;
/// they are one number in two languages.
pub const SCHEMA_VERSION: u32 = 2;

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
