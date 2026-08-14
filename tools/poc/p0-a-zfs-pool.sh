#!/usr/bin/env bash
# P0-A — ADR-0012's disk-identity chain, then the ZFS fundamentals ADR-0007 rests on.
#
# The order of the sections is not cosmetic. ADR-0012 calls the disk-identity question "PoC'nin
# ilk beş dakikada kanıtlaması gereken şey", so section 1 runs before a single byte is written to
# a vdev. If /dev/disk/by-id turns out to be empty, transport-derived, or shared between two
# disks on Hyper-V, then risk R1 (destroying the wrong disk) is unmitigated and a perfectly
# working pool underneath it means nothing — DEPSIS would be selecting disks by a name that moves.
#
# ADR-0012 marks exactly two things "inferred" and predicts one outright failure:
#   inferred  — the FORM of the by-id symlink (wwn-0x… NAA vs scsi-1…/scsi-3… T10);
#   inferred  — that any of this holds on the Debian trixie kernel at all;
#   predicted failure — storvsc_host_mishandles_cmd() suppresses INQUIRY page 0x80, so there is
#                       NO usable SCSI unit serial.
# That last one is why a serial appearing here is bad news, not good news: it would mean the ADR
# is wrong about the target, so it is reported with `unexpected` rather than quietly accepted.
#
# Sections 2–7 then prove the storage primitives ADR-0007 Katman 2 exposes (pool, dataset,
# snapshot, send/receive, scrub, import, degraded operation) actually behave the way the rest of
# the design assumes on this exact kernel and zfs build.

POC_ID=p0-a
# shellcheck source=lib/common.sh
. "$(dirname "$(readlink -f "$0")")/lib/common.sh"

require_test_environment

SCRIPT_DIR=$(dirname "$(readlink -f "$0")")
BYID=/dev/disk/by-id
BYPARTUUID=/dev/disk/by-partuuid
WORK=$(mktemp -d /tmp/p0a.XXXXXX)

# The vdevs are 20 GB. The 64 MB CIDATA seed disk must never be mistaken for one, and neither
# must anything else small that happens to be attached.
MIN_VDEV_BYTES=$((5 * 1024 * 1024 * 1024))
# Minimum host-GUID prefix (in hex digits) we are willing to call a match. 12 nibbles is 6 bytes;
# anything shorter is coincidence across four disks, not evidence of a shared identifier.
MATCH_MIN_NIBBLES=12

cleanup() {
  section 'Cleanup'
  # Section 6 exports the pool. If the run dies between the export and the import, cleanup_pool
  # would not see the pool in `zpool list` and would leave it live on the vdevs.
  zpool import -d "$BYID" -N -f "$DEPSIS_TEST_POOL" >/dev/null 2>&1 || true
  cleanup_pool
  rm -rf "${WORK:?}"
}
trap cleanup EXIT

# ─── helpers ──────────────────────────────────────────────────────────────────

# Every non-partition /dev/disk/by-id name that resolves to block device $1.
links_for_dev() {
  local dev="$1" l
  for l in "$BYID"/*; do
    [ -e "$l" ] || continue
    case "${l##*/}" in *-part[0-9]*) continue ;; esac
    if [ "$(readlink -f "$l")" = "$dev" ]; then printf '%s\n' "$l"; fi
  done
  return 0
}

# What the first character after the prefix tells us about where the name came from. udev's
# scsi_id encodes the page-0x83 DESIGNATOR TYPE as the leading digit, so this is not guesswork:
# a leading 0 or S means udev never got a page 0x83 and fabricated the name from vendor/model,
# which would make the whole ADR-0012 tier-1 story false while still looking like a stable link.
idlink_form() {
  case "${1##*/}" in
    wwn-0x6*)     echo 'wwn-0x6… — NAA-6 (IEEE Registered Extended) from VPD page 0x83' ;;
    wwn-0x*)      echo 'wwn-0x… — NAA from VPD page 0x83' ;;
    scsi-1*)      echo 'scsi-1… — page 0x83 designator type 1 (T10 vendor ID)' ;;
    scsi-2*)      echo 'scsi-2… — page 0x83 designator type 2 (EUI-64)' ;;
    scsi-3*)      echo 'scsi-3… — page 0x83 designator type 3 (NAA)' ;;
    scsi-8*)      echo 'scsi-8… — page 0x83 designator type 8 (SCSI name string)' ;;
    scsi-0*)      echo 'scsi-0… — scsi_id FALLBACK from vendor+model+serial, NOT page 0x83' ;;
    scsi-S*)      echo 'scsi-S… — legacy serial-derived, NOT page 0x83' ;;
    ata-*|nvme-*) echo 'ata-/nvme- — not the Hyper-V synthetic SCSI path at all' ;;
    *)            echo 'unrecognised form' ;;
  esac
}

is_page83_form() {
  case "${1##*/}" in
    wwn-0x*|scsi-1*|scsi-2*|scsi-3*|scsi-8*) return 0 ;;
    *) return 1 ;;
  esac
}

# Reduce an identifier to its bare lowercase hex payload, so a host-side GUID can be searched for
# inside it without tripping over "0x", the scsi_id type digit, or separators.
hexonly() {
  local s="${1##*/}"
  s="${s#wwn-0x}"; s="${s#scsi-}"; s="${s#wwn-}"
  tr 'A-Z' 'a-z' <<<"$s" | tr -cd '0-9a-f'
}

# GUID as flat lowercase hex, exactly as written.
guid_hex() { tr -d '{}-' <<<"$1" | tr 'A-Z' 'a-z'; }

# GUID as it appears ON THE WIRE: Windows stores the first three fields little-endian, so a
# firmware-generated descriptor built from the raw bytes reads byte-swapped relative to the
# string Get-VHD printed. Both spellings must be tried or a real match looks like a failure.
guid_hex_swapped() {
  local g a b c rest
  g=$(tr -d '{}' <<<"$1" | tr 'A-Z' 'a-z')
  a=${g:0:8}; b=${g:9:4}; c=${g:14:4}; rest="${g:19:4}${g:24:12}"
  echo "${a:6:2}${a:4:2}${a:2:2}${a:0:2}${b:2:2}${b:0:2}${c:2:2}${c:0:2}${rest}"
}

# Longest prefix of hex string $1 that occurs anywhere in blob $2. Prints the length, 0 if none.
longest_prefix_hit() {
  local hex="$1" blob="$2" len
  for len in 32 28 24 20 16 12; do
    if [ "${#hex}" -ge "$len" ] && grep -qi -- "${hex:0:len}" <<<"$blob"; then
      echo "$len"; return 0
    fi
  done
  echo 0
  return 0
}

# sha256 of every regular file under $1, path-sorted. Used to prove replication and degraded
# reads return the same bytes, not merely the same file names.
manifest() { ( cd "$1" && find . -type f -print0 | sort -z | xargs -0 -r sha256sum ); }

check_manifest() { # desc, expected manifest, path
  local got
  got=$(manifest "$3")
  if [ "$2" = "$got" ]; then
    pass "$1" "$(printf '%s\n' "$2" | wc -l | tr -d ' ') files verified by sha256"
  else
    fail "$1" "$(diff <(printf '%s\n' "$2") <(printf '%s\n' "$got") | tr '\n' ' ' || true)"
  fi
}

parse_expected_ids() { # prints "<host vdev name>\t<DiskIdentifier>" per line
  local f="$1"
  if command -v jq >/dev/null 2>&1; then
    # PowerShell 5.1's `Set-Content -Encoding UTF8` writes a BOM (the same trap ADR-0012 hit with
    # cloud-init), and jq refuses to parse a document that starts with one.
    sed '1s/^\xEF\xBB\xBF//' "$f" | jq -r 'to_entries[] | "\(.key)\t\(.value.diskIdentifier)"'
  else
    awk -F'"' '/^[[:space:]]*"[^"]+"[[:space:]]*:[[:space:]]*\{/ {k=$2}
               /diskIdentifier/ {print k "\t" $4}' "$f"
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
section '0. Environment'
# ═══════════════════════════════════════════════════════════════════════════════
note "kernel: $(uname -r)"
note "zfs version: $(zfs version 2>&1 | head -1 | tr -d '\n')"
# ADR-0000 leaves the trixie package versions unverified; every number below is measured here.
note "zfsutils-linux: $(dpkg-query -W -f='${Version}' zfsutils-linux 2>/dev/null || echo 'not installed')"
note "sg3-utils: $(dpkg-query -W -f='${Version}' sg3-utils 2>/dev/null || echo 'not installed')"
note "util-linux: $(dpkg-query -W -f='${Version}' util-linux 2>/dev/null || echo '?')"
note "build marker: $(tr -d '\n' </etc/depsis-poc-build.json)"

# ═══════════════════════════════════════════════════════════════════════════════
section '1. Disk identity — ADR-0012 tier 1 (/dev/disk/by-id from VPD page 0x83)'
# ═══════════════════════════════════════════════════════════════════════════════

if [ ! -d "$BYID" ]; then
  fail "$BYID does not exist at all" \
       'ADR-0012 tier 1 is dead: DEPSIS would have nothing but /dev/sdX to name a disk with'
  poc_summary
  exit 1
fi
pass "$BYID exists" "$(find "$BYID" -maxdepth 1 -type l | wc -l | tr -d ' ') symlinks total"

# poc_vdevs hands back by-id LINKS, and on Hyper-V a single disk normally has more than one
# (a wwn- form and a scsi- form). lib/common.sh does not collapse them, so asking for a large
# count and deduplicating on realpath here is the only way to be sure the "mirror" below is
# built from two DIFFERENT disks rather than two names for the same one.
ID_CANDIDATES=()
for want in 12 8 6 4 2; do
  mapfile -t ID_CANDIDATES < <(poc_vdevs "$want" 2>/dev/null || true)
  if [ "${#ID_CANDIDATES[@]}" -gt 0 ]; then break; fi
done
if [ "${#ID_CANDIDATES[@]}" -eq 0 ]; then
  fail 'poc_vdevs returned no by-id disks' \
       'either /dev/disk/by-id is empty or every entry resolves to the root disk'
  poc_summary
  exit 1
fi

declare -A DEV_LINK=() DEV_IDBLOB=() DEV_PRIMARY=()
DEVS=()
alias_count=0
for l in "${ID_CANDIDATES[@]}"; do
  [ -e "$l" ] || continue
  d=$(readlink -f "$l")
  if [ -n "${DEV_LINK[$d]:-}" ]; then alias_count=$((alias_count + 1)); continue; fi
  sz=$(blockdev --getsize64 "$d" 2>/dev/null || echo 0)
  if [ "$sz" -lt "$MIN_VDEV_BYTES" ]; then
    warn "skipping $l -> $d ($sz bytes): too small to be a 20 GB vdev, probably the CIDATA seed"
    continue
  fi
  mounted=$(lsblk -nro MOUNTPOINT "$d" 2>/dev/null | grep -c . || true)
  if [ "$mounted" -gt 0 ]; then
    # Belt and braces on top of poc_vdevs' root-disk exclusion. R1 is the one risk where a
    # redundant check costs nothing and a missing one costs the machine.
    warn "skipping $l -> $d: it carries mounted filesystems, refusing to treat it as a vdev"
    continue
  fi
  DEV_LINK[$d]="$l"
  DEVS+=("$d")
done

if [ "${#DEVS[@]}" -lt 2 ]; then
  fail 'fewer than 2 usable vdev disks resolved from /dev/disk/by-id' "candidates: ${ID_CANDIDATES[*]}"
  poc_summary
  exit 1
fi
note "distinct vdev block devices under test: ${DEVS[*]}"
if [ "$alias_count" -gt 0 ]; then
  note "$alias_count of the names poc_vdevs returned were aliases of a disk already counted" \
       'lib/common.sh does not dedupe on realpath; a caller trusting it could build a "mirror" from one disk'
fi

# ─── 1a. what form is the by-id name, and is it really page-0x83 derived? ──────
declare -A FORMS_SEEN=()
for d in "${DEVS[@]}"; do
  mapfile -t links < <(links_for_dev "$d")
  if [ "${#links[@]}" -eq 0 ]; then
    fail "$d has NO /dev/disk/by-id name" 'this disk can only be addressed by a name that moves'
    continue
  fi
  blob=""
  primary=""
  for l in "${links[@]}"; do
    note "  $d <- ${l##*/}" "$(idlink_form "$l")"
    blob+="$(hexonly "$l")"$'\n'
    FORMS_SEEN["$(idlink_form "$l")"]=1
    if [ -z "$primary" ] && is_page83_form "$l"; then primary="$l"; fi
  done

  # udev's own view, straight from the tool that generates the names above.
  SCSI_ID=""
  for c in /usr/lib/udev/scsi_id /lib/udev/scsi_id; do
    if [ -x "$c" ]; then SCSI_ID="$c"; break; fi
  done
  if [ -n "$SCSI_ID" ]; then
    sid=$("$SCSI_ID" --page=0x83 --whitelisted --device="$d" 2>&1) || sid=""
    note "  scsi_id --page=0x83 $d: ${sid:-<empty>}"
    if [ -n "$sid" ]; then blob+="$(hexonly "$sid")"$'\n'; fi
  else
    warn "scsi_id helper not found; the udev-side page-0x83 cross-check is SKIPPED for $d"
  fi

  DEV_IDBLOB[$d]="$blob"
  if [ -n "$primary" ]; then
    DEV_PRIMARY[$d]="$primary"
    pass "$d has a page-0x83-derived by-id name" "${primary##*/}"
  else
    DEV_PRIMARY[$d]="${links[0]}"
    fail "$d has by-id names but none derived from VPD page 0x83" \
         "forms: ${links[*]##*/} — these are transport or model derived and are NOT stable identity"
  fi
done

# ADR-0012 lists the symlink form as inferred. This is the line that settles it.
note "ADR-0012 'inferred' item SETTLED — by-id form(s) observed on this target: ${!FORMS_SEEN[*]}"

# ─── 1b. there must be NO usable SCSI unit serial ─────────────────────────────
section '1b. SCSI unit serial — ADR-0012 predicts page 0x80 is suppressed by storvsc'

any_serial=0
for d in "${DEVS[@]}"; do
  kname=$(basename "$d")
  sysdev="/sys/block/$kname/device"

  # The kernel caches whichever VPD pages it managed to read. These two sysfs files are the most
  # direct evidence obtainable: pg83 present means storvsc's BLIST_TRY_VPD_PAGES really does open
  # VPD reads on trixie, and pg80 absent means storvsc_host_mishandles_cmd() really does mask the
  # unit serial. Neither fact is visible from userspace tooling alone.
  if [ -s "$sysdev/vpd_pg83" ]; then
    pass "$kname: kernel cached VPD page 0x83" "$(stat -c %s "$sysdev/vpd_pg83") bytes"
  else
    fail "$kname: kernel holds no VPD page 0x83" \
         'every by-id name for this disk therefore came from a fallback, not from device identity'
  fi

  if [ -e "$sysdev/vpd_pg80" ]; then
    pg80=$(tr -d '\0' <"$sysdev/vpd_pg80" 2>/dev/null | tr -cd '[:print:]' || true)
    if [ -n "$pg80" ]; then
      any_serial=1
      unexpected "$kname: kernel DID read VPD page 0x80 and it carries content" \
                 "'$pg80' — ADR-0012 says storvsc masks this page; the ADR is wrong about trixie"
    else
      pass "$kname: vpd_pg80 exists but is empty" 'no usable unit serial, as ADR-0012 predicts'
    fi
  else
    pass "$kname: no vpd_pg80 in sysfs at all" 'page 0x80 masked, as ADR-0012 predicts'
  fi

  # lsblk's SERIAL column is filled from udev's ID_SERIAL_SHORT, which scsi_id derives from
  # page 0x83 when there is no page 0x80. A non-empty value here is NOT a unit serial, and
  # reading it as one is precisely how storage_devices.serial would end up full of WWNs.
  lsser=$(lsblk -dno SERIAL "$d" 2>/dev/null | tr -d ' ' || true)
  note "  lsblk -o NAME,SERIAL $kname: '${lsser:-<empty>}'" \
       'page-0x83 derived if present; not evidence of a unit serial number'

  # ID_SCSI_SERIAL is the property udev sets only when the page 0x80 read succeeded.
  scsiser=$(udevadm info --query=property --name="$d" 2>/dev/null | sed -n 's/^ID_SCSI_SERIAL=//p' || true)
  if [ -n "$scsiser" ]; then
    any_serial=1
    unexpected "$kname: udev exported ID_SCSI_SERIAL" \
               "'$scsiser' — page 0x80 IS readable here, contradicting ADR-0012"
  else
    pass "$kname: udev exported no ID_SCSI_SERIAL"
  fi

  if command -v sg_vpd >/dev/null 2>&1; then
    rc=0
    out=$(sg_vpd --page=0x80 "$d" 2>&1) || rc=$?
    ser=$(sed -n 's/.*[Uu]nit serial number: *//p' <<<"$out" | tr -d ' \t')
    note "  sg_vpd --page=0x80 $kname (rc=$rc): ${out//$'\n'/ | }"
    if [ "$rc" -ne 0 ] || [ -z "$ser" ]; then
      pass "$kname: sg_vpd returns no unit serial"
    else
      any_serial=1
      unexpected "$kname: sg_vpd read a unit serial from page 0x80" \
                 "'$ser' — ADR-0012's 'kullanılabilir bir SCSI seri numarası yok' is wrong"
    fi
  elif command -v sg_inq >/dev/null 2>&1; then
    rc=0
    out=$(sg_inq --page=0x80 "$d" 2>&1) || rc=$?
    note "  sg_inq --page=0x80 $kname (rc=$rc): ${out//$'\n'/ | }"
  else
    warn 'neither sg_vpd nor sg_inq is installed (sg3-utils); the page-0x80 probe is SKIPPED'
    note 'page 0x80 probe SKIPPED — only the sysfs and udev evidence above stands'
  fi
done

if [ "$any_serial" -eq 0 ]; then
  note 'schema consequence CONFIRMED: storage_devices.serial must stay nullable and can never be a key' \
       'no disk on this target reports a SCSI unit serial through any of four independent paths'
else
  warn 'a SCSI serial appeared. ADR-0012 must be corrected before the schema decision is cited as verified.'
fi

# ─── 1c. page 0x83 versus what the host recorded at creation ──────────────────
section '1c. VPD page 0x83 vs the DiskIdentifiers the host wrote at creation time'

if command -v sg_vpd >/dev/null 2>&1; then
  for d in "${DEVS[@]}"; do
    p83=$(sg_vpd --page=0x83 "$d" 2>&1) || p83='(sg_vpd failed)'
    note "  page 0x83 $d: ${p83//$'\n'/ | }"
  done
else
  warn 'sg_vpd unavailable; the decoded page-0x83 dump is SKIPPED (sysfs vpd_pg83 above still holds)'
fi

# provision-debian.ps1 writes this next to the VHDXs on the Windows host. It does not reach the
# guest by itself, so the comparison is best-effort — but say so loudly when it is missing,
# because without it the host<->guest binding is an assumption rather than the machine-checkable
# invariant ADR-0012 claims.
EXPECTED_JSON=""
for c in "${DEPSIS_EXPECTED_IDS:-}" \
         /etc/depsis/expected-disk-ids.json \
         /etc/depsis-poc-expected-disk-ids.json \
         "$SCRIPT_DIR/../../deploy/vm/artifacts/depsis-poc/expected-disk-ids.json"; do
  if [ -n "$c" ] && [ -r "$c" ]; then EXPECTED_JSON="$c"; break; fi
done

if [ -z "$EXPECTED_JSON" ]; then
  warn 'expected-disk-ids.json is not reachable from the guest'
  note 'HOST<->GUEST IDENTITY BINDING UNPROVEN' \
       'copy deploy/vm/artifacts/depsis-poc/expected-disk-ids.json into the guest or set DEPSIS_EXPECTED_IDS, then re-run; until then R1 rests on the guest-side evidence only'
else
  note "comparing against $EXPECTED_JSON"
  mapfile -t EXPECTED < <(parse_expected_ids "$EXPECTED_JSON" 2>/dev/null || true)
  if [ "${#EXPECTED[@]}" -eq 0 ]; then
    fail 'expected-disk-ids.json parsed to zero entries' "$EXPECTED_JSON"
  fi
  declare -A CLAIMED_BY=()
  for e in "${EXPECTED[@]}"; do
    [ -n "$e" ] || continue
    hname=${e%%$'\t'*}
    guid=${e#*$'\t'}
    raw=$(guid_hex "$guid")
    swp=$(guid_hex_swapped "$guid")
    hit=""; hitlen=0; hitform=""
    for d in "${DEVS[@]}"; do
      n=$(longest_prefix_hit "$raw" "${DEV_IDBLOB[$d]}"); form='as-written'
      if [ "$n" -lt "$MATCH_MIN_NIBBLES" ]; then
        n=$(longest_prefix_hit "$swp" "${DEV_IDBLOB[$d]}"); form='byte-swapped'
      fi
      if [ "$n" -ge "$MATCH_MIN_NIBBLES" ] && [ "$n" -gt "$hitlen" ]; then
        hit="$d"; hitlen="$n"; hitform="$form"
      fi
    done
    if [ -z "$hit" ]; then
      # NAA-6 is 16 bytes, of which 8 are consumed by the type nibble and Microsoft's IEEE OUI,
      # so a truncated match is expected and fine. NO match at all is not: it means the guest
      # identifier is not derived from the VHDX DiskIdentifier and the host-side JSON cannot be
      # used to verify a disk's role at all.
      fail "host $hname ($guid) matches no guest by-id identifier" \
           "tried as-written=$raw and byte-swapped=$swp against: ${DEV_IDBLOB[*]//$'\n'/ }"
    elif [ -n "${CLAIMED_BY[$hit]:-}" ]; then
      fail "host $hname and host ${CLAIMED_BY[$hit]} both map to guest $hit" \
           'two host VHDXs share one guest identifier — a VHDX was copied without Set-VHD -ResetDiskIdentifier'
    else
      CLAIMED_BY[$hit]="$hname"
      pass "host $hname -> guest $hit" \
           "$hitlen hex digits of the $hitform DiskIdentifier found in ${DEV_PRIMARY[$hit]##*/}"
    fi
  done
fi

# ─── 1d. the identifiers must be DISTINCT ─────────────────────────────────────
section '1d. Every vdev must carry a distinct identifier'

# A copied VHDX duplicates its page-0x83 descriptor. udev would then point one by-id name at
# whichever disk enumerated last and DEPSIS would happily "mirror" a disk with itself.
primaries=()
for d in "${DEVS[@]}"; do primaries+=("${DEV_PRIMARY[$d]##*/}"); done
uniq_names=$(printf '%s\n' "${primaries[@]}" | sort -u | wc -l | tr -d ' ')
assert_eq 'by-id names are unique across the vdevs' "${#primaries[@]}" "$uniq_names"

# Independent of udev entirely: hash the raw descriptor the kernel cached.
p83_hashes=()
for d in "${DEVS[@]}"; do
  f="/sys/block/$(basename "$d")/device/vpd_pg83"
  if [ -s "$f" ]; then p83_hashes+=("$(sha256sum <"$f" | cut -d' ' -f1)"); fi
done
if [ "${#p83_hashes[@]}" -eq "${#DEVS[@]}" ]; then
  uniq_p83=$(printf '%s\n' "${p83_hashes[@]}" | sort -u | wc -l | tr -d ' ')
  assert_eq 'raw VPD page 0x83 descriptors are unique across the vdevs' "${#DEVS[@]}" "$uniq_p83"
else
  fail 'not every vdev exposes vpd_pg83; descriptor uniqueness cannot be checked at the kernel level' \
       "${#p83_hashes[@]} of ${#DEVS[@]} disks"
fi

# ─── 1e. by-path, recorded and then never used again ──────────────────────────
section '1e. /dev/disk/by-path — cross-check only'

# ADR-0012 forbids by-path for role assignment: on VMBus SCSI it encodes controller+LUN, which is
# exactly the slot-dependent identity we are escaping. Moving a VHDX to a different
# ControllerLocation keeps its by-id name and changes its by-path name, so the only legitimate
# question by-path can answer is "is the disk I already identified still in the slot I expect?".
for d in "${DEVS[@]}"; do
  pth=$(udevadm info --query=property --name="$d" 2>/dev/null | sed -n 's/^ID_PATH=//p' || true)
  note "  $d by-path: ${pth:-<none>}" 'recorded for slot cross-check; never for role assignment'
done

# ═══════════════════════════════════════════════════════════════════════════════
section '2. Mirror pool created from by-id paths only'
# ═══════════════════════════════════════════════════════════════════════════════

VDEV0="${DEV_PRIMARY[${DEVS[0]}]}"
VDEV1="${DEV_PRIMARY[${DEVS[1]}]}"
B0=$(basename "$VDEV0")
B1=$(basename "$VDEV1")
note "mirror members: $B0 + $B1"

cleanup_pool
zpool create -f -m "$DEPSIS_POC_ROOT" "$DEPSIS_TEST_POOL" mirror "$VDEV0" "$VDEV1"
pass 'zpool create succeeded with /dev/disk/by-id arguments' "$VDEV0 + $VDEV1"

status=$(zpool status "$DEPSIS_TEST_POOL")
note "zpool status: ${status//$'\n'/ | }"
assert_eq 'pool health is ONLINE' ONLINE "$(zpool list -H -o health "$DEPSIS_TEST_POOL")"
assert_contains 'topology is a mirror' 'mirror-0' "$status"

# The decisive part. If `zpool status` prints sdb/sdc instead of the by-id names, everything in
# section 1 is cosmetic: the pool config would identify members by a name that can move, and the
# DEPSIS UI would tell an operator to pull the wrong disk.
assert_contains 'zpool status names the first member by its by-id name'  "$B0" "$status"
assert_contains 'zpool status names the second member by its by-id name' "$B1" "$status"

# ashift is fixed forever at creation. Measure it rather than assert a value we cannot justify
# on a dynamic VHDX whose logical sector size is 512 and physical is host-dependent.
note "ashift chosen by ZFS: $(zpool get -H -o value ashift "$DEPSIS_TEST_POOL")" \
     'immutable after creation; measured on this VHDX, not a hardware number'
note "logical/physical sector size of $B0: $(blockdev --getss "$(readlink -f "$VDEV0")")/$(blockdev --getpbsz "$(readlink -f "$VDEV0")")"

# ═══════════════════════════════════════════════════════════════════════════════
section '3. Dataset with the ADR-0004 property set'
# ═══════════════════════════════════════════════════════════════════════════════

DATA_DS="$DEPSIS_TEST_POOL/data"
DATA_PATH="$DEPSIS_POC_ROOT/data"
zfs create -o mountpoint="$DATA_PATH" \
           -o acltype=posixacl \
           -o xattr=sa \
           -o dnodesize=auto \
           "$DATA_DS"

assert_eq 'acltype=posixacl took'  posixacl "$(zfs get -H -o value acltype   "$DATA_DS")"
assert_eq 'xattr=sa took'          sa       "$(zfs get -H -o value xattr     "$DATA_DS")"
assert_eq 'dnodesize=auto took'    auto     "$(zfs get -H -o value dnodesize "$DATA_DS")"

# dnodesize only matters because xattr=sa puts xattrs — including Samba's security.NTACL — inside
# the dnode. That in turn needs feature@large_dnode, which is a pool feature, not a dataset one:
# a dataset created with these properties on a pool without the feature would silently behave
# differently. Record the feature state so the property assertions above mean something.
note "feature@large_dnode: $(zpool get -H -o value feature@large_dnode "$DEPSIS_TEST_POOL")"

assert_eq 'dataset mounted at the requested path' "$DATA_PATH" "$(findmnt -no TARGET "$DATA_PATH" 2>/dev/null || echo MISSING)"

# ═══════════════════════════════════════════════════════════════════════════════
section '4. Snapshot, then zfs send | zfs receive'
# ═══════════════════════════════════════════════════════════════════════════════

mkdir -p "$DATA_PATH/tree/deep"
head -c 1048576 /dev/urandom >"$DATA_PATH/tree/blob.bin"
printf 'depsis p0-a\n' >"$DATA_PATH/tree/deep/text.txt"

# ADR-0004 keeps the whole ACL substrate in xattrs, so an xattr that does not survive replication
# would mean Phase 2 restores come back without permissions. Plant one and follow it through.
XATTR_PLANTED=0
if command -v setfattr >/dev/null 2>&1; then
  setfattr -n user.depsis.probe -v p0a "$DATA_PATH/tree/deep/text.txt"
  XATTR_PLANTED=1
else
  warn 'setfattr not installed (attr); the xattr survival check is SKIPPED'
  note 'xattr survival across send/receive UNPROVEN in this run'
fi

SRC_MANIFEST=$(manifest "$DATA_PATH")
SNAP="$DATA_DS@p0a"
zfs snapshot "$SNAP"
pass 'snapshot created' "$SNAP"

REPL_DS="$DEPSIS_TEST_POOL/replica"
send_recv() { zfs send "$1" | zfs receive "$2"; }
assert_cmd 'zfs send | zfs receive into a second dataset' ok -- send_recv "$SNAP" "$REPL_DS"

REPL_PATH=$(zfs get -H -o value mountpoint "$REPL_DS" 2>/dev/null || echo '')
if [ -d "$REPL_PATH" ]; then
  check_manifest 'replica content is byte-identical to the source' "$SRC_MANIFEST" "$REPL_PATH"
  if [ "$XATTR_PLANTED" -eq 1 ] && command -v getfattr >/dev/null 2>&1; then
    xv=$(getfattr --only-values -n user.depsis.probe "$REPL_PATH/tree/deep/text.txt" 2>/dev/null || true)
    assert_eq 'the user xattr survived send/receive (xattr=sa payload)' p0a "$xv"
  fi
else
  fail 'the received dataset has no usable mountpoint' "mountpoint='$REPL_PATH'"
fi

# A plain `zfs send` carries no dataset properties; the receiver inherits from its parent. On this
# pool the parent has defaults, so if the replica comes back with acltype=off then a Phase 2
# restore would produce a share whose POSIX ACLs are unenforceable — silently, which is the exact
# failure mode P0-B exists to catch. Measure it instead of assuming either way.
repl_acltype=$(zfs get -H -o value acltype "$REPL_DS" 2>/dev/null || echo '?')
repl_xattr=$(zfs get -H -o value xattr "$REPL_DS" 2>/dev/null || echo '?')
if [ "$repl_acltype" = posixacl ] && [ "$repl_xattr" = sa ]; then
  note "replica inherited acltype=$repl_acltype xattr=$repl_xattr" 'from the pool defaults, not from the stream'
else
  note "plain send/recv did NOT reproduce the ADR-0004 properties (replica acltype=$repl_acltype xattr=$repl_xattr)" \
       'Phase 2 replication must use zfs send -p, or re-apply the properties after receive'
fi

# ═══════════════════════════════════════════════════════════════════════════════
section '5. Scrub'
# ═══════════════════════════════════════════════════════════════════════════════

zpool scrub "$DEPSIS_TEST_POOL"
t0=$SECONDS
# Polled rather than `zpool wait -t scrub`, so the result does not hinge on a flag whose presence
# in this build has not been verified. There is ~1 MB of data here; a long run means the vdevs
# are misbehaving, not that the test is slow.
deadline=$((SECONDS + 300))
while zpool status "$DEPSIS_TEST_POOL" | grep -q 'scan:.*in progress'; do
  if [ "$SECONDS" -ge "$deadline" ]; then break; fi
  sleep 2
done
scrub_elapsed=$((SECONDS - t0))
scan_line=$(zpool status "$DEPSIS_TEST_POOL" | sed -n 's/^[[:space:]]*scan: //p' | head -1)
note "scrub settled in ${scrub_elapsed}s: $scan_line" \
     'wall clock on a near-empty dynamic VHDX; §18.2 numbers may not be quoted from this'

if grep -q 'in progress' <<<"$scan_line"; then
  fail 'scrub did not finish inside the 300s budget' "$scan_line"
else
  pass 'scrub completed' "$scan_line"
fi
assert_contains 'scrub reports zero errors' 'with 0 errors' "$scan_line"
assert_eq 'pool reports no known data errors' 'No known data errors' \
          "$(zpool status "$DEPSIS_TEST_POOL" | sed -n 's/^errors: //p' | head -1)"
assert_contains 'zpool status -x calls the pool healthy' 'is healthy' \
                "$(zpool status -x "$DEPSIS_TEST_POOL")"

# Any non-zero READ/WRITE/CKSUM on a freshly scrubbed mirror would mean the VHDX layer is losing
# or corrupting I/O, which would quietly invalidate every later PoC that measures ZFS behaviour.
badcols=$(zpool status "$DEPSIS_TEST_POOL" |
          awk 'NF>=5 && $2 ~ /^(ONLINE|DEGRADED|OFFLINE|FAULTED|UNAVAIL)$/ && ($3!="0"||$4!="0"||$5!="0")' || true)
if [ -z "$badcols" ]; then
  pass 'every vdev READ/WRITE/CKSUM counter is zero'
else
  fail 'a vdev carries non-zero error counters' "${badcols//$'\n'/ | }"
fi

# ═══════════════════════════════════════════════════════════════════════════════
section '6. Identity stability across an export/import round trip'
# ═══════════════════════════════════════════════════════════════════════════════

# ADR-0012 tier 2: the GPT partition GUID lives in the disk's own content, so unlike by-id it does
# not depend on the SCSI transport reporting anything. It only exists once ZFS has partitioned the
# disks, which is why it is checked here rather than in section 1.
pu0=$(blkid -s PARTUUID -o value "${VDEV0}-part1" 2>/dev/null || true)
pu1=$(blkid -s PARTUUID -o value "${VDEV1}-part1" 2>/dev/null || true)
if [ -e "${VDEV0}-part1" ] && [ -e "${VDEV1}-part1" ]; then
  pass 'udev created -part1 by-id links for both members' 'zpool import -d by-id depends on these'
else
  fail 'no -part1 by-id links after zpool create' 'importing by id would have to fall back to whole-disk scanning'
fi
if [ -n "$pu0" ] && [ -n "$pu1" ]; then
  assert_ne 'tier 2: the two vdev PARTUUIDs differ' "$pu0" "$pu1"
  if [ -e "$BYPARTUUID/$pu0" ] && [ -e "$BYPARTUUID/$pu1" ]; then
    pass 'tier 2: both PARTUUIDs are present in /dev/disk/by-partuuid' "$pu0 / $pu1"
  else
    fail 'tier 2: blkid knows the PARTUUIDs but /dev/disk/by-partuuid does not' "$pu0 / $pu1"
  fi
else
  fail 'tier 2: the ZFS vdev partitions carry no PARTUUID' "vdev0='$pu0' vdev1='$pu1'"
fi

before_links=$(find "$BYID" -maxdepth 1 -mindepth 1 -printf '%f\n' | sort)
# ADR-0012 tier 3: the vdev label GUID. If this survives, membership is recoverable no matter what
# the transport or the partition table says.
guids_of_pool() {
  zpool status -g "$DEPSIS_TEST_POOL" | awk 'NF>=5 && $1 ~ /^[0-9]+$/ {print $1}' | sort
}
before_guids=$(guids_of_pool)
note "tier 3 vdev/label GUIDs before export: ${before_guids//$'\n'/ }"

zpool export "$DEPSIS_TEST_POOL"
if zpool list -H -o name 2>/dev/null | grep -qx "$DEPSIS_TEST_POOL"; then
  fail 'pool is still listed after zpool export'
else
  pass 'pool exported'
fi

# The scan must find the pool through /dev/disk/by-id alone. If it only appears under a bare
# `zpool import` (which walks /dev), DEPSIS cannot pin imports to stable names and every boot
# re-derives membership from whatever sdX happens to be.
scan=$(zpool import -d "$BYID" 2>&1 || true)
assert_contains 'the exported pool is discoverable scanning only /dev/disk/by-id' \
                "$DEPSIS_TEST_POOL" "$scan"
assert_cmd 'zpool import -d /dev/disk/by-id re-imports the pool' ok \
  -- zpool import -d "$BYID" "$DEPSIS_TEST_POOL"

after_links=$(find "$BYID" -maxdepth 1 -mindepth 1 -printf '%f\n' | sort)
assert_eq 'the /dev/disk/by-id namespace is unchanged by the round trip' "$before_links" "$after_links"
assert_eq 'tier 3: vdev label GUIDs are unchanged by the round trip' "$before_guids" "$(guids_of_pool)"

# Does ZFS still record by-id paths after being imported that way, or did it rewrite the config to
# whatever it resolved through? -P prints the full path it will use next time.
status_p=$(zpool status -P "$DEPSIS_TEST_POOL")
note "zpool status -P after import: ${status_p//$'\n'/ | }"
assert_contains 'the imported pool config still records /dev/disk/by-id paths' "$BYID/" "$status_p"

check_manifest 'data survived the export/import round trip' "$SRC_MANIFEST" "$DATA_PATH"

# ═══════════════════════════════════════════════════════════════════════════════
section '7. Degraded mirror — risk R1 territory, nothing is physically detached'
# ═══════════════════════════════════════════════════════════════════════════════

# `zpool offline` is a software state change on one side of a two-way mirror. The other side is
# never touched, so the pool always keeps a complete copy.
#
# After the import round trip ZFS may record the member as the -part1 path, so ask the pool what
# it calls the device instead of assuming the create-time string still matches.
MEMBER0=$(zpool status -P "$DEPSIS_TEST_POOL" | awk -v b="$B0" 'index($1, b) {print $1; exit}' || true)
if [ -z "$MEMBER0" ]; then MEMBER0="$VDEV0"; fi
note "offlining pool member as ZFS names it: $MEMBER0"

zpool offline "$DEPSIS_TEST_POOL" "$MEMBER0"
assert_eq 'pool reports DEGRADED with one side offline' DEGRADED \
          "$(zpool list -H -o health "$DEPSIS_TEST_POOL")"

deg=$(zpool status "$DEPSIS_TEST_POOL")
note "degraded status: ${deg//$'\n'/ | }"
assert_contains 'the offlined member is marked OFFLINE' 'OFFLINE' "$deg"
# The operator has to be told WHICH physical disk to replace. If the degraded view falls back to
# sdX, the DEPSIS UI cannot name the failed disk and §8.1's "affected disks serial/WWN list"
# requirement is unmeetable at exactly the moment it matters.
assert_contains 'the offlined member is still named by its by-id name while degraded' "$B0" "$deg"

# A NAS that stops serving when one mirror side drops is not a NAS. Both directions must work.
check_manifest 'existing data is still readable while DEGRADED' "$SRC_MANIFEST" "$DATA_PATH"
printf 'written while degraded\n' >"$DATA_PATH/tree/degraded.txt"
sync
assert_eq 'a write issued while DEGRADED reads back correctly' 'written while degraded' \
          "$(cat "$DATA_PATH/tree/degraded.txt")"
SRC_MANIFEST=$(manifest "$DATA_PATH")

zpool online "$DEPSIS_TEST_POOL" "$MEMBER0"
t0=$SECONDS
deadline=$((SECONDS + 300))
while :; do
  h=$(zpool list -H -o health "$DEPSIS_TEST_POOL")
  st=$(zpool status "$DEPSIS_TEST_POOL")
  if [ "$h" = ONLINE ] && ! grep -q 'in progress' <<<"$st"; then break; fi
  if [ "$SECONDS" -ge "$deadline" ]; then break; fi
  sleep 2
done
resilver_elapsed=$((SECONDS - t0))
scan_line=$(zpool status "$DEPSIS_TEST_POOL" | sed -n 's/^[[:space:]]*scan: //p' | head -1)

assert_eq 'pool returns to ONLINE after the member is brought back' ONLINE \
          "$(zpool list -H -o health "$DEPSIS_TEST_POOL")"
note "resilver settled in ${resilver_elapsed}s: $scan_line" \
     'wall clock on a near-empty pool; not a capacity-planning number'

# Whether an online actually triggers a resilver depends on how much changed while the member was
# out. Record it rather than assert it — asserting would make the test depend on how fast the
# previous section happened to run.
if grep -qi 'resilver' <<<"$scan_line"; then
  pass 'bringing the member back triggered a resilver' "$scan_line"
else
  note "no resilver recorded; scan line still reads: $scan_line" \
       'ZFS considered the member up to date — recorded, not assumed'
fi
assert_contains 'the post-online scan reports zero errors' 'with 0 errors' "$scan_line"
assert_contains 'zpool status -x calls the pool healthy again' 'is healthy' \
                "$(zpool status -x "$DEPSIS_TEST_POOL")"
check_manifest 'data is intact after the offline/online cycle' "$SRC_MANIFEST" "$DATA_PATH"

poc_summary
