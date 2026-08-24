#!/usr/bin/env bash
#
# One integration suite, with the four database URLs already in the environment.
#
# `wsl-itest.sh` runs everything, which is right for a gate and wrong for looking at one failure:
# on this checkout the whole suite is a minute and a half, and the interesting output is buried in
# a hundred lines of DEBUG from the other forty-six files.
#
#   bash tools/dev/wsl-itest-one.sh src/contract.test.ts
set -euo pipefail
cd /mnt/c/Users/HUAWEI/Desktop/xdepsisOS

pg_isready -q || service postgresql start

# As the `postgres` OS user, for the reason wsl-itest.sh gives: test-db.sh reaches the superuser
# over the local socket where authentication is `peer`, so running it as root fails.
eval "$(su postgres -c "cd $PWD && bash tools/dev/test-db.sh -e")"

# The workspace packages, because vitest is invoked DIRECTLY below and therefore does not
# get `test:unit`'s `dependsOn: ["^build"]`. `@depsis/contracts`, `@depsis/agent-protocol`
# and `@depsis/authz` resolve through their `dist/`, and without this a clean checkout
# fails with "Failed to resolve entry for package" — which is exactly how CI failed the
# first time it ever ran, in the job that copies this command.
pnpm build >/dev/null
exec pnpm --filter @depsis/api exec vitest run "$@"
