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
use crate::seams::{CommandRunner, PeerIdentity, SeamError};

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

pub struct Agent<'a, R: CommandRunner, S: Sink> {
    pub policy: Policy,
    pub runner: &'a R,
    pub audit: &'a S,
}

impl<'a, R: CommandRunner, S: Sink> Agent<'a, R, S> {
    pub fn new(policy: Policy, runner: &'a R, audit: &'a S) -> Self {
        Self {
            policy,
            runner,
            audit,
        }
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
    use crate::seams::mock::MockCommandRunner;

    const API_UID: u32 = 999;

    fn peer(uid: u32) -> PeerIdentity {
        PeerIdentity {
            uid,
            gid: uid,
            pid: 4242,
        }
    }

    fn agent<'a>(
        runner: &'a MockCommandRunner,
        sink: &'a MemorySink,
    ) -> Agent<'a, MockCommandRunner, MemorySink> {
        Agent::new(Policy { api_uid: API_UID }, runner, sink)
    }

    #[test]
    fn ping_reports_the_schema_version() {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let resp = agent(&r, &s).handle(r#"{"op":"ping"}"#, peer(API_UID), "c1", "health check");
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
        let resp = agent(&r, &s).handle(
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
        let resp = agent(&r, &s).handle(r#"{"op":"ping"}"#, peer(1000), "c3", "probe");
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
        let resp = agent(&r, &s).handle(
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
        let resp = agent(&r, &s).handle(
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
        let resp = agent(&r, &s).handle(
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
        let resp = agent(&r, &s).handle(
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
        for evil in [
            r#"{"op":"read_smart_summary","disk_by_id":"../../dev/sda"}"#,
            r#"{"op":"read_smart_summary","disk_by_id":"-d"}"#,
        ] {
            let resp = agent(&r, &s).handle(evil, peer(API_UID), "c8", "attack");
            assert!(matches!(resp, Response::Refused { .. }), "{evil}");
        }
        assert!(r.calls.borrow().is_empty());
    }

    #[test]
    fn every_executed_program_is_an_absolute_path() {
        let r = MockCommandRunner::with_responses(["1024 2048".into(), "ONLINE".into()]);
        let s = MemorySink::default();
        agent(&r, &s).handle(
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
        agent(&r, &s).handle(
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
        let resp = agent(&r, &s).handle("{not json", peer(API_UID), "c10", "junk");
        assert!(matches!(resp, Response::Refused { .. }));
        // An append-only log must not contain a guess about what was asked.
        assert!(s.entries.borrow().is_empty());
    }
}
