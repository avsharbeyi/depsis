#!/usr/bin/env bash
# P0-C — prove ADR-0013: PostgreSQL tenant isolation actually isolates.
#
# ADR-0013 §2 records two bypasses that PostgreSQL documents and that almost every RLS
# tutorial omits. Both are SILENT — the policies read correctly, `\d` prints "Row Security
# Enabled", nothing logs a warning, and rows still cross the tenant boundary:
#
#   1. The table OWNER bypasses RLS. `ENABLE ROW LEVEL SECURITY` does not stop it. If one
#      role runs the migrations and also serves traffic — the default arrangement in a
#      NestJS app with a single DATABASE_URL — every policy in the schema is dead code.
#   2. Uniqueness and foreign-key checks ALWAYS bypass RLS, and the docs call this out as a
#      covert channel. A global UNIQUE(name) therefore answers "does the other tenant have a
#      file called X?" through the ERROR channel, without ever returning a row. Master prompt
#      §18.2 says user A cannot see user B's file NAME; a 23505 tells them.
#
# Reading that in the manual is not the same as watching it happen, and a test suite that
# only ever asserts what it hopes to see would go green against a completely open database.
# So this script makes both leaks HAPPEN first, records them, then closes them and shows the
# same probe come back clean. Anything that fails to leak when it should is `unexpected` —
# that would mean ADR-0013 is wrong about PostgreSQL, which is a finding in its own right.

POC_ID=p0-c
# shellcheck source=lib/common.sh
. "$(dirname "$(readlink -f "$0")")/lib/common.sh"

require_test_environment

# ─── constants ────────────────────────────────────────────────────────────────
# Role names are taken verbatim from ADR-0013 §2.1 so the evidence log matches the ADR.
# Cleanup DROPs them; require_test_environment above is what makes that acceptable.
PGDB=depsis_poc_rls
OWNER_ROLE=depsis_owner
APP_ROLE=depsis_app
PGPW='P0c-Rls-Pw!2026'

# Fixed UUIDs, not random ones: the evidence file has to be diffable between runs.
ORG_A=11111111-1111-1111-1111-111111111111
ORG_B=22222222-2222-2222-2222-222222222222
ROOT_ID=00000000-0000-0000-0000-000000000000
NOBODY_ORG=99999999-9999-9999-9999-999999999999

# The single filename that only tenant B holds. Everything in section 5 turns on it.
B_ONLY_NAME='quarterly-layoffs.xlsx'

PGPORT=5432
CONN_MODE=setrole   # overwritten to "tcp" if a real per-role connection is possible
CLAIM1=''
CLAIM2=''

# ─── psql plumbing ────────────────────────────────────────────────────────────
# Every helper takes SQL as $1 and returns psql's exit status, so the harness assertions can
# call them directly: assert_cmd '...' fail -- q_app "$sql".
#
# Objects are ALWAYS schema-qualified (depsis.file_entries). No search_path games: a PoC
# whose result depends on an implicit search_path is not evidence of anything.

_psql_super() { # <database> <sql>
  printf '%s\n' "$2" | runuser -u postgres -- \
    psql -X -q -At -v ON_ERROR_STOP=1 -d "$1" -f -
}

q_admin() { _psql_super postgres "$1"; }   # maintenance DB: CREATE/DROP DATABASE, roles
q_super() { _psql_super "$PGDB"   "$1"; }  # superuser inside the test DB

# Best-effort variant for cleanup only — must never abort the EXIT trap.
_admin_lax() {
  printf '%s\n' "$1" | runuser -u postgres -- psql -X -q -At -d postgres -f - >/dev/null 2>&1 || true
}

# A real TCP login as the role is the only thing that proves ADR-0013's role split as it will
# actually be deployed. If pg_hba refuses it we fall back to superuser + SET ROLE, which still
# exercises RLS (check_enable_rls uses the *current* role) but is weaker evidence — the
# session_user behind it is still a superuser. That degradation is recorded loudly, never
# silently absorbed.
_psql_role() { # <role> <sql>
  if [ "$CONN_MODE" = tcp ]; then
    printf '%s\n' "$2" | PGPASSWORD="$PGPW" \
      psql -X -q -At -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PGPORT" -U "$1" -d "$PGDB" -f -
  else
    printf 'SET ROLE %s;\n%s\n' "$1" "$2" | runuser -u postgres -- \
      psql -X -q -At -v ON_ERROR_STOP=1 -d "$PGDB" -f -
  fi
}

q_owner() { _psql_role "$OWNER_ROLE" "$1"; }
q_app()   { _psql_role "$APP_ROLE"   "$1"; }

# All measurements come back as label=value lines so a stray psql command tag or NOTICE
# cannot be mistaken for a result.
_field() { sed -n "s/^$1=//p" <<<"$2" | head -1; }

cleanup() {
  section 'Cleanup'
  [ -n "$CLAIM1" ] && rm -f "$CLAIM1"
  [ -n "$CLAIM2" ] && rm -f "$CLAIM2"
  # Deliberately NOT cleanup_pool: P0-C creates no ZFS pool, and destroying one we did not
  # create is precisely the risk-R1 mistake this harness exists to prevent.
  _admin_lax "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
              WHERE datname = '$PGDB' AND pid <> pg_backend_pid();"
  _admin_lax "DROP DATABASE IF EXISTS $PGDB;"
  _admin_lax "DROP ROLE IF EXISTS $APP_ROLE;"
  _admin_lax "DROP ROLE IF EXISTS $OWNER_ROLE;"
}
trap cleanup EXIT

# ═══════════════════════════════════════════════════════════════════════════════
section '0. Environment — which PostgreSQL is actually here?'
# ═══════════════════════════════════════════════════════════════════════════════
# ADR-0013 decides "PGDG PostgreSQL 18", but Debian 13 stock is PG 17. Assume neither.

if ! command -v psql >/dev/null 2>&1; then
  fail 'psql is not installed — ADR-0013 cannot be verified on this VM' \
       'install postgresql (stock) or postgresql-18 (PGDG) and re-run'
  poc_summary; exit 1
fi
if ! getent passwd postgres >/dev/null 2>&1; then
  fail 'no postgres OS user — no local superuser channel' 'is the server package installed?'
  poc_summary; exit 1
fi
if ! runuser -u postgres -- psql -X -At -c 'SELECT 1' >/dev/null 2>&1; then
  fail 'cannot reach the cluster as the postgres superuser' 'is the cluster running?'
  poc_summary; exit 1
fi

PGPORT=$(runuser -u postgres -- psql -X -At -c 'SHOW port' 2>/dev/null || echo 5432)
SERVER_VERSION=$(runuser -u postgres -- psql -X -At -c 'SHOW server_version')
SERVER_VERSION_NUM=$(runuser -u postgres -- psql -X -At -c 'SHOW server_version_num')
PG_MAJOR=$(( SERVER_VERSION_NUM / 10000 ))

note "psql client: $(psql --version 2>&1)"
note "server_version: $SERVER_VERSION (num=$SERVER_VERSION_NUM, major=$PG_MAJOR, port=$PGPORT)"
note "postgresql package: $(dpkg-query -W -f='${Version}' postgresql 2>/dev/null || echo 'not installed')"
note "postgresql-$PG_MAJOR package: $(dpkg-query -W -f='${Version}' "postgresql-$PG_MAJOR" 2>/dev/null || echo 'not installed')"

# uuidv7() is the one thing ADR-0013 §1 names as concretely missing below PG 18. It is a
# built-in, so a catalog lookup settles it without depending on any extension being present.
HAS_UUIDV7=$(runuser -u postgres -- psql -X -At -c \
  "SELECT count(*) FROM pg_proc WHERE proname = 'uuidv7' AND pronamespace = 'pg_catalog'::regnamespace")
note "pg_catalog.uuidv7() present: $HAS_UUIDV7"

if [ "$PG_MAJOR" -ge 18 ]; then
  # If an 18+ server does NOT have uuidv7(), ADR-0013's version table is wrong.
  assert_eq "PG $PG_MAJOR ships built-in uuidv7() (ADR-0013 §1)" 1 "$HAS_UUIDV7"
else
  # Confirming the absence is the point: it is the evidence behind the PGDG decision.
  assert_eq "PG $PG_MAJOR does NOT ship uuidv7() — confirms ADR-0013 §1" 0 "$HAS_UUIDV7"
  warn "this cluster is PG $PG_MAJOR, not the PG 18 ADR-0013 chose — the PGDG step has not been applied"
  # Not a FAIL: ADR-0013 explicitly keeps PG 17 as an accepted fallback (UUIDv7 moves into
  # application code). It IS a deviation from the deployed decision, so it is recorded.
  note "DEVIATION: running PG $PG_MAJOR; ADR-0013 mandates PGDG PG 18 or an explicit supersede"
fi

# ADR-0013 §1 also claims PG 17 rejects LIKE on nondeterministic collations. That claim
# belongs to the search stack (ADR-0010) and is measured by P0-H, not here — recorded so the
# gap is visible rather than assumed covered.
note 'nondeterministic-collation LIKE claim (ADR-0013 §1) is NOT tested here — deferred to P0-H'

if [ "$HAS_UUIDV7" = 1 ]; then ID_DEFAULT='uuidv7()'; else ID_DEFAULT='gen_random_uuid()'; fi
note "primary key default for this run: $ID_DEFAULT"

# ═══════════════════════════════════════════════════════════════════════════════
section '1. Setup — owner runs DDL, app is NOT the table owner'
# ═══════════════════════════════════════════════════════════════════════════════

# Remove anything a previous aborted run left behind, then build from scratch.
q_admin "
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE datname = '$PGDB' AND pid <> pg_backend_pid();
"
q_admin "DROP DATABASE IF EXISTS $PGDB;"
q_admin "DROP ROLE IF EXISTS $APP_ROLE;"
q_admin "DROP ROLE IF EXISTS $OWNER_ROLE;"

# NOSUPERUSER/NOBYPASSRLS are the defaults, written out anyway: if either were ever flipped,
# every assertion after this point would pass for the wrong reason.
q_admin "
CREATE ROLE $OWNER_ROLE LOGIN PASSWORD '$PGPW' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE $APP_ROLE   LOGIN PASSWORD '$PGPW' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
"
q_admin "CREATE DATABASE $PGDB OWNER $OWNER_ROLE;"
pass 'created test database and the two ADR-0013 roles'

q_super "
CREATE SCHEMA depsis AUTHORIZATION $OWNER_ROLE;
GRANT CONNECT ON DATABASE $PGDB TO $APP_ROLE;
"

# Decide how the app role will be driven for the rest of the run.
if PGPASSWORD="$PGPW" psql -X -At -h 127.0.0.1 -p "$PGPORT" -U "$APP_ROLE" -d "$PGDB" \
     -c 'SELECT 1' >/dev/null 2>&1; then
  CONN_MODE=tcp
  pass "$APP_ROLE can log in over TCP — RLS is exercised on a real connection"
else
  CONN_MODE=setrole
  warn "pg_hba refuses a password login for $APP_ROLE; falling back to superuser + SET ROLE"
  note 'DEGRADED EVIDENCE: role separation is simulated with SET ROLE, not a real login' \
       'session_user remains a superuser; the connection-level half of ADR-0013 §2.1 is unproven here'
fi
note "connection mode: $CONN_MODE"

# The schema. parent_id is NOT NULL with a sentinel root rather than nullable, because a
# nullable column inside a UNIQUE constraint makes that constraint vacuous for root-level
# entries (NULLs compare distinct) unless PG 15+ NULLS NOT DISTINCT is spelled out. That is a
# real way to ship a tenant-scoped constraint that enforces nothing; sidestep it explicitly.
q_owner "
CREATE TABLE depsis.organizations (
    id    uuid PRIMARY KEY,
    slug  text NOT NULL
);

CREATE TABLE depsis.file_entries (
    id              uuid PRIMARY KEY DEFAULT $ID_DEFAULT,
    organization_id uuid NOT NULL REFERENCES depsis.organizations(id),
    parent_id       uuid NOT NULL DEFAULT '$ROOT_ID',
    name            text NOT NULL,
    size_bytes      bigint NOT NULL DEFAULT 0
);

-- No TO clause: the policy applies to PUBLIC, so once FORCE is on it constrains the owner
-- too. A policy written 'TO depsis_app' would leave the owner with no policy at all, which
-- under FORCE means default-deny — green tests, and a migration role that can read nothing.
--
-- nullif(...,'') is load-bearing. current_setting('depsis.org_id', true) returns NULL when
-- the GUC was never set in the session, but an EMPTY STRING once it has been set and the
-- transaction ended. ''::uuid raises 22P02, which would turn section 5's clean zero-row
-- result into a query error.
ALTER TABLE depsis.organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_self ON depsis.organizations
    USING      (id = nullif(current_setting('depsis.org_id', true), '')::uuid)
    WITH CHECK (id = nullif(current_setting('depsis.org_id', true), '')::uuid);

ALTER TABLE depsis.file_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON depsis.file_entries
    USING      (organization_id = nullif(current_setting('depsis.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('depsis.org_id', true), '')::uuid);

GRANT USAGE ON SCHEMA depsis TO $APP_ROLE;
GRANT SELECT, INSERT, UPDATE, DELETE ON depsis.organizations, depsis.file_entries TO $APP_ROLE;
"
pass 'schema created with ENABLE ROW LEVEL SECURITY (FORCE deliberately withheld for section 2)'

# Seeding both tenants from one connection is only possible BECAUSE the owner bypass is real.
# If this INSERT ever starts failing, section 2's premise has changed and must be re-read.
q_owner "
INSERT INTO depsis.organizations (id, slug) VALUES
    ('$ORG_A', 'tenant-a'),
    ('$ORG_B', 'tenant-b');

INSERT INTO depsis.file_entries (organization_id, name, size_bytes) VALUES
    ('$ORG_A', 'a-budget.txt',   100),
    ('$ORG_A', 'a-photo.jpg',    200),
    ('$ORG_B', 'b-contract.pdf', 400),
    ('$ORG_B', '$B_ONLY_NAME',   800);
"
pass 'seeded 2 tenants / 4 files as the owner with NO tenant context set' \
     'the seed only succeeded because the owner bypasses RLS — that is section 2'

# Catalog facts the rest of the file depends on. Checking them is not ceremony: if the app
# role were the table owner, or had BYPASSRLS, every isolation assertion below would pass
# while proving nothing.
CATALOG=$(q_super "
SELECT 'fe_owner='   || c.relowner::regrole::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'depsis' AND c.relname = 'file_entries';
SELECT 'app_super='  || rolsuper::text     FROM pg_roles WHERE rolname = '$APP_ROLE';
SELECT 'app_bypass=' || rolbypassrls::text FROM pg_roles WHERE rolname = '$APP_ROLE';
")
assert_eq 'file_entries is owned by the migration role'      "$OWNER_ROLE" "$(_field fe_owner   "$CATALOG")"
assert_eq "$APP_ROLE is not a superuser"                     false          "$(_field app_super  "$CATALOG")"
assert_eq "$APP_ROLE does not hold BYPASSRLS"                false          "$(_field app_bypass "$CATALOG")"

# ═══════════════════════════════════════════════════════════════════════════════
section '2. THE OWNER BYPASS — ENABLE alone is not a control (ADR-0013 §2.1)'
# ═══════════════════════════════════════════════════════════════════════════════
# The failure mode: the policy is correct, RLS is "enabled", and the application connects as
# the role that created the tables. Every tenant sees every tenant.

OWNER_PRE=$(q_owner "
BEGIN;
SET LOCAL depsis.org_id = '$ORG_A';
SELECT 'count=' || count(*)                       FROM depsis.file_entries;
SELECT 'sum='   || coalesce(sum(size_bytes), 0)   FROM depsis.file_entries;
COMMIT;
")
owner_pre_count=$(_field count "$OWNER_PRE")
note "owner, tenant-A context, ENABLE only → rows=$owner_pre_count sum=$(_field sum "$OWNER_PRE")"

if [ "$owner_pre_count" = 4 ]; then
  pass 'owner sees ALL 4 rows despite a tenant-A context — RLS is bypassed as documented' \
       'ENABLE ROW LEVEL SECURITY does not constrain the table owner'
elif [ "$owner_pre_count" = 2 ]; then
  # Safer than documented, but it means ADR-0013 §2.1 misreads PostgreSQL and the two-role
  # split was justified on a false premise. Loud either way.
  unexpected 'owner was CONSTRAINED by RLS without FORCE — ADR-0013 §2.1 is wrong' \
             "expected 4 rows (bypass), got $owner_pre_count"
else
  fail 'owner-bypass probe returned an unexplained row count' "got '$owner_pre_count', expected 4"
fi

# Belt and braces, per ADR-0013 §2.1.
q_owner "
ALTER TABLE depsis.organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE depsis.file_entries  FORCE ROW LEVEL SECURITY;
"

OWNER_POST=$(q_owner "
BEGIN;
SET LOCAL depsis.org_id = '$ORG_A';
SELECT 'count=' || count(*)                     FROM depsis.file_entries;
SELECT 'sum='   || coalesce(sum(size_bytes), 0) FROM depsis.file_entries;
COMMIT;
")
assert_eq 'after FORCE, the owner sees only tenant A (2 rows)' 2 "$(_field count "$OWNER_POST")"
assert_eq 'after FORCE, the owner aggregate is tenant-scoped too' 300 "$(_field sum "$OWNER_POST")"

# The migration test ADR-0013 §2.1 promises: any table with RLS on but FORCE off is a hole.
# Prototyped here so Phase 1 can lift it straight into the migration suite.
ORPHANS=$(q_super "
SELECT 'orphans=' || count(*)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'depsis' AND c.relkind = 'r'
   AND c.relrowsecurity AND NOT c.relforcerowsecurity;
")
assert_eq 'no table has RLS enabled without FORCE' 0 "$(_field orphans "$ORPHANS")"
note 'this guard only catches ENABLE-without-FORCE; a tenant table with NO RLS at all is invisible to it' \
     'the Phase 1 migration test must also assert every table carrying organization_id has RLS'

# The bypass that FORCE does NOT close. depsis_backup (ADR-0013 §2.1) is a superuser-adjacent
# role, so it is a tenant-crossing role by construction and must be treated as one.
SUPER_VIEW=$(q_super "
BEGIN;
SET LOCAL depsis.org_id = '$ORG_A';
SELECT 'count=' || count(*) FROM depsis.file_entries;
COMMIT;
")
assert_eq 'a SUPERUSER still sees all 4 rows even under FORCE (documented, unavoidable)' \
          4 "$(_field count "$SUPER_VIEW")"

# ═══════════════════════════════════════════════════════════════════════════════
section '3. Cross-tenant reads as depsis_app — list, count and aggregate must agree'
# ═══════════════════════════════════════════════════════════════════════════════
# A filtered list with an unfiltered COUNT still leaks existence, and an unfiltered SUM leaks
# size. All three have to be scoped by the same policy or §18.2 is not met.

APP_A=$(q_app "
BEGIN;
SET LOCAL depsis.org_id = '$ORG_A';
SELECT 'names='  || coalesce(string_agg(name, ',' ORDER BY name), '') FROM depsis.file_entries;
SELECT 'count='  || count(*)                                          FROM depsis.file_entries;
SELECT 'sum='    || coalesce(sum(size_bytes), 0)                      FROM depsis.file_entries;
SELECT 'orgs='   || count(*)                                          FROM depsis.organizations;
SELECT 'bprobe=' || count(*) FROM depsis.file_entries WHERE name = '$B_ONLY_NAME';
COMMIT;
")
note "app, tenant-A context → $(tr '\n' ' ' <<<"$APP_A")"

assert_eq  'plain SELECT returns exactly tenant A'      'a-budget.txt,a-photo.jpg' "$(_field names  "$APP_A")"
assert_eq  'COUNT(*) agrees with the list'              2    "$(_field count  "$APP_A")"
assert_eq  'SUM() is tenant-scoped (300, not 1500)'     300  "$(_field sum    "$APP_A")"
assert_eq  'organizations is tenant-scoped as well'     1    "$(_field orgs   "$APP_A")"
assert_eq  "targeted probe for B's file returns 0 rows" 0    "$(_field bprobe "$APP_A")"

APP_B=$(q_app "
BEGIN;
SET LOCAL depsis.org_id = '$ORG_B';
SELECT 'count=' || count(*)                     FROM depsis.file_entries;
SELECT 'sum='   || coalesce(sum(size_bytes), 0) FROM depsis.file_entries;
COMMIT;
")
assert_eq 'tenant B sees only its own 2 rows' 2    "$(_field count "$APP_B")"
assert_eq 'tenant B aggregate is 1200'        1200 "$(_field sum   "$APP_B")"

# Isolation is not read-only. WITH CHECK must stop A from writing INTO B, otherwise A can
# plant a row it cannot see and B can.
assert_cmd 'tenant A cannot INSERT a row owned by tenant B (WITH CHECK)' fail -- \
  q_app "BEGIN;
         SET LOCAL depsis.org_id = '$ORG_A';
         INSERT INTO depsis.file_entries (organization_id, name) VALUES ('$ORG_B', 'a-smuggled.txt');
         COMMIT;"

# UPDATE is the quieter version of the same attack: no new row, just a reparent.
assert_cmd "tenant A cannot UPDATE B's rows (0 rows visible to the UPDATE)" ok -- \
  q_app "BEGIN;
         SET LOCAL depsis.org_id = '$ORG_A';
         UPDATE depsis.file_entries SET size_bytes = 0 WHERE name = '$B_ONLY_NAME';
         COMMIT;"
B_INTACT=$(q_app "
BEGIN;
SET LOCAL depsis.org_id = '$ORG_B';
SELECT 'size=' || size_bytes FROM depsis.file_entries WHERE name = '$B_ONLY_NAME';
COMMIT;
")
assert_eq "B's row survived A's blind UPDATE untouched" 800 "$(_field size "$B_INTACT")"

# ═══════════════════════════════════════════════════════════════════════════════
section '4. THE CONSTRAINT COVERT CHANNEL — the most important test in this file'
# ═══════════════════════════════════════════════════════════════════════════════
# PostgreSQL: "Referential integrity checks, such as unique or primary key constraints and
# foreign key references, always bypass row security." The index is BELOW the policy layer.
#
# So a global UNIQUE(name) turns INSERT into an oracle: tenant A cannot SELECT B's row, but A
# can ASK whether it exists and get a reliable yes/no from the error. Nothing is logged as a
# violation, no policy is wrong, and §18.2 ("A cannot see B's file name") is breached anyway.
# This is the leak that survives a correct-looking RLS review, which is why it is proven by
# construction here rather than argued about.

q_owner "ALTER TABLE depsis.file_entries ADD CONSTRAINT file_entries_name_global_key UNIQUE (name);"
note "installed the FORBIDDEN constraint UNIQUE (name) — ADR-0013 §2.2 says this must never ship"

# The audit that ADR-0013 §2.2 promises ("a migration test rejects any UNIQUE/EXCLUDE without
# organization_id"). Run it now, while the bad constraint is in place, so we know the audit
# can actually detect one. An audit that has never returned non-zero is not an audit.
AUDIT_SQL="
SELECT 'bad=' || count(*)
  FROM pg_constraint c
  JOIN pg_class     t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE n.nspname = 'depsis'
   AND c.contype IN ('u', 'x')
   AND t.relname <> 'organizations'
   AND NOT EXISTS (
         SELECT 1 FROM unnest(c.conkey) AS u(colnum)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.colnum
          WHERE a.attname = 'organization_id');
"
assert_eq 'the constraint audit DETECTS the cross-tenant UNIQUE' 1 "$(_field bad "$(q_super "$AUDIT_SQL")")"

# Establish the premise before claiming a leak: A genuinely cannot see the row.
INVIS=$(q_app "
BEGIN;
SET LOCAL depsis.org_id = '$ORG_A';
SELECT 'visible=' || count(*) FROM depsis.file_entries WHERE name = '$B_ONLY_NAME';
COMMIT;
")
assert_eq "tenant A cannot SELECT '$B_ONLY_NAME' (0 rows)" 0 "$(_field visible "$INVIS")"

# Now the oracle. VERBOSITY verbose so the SQLSTATE is in the captured text: 23505 is the
# machine-readable form of the answer "yes, some other tenant has that name".
leak_rc=0
leak_out=$(q_app "\\set VERBOSITY verbose
BEGIN;
SET LOCAL depsis.org_id = '$ORG_A';
INSERT INTO depsis.file_entries (organization_id, name) VALUES ('$ORG_A', '$B_ONLY_NAME');
COMMIT;" 2>&1) || leak_rc=$?

if [ "$leak_rc" -eq 0 ]; then
  # Would mean the unique index did NOT see B's invisible row — i.e. RLS reaches below the
  # index after all, and ADR-0013 §2.2 is wrong about PostgreSQL.
  unexpected 'the cross-tenant INSERT SUCCEEDED — uniqueness did NOT bypass RLS' \
             'ADR-0013 §2.2 would be wrong; re-derive the constraint rule before trusting it'
elif grep -qE '23505|duplicate key value' <<<"$leak_out"; then
  pass 'COVERT CHANNEL CONFIRMED: 23505 tells tenant A that another tenant holds that name' \
       "${leak_out//$'\n'/ ; }"
  # Second-order question: does the error also hand over the VALUE? PostgreSQL suppresses the
  # "Key (name)=(...)" DETAIL when RLS is active on the relation, so normally only EXISTENCE
  # leaks. If the value itself comes back, the leak is strictly worse than ADR-0013 assumed.
  if grep -qF "$B_ONLY_NAME" <<<"$leak_out"; then
    unexpected 'the error DETAIL echoed the conflicting value back to the wrong tenant' \
               'existence AND content leaked; ADR-0013 §2.2 understates the severity'
  else
    note 'error DETAIL was suppressed under RLS — only EXISTENCE leaked, not the stored value' \
         'that suppression is not a mitigation: A already learns the answer it asked for'
  fi
else
  fail 'cross-tenant INSERT failed for some reason other than a unique violation' "$leak_out"
fi

# ── the fix ──────────────────────────────────────────────────────────────────
q_owner "
ALTER TABLE depsis.file_entries DROP CONSTRAINT file_entries_name_global_key;
ALTER TABLE depsis.file_entries
    ADD CONSTRAINT file_entries_tenant_name_key UNIQUE (organization_id, parent_id, name);
"
assert_eq 'the constraint audit is clean once organization_id is in the key' \
          0 "$(_field bad "$(q_super "$AUDIT_SQL")")"

# Identical probe, identical inputs. It must now succeed — the oracle is gone.
assert_cmd 'the SAME insert now succeeds under UNIQUE (organization_id, parent_id, name)' ok -- \
  q_app "BEGIN;
         SET LOCAL depsis.org_id = '$ORG_A';
         INSERT INTO depsis.file_entries (organization_id, name) VALUES ('$ORG_A', '$B_ONLY_NAME');
         COMMIT;"

# Closing the leak must not have closed the constraint. Same name twice inside tenant A is
# still a genuine conflict; if this passed, we "fixed" the covert channel by deleting the rule.
assert_cmd 'intra-tenant uniqueness still enforced (same name twice inside tenant A)' fail -- \
  q_app "BEGIN;
         SET LOCAL depsis.org_id = '$ORG_A';
         INSERT INTO depsis.file_entries (organization_id, name) VALUES ('$ORG_A', '$B_ONLY_NAME');
         COMMIT;"

# Both tenants now hold the same filename and neither can tell.
AFTER_A=$(q_app "BEGIN; SET LOCAL depsis.org_id = '$ORG_A';
                 SELECT 'count=' || count(*) FROM depsis.file_entries;
                 SELECT 'named=' || count(*) FROM depsis.file_entries WHERE name = '$B_ONLY_NAME';
                 COMMIT;")
AFTER_B=$(q_app "BEGIN; SET LOCAL depsis.org_id = '$ORG_B';
                 SELECT 'count=' || count(*) FROM depsis.file_entries;
                 SELECT 'named=' || count(*) FROM depsis.file_entries WHERE name = '$B_ONLY_NAME';
                 COMMIT;")
assert_eq 'tenant A now has 3 rows'                     3 "$(_field count "$AFTER_A")"
assert_eq "tenant A sees exactly one '$B_ONLY_NAME'"    1 "$(_field named "$AFTER_A")"
assert_eq 'tenant B still has 2 rows'                   2 "$(_field count "$AFTER_B")"
assert_eq "tenant B sees exactly one '$B_ONLY_NAME'"    1 "$(_field named "$AFTER_B")"

# The primary key is still a global unique index on id. With random/uuidv7 ids it is not a
# practical oracle, but it is the same mechanism — worth recording so nobody later adds a
# guessable or natural key and reopens the channel.
note 'file_entries PRIMARY KEY (id) is global by construction; safe only because ids are unguessable' \
     'a natural or sequential primary key would reintroduce the same covert channel'

# ═══════════════════════════════════════════════════════════════════════════════
section '5. FAIL-CLOSED — no tenant context must mean no rows, never all rows'
# ═══════════════════════════════════════════════════════════════════════════════
# ADR-0013 §2.3: a query that escapes its transaction has no context, and the policy must
# REFUSE it. A policy that returns everything when the context is missing is worse than no
# policy at all, because the code above it looks correct.

NOCTX=$(q_app "
SELECT 'autocommit=' || count(*) FROM depsis.file_entries;
BEGIN;
SELECT 'intxn=' || count(*) FROM depsis.file_entries;
COMMIT;
BEGIN;
SET LOCAL depsis.org_id = '';
SELECT 'empty=' || count(*) FROM depsis.file_entries;
COMMIT;
BEGIN;
SET LOCAL depsis.org_id = '$NOBODY_ORG';
SELECT 'unknown=' || count(*) FROM depsis.file_entries;
COMMIT;
")
note "fail-closed probes → $(tr '\n' ' ' <<<"$NOCTX")"

assert_eq 'no context, outside any transaction → 0 rows' 0 "$(_field autocommit "$NOCTX")"
assert_eq 'no context, inside a transaction → 0 rows'    0 "$(_field intxn      "$NOCTX")"
# The empty string is the shape the GUC actually takes after a SET LOCAL unwinds. Without the
# nullif() in the policy this line would be a 22P02 cast error rather than a clean zero.
assert_eq 'empty-string context → 0 rows, not an error'  0 "$(_field empty      "$NOCTX")"
assert_eq 'unknown tenant id → 0 rows'                   0 "$(_field unknown    "$NOCTX")"

# A malformed context is a different failure: the cast raises before the policy can filter.
# That is still fail-closed, but it is noisy and it means the API must validate the org id
# before it reaches SET LOCAL rather than relying on the policy to absorb garbage.
assert_cmd 'a malformed org id ERRORS rather than returning rows' fail -- \
  q_app "BEGIN;
         SET LOCAL depsis.org_id = 'not-a-uuid';
         SELECT count(*) FROM depsis.file_entries;
         COMMIT;"
note 'malformed context raises 22P02 instead of returning 0 rows — the API must validate org ids upstream'

# ═══════════════════════════════════════════════════════════════════════════════
section '6. SET LOCAL scope — what makes PgBouncer transaction pooling safe'
# ═══════════════════════════════════════════════════════════════════════════════
# One psql process = one backend, so running two transactions down the same connection is an
# honest simulation of a pooler handing the same server connection to two different requests.

SCOPE=$(q_app "
BEGIN;
SET LOCAL depsis.org_id = '$ORG_A';
SELECT 'inside=' || count(*) FROM depsis.file_entries;
COMMIT;
SELECT 'after='   || count(*) FROM depsis.file_entries;
SELECT 'setting=[' || coalesce(current_setting('depsis.org_id', true), '<NULL>') || ']';
")
note "SET LOCAL scope → $(tr '\n' ' ' <<<"$SCOPE")"
assert_eq 'context applies inside its transaction'                     3 "$(_field inside "$SCOPE")"
assert_eq 'context is GONE on the next request over the same backend'  0 "$(_field after  "$SCOPE")"
note "residual GUC value after COMMIT: $(_field 'setting' "$SCOPE")" \
     'this is why the policy uses nullif(current_setting(...), \x27\x27)'

# The mirror image: prove the forbidden form is actually dangerous, rather than banning it on
# principle. A plain SET survives the transaction, so under session pooling request N+1
# inherits request N's tenant. That is the whole reason ADR-0013 forbids session pooling.
BLEED=$(q_app "
BEGIN;
SET depsis.org_id = '$ORG_A';
COMMIT;
SELECT 'leaked=' || count(*) FROM depsis.file_entries;
")
leaked=$(_field leaked "$BLEED")
if [ "$leaked" = 3 ]; then
  pass 'plain SET (no LOCAL) LEAKS tenant context past COMMIT — session pooling is unusable' \
       "a later request on the same backend still saw $leaked tenant-A rows"
elif [ "$leaked" = 0 ]; then
  unexpected 'plain SET did NOT survive the transaction — ADR-0013 §2.3 overstates the risk' \
             'the session-pooling prohibition would need re-deriving'
else
  fail 'context-bleed probe returned an unexplained row count' "got '$leaked'"
fi

# ═══════════════════════════════════════════════════════════════════════════════
section '7. SKIP LOCKED — two claimers must never get the same job (ADR-0003)'
# ═══════════════════════════════════════════════════════════════════════════════
# Minimal check only: does the documented queue pattern actually hand out distinct rows, and
# does the second claimer SKIP rather than WAIT. Throughput is explicitly out of scope here —
# ADR-0003 marks that unverified and defers it to the §18.1 performance run.

q_owner "
CREATE TABLE depsis.job_queue (
    id           bigserial PRIMARY KEY,
    status       text        NOT NULL DEFAULT 'queued',
    priority     int         NOT NULL DEFAULT 0,
    run_after    timestamptz NOT NULL DEFAULT now(),
    lease_until  timestamptz,
    attempt      int         NOT NULL DEFAULT 0,
    max_attempts int         NOT NULL DEFAULT 3,
    worker_id    text
);
INSERT INTO depsis.job_queue (status) VALUES ('queued'), ('queued'), ('queued');
"

# The claim statement is ADR-0003's, verbatim in shape: short transaction, mark running, hand
# out a lease. Testing a simplified query would prove nothing about the one we will ship.
claim_sql() { # <worker-id> <hold-seconds>
  cat <<SQL
BEGIN;
UPDATE depsis.job_queue SET
    status      = 'running',
    lease_until = now() + make_interval(secs => 30),
    attempt     = attempt + 1,
    worker_id   = '$1'
WHERE id = (
    SELECT id FROM depsis.job_queue
     WHERE status = 'queued'
        OR (status = 'running' AND lease_until < now())
     ORDER BY priority DESC, run_after, id
     FOR UPDATE SKIP LOCKED
     LIMIT 1
)
RETURNING 'claimed=' || id;
SELECT pg_sleep($2);
COMMIT;
SQL
}

CLAIM1=$(mktemp /tmp/p0c-claim1.XXXXXX)
CLAIM2=$(mktemp /tmp/p0c-claim2.XXXXXX)

# Worker 1 claims, then holds its transaction open for 6s.
q_owner "$(claim_sql worker-1 6)" >"$CLAIM1" 2>&1 &
w1_pid=$!

# Wait for worker 1 to be demonstrably past its UPDATE (it is sleeping) rather than guessing
# with a fixed delay — a blind sleep on a slow VM would silently test nothing concurrent.
concurrent=0
for _ in $(seq 1 60); do
  n=$(q_super "SELECT count(*) FROM pg_stat_activity
                WHERE datname = '$PGDB' AND state = 'active' AND query LIKE '%pg_sleep%'" 2>/dev/null || echo 0)
  if [ "${n:-0}" -ge 1 ]; then concurrent=1; break; fi
  sleep 0.2
done

if [ "$concurrent" -eq 1 ]; then
  pass 'worker-1 is holding its row lock; the second claim is genuinely concurrent'
else
  warn 'could not confirm worker-1 held its lock — the SKIP LOCKED result below may be sequential'
  note 'CONCURRENCY NOT ESTABLISHED: treat the SKIP LOCKED result as inconclusive'
fi

t0=$(date +%s%3N)
q_owner "$(claim_sql worker-2 0)" >"$CLAIM2" 2>&1 || true
t1=$(date +%s%3N)
wait "$w1_pid" || true

c1=$(sed -n 's/^claimed=//p' "$CLAIM1" | head -1)
c2=$(sed -n 's/^claimed=//p' "$CLAIM2" | head -1)
elapsed=$(( t1 - t0 ))
note "worker-1 claimed job '$c1'; worker-2 claimed job '$c2' in ${elapsed}ms"

if [ -z "$c1" ] || [ -z "$c2" ]; then
  fail 'a claimer came back empty — the queue pattern did not hand out a job' \
       "w1='$c1' w2='$c2'; w1 log: $(tr '\n' ' ' <"$CLAIM1")"
else
  assert_ne 'two concurrent claimers received DIFFERENT jobs' "$c1" "$c2"
fi

# The threshold is not invented: worker-1 held its transaction for 6000ms, so anything close
# to that means worker-2 blocked on the lock instead of skipping it.
if [ "$elapsed" -lt 3000 ]; then
  pass "worker-2 did not block on worker-1's lock (${elapsed}ms << 6000ms hold)"
else
  fail 'worker-2 appears to have WAITED for the lock — SKIP LOCKED is not in effect' \
       "${elapsed}ms against a 6000ms hold"
fi

REMAIN=$(q_owner "SELECT 'queued=' || count(*) FROM depsis.job_queue WHERE status = 'queued';")
assert_eq 'exactly one job is left queued after two claims' 1 "$(_field queued "$REMAIN")"

poc_summary
