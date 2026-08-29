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

use crate::op::{DiskInfo, DiskRef, PoolTopology, MAX_DISKS, MAX_POOL_DISKS};
use crate::seams::SeamError;

pub const LSBLK: &str = "/usr/bin/lsblk";

/// Where a `/dev/disk/by-id` name becomes a path. A literal, joined to a validated single
/// component — the same construction `read_smart_summary` uses, and the reason a caller cannot
/// name `/dev/sda` (risk R1).
pub const BY_ID_DIR: &str = "/dev/disk/by-id";

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
/// `MOUNTPOINTS` (plural) is asked for as well as `MOUNTPOINT`, and the plural one is the
/// authority. The singular column reports AT MOST ONE of a device's mount points, and which one is
/// decided by libmount's fs-root fixup: on the standard btrfs subvolume layout — Debian and Ubuntu
/// `@`/`@home`, openSUSE, Fedora — the partition is mounted at `/` with `subvol=@` and at `/home`
/// with `subvol=@home`, neither entry has fs-root `/`, and the singular column answers `/home`.
/// The appliance's own boot disk then reports `holds_system: false`.
///
/// `NAME` IS IN THE LIST AND NOTHING READS IT. lsblk draws its tree on the NAME column, and with
/// NAME absent from `--output` it does not nest at all: the JSON comes back FLAT, every partition
/// a top-level entry of type `part`, every disk carrying no children. [`parse`] drops non-disks,
/// so the appliance's own boot disk then reports `holds: ["gpt"]`, `mounted: false` and
/// `holds_system: false` — the guard that refuses to build a pool on the disk the box boots from
/// never fires. This shipped, and every unit test below passed throughout, because the fixtures
/// were written with `children` — they encoded what lsblk produces WITH NAME, not what this argv
/// asked for. Measured on util-linux 2.39.3 and 2.41. Remove the column and the tree goes with it.
///
/// `concat!` AND NOT A BACKSLASH CONTINUATION. Written as one literal split over two lines with a
/// trailing `\`, rustfmt joined the lines back and left the indentation INSIDE the string; lsblk
/// then answered `unknown column: <spaces>MOUNTPOINT,...` and the whole inventory failed. No unit
/// test could see it — the constant only means anything to the real command — so the invariant is
/// asserted directly below instead.
pub const COLUMNS: &str = concat!(
    "NAME,KNAME,TYPE,SIZE,MODEL,SERIAL,WWN,ROTA,RM,TRAN,",
    "FSTYPE,PTTYPE,MOUNTPOINT,MOUNTPOINTS,ID-LINK"
);

pub fn argv() -> [&'static str; 4] {
    ["--json", "--bytes", "--output", COLUMNS]
}

/// The mount points that mean "this is the appliance".
///
/// A disk holding any of these is not a pool candidate under any confirmation, so the check is
/// here and not in a dialogue somebody can click through.
///
/// `/efi` is in the list because systemd-gpt-auto mounts the ESP there on an XBOOTLDR layout, where
/// `/boot` is a separate partition and the ESP is not under it.
const SYSTEM_MOUNTS: [&str; 4] = ["/", "/boot", "/boot/efi", "/efi"];

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
    /// The singular column: AT MOST ONE mount point, chosen by libmount. Kept as a fallback for a
    /// build of lsblk that does not carry the plural one, and never preferred over it.
    #[serde(default)]
    mountpoint: Option<String>,
    /// The plural column, which is the authority. lsblk emits `[null]` for an unmounted device,
    /// hence the inner `Option`.
    #[serde(default)]
    mountpoints: Option<Vec<Option<String>>>,
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
        // A PARTITION AT THE TOP LEVEL means the output is not a tree — see [`COLUMNS`]. Every
        // disk in such a listing looks empty, which is the one wrong answer this module must never
        // give, so the call fails instead. The same direction the missing ID-LINK column fails in.
        if node.kind.as_deref() == Some("part") {
            return Err(SeamError::Io(
                "lsblk returned a flat list: a partition appears at the top level, so no disk's                  content can be read from it"
                    .to_string(),
            ));
        }
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
        note_mounts(child, mounted, system);
        collect(child, holds, mounted, system);
    }

    // The device's own filesystem, for a disk formatted without a partition table.
    if let Some(fstype) = clean(node.fstype.as_deref()) {
        if !holds.contains(&fstype) {
            holds.push(fstype);
        }
    }
    note_mounts(node, mounted, system);
}

/// Every place this device is mounted, not just the first one lsblk happened to report.
///
/// The plural column when it is there, the singular one only as a fallback — see [`COLUMNS`] for
/// the layout on which the singular one answers `/home` about the disk holding `/`.
fn note_mounts(node: &Node, mounted: &mut bool, system: &mut bool) {
    let points: Vec<String> = match node.mountpoints.as_ref() {
        Some(list) => list.iter().filter_map(|p| clean(p.as_deref())).collect(),
        None => clean(node.mountpoint.as_deref()).into_iter().collect(),
    };
    for point in points {
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

/// Why a proposed pool was refused.
///
/// Each variant is a sentence an operator can act on. They are separate variants rather than one
/// string because the API turns them into different HTTP answers — a disk that is not there is a
/// 409 the operator fixes by looking at the box, and a mismatched WWN is a 409 that means STOP.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PoolPlanError {
    #[error("a {topology} pool needs at least {minimum} disks; {given} were named")]
    TooFewDisks {
        topology: &'static str,
        minimum: usize,
        given: usize,
    },
    #[error("a {topology} pool takes exactly {maximum} disk(s); {given} were named")]
    TooManyDisks {
        topology: &'static str,
        maximum: usize,
        given: usize,
    },
    #[error("no more than {MAX_POOL_DISKS} disks in one pool; {given} were named")]
    TooManyForOneCall { given: usize },
    #[error("{by_id} was named twice")]
    Duplicate { by_id: String },
    #[error("{by_id} is not a disk this machine reports")]
    Unknown { by_id: String },
    #[error(
        "{by_id} reports WWN {found:?}, not {expected:?}: the disk in that slot is not the one \
         that was confirmed"
    )]
    WwnMismatch {
        by_id: String,
        expected: String,
        found: Option<String>,
    },
    #[error("{by_id} holds this machine's own system; it can never be part of a pool")]
    SystemDisk { by_id: String },
    #[error("{by_id} already holds {holds}; clear it deliberately before using it in a pool")]
    NotBlank { by_id: String, holds: String },
    #[error("{by_id} is mounted; it cannot be part of a pool while it is in use")]
    Mounted { by_id: String },
    #[error("{by_id} is removable; a disk that can be unplugged takes its vdev with it")]
    Removable { by_id: String },
}

/// Check a proposed WIPE against what the box reports RIGHT NOW.
///
/// The mirror image of `plan`, with the content checks inverted: content is the REASON to wipe,
/// so `holds` refuses nothing here, and removability refuses nothing either — wiping a USB stick
/// is an ordinary wish, it is JOINING one to a pool that stays forbidden. What cannot be passed
/// by any confirmation is the same two absolutes as pool creation: the system disk, and anything
/// mounted. The WWN re-check is verbatim the pool wizard's TOCTOU defence: the caller confirms a
/// disk, the agent re-reads the inventory, and a device swapped in between is refused, not erased.
pub fn wipe_plan(disk: &DiskRef, inventory: &[DiskInfo]) -> Result<(), PoolPlanError> {
    let by_id = disk.by_id.as_str();
    let Some(found) = inventory.iter().find(|d| d.by_id.as_deref() == Some(by_id)) else {
        return Err(PoolPlanError::Unknown {
            by_id: by_id.to_string(),
        });
    };
    if found.wwn.as_deref() != Some(disk.wwn.as_str()) {
        return Err(PoolPlanError::WwnMismatch {
            by_id: by_id.to_string(),
            expected: disk.wwn.clone(),
            found: found.wwn.clone(),
        });
    }
    if found.holds_system {
        return Err(PoolPlanError::SystemDisk {
            by_id: by_id.to_string(),
        });
    }
    if found.mounted {
        return Err(PoolPlanError::Mounted {
            by_id: by_id.to_string(),
        });
    }
    Ok(())
}

/// Check a proposed pool against what the box reports RIGHT NOW, and build the argv.
///
/// The inventory is a parameter rather than something this reads, so the caller decides when it
/// was taken — and the dispatcher takes it immediately before creating the pool rather than
/// reusing whatever the wizard was looking at. That ordering is the whole value of the WWN check:
/// re-checking against a stale inventory would confirm only that the caller copied it correctly.
pub fn plan<'a>(
    pool: &'a str,
    topology: PoolTopology,
    disks: &'a [DiskRef],
    inventory: &[DiskInfo],
) -> Result<Vec<String>, PoolPlanError> {
    let name = match topology {
        PoolTopology::Single => "single",
        PoolTopology::Mirror => "mirror",
        PoolTopology::Raidz1 => "raidz1",
        PoolTopology::Raidz2 => "raidz2",
    };

    if disks.len() > MAX_POOL_DISKS {
        return Err(PoolPlanError::TooManyForOneCall { given: disks.len() });
    }
    if disks.len() < topology.minimum_disks() {
        return Err(PoolPlanError::TooFewDisks {
            topology: name,
            minimum: topology.minimum_disks(),
            given: disks.len(),
        });
    }
    if let Some(maximum) = topology.maximum_disks() {
        if disks.len() > maximum {
            return Err(PoolPlanError::TooManyDisks {
                topology: name,
                maximum,
                given: disks.len(),
            });
        }
    }

    let mut seen: Vec<&str> = Vec::new();
    for disk in disks {
        let by_id = disk.by_id.as_str();
        // A disk named twice would be given to `zpool` twice, and a "mirror" of one device with
        // itself is a single point of failure wearing the word mirror.
        if seen.contains(&by_id) {
            return Err(PoolPlanError::Duplicate {
                by_id: by_id.to_string(),
            });
        }
        seen.push(by_id);

        let Some(found) = inventory.iter().find(|d| d.by_id.as_deref() == Some(by_id)) else {
            return Err(PoolPlanError::Unknown {
                by_id: by_id.to_string(),
            });
        };
        if found.wwn.as_deref() != Some(disk.wwn.as_str()) {
            return Err(PoolPlanError::WwnMismatch {
                by_id: by_id.to_string(),
                expected: disk.wwn.clone(),
                found: found.wwn.clone(),
            });
        }
        // Last, and not first, on purpose: an operator who named the system disk should hear that
        // it is the system disk, not that it was named twice.
        if found.holds_system {
            return Err(PoolPlanError::SystemDisk {
                by_id: by_id.to_string(),
            });
        }

        // THREE INDEPENDENT SIGNALS, and that is the point rather than belt-and-braces. Until this
        // was written the only content check here was `holds_system`, which is derived from one
        // probe — and a review found the layout on which that probe answers wrongly about the
        // appliance's own boot disk. "The disk must be blank" is a sentence the wizard, the OpenAPI
        // description and the README all state; it was enforced only in browser JavaScript, so a
        // direct API call naming a disk full of data reached `zpool create` with nothing but
        // zpool's own blkid probe left in the way.
        //
        // `mounted` and `holds` come from different lsblk columns than `holds_system` does, so a
        // device that defeats one of them still has to defeat the others.
        if found.mounted {
            return Err(PoolPlanError::Mounted {
                by_id: by_id.to_string(),
            });
        }
        if !found.holds.is_empty() {
            return Err(PoolPlanError::NotBlank {
                by_id: by_id.to_string(),
                holds: found.holds.join(", "),
            });
        }
        // Documented as a refusal in op.rs and in the OpenAPI description long before anything
        // refused it. A USB stick is a disk, and a vdev that can be unplugged by someone tidying a
        // desk is not redundancy.
        if found.removable {
            return Err(PoolPlanError::Removable {
                by_id: by_id.to_string(),
            });
        }
    }

    let mut argv: Vec<String> = vec!["create".into()];
    // ADR-0004's properties as POOL-level defaults, so every dataset made here inherits them.
    // `CreateDataset` sets `acltype` per dataset; a pool whose default is `off` makes every
    // dataset that forgets to say so a dataset with no ACLs at all.
    argv.push("-O".into());
    argv.push("acltype=posixacl".into());
    argv.push("-O".into());
    argv.push("xattr=sa".into());
    // Relatime rather than atime=off: `atime=on` writes on every read, which on a NAS is every
    // file anybody opens; `atime=off` breaks the small number of tools that read it.
    argv.push("-O".into());
    argv.push("relatime=on".into());
    // 4 KiB sectors. Getting this wrong is UNFIXABLE — ashift is set per vdev at creation and
    // cannot be changed — and a pool created with ashift=9 on a disk that lies about its sector
    // size loses a large fraction of its write performance for the life of the pool.
    argv.push("-o".into());
    argv.push("ashift=12".into());
    // NOT mounted at the pool name. `/tank` appearing at the root of the filesystem is a surprise,
    // and DEPSIS mounts its own datasets where its configuration says.
    argv.push("-m".into());
    argv.push("none".into());
    // NO `-f`. See `Request::CreatePool`: without it `zpool` refuses a disk that already holds a
    // filesystem, and that refusal is a gate this product deliberately does not own.
    argv.push(pool.to_string());
    if let Some(keyword) = topology.keyword() {
        argv.push(keyword.to_string());
    }
    for disk in disks {
        argv.push(format!("{BY_ID_DIR}/{}", disk.by_id.as_str()));
    }
    Ok(argv)
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
    fn the_column_list_is_a_column_list_and_not_prose() {
        // lsblk takes `--output` as ONE argument and matches each name exactly: a stray space
        // makes the whole call fail with `unknown column`, and the box reports no disks at all.
        // This is not hypothetical — a rustfmt-joined line continuation put twenty-seven spaces in
        // the middle of the constant, and nothing in this file could tell until lsblk ran.
        assert!(
            !COLUMNS.contains(char::is_whitespace),
            "no whitespace anywhere in an --output list: {COLUMNS}"
        );
        for column in COLUMNS.split(',') {
            assert!(
                !column.is_empty()
                    && column
                        .chars()
                        .all(|c| c.is_ascii_uppercase() || c == '-' || c.is_ascii_digit()),
                "not a column name: {column:?}"
            );
        }
    }

    #[test]
    fn the_columns_keep_the_one_that_makes_lsblk_nest() {
        // NAME is read by nothing and looks like a duplicate of KNAME, which is exactly why it is
        // at risk of being tidied away. It is the column lsblk draws the tree on.
        assert!(
            COLUMNS.starts_with("NAME,"),
            "without NAME lsblk emits a flat list and every disk reports holding nothing"
        );
    }

    #[test]
    fn a_flat_listing_is_a_failure_and_not_a_box_full_of_empty_disks() {
        // WHAT THE APPLIANCE GATE CAUGHT ON REAL HARDWARE. lsblk asked without NAME answers with
        // partitions at the top level; the disk they belong to carries no children and comes back
        // as `holds: ["gpt"], mounted: false, holds_system: false`. That is the boot disk offered
        // as a pool candidate. Refusing the listing is the only safe reading of it.
        let json = r#"{"blockdevices":[
          {"kname":"sda","type":"disk","size":161061273600,"pttype":"gpt"},
          {"kname":"sda1","type":"part","size":160000000000,"fstype":"ext4",
           "mountpoints":["/"]}]}"#;
        let error = parse(json).expect_err("a flat listing cannot be read");
        assert!(
            format!("{error:?}").contains("flat list"),
            "the failure has to name what went wrong: {error:?}"
        );
    }

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
    fn the_system_disk_is_found_when_it_has_several_mount_points() {
        // THE FAILURE THIS FILE SHIPPED WITH. On the standard btrfs subvolume layout — Debian and
        // Ubuntu `@`/`@home`, openSUSE, Fedora — the root partition is mounted at `/` with
        // `subvol=@` and at `/home` with `subvol=@home`. Neither mountinfo entry has fs-root `/`,
        // so lsblk's SINGULAR column falls through its fixup and answers `/home`, and the
        // appliance's own boot disk came back `holds_system: false`.
        let json = r#"{"blockdevices":[
          {"kname":"nvme0n1","type":"disk","size":512110190592,"pttype":"gpt","children":[
            {"kname":"nvme0n1p2","type":"part","size":511573319680,"fstype":"btrfs",
             "mountpoint":"/home","mountpoints":["/home","/","/var/log"],"children":[]}]}]}"#;
        let (disks, _) = parse(json).expect("parses");
        assert!(
            disks[0].holds_system,
            "the disk carrying / must be reported as the system disk however many places it is \
             also mounted"
        );
        assert!(disks[0].mounted);
    }

    #[test]
    fn the_singular_column_is_still_read_when_the_plural_one_is_absent() {
        // A build of lsblk without MOUNTPOINTS must degrade to the old behaviour rather than to
        // "nothing is mounted anywhere", which would be the dangerous direction.
        let json = r#"{"blockdevices":[
          {"kname":"sda","type":"disk","size":1,"children":[
            {"kname":"sda1","type":"part","size":1,"fstype":"ext4","mountpoint":"/",
             "children":[]}]}]}"#;
        let (disks, _) = parse(json).expect("parses");
        assert!(disks[0].holds_system);
    }

    #[test]
    fn an_unmounted_device_reporting_a_null_entry_is_not_mounted() {
        // lsblk writes `"mountpoints":[null]` rather than an empty array for a device that is not
        // mounted. Read naively that is one mount point, and every blank disk would look in use.
        let json = r#"{"blockdevices":[
          {"kname":"sdb","type":"disk","size":1,"mountpoints":[null],"children":[]}]}"#;
        let (disks, _) = parse(json).expect("parses");
        assert!(!disks[0].mounted);
        assert!(!disks[0].holds_system);
    }

    #[test]
    fn the_esp_at_slash_efi_counts_as_the_system() {
        // systemd-gpt-auto mounts the ESP at /efi on an XBOOTLDR layout, where /boot is a separate
        // partition and the ESP is not underneath it.
        let json = r#"{"blockdevices":[
          {"kname":"sdc","type":"disk","size":1,"children":[
            {"kname":"sdc1","type":"part","size":1,"fstype":"vfat","mountpoints":["/efi"],
             "children":[]}]}]}"#;
        let (disks, _) = parse(json).expect("parses");
        assert!(disks[0].holds_system);
    }

    #[test]
    fn a_disk_with_anything_on_it_is_refused_by_the_agent_and_not_only_by_the_wizard() {
        // "The disk must be blank" is stated by the wizard, by the OpenAPI description and by the
        // README. Until a review said so it was enforced ONLY in browser JavaScript: a direct API
        // call naming a disk full of data passed the route, which checks nothing by design, passed
        // this function, and reached `zpool create`.
        let mut disk = present("ata-A", "0xA", false);
        disk.holds = vec!["ext4".into()];
        let error = plan(
            "tank",
            PoolTopology::Single,
            &[named("ata-A", "0xA")],
            &[disk],
        )
        .expect_err("must refuse");
        assert!(matches!(error, PoolPlanError::NotBlank { .. }), "{error}");
    }

    #[test]
    fn a_mounted_disk_is_refused() {
        let mut disk = present("ata-A", "0xA", false);
        disk.mounted = true;
        let error = plan(
            "tank",
            PoolTopology::Single,
            &[named("ata-A", "0xA")],
            &[disk],
        )
        .expect_err("must refuse");
        assert!(matches!(error, PoolPlanError::Mounted { .. }), "{error}");
    }

    #[test]
    fn a_removable_disk_is_refused() {
        // Described as a refusal in op.rs and in the OpenAPI document long before anything refused
        // it. A vdev that can be unplugged by someone tidying a desk is not redundancy.
        let mut disk = present("ata-USB", "0xU", false);
        disk.removable = true;
        let error = plan(
            "tank",
            PoolTopology::Single,
            &[named("ata-USB", "0xU")],
            &[disk],
        )
        .expect_err("must refuse");
        assert!(matches!(error, PoolPlanError::Removable { .. }), "{error}");
    }

    #[test]
    fn the_system_disk_is_named_as_such_even_when_it_also_has_content() {
        // Ordering inside the loop. A system disk always has a partition table, so a `NotBlank`
        // check placed first would tell the operator to clear their boot disk.
        let mut disk = present("ata-SYS", "0xS", true);
        disk.holds = vec!["gpt".into(), "ext4".into()];
        disk.mounted = true;
        let error = plan(
            "tank",
            PoolTopology::Single,
            &[named("ata-SYS", "0xS")],
            &[disk],
        )
        .expect_err("must refuse");
        assert!(matches!(error, PoolPlanError::SystemDisk { .. }), "{error}");
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

    fn present(by_id: &str, wwn: &str, system: bool) -> DiskInfo {
        DiskInfo {
            by_id: Some(by_id.to_string()),
            kname: "sdx".into(),
            size_bytes: 1_000,
            model: None,
            serial: None,
            wwn: Some(wwn.to_string()),
            rotational: true,
            removable: false,
            transport: None,
            holds: vec![],
            mounted: false,
            holds_system: system,
        }
    }

    fn named(by_id: &str, wwn: &str) -> DiskRef {
        DiskRef {
            by_id: crate::op::SafeComponent::parse(by_id).expect("test id"),
            wwn: wwn.to_string(),
        }
    }

    #[test]
    fn a_mirror_becomes_a_zpool_create_with_the_adr_0004_properties() {
        let inventory = [
            present("ata-A", "0xA", false),
            present("ata-B", "0xB", false),
        ];
        let argv = plan(
            "tank",
            PoolTopology::Mirror,
            &[named("ata-A", "0xA"), named("ata-B", "0xB")],
            &inventory,
        )
        .expect("a valid mirror");

        assert_eq!(argv[0], "create");
        // ADR-0004 chose POSIX ACLs and the `xattr=sa` that makes them cheap. As POOL defaults, so
        // a dataset created without saying so inherits them rather than getting `off`.
        assert!(argv.windows(2).any(|w| w == ["-O", "acltype=posixacl"]));
        assert!(argv.windows(2).any(|w| w == ["-O", "xattr=sa"]));
        assert!(argv.windows(2).any(|w| w == ["-o", "ashift=12"]));
        assert!(argv.windows(2).any(|w| w == ["-m", "none"]));
        // The name, the keyword, then the members, in that order — `zpool` is positional.
        let tail: Vec<&str> = argv
            .iter()
            .rev()
            .take(4)
            .rev()
            .map(String::as_str)
            .collect();
        assert_eq!(
            tail,
            [
                "tank",
                "mirror",
                "/dev/disk/by-id/ata-A",
                "/dev/disk/by-id/ata-B"
            ]
        );
    }

    #[test]
    fn it_never_forces() {
        // The gate this product does not own. Without `-f`, `zpool create` refuses a device that
        // already holds a filesystem — so a disk with data on it cannot be taken by this operation
        // however it was confirmed, and clearing one stays something an operator does themselves.
        let inventory = [present("ata-A", "0xA", false)];
        let argv = plan(
            "tank",
            PoolTopology::Single,
            &[named("ata-A", "0xA")],
            &inventory,
        )
        .expect("a valid single-disk pool");
        assert!(!argv.iter().any(|a| a == "-f" || a == "--force"));
    }

    #[test]
    fn a_single_disk_pool_gets_no_topology_keyword() {
        let inventory = [present("ata-A", "0xA", false)];
        let argv = plan(
            "tank",
            PoolTopology::Single,
            &[named("ata-A", "0xA")],
            &inventory,
        )
        .expect("valid");
        assert!(!argv.iter().any(|a| a == "single"));
        assert_eq!(
            argv.last().map(String::as_str),
            Some("/dev/disk/by-id/ata-A")
        );
    }

    #[test]
    fn the_system_disk_is_refused_however_it_is_confirmed() {
        // No confirmation makes this the thing the operator meant. Overwriting it destroys the
        // appliance, so the refusal is here rather than in a dialogue.
        let inventory = [
            present("ata-A", "0xA", false),
            present("ata-SYS", "0xS", true),
        ];
        let error = plan(
            "tank",
            PoolTopology::Mirror,
            &[named("ata-A", "0xA"), named("ata-SYS", "0xS")],
            &inventory,
        )
        .expect_err("must refuse");
        assert!(matches!(error, PoolPlanError::SystemDisk { .. }), "{error}");
    }

    #[test]
    fn a_swapped_disk_is_refused_even_though_the_name_still_matches() {
        // The check that makes the confirmation mean anything. `/dev/disk/by-id` names a DEVICE,
        // and a device can be pulled and another put in the same slot between the inventory the
        // operator read and the button they pressed — so the name alone confirms nothing.
        let inventory = [present("ata-A", "0xSOMETHING-ELSE", false)];
        let error = plan(
            "tank",
            PoolTopology::Single,
            &[named("ata-A", "0xA")],
            &inventory,
        )
        .expect_err("must refuse");
        assert!(
            matches!(error, PoolPlanError::WwnMismatch { .. }),
            "{error}"
        );
    }

    #[test]
    fn a_disk_the_box_does_not_report_is_refused() {
        let error = plan(
            "tank",
            PoolTopology::Single,
            &[named("ata-GHOST", "0xG")],
            &[],
        )
        .expect_err("must refuse");
        assert!(matches!(error, PoolPlanError::Unknown { .. }), "{error}");
    }

    #[test]
    fn one_disk_cannot_be_a_mirror_of_itself() {
        // Named twice, `zpool` would happily build a "mirror" of one device with itself: a single
        // point of failure wearing the word mirror.
        let inventory = [present("ata-A", "0xA", false)];
        let error = plan(
            "tank",
            PoolTopology::Mirror,
            &[named("ata-A", "0xA"), named("ata-A", "0xA")],
            &inventory,
        )
        .expect_err("must refuse");
        assert!(matches!(error, PoolPlanError::Duplicate { .. }), "{error}");
    }

    #[test]
    fn an_arrangement_needs_enough_disks_to_mean_what_it_says() {
        // `raidz1` with two disks creates a pool with the storage of one disk and the redundancy
        // of a mirror, described by a word that promises something else.
        let inventory = [
            present("ata-A", "0xA", false),
            present("ata-B", "0xB", false),
        ];
        for (topology, count) in [
            (PoolTopology::Mirror, 1),
            (PoolTopology::Raidz1, 2),
            (PoolTopology::Raidz2, 2),
        ] {
            let named: Vec<DiskRef> = [named("ata-A", "0xA"), named("ata-B", "0xB")]
                .into_iter()
                .take(count)
                .collect();
            let error = plan("tank", topology, &named, &inventory).expect_err("must refuse");
            assert!(
                matches!(error, PoolPlanError::TooFewDisks { .. }),
                "{error}"
            );
        }
    }

    #[test]
    fn a_single_disk_pool_takes_exactly_one() {
        // Otherwise `Single` with two disks would be a STRIPE — the arrangement in which losing
        // either disk loses everything, which is the one thing that must not be reachable by
        // picking the wrong item in a list.
        let inventory = [
            present("ata-A", "0xA", false),
            present("ata-B", "0xB", false),
        ];
        let error = plan(
            "tank",
            PoolTopology::Single,
            &[named("ata-A", "0xA"), named("ata-B", "0xB")],
            &inventory,
        )
        .expect_err("must refuse");
        assert!(
            matches!(error, PoolPlanError::TooManyDisks { .. }),
            "{error}"
        );
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
