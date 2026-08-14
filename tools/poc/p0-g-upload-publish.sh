#!/usr/bin/env bash
# P0-G — prove ADR-0008: atomic publish, rename semantics and the quota model.
#
# ADR-0008 threw away the separate staging dataset because of one syscall detail: rename(2)
# refuses to cross a mount point, and every ZFS dataset is its own mount. If that reading is
# wrong, the ADR's whole storage layout change was unnecessary. If it is right, then any code
# that calls fs.rename() across datasets throws at publish time — after the upload succeeded,
# after the scan passed, at the worst possible moment.
#
# So this script does not test "does publishing work". It tests the four claims the ADR bet on:
#
#   1. cross-dataset rename(2) is EXDEV, and the kernel decides on MOUNT identity, not device
#      identity (the parenthetical in rename(2) that the ADR quotes)
#   2. intra-dataset rename is O(1) — measured against the cost of a real copy on this machine,
#      not against a number someone guessed
#   3. there is no zero-copy escape hatch across datasets, reflink included
#   4. RENAME_NOREPLACE is not available, so the linkat+unlink fallback is load-bearing
#
# Two things this script deliberately does NOT do:
#   - it does not use `mv` to test rename. coreutils falls back to copy+unlink in userspace on
#     EXDEV, which would hide the exact failure we are hunting. Every rename here is the raw
#     syscall via python3's os.rename/os.link.
#   - it does not claim to test power-loss durability. See section 6.
#
# Samba's `veto files = /.depsis/` is P0-B's job and is not repeated here.

POC_ID=p0-g
# shellcheck source=lib/common.sh
. "$(dirname "$(readlink -f "$0")")/lib/common.sh"

require_test_environment

# The layout under test is ADR-0008's: per-user datasets, staging INSIDE each one.
USER_A="$DEPSIS_TEST_POOL/users/1001"
USER_B="$DEPSIS_TEST_POOL/users/1002"
USER_Q="$DEPSIS_TEST_POOL/users/1003"
MNT_A="$DEPSIS_POC_ROOT/users/1001"
MNT_B="$DEPSIS_POC_ROOT/users/1002"
MNT_Q="$DEPSIS_POC_ROOT/users/1003"

# Kept outside DEPSIS_POC_ROOT so cleanup_pool's rm -rf can never walk into a live bind mount.
BIND_MNT=/mnt/depsis-p0g-bind
SHM_CTRL=/dev/shm/depsis-p0g-ctrl

# 1 GiB is enough: a full copy of it is seconds of real I/O on any plausible disk, while a
# metadata-only rename is single-digit milliseconds. The gap is not subtle.
: "${DEPSIS_POC_BIG_MIB:=1024}"
BIG_MIB="$DEPSIS_POC_BIG_MIB"
BIG_BYTES=$(( BIG_MIB * 1024 * 1024 ))

# refquota / quota ratio comes straight from ADR-0008's table (quota = refquota x ~1.3-1.5).
REFQUOTA_MIB=64
QUOTA_MIB=96
REFQUOTA_B=$(( REFQUOTA_MIB * 1024 * 1024 ))
FILL_CAP_B=$(( 4 * REFQUOTA_B ))   # runaway guard: if we ever write this much, quota is not enforced

cleanup() {
  section 'Cleanup'
  umount "$BIND_MNT" 2>/dev/null || true
  rmdir  "$BIND_MNT" 2>/dev/null || true
  rm -rf "$SHM_CTRL" 2>/dev/null || true
  cleanup_pool
}
trap cleanup EXIT

# ─── local helpers ────────────────────────────────────────────────────────────

now_ns()     { date +%s%N; }
elapsed_ms() { echo $(( ( $(date +%s%N) - $1 ) / 1000000 )); }
zprop()      { zfs get -Hp -o value "$1" "$2"; }

# ZFS space accounting settles on a txg boundary. Every used/referenced read in this script is
# preceded by this, otherwise the numbers lag reality by up to five seconds and the space
# assertions become coin flips.
zsync() { zpool sync "$DEPSIS_TEST_POOL" 2>/dev/null || sync; }

# Run a probe helper without letting an unhandled exception trip the harness ERR trap and abort
# the whole run. A crashed probe must be reported as a failed assertion, not as a dead script.
probe() {
  local out rc=0
  out=$("$@" 2>&1) || rc=$?
  if [ "$rc" -ne 0 ]; then
    printf 'PROBEFAIL(rc=%s) %s\n' "$rc" "${out//$'\n'/ }"
  else
    printf '%s\n' "$out"
  fi
}

expect_ok() { # <desc> <probe output>
  case "$2" in
    OK*) pass "$1" "$2" ;;
    *)   fail "$1" "$2" ;;
  esac
}

expect_errno() { # <desc> <wanted errno name> <probe output>
  case "$3" in
    OK*)             unexpected "$1 — expected $2 but the syscall SUCCEEDED" "$3" ;;
    "ERRNO:$2"|"ERRNO:$2 "*) pass "$1 → $2" "$3" ;;
    *)               fail "$1 — expected $2" "$3" ;;
  esac
}

# ─── raw syscall probes (python3 = the shortest path to an unwrapped syscall) ──

py_rename() { # old new  → "OK" | "ERRNO:NAME"
python3 - "$1" "$2" <<'PY'
import errno, os, sys
try:
    os.rename(sys.argv[1], sys.argv[2])
    print("OK")
except OSError as e:
    print("ERRNO:%s" % errno.errorcode.get(e.errno, e.errno))
PY
}

py_link() { # old new  → "OK" | "ERRNO:NAME"
python3 - "$1" "$2" <<'PY'
import errno, os, sys
try:
    os.link(sys.argv[1], sys.argv[2], follow_symlinks=False)
    print("OK")
except OSError as e:
    print("ERRNO:%s" % errno.errorcode.get(e.errno, e.errno))
PY
}

py_fsync_dir() { # dir  → "OK" | "ERRNO:NAME"
python3 - "$1" <<'PY'
import errno, os, sys
fd = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(fd)
    print("OK")
except OSError as e:
    print("ERRNO:%s" % errno.errorcode.get(e.errno, e.errno))
finally:
    os.close(fd)
PY
}

# The exact five-step ordering from ADR-0008, expressed as the syscalls the system agent will
# make — including renameat() with two directory fds, which is what the ADR's C snippet shows.
py_publish() { # staging_dir part_name dest_dir final_name payload → "OK" | "ERRNO:NAME"
python3 - "$1" "$2" "$3" "$4" "$5" <<'PY'
import errno, os, sys
sdir, part, ddir, final, payload = sys.argv[1:6]
sfd = os.open(sdir, os.O_RDONLY | os.O_DIRECTORY)
dfd = os.open(ddir, os.O_RDONLY | os.O_DIRECTORY)
try:
    fd = os.open(part, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600, dir_fd=sfd)  # 1. write
    try:
        os.write(fd, payload.encode())
        os.fsync(fd)                                                              # 2. fsync file
    finally:
        os.close(fd)
    # 3. scan/policy would run here, with the file still inside .depsis/
    os.rename(part, final, src_dir_fd=sfd, dst_dir_fd=dfd)                        # 4. renameat
    os.fsync(dfd)                                                                 # 5. fsync DIR
    print("OK")
except OSError as e:
    print("ERRNO:%s" % errno.errorcode.get(e.errno, e.errno))
finally:
    os.close(sfd); os.close(dfd)
PY
}

# renameat2 is not exposed by python's os module. glibc >= 2.28 exports the wrapper; if it is
# missing we fall back to the raw syscall number. Both paths are reported so an EINVAL can be
# attributed to ZFS rather than to a broken probe.
py_renameat2_noreplace() { # old new → "OK <how>" | "ERRNO:NAME <how>" | "SKIP <why>"
python3 - "$1" "$2" <<'PY'
import ctypes, errno, os, platform, sys

RENAME_NOREPLACE = 1
AT_FDCWD = -100
old = sys.argv[1].encode()
new = sys.argv[2].encode()
libc = ctypes.CDLL(None, use_errno=True)

fn = None
try:
    fn = libc.renameat2
    fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int,
                   ctypes.c_char_p, ctypes.c_uint]
    how = "glibc renameat2()"
except AttributeError:
    nr = {"x86_64": 316, "aarch64": 276, "i686": 353, "ppc64le": 357}.get(platform.machine())
    if nr is None:
        print("SKIP no-glibc-wrapper-and-unknown-arch:%s" % platform.machine())
        raise SystemExit(0)
    libc.syscall.argtypes = [ctypes.c_long, ctypes.c_int, ctypes.c_char_p, ctypes.c_int,
                             ctypes.c_char_p, ctypes.c_uint]
    how = "syscall(%d)" % nr
    fn = lambda a, b, c, d, e, _nr=nr: libc.syscall(_nr, a, b, c, d, e)

ctypes.set_errno(0)
rc = fn(AT_FDCWD, old, AT_FDCWD, new, RENAME_NOREPLACE)
if rc == 0:
    print("OK %s" % how)
else:
    e = ctypes.get_errno()
    print("ERRNO:%s %s" % (errno.errorcode.get(e, e), how))
PY
}

# Write 1 MiB at a time, fsync each chunk so the quota verdict is deterministic rather than
# arriving whenever the txg happens to close. Stops at a hard cap so an UNENFORCED quota shows
# up as a bounded "NOQUOTA" result instead of filling the pool.
py_fill() { # path cap_bytes → "ERRNO:NAME <bytes>" | "NOQUOTA <bytes>"
python3 - "$1" "$2" <<'PY'
import errno, os, sys
path, cap = sys.argv[1], int(sys.argv[2])
chunk = 1024 * 1024
buf = os.urandom(chunk)
total = 0
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
try:
    while total < cap:
        total += os.write(fd, buf)
        os.fsync(fd)
    print("NOQUOTA %d" % total)
except OSError as e:
    print("ERRNO:%s %d" % (errno.errorcode.get(e.errno, e.errno), total))
finally:
    try:
        os.close(fd)
    except OSError:
        pass
PY
}

# ═══════════════════════════════════════════════════════════════════════════════
section '0. Environment'
# ═══════════════════════════════════════════════════════════════════════════════

note "zfs version: $(zfs version 2>&1 | head -1)"
note "kernel: $(uname -r)"
note "coreutils cp: $(cp --version 2>&1 | head -1)"
note "glibc: $(ldd --version 2>&1 | head -1)"

HAVE_PY=1
if command -v python3 >/dev/null 2>&1; then
  note "python3: $(python3 --version 2>&1)"
else
  HAVE_PY=0
  warn 'python3 is NOT installed'
  # Everything that distinguishes rename(2) from mv needs a raw syscall. Without it P0-G cannot
  # answer its own headline question, and reporting that as a skip would be dishonest.
  fail 'P0-G headline is UNTESTED: python3 absent, no way to issue a raw rename(2)' \
       'install python3 on the PoC VM and re-run; do not mark ADR-0008 verified without it'
fi

mapfile -t VDEVS < <(poc_vdevs 2)
[ "${#VDEVS[@]}" -ge 2 ] || { fail 'need 2 vdev disks'; poc_summary; exit 1; }
note "vdevs: ${VDEVS[*]}"

cleanup_pool
zpool create -f -m "$DEPSIS_POC_ROOT" "$DEPSIS_TEST_POOL" mirror "${VDEVS[0]}" "${VDEVS[1]}"
pass 'created mirror test pool'

# compression=off everywhere: this script uses `zfs get used` as evidence that a copy really
# copied. With compression on, that evidence is worthless.
zfs create -p -o compression=off "$USER_A"
zfs create -p -o compression=off "$USER_B"
mkdir -p "$MNT_A/.depsis/staging" "$MNT_A/Documents"
mkdir -p "$MNT_B/.depsis/staging" "$MNT_B/Documents"

# Same pool, same vdevs, adjacent datasets — the most favourable case the ADR could face.
assert_eq 'both datasets live in the same pool' \
  "$DEPSIS_TEST_POOL" "$(zfs get -H -o value name "$USER_A" 2>/dev/null | cut -d/ -f1)"

note "block_cloning pool feature: $(zpool get -H -o value feature@block_cloning "$DEPSIS_TEST_POOL" 2>&1)"

# Relevant to tus: a resumable upload server may want to preallocate the .part file up front.
# ADR-0008 makes no claim here, so this is recorded, not asserted.
if fallocate -l 1M "$MNT_A/.depsis/staging/falloc.probe" 2>/dev/null; then
  note 'fallocate(2) preallocation works on this ZFS build' \
       "$(stat -c 'apparent=%s allocated=%b*%B' "$MNT_A/.depsis/staging/falloc.probe")"
else
  note 'fallocate(2) preallocation is NOT supported here — tus staging cannot preallocate'
fi
rm -f "$MNT_A/.depsis/staging/falloc.probe"

# ═══════════════════════════════════════════════════════════════════════════════
section '1. THE HEADLINE — cross-dataset rename(2) must return EXDEV'
# ═══════════════════════════════════════════════════════════════════════════════
# If this returns anything other than EXDEV, ADR-0008's storage layout change was unnecessary
# and the ADR must be rewritten. If it returns EXDEV, then every naive fs.rename() in the upload
# path is a guaranteed production failure and the .depsis-inside-the-dataset layout is forced.

dev_a=$(stat -c %d "$MNT_A")
dev_b=$(stat -c %d "$MNT_B")
note "st_dev of $MNT_A = $dev_a ; st_dev of $MNT_B = $dev_b"
assert_ne 'the two datasets report different st_dev (each dataset is its own superblock)' \
  "$dev_a" "$dev_b"

if [ "$HAVE_PY" -eq 1 ]; then
  echo 'p0g-payload' >"$MNT_A/.depsis/staging/xdev.part"

  got=$(probe py_rename "$MNT_A/.depsis/staging/xdev.part" "$MNT_B/Documents/xdev.final")
  expect_errno 'raw rename(2) from one dataset into another in the SAME pool' EXDEV "$got"

  # The ADR leans on the parenthetical in rename(2): the kernel compares MOUNT points, not
  # devices. A bind mount is the clean way to separate those two ideas — same superblock, same
  # st_dev, different vfsmount. If this also returns EXDEV, the ADR's reading is exactly right,
  # and it also means DEPSIS can never publish across a bind mount either (container layouts,
  # per-share re-mounts) no matter how identical the underlying filesystem is.
  mkdir -p "$BIND_MNT"
  if mount --bind "$MNT_A" "$BIND_MNT" 2>/dev/null; then
    dev_bind=$(stat -c %d "$BIND_MNT")
    assert_eq 'bind mount of the SAME dataset reports the SAME st_dev' "$dev_a" "$dev_bind"
    got=$(probe py_rename "$MNT_A/.depsis/staging/xdev.part" "$BIND_MNT/Documents/bind.final")
    expect_errno 'rename(2) across a bind mount of the same dataset (same st_dev!)' EXDEV "$got"
    note 'confirmed: the kernel test is mount identity, not device identity'
    umount "$BIND_MNT"
  else
    warn 'could not create the bind mount; the mount-vs-device distinction is unproven'
    note 'bind-mount corollary SKIPPED'
  fi
  rmdir "$BIND_MNT" 2>/dev/null || true

  # And now the trap that makes this bug so easy to miss in manual testing: `mv` succeeds.
  # It succeeds because coreutils catches EXDEV and does copy+unlink in userspace. Anyone who
  # "verified" cross-dataset publish with mv verified nothing.
  ino_before=$(stat -c %i "$MNT_A/.depsis/staging/xdev.part")
  assert_cmd 'mv across datasets SUCCEEDS (userspace fallback) where rename(2) failed' ok \
    -- mv "$MNT_A/.depsis/staging/xdev.part" "$MNT_B/Documents/mv.final"
  ino_after=$(stat -c %i "$MNT_B/Documents/mv.final")
  # A real rename preserves the inode. A copy cannot.
  assert_ne 'mv produced a NEW inode — it copied, it did not rename' "$ino_before" "$ino_after"
  note "inode before mv=$ino_before, after mv=$ino_after" \
       'this is why the PoC uses raw rename(2) and never mv'
  rm -f "$MNT_B/Documents/mv.final"
fi

# ═══════════════════════════════════════════════════════════════════════════════
section '2. Intra-dataset rename must be O(1) — measured, not assumed'
# ═══════════════════════════════════════════════════════════════════════════════
# ADR-0008's whole payoff is "O(1), atomik, çökmeye tutarlı. 10 GB kopya yok." That is a
# performance claim, so it gets measured against the cost of a real copy on this same machine
# rather than against a threshold pulled out of the air.

BIG="$MNT_A/.depsis/staging/big.part"
used_a0=$(zprop used "$USER_A")

t0=$(now_ns)
dd if=/dev/urandom of="$BIG" bs=1M count="$BIG_MIB" conv=fsync status=none
create_ms=$(elapsed_ms "$t0")
# Incompressible input on purpose, so `used` is a truthful byte count below. The rate includes
# RNG cost, so it is NOT a disk benchmark — the honest copy baseline is measured further down.
note "created ${BIG_MIB} MiB staging file in ${create_ms} ms (includes /dev/urandom cost)"

zsync
used_a1=$(zprop used "$USER_A")
grew=$(( used_a1 - used_a0 ))
note "dataset used grew by $grew bytes for a $BIG_BYTES byte file"
# If ZFS elided the data (compression, zero-detection), every space-based assertion later in
# this script is meaningless and must not be believed.
if [ "$grew" -ge $(( BIG_BYTES * 8 / 10 )) ]; then
  pass 'the staging file really consumed pool space (space accounting is trustworthy)'
  SPACE_EVIDENCE_OK=1
else
  SPACE_EVIDENCE_OK=0
  fail 'the file did not consume the expected space — space-based evidence is unusable' \
       "expected >= $(( BIG_BYTES * 8 / 10 )), saw $grew"
fi

RENAME_MEASURED=0
if [ "$HAVE_PY" -eq 1 ]; then
  RENAMED="$MNT_A/Documents/big.published"
  size_before=$(stat -c %s "$BIG")
  ino_before=$(stat -c %i "$BIG")

  t0=$(now_ns)
  got=$(probe py_rename "$BIG" "$RENAMED")
  rename_ms=$(elapsed_ms "$t0")
  expect_ok 'intra-dataset rename(2) from .depsis/staging into the visible tree' "$got"

  if [ -f "$RENAMED" ]; then
    RENAME_MEASURED=1
    note "intra-dataset rename of ${BIG_MIB} MiB took ${rename_ms} ms"
    assert_eq 'rename preserved the inode (nothing was copied)' \
      "$ino_before" "$(stat -c %i "$RENAMED")"
    assert_eq 'rename preserved the size' "$size_before" "$(stat -c %s "$RENAMED")"

    zsync
    used_a2=$(zprop used "$USER_A")
    d=$(( used_a2 - used_a1 )); [ "$d" -lt 0 ] && d=$(( -d )) || true
    # A copy would have added BIG_BYTES. 64 MiB is far below that and far above metadata churn.
    if [ "$d" -lt $(( 64 * 1024 * 1024 )) ]; then
      pass 'rename consumed no measurable space' "delta=$d bytes"
    else
      fail 'rename changed dataset usage — something copied' "delta=$d bytes"
    fi
  fi

  # The baseline: what a copy of this exact file actually costs here. --reflink=never is
  # mandatory — coreutils 9.x defaults to reflink=auto, and on ZFS >= 2.2 block cloning would
  # turn the "copy" into a metadata operation and destroy the comparison.
  t0=$(now_ns)
  cp --reflink=never "$RENAMED" "$MNT_A/Documents/big.copy"
  sync
  copy_ms=$(elapsed_ms "$t0")
  note "full intra-dataset copy of ${BIG_MIB} MiB took ${copy_ms} ms" \
       "this is the cost ADR-0008 is claiming to eliminate"
  rm -f "$MNT_A/Documents/big.copy"

  if [ "$RENAME_MEASURED" -eq 1 ]; then
    # Bound derivation: a copy-based publish must at minimum read and write the whole file, so
    # it cannot be faster than copy_ms. Demanding rename <= copy_ms/20 leaves a 20x margin for
    # a noisy VM while still being impossible for anything that touches the data. The 50 ms
    # floor keeps the test from becoming absurd on a very fast host; the 1000 ms ceiling keeps
    # it from becoming meaningless on a very slow one.
    bound_ms=$(( copy_ms / 20 ))
    if [ "$bound_ms" -lt 50 ];   then bound_ms=50;   fi
    if [ "$bound_ms" -gt 1000 ]; then bound_ms=1000; fi
    if [ "$rename_ms" -le "$bound_ms" ]; then
      pass "rename is O(1): ${rename_ms} ms vs a ${copy_ms} ms copy (bound ${bound_ms} ms)"
    else
      fail "rename was not O(1)" "rename=${rename_ms} ms, copy=${copy_ms} ms, bound=${bound_ms} ms"
    fi
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
section '3. reflink — is there any zero-copy escape hatch across datasets?'
# ═══════════════════════════════════════════════════════════════════════════════
# ADR-0008 claims there is none: not rename, not reflink. If a cross-dataset reflink worked,
# the separate staging dataset could have been kept and the layout change reversed.

SRC_BIG="$MNT_A/Documents/big.published"
if [ ! -f "$SRC_BIG" ]; then SRC_BIG="$BIG"; fi

if [ -f "$SRC_BIG" ]; then
  assert_errno 'cp --reflink=always ACROSS datasets must fail' EXDEV \
    -- cp --reflink=always "$SRC_BIG" "$MNT_B/Documents/clone.bin"
  rm -f "$MNT_B/Documents/clone.bin"

  # Intra-dataset reflink is not something ADR-0008 rules on, but the answer matters for
  # server-side copy inside one user's dataset, so record it without asserting.
  cl_out=$(cp --reflink=always "$SRC_BIG" "$MNT_A/Documents/clone.bin" 2>&1) && cl_rc=0 || cl_rc=$?
  if [ "$cl_rc" -eq 0 ]; then
    note 'intra-dataset cp --reflink=always SUCCEEDS (block cloning is usable within a dataset)'
  else
    note "intra-dataset cp --reflink=always failed (rc=$cl_rc): ${cl_out//$'\n'/ }"
  fi
  rm -f "$MNT_A/Documents/clone.bin"
  zsync

  # --reflink=auto is the dangerous one: it does not error, it silently becomes a full copy.
  # Anyone who writes `cp --reflink=auto` expecting zero-copy publish gets 2x write
  # amplification and a non-atomic, observable half-file, with no diagnostic anywhere.
  used_b0=$(zprop used "$USER_B")
  t0=$(now_ns)
  cp --reflink=auto "$SRC_BIG" "$MNT_B/Documents/auto.bin"
  sync
  auto_ms=$(elapsed_ms "$t0")
  zsync
  used_b1=$(zprop used "$USER_B")
  auto_grew=$(( used_b1 - used_b0 ))
  note "cross-dataset cp --reflink=auto: rc=0, ${auto_ms} ms, destination used grew ${auto_grew} bytes"

  if [ "$SPACE_EVIDENCE_OK" -eq 1 ]; then
    if [ "$auto_grew" -ge $(( BIG_BYTES * 8 / 10 )) ]; then
      pass '--reflink=auto silently performed a FULL copy across datasets' \
           "it wrote ~$auto_grew bytes and reported success"
    else
      unexpected '--reflink=auto did NOT copy across datasets — a zero-copy path exists' \
           "destination used grew only $auto_grew bytes; ADR-0008 section 2 is wrong"
    fi
  fi
  rm -f "$MNT_B/Documents/auto.bin"
fi

# Free the large files before the quota section so pool pressure cannot confuse EDQUOT with ENOSPC.
rm -f "$MNT_A/Documents/big.published" "$BIG"
zsync

# ═══════════════════════════════════════════════════════════════════════════════
section '4. renameat2(RENAME_NOREPLACE) on ZFS'
# ═══════════════════════════════════════════════════════════════════════════════
# ADR-0008 predicts EINVAL: OpenZFS PR #12209 stalled and rename(2) does not fall back when the
# filesystem rejects a flag. DEPSIS therefore must probe at startup and cache the answer instead
# of assuming. This section produces the number that probe would produce.

if [ "$HAVE_PY" -eq 1 ]; then
  # Control first. tmpfs implements RENAME_NOREPLACE, so if the control does not behave, the
  # probe itself is broken and any EINVAL from ZFS below would be meaningless.
  mkdir -p "$SHM_CTRL"
  echo ctrl >"$SHM_CTRL/a"
  ctrl=$(probe py_renameat2_noreplace "$SHM_CTRL/a" "$SHM_CTRL/b")
  case "$ctrl" in
    SKIP*)
      warn "renameat2 probe unavailable: $ctrl"
      note 'renameat2 SECTION SKIPPED — ADR-0008 section 4 remains unverified'
      CTRL_OK=0
      ;;
    OK*)
      pass 'control: RENAME_NOREPLACE works on tmpfs — the probe itself is sound' "$ctrl"
      CTRL_OK=1
      ;;
    *)
      fail 'control: RENAME_NOREPLACE failed even on tmpfs — probe is broken' "$ctrl"
      CTRL_OK=0
      ;;
  esac

  if [ "${CTRL_OK:-0}" -eq 1 ]; then
    echo ctrl2 >"$SHM_CTRL/c"; echo ctrl3 >"$SHM_CTRL/d"
    ctrl2=$(probe py_renameat2_noreplace "$SHM_CTRL/c" "$SHM_CTRL/d")
    expect_errno 'control: RENAME_NOREPLACE onto an existing name on tmpfs' EEXIST "$ctrl2"

    # Now the real question, on ZFS.
    echo zfs1 >"$MNT_A/.depsis/staging/nr.part"
    zres=$(probe py_renameat2_noreplace "$MNT_A/.depsis/staging/nr.part" "$MNT_A/Documents/nr.final")
    note "ZFS renameat2(RENAME_NOREPLACE), destination absent: $zres"
    case "$zres" in
      ERRNO:EINVAL*)
        pass 'ZFS rejects RENAME_NOREPLACE with EINVAL, as ADR-0008 predicts' "$zres"
        note 'the linkat+unlink fallback is therefore load-bearing, not a nicety'
        ;;
      OK*)
        # Not a disaster, but it contradicts the ADR and must not pass quietly: ADR-0008
        # section 4 and the "RENAME_NOREPLACE probe edilmeden kullanılamaz" prohibition both
        # need rewriting, and the runtime probe's cached "false" would now be wrong.
        unexpected 'RENAME_NOREPLACE SUCCEEDED on ZFS — ADR-0008 section 4 is out of date' "$zres"
        ;;
      *)
        fail 'ZFS returned an unexpected errno for RENAME_NOREPLACE' "$zres"
        ;;
    esac

    # Second probe: destination present. A filesystem with real support answers EEXIST here;
    # one without answers EINVAL regardless of what is on disk. The difference tells DEPSIS
    # whether the flag can ever be trusted as a no-clobber primitive.
    echo zfs2 >"$MNT_A/.depsis/staging/nr2.part"
    echo occupied >"$MNT_A/Documents/nr2.final"
    zres2=$(probe py_renameat2_noreplace "$MNT_A/.depsis/staging/nr2.part" "$MNT_A/Documents/nr2.final")
    note "ZFS renameat2(RENAME_NOREPLACE), destination present: $zres2"
    case "$zres2" in
      ERRNO:EINVAL*) pass 'ZFS answers EINVAL regardless of destination state (flag unsupported)' ;;
      ERRNO:EEXIST*) pass 'ZFS answers EEXIST — real RENAME_NOREPLACE support' \
                          'ADR-0008 section 4 needs updating' ;;
      OK*)           unexpected 'RENAME_NOREPLACE CLOBBERED an existing destination' \
                          'this is worse than no support: the flag is accepted and ignored' ;;
      *)             fail 'unexpected result for the destination-present probe' "$zres2" ;;
    esac
    rm -f "$MNT_A/.depsis/staging/nr.part" "$MNT_A/.depsis/staging/nr2.part" \
          "$MNT_A/Documents/nr.final" "$MNT_A/Documents/nr2.final"
  fi
  rm -rf "$SHM_CTRL"
fi

# ═══════════════════════════════════════════════════════════════════════════════
section '5. The portable fallback — linkat + unlink as atomic no-clobber'
# ═══════════════════════════════════════════════════════════════════════════════
# This is what DEPSIS actually ships with, per ADR-0008. It only works if link(2) refuses to
# overwrite. If link() ever clobbered, two concurrent publishes of the same filename would
# silently destroy one user's upload with no error and no trace.

if [ "$HAVE_PY" -eq 1 ]; then
  STAGED="$MNT_A/.depsis/staging/link.part"
  DEST="$MNT_A/Documents/link.final"
  echo 'link-payload-v1' >"$STAGED"
  staged_ino=$(stat -c %i "$STAGED")

  got=$(probe py_link "$STAGED" "$DEST")
  expect_ok 'link(2) succeeds when the destination does not exist' "$got"
  assert_eq 'the link points at the same inode' "$staged_ino" "$(stat -c %i "$DEST")"
  assert_eq 'link count is 2 before the unlink' 2 "$(stat -c %h "$DEST")"

  # The no-clobber property, which is the entire reason this idiom was chosen.
  echo 'link-payload-v2' >"$MNT_A/.depsis/staging/link2.part"
  got=$(probe py_link "$MNT_A/.depsis/staging/link2.part" "$DEST")
  expect_errno 'link(2) onto an EXISTING destination must fail atomically' EEXIST "$got"
  assert_contains 'the original destination content is untouched' \
    'link-payload-v1' "$(cat "$DEST")"

  # Step two of the idiom: drop the staging name. The published file must survive intact.
  rm -f "$STAGED"
  assert_eq 'link count drops to 1 after unlinking the staging name' 1 "$(stat -c %h "$DEST")"
  assert_contains 'published content survives the unlink' 'link-payload-v1' "$(cat "$DEST")"

  # Boundary reminder: hard links cannot cross datasets either, so this fallback is only valid
  # for the .depsis-inside-the-target-dataset layout. On a separate staging dataset it would
  # have failed exactly like rename did.
  got=$(probe py_link "$DEST" "$MNT_B/Documents/link.crossds")
  expect_errno 'link(2) across datasets fails too (the fallback is intra-dataset only)' EXDEV "$got"

  rm -f "$DEST" "$MNT_A/.depsis/staging/link2.part"
fi

# ═══════════════════════════════════════════════════════════════════════════════
section '6. The ADR-0008 publish ordering, and what this script cannot prove'
# ═══════════════════════════════════════════════════════════════════════════════
# Ordering: write .part → fsync(file) → scan → renameat → fsync(DEST DIRECTORY).
#
# Step 5 exists because fsync on the file only makes the file's DATA durable. The rename is a
# change to the destination DIRECTORY, and that directory entry lives in its own metadata. If
# power is lost after the rename but before the directory is committed, the bytes survive under
# a name nobody can find: the upload is reported complete, the user sees nothing, and the
# staging reaper eventually deletes it. That is silent data loss, which is the failure class
# §17 cares about most.
#
# WHAT THIS SECTION DOES NOT DO: it does not cut power, so it does not test durability. It only
# proves the syscall sequence is available and completes. Real power-loss verification requires
# hard reset / write-cache injection under a running publish and belongs in the chaos and
# recovery suite, not here. Do not cite this section as durability evidence.

if [ "$HAVE_PY" -eq 1 ]; then
  # fsync on a directory fd is not universally supported; some filesystems return EINVAL. If ZFS
  # did, ADR-0008's step 5 would be unimplementable and the ordering would need redesigning.
  got=$(probe py_fsync_dir "$MNT_A/Documents")
  expect_ok 'fsync() on a directory fd is accepted by ZFS (step 5 is implementable)' "$got"

  got=$(probe py_publish "$MNT_A/.depsis/staging" 'pub.part' "$MNT_A/Documents" 'pub.final' \
                         'depsis-p0g-publish-payload')
  expect_ok 'the full ADR-0008 ordering executes end to end' "$got"
  if [ -f "$MNT_A/Documents/pub.final" ]; then
    assert_contains 'published file has the staged content' \
      'depsis-p0g-publish-payload' "$(cat "$MNT_A/Documents/pub.final")"
    assert_cmd 'the .part name is gone from staging after publish' fail \
      -- test -e "$MNT_A/.depsis/staging/pub.part"
  fi
  note 'DURABILITY NOT TESTED HERE — power-loss behaviour is out of scope for P0-G' \
       'belongs to the chaos/recovery suite; ADR-0008 item 5 remains unverified after this run'
  rm -f "$MNT_A/Documents/pub.final"
fi

# ═══════════════════════════════════════════════════════════════════════════════
section '7. Quota semantics — refquota vs quota vs statvfs'
# ═══════════════════════════════════════════════════════════════════════════════
# ADR-0008's model: refquota is the number the user sees (snapshots excluded, so an admin's
# snapshot policy can never lock a user out), quota is refquota x ~1.3-1.5 (snapshots included,
# so snapshot accumulation cannot eat the pool). Both of those only hold if ZFS actually
# enforces them the way the table claims. And the UI must be fed from `zfs get`, never statvfs.

zfs create -o compression=off \
           -o refquota="${REFQUOTA_MIB}M" \
           -o quota="${QUOTA_MIB}M" \
           "$USER_Q"
mkdir -p "$MNT_Q/.depsis/staging"

if [ "$HAVE_PY" -eq 1 ]; then
  # Fill via .depsis/staging on purpose: ADR-0008 states staging counts against the user's
  # refquota, precisely so a user cannot park data in staging to dodge their limit. If this
  # filled past refquota, that dodge would be real.
  out1=$(probe py_fill "$MNT_Q/.depsis/staging/hog1.part" "$FILL_CAP_B")
  st1=${out1%% *}; b1=${out1##* }
  note "fill #1 (fresh dataset, refquota=${REFQUOTA_MIB}M): $out1"

  case "$st1" in
    NOQUOTA*)
      unexpected 'refquota was NOT enforced — writes ran past the limit to the safety cap' \
        "wrote $b1 bytes with refquota=$REFQUOTA_B" ;;
    ERRNO:EDQUOT*)
      pass 'writing past refquota returns EDQUOT' "stopped at $b1 bytes"
      note 'the tus layer must map this to 507 Insufficient Storage, not 500' ;;
    ERRNO:ENOSPC*)
      # Not fatal to the ADR (its 507 mapping already covers both) but the exact errno matters
      # to whoever writes that mapping, so it is recorded as a failure of the prediction.
      fail 'writes past refquota returned ENOSPC, not the predicted EDQUOT' \
        "stopped at $b1 bytes — update ADR-0008's error mapping text" ;;
    *)
      fail 'unexpected result while filling to refquota' "$out1" ;;
  esac

  if [ "$st1" != "NOQUOTA" ]; then
    # The limit must be both a real ceiling and actually usable. A refquota that stops at 10%
    # of its nominal value would be just as broken as one that does not stop at all.
    if [ "$b1" -lt "$REFQUOTA_B" ]; then
      pass 'the enforced ceiling is at or below the configured refquota' "$b1 < $REFQUOTA_B"
    else
      unexpected 'wrote at least refquota bytes before failing' "$b1 >= $REFQUOTA_B"
    fi
    if [ "$b1" -gt $(( REFQUOTA_B * 3 / 4 )) ]; then
      pass 'refquota is usable, not wildly conservative' "$b1 of $REFQUOTA_B bytes usable"
    else
      fail 'far less than refquota was writable' "$b1 of $REFQUOTA_B bytes"
    fi
  fi

  # ── the snapshot divergence, which is the entire point of using two properties ──
  zfs snapshot "$USER_Q@p0g"
  rm -f "$MNT_Q/.depsis/staging/hog1.part"
  zsync

  qprops=$(zfs get -Hp -o property,value used,usedbysnapshots,available,referenced,refquota,quota \
             "$USER_Q" | tr '\n' ' ')
  note "ADR-0008 UI source → $qprops"

  q_used=$(zprop used "$USER_Q")
  q_snap=$(zprop usedbysnapshots "$USER_Q")
  q_ref=$(zprop referenced "$USER_Q")
  q_avail=$(zprop available "$USER_Q")

  # The ADR mandates this exact command as the UI's data source. If any of the six properties
  # is not a plain integer, the API layer cannot consume it without special-casing.
  badprops=""
  for p in used usedbysnapshots available referenced refquota quota; do
    v=$(zprop "$p" "$USER_Q")
    case "$v" in ''|*[!0-9]*) badprops="$badprops $p=$v" ;; esac
  done
  if [ -z "$badprops" ]; then
    pass 'all six ADR-mandated quota properties parse as byte integers'
  else
    fail 'the ADR-mandated quota source did not return integers' "$badprops"
  fi

  # After deleting the data while a snapshot holds it: refquota (which tracks `referenced`)
  # should be free again, while quota (which includes `usedbysnapshots`) should not be.
  if [ "$q_snap" -gt $(( REFQUOTA_B / 2 )) ]; then
    pass 'the snapshot still holds the deleted data' "usedbysnapshots=$q_snap"
  else
    fail 'the snapshot did not retain the deleted data' "usedbysnapshots=$q_snap"
  fi
  if [ "$q_ref" -lt $(( REFQUOTA_B / 4 )) ]; then
    pass 'refquota freed on delete (referenced dropped)' "referenced=$q_ref"
  else
    fail 'referenced did not drop after the delete' "referenced=$q_ref"
  fi

  # ── statvfs, which ADR-0008 forbids feeding the UI ──
  # stat -f IS statvfs. Read it here, while the dataset is in the state that separates the two
  # accountings: referenced ~0, used ~refquota, usedbysnapshots ~refquota.
  read -r sv_frsize sv_blocks sv_bfree sv_bavail < <(stat -f -c '%S %b %f %a' "$MNT_Q")
  sv_total=$(( sv_frsize * sv_blocks ))
  sv_used=$(( sv_frsize * (sv_blocks - sv_bfree) ))
  sv_avail=$(( sv_frsize * sv_bavail ))
  note "statvfs on $MNT_Q → total=$sv_total used=$sv_used avail=$sv_avail (frsize=$sv_frsize)"
  note "zfs        on $USER_Q → used=$q_used usedbysnapshots=$q_snap referenced=$q_ref available=$q_avail"

  # statvfs has no snapshot dimension at all: f_blocks-f_bfree tracks `referenced`, so a UI fed
  # from it would tell this user they are using nothing while two thirds of their `quota` is
  # consumed by a snapshot they cannot see. That is a structural gap, not a version quirk.
  if [ "$q_snap" -gt 0 ]; then
    gap=$(( q_used - sv_used )); [ "$gap" -lt 0 ] && gap=$(( -gap )) || true
    if [ "$gap" -ge $(( q_snap / 2 )) ]; then
      pass 'statvfs used disagrees materially with zfs used — statvfs cannot feed the quota UI' \
           "gap=$gap bytes, usedbysnapshots=$q_snap"
    else
      # Worth knowing, but it does not license using statvfs: agreeing on one version is not
      # the same as agreeing across versions, which is what ADR-0008 actually warns about.
      note "statvfs used tracked zfs used on this build (gap=$gap bytes)" \
           'the ADR claim is about cross-version consistency; one version agreeing proves nothing'
    fi
  fi

  # ── second fill: now bounded by `quota`, not `refquota` ──
  out2=$(probe py_fill "$MNT_Q/.depsis/staging/hog2.part" "$FILL_CAP_B")
  st2=${out2%% *}; b2=${out2##* }
  note "fill #2 (snapshot holding ~${REFQUOTA_MIB}M, quota=${QUOTA_MIB}M): $out2"
  note "statvfs promised $sv_avail bytes; the dataset actually accepted $b2 bytes" \
       "delta=$(( sv_avail - b2 )) bytes — measured, not asserted"

  if [ "$st2" = "NOQUOTA" ]; then
    unexpected 'quota did not stop the second fill' "wrote $b2 bytes with quota=$(( QUOTA_MIB * 1024 * 1024 ))"
  elif [ "$b2" -lt $(( b1 * 3 / 4 )) ]; then
    # Arithmetic: quota 96M - snapshot 64M leaves ~32M, i.e. half of fill #1. The 3/4 threshold
    # is loose enough for metadata overhead and tight enough that only real divergence passes.
    pass 'snapshot space counts against quota but not refquota' \
         "fill#1=$b1 bytes, fill#2=$b2 bytes with the same refquota"
  else
    fail 'the second fill was not constrained by quota' \
         "fill#1=$b1, fill#2=$b2 — the two properties are not behaving differently"
  fi

  # ── destroy the snapshot: the space must come back ──
  rm -f "$MNT_Q/.depsis/staging/hog2.part"
  zfs destroy "$USER_Q@p0g"
  zsync
  note "after snapshot destroy → used=$(zprop used "$USER_Q") usedbysnapshots=$(zprop usedbysnapshots "$USER_Q")"

  out3=$(probe py_fill "$MNT_Q/.depsis/staging/hog3.part" "$FILL_CAP_B")
  st3=${out3%% *}; b3=${out3##* }
  note "fill #3 (snapshot destroyed): $out3"
  if [ "$st3" != "NOQUOTA" ] && [ "$b3" -gt $(( b2 * 5 / 4 )) ]; then
    pass 'destroying the snapshot returned the quota headroom' "fill#2=$b2 → fill#3=$b3 bytes"
  else
    fail 'space did not come back after the snapshot was destroyed' "fill#2=$b2, fill#3=$b3"
  fi
  rm -f "$MNT_Q/.depsis/staging/hog3.part"
fi

# ═══════════════════════════════════════════════════════════════════════════════
section '8. Explicitly out of scope for P0-G'
# ═══════════════════════════════════════════════════════════════════════════════
note 'Samba veto of .depsis is proven by P0-B and is not repeated here'
note 'power-loss durability of the directory fsync is NOT proven by this script (see section 6)'
note 'BLAKE3 vs SHA-256 throughput (ADR-0008, unverified) is not measured here'
note 'EDQUOT → HTTP 507 mapping is an API-layer test; this script only establishes the errno'

poc_summary
