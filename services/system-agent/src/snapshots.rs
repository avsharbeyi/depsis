//! What snapshots the pool ACTUALLY holds.
//!
//! DEPSIS has been able to take a snapshot since `CreateSnapshot`, and it records each one it takes
//! in `snapshots`. What it has never been able to do is ASK. The backups screen says so in a
//! warning box of its own: "Bu liste havuzun envanteri değil… kabuktan alınmış bir görüntü burada
//! görünmez — yokluğu, olmadığı anlamına gelmez."
//!
//! That warning is honest, and it is also the whole problem. A list that disclaims being true is a
//! list nobody can act on, and it fails in the direction that costs data: a snapshot destroyed from
//! a shell keeps its row, so the screen goes on offering a restore point that does not exist. The
//! reader finds out at the moment they need it.
//!
//! ONE OPERAND, and it is a `DatasetName` — the same validated type `CreateSnapshot` takes. Unlike
//! `pools.rs`, which takes none at all, this one has to be told which dataset to look under: `zfs
//! list -t snapshot` with no operand walks every dataset on the box, which on an appliance holding
//! a tenant's shares means reporting the existence of datasets the caller has no business seeing.

use crate::seams::SeamError;

/// One snapshot, as `zfs list -t snapshot -H -p` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotInfo {
    /// The part after `@`. The dataset half is dropped: the caller named it, so echoing it back on
    /// every row is noise the API would only have to strip again.
    pub name: String,
    /// What destroying this snapshot would actually free.
    ///
    /// NOT what the snapshot "contains": ZFS charges a snapshot only for blocks no longer
    /// referenced by the live filesystem or by a newer snapshot, so a snapshot of a terabyte that
    /// nothing has changed since costs nearly nothing. Reporting `referenced` instead would show a
    /// row of terabytes and invite an operator to delete snapshots that were free.
    pub used_bytes: u64,
    /// Seconds since the epoch. `-p` makes ZFS print this as an integer rather than a localised
    /// date — a date string would have to be parsed back through whatever locale the agent's
    /// process happened to be started in.
    pub created_at: i64,
}

/// The `zfs list` argv for one dataset's snapshots.
///
/// `-d 1` is load-bearing. Without a depth limit the listing is RECURSIVE, so asking about the
/// share parent would also return every child dataset's snapshots — and on a box where each tenant
/// gets a dataset that is one tenant being told about another's backups.
///
/// `-p` for parseable output: byte counts as integers and `creation` as an epoch second. Without it
/// ZFS prints "1.5G" and a localised timestamp, and both have to be un-formatted by hand.
///
/// `-s creation` sorts oldest first, which is the order a restore screen reads in.
pub fn list_snapshots_argv(dataset: &str) -> [&str; 12] {
    [
        "list",
        "-t",
        "snapshot",
        "-H",
        "-p",
        "-d",
        "1",
        "-o",
        "name,used,creation",
        "-s",
        "creation",
        dataset,
    ]
}

/// Parse `zfs list -t snapshot -H -p -o name,used,creation`.
///
/// A line that cannot be read completely is DROPPED rather than half-read, exactly as
/// `parse_filesystems` drops one: a snapshot row with a name and no size would render as a restore
/// point of unknown cost, and "unknown" is not a thing this screen can display honestly.
///
/// `dataset` is the one that was asked about, and rows belonging to anything else are dropped too.
/// With `-d 1` ZFS should not return any, but the filter is the difference between trusting the
/// flag and checking it — and the cost of the flag being wrong is one tenant seeing another's
/// snapshot names.
pub fn parse_snapshots(dataset: &str, out: &str) -> Vec<SnapshotInfo> {
    let prefix = format!("{dataset}@");
    out.lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let full = fields.next()?;
            let used = fields.next()?;
            let created = fields.next()?;
            // A fourth field means the output is not the shape this parser was written against.
            // Reading the first three anyway would be reading a format nobody verified.
            if fields.next().is_some() {
                return None;
            }
            let name = full.strip_prefix(&prefix)?;
            if name.is_empty() {
                return None;
            }
            Some(SnapshotInfo {
                name: name.to_string(),
                used_bytes: used.trim().parse().ok()?,
                created_at: created.trim().parse().ok()?,
            })
        })
        .collect()
}

/// `zfs list` on a dataset that does not exist fails, and that is not a fault to report as one.
///
/// A share whose dataset was never created — the ordinary state before the setup wizard runs — is
/// the same answer as a dataset with no snapshots: nothing to restore from. Distinguishing them
/// would give the screen a third state to render and no action to attach to it.
pub fn missing_dataset(error: &SeamError) -> bool {
    let said = error.to_string();
    said.contains("does not exist") || said.contains("dataset does not exist")
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

    #[test]
    fn the_argv_names_the_dataset_last_and_limits_the_depth() {
        let argv = list_snapshots_argv("tank/depsis");
        assert_eq!(argv[argv.len() - 1], "tank/depsis");
        // `-p`: without it the sizes come back as "1.5G" and the dates localised.
        assert!(argv.contains(&"-p"), "parseable output must be requested");
        assert!(
            argv.contains(&"-H"),
            "tab-separated output must be requested"
        );
        // `-d 1`. The doc comment above called this load-bearing and the first version of the argv
        // did not carry it — a comment describing a fence that was not there. Without the depth
        // limit the listing is recursive, so asking about the share parent returns every child
        // dataset's snapshots too; on a box where each tenant has a dataset, that is one tenant
        // being told what another holds. Asserted so the claim and the code cannot part again.
        let depth = argv
            .iter()
            .position(|arg| *arg == "-d")
            .expect("the depth limit must be in the argv");
        assert_eq!(argv[depth + 1], "1", "the depth limit must be exactly one");
    }

    #[test]
    fn reads_a_real_looking_listing() {
        let out = "tank/depsis@nightly-1\t1024\t1756000000\n\
                   tank/depsis@nightly-2\t0\t1756086400\n";
        assert_eq!(
            parse_snapshots("tank/depsis", out),
            vec![
                SnapshotInfo {
                    name: "nightly-1".to_string(),
                    used_bytes: 1024,
                    created_at: 1_756_000_000,
                },
                SnapshotInfo {
                    name: "nightly-2".to_string(),
                    used_bytes: 0,
                    created_at: 1_756_086_400,
                },
            ]
        );
    }

    #[test]
    fn a_dataset_with_no_snapshots_is_an_empty_list_and_not_an_error() {
        assert_eq!(parse_snapshots("tank/depsis", ""), vec![]);
    }

    #[test]
    fn drops_a_row_belonging_to_another_dataset() {
        // `-d 1` should prevent this. The filter is what makes that a checked claim rather than a
        // trusted one, and the cost of the flag being wrong is one tenant seeing another's names.
        let out = "tank/depsis@mine\t1\t2\n\
                   tank/other@theirs\t1\t2\n\
                   tank/depsis/child@nested\t1\t2\n";
        let found = parse_snapshots("tank/depsis", out);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "mine");
    }

    #[test]
    fn drops_a_row_that_is_not_complete() {
        let out = "tank/depsis@half\t1024\n\
                   tank/depsis@whole\t1024\t1756000000\n\
                   tank/depsis@extra\t1024\t1756000000\tsomething\n";
        let found = parse_snapshots("tank/depsis", out);
        assert_eq!(found.len(), 1, "only the complete row survives");
        assert_eq!(found[0].name, "whole");
    }

    #[test]
    fn drops_a_row_whose_numbers_are_not_numbers() {
        // `zfs list` without `-p` prints "1.5G". If the flag were ever dropped, every row would
        // parse to a wrong number instead of disappearing — so this asserts they disappear.
        let out = "tank/depsis@pretty\t1.5G\tSun Aug 25 12:00 2026\n";
        assert_eq!(parse_snapshots("tank/depsis", out), vec![]);
    }

    #[test]
    fn ignores_prose_a_future_zfs_might_print() {
        let out = "no datasets available\n";
        assert_eq!(parse_snapshots("tank/depsis", out), vec![]);
    }

    #[test]
    fn a_name_that_is_only_the_dataset_is_not_a_snapshot() {
        assert_eq!(
            parse_snapshots("tank/depsis", "tank/depsis@\t1\t2\n"),
            vec![]
        );
        assert_eq!(
            parse_snapshots("tank/depsis", "tank/depsis\t1\t2\n"),
            vec![]
        );
    }

    #[test]
    fn a_snapshot_name_containing_an_at_sign_keeps_all_of_it() {
        // ZFS forbids `@` in a snapshot name, so this cannot arise from a real pool — but the
        // parser splits on the FIRST separator by using a prefix strip, and that behaviour is
        // worth pinning: a future name rule change must not silently truncate names.
        let found = parse_snapshots("tank/depsis", "tank/depsis@a@b\t1\t2\n");
        assert_eq!(found[0].name, "a@b");
    }

    #[test]
    fn a_dataset_whose_name_is_a_prefix_of_another_does_not_capture_it() {
        // "tank/dep" must not swallow "tank/depsis@x". The `@` in the prefix is what prevents it.
        assert_eq!(parse_snapshots("tank/dep", "tank/depsis@x\t1\t2\n"), vec![]);
    }
}
