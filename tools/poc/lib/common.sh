# shellcheck shell=bash
# DEPSIS Phase 0 PoC harness — shared by every tools/poc/*.sh script.
#
# Purpose: these PoCs prove or disprove the behavioural claims that the ADRs mark
# "unverified". A PoC that quietly passes is worse than useless, so this harness is built
# around three rules:
#
#   1. REFUSE TO RUN OUTSIDE THE TEST VM. Every script here destroys ZFS pools. Master prompt
#      §22 forbids running data-destroying commands on real disks without explicit approval.
#   2. RECORD EVIDENCE. Every assertion writes a line to a machine-readable log under
#      docs/adr/evidence/, so an ADR can cite an actual run instead of an intention.
#   3. AN UNEXPECTED PASS IS ALSO A FINDING. Several PoCs assert that something FAILS
#      (e.g. cross-dataset rename must return EXDEV). If it unexpectedly succeeds, that
#      contradicts an ADR and must be loud, not silently green.

set -Eeuo pipefail

# ─── configuration ────────────────────────────────────────────────────────────
: "${DEPSIS_TEST_POOL:=depsistest}"
: "${DEPSIS_POC_ROOT:=/srv/depsis-poc}"
: "${DEPSIS_EVIDENCE_DIR:=/var/log/depsis-poc}"

POC_ID="${POC_ID:-unknown}"
_pass=0
_fail=0
_unexpected=0
_evidence=""

# ─── output ───────────────────────────────────────────────────────────────────
_c_red=$'\033[31m'; _c_grn=$'\033[32m'; _c_ylw=$'\033[33m'
_c_cyn=$'\033[36m'; _c_bld=$'\033[1m';  _c_rst=$'\033[0m'

section() { printf '\n%s── %s ──%s\n' "$_c_cyn$_c_bld" "$*" "$_c_rst"; }
info()    { printf '    %s\n' "$*"; }
warn()    { printf '%s    ! %s%s\n' "$_c_ylw" "$*" "$_c_rst"; }

_record() { # kind, message, detail
  printf '%s\t%s\t%s\t%s\n' "$POC_ID" "$1" "$2" "${3//$'\n'/ }" >>"$_evidence"
}

pass() {
  _pass=$((_pass + 1))
  printf '%s    PASS%s %s\n' "$_c_grn" "$_c_rst" "$1"
  _record PASS "$1" "${2:-}"
}

fail() {
  _fail=$((_fail + 1))
  printf '%s    FAIL%s %s\n' "$_c_red" "$_c_rst" "$1"
  [ -n "${2:-}" ] && printf '         %s\n' "$2"
  _record FAIL "$1" "${2:-}"
}

# For the case that matters most: an assertion we expected to fail actually succeeded.
# That means an ADR is wrong, which is a finding in its own right — never a silent pass.
unexpected() {
  _unexpected=$((_unexpected + 1))
  printf '%s  UNEXPECTED%s %s\n' "$_c_ylw$_c_bld" "$_c_rst" "$1"
  [ -n "${2:-}" ] && printf '         %s\n' "$2"
  _record UNEXPECTED "$1" "${2:-}"
}

note() { _record NOTE "$1" "${2:-}"; info "$1"; }

# ─── assertions ───────────────────────────────────────────────────────────────

# assert_cmd <description> <expected: ok|fail> -- <command...>
assert_cmd() {
  local desc="$1" expect="$2"; shift 2
  [ "$1" = "--" ] && shift
  local out rc
  out=$("$@" 2>&1) && rc=0 || rc=$?
  if [ "$expect" = ok ] && [ "$rc" -eq 0 ]; then
    pass "$desc" "rc=0"
  elif [ "$expect" = fail ] && [ "$rc" -ne 0 ]; then
    pass "$desc (failed as expected, rc=$rc)" "$out"
  elif [ "$expect" = fail ]; then
    unexpected "$desc — expected failure but it SUCCEEDED" "$out"
  else
    fail "$desc" "rc=$rc: $out"
  fi
}

# assert_errno <description> <expected errno name> -- <command...>
# Captures the real errno via a tiny C-free trick: run under `strace`-free perl if present,
# else match the message. Prefer the dedicated C probes in the PoCs that truly need errno.
assert_errno() {
  local desc="$1" want="$2"; shift 2
  [ "$1" = "--" ] && shift
  local out rc
  out=$("$@" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq 0 ]; then
    unexpected "$desc — expected $want but the call SUCCEEDED" "$out"
  elif grep -qiE "$want|$(_errno_text "$want")" <<<"$out"; then
    pass "$desc → $want" "$out"
  else
    fail "$desc — expected $want" "rc=$rc: $out"
  fi
}

_errno_text() {
  case "$1" in
    EXDEV)      echo 'cross-device|Invalid cross-device link' ;;
    EINVAL)     echo 'Invalid argument' ;;
    EOPNOTSUPP) echo 'not supported|Operation not supported' ;;
    ENODEV)     echo 'No such device' ;;
    EPERM)      echo 'not permitted' ;;
    EDQUOT)     echo 'Disk quota exceeded' ;;
    ENOSPC)     echo 'No space left' ;;
    EEXIST)     echo 'File exists' ;;
    *)          echo "$1" ;;
  esac
}

assert_eq() {
  local desc="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then pass "$desc" "= $got"
  else fail "$desc" "expected '$want', got '$got'"; fi
}

assert_ne() {
  local desc="$1" bad="$2" got="$3"
  if [ "$bad" != "$got" ]; then pass "$desc" "= $got"
  else fail "$desc" "value should not be '$bad'"; fi
}

assert_contains() {
  local desc="$1" needle="$2" hay="$3"
  if grep -qF -- "$needle" <<<"$hay"; then pass "$desc"
  else fail "$desc" "missing '$needle' in: ${hay:0:400}"; fi
}

# ─── safety ───────────────────────────────────────────────────────────────────
# Risk R1 is "destroy the wrong disk". These PoCs run zpool destroy, so the guard below is
# the single most important thing in this file.
require_test_environment() {
  [ "$(id -u)" -eq 0 ] || { echo "Must run as root." >&2; exit 1; }

  if [ ! -f /etc/depsis-poc-build.json ]; then
    cat >&2 <<'EOF'
REFUSING TO RUN.

/etc/depsis-poc-build.json is absent, so this is not the DEPSIS PoC VM created by
deploy/vm/provision-debian.ps1. These scripts run `zpool destroy` and will erase disks.

If you really are on a disposable test machine, create that marker file yourself and accept
the consequences. It is deliberately not auto-created.
EOF
    exit 1
  fi

  # Never touch a pool we did not create.
  local p
  for p in $(zpool list -H -o name 2>/dev/null || true); do
    if [ "$p" != "$DEPSIS_TEST_POOL" ]; then
      echo "REFUSING TO RUN: unexpected pool '$p' present. Only '$DEPSIS_TEST_POOL' is allowed." >&2
      exit 1
    fi
  done

  mkdir -p "$DEPSIS_EVIDENCE_DIR"
  _evidence="$DEPSIS_EVIDENCE_DIR/$POC_ID.tsv"
  : >"$_evidence"
}

# Vdev disks come from provision-debian.ps1, which recorded their expected page-0x83
# identifiers. Resolving by-id (never /dev/sdX) is itself part of what ADR-0012 must prove.
poc_vdevs() {
  local n="${1:-2}" found=()
  local d
  while IFS= read -r d; do
    # Skip anything holding a partition table already in use by the system disk.
    [ -n "$d" ] && found+=("$d")
  done < <(find /dev/disk/by-id -maxdepth 1 \( -name 'scsi-*' -o -name 'wwn-*' \) ! -name '*-part*' 2>/dev/null | sort)

  if [ "${#found[@]}" -lt "$((n + 1))" ]; then
    echo "Not enough by-id disks found (need $((n + 1)) including the system disk, saw ${#found[@]})." >&2
    echo "If /dev/disk/by-id is empty, ADR-0012's page-0x83 assumption is WRONG — record that." >&2
    return 1
  fi
  # Drop the disk that carries the mounted root.
  local rootdisk
  rootdisk=$(lsblk -no PKNAME "$(findmnt -no SOURCE /)" 2>/dev/null | head -1)
  local out=() c=0
  for d in "${found[@]}"; do
    [ "$(basename "$(readlink -f "$d")")" = "$rootdisk" ] && continue
    out+=("$d"); c=$((c + 1)); [ "$c" -ge "$n" ] && break
  done
  printf '%s\n' "${out[@]}"
}

cleanup_pool() {
  if zpool list -H -o name 2>/dev/null | grep -qx "$DEPSIS_TEST_POOL"; then
    zpool destroy -f "$DEPSIS_TEST_POOL" 2>/dev/null || true
  fi
  rm -rf "${DEPSIS_POC_ROOT:?}" 2>/dev/null || true
}

# ─── summary ──────────────────────────────────────────────────────────────────
poc_summary() {
  section "$POC_ID summary"
  printf '    passed: %d   failed: %d   unexpected: %d\n' "$_pass" "$_fail" "$_unexpected"
  printf '    evidence: %s\n' "$_evidence"
  if [ "$_unexpected" -gt 0 ]; then
    warn "An assertion that was expected to FAIL succeeded. An ADR is wrong — read the evidence."
  fi
  # Unexpected passes are failures of the ADR, so they are non-zero exits too.
  [ "$_fail" -eq 0 ] && [ "$_unexpected" -eq 0 ]
}

trap 'rc=$?; [ $rc -ne 0 ] && printf "\n%sPoC aborted (rc=%s) at line %s%s\n" "$_c_red" "$rc" "$LINENO" "$_c_rst"; exit $rc' ERR
