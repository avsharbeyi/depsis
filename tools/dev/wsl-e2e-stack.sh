#!/usr/bin/env bash
#
# `tools/dev/e2e-stack.sh` inside the WSL distro that holds PostgreSQL.
#
# The other two WSL-needing gates have a wrapper (wsl-itest.sh, wsl-migration-check.sh) and this —
# the one with by far the most setup — did not, so every session rediscovered the same two things:
# the service is not running, and the superuser password is not what the script defaults to.
#
# The stack runs INSIDE the distro and the Playwright run happens on Windows against 127.0.0.1;
# that works because WSL2 forwards localhost. Bring it up here, then from Windows:
#
#   bash tools/dev/wsl-e2e-stack.sh          # up; writes e2e/.env.stack
#   pnpm test:e2e                            # from Windows, against what it wrote
#   bash tools/dev/wsl-e2e-stack.sh --down   # stop the five processes
set -euo pipefail
cd /mnt/c/Users/HUAWEI/Desktop/xdepsisOS

pg_isready -q || service postgresql start

# The same password wsl-migration-check.sh sets, and set the same way — over the local socket where
# peer authentication works. Sharing one value between the two wrappers is the point: a box where
# one of them has run is a box where the other one works.
SUPER_PW="${SUPER_PW:-ci-super}"
su postgres -c "psql -X -q -c \"ALTER ROLE postgres PASSWORD '$SUPER_PW'\"" >/dev/null
export PGPASSWORD="$SUPER_PW"

# ── an ordinary account for the API ───────────────────────────────────────────
#
# The agent's `Policy` compares SO_PEERCRED against DEPSIS_API_UID and refuses uid 0 outright, so
# the API may not be root — and in this distro everything is root. Without an account here the
# stack still comes up, but with NO agent: everything that moves bytes answers 503 and nine of
# e2e/files.spec.ts's twelve tests gate themselves out with `test.fixme`. They report as skipped
# rather than as passing, which is honest and still means the file tests did not run.
API_USER="${DEPSIS_E2E_API_USER:-depsis-e2e}"
if ! id -u "$API_USER" >/dev/null 2>&1; then
  echo "creating the unprivileged account '$API_USER' for the API to run as"
  useradd --system --create-home --shell /usr/sbin/nologin "$API_USER"
fi
export DEPSIS_E2E_API_USER="$API_USER"

# Cargo lives in root's home and is not on a non-login shell's PATH; the stack script builds the
# agent when the binary is missing or stale.
export PATH="$HOME/.cargo/bin:$PATH"

exec bash tools/dev/e2e-stack.sh "$@"
