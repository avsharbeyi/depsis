#!/usr/bin/env bash
#
# Does every `uses:` in the workflows actually resolve to an action?
#
# actionlint does NOT check this — it validates syntax and contexts, not whether the repository on
# the other side of a `uses:` contains an `action.yml`. A reference that does not resolve makes
# GitHub reject the ENTIRE workflow at build time, which is invisible: the run is a zero-second
# `startup_failure` with no name and no log.
#
# Found the hard way: a step added to lint the workflows referenced `rhysd/actionlint@main`, which
# is the tool's source repository and carries no action.yml. The lint step broke the file it was
# there to protect.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Windows: gh is installed outside the default PATH of a non-login shell.
[ -d "/c/Program Files/GitHub CLI" ] && export PATH="$PATH:/c/Program Files/GitHub CLI"
command -v gh >/dev/null || { echo "gh gerekiyor: winget install GitHub.cli, sonra gh auth login"; exit 2; }

bad=0
grep -hoE '^\s*(-\s*)?uses:\s*\S+' "$REPO"/.github/workflows/*.yml \
  | sed -E 's/.*uses:\s*//' | sort -u | while read -r ref; do
  # docker:// and local ./ references are not repositories.
  case "$ref" in
    docker://*|./*) printf '%-34s %s\n' "$ref" 'yerel/docker — atlandı'; continue ;;
  esac
  repo=${ref%@*}
  # A subdirectory action (owner/repo/path@ref) lives under that path, not at the root.
  owner_repo=$(echo "$repo" | cut -d/ -f1,2)
  sub=$(echo "$repo" | cut -s -d/ -f3-)
  found=''
  for f in action.yml action.yaml; do
    p=${sub:+$sub/}$f
    if gh api "repos/$owner_repo/contents/$p" --jq '.name' >/dev/null 2>&1; then
      found=$p
      break
    fi
  done
  if [ -n "$found" ]; then
    printf '%-34s OK   (%s)\n' "$ref" "$found"
  else
    printf '%-34s ÇÖZÜLMÜYOR — GitHub bütün dosyayı reddeder\n' "$ref"
    bad=1
  fi
done
