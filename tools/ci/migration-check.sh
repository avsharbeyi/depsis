#!/usr/bin/env bash
#
# The migration and tenant-isolation gate that runs on every push.
#
# P1-A proves far more than this, but it needs the Debian VM: ZFS, systemd, the Rust agent. The
# guarantees below need only PostgreSQL 18, so there is no reason for them to be measured once on
# someone's VM and then trusted forever. ADR-0013 says its two RLS bypasses were "made permanent by
# a migration test"; until this file existed that sentence was not true, and a claim in an ADR that
# nothing enforces is exactly what this project treats as a defect.
#
# What is checked here is deliberately the subset that a CI runner can settle honestly:
#
#   * the runner applies the migration, once, under the owner role
#   * no `.up.sql` / `.down.sql` split layout has crept back in
#   * the application role cannot run DDL and cannot write to organizations
#   * a query with no tenant context returns zero rows, not everything
#   * tenants cannot see or write each other's rows
#   * a cross-tenant duplicate email is allowed; a same-tenant one is not, including the Turkish
#     dotted capital I and NFC/NFD spellings
#   * every unique or exclusion index either carries organization_id or is on an explicit list
#   * down really rolls back, and up re-applies afterwards
#
# Everything is asserted against a live server. Nothing here reads a source file and infers.

set -uo pipefail

DB_DIR="${DB_DIR:-packages/db}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE_ADMIN="${PGDATABASE_ADMIN:-postgres}"
DB_NAME="${DB_NAME:-depsis}"

export PGHOST PGPORT PGUSER

pass_count=0
fail_count=0

ok()   { pass_count=$((pass_count + 1)); printf '  ok    %s\n' "$1"; }
bad()  { fail_count=$((fail_count + 1)); printf '  FAIL  %s\n' "$1"; [ -n "${2:-}" ] && printf '        %s\n' "${2:0:400}"; }
step() { printf '\n== %s ==\n' "$1"; }

admin()  { psql -X -q -At -d "$PGDATABASE_ADMIN" -v ON_ERROR_STOP=1 "$@"; }
db()     { psql -X -q -At -d "$DB_NAME" "$@" 2>&1; }
as_app() { PGPASSWORD="$APP_PW" psql -X -q -At "postgresql://depsis_app@$PGHOST:$PGPORT/$DB_NAME" -c "$1" 2>&1; }

# ─── 0. the server must be the one the schema requires ────────────────────────
step 'server'
SERVER_NUM=$(admin -c 'SHOW server_version_num' 2>/dev/null || echo 0)
if [ "${SERVER_NUM:-0}" -ge 180000 ]; then
  ok "PostgreSQL $(admin -c 'SHOW server_version')"
else
  bad "server is not PostgreSQL 18+" "server_version_num=$SERVER_NUM; the schema requires uuidv7()"
  exit 1
fi

# ─── 1. provision ─────────────────────────────────────────────────────────────
step 'bootstrap'
# This script DROPS the database it works on, so it refuses to run against a name that does not
# look disposable. A developer who points it at a real database by copying a command line out of a
# CI log should get a refusal, not a restore from backup.
case "$DB_NAME" in
  *_ci|*_test|depsis_ci) : ;;
  *)
    if [ "${DEPSIS_CI_ALLOW_DROP:-0}" != "1" ]; then
      bad "refusing to drop a database named '$DB_NAME'"           'use a name ending in _ci or _test, or set DEPSIS_CI_ALLOW_DROP=1 if you really mean it'
      exit 1
    fi ;;
esac

admin -c "DROP DATABASE IF EXISTS $DB_NAME" >/dev/null 2>&1
if psql -X -q -d "$PGDATABASE_ADMIN" -v ON_ERROR_STOP=1 -v db_name="$DB_NAME"         -f "$DB_DIR/bootstrap.sql" >/tmp/bootstrap.log 2>&1; then
  ok 'bootstrap.sql applies'
else
  bad 'bootstrap.sql failed' "$(tail -5 /tmp/bootstrap.log)"
  exit 1
fi

OWNER_PW="ci-owner-$RANDOM$RANDOM"
APP_PW="ci-app-$RANDOM$RANDOM"
admin -c "ALTER ROLE depsis_owner PASSWORD '$OWNER_PW'" >/dev/null
admin -c "ALTER ROLE depsis_app   PASSWORD '$APP_PW'"   >/dev/null

# bootstrap.sql must clear BYPASSRLS unconditionally, not only when it creates the role — a
# pre-existing role carrying it would make every policy below decorative while everything reports
# success.
admin -c "ALTER ROLE depsis_app BYPASSRLS" >/dev/null
psql -X -q -d "$PGDATABASE_ADMIN" -v ON_ERROR_STOP=1 -v db_name="$DB_NAME" -f "$DB_DIR/bootstrap.sql" >/dev/null 2>&1
if [ "$(admin -c "SELECT rolbypassrls FROM pg_roles WHERE rolname='depsis_app'")" = "f" ]; then
  ok 'bootstrap.sql clears BYPASSRLS on an already-existing role'
else
  bad 'depsis_app still holds BYPASSRLS after bootstrap' 'every policy in the migration is decorative'
fi

# The locale provider is asserted, not configured. Everything in the folding section below depends
# on it: under libc, lower('İ') is plain 'i' and the Turkish assertions would pass for the wrong
# reason, hiding the very bug fold_identity exists to prevent on the ICU database the product runs.
# `datlocprovider` is of type "char", and `"char" || text` is an ambiguous operator — without the
# cast the query errors, PROVIDER comes back empty, and the check reports a confusing failure.
PROVIDER=$(admin -c "SELECT datlocprovider::text || ':' || coalesce(datlocale,'') FROM pg_database WHERE datname='$DB_NAME'")
case "$PROVIDER" in
  i:*) ok "the database uses the ICU locale provider ($PROVIDER)" ;;
  *)   bad "the database is not ICU ($PROVIDER)"            'the Turkish folding assertions below would pass for the wrong reason' ;;
esac

export DEPSIS_MIGRATION_DATABASE_URL="postgresql://depsis_owner:$OWNER_PW@$PGHOST:$PGPORT/$DB_NAME"

# ─── 2. the layout, before anything is run ────────────────────────────────────
step 'migration layout'
SPLIT=$(find "$DB_DIR/migrations" -name '*.up.sql' -o -name '*.down.sql' 2>/dev/null)
if [ -z "$SPLIT" ]; then
  ok 'no migration uses the .up.sql / .down.sql split layout'
else
  bad 'a migration uses the split layout' \
      "$SPLIT — the CLI cannot select the loader that pairs them, so these run as separate forward migrations and every deploy applies the previous rollback"
fi

if [ -f "$DB_DIR/migrate.config.js" ] && ! grep -q -- '-f\|--config-file' "$DB_DIR/package.json"; then
  bad 'migrate.config.js exists but no script passes -f' 'it is never read; every option in it is silently a CLI default'
else
  ok 'no unreferenced migration config file'
fi

# ─── 3. apply ─────────────────────────────────────────────────────────────────
step 'migrate up'
if ( cd "$DB_DIR" && npm run --silent migrate:up ) >/tmp/up.log 2>&1; then
  ok 'the shipped migrate:up script applies the migrations'
else
  bad 'migrate:up failed' "$(tail -8 /tmp/up.log)"
  exit 1
fi

HIST=$(db -c "SELECT string_agg(name, ',' ORDER BY id) FROM depsis_migrations")
case "$HIST" in
  *ERROR*)  bad 'the history table depsis_migrations does not exist' "$HIST" ;;
  *.up*|*.down*) bad 'a suffixed file was applied as a migration in its own right' "$HIST" ;;
  *)        ok "history: $HIST" ;;
esac

# ─── 4. the application role has no DDL ───────────────────────────────────────
step 'app role privileges'
while IFS= read -r ddl; do
  [ -z "$ddl" ] && continue
  OUT=$(as_app "$ddl")
  if grep -qi 'permission denied\|must be owner' <<<"$OUT"; then
    ok "refused: ${ddl:0:52}"
  else
    bad "NOT refused: $ddl" "$OUT"
  fi
done <<'DDL'
CREATE TABLE evil (x int)
ALTER TABLE users ADD COLUMN backdoor text
DROP TABLE users
ALTER TABLE users DISABLE ROW LEVEL SECURITY
ALTER TABLE users NO FORCE ROW LEVEL SECURITY
CREATE POLICY evil ON users FOR ALL USING (true)
INSERT INTO organizations (slug, name) VALUES ('evil', 'Evil')
DDL

# ─── 5. tenant isolation ──────────────────────────────────────────────────────
step 'tenant isolation'
db -c "SET ROLE depsis_owner;
       INSERT INTO organizations (slug,name) VALUES ('acme','Acme'),('globex','Globex');" >/dev/null
A=$(db -c "SELECT id FROM organizations WHERE slug='acme'")
B=$(db -c "SELECT id FROM organizations WHERE slug='globex'")
db -c "SET ROLE depsis_owner;
       INSERT INTO users (organization_id,email,display_name)
       VALUES ('$A','ada@acme.test','Ada'),('$B','bob@globex.test','Bob');" >/dev/null

NOCTX=$(as_app "SELECT count(*) FROM users")
[ "$NOCTX" = "0" ] && ok 'no tenant context returns zero rows (fail-closed)' \
                   || bad 'a query with no tenant context returned rows' "count=$NOCTX"

SEEN_A=$(as_app "BEGIN; SET LOCAL depsis.organization_id='$A'; SELECT string_agg(email,',') FROM users; COMMIT;")
[ "$SEEN_A" = "ada@acme.test" ] && ok 'tenant A sees only its own user' \
                                || bad 'tenant A saw the wrong set' "$SEEN_A"

SEEN_B=$(as_app "BEGIN; SET LOCAL depsis.organization_id='$B'; SELECT string_agg(email,',') FROM users; COMMIT;")
[ "$SEEN_B" = "bob@globex.test" ] && ok 'tenant B sees only its own user' \
                                  || bad 'tenant B saw the wrong set' "$SEEN_B"

CROSS=$(as_app "BEGIN; SET LOCAL depsis.organization_id='$A';
                INSERT INTO users (organization_id,email,display_name)
                VALUES ('$B','sneak@x.test','S'); COMMIT;")
grep -qi 'row-level security' <<<"$CROSS" && ok 'writing into another tenant is refused by policy' \
                                          || bad 'a cross-tenant write was not refused' "$CROSS"

# ─── 6. uniqueness: scoped, and folded correctly ──────────────────────────────
step 'uniqueness and identity folding'

# Cross-tenant reuse must be ALLOWED — a refusal here is the existence oracle P0-C measured.
REUSE=$(as_app "BEGIN; SET LOCAL depsis.organization_id='$A';
                INSERT INTO users (organization_id,email,display_name)
                VALUES ('$A','bob@globex.test','Bob in A'); COMMIT;")
grep -qi 'duplicate key' <<<"$REUSE" \
  && bad 'a cross-tenant duplicate email was refused' 'this tells one tenant that another holds the address' \
  || ok 'the same address may be used by two different tenants'

# Same-tenant duplicates must be refused, in every spelling of the same address.
check_dup() { # label sql-literal
  OUT=$(db -c "SET ROLE depsis_owner;
               INSERT INTO users (organization_id,email,display_name)
               VALUES ('$A',$2,'dup');")
  grep -qi 'duplicate key' <<<"$OUT" && ok "same-tenant duplicate refused: $1" \
                                     || bad "same-tenant duplicate ACCEPTED: $1" "${OUT:-no error at all}"
}
check_dup 'ASCII case'          "'ADA@ACME.TEST'"

db -c "SET ROLE depsis_owner;
       INSERT INTO users (organization_id,email,display_name)
       VALUES ('$A','ismail@acme.test','Ismail');" >/dev/null 2>&1
check_dup 'Turkish dotted I'    "'İsmail@acme.test'"
db -c "SET ROLE depsis_owner;
       INSERT INTO users (organization_id,email,display_name)
       VALUES ('$A',U&'jos\\00e9@acme.test','Jose NFC');" >/dev/null 2>&1
check_dup 'NFD vs NFC'          "U&'jose\\0301@acme.test'"

# The negative control. Accent stripping in an identity key merges two different people.
DISTINCT=$(db -c "SET ROLE depsis_owner;
                  INSERT INTO users (organization_id,email,display_name)
                  VALUES ('$A','cagri@acme.test','C'),('$A','çağrı@acme.test','Ç');")
grep -qi 'duplicate key' <<<"$DISTINCT" \
  && bad 'cagri@ and çağrı@ were folded together' 'an identity key must not strip accents' \
  || ok 'cagri@ and çağrı@ stay distinct'

# ─── 7. the constraint audit, written so it can actually see ──────────────────
step 'uniqueness audit'
# A bare CREATE UNIQUE INDEX has no pg_constraint row, so an audit that scans only pg_constraint is
# blind to the idiom this schema would most naturally use for a scoped key. Scan pg_index.
BAD=$(db -c "
  SELECT coalesce(string_agg(i.relname, ', '), '')
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND (x.indisunique OR x.indisexclusion)
     AND pg_get_indexdef(i.oid) NOT LIKE '%organization_id%'
     AND i.relname NOT IN ('organizations_pkey','users_pkey','organizations_slug_key','depsis_migrations_pkey')
")
[ -z "$BAD" ] && ok 'every unique/exclusion index carries organization_id or is allow-listed' \
              || bad "unique index without organization_id: $BAD" \
                     'a 23505 on it tells one tenant that another holds the value'

# ─── 8. down, and up again ────────────────────────────────────────────────────
step 'rollback'
if ( cd "$DB_DIR" && npm run --silent migrate:down ) >/tmp/down.log 2>&1; then
  ok 'the shipped migrate:down script rolls back'
else
  bad 'migrate:down failed' "$(tail -8 /tmp/down.log)"
fi
LEFT=$(db -c "SELECT count(*) FROM depsis_migrations")
[ "$LEFT" = "0" ] && ok 'the history table is empty after rollback' \
                  || bad 'the history table still records migrations' "count=$LEFT"

if ( cd "$DB_DIR" && npm run --silent migrate:up ) >/tmp/up2.log 2>&1; then
  ok 'the migration re-applies after a rollback'
else
  bad 're-applying after rollback failed' "$(tail -8 /tmp/up2.log)"
fi

# ─── summary ──────────────────────────────────────────────────────────────────
printf '\n== summary ==\n  passed: %d   failed: %d\n' "$pass_count" "$fail_count"
[ "$fail_count" -eq 0 ] || exit 1
