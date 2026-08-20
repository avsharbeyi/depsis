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

# `-d` defaults to the admin database but callers may override it by passing their own -d, which
# psql resolves last-wins. Several checks below need to inspect the catalog of the database under
# test rather than the one the superuser connected to.
admin()  { psql -X -q -At -d "$PGDATABASE_ADMIN" -v ON_ERROR_STOP=1 "$@"; }
db()     { psql -X -q -At -d "$DB_NAME" "$@" 2>&1; }
as_app() { PGPASSWORD="$APP_PW" psql -X -q -At "postgresql://depsis_app@$PGHOST:$PGPORT/$DB_NAME" -c "$1" 2>&1; }
# Same as `db`, named so a reader can see at a glance that the caller EXPECTS a failure and is
# reading the message rather than the exit code.
_lax_db() { psql -X -q -At -d "$DB_NAME" -c "$1" 2>&1 || true; }

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

# These ALTER ROLE statements change the password CLUSTER-WIDE, not per database — roles are
# cluster objects. On a CI runner the cluster is disposable so that costs nothing, but on a shared
# development cluster it will break any other database whose connection strings use these roles.
# Said out loud because it cost one confusing "password authentication failed" already.
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

# Every migration after the first must call the shared guard as its first statement. P1-A measured
# what happens otherwise: the check lived inline in 0001, so applying a LATER migration onto a role
# that had since been granted BYPASSRLS installed its policies without a word. Forgetting the call
# is now a red build rather than a silent hole.
MISSING_GUARD=""
for f in "$DB_DIR"/migrations/*.sql; do
  case "$(basename "$f")" in 0001_*) continue ;; esac
  grep -q 'assert_rls_roles_sane' "$f" || MISSING_GUARD="$MISSING_GUARD $(basename "$f")"
done
if [ -z "$MISSING_GUARD" ]; then
  ok 'every migration after 0001 calls assert_rls_roles_sane()'
else
  bad "migration(s) missing the RLS role guard:$MISSING_GUARD"       'applying them onto a BYPASSRLS role would install policies that role ignores'
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

# ─── 6b. the slug resolver, and the limits of the privilege it borrows ────────
step 'slug resolution (ADR-0015 §5)'

# The function exists so login is possible at all: the policy on organizations requires a tenant
# context, and a user arriving with a slug does not have one yet. What has to be true is that it
# borrows the owner's privilege for exactly one column of one row and not a byte more.

RESOLVED=$(as_app "SELECT public.resolve_organization_by_slug('acme')")
[ "$RESOLVED" = "$A" ] && ok 'an unauthenticated caller can resolve a known slug to its id' \
                       || bad 'the slug did not resolve to the expected id' "got '$RESOLVED', want '$A'"

UNKNOWN=$(as_app "SELECT coalesce(public.resolve_organization_by_slug('no-such-tenant')::text,'NULL')")
[ "$UNKNOWN" = "NULL" ] && ok 'an unknown slug resolves to NULL' \
                        || bad 'an unknown slug returned something' "$UNKNOWN"

# A malformed slug must be answered without touching the table — the CHECK shape is repeated inside
# the function precisely so a probing value cannot reach a row.
# Dollar-quoted, not single-quoted. The first version interpolated each payload into a normal SQL
# literal, which meant the injection probe produced a psql syntax error and never reached the
# function at all — a test that failed to deliver the thing it was testing. $probe$...$probe$
# carries the bytes through verbatim, which is the only way to learn how the function treats them.
for junk in "'; DROP TABLE users; --" "ACME" "a--very--long--$(printf 'x%.0s' $(seq 1 80))" "" "Acme " "../etc" ; do
  OUT=$(as_app "SELECT coalesce(public.resolve_organization_by_slug(\$probe\$$junk\$probe\$)::text,'NULL')")
  if [ "$OUT" = "NULL" ]; then
    ok "a malformed slug resolves to NULL: ${junk:0:28}"
  else
    bad "a malformed slug resolved to something: ${junk:0:28}" "$OUT"
  fi
done

# THE assertion this section exists for. Holding the id must not, by itself, let the caller read
# the row — the function returns an id, it does not grant a context. If this ever passes, the
# SECURITY DEFINER function has become a way around the policy rather than a way to start.
STILL_BLIND=$(as_app "SELECT count(*) FROM organizations WHERE id = '$A'")
[ "$STILL_BLIND" = "0" ] && ok 'resolving an id does NOT make the organizations row readable' \
                         || bad 'the organizations row is readable without a tenant context' "count=$STILL_BLIND"

# And with a context it is readable, so the previous assertion is not passing because the row is
# simply absent.
WITH_CTX=$(as_app "BEGIN; SET LOCAL depsis.organization_id='$A'; SELECT count(*) FROM organizations; COMMIT;")
[ "$WITH_CTX" = "1" ] && ok 'with a tenant context the row IS readable (the control)' \
                      || bad 'the row is not readable even with a context' "count=$WITH_CTX"

# PUBLIC must not hold EXECUTE. PostgreSQL grants it by default on new functions, and on a
# SECURITY DEFINER function that means every role in the cluster can borrow the owner's privileges.
PUB=$(admin -d "$DB_NAME" -c "SELECT has_function_privilege('public','public.resolve_organization_by_slug(text)','EXECUTE')")
[ "$PUB" = "f" ] && ok 'PUBLIC cannot execute the SECURITY DEFINER resolver' \
                 || bad 'PUBLIC holds EXECUTE on a SECURITY DEFINER function' \
                        'every role in the cluster can borrow depsis_owner through it'

# A SECURITY DEFINER function without a fixed search_path is the classic privilege escalation. This
# checks the shipped definition rather than trusting the comment above it.
SP=$(admin -d "$DB_NAME" -c "SELECT coalesce(array_to_string(proconfig,','),'NONE')
                             FROM pg_proc WHERE proname='resolve_organization_by_slug'")
case "$SP" in
  *search_path*) ok "the resolver pins its search_path ($SP)" ;;
  *)             bad 'the SECURITY DEFINER resolver has no fixed search_path' \
                     'a caller can shadow public.organizations and run it as the owner' ;;
esac

# ─── 6c. sessions, and what resolve_session refuses to tell a caller ──────────
step 'sessions (migration 0003)'

SESSION_TOKEN_HASH="\\x$(printf 'a%.0s' $(seq 1 64))"
EXPIRED_HASH="\\x$(printf 'b%.0s' $(seq 1 64))"
REVOKED_HASH="\\x$(printf 'c%.0s' $(seq 1 64))"
DISABLED_HASH="\\x$(printf 'd%.0s' $(seq 1 64))"

USER_A=$(db -c "SET ROLE depsis_owner; SELECT id FROM users WHERE organization_id='$A' LIMIT 1")
db -c "SET ROLE depsis_owner;
       INSERT INTO users (organization_id,email,display_name,disabled_at)
       VALUES ('$A','disabled@acme.test','Disabled',now());" >/dev/null
USER_OFF=$(db -c "SET ROLE depsis_owner; SELECT id FROM users WHERE email='disabled@acme.test'")

# The expired row needs an explicit older created_at, because `sessions_expires_after` requires
# expires_at > created_at. The first version of this seed set expires_at in the past while letting
# created_at default to now(), so the CHECK correctly refused it — and, because all four rows were
# one statement, took the live session down with it. Every negative assertion below then passed
# against an empty table. The errors were suppressed, which is why it looked like one failure
# instead of five meaningless successes.
SEED_ERR=$(db -c "SET ROLE depsis_owner;
  INSERT INTO sessions (organization_id,user_id,token_hash,created_at,expires_at) VALUES
    ('$A','$USER_A','$SESSION_TOKEN_HASH'::bytea, now(),                     now() + interval '1 hour'),
    ('$A','$USER_A','$EXPIRED_HASH'::bytea,       now() - interval '2 hours', now() - interval '1 minute'),
    ('$A','$USER_OFF','$DISABLED_HASH'::bytea,    now(),                     now() + interval '1 hour');
  INSERT INTO sessions (organization_id,user_id,token_hash,expires_at,revoked_at) VALUES
    ('$A','$USER_A','$REVOKED_HASH'::bytea,       now() + interval '1 hour', now());")

# The seed is asserted, not assumed. Four rows must exist or every check below is measuring an
# empty table and reporting success for it.
SEEDED=$(db -c "SET ROLE depsis_owner; SELECT count(*) FROM sessions")
if [ "$SEEDED" = "4" ]; then
  ok 'four session fixtures seeded (live, expired, revoked, disabled-user)'
else
  bad "the session fixtures did not seed (count=$SEEDED)"       "every assertion below would pass against an empty table. ${SEED_ERR:-no error reported}"
fi

# The expiry CHECK has to bite, or a caller could create a session that was never valid and the
# resolver's expiry test would be the only thing standing between it and a live context.
BAD_EXP=$(_lax_db "SET ROLE depsis_owner;
                   INSERT INTO sessions (organization_id,user_id,token_hash,created_at,expires_at)
                   VALUES ('$A','$USER_A','\\x00'::bytea, now(), now() - interval '1 day');")
grep -qi 'violates check\|sessions_expires_after\|sessions_token_hash_len' <<<"$BAD_EXP" \
  && ok 'a session that expires before it was created is refused' \
  || bad 'an already-expired session was accepted' "${BAD_EXP:-no error}"

RESOLVED_S=$(as_app "SELECT organization_id::text FROM public.resolve_session('$SESSION_TOKEN_HASH'::bytea)")
[ "$RESOLVED_S" = "$A" ] && ok 'a live session resolves to its organization with no tenant context' \
                         || bad 'the live session did not resolve' "got '$RESOLVED_S', want '$A'"

for pair in "expired:$EXPIRED_HASH" "revoked:$REVOKED_HASH" "disabled-user:$DISABLED_HASH"; do
  label=${pair%%:*}; h=${pair#*:}
  OUT=$(as_app "SELECT count(*) FROM public.resolve_session('$h'::bytea)")
  [ "$OUT" = "0" ] && ok "resolve_session returns nothing for a $label session" \
                   || bad "a $label session resolved" "rows=$OUT"
done

# Indistinguishable from a token that never existed — otherwise the caller learns that a token WAS
# valid, which is a different and more useful fact than "not valid".
NEVER=$(as_app "SELECT count(*) FROM public.resolve_session('\\x$(printf 'e%.0s' $(seq 1 64))'::bytea)")
[ "$NEVER" = "0" ] && ok 'an unknown token is indistinguishable from a dead one' \
                   || bad 'an unknown token behaved differently' "rows=$NEVER"

# Resolving does not hand over the session row itself.
BLIND_S=$(as_app "SELECT count(*) FROM sessions")
[ "$BLIND_S" = "0" ] && ok 'resolving a session does NOT make the sessions table readable' \
                     || bad 'sessions are readable with no tenant context' "count=$BLIND_S"

# The backup role must never carry replayable material.
BK=$(admin -d "$DB_NAME" -c "SELECT has_table_privilege('depsis_backup','public.sessions','SELECT')")
if [ "$BK" = "f" ]; then
  ok 'depsis_backup has no SELECT on sessions'
else
  # The GRANT is absent, but the policy is what actually decides; check the policy too.
  POL=$(admin -d "$DB_NAME" -c "SELECT qual FROM pg_policies
                                WHERE tablename='sessions' AND policyname='sessions_backup_denied'")
  case "$POL" in
    *false*) ok 'the backup role is denied sessions by policy' ;;
    *)       bad 'the backup role can read session token hashes' \
                 'a restored backup would carry replayable session material' ;;
  esac
fi

PUB_S=$(admin -d "$DB_NAME" -c "SELECT has_function_privilege('public','public.resolve_session(bytea)','EXECUTE')")
[ "$PUB_S" = "f" ] && ok 'PUBLIC cannot execute resolve_session' \
                   || bad 'PUBLIC holds EXECUTE on resolve_session' 'it is SECURITY DEFINER'

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
     -- A surrogate primary key on a single uuidv7 \`id\` is not an oracle: provoking a collision
     -- means guessing 122 random bits, so the caller must already hold the value to learn that it
     -- exists. Expressed as a rule rather than a list, because a list grows with every table and
     -- eventually somebody appends a genuinely global natural key to it without noticing.
     AND pg_get_indexdef(i.oid) NOT LIKE '%(id)'
     -- The two named exceptions, each argued in the migration that creates it. Anything else that
     -- wants on this list needs its own argument, not an analogy to these.
     AND i.relname NOT IN ('organizations_slug_key','sessions_token_hash_key','depsis_migrations_pkey')
")
[ -z "$BAD" ] && ok 'every unique/exclusion index carries organization_id or is allow-listed' \
              || bad "unique index without organization_id: $BAD" \
                     'a 23505 on it tells one tenant that another holds the value'

# ─── 8. down, and up again ────────────────────────────────────────────────────
step 'rollback'
BEFORE=$(db -c "SELECT count(*) FROM depsis_migrations")
if ( cd "$DB_DIR" && npm run --silent migrate:down ) >/tmp/down.log 2>&1; then
  ok 'the shipped migrate:down script rolls back'
else
  bad 'migrate:down failed' "$(tail -8 /tmp/down.log)"
fi

# One step, not all of them. Measured: `down` with no argument undoes exactly the most recent
# migration. An earlier version of this check assumed it undid everything and failed the moment a
# second migration existed — the assumption, not the tool, was wrong.
AFTER=$(db -c "SELECT count(*) FROM depsis_migrations")
if [ "$AFTER" = "$((BEFORE - 1))" ]; then
  ok "migrate:down rolls back exactly one migration ($BEFORE -> $AFTER)"
else
  bad 'migrate:down did not roll back exactly one migration' "$BEFORE -> $AFTER"
fi

# And all the way back, through the separately-named script. `down 0` means ALL, which is a footgun
# worth keeping out of the script a deploy would reach for.
if ( cd "$DB_DIR" && npm run --silent migrate:down:all ) >/tmp/downall.log 2>&1; then
  ok 'migrate:down:all rolls the rest back'
else
  bad 'migrate:down:all failed' "$(tail -8 /tmp/downall.log)"
fi
LEFT=$(db -c "SELECT count(*) FROM depsis_migrations")
[ "$LEFT" = "0" ] && ok 'the history table is empty after a full rollback' \
                  || bad 'the history table still records migrations' "count=$LEFT"

# Nothing of the schema may survive a full rollback except the history table itself.
SURVIVORS=$(db -c "SELECT coalesce(string_agg(tablename,','),'') FROM pg_tables
                   WHERE schemaname='public' AND tablename <> 'depsis_migrations'")
[ -z "$SURVIVORS" ] && ok 'no table survives a full rollback' \
                    || bad "tables survived the rollback: $SURVIVORS" \
                           'the next deploy will hit "relation already exists"'

FUNCS=$(db -c "SELECT coalesce(string_agg(proname,','),'') FROM pg_proc p
               JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='public' AND p.proname IN
                     ('current_organization_id','fold_identity','set_updated_at','resolve_organization_by_slug')")
[ -z "$FUNCS" ] && ok 'no function survives a full rollback' \
                || bad "functions survived the rollback: $FUNCS" 

if ( cd "$DB_DIR" && npm run --silent migrate:up ) >/tmp/up2.log 2>&1; then
  ok 'the migrations re-apply after a full rollback'
else
  bad 're-applying after rollback failed' "$(tail -8 /tmp/up2.log)"
fi

REAPPLIED=$(db -c "SELECT count(*) FROM depsis_migrations")
[ "$REAPPLIED" = "$BEFORE" ] && ok "all $BEFORE migrations are applied again" \
                             || bad 'a different number of migrations came back' "$BEFORE -> $REAPPLIED"

# ─── summary ──────────────────────────────────────────────────────────────────
printf '\n== summary ==\n  passed: %d   failed: %d\n' "$pass_count" "$fail_count"
[ "$fail_count" -eq 0 ] || exit 1
