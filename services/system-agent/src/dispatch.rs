//! Request dispatch — the single chokepoint every privileged operation passes through.
//!
//! Order matters and is not negotiable:
//!
//!   parse → authorize → audit(intent) → execute → audit(outcome)
//!
//! Parsing first means a malformed or flag-shaped operand is refused before any identity work,
//! and an unparseable request never reaches an executor. Auditing intent *before* execution
//! means a call that hangs or crashes the agent still left a trace of what was attempted.

use crate::audit::{self, Outcome, Sink};
use crate::authz::{Decision, Policy};
use crate::op::{AclType, Request, Response, SCHEMA_VERSION};
use crate::seams::{CommandRunner, OpenIntent, PeerIdentity, SafePath, SeamError, TokenSource};
use crate::transfer::{PendingTransfer, TransferRegistry};
use std::io::Seek;
use std::sync::Mutex;

/// Absolute paths only.
///
/// `execvp` falls back to searching `/bin:/usr/bin` when `PATH` is unset, so a relative program
/// name is a supply chain question rather than a convenience. These constants are the complete
/// set of binaries the agent will ever run.
pub mod bin {
    pub const ZFS: &str = "/usr/sbin/zfs";
    pub const ZPOOL: &str = "/usr/sbin/zpool";
    pub const SMARTCTL: &str = "/usr/sbin/smartctl";
    pub const TESTPARM: &str = "/usr/bin/testparm";
}

/// Where staging files live inside a share.
///
/// Literal components, never caller-supplied. ADR-0008 keeps staging INSIDE the destination
/// dataset so publishing is an O(1) same-dataset rename rather than a copy — a separate staging
/// dataset would mean writing every byte twice and doubling the user's quota mid-upload.
pub const STAGING_DIR: [&str; 2] = [".depsis", "staging"];

pub struct Agent<'a, R: CommandRunner, S: Sink, P: SafePath> {
    pub policy: Policy,
    pub runner: &'a R,
    pub audit: &'a S,
    /// The share tree, confined by `openat2`. `None` on a box with no storage configured yet,
    /// which is the normal state of a NAS before setup — the transfer operations then refuse,
    /// with a reason, rather than the agent refusing to start at all.
    pub paths: Option<&'a P>,
    pub tokens: &'a dyn TokenSource,
    /// Shared with the data socket's accept loop, which runs concurrently with this one. The
    /// control loop is deliberately serial (ADR-0006), but bulk transfers must not be: a 10 GB
    /// upload holding the control socket would block every other privileged call for its duration.
    pub transfers: &'a Mutex<TransferRegistry>,
}

impl<'a, R: CommandRunner, S: Sink, P: SafePath> Agent<'a, R, S, P> {
    pub fn new(
        policy: Policy,
        runner: &'a R,
        audit: &'a S,
        paths: Option<&'a P>,
        tokens: &'a dyn TokenSource,
        transfers: &'a Mutex<TransferRegistry>,
    ) -> Self {
        Self {
            policy,
            runner,
            audit,
            paths,
            tokens,
            transfers,
        }
    }

    /// Open the staging file and hand back a token for the data channel.
    ///
    /// The resolution happens HERE, once, and the descriptor is what survives. The token names
    /// that descriptor; nothing the caller sends on the data socket can change which file it
    /// writes to. That is the property which makes splitting one upload across two connections
    /// safe, and it is why the data socket takes a token rather than repeating the file name.
    fn open_transfer(&self, share: &str, staging_name: &str) -> Result<Response, SeamError> {
        let Some(paths) = self.paths else {
            return Ok(Response::Refused {
                reason: "no share root is configured; storage is not set up".to_string(),
            });
        };

        let relative = [share, STAGING_DIR[0], STAGING_DIR[1], staging_name];
        // Append, not CreateNew: tus uploads resume, and the second PATCH for one upload must
        // continue the same `.part` rather than being refused for existing.
        let mut file = paths.open(&relative, OpenIntent::Append)?;

        // Where a resumed upload continues from. Read from the file itself rather than tracked
        // separately: a number kept beside the data is a number that can disagree with it.
        let offset = file
            .seek(std::io::SeekFrom::End(0))
            .map_err(|e| SeamError::Io(format!("seek staging file: {e}")))?;

        let token = self.tokens.token();
        match self.transfers.lock() {
            Ok(mut registry) => registry.insert(
                token.clone(),
                PendingTransfer {
                    file,
                    share: share.to_string(),
                    staging_name: staging_name.to_string(),
                    opened_at: std::time::Instant::now(),
                },
            ),
            Err(_) => {
                // A poisoned mutex means another thread panicked while holding it. Refusing is
                // the honest answer: the registry's contents can no longer be reasoned about.
                return Ok(Response::Failed {
                    reason: "the transfer registry is unavailable".to_string(),
                });
            }
        }

        Ok(Response::Transfer { token, offset })
    }

    /// Move a finished staging file into place, durably.
    ///
    /// ADR-0008 steps 4 and 5. The directory fsync is the one people skip, and skipping it means
    /// a power cut can leave the data on disk with nothing pointing at it — the file survived and
    /// the rename did not.
    fn publish_transfer(
        &self,
        share: &str,
        staging_name: &str,
        destination: &[&str],
    ) -> Result<Response, SeamError> {
        let Some(paths) = self.paths else {
            return Ok(Response::Refused {
                reason: "no share root is configured; storage is not set up".to_string(),
            });
        };
        let Some((file_name, dirs)) = destination.split_last() else {
            return Ok(Response::Refused {
                reason: "destination is empty".to_string(),
            });
        };

        let staged = [share, STAGING_DIR[0], STAGING_DIR[1], staging_name];
        let size = paths
            .open(&staged, OpenIntent::Read)?
            .metadata()
            .map_err(|e| SeamError::Io(format!("stat staging file: {e}")))?
            .len();

        let mut dest_dir: Vec<&str> = vec![share];
        dest_dir.extend_from_slice(dirs);
        let staging_dir = [share, STAGING_DIR[0], STAGING_DIR[1]];

        // Rename and directory fsync in one call, so step 5 cannot be left out here.
        paths.publish(&staging_dir, staging_name, &dest_dir, file_name)?;

        Ok(Response::Publish { bytes: size })
    }

    /// Handle one raw request line.
    ///
    /// Returns a `Response` in every case, including refusal — the caller is a program, and a
    /// dropped connection is harder to diagnose than a structured refusal.
    pub fn handle(
        &self,
        raw: &str,
        peer: PeerIdentity,
        correlation_id: &str,
        reason: &str,
    ) -> Response {
        let request: Request = match serde_json::from_str(raw) {
            Ok(r) => r,
            Err(e) => {
                // No audit entry with an operation name here: we do not know what was asked,
                // and inventing one would put a fiction in an append-only log.
                return Response::Refused {
                    reason: format!("unparseable request: {e}"),
                };
            }
        };

        match self.policy.authorize(peer, &request) {
            Decision::Deny(why) => {
                self.audit.record(audit::entry(
                    correlation_id,
                    peer,
                    &request,
                    reason,
                    Outcome::Refused(why.to_string()),
                ));
                return Response::Refused {
                    reason: why.to_string(),
                };
            }
            Decision::Allow => {}
        }

        self.audit.record(audit::entry(
            correlation_id,
            peer,
            &request,
            reason,
            Outcome::Allowed,
        ));

        match self.execute(&request) {
            Ok(response) => response,
            Err(e) => {
                let msg = e.to_string();
                self.audit.record(audit::entry(
                    correlation_id,
                    peer,
                    &request,
                    reason,
                    Outcome::Failed(msg.clone()),
                ));
                Response::Failed { reason: msg }
            }
        }
    }

    fn execute(&self, request: &Request) -> Result<Response, SeamError> {
        match request {
            Request::Ping {} => Ok(Response::Ok {
                schema_version: SCHEMA_VERSION,
            }),

            Request::PoolStatus { pool } => {
                // -H -p: script-parsable, exact byte counts. Never statvfs (ADR-0008, P0-G).
                let out = self.runner.run(
                    bin::ZFS,
                    &["get", "-Hp", "-o", "value", "used,available", pool.as_str()],
                )?;
                let mut it = out.split_whitespace();
                let used = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
                let available = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
                let health = self
                    .runner
                    .run(bin::ZPOOL, &["list", "-H", "-o", "health", pool.as_str()])?
                    .trim()
                    .to_string();
                Ok(Response::PoolStatus {
                    health,
                    used_bytes: used,
                    available_bytes: available,
                })
            }

            Request::CreateDataset {
                dataset,
                acltype,
                refquota_bytes,
            } => {
                let acl = match acltype {
                    // The only variant that exists. P0-B measured that `nfsv4` reports itself
                    // as configured while enforcing nothing, so it is unrepresentable in `op`.
                    AclType::Posixacl => "acltype=posixacl",
                };
                let quota;
                let mut args: Vec<&str> = vec![
                    "create",
                    "-o",
                    acl,
                    "-o",
                    "xattr=sa",
                    "-o",
                    "dnodesize=auto",
                ];
                if let Some(bytes) = refquota_bytes {
                    quota = format!("refquota={bytes}");
                    args.push("-o");
                    args.push(&quota);
                }
                args.push(dataset.as_str());
                self.runner.run(bin::ZFS, &args)?;

                // Verify rather than assume. P0-B: acltype=nfsv4 sets cleanly and reports
                // itself back, so "the create command succeeded" proves nothing about whether
                // ACLs work. Read the property and refuse to hand over a dataset that would
                // silently enforce nothing.
                let got = self
                    .runner
                    .run(
                        bin::ZFS,
                        &["get", "-H", "-o", "value", "acltype", dataset.as_str()],
                    )?
                    .trim()
                    .to_string();
                // `posixacl` reads back as `posix` — a documented alias, measured in P0-A.
                if !matches!(got.as_str(), "posixacl" | "posix") {
                    return Ok(Response::Failed {
                        reason: format!(
                            "dataset created but acltype reads back as {got:?}; refusing to \
                             publish a dataset that may enforce no ACLs at all"
                        ),
                    });
                }
                Ok(Response::Created {
                    dataset: dataset.as_str().to_string(),
                })
            }

            Request::CreateSnapshot { dataset, name } => {
                let full = format!("{}@{}", dataset.as_str(), name.as_str());
                self.runner.run(bin::ZFS, &["snapshot", &full])?;
                Ok(Response::Snapshot { full_name: full })
            }

            Request::DiffSnapshots { dataset, from, to } => {
                let a = format!("{}@{}", dataset.as_str(), from.as_str());
                let b = format!("{}@{}", dataset.as_str(), to.as_str());
                // -H tab-separated, -F include file type. R lines carry both paths, which is
                // what lets reconciliation see a rename as a rename (ADR-0011, P0-D).
                let out = self.runner.run(bin::ZFS, &["diff", "-H", "-F", &a, &b])?;
                Ok(Response::Diff {
                    lines: out.lines().map(str::to_string).collect(),
                })
            }

            Request::ReadSmartSummary { disk_by_id } => {
                // Built from a validated single component, so the caller cannot reach outside
                // /dev/disk/by-id or smuggle a flag (risk R1).
                let path = format!("/dev/disk/by-id/{}", disk_by_id.as_str());
                let out = self
                    .runner
                    .run(bin::SMARTCTL, &["-H", "-A", "--json=c", &path])?;
                let healthy = out.contains("\"passed\": true") || out.contains("PASSED");
                Ok(Response::Smart {
                    healthy,
                    temperature_celsius: None,
                    raw: out,
                })
            }

            Request::OpenTransfer {
                share,
                staging_name,
            } => self.open_transfer(share.as_str(), staging_name.as_str()),

            Request::PublishTransfer {
                share,
                staging_name,
                destination,
            } => {
                let dest: Vec<&str> = destination.iter().map(|c| c.as_str()).collect();
                self.publish_transfer(share.as_str(), staging_name.as_str(), &dest)
            }

            Request::PublishSambaConfig { shares } => {
                // testparm is necessary but NOT sufficient. P0-B measured an invalid
                // full_audit opname passing testparm cleanly and then making smbd refuse every
                // connection. The real implementation must follow this with a live connection
                // smoke test and roll back on failure (§17); this skeleton stops at validation
                // and says so rather than pretending the gate is complete.
                self.runner
                    .run(bin::TESTPARM, &["-s", "--suppress-prompt"])?;
                Ok(Response::Published {
                    shares: shares.len(),
                })
            }
        }
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
    use crate::audit::MemorySink;
    use crate::seams::mock::{MockCommandRunner, MockSafePath, MockTokenSource};

    const API_UID: u32 = 999;

    fn peer(uid: u32) -> PeerIdentity {
        PeerIdentity {
            uid,
            gid: uid,
            pid: 4242,
        }
    }

    /// The collaborators every dispatch test needs.
    ///
    /// A struct rather than five arguments: the transfer registry and the share root have to
    /// outlive the `Agent` that borrows them, and returning the `Agent` alone would borrow
    /// temporaries that die at the end of the call.
    struct Harness {
        transfers: Mutex<TransferRegistry>,
        tokens: MockTokenSource,
        root: tempfile::TempDir,
        paths: Option<MockSafePath>,
    }

    impl Harness {
        /// No share root: the state of a box before storage is set up.
        fn bare() -> Self {
            let root = tempfile::tempdir().expect("tempdir");
            Self {
                transfers: Mutex::new(TransferRegistry::new()),
                tokens: MockTokenSource::default(),
                root,
                paths: None,
            }
        }

        /// A share root with `<share>/.depsis/staging` already in place.
        fn with_share(share: &str) -> Self {
            let root = tempfile::tempdir().expect("tempdir");
            let staging = root
                .path()
                .join(share)
                .join(STAGING_DIR[0])
                .join(STAGING_DIR[1]);
            std::fs::create_dir_all(&staging).expect("mkdir staging");
            let paths = Some(MockSafePath::new(root.path()));
            Self {
                transfers: Mutex::new(TransferRegistry::new()),
                tokens: MockTokenSource::default(),
                root,
                paths,
            }
        }

        fn share_path(&self, parts: &[&str]) -> std::path::PathBuf {
            let mut p = self.root.path().to_path_buf();
            for part in parts {
                p.push(part);
            }
            p
        }

        fn agent<'a, R: CommandRunner, S: Sink>(
            &'a self,
            runner: &'a R,
            sink: &'a S,
        ) -> Agent<'a, R, S, MockSafePath> {
            Agent::new(
                Policy { api_uid: API_UID },
                runner,
                sink,
                self.paths.as_ref(),
                &self.tokens,
                &self.transfers,
            )
        }
    }

    fn agent<'a, R: CommandRunner, S: Sink>(
        runner: &'a R,
        sink: &'a S,
        harness: &'a Harness,
    ) -> Agent<'a, R, S, MockSafePath> {
        harness.agent(runner, sink)
    }

    #[test]
    fn ping_reports_the_schema_version() {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp =
            agent(&r, &s, &h).handle(r#"{"op":"ping"}"#, peer(API_UID), "c1", "health check");
        assert_eq!(
            resp,
            Response::Ok {
                schema_version: SCHEMA_VERSION
            }
        );
    }

    #[test]
    fn a_free_form_command_is_refused_and_runs_nothing() {
        // The headline property of TB4: there is no way to ask the agent to run a command.
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"exec","argv":["/bin/sh","-c","zpool destroy tank"]}"#,
            peer(API_UID),
            "c2",
            "attack",
        );
        assert!(matches!(resp, Response::Refused { .. }));
        assert!(r.calls.borrow().is_empty(), "nothing may be executed");
    }

    #[test]
    fn an_unauthorized_uid_is_refused_and_audited() {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(r#"{"op":"ping"}"#, peer(1000), "c3", "probe");
        assert!(matches!(resp, Response::Refused { .. }));
        assert!(r.calls.borrow().is_empty());
        let entries = s.entries.borrow();
        assert_eq!(entries.len(), 1);
        assert!(matches!(entries[0].outcome, Outcome::Refused(_)));
        assert_eq!(entries[0].uid, 1000);
    }

    #[test]
    fn a_dataset_name_shaped_like_a_flag_never_reaches_the_runner() {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"create_snapshot","dataset":"-R","name":"s1"}"#,
            peer(API_UID),
            "c4",
            "snapshot",
        );
        assert!(matches!(resp, Response::Refused { .. }));
        assert!(r.calls.borrow().is_empty());
    }

    #[test]
    fn create_dataset_always_passes_posixacl_and_sa() {
        let r = MockCommandRunner::with_responses(["".into(), "posix".into()]);
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"create_dataset","dataset":"tank/u/1","acltype":"posixacl","refquota_bytes":1048576}"#,
            peer(API_UID),
            "c5",
            "provision user",
        );
        assert!(matches!(resp, Response::Created { .. }));
        let argv = r.call(0).expect("create was run");
        assert_eq!(argv[0], bin::ZFS);
        assert!(argv.contains(&"acltype=posixacl".to_string()));
        assert!(argv.contains(&"xattr=sa".to_string()));
        assert!(argv.contains(&"refquota=1048576".to_string()));
        assert!(!argv.iter().any(|a| a.contains("nfsv4")));
    }

    #[test]
    fn create_dataset_refuses_to_publish_when_acltype_reads_back_wrong() {
        // The measured failure mode: the create succeeds and the property reports itself as
        // configured while enforcing nothing. Verification, not optimism.
        let r = MockCommandRunner::with_responses(["".into(), "nfsv4".into()]);
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"create_dataset","dataset":"tank/u/2","acltype":"posixacl"}"#,
            peer(API_UID),
            "c6",
            "provision user",
        );
        match resp {
            Response::Failed { reason } => assert!(reason.contains("nfsv4")),
            other => panic!("expected refusal to publish, got {other:?}"),
        }
    }

    #[test]
    fn smart_reads_are_confined_to_dev_disk_by_id() {
        let r = MockCommandRunner::with_responses(["PASSED".into()]);
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"read_smart_summary","disk_by_id":"wwn-0x600224801b119da9"}"#,
            peer(API_UID),
            "c7",
            "telemetry",
        );
        assert!(matches!(resp, Response::Smart { healthy: true, .. }));
        let argv = r.call(0).expect("smartctl was run");
        assert!(argv
            .last()
            .expect("path arg")
            .starts_with("/dev/disk/by-id/"));
    }

    #[test]
    fn a_smart_read_cannot_be_pointed_at_an_arbitrary_device() {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        for evil in [
            r#"{"op":"read_smart_summary","disk_by_id":"../../dev/sda"}"#,
            r#"{"op":"read_smart_summary","disk_by_id":"-d"}"#,
        ] {
            let resp = agent(&r, &s, &h).handle(evil, peer(API_UID), "c8", "attack");
            assert!(matches!(resp, Response::Refused { .. }), "{evil}");
        }
        assert!(r.calls.borrow().is_empty());
    }

    #[test]
    fn every_executed_program_is_an_absolute_path() {
        let r = MockCommandRunner::with_responses(["1024 2048".into(), "ONLINE".into()]);
        let s = MemorySink::default();
        let h = Harness::bare();
        agent(&r, &s, &h).handle(
            r#"{"op":"pool_status","pool":"tank"}"#,
            peer(API_UID),
            "c9",
            "telemetry",
        );
        for argv in r.calls.borrow().iter() {
            assert!(
                argv[0].starts_with('/'),
                "program {:?} must be absolute — execvp falls back to /bin:/usr/bin",
                argv[0]
            );
        }
    }

    #[test]
    fn the_audit_entry_carries_identity_and_correlation_id() {
        let r = MockCommandRunner::with_responses(["".into()]);
        let s = MemorySink::default();
        let h = Harness::bare();
        agent(&r, &s, &h).handle(
            r#"{"op":"create_snapshot","dataset":"tank/u/1","name":"nightly"}"#,
            peer(API_UID),
            "corr-abc",
            "scheduled snapshot",
        );
        let entries = s.entries.borrow();
        let e = entries.first().expect("an entry was recorded");
        assert_eq!(e.correlation_id, "corr-abc");
        assert_eq!(e.uid, API_UID);
        assert_eq!(e.pid, 4242);
        assert_eq!(e.operation, "create_snapshot");
        assert_eq!(e.reason, "scheduled snapshot");
    }

    #[test]
    fn an_unparseable_request_is_not_audited_under_an_invented_operation() {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle("{not json", peer(API_UID), "c10", "junk");
        assert!(matches!(resp, Response::Refused { .. }));
        // An append-only log must not contain a guess about what was asked.
        assert!(s.entries.borrow().is_empty());
    }
    // ── transfers ──
    //
    // The bulk data path's control half. The byte-carrying socket is separate; these settle what
    // the control channel does, which is where the confinement decision is made.

    fn open_transfer(h: &Harness, share: &str, name: &str) -> Response {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let raw = format!(r#"{{"op":"open_transfer","share":"{share}","staging_name":"{name}"}}"#);
        h.agent(&r, &s)
            .handle(&raw, peer(API_UID), "c-transfer", "upload")
    }

    #[test]
    fn opening_a_transfer_creates_the_staging_file_and_returns_a_token() {
        let h = Harness::with_share("alice");

        match open_transfer(&h, "alice", "u1.part") {
            Response::Transfer { token, offset } => {
                assert_eq!(token, "token-1", "the mock source mints predictable tokens");
                assert_eq!(offset, 0, "a new upload starts at zero");
            }
            other => panic!("expected a transfer, got {other:?}"),
        }

        assert!(
            h.share_path(&["alice", ".depsis", "staging", "u1.part"])
                .exists(),
            "the staging file must exist once a transfer is open"
        );
    }

    #[test]
    fn a_resumed_transfer_reports_where_to_continue() {
        // tus resumes. The second PATCH for one upload must continue the same `.part` rather than
        // being refused for existing, and the offset has to come from the FILE — a number tracked
        // beside the data is a number that can disagree with it.
        let h = Harness::with_share("alice");
        std::fs::write(
            h.share_path(&["alice", ".depsis", "staging", "u2.part"]),
            b"twelve bytes",
        )
        .expect("seed a partial upload");

        match open_transfer(&h, "alice", "u2.part") {
            Response::Transfer { offset, .. } => assert_eq!(offset, 12),
            other => panic!("expected a transfer, got {other:?}"),
        }
    }

    #[test]
    fn a_transfer_is_refused_when_no_share_root_is_configured() {
        // The state of a NAS before setup. Refused with a reason, not silently missing — and the
        // agent still starts, because the operations that SET UP storage run through it.
        let h = Harness::bare();
        match open_transfer(&h, "alice", "u.part") {
            Response::Refused { reason } => assert!(reason.contains("no share root")),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn a_transfer_cannot_name_a_share_outside_the_root() {
        // `SafeComponent` refuses this at parse time, before any path work — which is the point of
        // typing the operand rather than checking it later.
        let h = Harness::with_share("alice");
        match open_transfer(&h, "../etc", "u.part") {
            Response::Refused { reason } => assert!(reason.contains("unparseable")),
            other => panic!("expected a parse refusal, got {other:?}"),
        }
    }

    #[test]
    fn publishing_moves_the_file_and_refuses_to_overwrite() {
        let h = Harness::with_share("alice");
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        std::fs::write(
            h.share_path(&["alice", ".depsis", "staging", "done.part"]),
            b"final contents",
        )
        .expect("stage");

        let raw = r#"{"op":"publish_transfer","share":"alice","staging_name":"done.part","destination":["report.txt"]}"#;
        match h
            .agent(&r, &s)
            .handle(raw, peer(API_UID), "c-pub", "publish")
        {
            Response::Publish { bytes } => assert_eq!(bytes, 14),
            other => panic!("expected a publish, got {other:?}"),
        }

        assert!(
            h.share_path(&["alice", "report.txt"]).exists(),
            "the file must be where the user asked for it"
        );
        assert!(
            !h.share_path(&["alice", ".depsis", "staging", "done.part"])
                .exists(),
            "and gone from staging"
        );

        // A second publish onto the same name must lose. Publishing is not allowed to destroy a
        // file the user already has, which is why the real implementation uses RENAME_NOREPLACE.
        std::fs::write(
            h.share_path(&["alice", ".depsis", "staging", "again.part"]),
            b"different",
        )
        .expect("stage again");
        let raw2 = r#"{"op":"publish_transfer","share":"alice","staging_name":"again.part","destination":["report.txt"]}"#;
        match h
            .agent(&r, &s)
            .handle(raw2, peer(API_UID), "c-pub2", "publish")
        {
            Response::Failed { reason } => assert!(reason.contains("already exists")),
            other => panic!("expected a refusal to overwrite, got {other:?}"),
        }
        assert_eq!(
            std::fs::read(h.share_path(&["alice", "report.txt"])).expect("read"),
            b"final contents",
            "the original must be untouched"
        );
    }

    #[test]
    fn a_transfer_is_audited_under_its_own_name() {
        // §16: a privileged call has to be explicable afterwards, and "open_transfer" is what the
        // journal should say — not a generic name that makes every upload look the same.
        let h = Harness::with_share("alice");
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let raw = r#"{"op":"open_transfer","share":"alice","staging_name":"a.part"}"#;
        h.agent(&r, &s)
            .handle(raw, peer(API_UID), "c-audit", "upload for job 7");

        let entries = s.entries.borrow();
        assert!(
            entries.iter().any(|e| e.operation == "open_transfer"),
            "the audit trail must name the operation, got {entries:?}"
        );
        assert!(
            entries.iter().any(|e| e.reason == "upload for job 7"),
            "and carry the caller's reason"
        );
    }
}
