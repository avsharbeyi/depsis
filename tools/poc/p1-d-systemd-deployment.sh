#!/usr/bin/env bash
#
# P1-D — the units, under real systemd.
#
# `deploy/systemd/` has been a set of files nobody ran. P0-E measured the agent's hardening by
# starting the binary by hand and reading /proc; P1-C started it with systemd-socket-activate, which
# is a standalone tool rather than systemd. Neither exercised the unit files themselves: not the
# socket unit's SocketUser/SocketGroup/SocketMode, not socket activation through pid 1, and not
# LoadCredential=, which is the entire delivery mechanism for both of the API's secrets (ADR-0016).
#
# A unit file that has never been loaded is a plan, not a deployment. This loads them.
#
# WHAT THIS DOES NOT PROVE. No ZFS here, so `zfs create` and the mount-namespace behaviour that
# shapes the agent's hardening stay in P0-E on the Debian VM. This is about delivery: does systemd
# hand the process what the unit says it does, and does the pair work once it has.
#
# Prerequisites: root, systemd as pid 1, a reachable PostgreSQL 18, a built agent
# (cargo build --release --bin depsis-agent) and a built API (pnpm build).
#
#   sudo PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=... bash tools/poc/p1-d-systemd-deployment.sh
#
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO" || exit 1

PORT="${DEPSIS_E2E_PORT:-3998}"
BASE="http://127.0.0.1:$PORT/api/v1"
DB_NAME="${DEPSIS_E2E_DB:-depsis_systemd}"
PREFIX=/usr/local/lib/depsis
WORK="$(mktemp -d)"
chmod 0755 "$WORK"
# A stand-in for the share tree. No ZFS here, so this is a plain directory — the agent confines
# itself to it with openat2(RESOLVE_BENEATH) either way, and what is being measured is the two-
# socket path, not the filesystem underneath it.
SHARES=/srv/depsis-p1d
PASSED=0
FAILED=0

ok()   { PASSED=$((PASSED + 1)); printf '  ok    %s\n' "$1"; }
bad()  { FAILED=$((FAILED + 1)); printf '  FAIL  %s\n' "$1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }
head1(){ printf '\n== %s ==\n' "$1"; }

cleanup() {
  systemctl stop depsis-api.service depsis-agent.service \
                 depsis-agent-data.socket depsis-agent.socket 2>/dev/null
  systemctl disable depsis-api.service depsis-agent.socket depsis-agent-data.socket 2>/dev/null
  systemctl reset-failed depsis-agent.service 2>/dev/null
  rm -f /etc/systemd/system/depsis-api.service \
        /etc/systemd/system/depsis-agent.service \
        /etc/systemd/system/depsis-agent.socket \
        /etc/systemd/system/depsis-agent-data.socket
  systemctl daemon-reload 2>/dev/null
  rm -rf "$WORK" "$SHARES"
}
trap cleanup EXIT

head1 'preconditions'
[ "$(id -u)" = 0 ] || { echo 'must run as root'; exit 2; }
[ "$(ps -p 1 -o comm=)" = systemd ] || { echo 'systemd must be pid 1'; exit 2; }
[ -x "$REPO/target/release/depsis-agent" ] || { echo 'no agent binary — cargo build --release'; exit 2; }
[ -f "$REPO/apps/api/dist/main.js" ] || { echo 'no API build — pnpm build'; exit 2; }
psql -qd postgres -c 'SELECT 1' >/dev/null 2>&1 || { echo 'psql cannot reach PostgreSQL'; exit 2; }
ok 'root, systemd as pid 1, both builds and PostgreSQL are present'

head1 'the units parse'
install -d -m 0755 /etc/systemd/system
cp deploy/systemd/depsis-agent.socket deploy/systemd/depsis-agent-data.socket \
   deploy/systemd/depsis-agent.service deploy/systemd/depsis-api.service /etc/systemd/system/
systemctl daemon-reload

# `systemd-analyze verify` resolves every directive and every referenced path. It is the check that
# a unit file has no misspelled directive silently ignored at load — systemd logs those and starts
# the service anyway, so a typo in a hardening line is a protection that is simply absent.
for unit in depsis-agent.socket depsis-agent-data.socket depsis-agent.service depsis-api.service; do
  if out=$(systemd-analyze verify "/etc/systemd/system/$unit" 2>&1); then
    ok "$unit verifies"
  else
    # Missing binaries and users are reported here too and are expected before the install step.
    if echo "$out" | grep -qvE 'command|Executable|not exist|Unknown user|Unknown group'; then
      bad "$unit: $out"
    else
      ok "$unit verifies (only missing paths, which the install step creates)"
    fi
  fi
done

# `systemd-analyze verify` does NOT catch a directive in the wrong section: systemd logs
# "Unknown key ... ignoring" and starts the unit regardless. Measured — both units carried
# StartLimitIntervalSec= in [Service], verify passed, and the rate limiting was never in effect.
# The journal is the only place that says so.
SINCE=$(date '+%Y-%m-%d %H:%M:%S')
systemctl daemon-reload
sleep 0.5
IGNORED=$(journalctl --since "$SINCE" --no-pager 2>/dev/null | grep -F 'Unknown key' | grep -c depsis)
check 'systemd ignored no directive in our units' "${IGNORED:-0}" '0'
[ "${IGNORED:-0}" = 0 ] || journalctl --since "$SINCE" --no-pager | grep -F 'Unknown key' | grep depsis | sort -u | head -5

head1 'install, the way a package would'
id -u depsis-api >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin depsis-api
API_GID=$(id -g depsis-api)
ok "depsis-api exists (uid=$(id -u depsis-api) gid=$API_GID)"

install -d -m 0755 "$PREFIX"
install -m 0755 "$REPO/target/release/depsis-agent" "$PREFIX/depsis-agent"

# A real packaging step, not a copy of the checkout. pnpm's per-package node_modules is a tree of
# symlinks relative to the repository root, so copying `apps/api` alone resolves nothing — measured:
# the service crash-looped on ERR_MODULE_NOT_FOUND for reflect-metadata — and copying the whole
# workspace would ship the sources and still depend on the layout. `pnpm deploy` produces a
# self-contained directory with a flat node_modules, which is what belongs under /usr/local/lib.
rm -rf "$PREFIX/api"
if pnpm --filter @depsis/api deploy --prod --legacy "$PREFIX/api" > "$WORK/deploy.log" 2>&1; then
  ok 'packaged the API with pnpm deploy'
else
  bad 'pnpm deploy failed'
  tail -15 "$WORK/deploy.log"
fi

# `deploy --prod` leaves the WORKSPACE recorded as a production install, so the next pnpm command
# decides node_modules is stale and tries to purge it — which, with no TTY, aborts. Measured: the
# migration step immediately after this failed with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY, and
# the API then would not start because there was no schema. Restoring here keeps the script
# re-runnable, which a proof that can only be run once is not.
pnpm install --frozen-lockfile > "$WORK/restore.log" 2>&1 \
  && ok 'the workspace install was restored after packaging' \
  || { bad 'could not restore the workspace install'; tail -10 "$WORK/restore.log"; }
rm -rf "$PREFIX/api/src" "$PREFIX/api"/*.tsbuildinfo

# `pnpm deploy --legacy` SYMLINKS workspace packages back into the checkout — measured:
#   node_modules/@depsis/agent-protocol -> ../../../../../../../root/ci/packages/agent-protocol
# so the "self-contained" directory is not. It works when run by hand, which is how it would have
# survived review, and fails under the unit because ProtectHome=yes makes /root unreachable. The
# hardening is what exposed the packaging, and without it the deployment would have looked fine
# right up until the checkout was deleted.
for link in "$PREFIX/api/node_modules"/@depsis/*; do
  [ -L "$link" ] || continue
  target=$(readlink -f "$link")
  rm "$link"
  cp -rL "$target" "$link"
done
# The .pnpm store also keeps a link back to the app's OWN package directory. Nothing resolves
# through it at runtime — the service starts without it — but it points at the checkout, so it
# would keep the package tied to a machine it should not need.
rm -f "$PREFIX/api/node_modules/.pnpm/node_modules/@depsis/api"

# Asserted, not assumed: nothing under the packaged tree may point outside it.
ESCAPES=$(find "$PREFIX/api" -type l -printf '%p -> %l\n' 2>/dev/null \
          | awk -v p="$PREFIX/api" '{ cmd = "readlink -f \"" $1 "\""; cmd | getline r; close(cmd);
                                      if (index(r, p) != 1) print }' | head -5)
[ -z "$ESCAPES" ] && ok 'the packaged tree contains no symlink leaving it' \
                  || bad "the package points outside itself: $ESCAPES"

chmod -R a+rX "$PREFIX"
[ -x /usr/bin/node ] || ln -sf "$(command -v node)" /usr/bin/node
ok "installed to $PREFIX"

# The two secrets, root-owned and unreadable by the service user. systemd is what bridges that gap;
# if LoadCredential= is not working, the API cannot read them at all and will say so.
install -d -m 0755 /etc/depsis
DB_URL="postgresql://depsis_app:${DEPSIS_APP_PASSWORD:-ci-app}@127.0.0.1:5432/$DB_NAME"
KEY=$(openssl rand -base64 32)
printf '%s\n' "$DB_URL" > /etc/depsis/db-url
printf '%s\n' "$KEY"    > /etc/depsis/secret.key
chown root:root /etc/depsis/db-url /etc/depsis/secret.key
chmod 0400      /etc/depsis/db-url /etc/depsis/secret.key
printf 'DEPSIS_API_PORT=%s\nNODE_ENV=production\nDEPSIS_AGENT_SOCKET=/run/depsis/agent.sock\nDEPSIS_AGENT_DATA_SOCKET=/run/depsis/agent-data.sock\nDEPSIS_ZFS_POOLS=\n' \
  "$PORT" > /etc/depsis/api.env
printf 'DEPSIS_API_UID=%s\n' "$(id -u depsis-api)" > /etc/depsis/agent.env
printf 'DEPSIS_SHARES_ROOT=%s\n' "$SHARES" >> /etc/depsis/agent.env
install -d -m 0755 "$SHARES" "$SHARES/alice" "$SHARES/alice/.depsis" "$SHARES/alice/.depsis/staging"
chmod 0644 /etc/depsis/api.env /etc/depsis/agent.env

# The service user must NOT be able to read the sources. That is what makes the credential
# mechanism worth measuring rather than assuming.
if setpriv --reuid=depsis-api --regid="$API_GID" --clear-groups cat /etc/depsis/secret.key >/dev/null 2>&1; then
  bad 'the service user can read /etc/depsis/secret.key directly'
else
  ok 'the service user cannot read the key file directly'
fi

head1 'a database for it'
# The roles are CLUSTER-wide and their passwords are not this probe's to inherit.
# tools/ci/migration-check.sh sets a fresh random password on depsis_app and depsis_owner every
# run, which is harmless in a throwaway CI container and breaks every later run on a persistent
# test box — measured: this probe failed with "password authentication failed for user depsis_app"
# after a migration-check run, and nothing in either script said why. Setting what we are about to
# write into /etc/depsis/db-url removes the coupling in the direction that can be fixed here.
psql -qd postgres -c "ALTER ROLE depsis_app   PASSWORD '${DEPSIS_APP_PASSWORD:-ci-app}'"     >/dev/null 2>&1
psql -qd postgres -c "ALTER ROLE depsis_owner PASSWORD '${DEPSIS_OWNER_PASSWORD:-ci-owner}'" >/dev/null 2>&1
psql -qd postgres -c "DROP DATABASE IF EXISTS $DB_NAME" >/dev/null 2>&1
psql -qd postgres -v db_name="$DB_NAME" -f packages/db/bootstrap.sql > "$WORK/boot.log" 2>&1 \
  && ok "$DB_NAME bootstrapped" || { bad 'bootstrap failed'; tail -10 "$WORK/boot.log"; }
DEPSIS_MIGRATION_DATABASE_URL="postgresql://depsis_owner:${DEPSIS_OWNER_PASSWORD:-ci-owner}@127.0.0.1:5432/$DB_NAME" \
  pnpm --filter @depsis/db run migrate:up > "$WORK/migrate.log" 2>&1 \
  && ok 'migrations applied' || { bad 'migrations failed'; tail -10 "$WORK/migrate.log"; }

head1 'the socket unit owns the socket'
systemctl start depsis-agent.socket
sleep 0.5
if [ -S /run/depsis/agent.sock ]; then
  ok 'systemd created /run/depsis/agent.sock'
  # These come from the unit file, not from a chown in a script. That is the difference between
  # "the socket has the right mode" and "the deployment gives it the right mode".
  check 'SocketMode= produced 0660' "$(stat -c '%a' /run/depsis/agent.sock)" '660'
  check 'SocketUser= produced root' "$(stat -c '%U' /run/depsis/agent.sock)" 'root'
  check 'SocketGroup= produced depsis-api' "$(stat -c '%G' /run/depsis/agent.sock)" 'depsis-api'
else
  bad 'no socket after starting depsis-agent.socket'
  journalctl -u depsis-agent.socket -n 15 --no-pager
fi
# Socket activation: the service must NOT be running yet.
check 'the agent is not running before the first connection' \
  "$(systemctl is-active depsis-agent.service 2>&1)" 'inactive'

head1 'two sockets, both guaranteed'
# An earlier version of this section tried to prove the agent refuses to start with only the
# control socket, by starting that socket alone and connecting. It could not: the agent started
# anyway and the check failed. The reason is in depsis-agent.service — `Requires=depsis-agent.socket
# depsis-agent-data.socket` — so triggering the service pulls the data socket in as a dependency,
# and the half-configured state the test described is unreachable through the unit graph.
#
# That is a better outcome than the test assumed, but only if it is measured rather than believed,
# because it is a property of the unit file and one edit away from being untrue. So: connect to the
# control socket with only it started, and assert that systemd brought the OTHER one up.
SINCE=$(date '+%Y-%m-%d %H:%M:%S')
runuser -u depsis-api -- node tools/poc/agent-client.mjs control \
  '{"correlation_id":"p1d-0","reason":"probe","request":{"op":"ping"}}' > "$WORK/one.txt" 2>&1
sleep 1
check 'triggering the service started the data socket too, via Requires=' \
  "$(systemctl is-active depsis-agent-data.socket 2>&1)" 'active'
check 'and the agent came up' "$(systemctl is-active depsis-agent.service 2>&1)" 'active'

# The agent's own fail-closed check, exercised where the unit graph cannot reach: one named
# descriptor, handed over by systemd-socket-activate rather than pid 1. This is the backstop for a
# hand-run daemon or an edited unit, and without running it the refusal is only a unit test.
# `systemd-socket-activate` listens until it is killed, so this is bounded explicitly rather than
# with `wait` — measured the hard way: the first version of this block hung the whole probe.
timeout 10 systemd-socket-activate --fdname=control -l "$WORK/half.sock" \
  --setenv=DEPSIS_API_UID="$(id -u depsis-api)" \
  --setenv=DEPSIS_SHARES_ROOT="$SHARES" \
  "$PREFIX/depsis-agent" --serve > "$WORK/half.log" 2>&1 &
HALF_PID=$!
sleep 1
# As root, not as depsis-api, and the reason is not laziness. systemd-socket-activate creates its
# socket with the invoking umask — 0755 here — and connecting to a Unix socket needs WRITE
# permission on it, so depsis-api could not reach it at all and the EACCES was swallowed by the
# error handler, producing a silent failure shaped like a pass. Identity is irrelevant to what is
# measured here: the agent refuses in `listeners_from_systemd`, before it ever accepts anything.
node -e '
  import("node:net").then(({ default: net }) => {
    const s = net.connect(process.argv[1]);
    s.on("connect", () => s.write("{}\n"));
    s.on("error", () => {});
    setTimeout(() => s.destroy(), 400);
  });
' "$WORK/half.sock" >/dev/null 2>&1
sleep 1
kill "$HALF_PID" 2>/dev/null
pkill -f "$WORK/half.sock" 2>/dev/null
wait "$HALF_PID" 2>/dev/null
if grep -q 'no socket named "data"' "$WORK/half.log" 2>/dev/null; then
  ok 'given only a control descriptor, the agent refuses and names the socket it is missing'
else
  bad "the agent accepted a half-configured descriptor set: $(tail -c 200 "$WORK/half.log" 2>/dev/null)"
fi

if [ -S /run/depsis/agent-data.sock ]; then
  ok 'systemd created /run/depsis/agent-data.sock'
  check 'the data socket is 0660 too' "$(stat -c '%a' /run/depsis/agent-data.sock)" '660'
  check 'the data socket is root:depsis-api' \
    "$(stat -c '%U:%G' /run/depsis/agent-data.sock)" "root:depsis-api"
else
  bad 'no data socket after the service was triggered'
  journalctl -u depsis-agent-data.socket -n 15 --no-pager
fi

# The directive that cost a bisection. RestrictSUIDSGID=yes blocks openat2(2) outright — systemd
# filters the mode argument of file-creating syscalls, and openat2 carries its mode inside a struct
# in userspace memory that seccomp cannot read, so it denies the call. openat2(RESOLVE_BENEATH) is
# the whole containment mechanism for share writes, so the directive turns every upload into a
# "path escapes the share root" error for a path that escapes nothing. Asserted here by name so
# that re-adding it fails loudly rather than at the next upload.
check 'RestrictSUIDSGID is off, because it would disable openat2' \
  "$(systemctl show -p RestrictSUIDSGID --value depsis-agent.service)" 'no'

head1 'each socket speaks its own protocol'
# The by-name mapping, end to end. systemd's descriptor ORDER follows unit load order; if the agent
# read fd 3 as "the control socket" these two answers would be swapped, and the swap is exactly the
# failure that would corrupt a user's file — control JSON appended to a staging file, upload bytes
# parsed as commands.
CONTROL_REPLY=$(runuser -u depsis-api -- node tools/poc/agent-client.mjs control \
  '{"correlation_id":"p1d-1","reason":"probe","request":{"op":"ping"}}' 2>&1)
case "$CONTROL_REPLY" in
  *'"status":"ok"'*) ok 'the control socket answers the control protocol' ;;
  *) bad "the control socket answered: $CONTROL_REPLY" ;;
esac

DATA_REPLY=$(runuser -u depsis-api -- node tools/poc/agent-client.mjs data nosuchtoken 0 x 2>&1)
case "$DATA_REPLY" in
  *'"kind":"refused"'*) ok 'the data socket answers the data protocol' ;;
  *) bad "the data socket answered: $DATA_REPLY" ;;
esac

# What order did systemd ACTUALLY use? Recorded rather than predicted: `remove_var` in the agent
# does not rewrite /proc/PID/environ, which still holds the values it was execve'd with.
AGENTPID=$(systemctl show -p MainPID --value depsis-agent.service)
FDNAMES=$(tr '\0' '\n' < "/proc/$AGENTPID/environ" 2>/dev/null | sed -n 's/^LISTEN_FDNAMES=//p')
if [ -n "$FDNAMES" ]; then
  ok "systemd passed LISTEN_FDNAMES=$FDNAMES (the order is systemd's, the mapping is by name)"
else
  bad 'could not read LISTEN_FDNAMES from the running agent'
fi

head1 'a file travels the whole path'
# OpenTransfer on the control socket, the bytes on the data socket, PublishTransfer on the control
# socket again. This is the first time the two channels have been exercised together against real
# systemd, and the only thing that proves the token survives between two connections.
OPEN=$(runuser -u depsis-api -- node tools/poc/agent-client.mjs control \
  '{"correlation_id":"p1d-2","reason":"P1-D upload probe","request":{"op":"open_transfer","share":"alice","staging_name":"probe.part"}}' 2>&1)
TOKEN=$(printf '%s' "$OPEN" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
if [ -n "$TOKEN" ]; then
  ok 'OpenTransfer returned a token'
else
  bad "OpenTransfer failed: $OPEN"
fi

PAYLOAD='hello world'
if [ -n "$TOKEN" ]; then
  # `data1` writes the preamble and the body in ONE syscall — the ordinary case for any client that
  # pipes a body straight into the socket, and the case that breaks if the preamble reader throws
  # away whatever followed the newline. The failure is silent: the file still ends up the declared
  # length, because the copy loop simply reads further.
  SENT=$(runuser -u depsis-api -- node tools/poc/agent-client.mjs data1 "$TOKEN" 0 "$PAYLOAD" 2>&1)
  case "$SENT" in
    *'"status":"stored"'*) ok 'the data socket stored the chunk' ;;
    *) bad "the upload failed: $SENT" ;;
  esac
  STAGED=$(cat "$SHARES/alice/.depsis/staging/probe.part" 2>/dev/null)
  check 'the staged bytes are the bytes that were sent, head included' "$STAGED" "$PAYLOAD"

  # The uid and gid the file will belong to. depsis-api is standing in for a tenant account here;
  # what matters is that it is NOT root and NOT the agent, so "the uploader can read it back" is a
  # real question rather than a tautology.
  OWNER_UID=$(id -u depsis-api); OWNER_GID=$(id -g depsis-api)
  PUB=$(runuser -u depsis-api -- node tools/poc/agent-client.mjs control \
    "{\"correlation_id\":\"p1d-3\",\"reason\":\"P1-D upload probe\",\"request\":{\"op\":\"publish_transfer\",\"share\":\"alice\",\"staging_name\":\"probe.part\",\"destination\":[\"hello.txt\"],\"expected_bytes\":${#PAYLOAD},\"owner_uid\":$OWNER_UID,\"owner_gid\":$OWNER_GID}}" 2>&1)
  case "$PUB" in
    *'"status":"publish"'*) ok 'PublishTransfer moved it into the share' ;;
    *) bad "publish failed: $PUB" ;;
  esac
  check 'the published file holds the uploaded bytes' \
    "$(cat "$SHARES/alice/hello.txt" 2>/dev/null)" "$PAYLOAD"
  [ -e "$SHARES/alice/.depsis/staging/probe.part" ] \
    && bad 'the staging file is still there after a publish' \
    || ok 'the staging file is gone, because publish renames rather than copies'

  # The gap that used to be asserted here as a known defect. A published file was root-owned at
  # 0600, so the account that uploaded it could not read it back — and the fastest-looking repair
  # would have been to widen the mode, which is the cross-tenant read the threat model exists to
  # prevent. The axis is ownership, and the mode stays closed.
  check 'the published file belongs to the uploader, not to root' \
    "$(stat -c '%U:%G:%a' "$SHARES/alice/hello.txt" 2>/dev/null)" "depsis-api:depsis-api:600"
  # The claim that actually matters, made by reading the file AS that account rather than by
  # reasoning about the mode.
  if runuser -u depsis-api -- cat "$SHARES/alice/hello.txt" >/dev/null 2>&1; then
    ok 'and that account can read it back'
  else
    bad 'the owner still cannot read its own published file'
  fi

  # Refusing root ownership, measured rather than argued: a caller that omits the mapping must be
  # told, not silently handed back the bug the operands were added to fix.
  runuser -u depsis-api -- node tools/poc/agent-client.mjs control \
    '{"correlation_id":"p1d-5","reason":"probe","request":{"op":"open_transfer","share":"alice","staging_name":"asroot.part"}}' > "$WORK/r.json" 2>&1
  RTOK=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$WORK/r.json")
  runuser -u depsis-api -- node tools/poc/agent-client.mjs data1 "$RTOK" 0 'x' >/dev/null 2>&1
  RPUB=$(runuser -u depsis-api -- node tools/poc/agent-client.mjs control \
    '{"correlation_id":"p1d-6","reason":"probe","request":{"op":"publish_transfer","share":"alice","staging_name":"asroot.part","destination":["asroot.txt"],"expected_bytes":1,"owner_uid":0,"owner_gid":0}}' 2>&1)
  case "$RPUB" in
    *'owned by root'*) ok 'publishing a file to root is refused, with a reason that names the fix' ;;
    *) bad "root ownership was not refused: $RPUB" ;;
  esac
  [ -e "$SHARES/alice/asroot.txt" ] \
    && bad 'the refused publish moved the file anyway' \
    || ok 'and the refused publish left the destination untouched'
fi

head1 'abandoned staging files can be reclaimed'
# Until this operation existed the upload path was a dead end: `.depsis/staging` counts against the
# user's refquota, Samba vetoes `/.depsis/` and the API filters the prefix server-side, so an
# abandoned chunk was invisible to the user, undeletable by the user, undeletable by the API — which
# cannot write inside a share at all — and undeletable by the agent. Quota nobody could reclaim.
DOPEN=$(runuser -u depsis-api -- node tools/poc/agent-client.mjs control \
  '{"correlation_id":"p1d-7","reason":"cancelled upload","request":{"op":"open_transfer","share":"alice","staging_name":"junk.part"}}' 2>&1)
DTOK=$(printf '%s' "$DOPEN" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$DTOK" ] && ok 'a transfer to abandon was opened' || bad "could not open one: $DOPEN"
[ -e "$SHARES/alice/.depsis/staging/junk.part" ] \
  && ok 'and its staging file exists' \
  || bad 'no staging file after OpenTransfer'

DISC=$(runuser -u depsis-api -- node tools/poc/agent-client.mjs control \
  '{"correlation_id":"p1d-8","reason":"cancelled upload","request":{"op":"discard_transfer","share":"alice","staging_name":"junk.part"}}' 2>&1)
case "$DISC" in
  *'"status":"discarded"'*'"existed":true'*) ok 'DiscardTransfer removed it' ;;
  *) bad "discard failed: $DISC" ;;
esac
[ -e "$SHARES/alice/.depsis/staging/junk.part" ] \
  && bad 'the staging file survived a discard' \
  || ok 'the file is gone from the filesystem, not just from the registry'

# Retrying must be a success. The sweeper can legitimately have got there first, and a caller that
# has to tell "already clean" apart from a fault will eventually treat one as the other.
AGAIN=$(runuser -u depsis-api -- node tools/poc/agent-client.mjs control \
  '{"correlation_id":"p1d-9","reason":"cancelled upload","request":{"op":"discard_transfer","share":"alice","staging_name":"junk.part"}}' 2>&1)
case "$AGAIN" in
  *'"existed":false'*) ok 'and discarding it again is a success, not an error' ;;
  *) bad "the second discard was not a clean success: $AGAIN" ;;
esac

# The name has to be usable again straight away. If the registry entry outlived the file, every
# cancelled upload would block its own name for TRANSFER_TTL — five minutes — and the interlock
# that produces that would be the first thing someone removed.
REOPEN=$(runuser -u depsis-api -- node tools/poc/agent-client.mjs control \
  '{"correlation_id":"p1d-10","reason":"retry","request":{"op":"open_transfer","share":"alice","staging_name":"junk.part"}}' 2>&1)
case "$REOPEN" in
  *'"token"'*) ok 'the same staging name can be opened again immediately' ;;
  *) bad "the name was still reserved: $REOPEN" ;;
esac
runuser -u depsis-api -- node tools/poc/agent-client.mjs control \
  '{"correlation_id":"p1d-11","reason":"tidy","request":{"op":"discard_transfer","share":"alice","staging_name":"junk.part"}}' >/dev/null 2>&1

head1 'a bad chunk leaves nothing behind'
OPEN2=$(runuser -u depsis-api -- node tools/poc/agent-client.mjs control \
  '{"correlation_id":"p1d-4","reason":"P1-D short-chunk probe","request":{"op":"open_transfer","share":"alice","staging_name":"short.part"}}' 2>&1)
TOKEN2=$(printf '%s' "$OPEN2" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
if [ -n "$TOKEN2" ]; then
  # Declare eleven bytes, send four, and hang up. On a real socket this is what a client that died
  # mid-chunk looks like, and it must not produce a shorter file reported as stored.
  SHORT=$(runuser -u depsis-api -- node -e '
    import("node:net").then(async ({ default: net }) => {
      const s = net.connect("/run/depsis/agent-data.sock");
      await new Promise((r) => s.once("connect", r));
      s.write(JSON.stringify({ token: process.argv[1], offset: 0, length: 11 }) + "\n");
      await new Promise((r) => setTimeout(r, 200));
      s.write("abcd");
      await new Promise((r) => setTimeout(r, 200));
      s.destroy();
    });
  ' "$TOKEN2" 2>&1)
  sleep 1
  SIZE=$(stat -c '%s' "$SHARES/alice/.depsis/staging/short.part" 2>/dev/null)
  check 'a client that dies mid-chunk leaves a zero-length staging file' "${SIZE:-missing}" '0'
fi

head1 'the API, started by systemd'
systemctl start depsis-api.service
for _ in $(seq 1 60); do curl -fsS "$BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
if [ "$(systemctl is-active depsis-api.service)" = active ]; then
  ok 'depsis-api.service is active'
else
  bad 'depsis-api.service did not start'
  journalctl -u depsis-api.service -n 40 --no-pager
fi

MAINPID=$(systemctl show -p MainPID --value depsis-api.service)
[ -n "$MAINPID" ] && [ "$MAINPID" != 0 ] && ok "running as pid $MAINPID" || bad 'no MainPID'

head1 'the credentials arrived, and are not in the environment'
if journalctl -u depsis-api.service --no-pager | grep -q 'TOTP secrets are sealed with the key'; then
  ok 'the API loaded the key through LoadCredential='
else
  bad 'the API did not report loading a key'
  journalctl -u depsis-api.service -n 20 --no-pager | grep -i 'secret\|key' | head -5
fi
if journalctl -u depsis-api.service --no-pager | grep -q "connected as 'depsis_app'"; then
  ok 'the API read its connection string from the credential'
else
  bad 'the API did not connect using the credential'
fi

# §16, and the whole argument in ADR-0016 for using files: a secret in the environment is readable
# by anything running as the same user through /proc, and is inherited by every child.
# Guarded: a dead service reports MainPID 0, and /proc/0 does not exist. Without the guard the read
# fails, ENVIRON is empty, and the three assertions below all PASS by finding nothing — a clean
# report from a service that never started.
if [ -z "${MAINPID:-}" ] || [ "$MAINPID" = 0 ]; then
  bad 'cannot inspect the environment: the service is not running'
  ENVIRON='(service not running)'
else
  ENVIRON=$(tr '\0' '\n' < "/proc/$MAINPID/environ" 2>/dev/null)
  [ -n "$ENVIRON" ] || bad 'the process environment could not be read at all'
fi
if echo "$ENVIRON" | grep -q "^DEPSIS_DATABASE_URL="; then
  bad 'the connection string is in the process environment'
else
  ok 'no connection string in the process environment'
fi
if echo "$ENVIRON" | grep -qF "$KEY" || echo "$ENVIRON" | grep -qF 'ci-app'; then
  bad 'a secret value appears in the process environment'
else
  ok 'no secret value appears in the process environment'
fi
if echo "$ENVIRON" | grep -q '^DEPSIS_SECRET_KEY_FILE=/run/credentials/'; then
  ok 'what reaches the environment is a path under /run/credentials, not a secret'
else
  bad "DEPSIS_SECRET_KEY_FILE does not point into the credentials directory"
fi

CREDS="/run/credentials/depsis-api.service"
if [ -d "$CREDS" ]; then
  ok "the credentials directory exists at $CREDS"
  # The PROPERTY, not a mode. An earlier version asserted 0400 owned by the service user, from
  # documentation rather than measurement. Measured on systemd 257: the file is 0440 root:root
  # inside a 0550 root:root directory, and the service user reaches it through an ACL — the `+` in
  # the mode string is the only visible sign of that without the acl package installed. Asserting a
  # mode would have failed a correct system, and would fail again every time systemd changed how it
  # grants access. What has to be true is who can read it.
  printf '  note: %s %s\n' \
    "$(stat -c 'mode=%a owner=%U group=%G' "$CREDS/secret-key")" \
    "$(ls -l "$CREDS/secret-key" | awk '{ print $1 }')"

  case "$(ls -ld "$CREDS" | awk '{ print $1 }')" in
    *+) ok 'access comes from an ACL, which is why the mode alone looks closed' ;;
    *) bad 'no ACL on the credentials directory, yet the service reads it — mechanism unclear' ;;
  esac

  if setpriv --reuid=depsis-api --regid="$API_GID" --clear-groups \
       cat "$CREDS/secret-key" 2>/dev/null | grep -q .; then
    ok 'the service user can read the credential'
  else
    bad 'the service user cannot read its own credential'
  fi
  if setpriv --reuid=65534 --regid=65534 --clear-groups \
       cat "$CREDS/secret-key" >/dev/null 2>&1; then
    bad 'an unrelated user can read the credential'
  else
    ok 'an unrelated user cannot read the credential'
  fi
else
  bad "no credentials directory at $CREDS"
fi

head1 'the hardening is actually applied'
# Read back from systemd rather than from the file: a misspelled directive is logged and ignored,
# so the only honest check is what the manager says it is enforcing.
for pair in "NoNewPrivileges yes" "ProtectSystem strict" "ProtectHome yes" "PrivateTmp yes"; do
  set -- $pair
  got=$(systemctl show -p "$1" --value depsis-api.service)
  check "$1=$2 is in effect" "$got" "$2"
done
CAPS=$(systemctl show -p CapabilityBoundingSet --value depsis-api.service)
[ "$CAPS" = "" ] && ok 'the capability bounding set is empty' || bad "capabilities remain: $CAPS"

head1 'socket activation, and the pair working'
# The first request that needs the agent is what should start it.
JAR="$WORK/admin.jar"
PW='correct-horse-battery-staple-42'
# -o cat, because the default renderer prefixes every line with a timestamp and hostname, so the
# banner's leading spaces are no longer at the start of the line and the pattern never matches.
TOKEN=$(journalctl -u depsis-api.service -o cat --no-pager | grep -oE '^ {6}[A-Za-z0-9_-]{20,}$' | tail -1 | tr -d ' ')
[ -n "$TOKEN" ] && ok 'the setup token reached the journal' || bad 'no setup token in the journal'

curl -sS -X POST "$BASE/setup/claim" -H 'content-type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"organizationName\":\"P1D\",\"organizationSlug\":\"p1d\",\"adminUsername\":\"admin\",\"adminDisplayName\":\"Admin\",\"adminPassword\":\"$PW\"}" \
  | grep -q '"status":"ok"' && ok 'the box was claimed' || bad 'claim failed'

curl -sS -c "$JAR" -X POST "$BASE/auth/login" -H 'content-type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$PW\"}" \
  | grep -q '"status":"ok"' && ok 'signed in' || bad 'login failed'

CODE=$(curl -sS -b "$JAR" -o "$WORK/telemetry.json" -w '%{http_code}' "$BASE/system/telemetry")
check 'telemetry answers 200 through the systemd-managed pair' "$CODE" '200'

check 'the agent was started by the connection, not by the boot order' \
  "$(systemctl is-active depsis-agent.service)" 'active'

# Enrolment is the path that needs the key, so it is the one that proves the key WORKS rather than
# merely that a file was delivered.
ENROL=$(curl -sS -b "$JAR" -o "$WORK/enrol.json" -w '%{http_code}' -X POST "$BASE/me/mfa/enrolment")
check 'MFA enrolment succeeds, so the delivered key is usable' "$ENROL" '200'

head1 'ACCESS CONTROL — a second account, and what it may not do'
# §20 forbids starting Phase 2 until the previous phase's access-control acceptance tests pass.
# Until migration 0009 that sentence could not even be written: an appliance had exactly one
# account and no way to make another, so there was no unauthorised user to refuse. This section is
# that gate, and every assertion in it is about a REQUEST being refused rather than about a row.
USERS="$BASE/users"
MEMBER_PW='member-correct-horse-battery-42'
MEMBER_JAR="$WORK/member.jar"

MADE=$(curl -sS -b "$JAR" -c "$JAR" -X POST "$USERS" \
  -H 'content-type: application/json' -H "origin: http://127.0.0.1:$PORT" \
  -d "{\"username\":\"uye\",\"password\":\"$MEMBER_PW\"}" 2>&1)
MEMBER_ID=$(printf '%s' "$MADE" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$MEMBER_ID" ] && ok 'an administrator created a second account' || bad "create failed: $MADE"
case "$MADE" in
  *'"role":"member"'*) ok 'and it defaults to member, not to administrator' ;;
  *) bad "the new account is not a member: $MADE" ;;
esac

curl -sS -c "$MEMBER_JAR" -X POST "$BASE/auth/login" -H 'content-type: application/json' \
  -d "{\"username\":\"uye\",\"password\":\"$MEMBER_PW\"}" \
  | grep -q '"status":"ok"' && ok 'the second account can sign in' || bad 'the member could not sign in'

# THE GATE. A signed-in member is authenticated and NOT authorised for administration.
check 'a member is refused the user list (403, not 401 and not 200)' \
  "$(curl -sS -o /dev/null -w '%{http_code}' -b "$MEMBER_JAR" "$USERS")" '403'
check 'a member cannot create an account' \
  "$(curl -sS -o /dev/null -w '%{http_code}' -b "$MEMBER_JAR" -X POST "$USERS" \
     -H 'content-type: application/json' -H "origin: http://127.0.0.1:$PORT" \
     -d '{"username":"x","password":"aaaaaaaaaaaa"}')" '403'
check 'a member cannot promote themselves' \
  "$(curl -sS -o /dev/null -w '%{http_code}' -b "$MEMBER_JAR" -X PATCH "$USERS/$MEMBER_ID" \
     -H 'content-type: application/json' -H "origin: http://127.0.0.1:$PORT" \
     -d '{"role":"admin"}')" '403'
# And the negative control: the same member IS allowed the things a member may do. Without this the
# three refusals above would also pass against an API that refused everything.
check 'but a member may still list files' \
  "$(curl -sS -o /dev/null -w '%{http_code}' -b "$MEMBER_JAR" "$BASE/files")" '200'
check 'and read their own account' \
  "$(curl -sS -o /dev/null -w '%{http_code}' -b "$MEMBER_JAR" "$BASE/me")" '200'

# CSRF. The cookie is SameSite=Lax, and this is the server-side half — measured on a route that
# had none until the check was moved out of auth.controller.ts.
check 'a cross-origin state change is refused' \
  "$(curl -sS -o /dev/null -w '%{http_code}' -b "$JAR" -X POST "$USERS" \
     -H 'content-type: application/json' -H 'origin: http://evil.example' \
     -d '{"username":"csrf","password":"aaaaaaaaaaaa"}')" '403'
check 'and so is one against the MFA route, which used to have no check at all' \
  "$(curl -sS -o /dev/null -w '%{http_code}' -b "$JAR" -X DELETE "$BASE/me/mfa" \
     -H 'content-type: application/json' -H 'origin: http://evil.example' -d '{"password":"x"}')" '403'

head1 'ACCESS CONTROL — the box cannot be locked out of itself'
# Once an organisation has no usable administrator, nothing inside DEPSIS can restore one: creating
# accounts needs an administrator and the claim runs exactly once. The rule is a database trigger
# because two administrators demoting each other concurrently both read "there are two of us".
LAST=$(curl -sS -b "$JAR" -X PATCH "$USERS/$(curl -sS -b "$JAR" "$USERS" | sed -n 's/.*"id":"\([^"]*\)","username":"admin".*/\1/p')" \
  -H 'content-type: application/json' -H "origin: http://127.0.0.1:$PORT" -d '{"role":"member"}' 2>&1)
case "$LAST" in
  *'at least one enabled administrator'*) ok 'the last administrator cannot be demoted' ;;
  *) bad "demoting the last administrator was allowed: $LAST" ;;
esac

ADMIN_ID=$(curl -sS -b "$JAR" "$USERS" | sed -n 's/.*"id":"\([^"]*\)","username":"admin".*/\1/p')
SELF=$(curl -sS -o /dev/null -w '%{http_code}' -b "$JAR" -X PATCH "$USERS/$ADMIN_ID" \
  -H 'content-type: application/json' -H "origin: http://127.0.0.1:$PORT" -d '{"disabled":true}')
check 'an administrator cannot disable their own account' "$SELF" '403'

head1 'ACCESS CONTROL — a password change, and what it revokes'
# A second cookie jar for the SAME member, so "other sessions are revoked" is observed rather than
# asserted from a count the server reported about itself.
SECOND_JAR="$WORK/member2.jar"
curl -sS -c "$SECOND_JAR" -X POST "$BASE/auth/login" -H 'content-type: application/json' \
  -d "{\"username\":\"uye\",\"password\":\"$MEMBER_PW\"}" >/dev/null
check 'the member holds two live sessions' \
  "$(curl -sS -o /dev/null -w '%{http_code}' -b "$SECOND_JAR" "$BASE/me")" '200'

check 'a password change with the wrong current password is refused' \
  "$(curl -sS -o /dev/null -w '%{http_code}' -b "$MEMBER_JAR" -X POST "$BASE/me/password" \
     -H 'content-type: application/json' -H "origin: http://127.0.0.1:$PORT" \
     -d '{"currentPassword":"wrong","newPassword":"new-correct-horse-42"}')" '401'

CHANGED=$(curl -sS -b "$MEMBER_JAR" -X POST "$BASE/me/password" \
  -H 'content-type: application/json' -H "origin: http://127.0.0.1:$PORT" \
  -d "{\"currentPassword\":\"$MEMBER_PW\",\"newPassword\":\"new-correct-horse-42\"}" 2>&1)
case "$CHANGED" in
  *'"status":"ok"'*) ok 'the member changed their own password' ;;
  *) bad "password change failed: $CHANGED" ;;
esac
check 'the OTHER session is dead afterwards' \
  "$(curl -sS -o /dev/null -w '%{http_code}' -b "$SECOND_JAR" "$BASE/me")" '401'
check 'and the session that made the change still works' \
  "$(curl -sS -o /dev/null -w '%{http_code}' -b "$MEMBER_JAR" "$BASE/me")" '200'
check 'the old password no longer signs in' \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/login" -H 'content-type: application/json' \
     -d "{\"username\":\"uye\",\"password\":\"$MEMBER_PW\"}")" '401'

head1 'ACCESS CONTROL — disabling an account ends it now, not at expiry'
curl -sS -b "$JAR" -X PATCH "$USERS/$MEMBER_ID" -H 'content-type: application/json' \
  -H "origin: http://127.0.0.1:$PORT" -d '{"disabled":true}' >/dev/null 2>&1
check 'a disabled account\'"'"'s live session stops working immediately' \
  "$(curl -sS -o /dev/null -w '%{http_code}' -b "$MEMBER_JAR" "$BASE/me")" '401'
check 'and it cannot sign in again' \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/login" -H 'content-type: application/json' \
     -d '{"username":"uye","password":"new-correct-horse-42"}')" '401'

head1 'a file goes in through HTTP and comes back in a listing'
# The API names its default share after the organisation slug. The directory has to exist before
# the agent can resolve into it — there is no mkdir operation in the agent's closed op set yet, so
# the installer's job of laying out the share tree is done here by hand, exactly as it is for the
# 'alice' fixture above. This is the next real gap, and it is named rather than papered over.
ORG_SLUG=p1d
install -d -m 0755 "$SHARES/$ORG_SLUG" "$SHARES/$ORG_SLUG/.depsis" "$SHARES/$ORG_SLUG/.depsis/staging"
install -d -m 0755 "$SHARES/$ORG_SLUG/Belgeler"
# The whole point of the appliance, and the first time it has been possible. Until this section
# existed no HTTP endpoint accepted file bytes at all: the agent could stage and publish, and
# nothing above it could ask.
FILES="$BASE/files"
BODY='DEPSIS ilk dosya. Çağrı Işık.'
# BYTES, not characters. `${#BODY}` counts characters, and the Turkish letters here are two bytes
# each in UTF-8 — declaring the character count made the API refuse the chunk for exceeding the
# length the upload was created with, which is exactly what it should do.
LEN=$(printf '%s' "$BODY" | wc -c)

# A folder first, so the upload lands somewhere a user chose.
MKDIR=$(curl -sS -b "$JAR" -c "$JAR" -X POST "$FILES/folders" \
  -H 'content-type: application/json' -H "origin: http://127.0.0.1:$PORT" \
  -d '{"name":"Belgeler"}' 2>&1)
FOLDER_ID=$(printf '%s' "$MKDIR" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
if [ -n "$FOLDER_ID" ]; then
  ok 'POST /files/folders created a folder'
else
  bad "could not create a folder: $MKDIR"
fi

# tus creation. The metadata header is base64 per the tus spec, filename included, so a name with
# Turkish letters survives a header that is ASCII-only.
META="filename $(printf '%s' 'rapor.txt' | base64 -w0),parentId $(printf '%s' "$FOLDER_ID" | base64 -w0)"
LOCATION=$(curl -sS -D - -o /dev/null -b "$JAR" -c "$JAR" -X POST "$BASE/uploads" \
  -H "origin: http://127.0.0.1:$PORT" \
  -H "upload-length: $LEN" -H "upload-metadata: $META" 2>&1 | tr -d '\r' | sed -n 's/^[Ll]ocation: //p')
UPLOAD_ID=$(basename "$LOCATION")
if [ -n "$UPLOAD_ID" ] && [ "$UPLOAD_ID" != "/" ]; then
  ok "POST /uploads created a session ($UPLOAD_ID)"
else
  bad 'POST /uploads returned no Location'
fi

# The bytes. `--data-binary` with the tus content type; the API must not parse this body.
PATCH_CODE=$(printf '%s' "$BODY" | curl -sS -o /dev/null -w '%{http_code}' -b "$JAR" -c "$JAR" \
  -X PATCH "$BASE/uploads/$UPLOAD_ID" -H "origin: http://127.0.0.1:$PORT" \
  -H 'content-type: application/offset+octet-stream' -H 'upload-offset: 0' \
  --data-binary @- 2>&1)
check 'PATCH /uploads/{id} accepted the chunk' "$PATCH_CODE" '204'

# And the bytes are where a user would look for them — read off the filesystem, not off the API,
# so this cannot pass on a metadata row alone.
# EXACTLY where the user asked for it. The `||` fallback this line used to carry hid a real
# defect: publish ignored the parent folder and put every upload at the share root, and the
# fallback read it from there and called the test passed.
LANDED=$(cat "$SHARES/$ORG_SLUG/Belgeler/rapor.txt" 2>/dev/null)
check 'the bytes are in the share, byte for byte' "$LANDED" "$BODY"

LISTING=$(curl -sS -b "$JAR" -c "$JAR" "$FILES?parentId=$FOLDER_ID" 2>&1)
case "$LISTING" in
  *'"name":"rapor.txt"'*) ok 'GET /files lists the uploaded file' ;;
  *) bad "the listing did not contain it: $LISTING" ;;
esac
case "$LISTING" in
  *"\"size\":$LEN"*) ok 'and reports the size the agent actually stored' ;;
  *) bad "the listed size is wrong: $LISTING" ;;
esac

# The file id, for rename and trash.
FILE_ID=$(printf '%s' "$LISTING" | sed -n 's/.*"id":"\([^"]*\)","parentId".*/\1/p' | head -1)

# ── the bytes come back ───────────────────────────────────────────────────────
# The reverse direction on the data socket. The API cannot read the file itself — it holds no
# descriptor and, once user-to-uid mapping exists, no permission — so a download is the agent
# streaming back over the same socket the upload went out on.
GOT=$(curl -sS -b "$JAR" "$FILES/$FILE_ID/content" 2>&1)
check 'GET /files/{id}/content returns the bytes that were uploaded' "$GOT" "$BODY"

HEADERS=$(curl -sS -D - -o /dev/null -b "$JAR" "$FILES/$FILE_ID/content" 2>&1 | tr -d '\r')
case "$HEADERS" in
  *"Content-Length: $LEN"*) ok 'and a Content-Length equal to the file, in bytes' ;;
  *) bad "Content-Length is wrong: $(printf '%s' "$HEADERS" | grep -i content-length)" ;;
esac
case "$HEADERS" in
  *'Accept-Ranges: bytes'*) ok 'and advertises Range support' ;;
  *) bad 'no Accept-Ranges header' ;;
esac
# `attachment`, not inline. A tenant-supplied HTML file served inline on the API's own origin is a
# stored XSS against every other tenant's session.
case "$HEADERS" in
  *'Content-Disposition: attachment'*) ok 'and serves as an attachment rather than inline' ;;
  *) bad 'the file would render inline on the API origin' ;;
esac
ETAG=$(printf '%s' "$HEADERS" | sed -n 's/^ETag: //p')
[ -n "$ETAG" ] && ok "a strong validator is present ($ETAG)" || bad 'no ETag'

# A range from the middle. The first six bytes of the body are ASCII, so this is byte-exact
# regardless of how the Turkish letters later in the string are encoded.
RANGE_BODY=$(curl -sS -b "$JAR" -H 'range: bytes=0-5' "$FILES/$FILE_ID/content" 2>&1)
check 'a Range request returns exactly that range' "$RANGE_BODY" 'DEPSIS'
RANGE_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -b "$JAR" -H 'range: bytes=0-5' "$FILES/$FILE_ID/content" 2>&1)
check 'and answers 206 rather than 200' "$RANGE_CODE" '206'

# Past the end. Answering 200 with a full body here is how a resumed download silently restarts.
OVER=$(curl -sS -o /dev/null -w '%{http_code}' -b "$JAR" -H "range: bytes=$((LEN + 10))-" "$FILES/$FILE_ID/content" 2>&1)
check 'a range past the end is 416, not a silent full body' "$OVER" '416'

# If-Range with a stale validator must NOT splice: the client holds bytes from the old file, and a
# 206 of the new one produces a file that is corrupt in a way neither side can detect.
STALE=$(curl -sS -o /dev/null -w '%{http_code}' -b "$JAR" \
  -H 'range: bytes=0-5' -H 'if-range: "not-the-etag"' "$FILES/$FILE_ID/content" 2>&1)
check 'If-Range with a stale validator falls back to the whole file' "$STALE" '200'

DL_ANON=$(curl -sS -o /dev/null -w '%{http_code}' "$FILES/$FILE_ID/content" 2>&1)
check 'an unauthenticated caller cannot download' "$DL_ANON" '401'

REN=$(curl -sS -b "$JAR" -c "$JAR" -X PATCH "$FILES/$FILE_ID" \
  -H 'content-type: application/json' -H "origin: http://127.0.0.1:$PORT" \
  -d '{"name":"Çağrı raporu.txt"}' 2>&1)
case "$REN" in
  *'raporu.txt'*) ok 'PATCH /files/{id} renamed it, Turkish letters intact' ;;
  *) bad "rename failed: $REN" ;;
esac

DEL=$(curl -sS -b "$JAR" -c "$JAR" -X DELETE "$FILES/$FILE_ID" \
  -H "origin: http://127.0.0.1:$PORT" 2>&1)
case "$DEL" in
  *'"id"'*) ok 'DELETE /files/{id} moved it to the trash' ;;
  *) bad "trash failed: $DEL" ;;
esac
AFTER=$(curl -sS -b "$JAR" -c "$JAR" "$FILES?parentId=$FOLDER_ID" 2>&1)
case "$AFTER" in
  *rapor*) bad 'a trashed file is still listed' ;;
  *) ok 'and it is gone from the listing' ;;
esac

# Tenant isolation at the HTTP layer, not just in SQL: an anonymous caller must not reach any of it.
ANON=$(curl -sS -o /dev/null -w '%{http_code}' "$FILES" 2>&1)
check 'an unauthenticated caller cannot list files' "$ANON" '401'

head1 'what systemd thinks of the result'
# Recorded, not asserted. The number moves between systemd versions and a threshold here would
# become a thing to game rather than a thing to read.
systemd-analyze security depsis-api.service --no-pager 2>/dev/null | tail -3
systemd-analyze security depsis-agent.service --no-pager 2>/dev/null | tail -3

printf '\n== summary ==\n  passed: %d   failed: %d\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ] || exit 1
