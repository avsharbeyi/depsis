#!/usr/bin/env bash
#
# Run the integration suites inside the WSL distro that holds PostgreSQL.
#
# `tools/dev/test-db.sh` prints the four URLs the suites need; without them every DB-backed test
# skips itself, and a skipped suite reports as a pass. This wrapper exists so "the tests ran" is
# one command rather than a remembered sequence — the same reason test-db.sh exists.
#
#   bash tools/dev/wsl-itest.sh                        # every integration suite
#   bash tools/dev/wsl-itest.sh shares                 # only files matching 'shares'
set -euo pipefail
cd /mnt/c/Users/HUAWEI/Desktop/xdepsisOS

pg_isready -q || service postgresql start

# As the `postgres` OS user: test-db.sh reaches the superuser over the local socket, where
# authentication is `peer` — it maps the OS user to the role of the same name, so running it as
# root fails with "Peer authentication failed for user postgres" no matter what password is set.
eval "$(su postgres -c "cd $PWD && bash tools/dev/test-db.sh -e")"

# The workspace packages, because vitest is invoked DIRECTLY below and therefore does not
# get `test:unit`'s `dependsOn: ["^build"]`. `@depsis/contracts`, `@depsis/agent-protocol`
# and `@depsis/authz` resolve through their `dist/`, and without this a clean checkout
# fails with "Failed to resolve entry for package" — which is exactly how CI failed the
# first time it ever ran, in the job that copies this command.
pnpm build >/dev/null
exec pnpm --filter @depsis/api exec vitest run "$@"
