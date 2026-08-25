//! DEPSIS system agent — core.
//!
//! This crate is the privileged side of the most important trust boundary in DEPSIS (threat
//! model TB4). The API runs unprivileged and cannot touch ZFS, Samba or SMART directly; it asks
//! the agent, and the agent decides.
//!
//! ADR-0006 is explicit that the agent runs as root and that this is not hidden. `zpool`
//! operations cannot be delegated, and `CAP_SYS_ADMIN` is root-equivalent anyway, so pretending
//! ambient capabilities buy safety here would be self-deception. Safety comes from a small
//! surface instead:
//!
//!   1. The operation set is a closed typed enum. No shell, no pass-through arguments (`op`).
//!   2. Every call is authorized against kernel-supplied peer credentials (`authz`).
//!   3. Caller-supplied names are types, not strings (`op::SafeComponent`, `op::DatasetName`),
//!      so a flag, a slash or a `..` cannot be expressed. For operations that take a path
//!      *inside* a share, `seams::SafePath` adds kernel-enforced confinement via
//!      `openat2(RESOLVE_BENEATH)`.
//!
//!      As of Phase 0 no operation in `Request` takes such a path — `ReadSmartSummary` builds
//!      `/dev/disk/by-id/<component>`, and `openat2` would be actively wrong there because a
//!      by-id name IS a symlink. `SafePath` is implemented and tested against a real kernel
//!      (the `openat2 containment` tests in `unix.rs`) ahead of Phase 1, which introduces the
//!      first operations that need it. Stating otherwise would be exactly the "two realities"
//!      this project forbids elsewhere.
//!
//!      `SafePath` hands back an OPEN FILE, never a path. An earlier version resolved with
//!      `openat2`, dropped the descriptor and returned a joined path for somebody else to open
//!      later — which uses the syscall as a check rather than as the operation, and leaves the
//!      classic TOCTOU window between the two. Nothing called it, so nothing was exploitable,
//!      but the upload path was about to be built on top of it.
//!   4. Every call is audited with identity, reason and correlation id (`audit`).
//!
//! Nothing in this file is platform-specific. That is enforced by CI, which cross-checks the
//! Windows target so a stray `cfg` cannot creep into the core.

#![forbid(unsafe_code)]

pub mod acl;
pub mod audit;
pub mod authz;
pub mod data;
pub mod disks;
pub mod dispatch;
pub mod identity;
pub mod offsite;
pub mod op;
pub mod pools;
pub mod replicate;
pub mod samba;
pub mod seams;
pub mod smart;
pub mod snapshots;
pub mod sweep;
pub mod transfer;
pub mod zerotier;

/// Emit the JSON Schema for the request/response contract.
///
/// ADR-0006: this is the source of truth for the TypeScript side. A build step turns it into a
/// committed `.d.ts` and CI fails on drift, so the unprivileged side can never define what the
/// privileged side accepts.
pub fn request_schema_json() -> String {
    let schema = schemars::schema_for!(op::Request);
    serde_json::to_string_pretty(&schema).unwrap_or_else(|_| "{}".to_string())
}

pub fn response_schema_json() -> String {
    let schema = schemars::schema_for!(op::Response);
    serde_json::to_string_pretty(&schema).unwrap_or_else(|_| "{}".to_string())
}
