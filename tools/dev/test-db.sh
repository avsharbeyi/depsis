#!/usr/bin/env bash
#
# Builds the database the integration suites run against, and prints the two URLs they need.
#
# This exists because working it out from scratch costs half an hour every time. The suites skip
# themselves unless `DEPSIS_TEST_DATABASE_URL` and `DEPSIS_TEST_OWNER_DATABASE_URL` are set, and a
# skipped suite reports as a pass — so "the tests are green" and "the tests ran" are different
# statements unless something sets these up.
#
# The database is DEDICATED and recreated from nothing each time. Sharing one with
# tools/ci/migration-check.sh does not work: that script randomises the cluster's role passwords
# and leaves fixture rows behind, which made a suite's result depend on what had run before it.
#
#   bash tools/dev/test-db.sh              # rebuild, then print the two URLs
#   eval "$(bash tools/dev/test-db.sh -e)" # ...and export them into this shell
#
set -euo pipefail

DB_NAME="${DB_NAME:-depsis_apitest}"
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

su_psql postgres -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE)" >/dev/null

# bootstrap.sql creates the database, the roles, and the extensions the schema needs. The
# migrations refuse to run without it — `unaccent` and `pg_trgm` are checked by name.
su_psql postgres -v db_name="$DB_NAME" -f "$here/packages/db/bootstrap.sql" >/dev/null

# Cluster-wide, because roles are cluster objects. Said out loud because it will break any other
# database on this cluster whose connection strings use these roles.
su_psql postgres -c "ALTER ROLE depsis_owner PASSWORD '$OWNER_PW'" >/dev/null
su_psql postgres -c "ALTER ROLE depsis_app   PASSWORD '$APP_PW'"   >/dev/null

APP_URL="postgresql://depsis_app:$APP_PW@$PGHOST:$PGPORT/$DB_NAME"
OWNER_URL="postgresql://depsis_owner:$OWNER_PW@$PGHOST:$PGPORT/$DB_NAME"

# Migrated as the OWNER, never as the superuser: a superuser silently bypasses row-level security,
# so a schema that only works because it was created by one would pass here and fail in production.
( cd "$here/packages/db" && DEPSIS_MIGRATION_DATABASE_URL="$OWNER_URL" \
  npx node-pg-migrate -d DEPSIS_MIGRATION_DATABASE_URL -m migrations -t depsis_migrations \
    --advisory-lock-mode wait --no-single-transaction up >/dev/null )

if [ "$export_form" = 1 ]; then
  printf 'export DEPSIS_TEST_DATABASE_URL=%s\n' "$APP_URL"
  printf 'export DEPSIS_TEST_OWNER_DATABASE_URL=%s\n' "$OWNER_URL"
else
  printf 'DEPSIS_TEST_DATABASE_URL=%s\n' "$APP_URL"
  printf 'DEPSIS_TEST_OWNER_DATABASE_URL=%s\n' "$OWNER_URL"
fi
