#!/usr/bin/env bash
#
# The join. Does a real `sync_posix_identity` to the real agent produce a person who can log in?
#
# p2-a measured that the ACL chain gates a real smbd session. p2-b measured that a precomputed NT
# hash installs and authenticates. `identity.rs` has unit tests against scripted `getent` output,
# and `identity-sync.integration.test.ts` measures the shape the API sends. Every LINK is proven.
#
# None of that proves the JOIN. The links were measured with hand-made accounts, hand-written
# smbpasswd lines and a mock runner; this drives the actual compiled agent over an actual Unix
# socket with an actual request, and then asks the machine and smbd whether it worked.
#
# It is the privileged half deliberately. Booting the whole API to create a user would measure
# Nest's wiring, which unit tests already cover, and would hide the thing worth watching — what the
# root daemon does to /etc/passwd, /etc/group and the passdb when a real request arrives.
#
#   sudo bash tools/poc/p2-c-identity-end-to-end.sh
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENT_BIN="$REPO/target/release/depsis-agent"
WORK=/tmp/depsis-p2c
SOCK="$WORK/agent.sock"
DATASOCK="$WORK/agent-data.sock"
SHARES="$WORK/shares"
CONF=/etc/samba/smb.conf
INCLUDED=/etc/samba/depsis-p2c.conf
BACKUP=/etc/samba/smb.conf.p2c-backup

# The reserved range, and names the agent derives from the numbers.
UID_ALI=300601
UID_VELI=300602
GID_TEAM=300610
PW_ALI='ali-parola-42'
PW_VELI='veli-parola-42'

passed=0
failed=0
say() { printf '  %-62s %s\n' "$1" "$2"; }
ok() { say "$1" "${2:-ok}"; passed=$((passed + 1)); }
bad() { say "$1" "${2:-}"; failed=$((failed + 1)); }

cleanup() {
  pkill -f "systemd-socket-activate --fdname=control:data" 2>/dev/null
  systemctl stop smbd >/dev/null 2>&1
  [ -f "$BACKUP" ] && mv -f "$BACKUP" "$CONF"
  rm -f "$INCLUDED"
  for u in ali veli; do
    pdbedit -x -u "$u" >/dev/null 2>&1
    userdel "$u" >/dev/null 2>&1
  done
  for g in depsis-p-$UID_ALI depsis-p-$UID_VELI depsis-t-$GID_TEAM; do
    groupdel "$g" >/dev/null 2>&1
  done
  rm -rf "$WORK"
  systemctl start smbd >/dev/null 2>&1
}
trap cleanup EXIT

[ "$(id -u)" = 0 ] || { echo "must run as root"; exit 2; }
command -v systemd-socket-activate >/dev/null || { echo "systemd-socket-activate is required"; exit 2; }
[ -x "$AGENT_BIN" ] || { echo "build the agent first: cargo build --release --bin depsis-agent"; exit 2; }
cleanup

echo "════ p2-c — from one agent request to a Windows login"
echo

install -d -m 0755 "$WORK" "$SHARES"
install -d -m 0750 "$SHARES/ortak"

# ─── the agent, under socket activation, exactly as the unit runs it ──────────
#
# `DEPSIS_API_UID=0` would be refused — the agent will not take orders from root over this socket,
# because then every root process on the box could drive it. So the probe runs as an ordinary uid
# and the agent is told to expect that one.
PROBE_UID=399990
id -u p2cprobe >/dev/null 2>&1 || {
  groupadd -g "$PROBE_UID" p2cprobe 2>/dev/null
  useradd -u "$PROBE_UID" -g "$PROBE_UID" -M -s /usr/sbin/nologin p2cprobe 2>/dev/null
}

# BOTH sockets, and NAMED. The agent looks them up by `LISTEN_FDNAMES` and refuses to start
# with only one — deliberately: started with just the control socket it would accept
# `OpenTransfer` and mint tokens for data connections that could never arrive.
# `--fdname=control:data` is how `systemd-socket-activate` spells what the two `.socket` units
# declare with `FileDescriptorName=`. Getting this wrong is not subtle — the agent exits with
# the reason on stderr — which is why it says so rather than defaulting to a position.
setsid nohup systemd-socket-activate --fdname=control:data \
  --listen="$SOCK" --listen="$DATASOCK" \
  --setenv=DEPSIS_API_UID="$PROBE_UID" --setenv=DEPSIS_SHARES_ROOT="$SHARES" \
  "$AGENT_BIN" --serve > "$WORK/agent.log" 2>&1 < /dev/null &
for _ in $(seq 1 40); do [ -S "$SOCK" ] && break; sleep 0.2; done
chown "root:$PROBE_UID" "$SOCK" "$DATASOCK" 2>/dev/null
chmod 0660 "$SOCK" "$DATASOCK" 2>/dev/null
[ -S "$SOCK" ] && ok "the agent is listening" || { bad "NO SOCKET"; exit 1; }

cat > "$WORK/ask.mjs" <<'PROBE'
import { createConnection } from 'node:net';
const [, , sock, body] = process.argv;
const c = createConnection({ path: sock });
let buf = '';
const done = (v) => { c.destroy(); process.stdout.write(v); process.exit(0); };
const t = setTimeout(() => done('TIMEOUT'), 20000);
c.on('connect', () => c.write(body + '\n'));
c.on('data', (d) => { buf += d; if (buf.includes('\n')) { clearTimeout(t); done(buf.trim()); } });
c.on('end', () => { clearTimeout(t); done(buf.trim() || 'CLOSED'); });
c.on('error', (e) => { clearTimeout(t); done('ERROR ' + (e.code ?? e.message)); });
PROBE

# The NT hashes the API would have computed. Same formula `apps/api/src/auth/nt-hash.ts` implements
# and `p2-b` confirmed against Samba: MD4 of the password in UTF-16LE, uppercase hex.
nt() {
  printf '%s' "$1" | iconv -f UTF-8 -t UTF-16LE \
    | openssl dgst -md4 -provider legacy -provider default -r | cut -d' ' -f1 | tr 'a-f' 'A-F'
}
NT_ALI=$(nt "$PW_ALI")
NT_VELI=$(nt "$PW_VELI")

ask() {
  setpriv --reuid=p2cprobe --regid="$PROBE_UID" --clear-groups \
    node "$WORK/ask.mjs" "$SOCK" "$1"
}

# ─── one request: two users, one team, ali in it ──────────────────────────────
echo
echo "── 1. one sync_posix_identity, sent as the API would send it"
REQ=$(cat <<JSON
{"correlation_id":"p2c","reason":"end to end","request":{"op":"sync_posix_identity",
 "users":[{"uid":$UID_ALI,"login":"ali","nt_hash":"$NT_ALI"},
          {"uid":$UID_VELI,"login":"veli","nt_hash":"$NT_VELI"}],
 "groups":[{"gid":$GID_TEAM,"members":[$UID_ALI]}]}}
JSON
)
ANSWER=$(ask "$(printf '%s' "$REQ" | tr -d '\n')")
case "$ANSWER" in
  *posix_identity_synced*) ok "the agent accepted it" "$ANSWER" ;;
  *) bad "THE AGENT REFUSED" "$ANSWER"; echo "--- agent log"; tail -20 "$WORK/agent.log" ;;
esac

# ─── 2. did the machine actually change? ──────────────────────────────────────
echo
echo "── 2. the machine"
[ "$(id -u ali 2>/dev/null)" = "$UID_ALI" ] \
  && ok "ali exists at the uid DEPSIS issued" "$UID_ALI" || bad "NO ACCOUNT FOR ali"
[ "$(id -u veli 2>/dev/null)" = "$UID_VELI" ] \
  && ok "veli exists at the uid DEPSIS issued" "$UID_VELI" || bad "NO ACCOUNT FOR veli"

getent passwd ali | grep -q nologin \
  && ok "the shell is nologin" || bad "ali HAS A LOGIN SHELL"
[ -d "$(getent passwd ali | cut -d: -f6)" ] \
  && bad "A HOME DIRECTORY WAS CREATED" || ok "no home directory"

MEMBERS=$(getent group "depsis-t-$GID_TEAM" | cut -d: -f4)
[ "$MEMBERS" = "ali" ] \
  && ok "the team group holds exactly its member" "$MEMBERS" \
  || bad "WRONG MEMBERSHIP" "'$MEMBERS'"

# ─── 3. the ACL, written by the same agent, and a real login ──────────────────
echo
echo "── 3. an actual SMB session"
setfacl -m "g:$GID_TEAM:rx" "$SHARES"
setfacl -m "g:$GID_TEAM:rwx" -m "d:g:$GID_TEAM:rwx" "$SHARES/ortak"
echo 'icerik' > "$SHARES/ortak/dosya.txt"

cp -f "$CONF" "$BACKUP" 2>/dev/null || : > "$BACKUP"
cat > "$CONF" <<EOF
[global]
	workgroup = WORKGROUP
	server role = standalone server
	security = user
	map to guest = never
	include = $INCLUDED
EOF
cat > "$INCLUDED" <<EOF
[ortak]
	comment = DEPSIS share
	path = $SHARES/ortak
	browseable = yes
	read only = no
	guest ok = no
EOF
systemctl restart smbd >/dev/null 2>&1
for _ in $(seq 1 20); do smbclient -L localhost -N >/dev/null 2>&1 && break; sleep 0.5; done

# The password was NEVER given to Samba as text. It went in as an NT hash, inside one agent
# request, computed the way the API computes it.
smbclient //localhost/ortak -U "ali%$PW_ALI" -c 'ls' >/dev/null 2>&1 \
  && ok "ali logs in with the password DEPSIS only ever hashed" \
  || bad "ali CANNOT LOG IN"

smbclient //localhost/ortak -U "veli%$PW_VELI" -c 'ls' >/dev/null 2>&1 \
  && bad "veli GOT IN — the ACL grants the team, and veli is not in it" \
  || ok "veli authenticates but the ACL refuses the share"

smbclient //localhost/ortak -U "ali%yanlis-parola" -c 'ls' >/dev/null 2>&1 \
  && bad "A WRONG PASSWORD WORKED — this whole file measures nothing" \
  || ok "a wrong password is refused"

# ─── 4. idempotence, and a removal that has to bite ───────────────────────────
echo
echo "── 4. running it again, with ali taken out of the team"
REQ2=$(cat <<JSON
{"correlation_id":"p2c","reason":"membership change","request":{"op":"sync_posix_identity",
 "users":[{"uid":$UID_ALI,"login":"ali"},{"uid":$UID_VELI,"login":"veli"}],
 "groups":[{"gid":$GID_TEAM,"members":[]}]}}
JSON
)
ANSWER2=$(ask "$(printf '%s' "$REQ2" | tr -d '\n')")
case "$ANSWER2" in
  *'"users_created":0'*) ok "a second sync creates nothing" "$ANSWER2" ;;
  *posix_identity_synced*) bad "IT CREATED SOMETHING ON THE SECOND RUN" "$ANSWER2" ;;
  *) bad "THE SECOND SYNC FAILED" "$ANSWER2" ;;
esac

LEFT=$(getent group "depsis-t-$GID_TEAM" | cut -d: -f4)
[ -z "$LEFT" ] && ok "ali actually left the group" || bad "STILL A MEMBER" "'$LEFT'"

# THE ONE THAT MATTERS. A removal that does not reach the filesystem is somebody who keeps reading
# folders their grant no longer covers — and it is invisible from the web, which shows the grant as
# gone.
systemctl restart smbd >/dev/null 2>&1
for _ in $(seq 1 20); do smbclient -L localhost -N >/dev/null 2>&1 && break; sleep 0.5; done
smbclient //localhost/ortak -U "ali%$PW_ALI" -c 'ls' >/dev/null 2>&1 \
  && bad "ali STILL READS THE SHARE — the removal never reached SMB" \
  || ok "and the share is closed to ali"

# The password survived a sync that carried no hash: `nt_hash` was absent in the second request,
# which must leave the existing credential alone rather than clearing it.
smbclient -L localhost -U "ali%$PW_ALI" >/dev/null 2>&1 \
  && ok "an absent nt_hash left the password alone" \
  || bad "THE SECOND SYNC DESTROYED THE PASSWORD"

echo
echo "════ $passed passed, $failed failed"
[ "$failed" -eq 0 ]
