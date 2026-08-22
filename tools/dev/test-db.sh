#!/usr/bin/env bash
#
# Builds the databases the integration suites run against, and prints the four URLs they need.
#
# This exists because working it out from scratch costs half an hour every time. The suites skip
# themselves unless their environment variables are set, and a skipped suite reports as a pass —
# so "the tests are green" and "the tests ran" are different statements unless something sets
# these up.
#
# TWO databases, not one, and the second one is the whole reason this script grew:
#
#   depsis_apitest        migrated and CLAIMED by whatever the tests seed
#   depsis_setup_apitest  migrated and NEVER claimed
#
# `setup.integration.test.ts` measures the one-time claim — that the token works once, that a
# second claim is refused, that an unclaimed server says so. It cannot run against a database
# some other suite has already claimed, so it asks for its own pair of URLs. Until this script
# created it, those eleven tests skipped silently on every local run and only CI ever executed
# them. Eleven tests that never run are eleven tests that are not there.
#
#   bash tools/dev/test-db.sh              # rebuild, then print the four URLs
#   eval "$(bash tools/dev/test-db.sh -e)" # ...and export them into this shell
#
set -euo pipefail

DB_NAME="${DB_NAME:-depsis_apitest}"
SETUP_DB_NAME="${SETUP_DB_NAME:-depsis_setup_apitest}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
SUPERUSER="${SUPERUSER:-postgres}"
# The SAME passwords `tools/dev/up.sh` sets, and that is deliberate rather than lazy. Roles are
# cluster objects: `depsis_app` has one password for every database on the server. When this script
# picked its own, running it broke the development appliance's connection string and running the
# appliance broke this one's — each fixing itself by breaking the other, which took a round of
# "password authentication failed" to see.
APP_PW="${APP_PW:-ci-app}"
OWNER_PW="${OWNER_PW:-ci-owner}"

export_form=0
[ "${1:-}" = '-e' ] && export_form=1

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Run as the superuser over the local socket: peer authentication needs no password, which is one
# fewer secret to place. Everything the suites themselves do goes over TCP as depsis_app or
# depsis_owner, exactly as the API does.
su_psql() { psql -X -q -At -v ON_ERROR_STOP=1 -U "$SUPERUSER" -d "$1" "${@:2}"; }

# Cluster-wide, because roles are cluster objects. Said out loud because it will break any other
# database on this cluster whose connection strings use these roles. Done once, before either
# database is built, so both end up reachable with the same credentials.
su_psql postgres -c "ALTER ROLE depsis_owner PASSWORD '$OWNER_PW'" >/dev/null 2>&1 || true
su_psql postgres -c "ALTER ROLE depsis_app   PASSWORD '$APP_PW'"   >/dev/null 2>&1 || true

build() {
  local name="$1"
  su_psql postgres -c "DROP DATABASE IF EXISTS $name WITH (FORCE)" >/dev/null

  # bootstrap.sql creates the database, the roles, and the extensions the schema needs. The
  # migrations refuse to run without it — `unaccent` and `pg_trgm` are checked by name.
  su_psql postgres -v db_name="$name" -f "$here/packages/db/bootstrap.sql" >/dev/null

  # bootstrap.sql may reset the role passwords, so they are set again after it rather than only
  # before. Cheap, and it removes an ordering question nobody should have to think about.
  su_psql postgres -c "ALTER ROLE depsis_owner PASSWORD '$OWNER_PW'" >/dev/null
  su_psql postgres -c "ALTER ROLE depsis_app   PASSWORD '$APP_PW'"   >/dev/null

  # Migrated as the OWNER, never as the superuser: a superuser silently bypasses row-level
  # security, so a schema that only works because it was created by one would pass here and fail
  # in production.
  ( cd "$here/packages/db" \
    && DEPSIS_MIGRATION_DATABASE_URL="postgresql://depsis_owner:$OWNER_PW@$PGHOST:$PGPORT/$name" \
       npx node-pg-migrate -d DEPSIS_MIGRATION_DATABASE_URL -m migrations -t depsis_migrations \
         --advisory-lock-mode wait --no-single-transaction up >/dev/null )
}

build "$DB_NAME"
build "$SETUP_DB_NAME"

emit() {
  if [ "$export_form" = 1 ]; then printf 'export %s=%s\n' "$1" "$2"; else printf '%s=%s\n' "$1" "$2"; fi
}

emit DEPSIS_TEST_DATABASE_URL             "postgresql://depsis_app:$APP_PW@$PGHOST:$PGPORT/$DB_NAME"
emit DEPSIS_TEST_OWNER_DATABASE_URL       "postgresql://depsis_owner:$OWNER_PW@$PGHOST:$PGPORT/$DB_NAME"
emit DEPSIS_TEST_SETUP_DATABASE_URL       "postgresql://depsis_app:$APP_PW@$PGHOST:$PGPORT/$SETUP_DB_NAME"
emit DEPSIS_TEST_SETUP_OWNER_DATABASE_URL "postgresql://depsis_owner:$OWNER_PW@$PGHOST:$PGPORT/$SETUP_DB_NAME"
