//! The disk inventory: `lsblk --json`, read into `DiskInfo`.
//!
//! WHY `lsblk` AND NOT `/sys`. Walking `/sys/block` directly is the obvious alternative and it is
//! more code for a worse answer: the stable `/dev/disk/by-id` link has to be recovered by reading
//! and resolving a directory of symlinks, the WWN lives in a different file per transport, and
//! "is anything mounted on this" means parsing `/proc/self/mountinfo` and mapping device numbers
//! back to parents. `lsblk` is util-linux, it is on every Debian box the project targets, it
//! answers all of that in one call, and — the part that matters here — it has no destructive mode
//! and the argv below is a constant.
//!
//! WHAT IS DELIBERATELY NOT REPORTED. Partitions are not disks. They shape three fields of their
//! parent — `holds`, `mounted`, `holds_system` — and are otherwise dropped, because the caller of
//! this operation is about to make a decision about a whole device.

use serde::Deserialize;

use crate::op::{DiskInfo, MAX_DISKS};
use crate::seams::SeamError;

pub const LSBLK: &str = "/usr/bin/lsblk";

/// The columns, as one constant.
///
/// `--bytes` because a human-readable "3.6T" is a string a caller would have to parse back, and
/// every rounding it does is a size shown next to a confirmation to destroy the disk.
///
/// `ID-LINK` is the `/dev/disk/by-id` name. util-linux gained it in 2.38 and Debian trixie — the
/// baseline in ADR-0000 — ships 2.41, so it is present; a build of lsblk without it fails the call
/// outright rather than silently reporting every disk as having no stable identity, which is the
/// direction to fail in when the field is the one used to name a disk in a destroy confirmation.
///
/// `PATH` is deliberately absent and `--paths` is deliberately not passed. Both make `KNAME` a full
/// `/dev/sda` string, and `kname` is the field shown beside the stable id precisely because it is
/// the short name an operator reads on a chassis label. Measured against lsblk 2.41, which prints
/// `"kname": "/dev/sda"` under `--paths` — so the flag would have quietly changed what that column
/// means rather than adding one.
pub const COLUMNS: &str =
    "KNAME,TYPE,SIZE,MODEL,SERIAL,WWN,ROTA,RM,TRAN,FSTYPE,PTTYPE,MOUNTPOINT,ID-LINK";

pub fn argv() -> [&'static str; 4] {
    ["--json", "--bytes", "--output", COLUMNS]
}

/// The mount points that mean "this is the appliance".
///
/// A disk holding any of these is not a pool candidate under any confirmation, so the check is
/// here and not in a dialogue somebody can click through.
const SYSTEM_MOUNTS: [&str; 3] = ["/", "/boot", "/boot/efi"];

/// lsblk's own shape. Only the fields [`COLUMNS`] asks for, and every one optional: lsblk omits a
/// column it has no value for rather than emitting null, and older builds spell some of them
/// differently.
#[derive(Debug, Deserialize)]
struct Node {
    #[serde(default)]
    kname: Option<String>,
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    serial: Option<String>,
    #[serde(default)]
    wwn: Option<String>,
    #[serde(default)]
    rota: Option<bool>,
    #[serde(default)]
    rm: Option<bool>,
    #[serde(default)]
    tran: Option<String>,
    #[serde(default)]
    fstype: Option<String>,
    #[serde(default)]
    pttype: Option<String>,
    /// A string on lsblk 2.38, and still a string on 2.41 — `MOUNTPOINTS` (plural) is the array
    /// form and is not asked for, because one mount point is enough to answer "is this in use".
    #[serde(default)]
    mountpoint: Option<String>,
    #[serde(default, rename = "id-link")]
    id_link: Option<String>,
    #[serde(default)]
    children: Vec<Node>,
}

#[derive(Debug, Deserialize)]
struct Output {
    #[serde(default)]
    blockdevices: Vec<Node>,
}

/// Parse what `lsblk` said.
///
/// Returns the disks and whether the list was cut at [`MAX_DISKS`].
pub fn parse(json: &str) -> Result<(Vec<DiskInfo>, bool), SeamError> {
    let output: Output = serde_json::from_str(json)
        .map_err(|e| SeamError::Io(format!("lsblk produced unreadable JSON: {e}")))?;

    let mut disks = Vec::new();
    let mut truncated = false;

    for node in &output.blockdevices {
        // `disk` only. `loop`, `rom` and `md` are block devices and not things a pool is built on;
        // `part` never appears at the top level, but naming the type rather than excluding a list
        // of others means a device class added to lsblk later is dropped rather than offered.
        if node.kind.as_deref() != Some("disk") {
            continue;
        }
        if disks.len() >= MAX_DISKS {
            truncated = true;
            break;
        }
        disks.push(convert(node));
    }

    Ok((disks, truncated))
}

fn convert(node: &Node) -> DiskInfo {
    let mut holds = Vec::new();
    let mut mounted = false;
    let mut holds_system = false;

    // The partition table itself counts as content. A disk with a GPT and no filesystems is still
    // a disk somebody partitioned, and overwriting it loses whatever the partitions were for.
    if let Some(pttype) = clean(node.pttype.as_deref()) {
        holds.push(pttype);
    }
    collect(node, &mut holds, &mut mounted, &mut holds_system);
    holds.dedup();

    DiskInfo {
        by_id: clean(node.id_link.as_deref()),
        kname: clean(node.kname.as_deref()).unwrap_or_else(|| "?".to_string()),
        size_bytes: node.size.unwrap_or(0),
        model: clean(node.model.as_deref()),
        serial: clean(node.serial.as_deref()),
        wwn: clean(node.wwn.as_deref()),
        rotational: node.rota.unwrap_or(false),
        removable: node.rm.unwrap_or(false),
        transport: clean(node.tran.as_deref()),
        holds,
        mounted,
        holds_system,
    }
}

/// Walk a device and everything under it.
///
/// Recursive because the tree genuinely is: a partition can hold LVM, which holds logical volumes,
/// which hold filesystems — and a disk whose only content is three levels down is still a disk
/// with content on it.
fn collect(node: &Node, holds: &mut Vec<String>, mounted: &mut bool, system: &mut bool) {
    for child in &node.children {
        if let Some(fstype) = clean(child.fstype.as_deref()) {
            if !holds.contains(&fstype) {
                holds.push(fstype);
            }
        }
        if let Some(point) = clean(child.mountpoint.as_deref()) {
            *mounted = true;
            if SYSTEM_MOUNTS.contains(&point.as_str()) {
                *system = true;
            }
        }
        collect(child, holds, mounted, system);
    }

    // The device's own filesystem, for a disk formatted without a partition table.
    if let Some(fstype) = clean(node.fstype.as_deref()) {
        if !holds.contains(&fstype) {
            holds.push(fstype);
        }
    }
    if let Some(point) = clean(node.mountpoint.as_deref()) {
        *mounted = true;
        if SYSTEM_MOUNTS.contains(&point.as_str()) {
            *system = true;
        }
    }
}

/// Empty is absent.
///
/// lsblk writes `""` for a column it has no value for as often as it writes `null`, and an empty
/// string reaching `by_id` would be a stable identity that names nothing.
fn clean(value: Option<&str>) -> Option<String> {
    match value.map(str::trim) {
        None | Some("") => None,
        Some(text) => Some(text.to_string()),
    }
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

    /// Two disks as a real box presents them: a system disk with a GPT, an EFI partition and root
    /// on LVM, and an empty one.
    const REAL: &str = r#"{
      "blockdevices": [
        {"kname":"sda","type":"disk","size":512110190592,"model":"Samsung SSD 860",
         "serial":"S3Z8NB0K","wwn":"0x5002538e40a1b2c3","rota":false,"rm":false,"tran":"sata",
         "fstype":null,"pttype":"gpt","mountpoint":null,"id-link":"ata-Samsung_SSD_860_S3Z8NB0K",
         "children":[
           {"kname":"sda1","type":"part","size":536870912,"fstype":"vfat","mountpoint":"/boot/efi",
            "children":[]},
           {"kname":"sda2","type":"part","size":511573319680,"fstype":"LVM2_member",
            "mountpoint":null,"children":[
              {"kname":"dm-0","type":"lvm","size":511573319680,"fstype":"ext4","mountpoint":"/",
               "children":[]}
            ]}
         ]},
        {"kname":"sdb","type":"disk","size":4000787030016,"model":"WDC WD40EFRX",
         "serial":"WD-WCC4E123","wwn":"0x50014ee2b1c2d3e4","rota":true,"rm":false,"tran":"sata",
         "fstype":null,"pttype":null,"mountpoint":null,"id-link":"ata-WDC_WD40EFRX_WD-WCC4E123",
         "children":[]},
        {"kname":"loop0","type":"loop","size":12345,"children":[]}
      ]
    }"#;

    #[test]
    fn reports_whole_disks_and_not_partitions() {
        let (disks, truncated) = parse(REAL).expect("parses");
        assert!(!truncated);
        // `loop0` is a block device and not a disk.
        assert_eq!(
            disks.iter().map(|d| d.kname.as_str()).collect::<Vec<_>>(),
            ["sda", "sdb"]
        );
    }

    #[test]
    fn finds_the_system_disk_through_two_levels() {
        // The point of the recursion: root is on an LVM volume inside a partition, so a walk one
        // level deep would report the appliance's own disk as empty and offer it as a pool
        // candidate.
        let (disks, _) = parse(REAL).expect("parses");
        let system = &disks[0];
        assert!(system.holds_system, "root is on sda2 → dm-0");
        assert!(system.mounted);
        assert!(system.holds.contains(&"gpt".to_string()));
        assert!(system.holds.contains(&"ext4".to_string()));
        assert!(system.holds.contains(&"vfat".to_string()));
    }

    #[test]
    fn an_untouched_disk_holds_nothing() {
        // The only state in which offering the disk is safe, so it has to be reachable: a disk
        // that reported content it does not have could never be used.
        let (disks, _) = parse(REAL).expect("parses");
        let blank = &disks[1];
        assert!(blank.holds.is_empty());
        assert!(!blank.mounted);
        assert!(!blank.holds_system);
        assert_eq!(blank.by_id.as_deref(), Some("ata-WDC_WD40EFRX_WD-WCC4E123"));
        assert!(blank.rotational);
    }

    #[test]
    fn a_disk_formatted_without_a_partition_table_still_reports_its_filesystem() {
        let json = r#"{"blockdevices":[
          {"kname":"sdc","type":"disk","size":100,"fstype":"zfs_member","pttype":null,
           "mountpoint":null,"children":[]}]}"#;
        let (disks, _) = parse(json).expect("parses");
        assert_eq!(disks[0].holds, ["zfs_member"]);
    }

    #[test]
    fn a_mounted_disk_that_is_not_the_system_disk_is_mounted_but_not_system() {
        // The distinction the API leans on: `mounted` asks for a confirmation, `holds_system`
        // refuses outright.
        let json = r#"{"blockdevices":[
          {"kname":"sdd","type":"disk","size":100,"pttype":"gpt","children":[
            {"kname":"sdd1","type":"part","size":100,"fstype":"ext4","mountpoint":"/srv/data",
             "children":[]}]}]}"#;
        let (disks, _) = parse(json).expect("parses");
        assert!(disks[0].mounted);
        assert!(!disks[0].holds_system);
    }

    #[test]
    fn an_empty_string_is_not_an_identity() {
        // lsblk writes "" as readily as null, and an empty `by_id` would be a stable name for
        // nothing — passed to ReadSmartSummary it would resolve to the by-id DIRECTORY.
        let json = r#"{"blockdevices":[
          {"kname":"sde","type":"disk","size":100,"id-link":"","serial":"  ","wwn":"",
           "children":[]}]}"#;
        let (disks, _) = parse(json).expect("parses");
        assert_eq!(disks[0].by_id, None);
        assert_eq!(disks[0].serial, None);
        assert_eq!(disks[0].wwn, None);
    }

    #[test]
    fn a_missing_column_is_not_a_parse_failure() {
        // A build of lsblk that omits a column must degrade to "unknown", not to no inventory at
        // all — the caller can still see that a disk exists.
        let json = r#"{"blockdevices":[{"kname":"sdf","type":"disk"}]}"#;
        let (disks, _) = parse(json).expect("parses");
        assert_eq!(disks[0].size_bytes, 0);
        assert_eq!(disks[0].model, None);
    }

    #[test]
    fn unreadable_output_is_an_error_and_not_an_empty_inventory() {
        // The difference between "this box has no disks" and "the agent could not tell" must not
        // be collapsed: the first is a screen saying so, the second would offer an empty list of
        // candidates and let somebody conclude the disks are gone.
        assert!(parse("not json at all").is_err());
    }

    #[test]
    fn the_argv_carries_no_caller_input() {
        // The security property of this operation, pinned. Every element is a literal; there is
        // no operand and therefore nothing to smuggle.
        for arg in argv() {
            assert!(!arg.is_empty());
        }
        assert!(argv().contains(&"--json"));
        assert!(argv().contains(&"--bytes"));
    }

    #[test]
    fn the_kernel_name_stays_short() {
        // `--paths` and the `PATH` column both turn `kname` into `/dev/sda`, measured against
        // lsblk 2.41. That is not an extra field, it is the same field meaning something else —
        // and `kname` exists to be the short name an operator reads on a chassis label.
        assert!(!argv().contains(&"--paths"));
        assert!(!COLUMNS.split(',').any(|column| column == "PATH"));

        // A capture from a real box, so the assertion is about lsblk's behaviour and not about a
        // fixture somebody wrote to match the parser.
        let real = r#"{"blockdevices":[{"kname":"sda","type":"disk","size":382496768,
          "model":"Virtual Disk","serial":"60022480b85a9136c0b1d97945cba312",
          "wwn":"0x60022480b85a9136c0b1d97945cba312","rota":true,"rm":false,"tran":null,
          "fstype":"ext4","pttype":null,"mountpoint":null,
          "id-link":"scsi-360022480b85a9136c0b1d97945cba312"}]}"#;
        let (disks, _) = parse(real).expect("parses");
        assert_eq!(disks[0].kname, "sda");
        assert_eq!(
            disks[0].by_id.as_deref(),
            Some("scsi-360022480b85a9136c0b1d97945cba312")
        );
        // A disk formatted with no partition table: the filesystem is on the device itself, and
        // reporting `holds: []` here would offer the disk as empty.
        assert_eq!(disks[0].holds, ["ext4"]);
    }
}
