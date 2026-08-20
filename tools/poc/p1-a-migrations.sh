#!/usr/bin/env bash
# P1-A — prove ADR-0014: the migration pipeline itself, not the SQL it happens to carry.
#
# Migration 0001 was already applied by hand with `psql` and its RLS behaviour measured. That
# proved the SQL. It proved nothing at all about the thing ADR-0014 actually decided, which is the
# RUNNER: whether node-pg-migrate can execute these files as `depsis_owner`, whether its advisory
# lock really serialises two deploys, and whether a migration that dies halfway leaves a history
# row claiming it succeeded.
#
# That last one is the reason this script exists. A history table that records a partially applied
# migration as complete is the worst failure this pipeline can have: every later deploy skips it,
# the schema is permanently wrong, and nothing ever errors again. It is the Phase 0 signature —
# silent, no message, discovered much later — moved into the deployment path.
#
# The items ADR-0014 lists as unverified:
#   1. depsis_app cannot run DDL after the migration has run through the real runner.
#   2. Two concurrent migration processes serialise on the advisory lock.
#   3. A migration that fails midway is NOT recorded as applied.
#   4. `down` really restores the schema — pg_dump --schema-only diff, not "it exited zero".
#   5. A `public.unaccent(...)`-qualified expression index builds inside a migration session.

POC_ID=p1-a
# shellcheck source=lib/common.sh
. "$(dirname "$(readlink -f "$0")")/lib/common.sh"

require_test_environment

# P1-A touches PostgreSQL only. It creates no ZFS pool, and `require_test_environment` already
# refuses to run if a pool other than the harness's own is present.

DB_SRC="${DEPSIS_DB_SRC:-/home/depsis/db}"
PGPORT_18="${DEPSIS_PGPORT:-5433}"
PGDB="${DEPSIS_PGDB:-depsis_p1a}"
OWNER=depsis_owner
APP=depsis_app

# A scratch directory the migration runner owns, so the test can add and remove migration files
# without touching the repository's own.
WORK=$(mktemp -d /tmp/p1a.XXXXXX)
chmod 0755 "$WORK"

# Two separate things on purpose. `drop_scratch_db` is called at the start of a run to clear a
# leftover from a previous one; `cleanup` is the EXIT trap and additionally removes the working
# directory. Folding them together deleted $WORK on the first line of section 1, which is exactly
# the sort of self-inflicted confusion this harness is supposed to avoid.
drop_scratch_db() {
  _admin_lax "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
              WHERE datname = '$PGDB' AND pid <> pg_backend_pid();"
  _admin_lax "DROP DATABASE IF EXISTS $PGDB;"
}

cleanup() {
  drop_scratch_db
  rm -rf "$WORK"
}

# psql as the cluster superuser. Kept as one helper so every call in this file goes to the same
# cluster on the same port — pointing half the assertions at Debian's stock PG 17 by accident is
# an easy and completely silent way to make this script lie.
_admin()     { runuser -u postgres -- psql -X -q -At -p "$PGPORT_18" -v ON_ERROR_STOP=1 "$@"; }
_admin_lax() { runuser -u postgres -- psql -X -q -At -p "$PGPORT_18" -c "$1" 2>/dev/null || true; }
_db()        { runuser -u postgres -- psql -X -q -At -p "$PGPORT_18" -d "$PGDB" "$@"; }
_db_lax()    { runuser -u postgres -- psql -X -q -At -p "$PGPORT_18" -d "$PGDB" -c "$1" 2>&1 || true; }

trap cleanup EXIT

# ═══════════════════════════════════════════════════════════════════════════════
section '0. Environment'
# ═══════════════════════════════════════════════════════════════════════════════

command -v node >/dev/null 2>&1 || { fail 'node is not installed; the runner cannot be tested'; poc_summary; }
NODE_V=$(node --version)
note "node $NODE_V"

SERVER_V=$(_admin -c 'SHOW server_version' 2>/dev/null || echo missing)
SERVER_NUM=$(_admin -c 'SHOW server_version_num' 2>/dev/null || echo 0)
note "cluster on port $PGPORT_18: $SERVER_V"
if [ "$SERVER_NUM" -ge 180000 ]; then
  pass 'the cluster under test is PostgreSQL 18 or newer (ADR-0013)' "$SERVER_V"
else
  fail "the cluster on port $PGPORT_18 is $SERVER_V, not 18+" \
       'Debian 13 stock is 17 on 5432; the PGDG 18 cluster is usually 5433. Set DEPSIS_PGPORT.'
  poc_summary
fi

[ -f "$DB_SRC/bootstrap.sql" ] || { fail "bootstrap.sql not found under $DB_SRC"; poc_summary; }
[ -d "$DB_SRC/migrations" ]    || { fail "no migrations directory under $DB_SRC"; poc_summary; }

# node-pg-migrate has to be resolvable. Resolved from the repo checkout rather than installed
# globally, so the version under test is the version the ADR pins.
NPM_BIN=""
for candidate in "$DB_SRC/node_modules/.bin/node-pg-migrate" \
                 "$DB_SRC/../../node_modules/.bin/node-pg-migrate" \
                 "$(command -v node-pg-migrate 2>/dev/null)"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] && { NPM_BIN="$candidate"; break; }
done
if [ -z "$NPM_BIN" ]; then
  fail 'node-pg-migrate is not installed' "run pnpm install in the checkout at $DB_SRC"
  poc_summary
fi
note "runner: $NPM_BIN"

# ═══════════════════════════════════════════════════════════════════════════════
section '1. Provision the cluster the way a deployment would'
# ═══════════════════════════════════════════════════════════════════════════════

drop_scratch_db >/dev/null 2>&1
cp "$DB_SRC/bootstrap.sql" "$WORK/bootstrap.sql"
# The SHIPPED file, with the database name passed as a parameter. An earlier version copied it
# and `sed`-ed the name, which meant the file under test was not the file that ships — and the CI
# gate needed the same workaround, which is what prompted making the name a real parameter.
chmod 0644 "$WORK/bootstrap.sql"

assert_cmd 'bootstrap.sql runs as a superuser with a parameterised database name' ok \
  -- runuser -u postgres -- psql -X -q -p "$PGPORT_18" -v ON_ERROR_STOP=1 -v db_name="$PGDB" \
     -f "$WORK/bootstrap.sql"

# The owner needs a password to be reachable over TCP, which is how the runner connects.
OWNER_PW="p1a-$(head -c 12 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9')"
_admin -c "ALTER ROLE $OWNER PASSWORD '$OWNER_PW';" >/dev/null
APP_PW="p1a-$(head -c 12 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9')"
_admin -c "ALTER ROLE $APP PASSWORD '$APP_PW';" >/dev/null

OWNER_URL="postgresql://$OWNER:$OWNER_PW@127.0.0.1:$PGPORT_18/$PGDB"
APP_URL="postgresql://$APP:$APP_PW@127.0.0.1:$PGPORT_18/$PGDB"

# Prove the URL works before blaming the runner for a connection problem.
if PGPASSWORD="$OWNER_PW" psql -X -q -At "$OWNER_URL" -c 'SELECT 1' >/dev/null 2>&1; then
  pass 'depsis_owner can connect over TCP with a password'
else
  fail 'depsis_owner cannot connect over TCP' \
       'check listen_addresses and pg_hba for scram-sha-256 on 127.0.0.1'
  poc_summary
fi

# ═══════════════════════════════════════════════════════════════════════════════
section '2. The runner applies the real migrations'
# ═══════════════════════════════════════════════════════════════════════════════

cp -r "$DB_SRC/migrations" "$WORK/migrations"
cp "$DB_SRC/migrate.config.js" "$WORK/" 2>/dev/null || true
chmod -R a+rX "$WORK"

# Every setting is an explicit CLI flag, exactly as packages/db/package.json passes them.
#
# There is no config file, and that is a measured decision rather than a preference. P1-A's second
# run established two things about node-pg-migrate 9.0.0: the CLI reads a config file only when
# `-f` is given (nothing in the repo passed it, so `migrate.config.js` was inert and the history
# went to the default `pgmigrations` table), and even WITH `-f` it honoured neither
# `migrationsTable` nor `migrationLoaderStrategies` in any file shape tried. A config file the tool
# ignores is worse than none: it is a second, plausible-looking description of behaviour that
# never happens.
#
# The flags are duplicated from package.json rather than shelled out to `npm run`, so that a
# mismatch between the two shows up as a P1-A failure. Section 8 asserts they match.
MIGRATE_FLAGS=(-d DEPSIS_MIGRATION_DATABASE_URL -t depsis_migrations
               --advisory-lock-mode wait --no-single-transaction)

run_migrate() { # direction [extra args...]
  local dir="$1"; shift
  ( cd "$WORK" && DEPSIS_MIGRATION_DATABASE_URL="$OWNER_URL" \
      "$NPM_BIN" "${MIGRATE_FLAGS[@]}" -m "$WORK/migrations" "$dir" "$@" 2>&1 )
}

UP_OUT=$(run_migrate up) && UP_RC=0 || UP_RC=$?
if [ "$UP_RC" -eq 0 ]; then
  pass 'node-pg-migrate applies 0001 as depsis_owner' "$(tail -2 <<<"$UP_OUT" | tr '\n' ' ')"
else
  fail 'node-pg-migrate could not apply 0001' "$UP_OUT"
fi

# The history table has to exist AND be owned by the migration role, not by a superuser: if the
# runner ever creates it while connected as someone else, a later deploy as depsis_owner cannot
# write to it and the failure looks like a permission bug in the schema.
HIST_OWNER=$(_db -c "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname='depsis_migrations'" 2>/dev/null)
assert_eq 'the history table is owned by depsis_owner' "$OWNER" "$HIST_OWNER"

# One row, not two. Two means the pairing loader is not active and `0001_foundation.down.sql` was
# treated as a migration in its own right — which is exactly what P1-A's first run found, before
# migrate.config.js declared migrationLoaderStrategies. The `up` command had run the DOWN file
# first, in alphabetical order.
# Counted, not hard-coded. This asserted '1' while only 0001 existed and then failed the moment a
# second migration was added — a test that breaks on correct changes trains people to edit tests
# without reading them.
EXPECTED_MIGRATIONS=$(ls "$DB_SRC/migrations"/*.sql | wc -l)
APPLIED=$(_db -c "SELECT count(*) FROM depsis_migrations" 2>/dev/null || echo ERR)
assert_eq "all $EXPECTED_MIGRATIONS migration file(s) are recorded as applied"   "$EXPECTED_MIGRATIONS" "$APPLIED"

RECORDED_NAMES=$(_db -c "SELECT string_agg(name, ',' ORDER BY id) FROM depsis_migrations" 2>/dev/null || echo ERR)
case "$RECORDED_NAMES" in
  *.down*|*.up*)
    unexpected 'a .up/.down suffixed file was applied as a migration in its own right' \
               "history contains: $RECORDED_NAMES — the split layout is back, and with it the defect where every deploy runs the previous migration's rollback" ;;
  *)
    pass 'the history names one migration, with no up/down suffix' "$RECORDED_NAMES" ;;
esac

# The layout itself, checked in the repository rather than only in this run's copy: a future
# migration added as a `.up.sql`/`.down.sql` pair would silently reintroduce the defect, because
# the CLI cannot select the loader that pairs them.
SPLIT_FILES=$(ls "$DB_SRC/migrations" | grep -E '\.(up|down)\.sql$' || true)
if [ -z "$SPLIT_FILES" ]; then
  pass 'no migration uses the unsupported .up.sql / .down.sql split layout'
else
  unexpected 'a migration uses the .up.sql / .down.sql split layout' \
             "$SPLIT_FILES — the CLI has no flag to select the pairing loader, so these run as separate forward migrations"
fi

TABLES=$(_db -c "SELECT string_agg(tablename,',' ORDER BY tablename) FROM pg_tables WHERE schemaname='public'" || echo ERR)
assert_contains 'organizations exists' 'organizations' "$TABLES"
assert_contains 'users exists'         'users'         "$TABLES"

# Ownership of the objects themselves. If the migration were ever run by a superuser, these would
# be owned by postgres, FORCE RLS would apply to a role nobody uses, and the owner policies would
# silently protect the wrong principal.
BAD_OWNER=$(_db -c "SELECT string_agg(tablename,',') FROM pg_tables
                    WHERE schemaname='public' AND tableowner <> '$OWNER'" || echo ERR)
if [ -z "$BAD_OWNER" ]; then
  pass 'every table created by the migration is owned by depsis_owner'
else
  fail 'some tables are not owned by depsis_owner' "$BAD_OWNER"
fi

# ═══════════════════════════════════════════════════════════════════════════════
section '3. ADR-0014 item 1 — the app role gained no DDL'
# ═══════════════════════════════════════════════════════════════════════════════

app_sql() { PGPASSWORD="$APP_PW" psql -X -q -At "$APP_URL" -c "$1" 2>&1; }

for ddl in \
  "CREATE TABLE evil (x int)" \
  "ALTER TABLE users ADD COLUMN backdoor text" \
  "DROP TABLE users" \
  "CREATE INDEX evil_idx ON users (email)" \
  "ALTER TABLE users DISABLE ROW LEVEL SECURITY" \
  "CREATE POLICY evil_policy ON users FOR ALL USING (true)" \
  "ALTER TABLE users NO FORCE ROW LEVEL SECURITY" \
  ; do
  OUT=$(app_sql "$ddl" || true)
  if grep -qi 'permission denied\|must be owner\|denied for' <<<"$OUT"; then
    pass "depsis_app refused: ${ddl:0:46}"
  else
    unexpected "depsis_app was NOT refused: $ddl" "$OUT"
  fi
done

# The subtler one: can the app role grant itself something, or read another role's data by
# switching roles? SET ROLE to a role you are not a member of must fail.
OUT=$(app_sql "SET ROLE $OWNER; SELECT 1" || true)
if grep -qi 'permission denied\|must be' <<<"$OUT"; then
  pass 'depsis_app cannot SET ROLE to depsis_owner'
else
  unexpected 'depsis_app escalated to depsis_owner via SET ROLE' "$OUT"
fi

# ═══════════════════════════════════════════════════════════════════════════════
section '4. ADR-0014 item 4 — down really restores the schema'
# ═══════════════════════════════════════════════════════════════════════════════

# "It exited zero" is not the claim. The claim is that the schema returns to what it was, and the
# only honest way to check that is to compare dumps.
BASE_DUMP="$WORK/base.sql"
AFTER_DOWN="$WORK/after-down.sql"

# Baseline is taken by rolling the migration back now, dumping, then re-applying — so the
# comparison is between two states produced the same way rather than between a dump taken before
# the runner ever touched the database and one taken after.
run_migrate down >/dev/null 2>&1
schema_dump() { # target-file
  # PostgreSQL 18's pg_dump wraps its output in `\restrict <random>` / `\unrestrict <random>`
  # markers whose token is generated fresh for every dump. Comparing raw dumps therefore reports a
  # difference on every run regardless of the schema — which is exactly what P1-A's first pass did,
  # producing a FAIL whose entire diff was those two lines. Stripping them leaves a comparison that
  # is about the schema.
  runuser -u postgres -- pg_dump -p "$PGPORT_18" --schema-only --no-owner --no-acl "$PGDB" 2>/dev/null \
    | grep -v -e '^\\restrict ' -e '^\\unrestrict ' > "$1"
}

schema_dump "$BASE_DUMP"
run_migrate up   >/dev/null 2>&1
DOWN_OUT=$(run_migrate down) && DOWN_RC=0 || DOWN_RC=$?
schema_dump "$AFTER_DOWN"

if [ "$DOWN_RC" -eq 0 ]; then
  pass 'node-pg-migrate rolls 0001 back'
else
  fail 'the down migration failed' "$DOWN_OUT"
fi

if diff -q "$BASE_DUMP" "$AFTER_DOWN" >/dev/null 2>&1; then
  pass 'up then down leaves the schema byte-identical to the rolled-back baseline'
else
  fail 'down did NOT restore the schema' \
       "$(diff -u "$BASE_DUMP" "$AFTER_DOWN" 2>/dev/null | head -20 | tr '\n' ' ' || true)"
fi

# `down` with no argument rolls back exactly ONE migration — measured, and the same correction the
# CI gate needed. Asserting zero here only worked while a single migration existed.
REMAINING=$(_db -c "SELECT count(*) FROM depsis_migrations" || echo ERR)
assert_eq 'down rolled back exactly one migration' "$((EXPECTED_MIGRATIONS - 1))" "$REMAINING"

# Re-applying after a rollback must work. A down that leaves a stray object turns the next deploy
# into a duplicate-object error that looks like a bug in the migration rather than in the rollback.
UP2=$(run_migrate up) && UP2_RC=0 || UP2_RC=$?
if [ "$UP2_RC" -eq 0 ]; then
  pass 'the migration re-applies cleanly after a rollback'
else
  fail 're-applying after down failed' "$UP2"
fi

# ═══════════════════════════════════════════════════════════════════════════════
section '5. ADR-0014 item 3 — a migration that dies halfway is not recorded'
# ═══════════════════════════════════════════════════════════════════════════════

# The failure this guards against: a migration whose first statement succeeds and whose second
# fails, recorded as applied. Every later deploy then skips it, and the schema is permanently
# half-built with nothing ever erroring again.
cat > "$WORK/migrations/0002_deliberately_broken.sql" <<'BROKEN'
-- Written by P1-A. The first statement succeeds; the second cannot.
-- Up Migration
CREATE TABLE public.p1a_half_applied (id int PRIMARY KEY);
SELECT 1 / 0;
-- Down Migration
DROP TABLE IF EXISTS public.p1a_half_applied;
BROKEN
chmod a+r "$WORK/migrations/"*.sql

BROKEN_OUT=$(run_migrate up) && BROKEN_RC=0 || BROKEN_RC=$?
if [ "$BROKEN_RC" -ne 0 ]; then
  pass 'the runner exits non-zero on a failing migration' "rc=$BROKEN_RC"
else
  unexpected 'a migration that raises division-by-zero reported success' "$BROKEN_OUT"
fi

RECORDED=$(_db -c "SELECT count(*) FROM depsis_migrations WHERE name LIKE '%deliberately_broken%'" || echo ERR)
if [ "$RECORDED" = "0" ]; then
  pass 'the failed migration is NOT recorded as applied'
else
  unexpected 'a half-applied migration is recorded as applied' \
             'every later deploy will skip it and the schema stays wrong, silently'
fi

# And its partial effect must be gone. node-pg-migrate is configured with singleTransaction=false,
# which controls whether the WHOLE RUN is one transaction — each individual migration should still
# be wrapped. This distinguishes those two.
LEFTOVER=$(_db -c "SELECT count(*) FROM pg_tables WHERE tablename='p1a_half_applied'" || echo ERR)
if [ "$LEFTOVER" = "0" ]; then
  pass 'the failed migration left no partial object behind (per-migration transaction)'
else
  unexpected 'the failed migration left public.p1a_half_applied behind' \
             'a later re-run will hit "relation already exists" and look like a different bug'
fi

rm -f "$WORK/migrations/0002_deliberately_broken.sql"

# ═══════════════════════════════════════════════════════════════════════════════
section '6. ADR-0014 item 2 — two deploys racing serialise on the advisory lock'
# ═══════════════════════════════════════════════════════════════════════════════

# A slow migration gives the race a window wide enough to be real rather than theoretical.
cat > "$WORK/migrations/0003_slow.sql" <<'SLOW'
-- Written by P1-A. Deliberately slow so two concurrent runners genuinely overlap.
-- Up Migration
SELECT pg_sleep(4);
CREATE TABLE public.p1a_race (id int PRIMARY KEY, tag text);
INSERT INTO public.p1a_race VALUES (1, 'once');
-- Down Migration
DROP TABLE IF EXISTS public.p1a_race;
SLOW
chmod a+r "$WORK/migrations/"*.sql

run_migrate up > "$WORK/race-a.log" 2>&1 &
RACE_A=$!
run_migrate up > "$WORK/race-b.log" 2>&1 &
RACE_B=$!
wait $RACE_A && RC_A=0 || RC_A=$?
wait $RACE_B && RC_B=0 || RC_B=$?
note "concurrent runners: rc_a=$RC_A rc_b=$RC_B"

# The decisive assertion is not the exit codes — it is that the migration ran exactly once. Two
# runners both applying it would either duplicate the row or collide on the primary key, and with
# advisoryLockMode 'wait' the second should find nothing left to do.
RACE_ROWS=$(_db -c "SELECT count(*) FROM public.p1a_race" 2>/dev/null || echo missing)
assert_eq 'the raced migration produced exactly one row (it ran exactly once)' '1' "$RACE_ROWS"

RACE_RECORDS=$(_db -c "SELECT count(*) FROM depsis_migrations WHERE name LIKE '%slow%'" || echo ERR)
assert_eq 'the raced migration is recorded exactly once' '1' "$RACE_RECORDS"

if [ "$RC_A" -eq 0 ] && [ "$RC_B" -eq 0 ]; then
  pass 'both concurrent runners exited zero (advisoryLockMode=wait)'
else
  # Not a failure of isolation — the lock still worked if the row count above is 1 — but it means
  # a deploy pipeline with two workers will show a red job, which someone will "fix" by removing
  # the lock. Worth recording loudly.
  warn "one runner exited non-zero: rc_a=$RC_A rc_b=$RC_B"
  note 'concurrent runners did not both exit zero' \
       "$(head -3 "$WORK/race-b.log" | tr '\n' ' ')"
fi

run_migrate down >/dev/null 2>&1
rm -f "$WORK/migrations/0003_slow.sql"

# ═══════════════════════════════════════════════════════════════════════════════
section '7. ADR-0014 item 5 — the qualified unaccent expression index'
# ═══════════════════════════════════════════════════════════════════════════════

# What ADR-0010 §85 actually requires, and what P1-A's earlier pass got wrong.
#
# The first version of this section built an index directly on
# `public.unaccent('public.unaccent'::regdictionary, name)` and failed with "functions in index
# expression must be marked IMMUTABLE". Measured cause: in PostgreSQL 18 BOTH overloads of
# unaccent — `unaccent(text)` and `unaccent(regdictionary, text)` — carry provolatile = 's'. So no
# amount of schema qualification makes either usable in an index expression; the qualification
# solves a different problem.
#
# ADR-0014 cited P0-H as having measured that the UNQUALIFIED form fails during index build
# because search_path is restricted. Re-reading p0-h.tsv, what P0-H actually measured is narrower
# and different: `depsis_norm is declared IMMUTABLE (provolatile=i)` and `an expression index on
# depsis_norm() can be created`. It never built an index on a bare unaccent call. The ADR's
# citation was a misreading and is corrected there.
#
# The working pattern, which is what ADR-0010's search indexes must use: an IMMUTABLE SQL wrapper
# with a fixed search_path, whose body carries the qualification so the dictionary resolves during
# an index build in a session whose search_path is not the author's.
cat > "$WORK/migrations/0004_unaccent_probe.sql" <<'UNACC'
-- Written by P1-A.
-- Up Migration
CREATE TABLE public.p1a_search (id int PRIMARY KEY, name text NOT NULL);

CREATE FUNCTION public.p1a_norm(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $fn$
  SELECT lower(public.unaccent('public.unaccent'::regdictionary, value))
$fn$;

CREATE INDEX p1a_search_name_idx
  ON public.p1a_search
  USING gin (public.p1a_norm(name) public.gin_trgm_ops);
-- Down Migration
DROP INDEX IF EXISTS public.p1a_search_name_idx;
DROP TABLE IF EXISTS public.p1a_search;
DROP FUNCTION IF EXISTS public.p1a_norm(text);
UNACC
chmod a+r "$WORK/migrations/"*.sql

UNACC_OUT=$(run_migrate up) && UNACC_RC=0 || UNACC_RC=$?
if [ "$UNACC_RC" -eq 0 ]; then
  pass 'an IMMUTABLE wrapper around qualified unaccent builds a gin_trgm index in a migration session'
else
  fail 'the wrapper-based unaccent expression index failed to build' "$(tail -6 <<<"$UNACC_OUT")"
fi

# Both overloads are STABLE, so a direct index on either must be refused. If a future PostgreSQL
# marks them IMMUTABLE this turns into an UNEXPECTED and ADR-0010's wrapper requirement can be
# revisited rather than carried forever out of habit.
# provolatile is of type "char", and `text || "char"` is an ambiguous operator — the first version
# of this query errored, VOL became 'ERR', and the assertion below then PASSED because 'ERR' does
# not contain '=i'. A green line for the wrong reason is worse than a red one.
VOL=$(_db -c "SELECT string_agg(p.oid::regprocedure::text || '=' || p.provolatile::text, ' ')
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE p.proname = 'unaccent' AND n.nspname = 'public'" || echo ERR)
note "unaccent volatility: $VOL"
if [ "$VOL" = "ERR" ] || [ -z "$VOL" ]; then
  fail 'could not read unaccent volatility' "$VOL"
elif grep -q '=i' <<<"$VOL"; then
  unexpected 'an unaccent overload is now IMMUTABLE' \
             "$VOL — ADR-0010's IMMUTABLE-wrapper requirement may no longer be necessary"
else
  pass 'both unaccent overloads are STABLE, so the wrapper is load-bearing' "$VOL"
fi

for expr in "public.unaccent('public.unaccent'::regdictionary, name)" "public.unaccent(name)"; do
  OUT=$(_db_lax "CREATE INDEX p1a_direct_idx ON public.p1a_search USING gin ($expr public.gin_trgm_ops);")
  if grep -qi 'must be marked IMMUTABLE' <<<"$OUT"; then
    pass "a direct index on $expr is refused for volatility"
  else
    unexpected "a direct index on $expr was accepted" "$OUT"
  fi
done

run_migrate down >/dev/null 2>&1
rm -f "$WORK/migrations/0004_unaccent_probe.sql"

# ═══════════════════════════════════════════════════════════════════════════════
section '8. The two connection strings really are separate'
# ═══════════════════════════════════════════════════════════════════════════════

# ADR-0014's role split rests on the app never seeing the owner URL, and on the shipped scripts
# actually carrying the settings this test exercises. Both are checked against package.json, since
# there is no longer a config file and the flags are the only place those settings exist.
PKG="$DB_SRC/package.json"
PKG_TEXT=$(cat "$PKG")

assert_contains 'the shipped scripts read DEPSIS_MIGRATION_DATABASE_URL' \
  'DEPSIS_MIGRATION_DATABASE_URL' "$PKG_TEXT"
assert_contains 'the shipped scripts name the depsis_migrations history table' \
  'depsis_migrations' "$PKG_TEXT"
assert_contains 'the shipped scripts request advisory-lock-mode wait' \
  'advisory-lock-mode wait' "$PKG_TEXT"

if grep -q 'DEPSIS_DATABASE_URL' "$PKG"; then
  unexpected 'a migration script references the APPLICATION connection string' \
             'migrations would run as depsis_app, or the app URL would carry owner credentials'
else
  pass 'no migration script references the application connection string'
fi

# A config file would be read only with -f, and P1-A measured that even then the runner ignores
# migrationsTable and migrationLoaderStrategies. One that exists but is not passed is a second,
# plausible-looking description of behaviour that never happens.
if [ -f "$DB_SRC/migrate.config.js" ] && ! grep -q -- '-f\|--config-file' "$PKG"; then
  unexpected 'migrate.config.js exists but no script passes -f, so it is never read' \
             'every option in it is silently replaced by a CLI default'
else
  pass 'there is no unreferenced migration config file'
fi

# With no migration URL set at all the runner must refuse rather than fall back to libpq defaults —
# which on this box would silently connect to the stock PG 17 cluster as the OS user.
NOENV=$( cd "$WORK" && env -u DEPSIS_MIGRATION_DATABASE_URL -u DATABASE_URL -u PGDATABASE \
           "$NPM_BIN" "${MIGRATE_FLAGS[@]}" -m "$WORK/migrations" up 2>&1 ) \
       && NOENV_RC=0 || NOENV_RC=$?
if [ "$NOENV_RC" -ne 0 ]; then
  pass 'the runner refuses to run with no migration URL set' "rc=$NOENV_RC"
else
  unexpected 'the runner ran with no connection string configured' \
             "it fell back to a libpq default: $(tail -2 <<<"$NOENV")"
fi

# ═══════════════════════════════════════════════════════════════════════════════
section '9. Uniqueness keys are visible to an audit, and fold identities correctly'
# ═══════════════════════════════════════════════════════════════════════════════

run_migrate up >/dev/null 2>&1

# ── the audit blind spot ──
#
# P0-C's constraint audit scans pg_constraint WHERE contype IN ('u','x'). A bare
# `CREATE UNIQUE INDEX` produces NO pg_constraint row — measured here — so a future migration
# written in that idiom could add a global unique index and the audit would still report clean,
# while a 23505 naming the index handed one tenant proof that another tenant's value exists.
_db -c "CREATE TABLE public.p1a_audit_probe (a int, b text);
        CREATE UNIQUE INDEX p1a_audit_probe_b_key ON public.p1a_audit_probe (b);" >/dev/null 2>&1
CONSTRAINT_SEES=$(_db -c "SELECT count(*) FROM pg_constraint
                          WHERE conrelid='public.p1a_audit_probe'::regclass AND contype IN ('u','x')" || echo ERR)
INDEX_SEES=$(_db -c "SELECT count(*) FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid
                     WHERE x.indrelid='public.p1a_audit_probe'::regclass AND x.indisunique" || echo ERR)
assert_eq 'a bare unique index is INVISIBLE to a pg_constraint audit' '0' "$CONSTRAINT_SEES"
assert_eq 'the same index IS visible in pg_index'                    '1' "$INDEX_SEES"
_db -c "DROP TABLE public.p1a_audit_probe" >/dev/null 2>&1

# The audit as it must actually be written: every unique or exclusion INDEX, however created, whose
# key omits organization_id, minus an explicit allow-list.
BAD_KEYS=$(_db -c "
  SELECT coalesce(string_agg(i.relname, ', '), '')
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND (x.indisunique OR x.indisexclusion)
     AND pg_get_indexdef(i.oid) NOT LIKE '%organization_id%'
     -- A single-column key on a uuid is not an existence oracle, and that is the actual reason
     -- rather than a naming convention: provoking a collision means presenting a value that already
     -- exists, and a uuid cannot be guessed. Expressed against the COLUMN TYPE, because an earlier
     -- version keyed on the column being called `id` and would have wrongly exempted a
     -- `UNIQUE (external_id)` on a caller-chosen string while wrongly flagging a legitimate
     -- `PRIMARY KEY (user_id)`.
     AND NOT (
       x.indnatts = 1
       AND EXISTS (
         SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = t.oid AND a.attnum = x.indkey[0] AND a.atttypid = 'uuid'::regtype
       )
     )
     -- The named exceptions. Each is argued in the migration that creates it; anything joining
     -- this list needs its own argument, not an analogy to these.
     AND i.relname NOT IN ('organizations_slug_key',
                           'sessions_token_hash_key',
                           'pending_logins_token_hash_key',
                           'depsis_migrations_pkey')
" || echo ERR)
if [ -z "$BAD_KEYS" ]; then
  pass 'every unique/exclusion index either includes organization_id or is on the allow-list'
else
  unexpected "unique index without organization_id: $BAD_KEYS" \
             'a 23505 on this index tells one tenant that another tenant holds the value'
fi

# ── identity folding ──
#
# The measured reason `lower(email)` was not good enough: on the ICU database bootstrap.sql
# creates, lower('İsmail') is i + U+0307 + smail, which is NOT lower('ismail').
ORG=$(_db -c "SET ROLE depsis_owner;
              INSERT INTO organizations (slug,name) VALUES ('p1a','P1A') RETURNING id;" | tail -1)
_db -c "SET ROLE depsis_owner;
        INSERT INTO users (organization_id,email,display_name)
        VALUES ('$ORG','ismail@firma.test','Ismail');" >/dev/null 2>&1

DUP_TR=$(_db_lax "SET ROLE depsis_owner;
                  INSERT INTO users (organization_id,email,display_name)
                  VALUES ('$ORG','İsmail@firma.test','Ismail 2');")
if grep -qi 'duplicate key\|23505' <<<"$DUP_TR"; then
  pass 'the Turkish dotted capital I is folded: İsmail@ collides with ismail@ in one tenant'
else
  unexpected 'İsmail@firma.test was accepted alongside ismail@firma.test' \
             'two accounts, one address, one tenant, no error — the exact failure fold_identity exists to prevent'
fi

DUP_ASCII=$(_db_lax "SET ROLE depsis_owner;
                     INSERT INTO users (organization_id,email,display_name)
                     VALUES ('$ORG','ISMAIL@FIRMA.TEST','Ismail 3');")
if grep -qi 'duplicate key\|23505' <<<"$DUP_ASCII"; then
  pass 'plain ASCII case folding still works'
else
  unexpected 'ISMAIL@FIRMA.TEST was accepted alongside ismail@firma.test' "$DUP_ASCII"
fi

# NFD and NFC spellings of the same address must also collide.
#
# Seed with the precomposed (NFC) form, then attempt the decomposed (NFD) one. The first version
# of this did it the other way round and used the strict `_db` helper for the second insert, so
# when the fold worked and the insert was correctly refused, ON_ERROR_STOP aborted the whole run —
# a passing behaviour presented as a crash.
_db_lax "SET ROLE depsis_owner;
         INSERT INTO users (organization_id,email,display_name)
         VALUES ('$ORG','jose@firma.test','Jose plain');" >/dev/null

_db_lax "SET ROLE depsis_owner;
         INSERT INTO users (organization_id,email,display_name)
         VALUES ('$ORG',U&'jos\00e9@firma.test','Jose NFC');" >/dev/null

DUP_NFD=$(_db_lax "SET ROLE depsis_owner;
                   INSERT INTO users (organization_id,email,display_name)
                   VALUES ('$ORG',U&'jose\0301@firma.test','Jose NFD');")
if grep -qi 'duplicate key\|23505' <<<"$DUP_NFD"; then
  pass 'the decomposed (NFD) spelling collides with the precomposed (NFC) one'
else
  unexpected 'the NFD spelling was accepted alongside the NFC one'              "${DUP_NFD:-no error at all} — two accounts for one address, differing only in Unicode composition"
fi

# And the negative control: folding must NOT merge genuinely different people. P0-H measured that
# the SEARCH normaliser collides Çağrı with Cagri, which is correct for search and fatal here.
DISTINCT=$(_db_lax "SET ROLE depsis_owner;
                    INSERT INTO users (organization_id,email,display_name)
                    VALUES ('$ORG','cagri@firma.test','Cagri'),('$ORG','çağrı@firma.test','Cagri accented');")
if grep -qi 'duplicate key\|23505' <<<"$DISTINCT"; then
  unexpected 'fold_identity merged cagri@ with çağrı@' \
             'accent stripping in an identity key merges two different people into one account'
else
  pass 'fold_identity does NOT strip accents: cagri@ and çağrı@ stay distinct'
fi

# ═══════════════════════════════════════════════════════════════════════════════
section '10. The migration refuses a role that would ignore its policies'
# ═══════════════════════════════════════════════════════════════════════════════

# Finding from the foundation review: bootstrap.sql only creates a role that is absent, so a
# pre-existing depsis_app carrying BYPASSRLS is left as found and every policy becomes decorative.
_admin -c "ALTER ROLE $APP BYPASSRLS;" >/dev/null
# ALL the way back, not one step. With the guard in every migration a single-step rollback would
# still exercise it, but rolling back fully also proves 0001's own inline check still fires.
run_migrate down 0 >/dev/null 2>&1
REFUSED=$(run_migrate up 2>&1) && REFUSED_RC=0 || REFUSED_RC=$?
if [ "$REFUSED_RC" -ne 0 ] && grep -qi 'ignore it\|BYPASSRLS' <<<"$REFUSED"; then
  pass 'the migration refuses to install RLS for a role holding BYPASSRLS'
else
  unexpected 'the migration installed policies onto a BYPASSRLS role' \
             "rc=$REFUSED_RC — the app would read every tenant with no error anywhere"
fi

# bootstrap.sql must repair it unconditionally, not only when creating the role.
runuser -u postgres -- psql -X -q -p "$PGPORT_18" -v ON_ERROR_STOP=1 -v db_name="$PGDB" -f "$WORK/bootstrap.sql" >/dev/null 2>&1
STILL_BYPASS=$(_admin -c "SELECT rolbypassrls FROM pg_roles WHERE rolname='$APP'")
assert_eq 'bootstrap.sql clears BYPASSRLS on an existing role' 'f' "$STILL_BYPASS"

run_migrate up >/dev/null 2>&1 && pass 're-applied after the role was repaired' \
  || fail 'still could not apply after repairing the role'

poc_summary
