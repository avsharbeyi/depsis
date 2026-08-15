#!/usr/bin/env bash
# P0-B — prove ADR-0004: the ACL substrate and its Samba mapping.
#
# This is one of the two gates that must pass before Phase 1 authz code is written.
#
# The headline claim under test is deliberately uncomfortable: zfsprops(7) says
# "The nfsv4 ZFS ACL type is not yet supported on Linux", and separately that an unsupported
# acltype behaves "the same as if it were set to off". Chained, that means acltype=nfsv4 on
# Debian does not give weak ACLs — it gives NO ACLs, silently, while also killing POSIX ACLs.
#
# Reading that in a man page is not the same as watching it happen. This script watches it
# happen, because a system built on the wrong reading would hand every user access to
# everything the mode bits allow, with no error anywhere.

POC_ID=p0-b
# shellcheck source=lib/common.sh
. "$(dirname "$(readlink -f "$0")")/lib/common.sh"

require_test_environment

TEST_USER=depsis_poc_alice
OTHER_USER=depsis_poc_bob
SHARE_GROUP=depsis_poc_rw
SMB_PASS='P0c-Test-Pw!2026'

cleanup() {
  section 'Cleanup'
  rm -f /etc/samba/smb.conf.d/depsis-poc.conf 2>/dev/null || true
  [ -f /etc/samba/smb.conf.p0b-backup ] && mv /etc/samba/smb.conf.p0b-backup /etc/samba/smb.conf
  systemctl reload smbd 2>/dev/null || true
  cleanup_pool
  userdel "$TEST_USER" 2>/dev/null || true
  userdel "$OTHER_USER" 2>/dev/null || true
  groupdel "$SHARE_GROUP" 2>/dev/null || true
}
trap cleanup EXIT

# ─── 0. environment ───────────────────────────────────────────────────────────
section 'Environment'
note "zfs version: $(zfs version 2>&1 | head -1)"
note "samba version: $(smbd --version 2>&1)"
note "kernel: $(uname -r)"
# ADR-0000 leaves the trixie samba package version unverified; capture it here.
note "samba package: $(dpkg-query -W -f='${Version}' samba 2>/dev/null || echo 'not installed')"
note "zfsutils package: $(dpkg-query -W -f='${Version}' zfsutils-linux 2>/dev/null || echo '?')"

mapfile -t VDEVS < <(poc_vdevs 2)
[ "${#VDEVS[@]}" -ge 2 ] || { fail 'need 2 vdev disks'; poc_summary; exit 1; }
note "vdevs: ${VDEVS[*]}"

cleanup_pool
zpool create -f -m "$DEPSIS_POC_ROOT" "$DEPSIS_TEST_POOL" mirror "${VDEVS[0]}" "${VDEVS[1]}"
pass 'created mirror test pool'

id "$TEST_USER"  >/dev/null 2>&1 || useradd -M -s /usr/sbin/nologin "$TEST_USER"
id "$OTHER_USER" >/dev/null 2>&1 || useradd -M -s /usr/sbin/nologin "$OTHER_USER"
getent group "$SHARE_GROUP" >/dev/null || groupadd "$SHARE_GROUP"
gpasswd -a "$TEST_USER" "$SHARE_GROUP" >/dev/null

# ═══════════════════════════════════════════════════════════════════════════════
section '1. acltype=nfsv4 — does it silently disable ACLs? (ADR-0004 core claim)'
# ═══════════════════════════════════════════════════════════════════════════════

zfs create -o mountpoint="$DEPSIS_POC_ROOT/nfsv4" "$DEPSIS_TEST_POOL/nfsv4" 2>/dev/null || true

set_rc=0
zfs set acltype=nfsv4 "$DEPSIS_TEST_POOL/nfsv4" 2>/dev/null || set_rc=$?
effective_acltype=$(zfs get -H -o value acltype "$DEPSIS_TEST_POOL/nfsv4")
note "requested acltype=nfsv4, zfs reports: '$effective_acltype' (set rc=$set_rc)"

if [ "$effective_acltype" = "nfsv4" ]; then
  # The property took. Now the real question: is it ENFORCED, or merely stored?
  warn "acltype reports 'nfsv4' — checking whether it is actually enforced"
  touch "$DEPSIS_POC_ROOT/nfsv4/probe"
  assert_cmd 'setfacl on an acltype=nfsv4 dataset should FAIL (ACLs are off on Linux)' fail \
    -- setfacl -m "u:$TEST_USER:rwx" "$DEPSIS_POC_ROOT/nfsv4/probe"
else
  # Most likely path: zfs rejected it or coerced it. Either way nfsv4 is unusable.
  pass "acltype=nfsv4 did not take on Linux (reports '$effective_acltype')" \
       "confirms zfsprops(7): not supported on Linux"
  touch "$DEPSIS_POC_ROOT/nfsv4/probe"
  assert_cmd 'setfacl must fail while acltype is not posixacl' fail \
    -- setfacl -m "u:$TEST_USER:rwx" "$DEPSIS_POC_ROOT/nfsv4/probe"
fi

# The dangerous part is that nothing warns you. Record what an operator would actually see.
note "operator-visible signal of the misconfiguration: acltype='$effective_acltype', no error emitted"

# ═══════════════════════════════════════════════════════════════════════════════
section '2. acltype=posixacl + xattr=sa — the corrected configuration'
# ═══════════════════════════════════════════════════════════════════════════════

SHARE_DS="$DEPSIS_TEST_POOL/share1"
SHARE_PATH="$DEPSIS_POC_ROOT/share1"
zfs create -o mountpoint="$SHARE_PATH" \
           -o acltype=posixacl \
           -o xattr=sa \
           -o dnodesize=auto \
           "$SHARE_DS"

# Neither property reads back as written. Both are display aliasing, and P0-A settled it
# behaviourally (xattr=sa yields 6 objects vs 16 for dir, so sa really is in effect):
#   acltype=posixacl -> "posix"   xattr=sa -> "on"
# The rule this implies is what matters: the agent's dataset validation must accept the alias
# forms, or it rejects correctly configured datasets. See ADR-0004.
acltype_got=$(zfs get -H -o value acltype "$SHARE_DS")
xattr_got=$(zfs get -H -o value xattr "$SHARE_DS")
case "$acltype_got" in
  posixacl | posix) pass "acltype is POSIX ACL (reported '$acltype_got')" ;;
  *) fail 'acltype is not POSIX ACL' "reported '$acltype_got'" ;;
esac
case "$xattr_got" in
  sa | on) pass "xattr is SA-based (reported '$xattr_got')" ;;
  dir) fail 'xattr fell back to directory-based storage' 'ADR-0004 requires sa' ;;
  *) fail 'xattr is not enabled' "reported '$xattr_got'" ;;
esac

chgrp "$SHARE_GROUP" "$SHARE_PATH"
chmod 0770 "$SHARE_PATH"

echo 'secret contents' >"$SHARE_PATH/doc.txt"
chmod 0640 "$SHARE_PATH/doc.txt"

assert_cmd 'setfacl now succeeds' ok \
  -- setfacl -m "g:$SHARE_GROUP:rwx" "$SHARE_PATH"
assert_cmd 'setfacl on the file succeeds' ok \
  -- setfacl -m "u:$TEST_USER:r--" "$SHARE_PATH/doc.txt"

acl_out=$(getfacl -p "$SHARE_PATH/doc.txt" 2>&1)
assert_contains 'getfacl reports the granted user entry' "user:$TEST_USER:r--" "$acl_out"

# ═══════════════════════════════════════════════════════════════════════════════
section '3. Is the ACL actually ENFORCED by the kernel?'
# ═══════════════════════════════════════════════════════════════════════════════
# A stored ACL that nothing enforces is exactly the failure mode of section 1. Prove the
# difference by having two unprivileged users try to read the same file.

assert_cmd "granted user ($TEST_USER) can read the file" ok \
  -- runuser -u "$TEST_USER" -- cat "$SHARE_PATH/doc.txt"

# bob has no ACL entry and is not in the group -> must be refused by the kernel, not by us.
assert_cmd "ungranted user ($OTHER_USER) is REFUSED by the kernel" fail \
  -- runuser -u "$OTHER_USER" -- cat "$SHARE_PATH/doc.txt"

# ═══════════════════════════════════════════════════════════════════════════════
section '4. Inheritance via POSIX default ACLs (aclinherit does NOT apply on Linux)'
# ═══════════════════════════════════════════════════════════════════════════════

setfacl -d -m "g:$SHARE_GROUP:rwx" "$SHARE_PATH"
mkdir -p "$SHARE_PATH/sub"
touch "$SHARE_PATH/sub/inherited.txt"

child_acl=$(getfacl -p "$SHARE_PATH/sub/inherited.txt" 2>&1)
assert_contains 'new file inherited the default ACL' "group:$SHARE_GROUP:rw" "$child_acl"

dir_acl=$(getfacl -p "$SHARE_PATH/sub" 2>&1)
assert_contains 'new directory inherited the default ACL as a default' "default:group:$SHARE_GROUP:rwx" "$dir_acl"

# ═══════════════════════════════════════════════════════════════════════════════
section '5. Samba mapping — DEPSIS POSIX ACL must be visible to SMB'
# ═══════════════════════════════════════════════════════════════════════════════

if ! command -v smbcacls >/dev/null 2>&1; then
  warn 'smbclient/smbcacls not installed; skipping the SMB half of P0-B'
  note 'SMB half SKIPPED — P0-B is NOT complete without it'
else
  cp /etc/samba/smb.conf /etc/samba/smb.conf.p0b-backup
  mkdir -p /etc/samba/smb.conf.d

  # ADR-0004: acl_xattr WITHOUT "ignore system acls", so Samba mirrors NT ACL edits down into
  # POSIX ACLs. ADR-0011: full_audit is the primary change-event source. ADR-0008: veto .depsis.
  cat >/etc/samba/smb.conf <<EOF
[global]
    workgroup = WORKGROUP
    server min protocol = SMB3
    security = user
    map to guest = never
    vfs objects = acl_xattr full_audit
    map acl inherit = yes
    store dos attributes = yes
    full_audit:prefix = %u|%I|%S
    full_audit:success = create_file renameat unlinkat mkdirat close ftruncate
    full_audit:failure = none
    full_audit:facility = local5
    full_audit:priority = notice

[p0bshare]
    path = $SHARE_PATH
    read only = no
    inherit acls = yes
    veto files = /.depsis/
    delete veto files = no
    valid users = @$SHARE_GROUP
EOF

  # ADR-0004 / master prompt §9: config is validated BEFORE publish, never string-appended live.
  assert_cmd 'testparm accepts the generated config' ok -- testparm -s --suppress-prompt
  systemctl reload smbd 2>/dev/null || systemctl restart smbd

  printf '%s\n%s\n' "$SMB_PASS" "$SMB_PASS" | smbpasswd -s -a "$TEST_USER" >/dev/null
  smbpasswd -e "$TEST_USER" >/dev/null

  # Prove the share is reachable BEFORE testing anything about it.
  #
  # An earlier run of this PoC reported the .depsis veto checks below as PASS while the share
  # was in fact completely unreachable: an invalid vfs_full_audit opname made smbd refuse every
  # connection, so the listing was empty (no .depsis in it — "pass") and the download failed
  # ("pass"). Two green checks, both meaningless. Any test that concludes something from an
  # absence has to first establish that presence was possible.
  if smbclient "//127.0.0.1/p0bshare" -U "$TEST_USER%$SMB_PASS" -c 'ls' >/dev/null 2>&1; then
    pass 'the share is reachable over SMB (precondition for everything below)'
  else
    fail 'the share is NOT reachable over SMB — every check below would be a false pass' \
         "$(smbclient "//127.0.0.1/p0bshare" -U "$TEST_USER%$SMB_PASS" -c 'ls' 2>&1 | head -3)
check the smbd log: an invalid full_audit opname makes the module refuse the connect, and
testparm does not catch it."
    poc_summary
    exit 1
  fi

  sacl=$(smbcacls "//127.0.0.1/p0bshare" /doc.txt -U "$TEST_USER%$SMB_PASS" 2>&1) || true
  note "smbcacls output: ${sacl//$'\n'/ ; }"

  if grep -q 'ACL:' <<<"$sacl"; then
    pass 'smbcacls can read the security descriptor over SMB'
    # The POSIX grant for alice must be visible as an ACE. Samba renders the SID or name.
    if grep -qiE "(${TEST_USER}|S-1-)" <<<"$sacl"; then
      pass 'the DEPSIS-granted subject appears in the SMB security descriptor'
    else
      fail 'granted subject is NOT visible over SMB' "$sacl"
    fi
  else
    fail 'smbcacls returned no ACL' "$sacl"
  fi

  # 5b. The bridge in the other direction: with "ignore system acls" OFF, an NT ACL change
  # made over SMB must be mirrored down into the POSIX ACL the kernel enforces. If this does
  # not hold, ADR-0004's single-substrate premise is broken.
  before=$(getfacl -p "$SHARE_PATH/doc.txt" 2>&1)
  if smbcacls "//127.0.0.1/p0bshare" /doc.txt -U "$TEST_USER%$SMB_PASS" \
        -a "ACL:$TEST_USER:ALLOWED/0x0/FULL" >/dev/null 2>&1; then
    after=$(getfacl -p "$SHARE_PATH/doc.txt" 2>&1)
    if [ "$before" != "$after" ]; then
      pass 'an SMB-side ACL change is mirrored into the POSIX ACL (single substrate holds)'
      note "posix acl after smb change: ${after//$'\n'/ ; }"
    else
      fail 'SMB-side ACL change did NOT reach the POSIX ACL — two realities' \
           "before=${before//$'\n'/ ; }"
    fi
  else
    warn 'could not set an ACL over SMB; the down-mapping half is unproven'
    note 'SMB->POSIX mirroring UNPROVEN'
  fi

  # 5c. veto must actually block, not merely hide (ADR-0008).
  mkdir -p "$SHARE_PATH/.depsis/staging"
  echo partial >"$SHARE_PATH/.depsis/staging/upload.part"
  listing=$(smbclient "//127.0.0.1/p0bshare" -U "$TEST_USER%$SMB_PASS" -c 'ls' 2>&1) || true
  if grep -q '\.depsis' <<<"$listing"; then
    fail 'veto files did not hide .depsis from SMB' "$listing"
  else
    pass '.depsis is not listed over SMB'
  fi
  getrc=0
  smbclient "//127.0.0.1/p0bshare" -U "$TEST_USER%$SMB_PASS" \
    -c 'get .depsis/staging/upload.part /tmp/p0b-veto-probe' >/dev/null 2>&1 || getrc=$?
  if [ "$getrc" -ne 0 ]; then
    pass 'veto files also BLOCKS direct access to .depsis (not just hiding)'
  else
    unexpected 'a vetoed .depsis file was downloadable over SMB' 'staging content is exposed'
  fi
  rm -f /tmp/p0b-veto-probe
fi

poc_summary
