#!/usr/bin/env bash
#
# Bring the whole appliance up on a development box and print how to reach it.
#
# Not a deployment. `deploy/systemd/` is the deployment, and `tools/poc/p1-d-systemd-deployment.sh`
# is what proves it works; this exists so a person can open DEPSIS in a browser and use it, which
# until now required reassembling five commands from three scripts every time.
#
# The API and the static server run as TRANSIENT SYSTEMD UNITS rather than backgrounded shell jobs.
# Measured: a process started from a `wsl.exe` invocation dies with that session however it is
# detached — `nohup`, `setsid` and `disown` all included — because the session, not the shell, is
# what goes away. systemd is pid 1 here and outlives it.
#
#   bash tools/dev/up.sh          bring it up and print the URL
#   bash tools/dev/up.sh --down   stop it again
#
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO" || exit 1

API_PORT="${DEPSIS_DEV_API_PORT:-3100}"
WEB_PORT="${DEPSIS_DEV_WEB_PORT:-3200}"
DB="${DEPSIS_DEV_DB:-depsis_dev}"
ADMIN_USERNAME='admin'
ADMIN_PASSWORD='depsis-dev-parola-42'
ORG_SLUG='depsis'

if [ "${1:-}" = '--down' ]; then
  systemctl stop depsis-dev-api depsis-dev-web 2>/dev/null
  systemctl reset-failed depsis-dev-api depsis-dev-web 2>/dev/null
  echo 'stopped'
  exit 0
fi

command -v systemctl >/dev/null && [ "$(ps -p 1 -o comm=)" = systemd ] || {
  echo 'This needs systemd as pid 1. On WSL, set `systemd=true` in /etc/wsl.conf and `wsl --shutdown`.'
  exit 1
}

export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-ci-postgres}"
psql -qd postgres -c 'SELECT 1' >/dev/null 2>&1 || {
  echo "PostgreSQL is not reachable at $PGHOST:$PGPORT as $PGUSER."
  exit 1
}

echo '→ database'
# The role passwords are CLUSTER-wide and `tools/ci/migration-check.sh` randomises them on every
# run. Setting them here is what stops "it worked yesterday" turning into an authentication failure
# nobody can place.
psql -qd postgres -c "ALTER ROLE depsis_app   PASSWORD 'ci-app'"   >/dev/null
psql -qd postgres -c "ALTER ROLE depsis_owner PASSWORD 'ci-owner'" >/dev/null 2>&1 || true
if ! psql -qd "$DB" -c 'SELECT 1' >/dev/null 2>&1; then
  psql -qd postgres -v db_name="$DB" -f packages/db/bootstrap.sql >/dev/null || exit 1
fi
DEPSIS_MIGRATION_DATABASE_URL="postgresql://depsis_owner:ci-owner@$PGHOST:$PGPORT/$DB" \
  pnpm --filter @depsis/db run migrate:up >/dev/null 2>&1 || {
    echo 'migrations failed'; exit 1;
  }

echo '→ build'
pnpm turbo run build --filter=@depsis/api --filter=@depsis/web >/dev/null 2>&1 || {
  echo 'build failed — run `pnpm turbo run build` to see why'; exit 1;
}

# A share root. There is no agent in this setup, so uploads answer 503 — the tree still lists,
# folders still create, and everything that does not move bytes works.
SHARES="${DEPSIS_DEV_SHARES:-/srv/depsis-dev}"
install -d -m 0755 "$SHARES" 2>/dev/null

echo '→ services'
systemctl stop depsis-dev-api depsis-dev-web 2>/dev/null
systemctl reset-failed depsis-dev-api depsis-dev-web 2>/dev/null
: > /tmp/depsis-dev-api.log
[ -f /tmp/depsis-dev-secret.key ] || head -c 32 /dev/urandom | base64 > /tmp/depsis-dev-secret.key

systemd-run --unit=depsis-dev-api --collect \
  --setenv=DEPSIS_DATABASE_URL="postgresql://depsis_app:ci-app@$PGHOST:$PGPORT/$DB" \
  --setenv=DEPSIS_API_PORT="$API_PORT" \
  --setenv=NODE_ENV=production \
  --setenv=DEPSIS_SECRET_KEY_FILE=/tmp/depsis-dev-secret.key \
  --setenv=DEPSIS_ZFS_POOLS= \
  --working-directory="$REPO" \
  --property=StandardOutput=append:/tmp/depsis-dev-api.log \
  --property=StandardError=append:/tmp/depsis-dev-api.log \
  "$(command -v node)" "$REPO/apps/api/dist/main.js" >/dev/null 2>&1

for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$API_PORT/api/v1/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$API_PORT/api/v1/health" >/dev/null || {
  echo 'the API did not come up:'; tail -20 /tmp/depsis-dev-api.log; exit 1;
}

# A static server for the built bundle that also proxies /api, so the session cookie stays
# same-site. Pointing the browser at two origins would work locally and diverge exactly where it
# matters — SameSite=Lax is what the cookie is issued with.
cat > /tmp/depsis-dev-web.mjs <<JS
import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = '$REPO/apps/web/dist';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    // node:http, NOT fetch. fetch rewrites the Host header from the URL and there is no way to
    // stop it, so the API saw \`Host: 127.0.0.1:$API_PORT\` while the browser had sent
    // \`Origin: http://<vm-ip>:$WEB_PORT\` — and the CSRF check, which compares the two, refused
    // every state change with a 403 that never reached the database. Measured: the browser could
    // not sign in while PowerShell could, because PowerShell sends no Origin header at all.
    //
    // Passing the headers through verbatim also removes the Expect: 100-continue problem that
    // forced the body to be buffered, so this streams again.
    const upstream = httpRequest(
      { host: '127.0.0.1', port: $API_PORT, path: req.url, method: req.method, headers: req.headers },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', (error) => {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(String(error));
    });
    req.pipe(upstream);
    return;
  }

  void (async () => {
    const path = normalize(req.url.split('?')[0]);
    const file = path === '/' ? '/index.html' : path;
    try {
      const body = await readFile(join(ROOT, file));
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      // Any unknown path is the single-page app's problem, not a 404. The hash router makes this
      // rare, but a reload of a deep link must not show the browser's own error page.
      try {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(await readFile(join(ROOT, 'index.html')));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(String(error));
      }
    }
  })();
}).listen($WEB_PORT, '0.0.0.0', () => console.log('web on $WEB_PORT'));
JS

systemd-run --unit=depsis-dev-web --collect \
  --property=StandardOutput=append:/tmp/depsis-dev-web.log \
  --property=StandardError=append:/tmp/depsis-dev-web.log \
  "$(command -v node)" /tmp/depsis-dev-web.mjs >/dev/null 2>&1
sleep 1
curl -fsS "http://127.0.0.1:$WEB_PORT/" >/dev/null || {
  echo 'the web server did not come up:'; tail -10 /tmp/depsis-dev-web.log; exit 1;
}

echo '→ first administrator'
CLAIMED=$(curl -fsS "http://127.0.0.1:$API_PORT/api/v1/setup/status" | grep -o '"setupRequired":[a-z]*')
if [ "$CLAIMED" = '"setupRequired":true' ]; then
  # The one-time token is printed to the log at startup and never stored. Reading it here is
  # exactly what an operator does with `journalctl -u depsis-api`.
  TOKEN=$(grep -oE '^ {6}[A-Za-z0-9_-]{20,}$' /tmp/depsis-dev-api.log | tail -1 | tr -d ' ')
  curl -sS -X POST "http://127.0.0.1:$API_PORT/api/v1/setup/claim" \
    -H 'content-type: application/json' \
    -d "{\"token\":\"$TOKEN\",\"organizationName\":\"DEPSIS\",\"organizationSlug\":\"$ORG_SLUG\",\"adminUsername\":\"$ADMIN_USERNAME\",\"adminDisplayName\":\"Yonetici\",\"adminPassword\":\"$ADMIN_PASSWORD\"}" \
    | grep -q '"status":"ok"' && echo '  claimed' || echo '  claim failed (already set up?)'
else
  echo '  already claimed'
fi

IP=$(hostname -I | awk '{print $1}')
cat <<INFO

  DEPSIS is up.

    http://$IP:$WEB_PORT          (from Windows)
    http://127.0.0.1:$WEB_PORT          (from inside this VM)

    Kullanıcı adı : $ADMIN_USERNAME
    Parola       : $ADMIN_PASSWORD

  Uploads answer 503: there is no privileged agent in this setup, so no bytes can reach a share.
  Everything else — listing, folders, users, telemetry, MFA — works.

  Stop it with:  bash tools/dev/up.sh --down
INFO
