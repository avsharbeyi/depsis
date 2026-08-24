//! What pools exist, and which dataset is mounted where DEPSIS serves shares from.
//!
//! Both questions were answered by CONFIGURATION until now — `DEPSIS_ZFS_POOLS` and
//! `DEPSIS_SHARE_PARENT_DATASET`, typed into `api.env` by hand — because the closed operation set
//! had no way to ask. That was defensible while the pool was made at install time from a shell. It
//! stopped being defensible the moment the product could create a pool itself: the wizard finished,
//! and the operator was told to edit a file and restart the API before the pool it had just built
//! would appear anywhere.
//!
//! NEITHER PARSER TAKES AN OPERAND. `zpool list -H -o name` and `zfs list -H -o name,mountpoint`
//! are run with no argument at all and the answer is filtered here, in Rust. That is not laziness
//! about `zfs list <path>` — it is the point: a command line with nothing caller-supplied in it has
//! nothing to smuggle, and these two run beside an operation that erases disks.

use crate::seams::SeamError;

/// One filesystem, as `zfs list -H -o name,mountpoint` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Filesystem {
    pub name: String,
    /// `-` and `none` and `legacy` all mean "not mounted by ZFS at a path", and all three arrive as
    /// literal strings. Collapsed to `None` here so a caller cannot compare a path against the
    /// four-character string `none` and find a match.
    pub mountpoint: Option<String>,
}

/// The `zpool list -H -o name` argv. No operand.
pub fn list_pools_argv() -> [&'static str; 4] {
    ["list", "-H", "-o", "name"]
}

/// The `zfs list -H -o name,mountpoint` argv. No operand.
///
/// `-H` gives tab-separated fields with no header, which is the documented script form. Without it
/// the columns are space-padded and a mountpoint containing a space becomes unparseable.
pub fn list_filesystems_argv() -> [&'static str; 4] {
    ["list", "-H", "-o", "name,mountpoint"]
}

/// Pool names, one per line.
///
/// A machine with no pools produces empty output, which is an empty list and not an error — that
/// is the ordinary state of a box nobody has set up yet, and it is the state the wizard exists for.
pub fn parse_pools(out: &str) -> Vec<String> {
    out.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        // A POOL NAME CANNOT CONTAIN A SPACE, and this filter is not tidiness: `zpool list` prints
        // "no pools available" when there are none, and whether that goes to stdout or stderr has
        // varied between versions. Read as a name it would become a pool the API then asks for
        // status about, and the refusal would be reported as a fault on a machine that is simply
        // empty. The same guard drops any other prose a future version decides to print.
        .filter(|line| !line.contains(char::is_whitespace))
        .map(str::to_string)
        .collect()
}

/// Filesystems and their mountpoints.
///
/// A line that does not have both fields is DROPPED rather than half-read. The alternative — taking
/// the first field and leaving the mountpoint unknown — would produce a dataset name with no
/// mountpoint, which is indistinguishable here from a legitimately unmounted one, and the caller
/// uses exactly that distinction to decide whether the share root is prepared.
pub fn parse_filesystems(out: &str) -> Vec<Filesystem> {
    out.lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let name = fields.next()?.trim();
            let mountpoint = fields.next()?.trim();
            if name.is_empty() {
                return None;
            }
            Some(Filesystem {
                name: name.to_string(),
                mountpoint: match mountpoint {
                    // ZFS writes all three for "not mounted at a path in the normal way", and each
                    // means something different to `zfs` while meaning the same thing here.
                    "" | "-" | "none" | "legacy" => None,
                    path => Some(path.to_string()),
                },
            })
        })
        .collect()
}

/// The dataset mounted exactly at `path`, if any.
///
/// EXACTLY, not "containing". A dataset mounted at `/srv` is not the dataset that holds
/// `/srv/depsis` — the directory would be an ordinary directory inside it — and treating the two as
/// the same would report the share root as prepared when nothing had been created for it, so
/// `POST /shares` would then make datasets that land somewhere nothing serves.
pub fn mounted_at<'a>(filesystems: &'a [Filesystem], path: &str) -> Option<&'a str> {
    let wanted = normalise(path);
    filesystems.iter().find_map(|fs| {
        let mountpoint = fs.mountpoint.as_deref()?;
        (normalise(mountpoint) == wanted).then_some(fs.name.as_str())
    })
}

/// Trailing slashes off, so `/srv/depsis/` and `/srv/depsis` are one path.
///
/// `/` itself keeps its slash: trimming it to the empty string would make the root filesystem match
/// a dataset with no mountpoint.
fn normalise(path: &str) -> &str {
    let trimmed = path.trim();
    match trimmed.trim_end_matches('/') {
        "" => "/",
        rest => rest,
    }
}

/// The dataset DEPSIS would create for a pool's share tree.
///
/// DERIVED, never chosen by a caller. `PrepareShareRoot` takes a pool name and nothing else, so the
/// only dataset it can create is this one — an operation that accepted a dataset path could mount a
/// tenant's data anywhere on the box, which is the reason `CreateDataset` refuses a mountpoint
/// operand in the first place.
pub fn share_dataset(pool: &str) -> String {
    format!("{pool}/depsis")
}

/// Refuse a shares root that is not an absolute path.
///
/// It comes from the agent's own environment rather than from a caller, so this is not an
/// injection check — it is a misconfiguration check, and it runs before the value is handed to
/// `zfs create -o mountpoint=…`, where a relative path would produce a dataset mounted somewhere
/// nobody intended relative to whatever directory the agent happened to start in.
pub fn check_shares_root(root: &str) -> Result<(), SeamError> {
    if !root.starts_with('/') {
        return Err(SeamError::Io(format!(
            "DEPSIS_SHARES_ROOT is {root:?}, which is not an absolute path"
        )));
    }
    if root.trim_end_matches('/').is_empty() {
        return Err(SeamError::Io(
            "DEPSIS_SHARES_ROOT is /, which cannot be a share tree".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "The crate-level denials exist because a panic in a root daemon is a denial of \
              service. In tests the opposite holds: a failed assertion SHOULD panic, and \
              indexing a fixture reads better than unwrapping an Option."
)]
mod tests {
    use super::*;

    #[test]
    fn pool_names_come_back_one_per_line() {
        assert_eq!(parse_pools("tank\nyedek\n"), ["tank", "yedek"]);
    }

    #[test]
    fn zpools_own_prose_is_not_read_as_a_pool_name() {
        // `zpool list` prints "no pools available" when there are none, and which stream that goes
        // to has varied between versions. Read as a name it becomes a pool the API asks for status
        // about, and the refusal is reported as a fault on a machine that is simply empty.
        assert!(parse_pools(
            "no pools available
"
        )
        .is_empty());
        assert_eq!(
            parse_pools(
                "no pools available
tank
"
            ),
            ["tank"]
        );
    }

    #[test]
    fn a_machine_with_no_pools_is_an_empty_list_and_not_an_error() {
        // The ordinary state of a box nobody has set up, and the state the wizard exists for.
        // Reporting it as a failure would make a fresh appliance look broken.
        assert!(parse_pools("").is_empty());
        assert!(parse_pools("\n  \n").is_empty());
    }

    #[test]
    fn the_dataset_mounted_at_the_share_root_is_found() {
        let out = "tank\tnone\ntank/depsis\t/srv/depsis\ntank/other\t/mnt/other\n";
        let filesystems = parse_filesystems(out);
        assert_eq!(mounted_at(&filesystems, "/srv/depsis"), Some("tank/depsis"));
        assert_eq!(
            mounted_at(&filesystems, "/srv/depsis/"),
            Some("tank/depsis")
        );
    }

    #[test]
    fn a_parent_mount_is_not_the_share_root() {
        // A dataset mounted at /srv is NOT the dataset holding /srv/depsis — that would be an
        // ordinary directory inside it. Treating them as the same would report the share root as
        // prepared when nothing had been created, and `POST /shares` would then make datasets that
        // land somewhere nothing serves.
        let filesystems = parse_filesystems("tank/srv\t/srv\n");
        assert_eq!(mounted_at(&filesystems, "/srv/depsis"), None);
    }

    #[test]
    fn none_legacy_and_dash_are_all_unmounted() {
        // Three spellings ZFS uses for "not mounted at a path", each meaning something different to
        // `zfs` and the same thing here. Left as strings, a caller comparing a path could match the
        // literal `none`.
        let filesystems = parse_filesystems("a\t-\nb\tnone\nc\tlegacy\nd\t/real\n");
        assert_eq!(
            filesystems
                .iter()
                .filter(|fs| fs.mountpoint.is_none())
                .count(),
            3
        );
        assert_eq!(mounted_at(&filesystems, "none"), None);
        assert_eq!(mounted_at(&filesystems, "-"), None);
        assert_eq!(mounted_at(&filesystems, "/real"), Some("d"));
    }

    #[test]
    fn a_half_line_is_dropped_rather_than_half_read() {
        // Taking the name and leaving the mountpoint unknown would produce a dataset that looks
        // unmounted, and "unmounted" is exactly the state the caller acts on.
        let filesystems = parse_filesystems("tank/depsis\ntank/other\t/mnt\n");
        assert_eq!(filesystems.len(), 1);
        assert_eq!(filesystems[0].name, "tank/other");
    }

    #[test]
    fn a_mountpoint_with_a_space_survives_the_tab_split() {
        // The reason `-H` is passed. Without it the columns are space-padded and this line becomes
        // two datasets, one of them named after half a directory.
        let filesystems = parse_filesystems("tank/x\t/srv/my shares\n");
        assert_eq!(mounted_at(&filesystems, "/srv/my shares"), Some("tank/x"));
    }

    #[test]
    fn the_share_dataset_name_is_derived_from_the_pool_and_nothing_else() {
        assert_eq!(share_dataset("tank"), "tank/depsis");
    }

    #[test]
    fn a_relative_or_root_share_tree_is_refused() {
        assert!(check_shares_root("srv/depsis").is_err());
        assert!(check_shares_root("/").is_err());
        assert!(check_shares_root("//").is_err());
        assert!(check_shares_root("/srv/depsis").is_ok());
    }

    #[test]
    fn neither_argv_carries_an_operand() {
        // The property these two share with `list_disks`, and the reason both were written this way
        // rather than as `zfs list <path>`: a command line with nothing caller-supplied in it has
        // nothing to smuggle, and these run beside an operation that erases disks.
        for argv in [list_pools_argv(), list_filesystems_argv()] {
            for arg in argv {
                assert!(!arg.starts_with('/'), "{arg} looks like a path operand");
            }
            assert!(argv.contains(&"-H"));
        }
    }
}
