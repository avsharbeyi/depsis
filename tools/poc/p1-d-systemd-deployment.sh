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
PASSED=0
FAILED=0

ok()   { PASSED=$((PASSED + 1)); printf '  ok    %s\n' "$1"; }
bad()  { FAILED=$((FAILED + 1)); printf '  FAIL  %s\n' "$1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }
head1(){ printf '\n== %s ==\n' "$1"; }

cleanup() {
  systemctl stop depsis-api.service depsis-agent.service depsis-agent.socket 2>/dev/null
  systemctl disable depsis-api.service depsis-agent.socket 2>/dev/null
  rm -f /etc/systemd/system/depsis-api.service \
        /etc/systemd/system/depsis-agent.service \
        /etc/systemd/system/depsis-agent.socket
  systemctl daemon-reload 2>/dev/null
  rm -rf "$WORK"
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
cp deploy/systemd/depsis-agent.socket deploy/systemd/depsis-agent.service \
   deploy/systemd/depsis-api.service /etc/systemd/system/
systemctl daemon-reload

# `systemd-analyze verify` resolves every directive and every referenced path. It is the check that
# a unit file has no misspelled directive silently ignored at load — systemd logs those and starts
# the service anyway, so a typo in a hardening line is a protection that is simply absent.
for unit in depsis-agent.socket depsis-agent.service depsis-api.service; do
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
printf 'DEPSIS_API_PORT=%s\nNODE_ENV=production\nDEPSIS_AGENT_SOCKET=/run/depsis/agent.sock\nDEPSIS_ZFS_POOLS=\n' \
  "$PORT" > /etc/depsis/api.env
printf 'DEPSIS_API_UID=%s\n' "$(id -u depsis-api)" > /etc/depsis/agent.env
chmod 0644 /etc/depsis/api.env /etc/depsis/agent.env

# The service user must NOT be able to read the sources. That is what makes the credential
# mechanism worth measuring rather than assuming.
if setpriv --reuid=depsis-api --regid="$API_GID" --clear-groups cat /etc/depsis/secret.key >/dev/null 2>&1; then
  bad 'the service user can read /etc/depsis/secret.key directly'
else
  ok 'the service user cannot read the key file directly'
fi

head1 'a database for it'
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
  -d "{\"token\":\"$TOKEN\",\"organizationName\":\"P1D\",\"organizationSlug\":\"p1d\",\"adminEmail\":\"admin@p1d.test\",\"adminDisplayName\":\"Admin\",\"adminPassword\":\"$PW\"}" \
  | grep -q '"status":"ok"' && ok 'the box was claimed' || bad 'claim failed'

curl -sS -c "$JAR" -X POST "$BASE/auth/login" -H 'content-type: application/json' \
  -d "{\"organizationSlug\":\"p1d\",\"email\":\"admin@p1d.test\",\"password\":\"$PW\"}" \
  | grep -q '"status":"ok"' && ok 'signed in' || bad 'login failed'

CODE=$(curl -sS -b "$JAR" -o "$WORK/telemetry.json" -w '%{http_code}' "$BASE/system/telemetry")
check 'telemetry answers 200 through the systemd-managed pair' "$CODE" '200'

check 'the agent was started by the connection, not by the boot order' \
  "$(systemctl is-active depsis-agent.service)" 'active'

# Enrolment is the path that needs the key, so it is the one that proves the key WORKS rather than
# merely that a file was delivered.
ENROL=$(curl -sS -b "$JAR" -o "$WORK/enrol.json" -w '%{http_code}' -X POST "$BASE/me/mfa/enrolment")
check 'MFA enrolment succeeds, so the delivered key is usable' "$ENROL" '200'

head1 'what systemd thinks of the result'
# Recorded, not asserted. The number moves between systemd versions and a threshold here would
# become a thing to game rather than a thing to read.
systemd-analyze security depsis-api.service --no-pager 2>/dev/null | tail -3
systemd-analyze security depsis-agent.service --no-pager 2>/dev/null | tail -3

printf '\n== summary ==\n  passed: %d   failed: %d\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ] || exit 1
