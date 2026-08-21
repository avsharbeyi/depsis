#!/usr/bin/env bash
#
# P1-C — the API and the privileged agent, in the same room.
#
# Everything about this pair had been measured separately. The agent's side is P0-E: SO_PEERCRED,
# the socket's DAC, openat2, the closed operation set. The client's side is apps/api's unit tests,
# which drive a local stream socket and settle framing, ordering and deadlines. Neither answers the
# question this script asks: do the two halves of the trust boundary AGREE — does the envelope the
# TypeScript client writes parse in the Rust binary, does the answer it writes back parse in the
# client, and does the version handshake match?
#
# It then walks the whole chain for real: HTTP -> session guard -> PostgreSQL -> Unix socket -> root
# agent -> response, including the three refusals (401, 403, 503) that are easy to claim and easy to
# get wrong.
#
# WHAT THIS DOES NOT PROVE. There is no ZFS here, so `pool_status` fails at the spawn. That is
# deliberate and useful — it exercises the failure path end to end — but a green run says nothing
# about ZFS behaviour, which stays in P0-A/P0-G on the Debian VM.
#
# Prerequisites: root, systemd-socket-activate, a PostgreSQL 18 the psql environment can reach, a
# built agent binary (cargo build --release --bin depsis-agent) and a built API (pnpm build).
#
#   sudo PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=... bash tools/poc/p1-c-api-agent.sh
#
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO" || exit 1

PORT="${DEPSIS_E2E_PORT:-3999}"
BASE="http://127.0.0.1:$PORT/api/v1"
SOCK="${DEPSIS_E2E_SOCKET:-/run/depsis/agent.sock}"
DB_NAME="${DEPSIS_E2E_DB:-depsis_e2e}"
AGENT_BIN="$REPO/target/release/depsis-agent"
API_MAIN="$REPO/apps/api/dist/main.js"
WORK="$(mktemp -d)"
# Traversable by the unprivileged uid. `mktemp -d` is 0700 and owned by root, so the probe script
# written into it was unreadable by exactly the identity that is supposed to be allowed — five
# assertions failed with a module-loader error that looked nothing like a permission problem.
chmod 0755 "$WORK"
PASSED=0
FAILED=0

ok()   { PASSED=$((PASSED + 1)); printf '  ok    %s\n' "$1"; }
bad()  { FAILED=$((FAILED + 1)); printf '  FAIL  %s\n' "$1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }
head1(){ printf '\n== %s ==\n' "$1"; }

cleanup() {
  pkill -f "$API_MAIN" 2>/dev/null
  pkill -f 'systemd-socket-activate' 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

# ── preconditions, asserted rather than assumed ────────────────────────────────
head1 'preconditions'
[ "$(id -u)" = 0 ] || { echo "must run as root (the agent runs as root)"; exit 2; }
command -v systemd-socket-activate >/dev/null || { echo "systemd-socket-activate is required"; exit 2; }
[ -x "$AGENT_BIN" ] || { echo "no agent binary at $AGENT_BIN — cargo build --release --bin depsis-agent"; exit 2; }
[ -f "$API_MAIN" ]  || { echo "no API build at $API_MAIN — pnpm build"; exit 2; }
psql -qd postgres -c 'SELECT 1' >/dev/null 2>&1 || { echo "psql cannot reach PostgreSQL"; exit 2; }
ok 'root, systemd-socket-activate, agent binary, API build and PostgreSQL are all present'

# ── the API's own uid, which is what SO_PEERCRED will see ──────────────────────
head1 'identities'
id -u depsis-api >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin depsis-api
API_UID=$(id -u depsis-api)
API_GID=$(id -g depsis-api)
# Read, not assumed. `useradd --system` need not give the group the same number as the user, and
# assuming it did produced an EACCES for the one identity that is supposed to be allowed — a
# permission failure that looked exactly like the agent refusing.
[ "$API_UID" -ne 0 ] && ok "depsis-api is uid=$API_UID gid=$API_GID, and is not root" \
                     || bad 'depsis-api resolved to root'

# ── the agent, started the way the unit file starts it ─────────────────────────
head1 'the agent, under socket activation'
install -d -m 0755 "$(dirname "$SOCK")"
rm -f "$SOCK"
pkill -f 'systemd-socket-activate' 2>/dev/null
sleep 0.3

# --setenv, not an environment prefix: systemd-socket-activate does not pass its own environment to
# the process it execs, and the agent refuses to start without DEPSIS_API_UID. It refusing loudly is
# how that mistake was visible at all.
setsid nohup systemd-socket-activate --listen="$SOCK" --setenv=DEPSIS_API_UID="$API_UID" \
  "$AGENT_BIN" --serve > "$WORK/agent.log" 2>&1 < /dev/null &
for _ in $(seq 1 40); do [ -S "$SOCK" ] && break; sleep 0.2; done

# The socket file's permissions are the FIRST gate, checked by the kernel before the agent sees a
# byte. systemd sets these from the unit; here they are set by hand for the same effect.
chown "root:$API_GID" "$SOCK"
chmod 0660 "$SOCK"
[ -S "$SOCK" ] && ok "listening on $SOCK" || bad "no socket at $SOCK"
check 'socket mode is 0660' "$(stat -c '%a' "$SOCK")" '660'
check 'socket group is the API group' "$(stat -c '%g' "$SOCK")" "$API_GID"

# ── the raw protocol, from three different identities ──────────────────────────
cat > "$WORK/probe.mjs" <<'PROBE'
import { createConnection } from 'node:net';
const SOCK = process.argv[2];
function ask(envelope) {
  return new Promise((resolve) => {
    const c = createConnection({ path: SOCK });
    let buf = '';
    const done = (v) => { c.destroy(); resolve(v); };
    const t = setTimeout(() => done('TIMEOUT'), 5000);
    c.on('connect', () => c.write(JSON.stringify(envelope) + '\n'));
    c.on('data', (d) => { buf += d; if (buf.includes('\n')) { clearTimeout(t); done(buf.trim()); } });
    c.on('end', () => { clearTimeout(t); done(buf.trim() === '' ? 'CLOSED' : buf.trim()); });
    c.on('error', (e) => { clearTimeout(t); done('ERROR ' + (e.code ?? e.message)); });
  });
}
const env = (request, reason = 'p1-c probe') => ({ correlation_id: 'p1c', reason, request });
console.log('ping:'    + (await ask(env({ op: 'ping' }))));
console.log('unknown:' + (await ask(env({ op: 'rm_rf_slash' }))));
console.log('extra:'   + (await ask(env({ op: 'ping', extra: 1 }))));
console.log('newline:' + (await ask(env({ op: 'ping' }, 'a' + String.fromCharCode(10) + 'FAKE'))));
process.exit(0);
PROBE
chmod 0644 "$WORK/probe.mjs"
NODE="$(command -v node)"

head1 'the boundary, from three identities'
AS_API=$(setpriv --reuid="$API_UID" --regid="$API_GID" --clear-groups "$NODE" "$WORK/probe.mjs" "$SOCK" 2>&1)
case "$AS_API" in
  *'ping:{"status":"ok","schema_version":1}'*) ok 'the API uid gets a schema v1 handshake' ;;
  *) bad "the API uid did not get a handshake: $(echo "$AS_API" | head -1)" ;;
esac
# The error enumerating the closed set is §2.2 made visible: there is nowhere to put a command.
case "$AS_API" in
  *'unknown:{"status":"refused"'*'expected one of `ping`'*) ok 'an unknown operation is refused, and the refusal names the closed set' ;;
  *) bad 'an unknown operation was not refused as expected' ;;
esac
case "$AS_API" in
  *'extra:{"status":"refused"'*'unknown field'*) ok 'an unknown FIELD is refused (deny_unknown_fields)' ;;
  *) bad 'an unknown field was not refused' ;;
esac
# A newline in `reason` is a log-injection primitive against an append-only audit trail.
case "$AS_API" in
  *'newline:{"status":"failed"'*'control characters'*) ok 'a control character in the audit reason is refused' ;;
  *) bad 'a control character in the reason was not refused' ;;
esac

AS_ROOT=$("$NODE" "$WORK/probe.mjs" "$SOCK" 2>&1)
# Root CAN open the socket — that is the point. The refusal has to come from SO_PEERCRED, not DAC.
case "$AS_ROOT" in
  *'ping:{"status":"refused"'*'root is not the API'*) ok 'root is refused by SO_PEERCRED, not by file permissions' ;;
  *) bad "root was not refused as expected: $(echo "$AS_ROOT" | head -1)" ;;
esac

AS_NOBODY=$(setpriv --reuid=65534 --regid=65534 --clear-groups "$NODE" "$WORK/probe.mjs" "$SOCK" 2>&1)
case "$AS_NOBODY" in
  *'ping:ERROR EACCES'*) ok 'an unrelated uid is stopped by the socket DAC, before the agent sees a byte' ;;
  *) bad "an unrelated uid was not stopped by DAC: $(echo "$AS_NOBODY" | head -1)" ;;
esac

# ── the TypeScript client against the live agent ───────────────────────────────
head1 'AgentService against the live agent'
chmod -R a+rX "$REPO/node_modules" "$REPO/apps" "$REPO/packages" 2>/dev/null
if setpriv --reuid="$API_UID" --regid="$API_GID" --clear-groups \
     env HOME="$WORK" PATH="$(dirname "$NODE"):/usr/bin:/bin" DEPSIS_AGENT_SOCKET="$SOCK" \
     "$NODE" "$REPO/node_modules/vitest/vitest.mjs" run apps/api/src/agent/agent.integration.test.ts \
     > "$WORK/client.log" 2>&1; then
  # The suite skips itself when DEPSIS_AGENT_SOCKET is unset, so "it exited zero" is not the same
  # as "it ran". A gated suite that quietly skips is the one failure mode a green tick cannot show.
  RAN=$(sed -e 's/\x1b\[[0-9;]*m//g' "$WORK/client.log" | grep -oE 'Tests +[0-9]+ passed' | tail -1 | grep -oE '[0-9]+')
  SKIPPED=$(sed -e 's/\x1b\[[0-9;]*m//g' "$WORK/client.log" | grep -cE 'Tests .*skipped')
  if [ "${RAN:-0}" -ge 5 ] && [ "$SKIPPED" -eq 0 ]; then
    ok "agent.integration.test.ts ran $RAN tests against the real agent, none skipped"
  else
    bad "agent.integration.test.ts exited zero having run ${RAN:-0} test(s)"
    tail -20 "$WORK/client.log"
  fi
else
  bad 'agent.integration.test.ts failed against the real agent'
  tail -25 "$WORK/client.log"
fi

# ── the whole chain over HTTP ──────────────────────────────────────────────────
head1 'a database that has never been set up'
psql -qd postgres -c "DROP DATABASE IF EXISTS $DB_NAME" > /dev/null 2>&1
if psql -qd postgres -v db_name="$DB_NAME" -f packages/db/bootstrap.sql > "$WORK/bootstrap.log" 2>&1; then
  ok "$DB_NAME bootstrapped"
else
  bad "bootstrap failed"; tail -15 "$WORK/bootstrap.log"
fi
if DEPSIS_MIGRATION_DATABASE_URL="postgresql://depsis_owner:${DEPSIS_OWNER_PASSWORD:-ci-owner}@127.0.0.1:5432/$DB_NAME" \
     pnpm --filter @depsis/db run migrate:up > "$WORK/migrate.log" 2>&1; then
  ok 'migrations applied'
else
  bad 'migrations failed'; tail -15 "$WORK/migrate.log"
fi

start_api() {
  pkill -f "$API_MAIN" 2>/dev/null
  sleep 0.5
  rm -f "$WORK/api.log"
  setpriv --reuid="$API_UID" --regid="$API_GID" --clear-groups \
    env HOME="$WORK" PATH="$(dirname "$NODE"):/usr/bin:/bin" NODE_ENV=production \
        DEPSIS_API_PORT="$PORT" \
        DEPSIS_DATABASE_URL="postgresql://depsis_app:${DEPSIS_APP_PASSWORD:-ci-app}@127.0.0.1:5432/$DB_NAME" \
        DEPSIS_AGENT_SOCKET="$SOCK" \
        DEPSIS_ZFS_POOLS="$1" \
    setsid nohup "$NODE" "$API_MAIN" > "$WORK/api.log" 2>&1 < /dev/null &
  for _ in $(seq 1 60); do curl -fsS "$BASE/health" >/dev/null 2>&1 && return 0; sleep 0.5; done
  bad 'the API did not come up'; tail -25 "$WORK/api.log"; return 1
}

head1 'the API, running as the uid the agent trusts'
start_api "" || exit 1
grep -q 'agent reachable' "$WORK/api.log" \
  && ok 'the API completed the version handshake at startup' \
  || bad 'no handshake line in the API log'

# §6.3: the first administrator's credentials must never be written in plaintext to a log, a QR code
# or a default config. The TOKEN may be — it is the proof of console access — but nothing else.
TOKEN=$(grep -oE '^ {6}[A-Za-z0-9_-]{20,}$' "$WORK/api.log" | head -1 | tr -d ' ')
[ -n "$TOKEN" ] && ok 'a one-time setup token was printed to the log' || bad 'no setup token in the log'

head1 'setup, sign-in, telemetry'
JAR="$WORK/admin.jar"
PW='correct-horse-battery-staple-42'

curl -sS "$BASE/setup/status" | grep -q '"setupRequired":true' \
  && ok 'setup/status says the box is unclaimed' || bad 'setup/status did not say setupRequired'

CLAIM=$(curl -sS -X POST "$BASE/setup/claim" -H 'content-type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"organizationName\":\"P1C\",\"organizationSlug\":\"p1c\",\"adminEmail\":\"admin@p1c.test\",\"adminDisplayName\":\"Admin\",\"adminPassword\":\"$PW\"}")
echo "$CLAIM" | grep -q '"status":"ok"' && ok 'the box was claimed' || bad "claim said: $CLAIM"

LOGIN=$(curl -sS -c "$JAR" -X POST "$BASE/auth/login" -H 'content-type: application/json' \
  -d "{\"organizationSlug\":\"p1c\",\"email\":\"admin@p1c.test\",\"password\":\"$PW\"}")
echo "$LOGIN" | grep -q '"status":"ok"' && ok 'the administrator signed in' || bad "login said: $LOGIN"

CODE=$(curl -sS -b "$JAR" -o "$WORK/telemetry.json" -w '%{http_code}' "$BASE/system/telemetry")
check 'telemetry answers 200 for the administrator' "$CODE" '200'
if "$NODE" -e '
  const t = require(process.argv[1]);
  const fail = (m) => { console.error(m); process.exit(1); };
  if (!Array.isArray(t.pools) || t.pools.length !== 0) fail("pools should be []");
  if (!(t.memory.totalBytes > 0)) fail("memory.totalBytes");
  if (!(t.memory.usedBytes > 0 && t.memory.usedBytes <= t.memory.totalBytes)) fail("memory.usedBytes");
  if (!Array.isArray(t.cpu.loadAverage) || t.cpu.loadAverage.length !== 3) fail("cpu.loadAverage");
  // Nothing in the operation set reports CPU temperature; a number here would be a mislabelled one.
  if ("temperatureCelsius" in t.cpu) fail("cpu.temperatureCelsius should be absent");
' "$WORK/telemetry.json" 2>"$WORK/body.err"; then
  ok 'the body matches the contract and omits what it cannot measure'
else
  bad "the body is wrong: $(cat "$WORK/body.err")"
fi

head1 'the refusals'
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/system/telemetry")
check 'an anonymous caller gets 401' "$CODE" '401'

# A second user in the same organization, sharing the administrator's hash so the password is known.
# There is no user-management endpoint yet, so the fixture is seeded directly.
psql -qd "$DB_NAME" -c "INSERT INTO public.users (organization_id, email, display_name, password_hash)
                        SELECT organization_id, 'other@p1c.test', 'Other', password_hash
                          FROM public.users WHERE email = 'admin@p1c.test'" > /dev/null 2>&1 \
  && ok 'seeded a non-administrator in the same organization' \
  || bad 'could not seed the second user'
JAR2="$WORK/other.jar"
curl -sS -c "$JAR2" -X POST "$BASE/auth/login" -H 'content-type: application/json' \
  -d "{\"organizationSlug\":\"p1c\",\"email\":\"other@p1c.test\",\"password\":\"$PW\"}" \
  | grep -q '"status":"ok"' && ok 'the non-administrator can sign in' || bad 'the second user could not sign in'
CODE=$(curl -sS -b "$JAR2" -o /dev/null -w '%{http_code}' "$BASE/system/telemetry")
check 'a signed-in non-administrator gets 403' "$CODE" '403'

head1 'a pool the agent cannot report on'
# 503, not 200 with an empty list. "There are no pools" and "we could not find out" are the two
# answers an operator most needs to tell apart, and only one of them means something is wrong now.
start_api "tank" || exit 1
CODE=$(curl -sS -b "$JAR" -o "$WORK/telemetry-503.json" -w '%{http_code}' "$BASE/system/telemetry")
check 'telemetry answers 503 rather than an empty pool list' "$CODE" '503'

head1 'the audit trail'
AUDIT=$(grep -c '"audit":1' "$WORK/agent.log" 2>/dev/null || echo 0)
[ "$AUDIT" -gt 0 ] && ok "$AUDIT audit lines written" || bad 'the agent wrote no audit lines'
# §16: a privileged call must be traceable back to the HTTP request that caused it.
if grep '"operation":"pool_status"' "$WORK/agent.log" | grep -q '"reason":"telemetry for pool tank"'; then
  ok 'the telemetry request reached the agent with its reason intact'
else
  bad 'no pool_status entry carrying the telemetry reason'
fi
if grep '"reason":"telemetry for pool tank"' "$WORK/agent.log" \
     | grep -qE '"correlation_id":"[0-9a-f-]{36}"'; then
  ok 'the privileged call carries the correlation id of the HTTP request'
else
  bad 'the audit entry has no usable correlation id'
fi
# §16 again, the other half: the trail must never contain a password, token or file content.
if grep -qF "$PW" "$WORK/agent.log" || grep -qF "$TOKEN" "$WORK/agent.log"; then
  bad 'a secret reached the agent audit trail'
else
  ok 'no password or setup token appears in the audit trail'
fi

printf '\n== summary ==\n  passed: %d   failed: %d\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ] || exit 1
