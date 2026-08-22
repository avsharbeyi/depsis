#!/usr/bin/env bash
#
# Bring up the stack the Playwright suite drives, WITHOUT systemd.
#
# `tools/dev/up.sh` already does this for a person sitting in front of a browser, and it uses
# transient systemd units because a process started from a `wsl.exe` invocation dies with that
# session however it is detached. That reasoning is correct and it is also why up.sh cannot be the
# e2e harness: a GitHub runner has no systemd session to run units in, and `systemd-run` there
# fails at the first step. So this is the same arrangement built out of `setsid`, pid files and
# signals.
#
#   bash tools/dev/e2e-stack.sh                 bring both stacks up, write e2e/.env.stack
#   bash tools/dev/e2e-stack.sh --reset-setup   put the unclaimed stack back to unclaimed
#   bash tools/dev/e2e-stack.sh --down          stop everything
#
# ── TWO STACKS, AND WHY ───────────────────────────────────────────────────────────────────────
#
# The suite has to test two mutually exclusive states of the same appliance: the setup wizard needs
# a box nobody has claimed, and everything else needs a box with an administrator in it. The claim
# is one-time by construction — `claim_system_setup()` refuses a second one and `SetupService`
# burns its in-memory token — so one database cannot be in both states, and the order the tests
# happen to run in must not be what decides which state they find.
#
# Sequencing them (wizard first, everyone else on the account it creates) was the other option and
# was rejected: it makes every later test depend on an earlier test having passed, so one broken
# wizard assertion reports as a whole red suite with no signal about what else works. It also
# cannot survive `--shard`, and it puts a hard order on projects Playwright runs in parallel.
#
# So: two databases, two API processes, two web origins.
#
#   MAIN   depsis_e2e        migrated and CLAIMED, an administrator seeded    :3210
#   SETUP  depsis_setup_e2e  migrated and NEVER claimed                       :3211
#
# The setup token lives only in the API process's memory and is regenerated on every boot, so
# `--reset-setup` rebuilds that database AND restarts that process — which is what makes the wizard
# test runnable twice on one machine instead of passing once and then failing forever.
#
# ── ONE ORIGIN PER STACK ──────────────────────────────────────────────────────────────────────
#
# The browser and the API must be same-origin. The session is a cookie issued `SameSite=Lax`, and
# two origins work locally right up to the point that matters. Each stack therefore gets a static
# server that also proxies /api — and that proxy uses `node:http` and NOT `fetch`, for the reason
# up.sh measured: fetch rewrites the Host header from the URL and there is no way to stop it, so
# the API saw `Host: 127.0.0.1:<api>` while the browser had sent `Origin: http://<host>:<web>`, and
# the CSRF check refused every state change with a 403 that never reached the database.
#
# ── A PRIVILEGED AGENT, WITHOUT SYSTEMD ───────────────────────────────────────────────────────
#
# WHY IT IS HERE. In this product a folder is a database row AND a directory, so with no agent
# `POST /files/folders` answers 503 before anything reaches the database — and rename, move, trash,
# restore and permanent delete all go through `AgentService` as well. An agent-less harness cannot
# put a single row in front of the file-manager tests, so nine of the twelve in e2e/files.spec.ts
# gated themselves out with `test.fixme`: eighteen tests across the two browser projects measuring
# nothing, on the one screen the appliance exists for. That was the largest hole in the suite.
#
# HOW. In production the two sockets are created by depsis-agent.socket and depsis-agent-data.socket
# and the agent adopts them through LISTEN_FDS; it refuses to start any other way, on purpose —
# letting systemd own the socket makes the socket file's DAC the first authorization gate.
# `systemd-socket-activate` speaks exactly that protocol without a service manager: it creates the
# listeners, names them with --fdname, and execs the agent with LISTEN_PID/LISTEN_FDS/LISTEN_FDNAMES
# set. It ships inside the systemd package itself, so it is on the runner image and on every Debian
# box this repository targets. The socket mode the unit files declare (root:depsis-api 0660) has no
# --option here and is applied with chgrp/chmod after the listeners appear.
#
# WHAT IS NOT PRODUCTION, said out loud. The agent runs as whoever ran this script rather than as
# root, so everything it does is bounded by that account's own permissions. That is enough for the
# tree under $RUN/shares, which is all the suite drives; it is NOT enough for the share, ACL and
# ZeroTier operations, and no test here touches those.
#
# THE UID GATE. `Policy { api_uid }` compares SO_PEERCRED against DEPSIS_API_UID and refuses uid 0
# outright — otherwise the root-refusal in `authz` would be unreachable and every root process on
# the box could drive privileged operations. So the API may not run as root. On a GitHub runner it
# does not. In WSL, where this script normally runs as root, set DEPSIS_E2E_API_USER to an ordinary
# account and the API is started as that user.
#
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO" || exit 1

MAIN_API_PORT="${DEPSIS_E2E_API_PORT:-3110}"
MAIN_WEB_PORT="${DEPSIS_E2E_WEB_PORT:-3210}"
SETUP_API_PORT="${DEPSIS_E2E_SETUP_API_PORT:-3111}"
SETUP_WEB_PORT="${DEPSIS_E2E_SETUP_WEB_PORT:-3211}"

MAIN_DB="${DEPSIS_E2E_DB:-depsis_e2e}"
SETUP_DB="${DEPSIS_E2E_SETUP_DB:-depsis_setup_e2e}"

# Ports and database names of their own, deliberately not up.sh's. A developer running the
# appliance to look at it and the suite running against it are two things that should be able to
# happen at the same time, and a suite that wipes the database somebody was demonstrating from is a
# suite people stop running.
ADMIN_USERNAME="${DEPSIS_E2E_ADMIN_USERNAME:-e2eyonetici}"
ADMIN_PASSWORD="${DEPSIS_E2E_ADMIN_PASSWORD:-depsis-e2e-parola-42}"
ORG_SLUG='e2e'
ORG_NAME='DEPSIS E2E'

export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-ci-postgres}"

# The SAME role passwords tools/dev/up.sh and tools/dev/test-db.sh use, and that is deliberate
# rather than lazy: roles are CLUSTER objects, so `depsis_app` has one password for every database
# on the server. A third script picking its own would break the other two every time it ran.
APP_PW="${APP_PW:-ci-app}"
OWNER_PW="${OWNER_PW:-ci-owner}"

RUN="${DEPSIS_E2E_RUN_DIR:-/tmp/depsis-e2e}"
ENV_FILE="$REPO/e2e/.env.stack"
NODE="$(command -v node)"

# The account the API runs as. Empty means "whoever ran this script", which is right everywhere the
# script is not root. See THE UID GATE above for why root is not an option when there is an agent.
API_USER="${DEPSIS_E2E_API_USER:-}"
if [ -n "$API_USER" ]; then
  API_UID="$(id -u "$API_USER")" || {
    echo "DEPSIS_E2E_API_USER is set to '$API_USER', which is not an account on this box"
    exit 1
  }
  API_GID="$(id -g "$API_USER")"
  # `--init-groups` rather than `--regid` alone: the API's supplementary groups are what the socket
  # mode below leans on, and a process with an empty group list would be refused by the kernel
  # before the agent ever saw the connection.
  AS_API=(setpriv --reuid="$API_UID" --regid="$API_GID" --init-groups --)
else
  API_UID="$(id -u)"
  API_GID="$(id -g)"
  AS_API=()
fi

AGENT_SOCKET="$RUN/agent-control.sock"
AGENT_DATA_SOCKET="$RUN/agent-data.sock"
AGENT_BIN="${DEPSIS_E2E_AGENT_BIN:-${CARGO_TARGET_DIR:-$REPO/target}/release/depsis-agent}"

# Why the agent cannot run here, or nothing at all. Printed rather than guessed at: "the file tests
# were skipped" is a fact the reader can already see in the report, and this is the sentence that
# says what to do about it.
agent_blocked_because() {
  if [ "$API_UID" = 0 ]; then
    echo 'the API would run as root and the agent refuses DEPSIS_API_UID=0; set DEPSIS_E2E_API_USER'
    return
  fi
  if ! command -v systemd-socket-activate >/dev/null 2>&1; then
    echo 'systemd-socket-activate is not installed (it ships in the systemd package)'
    return
  fi
  if [ ! -x "$AGENT_BIN" ] && ! command -v cargo >/dev/null 2>&1; then
    echo "no agent binary at $AGENT_BIN and no cargo to build one"
    return
  fi
}

AGENT_WHY="$(agent_blocked_because)"
AGENT_ON=0
[ -z "$AGENT_WHY" ] && AGENT_ON=1

# ── process control ───────────────────────────────────────────────────────────────────────────

# `setsid`, so each service is its own session leader and `kill -- -$pid` reaches anything it
# spawned. Backgrounding alone leaves the API's children in this script's process group, and
# `--down` would then leave a node process holding port 3110 with nothing recording its pid.
start_bg() {
  local name="$1"
  shift
  setsid bash -c 'printf %s "$$" > "$1"; shift; exec "$@"' _ "$RUN/$name.pid" "$@" \
    >>"$RUN/$name.log" 2>&1 </dev/null &
  # Give the wrapper a moment to write the pid file; the health wait below is the real check.
  sleep 0.2
}

stop_bg() {
  local name="$1" pidfile="$RUN/$1.pid" pid
  [ -f "$pidfile" ] || return 0
  pid="$(cat "$pidfile" 2>/dev/null)"
  rm -f "$pidfile"
  case "$pid" in '' | *[!0-9]*) return 0 ;; esac

  kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  for _ in $(seq 1 40); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.25
  done
  # SIGTERM asks; after ten seconds the question has been answered.
  kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
}

wait_health() {
  local port="$1" name="$2"
  # Two minutes, not thirty seconds, and up.sh explains why: Nest maps its routes by importing
  # every module, and doing that from /mnt/c — a Windows filesystem reached over 9p — takes twenty
  # seconds and more on a loaded machine. A budget that expires mid-boot reports a crash that did
  # not happen.
  for _ in $(seq 1 120); do
    curl -fsS "http://127.0.0.1:$port/api/v1/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "the $name API did not come up on $port"
  tail -30 "$RUN/$name-api.log" 2>/dev/null || echo '(its log is empty: it never got as far as printing)'
  return 1
}

# ── --down ────────────────────────────────────────────────────────────────────────────────────

if [ "${1:-}" = '--down' ]; then
  for unit in main-api main-web setup-api setup-web agent; do stop_bg "$unit"; done
  rm -f "$ENV_FILE"
  echo 'stopped'
  exit 0
fi

# ── shared setup ──────────────────────────────────────────────────────────────────────────────

psql -qd postgres -c 'SELECT 1' >/dev/null 2>&1 || {
  echo "PostgreSQL is not reachable at $PGHOST:$PGPORT as $PGUSER."
  exit 1
}

mkdir -p "$RUN" || exit 1

# Cluster-wide, and said out loud because it changes every other database on this cluster whose
# connection strings use these roles. tools/ci/migration-check.sh randomises them on every run, so
# without this "it worked yesterday" turns into an authentication failure nobody can place.
psql -qd postgres -c "ALTER ROLE depsis_owner PASSWORD '$OWNER_PW'" >/dev/null 2>&1 || true
psql -qd postgres -c "ALTER ROLE depsis_app   PASSWORD '$APP_PW'" >/dev/null 2>&1 || true

build_db() {
  local name="$1"
  psql -qd postgres -c "DROP DATABASE IF EXISTS $name WITH (FORCE)" >/dev/null || return 1
  # bootstrap.sql creates the database, the roles and the extensions the schema checks for by name.
  psql -qd postgres -v db_name="$name" -f "$REPO/packages/db/bootstrap.sql" >/dev/null || return 1
  # bootstrap.sql may reset the role passwords, so they are set again after it as well as before.
  psql -qd postgres -c "ALTER ROLE depsis_owner PASSWORD '$OWNER_PW'" >/dev/null
  psql -qd postgres -c "ALTER ROLE depsis_app   PASSWORD '$APP_PW'" >/dev/null
  # Migrated as the OWNER, never as the superuser: a superuser silently bypasses row-level
  # security, so a schema that only works because a superuser created it would pass here and fail
  # on the appliance.
  DEPSIS_MIGRATION_DATABASE_URL="postgresql://depsis_owner:$OWNER_PW@$PGHOST:$PGPORT/$name" \
    pnpm --filter @depsis/db run migrate:up >/dev/null 2>&1 || return 1
}

# Build the agent if there is no binary yet, then hand it its two listening sockets.
#
# `--locked`, matching the `rust` job in CI: a harness that quietly resolved a different dependency
# tree than the one the lockfile pins would be testing a binary nobody else has.
launch_agent() {
  if [ ! -x "$AGENT_BIN" ]; then
    echo '  building depsis-agent'
    if ! (cd "$REPO" && cargo build --locked --release --bin depsis-agent) \
      >"$RUN/agent-build.log" 2>&1; then
      echo 'the agent build failed:'
      tail -40 "$RUN/agent-build.log"
      return 1
    fi
  fi

  # Left-over socket files from a previous run: `systemd-socket-activate` binds the path and a stale
  # inode there is an "Address already in use" that says nothing about what is actually wrong.
  rm -f "$AGENT_SOCKET" "$AGENT_DATA_SOCKET"
  install -d -m 0770 "$RUN/shares" 2>/dev/null

  DEPSIS_API_UID="$API_UID" \
    DEPSIS_SHARES_ROOT="$RUN/shares" \
    start_bg agent systemd-socket-activate \
    -l "$AGENT_SOCKET" --fdname=control \
    -l "$AGENT_DATA_SOCKET" --fdname=data \
    -E DEPSIS_API_UID -E DEPSIS_SHARES_ROOT \
    "$AGENT_BIN" --serve

  for _ in $(seq 1 60); do
    [ -S "$AGENT_SOCKET" ] && [ -S "$AGENT_DATA_SOCKET" ] && break
    sleep 0.25
  done
  if [ ! -S "$AGENT_SOCKET" ] || [ ! -S "$AGENT_DATA_SOCKET" ]; then
    echo 'the agent did not create its sockets'
    tail -30 "$RUN/agent.log" 2>/dev/null || echo '(its log is empty: it never got as far as printing)'
    return 1
  fi

  # depsis-agent.socket declares SocketUser=root, SocketGroup=depsis-api, SocketMode=0660, and that
  # mode is not decoration: connecting to an AF_UNIX socket needs WRITE permission on the file, so
  # the DAC is the gate that refuses every other account on the box before the agent reads a byte.
  # `systemd-socket-activate` has no equivalent option, so the same gate is applied by hand.
  chgrp "$API_GID" "$AGENT_SOCKET" "$AGENT_DATA_SOCKET" 2>/dev/null || true
  chmod 0660 "$AGENT_SOCKET" "$AGENT_DATA_SOCKET" || return 1

  # The default share's own directory, which nothing in this flow would otherwise create.
  #
  # `FilesService.defaultShare` names the share after the organisation slug, and the agent resolves
  # every path as <shares root>/<share>/… On an appliance that directory is made by `create_share`
  # when an administrator sets a share up; the suite never drives that operation, so without this
  # line every folder the file tests create is refused with "the parent folder does not exist" —
  # a 409 the tests have no idea how to read, in place of the 503 they do.
  #
  # `.depsis/staging` with it: that is where an upload's `.part` file lives before it is published,
  # and `open_transfer` seeks it rather than creating the tree on the way.
  install -d -m 0770 "$RUN/shares/$ORG_SLUG/.depsis/staging" || return 1

  # The agent walks the tree with openat2 from this root, so it has to be able to write here even
  # where it is not the account that made the directory.
  chgrp -R "$API_GID" "$RUN/shares" 2>/dev/null || true
  chmod -R 0770 "$RUN/shares"
}

launch_api() {
  local name="$1" port="$2" db="$3"
  : >"$RUN/$name-api.log"
  [ -f "$RUN/secret.key" ] || head -c 32 /dev/urandom | base64 >"$RUN/secret.key"
  install -d -m 0770 "$RUN/shares" 2>/dev/null
  # Readable when the API runs as another account (DEPSIS_E2E_API_USER). It is a throwaway key for
  # one test stack; the alternative is a start-up failure that reads as a configuration bug.
  chmod 0644 "$RUN/secret.key"

  # Only the MAIN stack gets the agent. One shares root cannot honestly serve two APIs whose
  # databases disagree about what is in it, and the wizard specs — the only ones that drive the
  # setup stack — never put a file anywhere.
  if [ "$AGENT_ON" = 1 ] && [ "$name" = main ]; then
    export DEPSIS_AGENT_SOCKET="$AGENT_SOCKET" DEPSIS_AGENT_DATA_SOCKET="$AGENT_DATA_SOCKET"
  else
    unset DEPSIS_AGENT_SOCKET DEPSIS_AGENT_DATA_SOCKET
  fi

  DEPSIS_DATABASE_URL="postgresql://depsis_app:$APP_PW@$PGHOST:$PGPORT/$db" \
    DEPSIS_API_PORT="$port" \
    NODE_ENV=production \
    DEPSIS_SECRET_KEY_FILE="$RUN/secret.key" \
    DEPSIS_SHARES_ROOT="$RUN/shares" \
    DEPSIS_ZFS_POOLS= \
    DEPSIS_SMART_DISKS= \
    HOME="$RUN" \
    start_bg "$name-api" ${AS_API[@]+"${AS_API[@]}"} "$NODE" "$REPO/apps/api/dist/main.js"
}

launch_web() {
  local name="$1" web_port="$2" api_port="$3"
  : >"$RUN/$name-web.log"
  DEPSIS_E2E_WEB_ROOT="$REPO/apps/web/dist" \
    DEPSIS_E2E_WEB_PORT="$web_port" \
    DEPSIS_E2E_UPSTREAM_PORT="$api_port" \
    start_bg "$name-web" "$NODE" "$RUN/static-server.mjs"

  for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:$web_port/" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "the $name web server did not come up on $web_port"
  tail -20 "$RUN/$name-web.log" 2>/dev/null
  return 1
}

# The one-time token is printed to the log at startup and never stored, so reading it out of the
# log is exactly what an operator does with `journalctl -u depsis-api`. The pattern matches the
# indented line SetupService prints inside its banner.
read_setup_token() {
  grep -oE '^ {6}[A-Za-z0-9_-]{20,}$' "$RUN/$1-api.log" | tail -1 | tr -d ' '
}

write_env_file() {
  # Read by e2e/playwright.config.ts. It lands in the repository rather than in $RUN because on a
  # developer box the stack runs inside WSL while Playwright runs from Windows, and the working
  # tree is the one path both of them can see. `.env.*` is already gitignored.
  mkdir -p "$REPO/e2e"
  cat >"$ENV_FILE" <<ENV
# Written by tools/dev/e2e-stack.sh. Generated — do not edit, and do not commit.
DEPSIS_E2E_BASE_URL=http://127.0.0.1:$MAIN_WEB_PORT
DEPSIS_E2E_SETUP_BASE_URL=http://127.0.0.1:$SETUP_WEB_PORT
DEPSIS_E2E_ADMIN_USERNAME=$ADMIN_USERNAME
DEPSIS_E2E_ADMIN_PASSWORD=$ADMIN_PASSWORD
DEPSIS_E2E_ORG_SLUG=$ORG_SLUG
DEPSIS_E2E_SETUP_TOKEN=$1
# Which web bundle is being served, and whether the file tests have an agent to work through.
# Neither is read by the config; both are here so a report can be traced to what produced it.
DEPSIS_E2E_WEB_BUNDLE=${BUNDLE_ID:-unknown}
DEPSIS_E2E_AGENT=${AGENT_ON}
ENV
}

# ── --reset-setup ─────────────────────────────────────────────────────────────────────────────
#
# Puts the unclaimed stack back to unclaimed. Needed because the claim is one-time in two places at
# once: the database row and the token held in the API process's memory. Rebuilding the database
# alone would leave the process convinced setup was already complete.

if [ "${1:-}" = '--reset-setup' ]; then
  stop_bg setup-api
  echo '→ setup database'
  build_db "$SETUP_DB" || {
    echo 'migrations failed for the setup database'
    exit 1
  }
  echo '→ setup API'
  launch_api setup "$SETUP_API_PORT" "$SETUP_DB"
  wait_health "$SETUP_API_PORT" setup || exit 1
  TOKEN="$(read_setup_token setup)"
  [ -n "$TOKEN" ] || {
    echo 'the setup API came up but printed no claim token; is that database already claimed?'
    exit 1
  }
  write_env_file "$TOKEN"
  echo "  unclaimed again at http://127.0.0.1:$SETUP_WEB_PORT"
  exit 0
fi

# ── up ────────────────────────────────────────────────────────────────────────────────────────

for unit in main-api main-web setup-api setup-web agent; do stop_bg "$unit"; done

echo '→ databases'
build_db "$MAIN_DB" || {
  echo 'migrations failed for the main database'
  exit 1
}
build_db "$SETUP_DB" || {
  echo 'migrations failed for the setup database'
  exit 1
}

echo '→ build'
# Captured to a file rather than thrown at /dev/null. On the path where this hard-fails the
# compiler's own error is the only thing that tells the operator what to change, and "run it again
# by hand to see why" is an instruction that costs them a second five-minute build.
if ! pnpm turbo run build --filter=@depsis/api >"$RUN/api-build.log" 2>&1; then
  echo 'the API build failed:'
  tail -40 "$RUN/api-build.log"
  exit 1
fi

# The web bundle MAY fall back to an existing dist, and up.sh explains why it has to be possible:
# `node_modules` here may have been installed from Windows, and vite's bundler ships as a native
# binding, so `vite build` inside the VM dies with "Cannot find native binding" no matter how
# correct the source is. On CI the install is a Linux install and this branch never runs.
#
# But it is OPT-IN, and that is the whole point of the flag. A suite asserting against a bundle
# older than the source measures the wrong product, and the warning that used to be printed here
# scrolled past five minutes above the green tick — a developer who had just changed apps/web/src
# would be told their change worked by a run that never loaded it. Now they have to say so.
if pnpm turbo run build --filter=@depsis/web >"$RUN/web-build.log" 2>&1; then
  :
elif [ -f "$REPO/apps/web/dist/index.html" ] && [ "${DEPSIS_E2E_ALLOW_STALE_BUNDLE:-}" = '1' ]; then
  echo '  ! the web bundle did not rebuild here; serving the existing apps/web/dist'
  echo '    the suite is therefore testing an OLDER interface than apps/web/src says'
  echo '    (DEPSIS_E2E_ALLOW_STALE_BUNDLE=1 asked for this)'
else
  echo 'the web build failed:'
  tail -40 "$RUN/web-build.log"
  if [ -f "$REPO/apps/web/dist/index.html" ]; then
    echo
    echo 'there is a previous bundle in apps/web/dist. To serve it anyway — knowing the suite will'
    echo 'then measure an interface older than apps/web/src — re-run with'
    echo '  DEPSIS_E2E_ALLOW_STALE_BUNDLE=1 bash tools/dev/e2e-stack.sh'
  fi
  exit 1
fi

# Which bundle the suite actually measured, recorded where a failed run can be traced back to it.
# index.html names the hashed asset files, so its digest changes with any change to the source.
BUNDLE_ID="$(
  cd "$REPO/apps/web/dist" 2>/dev/null &&
    printf '%s %s' \
      "$(date -u -r index.html +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)" \
      "$(sha256sum index.html 2>/dev/null | cut -c1-16)"
)"

# The static server, written once and started twice with different ports. Parameterised through
# the environment rather than by interpolating the ports into the source, so that the file on disk
# is the same file both stacks run and a reader can diff it against up.sh's copy.
cat >"$RUN/static-server.mjs" <<'JS'
import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.env.DEPSIS_E2E_WEB_ROOT;
const PORT = Number(process.env.DEPSIS_E2E_WEB_PORT);
const UPSTREAM = Number(process.env.DEPSIS_E2E_UPSTREAM_PORT);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    // node:http, NOT fetch. fetch rewrites the Host header from the URL and there is no way to
    // stop it, so the API sees `Host: 127.0.0.1:<upstream>` while the browser sent
    // `Origin: http://127.0.0.1:<web>` — and the CSRF check, which compares the two, refuses every
    // state change with a 403 that never reaches the database. Measured in tools/dev/up.sh: the
    // browser could not sign in while PowerShell could, because PowerShell sends no Origin at all.
    //
    // Passing the headers through verbatim also keeps Expect: 100-continue working, so uploads
    // stream instead of being buffered.
    const upstream = httpRequest(
      { host: '127.0.0.1', port: UPSTREAM, path: req.url, method: req.method, headers: req.headers },
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
      // Any unknown path is the single-page app's problem, not a 404 — a reload of a deep link
      // must not show the browser's own error page.
      try {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(await readFile(join(ROOT, 'index.html')));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(String(error));
      }
    }
  })();
}).listen(PORT, '127.0.0.1', () => console.log(`web on ${PORT} → api ${UPSTREAM}`));
JS

if [ "$AGENT_ON" = 1 ]; then
  echo '→ storage agent'
  launch_agent || exit 1
elif [ -n "${DEPSIS_E2E_REQUIRE_AGENT:-}" ]; then
  # CI sets this. Without it the agent's absence is a silent loss of eighteen tests behind a green
  # tick, which is the exact shape the report's skip gate exists to refuse.
  echo "the storage agent cannot start here, and DEPSIS_E2E_REQUIRE_AGENT is set:"
  echo "  $AGENT_WHY"
  exit 1
else
  echo "  ! no storage agent: $AGENT_WHY"
  echo '    everything that moves bytes will answer 503, and e2e/files.spec.ts will gate nine of'
  echo '    its twelve tests out with test.fixme. They are reported as skipped, not as passing.'
fi

echo '→ services'
launch_api main "$MAIN_API_PORT" "$MAIN_DB"
launch_api setup "$SETUP_API_PORT" "$SETUP_DB"
wait_health "$MAIN_API_PORT" main || exit 1
wait_health "$SETUP_API_PORT" setup || exit 1

launch_web main "$MAIN_WEB_PORT" "$MAIN_API_PORT" || exit 1
launch_web setup "$SETUP_WEB_PORT" "$SETUP_API_PORT" || exit 1

echo '→ administrator on the main stack'
MAIN_TOKEN="$(read_setup_token main)"
[ -n "$MAIN_TOKEN" ] || {
  echo 'the main API printed no claim token, so there is nobody to sign in as'
  exit 1
}
# Through the WEB origin, not straight at the API. It is one more thing proven before a single test
# runs: if the proxy or the CSRF check is wrong, this claim fails here with a readable message
# instead of surfacing as fourteen sign-in tests that cannot explain themselves.
CLAIM=$(curl -sS -X POST "http://127.0.0.1:$MAIN_WEB_PORT/api/v1/setup/claim" \
  -H 'content-type: application/json' \
  -H "origin: http://127.0.0.1:$MAIN_WEB_PORT" \
  -d "{\"token\":\"$MAIN_TOKEN\",\"organizationName\":\"$ORG_NAME\",\"organizationSlug\":\"$ORG_SLUG\",\"adminUsername\":\"$ADMIN_USERNAME\",\"adminPassword\":\"$ADMIN_PASSWORD\"}")
case "$CLAIM" in
*'"status":"ok"'*) echo '  claimed' ;;
*)
  echo "  the claim was refused: $CLAIM"
  exit 1
  ;;
esac

# ── warm the organisation's default share ─────────────────────────────────────────────────────
#
# This is here because of a race in the product, not as a nicety. `FilesService.defaultShare`
# creates the organisation's share row LAZILY, on the first read that needs one, with a plain
# INSERT and no ON CONFLICT. On a freshly built database the suite's first burst of concurrent
# `GET /files` all find no share, all insert it, and all but one come back 500 —
# `duplicate key value violates unique constraint "shares_name_unique"`. Measured here: four of
# them in one run, surfacing in the browser as "Klasör okunamadı." on the file manager.
#
# One authenticated read before any browser starts means the row already exists and the race has
# nothing left to lose. It does not fix the product — two people opening the file manager at the
# same moment on a new appliance still hit it — and it is not meant to hide it.
if [ "$AGENT_ON" = 1 ]; then
  echo '→ warming the default share'
  JAR="$RUN/warm.cookies"
  rm -f "$JAR"
  curl -sS -c "$JAR" -X POST "http://127.0.0.1:$MAIN_WEB_PORT/api/v1/auth/login" \
    -H 'content-type: application/json' \
    -H "origin: http://127.0.0.1:$MAIN_WEB_PORT" \
    -d "{\"username\":\"$ADMIN_USERNAME\",\"password\":\"$ADMIN_PASSWORD\"}" \
    -o /dev/null || {
    echo '  the warm-up could not sign in'
    exit 1
  }
  WARM="$(curl -sS -b "$JAR" -H "origin: http://127.0.0.1:$MAIN_WEB_PORT" \
    -o /dev/null -w '%{http_code}' "http://127.0.0.1:$MAIN_WEB_PORT/api/v1/files?limit=1")"
  rm -f "$JAR"
  case "$WARM" in
  200) echo '  default share exists' ;;
  *)
    echo "  ! the warming read answered $WARM, so the share may still be created under load"
    echo '    expect "Klasör okunamadı." on the first file-manager tests'
    ;;
  esac
fi

SETUP_TOKEN="$(read_setup_token setup)"
[ -n "$SETUP_TOKEN" ] || {
  echo 'the setup API printed no claim token'
  exit 1
}
write_env_file "$SETUP_TOKEN"

cat <<INFO

  The e2e stack is up.

    main   http://127.0.0.1:$MAIN_WEB_PORT       claimed — $ADMIN_USERNAME / $ADMIN_PASSWORD
    setup  http://127.0.0.1:$SETUP_WEB_PORT       unclaimed, for the wizard

  Playwright reads e2e/.env.stack for both.

    pnpm test:e2e
    bash tools/dev/e2e-stack.sh --reset-setup   before running the wizard test again
    bash tools/dev/e2e-stack.sh --down

  Web bundle: $BUNDLE_ID
  Logs are in $RUN.
INFO

if [ "$AGENT_ON" = 1 ]; then
  echo "  Storage agent on $AGENT_SOCKET, shares under $RUN/shares."
else
  echo '  NO storage agent: anything that moves bytes answers 503.'
fi
echo
