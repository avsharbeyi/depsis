//! Replication: `zfs send` into `zfs recv`, onto a second dataset on this appliance.
//!
//! WHAT THIS IS NOT. It is not replication to another MACHINE. That needs a transport (SSH), a
//! credential store, host-key verification and a failure model for a link that goes away mid-send
//! — a trust surface of its own, and none of it can be exercised on a box with one pool. What it
//! is, is the target a two-pool NAS actually has: a second set of disks, so that losing the first
//! set is not losing the data. `docs/bilinen-sinirlamalar.md` says which half is missing.
//!
//! THE TARGET IS WHERE THE DANGER IS. `zfs recv -F` DESTROYS whatever is at the destination and
//! any snapshots newer than the common base. Pointed at the share dataset it would erase every
//! tenant's files, and it is one mistyped operand away from that. So the refusals below are not
//! validation in the ordinary sense — they are the difference between a backup and a wipe, and
//! §8.1's confirmation sequence sits in front of them in the API as well.

use crate::seams::SeamError;

/// Why a replication was refused before anything ran.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// Source and target name the same dataset.
    SameDataset,
    /// The target is inside the source, or the source inside the target.
    ///
    /// `tank/a` → `tank/a/backup` reads its own destination as it writes; the reverse destroys the
    /// source's parent. Neither is a transfer anyone asked for.
    Nested,
    /// The target is the dataset DEPSIS serves shares from.
    ///
    /// The single most destructive mistake available here, and the one a hurried operator makes:
    /// `recv -F` onto the share root erases every tenant's files. Refused by name rather than left
    /// to the confirmation dialogue, because a dialogue is a thing people click through.
    TargetIsShareRoot,
    /// The target is inside the share tree.
    ///
    /// Same argument one level down: a dataset under the share root holds somebody's files.
    TargetInsideShares,
}

impl Refusal {
    pub fn reason(&self) -> &'static str {
        match self {
            Self::SameDataset => "the source and the target are the same dataset",
            Self::Nested => "the source and the target contain one another",
            Self::TargetIsShareRoot => {
                "the target is the dataset DEPSIS serves shares from; receiving onto it would \
                 destroy every share"
            }
            Self::TargetInsideShares => {
                "the target is inside the share tree; receiving onto it would destroy files"
            }
        }
    }
}

/// Is `inner` the same as `outer`, or below it?
///
/// Compared COMPONENT-WISE, not as a string prefix. `tank/backups` starts with `tank/back` as text
/// while being a completely unrelated dataset, and a prefix test would refuse a legitimate target
/// or — worse, in the other direction — accept a nested one that merely spelled differently.
fn within(inner: &str, outer: &str) -> bool {
    inner == outer || inner.starts_with(&format!("{outer}/"))
}

/// Check a replication before any process is spawned.
///
/// `share_root_dataset` is what the agent is configured to serve shares from, or `None` when it
/// serves none. `None` DOES NOT relax the check into "anything goes" — it removes two refusals that
/// have nothing to compare against, and the other two still apply.
pub fn check(source: &str, target: &str, share_root_dataset: Option<&str>) -> Result<(), Refusal> {
    if source == target {
        return Err(Refusal::SameDataset);
    }
    if within(target, source) || within(source, target) {
        return Err(Refusal::Nested);
    }
    if let Some(shares) = share_root_dataset {
        if target == shares {
            return Err(Refusal::TargetIsShareRoot);
        }
        if within(target, shares) {
            return Err(Refusal::TargetInsideShares);
        }
    }
    Ok(())
}

/// The `zfs send` argv.
///
/// `-p` carries dataset properties so the copy is a copy rather than a body without its settings —
/// `acltype`, `refquota` and the rest arrive with it. Without them the target would silently
/// enforce different rules from the source, which on a restore is worse than no copy.
///
/// `-i base` when a common snapshot exists: an INCREMENTAL send moves only what changed. The full
/// send is the first one and the fallback; without the incremental path a nightly replication of a
/// terabyte would move a terabyte every night.
///
/// NO `-R`. Recursive send drags every child dataset, and the caller named ONE. Sending more than
/// was asked for onto a target that will be `-F`'d is how a replication becomes a surprise.
pub fn send_argv<'a>(source_snapshot: &'a str, base: Option<&'a str>) -> Vec<&'a str> {
    match base {
        Some(from) => vec!["send", "-p", "-i", from, source_snapshot],
        None => vec!["send", "-p", source_snapshot],
    }
}

/// The `zfs recv` argv.
///
/// `-F` rolls the target back to the common snapshot before applying the stream, and it is
/// REQUIRED for an incremental send to apply at all: a target that has drifted — someone wrote to
/// it, or it holds a newer snapshot — refuses the stream otherwise. It is also the flag that makes
/// this operation destructive, which is why `check` above refuses a target that could be somebody's
/// files and why §8.1's confirmation sits in front of it.
///
/// `-u` leaves the target UNMOUNTED. A received backup mounted over something, or mounted at the
/// source's own mountpoint (which `-p` carries across), is a way to make two datasets fight over
/// one directory. A backup does not need to be mounted to be a backup.
pub fn recv_argv(target: &str) -> Vec<&str> {
    vec!["recv", "-F", "-u", target]
}

/// Did `zfs recv` refuse because the streams do not line up?
///
/// Its own answer because the repair is different from every other failure: the caller has to send
/// a FULL stream instead of an incremental one. Reported rather than retried automatically — a
/// full send of a terabyte is not something to start on the agent's own initiative.
pub fn incremental_rejected(error: &SeamError) -> bool {
    let said = error.to_string();
    said.contains("most recent snapshot") || said.contains("incremental source")
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "a test that cannot index or unwrap is a test written around the lint"
)]
mod tests {
    use super::*;

    const SHARES: Option<&str> = Some("tank/depsis");

    #[test]
    fn allows_a_second_pool() {
        assert_eq!(check("tank/depsis", "backup/depsis", SHARES), Ok(()));
    }

    #[test]
    fn refuses_a_target_that_is_the_source() {
        assert_eq!(
            check("tank/depsis", "tank/depsis", SHARES),
            Err(Refusal::SameDataset)
        );
    }

    #[test]
    fn refuses_a_target_inside_the_source_and_the_other_way_round() {
        // Reading its own destination as it writes.
        assert_eq!(check("tank/a", "tank/a/backup", None), Err(Refusal::Nested));
        // And the reverse: receiving onto the source's parent destroys the source.
        assert_eq!(check("tank/a/inner", "tank/a", None), Err(Refusal::Nested));
    }

    #[test]
    fn refuses_the_share_root_as_a_target() {
        // THE ONE THAT ERASES EVERY TENANT'S FILES.
        assert_eq!(
            check("backup/old", "tank/depsis", SHARES),
            Err(Refusal::TargetIsShareRoot)
        );
    }

    #[test]
    fn refuses_a_target_inside_the_share_tree() {
        assert_eq!(
            check("backup/old", "tank/depsis/acme", SHARES),
            Err(Refusal::TargetInsideShares)
        );
    }

    #[test]
    fn a_dataset_that_merely_spells_like_the_share_root_is_not_inside_it() {
        // `tank/depsis-backup` starts with `tank/depsis` as TEXT and is a different dataset. A
        // prefix test would refuse a legitimate target here — and, in the other direction, would
        // accept something it should refuse.
        assert_eq!(check("tank/depsis", "tank/depsis-backup", SHARES), Ok(()));
        assert_eq!(check("tank/a", "tank/ab", None), Ok(()));
    }

    #[test]
    fn an_appliance_with_no_share_dataset_still_refuses_the_other_two() {
        // `None` removes the two refusals that have nothing to compare against; it does not turn
        // the check into "anything goes".
        assert_eq!(check("tank/a", "tank/a", None), Err(Refusal::SameDataset));
        assert_eq!(check("tank/a", "tank/a/b", None), Err(Refusal::Nested));
        assert_eq!(check("tank/a", "backup/a", None), Ok(()));
    }

    #[test]
    fn a_full_send_names_the_snapshot_and_carries_properties() {
        let argv = send_argv("tank/depsis@nightly", None);
        assert_eq!(argv, vec!["send", "-p", "tank/depsis@nightly"]);
        // NO `-R`: the caller named one dataset, and sending its children onto a target about to
        // be `-F`'d is a surprise, not a feature.
        assert!(!argv.contains(&"-R"));
    }

    #[test]
    fn an_incremental_send_names_the_base_before_the_target_snapshot() {
        // Order matters to `zfs`: `-i <from> <to>`. Reversed, it sends the wrong direction.
        assert_eq!(
            send_argv("tank/depsis@tuesday", Some("tank/depsis@monday")),
            vec![
                "send",
                "-p",
                "-i",
                "tank/depsis@monday",
                "tank/depsis@tuesday"
            ]
        );
    }

    #[test]
    fn the_receive_rolls_back_and_leaves_the_target_unmounted() {
        let argv = recv_argv("backup/depsis");
        assert_eq!(argv, vec!["recv", "-F", "-u", "backup/depsis"]);
    }

    #[test]
    fn recognises_the_refusal_that_needs_a_full_send() {
        let drifted = SeamError::Command {
            program: "/usr/sbin/zfs".to_string(),
            status: 1,
            stderr: "cannot receive incremental stream: most recent snapshot of backup/depsis \
                     does not match incremental source"
                .to_string(),
        };
        assert!(incremental_rejected(&drifted));

        let unrelated = SeamError::Command {
            program: "/usr/sbin/zfs".to_string(),
            status: 1,
            stderr: "out of space".to_string(),
        };
        assert!(!incremental_rejected(&unrelated));
    }
}
