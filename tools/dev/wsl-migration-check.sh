#!/usr/bin/env bash
#
# `tools/ci/migration-check.sh` inside the WSL distro that holds PostgreSQL.
#
# The gate proves every migration is reversible by rolling the newest one down and back up, so it
# needs a live PostgreSQL 18 — run from Windows it reports `server_version_num=0` and proves
# nothing while exiting 1, which is the honest failure but not a useful one.
#
# Why a password rather than peer authentication: the script builds connection URLs of the form
# `postgresql://depsis_owner:pw@$PGHOST:$PGPORT/...`, and a socket directory cannot be the host in
# one of those without percent-encoding the path. So the superuser gets a local password, set here
# over the socket where peer authentication does work, and everything else goes over TCP exactly as
# CI does it.
set -euo pipefail
cd /mnt/c/Users/HUAWEI/Desktop/xdepsisOS

pg_isready -q || service postgresql start

SUPER_PW="${SUPER_PW:-ci-super}"
su postgres -c "psql -X -q -c \"ALTER ROLE postgres PASSWORD '$SUPER_PW'\"" >/dev/null

export PGPASSWORD="$SUPER_PW"
# Its own database, and one whose name says so. The gate DROPs and rebuilds whatever it is pointed
# at, and it refuses a name that does not end in _ci or _test precisely so a stray run cannot take
# the development appliance's database with it.
export DB_NAME="${DB_NAME:-depsis_migration_test}"
exec bash tools/ci/migration-check.sh "$@"
