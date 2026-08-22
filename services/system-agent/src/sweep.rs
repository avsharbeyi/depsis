//! Reclaiming abandoned staging files.
//!
//! This is the piece that makes `.depsis/staging` a buffer rather than a leak, and it is also the
//! most dangerous code in the crate: a loop, in a process running as root, that unlinks files it
//! did not create. Everything below is shaped by that.
//!
//! WHY IT HAS TO BE HERE, in the agent, and not a `systemd .timer` running a script. Only this
//! process holds both halves of the question. The share root descriptor is here, so a sweep can
//! stay inside `openat2(RESOLVE_BENEATH)` instead of walking paths as root; and the transfer
//! registry is here, so "old" can be told apart from "old but streaming right now". An external
//! collector looking at mtime has neither: a resumable upload that has been paused for a day looks
//! exactly like litter, and a large chunk still being written has an mtime that stopped advancing
//! the moment the client stalled. It would eventually delete a live upload, and the user would see
//! a truncated file with no error anywhere.
//!
//! WHY IT IS DANGEROUS ANYWAY, stated rather than left implicit: the age cutoff below has to be
//! longer than the upload lifetime the API advertises to clients. If the API tells a tus client its
//! upload is resumable for 48 hours and this is set to 24, the agent deletes uploads the API
//! promised to keep, and the client's next PATCH resumes into a file that no longer exists. That
//! coupling cannot be enforced from inside this file; it is checked at startup against the one
//! number the agent does know, and otherwise it is written here so the next person changing either
//! side finds it.

use std::time::Duration;

use crate::audit::{Entry, Outcome, Sink};
use crate::dispatch::STAGING_DIR;
use crate::seams::{PeerIdentity, SafePath, SeamError};
use crate::transfer::{TransferRegistry, TRANSFER_TTL};

/// How long an untouched staging file survives, unless configured otherwise.
///
/// A day, because a resumable upload is allowed to be paused overnight and the cost of being wrong
/// in this direction is disk while the cost of being wrong in the other is the user's data.
pub const DEFAULT_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// The shortest age the sweeper will accept.
///
/// An hour, and the check exists because the failure it prevents is silent. A cutoff of minutes
/// looks like a tidy configuration and deletes chunks out from under clients that are still
/// uploading them; the client sees its next PATCH land at offset zero and reports a corrupt file.
/// `TRANSFER_TTL` is the floor below which it would be provably wrong — a transfer can sit unopened
/// for that long by design — so the accepted minimum is comfortably above it.
pub const MIN_MAX_AGE: Duration = Duration::from_secs(60 * 60);

/// How often the sweep runs.
///
/// Rare on purpose. The work is proportional to the number of shares and the litter in them, and
/// nothing here is urgent: a file that has been abandoned for a day can wait another ten minutes.
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(10 * 60);

/// The identity recorded for a sweep. There is no peer: the agent did this on its own.
///
/// pid is this process; uid is 0 because that is the truth. §16 asks who did a privileged thing,
/// and "the agent's own housekeeping" is a real and distinguishable answer.
fn self_identity() -> PeerIdentity {
    PeerIdentity {
        uid: 0,
        gid: 0,
        #[allow(
            clippy::cast_possible_wrap,
            reason = "A pid does not exceed i32::MAX on Linux; PeerIdentity holds i32 because that \
                      is what SO_PEERCRED gives, and this is the same number from the other side."
        )]
        pid: std::process::id() as i32,
    }
}

/// Validate a configured age, or say why not.
pub fn checked_max_age(configured: Duration) -> Result<Duration, SeamError> {
    if configured < MIN_MAX_AGE {
        return Err(SeamError::Io(format!(
            "a staging max age of {}s is below the {}s minimum; a short cutoff deletes uploads \
             clients are still resuming (TRANSFER_TTL alone is {}s)",
            configured.as_secs(),
            MIN_MAX_AGE.as_secs(),
            TRANSFER_TTL.as_secs()
        )));
    }
    Ok(configured)
}

/// What one pass did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SweepReport {
    pub removed: usize,
    /// Files old enough to remove that were left alone because a transfer names them.
    pub spared: usize,
    /// Shares that could not be read. Counted rather than fatal: one unreadable share must not
    /// stop the others being cleaned.
    pub unreadable: usize,
}

/// One pass over every share.
///
/// Never returns `Err` for a problem with an individual share. A sweeper that gives up on the first
/// unreadable directory cleans nothing on a box where one share is broken, and the breakage it
/// stops for is exactly the kind that comes with litter.
pub fn sweep_once<P: SafePath, S: Sink>(
    paths: &P,
    transfers: &std::sync::Mutex<TransferRegistry>,
    audit: &S,
    max_age: Duration,
) -> SweepReport {
    let mut report = SweepReport::default();

    let shares = match paths.list_dirs(&[]) {
        Ok(shares) => shares,
        Err(e) => {
            eprintln!("depsis-agent: sweep could not list the share root: {e}");
            report.unreadable = report.unreadable.saturating_add(1);
            return report;
        }
    };

    for share in shares {
        let staging = [share.as_str(), STAGING_DIR[0], STAGING_DIR[1]];
        let stale = match paths.list_stale_files(&staging, max_age) {
            Ok(names) => names,
            // A share with no `.depsis/staging` has never had an upload. Ordinary, not a problem.
            Err(_) => continue,
        };

        for name in stale {
            // Asked FRESH for every file, not once for the directory. A data connection can start
            // between two iterations of this loop, and the window between a stale listing and an
            // unlink is exactly where a live upload would be destroyed.
            let busy = {
                let registry = transfers
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                registry.is_busy(&share, &name)
            };
            if busy {
                report.spared = report.spared.saturating_add(1);
                continue;
            }

            let outcome = match paths.remove_file(&staging, &name) {
                Ok(true) => {
                    report.removed = report.removed.saturating_add(1);
                    Outcome::Allowed
                }
                // Someone else got there first — a `DiscardTransfer`, or the previous pass. The job
                // is done either way, and recording it as a failure would make a clean box look
                // like a broken one.
                Ok(false) => continue,
                Err(e) => Outcome::Failed(e.to_string()),
            };

            // Every deletion, individually. A root daemon that removes a user's file and leaves no
            // record of it is the thing §16 exists to forbid, and "it was only staging" is not an
            // answer anyone can verify after the fact.
            audit.record(Entry {
                correlation_id: "sweep".to_string(),
                uid: self_identity().uid,
                pid: self_identity().pid,
                operation: "sweep_staging",
                reason: format!(
                    "{share}/{name} was untouched for more than {}s",
                    max_age.as_secs()
                ),
                outcome,
            });
        }
    }

    report
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "The crate-level denials exist because a panic in a root daemon is a denial of \
              service on the one component that cannot be restarted casually. In tests the \
              opposite is true: a failed assertion SHOULD panic."
)]
mod tests {
    use super::*;
    use crate::audit::MemorySink;
    use crate::seams::mock::MockSafePath;
    use crate::transfer::PendingTransfer;
    use std::sync::Mutex;
    use std::time::Instant;

    const API: PeerIdentity = PeerIdentity {
        uid: 999,
        gid: 999,
        pid: 4242,
    };

    /// A share root with `alice/.depsis/staging`, and files whose mtime the test controls.
    fn tree(files: &[(&str, bool)]) -> (tempfile::TempDir, MockSafePath) {
        let dir = tempfile::tempdir().expect("tempdir");
        let staging = dir.path().join("alice").join(".depsis").join("staging");
        std::fs::create_dir_all(&staging).expect("staging");
        for (name, old) in files {
            let path = staging.join(name);
            std::fs::write(&path, b"x").expect("seed");
            if *old {
                // Two days back, comfortably past DEFAULT_MAX_AGE.
                let when = std::time::SystemTime::now() - Duration::from_secs(2 * 24 * 60 * 60);
                let file = std::fs::File::options()
                    .write(true)
                    .open(&path)
                    .expect("reopen");
                file.set_modified(when).expect("set mtime");
            }
        }
        let paths = MockSafePath::new(dir.path());
        (dir, paths)
    }

    #[test]
    fn an_abandoned_chunk_is_reclaimed_and_a_fresh_one_is_not() {
        // The whole point. `.depsis/staging` counts against the user's refquota and is invisible to
        // them, so litter here is quota the user cannot see and cannot free.
        let (dir, paths) = tree(&[("old.part", true), ("new.part", false)]);
        let transfers = Mutex::new(TransferRegistry::new());
        let audit = MemorySink::default();

        let report = sweep_once(&paths, &transfers, &audit, DEFAULT_MAX_AGE);

        assert_eq!(report.removed, 1);
        let staging = dir.path().join("alice/.depsis/staging");
        assert!(!staging.join("old.part").exists());
        assert!(
            staging.join("new.part").exists(),
            "a chunk written minutes ago belongs to an upload in progress"
        );
    }

    #[test]
    fn an_old_file_that_a_transfer_still_names_is_spared() {
        // The reason this runs in the agent rather than in a systemd timer. mtime alone cannot tell
        // "abandoned" from "opened and waiting for its data connection" — and a resumable upload
        // paused overnight looks identical to litter from the outside.
        let (dir, paths) = tree(&[("held.part", true)]);
        let mut registry = TransferRegistry::new();
        let file =
            std::fs::File::open(dir.path().join("alice/.depsis/staging/held.part")).expect("open");
        registry
            .insert(
                "tok".to_string(),
                PendingTransfer {
                    file,
                    share: "alice".to_string(),
                    staging_name: "held.part".to_string(),
                    opened_by: API,
                    correlation_id: "c".to_string(),
                    reason: "resumed upload".to_string(),
                    opened_at: Instant::now(),
                },
            )
            .expect("insert");
        let transfers = Mutex::new(registry);
        let audit = MemorySink::default();

        let report = sweep_once(&paths, &transfers, &audit, DEFAULT_MAX_AGE);

        assert_eq!(report.removed, 0);
        assert_eq!(report.spared, 1);
        assert!(dir.path().join("alice/.depsis/staging/held.part").exists());
    }

    #[test]
    fn every_reclaimed_file_leaves_a_journal_entry() {
        // A root daemon deleting a user's file with no record of it is what §16 forbids, and "it
        // was only staging" is not something anyone can verify afterwards.
        let (_dir, paths) = tree(&[("a.part", true), ("b.part", true)]);
        let transfers = Mutex::new(TransferRegistry::new());
        let audit = MemorySink::default();

        sweep_once(&paths, &transfers, &audit, DEFAULT_MAX_AGE);

        let entries = audit.entries();
        assert_eq!(entries.len(), 2);
        for entry in entries.iter() {
            assert_eq!(entry.operation, "sweep_staging");
            assert_eq!(entry.outcome, Outcome::Allowed);
            assert!(
                entry.reason.contains("untouched for more than"),
                "the entry must say why the file was old enough: {}",
                entry.reason
            );
        }
    }

    #[test]
    fn a_share_without_a_staging_directory_does_not_stop_the_others() {
        // One broken or brand-new share must not mean nothing gets cleaned, because the boxes with
        // litter are exactly the boxes where something is already odd.
        // The empty share sorts FIRST, and the name is chosen for that rather than by accident.
        // With `bob` here this test passed even against a sweeper mutated to abandon the whole pass
        // on the first unreadable share: `alice` had already been cleaned by then, so the assertion
        // below was satisfied by an implementation that gives up. A mutation run caught it.
        let (dir, paths) = tree(&[("old.part", true)]);
        std::fs::create_dir_all(dir.path().join("aaa-no-uploads-yet"))
            .expect("a share with no uploads yet");
        let transfers = Mutex::new(TransferRegistry::new());
        let audit = MemorySink::default();

        let report = sweep_once(&paths, &transfers, &audit, DEFAULT_MAX_AGE);

        assert_eq!(report.removed, 1);
        assert_eq!(report.unreadable, 0);
    }

    #[test]
    fn a_cutoff_short_enough_to_delete_live_uploads_is_refused() {
        // Silent failure otherwise: a cutoff of minutes reads as a tidy configuration and removes
        // chunks out from under clients still uploading them. The client's next PATCH lands at
        // offset zero and it reports a corrupt file.
        assert!(checked_max_age(Duration::from_secs(60)).is_err());
        assert!(checked_max_age(TRANSFER_TTL).is_err());
        assert_eq!(
            checked_max_age(DEFAULT_MAX_AGE).expect("the default must be acceptable"),
            DEFAULT_MAX_AGE
        );
        assert!(
            MIN_MAX_AGE > TRANSFER_TTL,
            "the accepted minimum must exceed the time a transfer may legitimately sit unopened"
        );
    }
}
