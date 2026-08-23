#!/usr/bin/env bash
#
# Does the ACL model DEPSIS writes actually gate a real SMB session?
#
# Everything §6.2 does today stops at the API. `folder_grants` decides who may reach a folder, the
# agent writes POSIX ACL entries naming numeric gids, and the share root is closed to `other`. None
# of that has ever been measured against smbd — and SMB is the protocol a NAS exists for, so if the
# chain breaks there, the whole permission model is web-only.
#
# There are three links, and each is a separate question this script answers with a measurement:
#
#   1. Does smbd resolve a DEPSIS user to a Unix account and pick up the SUPPLEMENTARY groups that
#      the ACL entries name? If not, an ACL granting `g:300010:rx` reaches nobody.
#   2. Does `valid users` narrow a share, and does it narrow it INDEPENDENTLY of the ACL — so that
#      the two together are an intersection rather than a race?
#   3. THE P0-B SHAPE. `valid users` naming an account that does not exist: does `testparm` pass it
#      and smbd then refuse EVERY connection, the way an invalid `full_audit` opname did? That
#      question decides whether DEPSIS can write the directive at all, because a share list is
#      published atomically — one bad name would take every other share down with it.
#
# Nothing here touches the repository's own configuration. It builds a throwaway share root, two
# throwaway accounts inside the reserved 300000-399999 range, and its own smb.conf, then removes
# them. Run as root on a box where losing /etc/samba is acceptable — the development VM.
#
#   sudo bash tools/poc/p2-a-smb-identity.sh
#
set -uo pipefail

ROOT=/srv/depsis-poc
CONF=/etc/samba/smb.conf
INCLUDED=/etc/samba/depsis-poc.conf
BACKUP=/etc/samba/smb.conf.p2a-backup

# The reserved range migration 0015 set aside, and the names the agent would derive from the
# numbers rather than from anything a caller typed.
GID_TEAM=300010
UID_IN=300001
UID_OUT=300002
USER_IN="depsis-u-$UID_IN"
USER_OUT="depsis-u-$UID_OUT"
GROUP_TEAM="depsis-t-$GID_TEAM"
PW='poc-parola-42'

passed=0
failed=0
say() { printf '  %-62s %s\n' "$1" "$2"; }
ok() { say "$1" "${2:-ok}"; passed=$((passed + 1)); }
bad() { say "$1" "${2:-}"; failed=$((failed + 1)); }

need_root() {
  [ "$(id -u)" = 0 ] || { echo "must run as root"; exit 2; }
}

# ─── teardown, registered before anything is built ────────────────────────────
cleanup() {
  systemctl stop smbd >/dev/null 2>&1
  [ -f "$BACKUP" ] && mv -f "$BACKUP" "$CONF"
  rm -f "$INCLUDED"
  userdel "$USER_IN" >/dev/null 2>&1
  userdel "$USER_OUT" >/dev/null 2>&1
  groupdel "$GROUP_TEAM" >/dev/null 2>&1
  groupdel "$USER_IN" >/dev/null 2>&1
  groupdel "$USER_OUT" >/dev/null 2>&1
  rm -rf "$ROOT"
  systemctl start smbd >/dev/null 2>&1
}
trap cleanup EXIT

need_root
echo "════ p2-a — does the ACL model reach SMB at all?"
echo

# ─── the accounts ─────────────────────────────────────────────────────────────
#
# Private primary groups, as `create_dir` already assumes: the agent passes the owner's uid as BOTH
# uid and gid, so a user's own gid must be theirs alone. The TEAM group is supplementary, and it is
# the one the ACL entry names — ADR-0004 gives entries to groups precisely so the entry count stays
# bounded as membership grows.
groupadd -g "$UID_IN" "$USER_IN" 2>/dev/null
groupadd -g "$UID_OUT" "$USER_OUT" 2>/dev/null
groupadd -g "$GID_TEAM" "$GROUP_TEAM" 2>/dev/null
useradd -u "$UID_IN" -g "$UID_IN" -G "$GROUP_TEAM" -M -s /usr/sbin/nologin "$USER_IN" 2>/dev/null
useradd -u "$UID_OUT" -g "$UID_OUT" -M -s /usr/sbin/nologin "$USER_OUT" 2>/dev/null

id "$USER_IN" >/dev/null 2>&1 && id "$USER_OUT" >/dev/null 2>&1 \
  && ok "two accounts exist in the reserved range" "$(id -u "$USER_IN"),$(id -u "$USER_OUT")" \
  || { bad "COULD NOT CREATE THE ACCOUNTS"; exit 1; }

id -nG "$USER_IN" | tr ' ' '\n' | grep -qx "$GROUP_TEAM" \
  && ok "the member is in the team group" \
  || bad "MEMBERSHIP DID NOT TAKE"

# ─── the share, as the agent would leave it ───────────────────────────────────
#
# 0750 root:root is what `SecureShareRoot` writes, and the ACL entry is what `ApplyFolderAcl`
# writes. Together they are the whole DEPSIS-side model: nothing reaches the share except through a
# named group entry.
install -d -m 0750 "$ROOT"
install -d -m 0750 "$ROOT/ortak"
setfacl -m "g:$GID_TEAM:rx" "$ROOT"
setfacl -m "g:$GID_TEAM:rwx" -m "d:g:$GID_TEAM:rwx" "$ROOT/ortak"
echo 'gizli' > "$ROOT/ortak/dosya.txt"
chmod 0640 "$ROOT/ortak/dosya.txt"
setfacl -m "g:$GID_TEAM:r" "$ROOT/ortak/dosya.txt"

# ─── Samba, with DEPSIS's file included exactly as the product does it ────────
cp -f "$CONF" "$BACKUP" 2>/dev/null || : > "$BACKUP"
cat > "$CONF" <<EOF
[global]
	workgroup = WORKGROUP
	server role = standalone server
	security = user
	map to guest = never
	# The one line the product's generated file tells the operator to add.
	include = $INCLUDED
EOF

write_included() {
	# \$1: an extra directive for [ortak], or empty.
	cat > "$INCLUDED" <<EOF
[ortak]
	comment = DEPSIS share
	path = $ROOT/ortak
	browseable = yes
	read only = no
	guest ok = no
	veto files = /.depsis/
	delete veto files = no
${1:+	$1}

[baska]
	comment = DEPSIS share
	path = $ROOT
	browseable = yes
	read only = yes
	guest ok = no
EOF
}

set_password() {
	printf '%s\n%s\n' "$PW" "$PW" | smbpasswd -a -s "$1" >/dev/null 2>&1
}
set_password "$USER_IN"
set_password "$USER_OUT"

restart_smbd() {
	systemctl restart smbd >/dev/null 2>&1
	for _ in $(seq 1 20); do
		smbclient -L localhost -N -g >/dev/null 2>&1 && return 0
		sleep 0.5
	done
	return 1
}

# `-c ls` rather than a bare connection: a connection can succeed and the tree connect still be
# refused, and what the model claims is about READING the folder.
can_read() {
	smbclient "//localhost/$2" -U "$1%$PW" -c 'ls' >/dev/null 2>&1
}

write_included ""
testparm -s "$CONF" >/dev/null 2>&1 \
  && ok "testparm accepts the generated shape" \
  || bad "TESTPARM REFUSED THE BASELINE"
restart_smbd && ok "smbd is serving" || { bad "SMBD WOULD NOT START"; exit 1; }

# ─── question 1: does the ACL gate a real session? ────────────────────────────
echo
echo "── 1. the POSIX ACL, through smbd"
can_read "$USER_IN" ortak \
  && ok "a member of the granted group can read the share" \
  || bad "THE ACL DOES NOT REACH SMB — the whole model is web-only"

can_read "$USER_OUT" ortak \
  && bad "A NON-MEMBER COULD READ IT — the ACL grants nothing" \
  || ok "a user outside the group is refused"

# ─── question 2: does `valid users` narrow independently? ─────────────────────
echo
echo "── 2. valid users, as a second gate"
write_included "valid users = $USER_OUT"
restart_smbd || bad "SMBD WOULD NOT RESTART WITH valid users"

can_read "$USER_IN" ortak \
  && bad "valid users DID NOT NARROW — the ACL member still got in" \
  || ok "a user the ACL allows but valid users omits is refused"

# The reverse: named in `valid users` but with no ACL entry. If this succeeded, `valid users` would
# be WIDENING — and DEPSIS would be handing out access the grant walk never granted.
can_read "$USER_OUT" ortak \
  && bad "valid users WIDENED ACCESS PAST THE ACL" \
  || ok "valid users cannot grant what the ACL withholds"

# ─── question 3: the P0-B shape ───────────────────────────────────────────────
echo
echo "── 3. an unmapped name in valid users — does it take the whole file down?"
write_included "valid users = kimseyok"
if testparm -s "$CONF" >/dev/null 2>&1; then
  say "testparm accepts a name with no account" "yes — so testparm is not the gate"
else
  say "testparm rejects a name with no account" "no"
fi
restart_smbd || bad "SMBD WOULD NOT RESTART"

# THE question. If an unresolvable name in ONE section stops smbd serving the OTHERS, then DEPSIS
# cannot write this directive at all: the publish is atomic over every share on the box, so one
# stale username would take the whole appliance offline.
if smbclient -L localhost -N -g 2>/dev/null | grep -qi '^disk|baska'; then
  ok "the other share is still served" "an unmapped name is contained"
else
  bad "AN UNMAPPED NAME TOOK DOWN THE WHOLE FILE" "valid users is unsafe to generate"
fi

can_read "$USER_IN" baska \
  && ok "and the other share is still usable" \
  || bad "THE OTHER SHARE STOPPED WORKING"

echo
echo "════ $passed passed, $failed failed"
[ "$failed" -eq 0 ]
