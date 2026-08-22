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
    Refused {
        reason: String,
    },
    Failed {
        reason: String,
    },
}

/// Bumped whenever `Request` or `Response` changes shape. The API checks it on connect.
pub const SCHEMA_VERSION: u32 = 1;

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
