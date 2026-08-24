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
exec pnpm --filter @depsis/api exec vitest run "$@"
