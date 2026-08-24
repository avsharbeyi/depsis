#!/usr/bin/env bash
#
# Watch the latest CI run, or report one by id, without burning the API budget.
#
# THE BUDGET IS SIXTY REQUESTS AN HOUR for unauthenticated calls, per source address, shared across
# everything on this machine. A thirty-second poll over a five-minute run is ten of them; over a
# thirty-minute run it is sixty, and then nothing can read anything for the rest of the hour —
# including the annotations that say why the run failed. Measured the hard way.
#
# So: three minutes between polls, and one request per poll. A CI run this project produces takes
# four to six minutes, so that is two or three requests to watch one to completion.
#
#   bash tools/dev/ci-watch.sh              # follow the newest run
#   bash tools/dev/ci-watch.sh 32785552822  # report one run and exit
#
# `gh` would authenticate and lift the limit to 5000, and is not assumed: it is not installed here.
set -uo pipefail

REPO="${DEPSIS_CI_REPO:-avsharbeyi/depsis}"
API="https://api.github.com/repos/$REPO"
GAP="${DEPSIS_CI_POLL_SECONDS:-180}"

budget() {
  local left
  left=$(curl -sD - -o /dev/null "https://api.github.com/rate_limit" 2>/dev/null |
    awk 'tolower($1) == "x-ratelimit-remaining:" { print $2 }' | tr -d '\r')
  echo "${left:-?}"
}

run_id="${1:-}"
if [ -z "$run_id" ]; then
  run_id=$(curl -s "$API/actions/runs?per_page=1" |
    python3 -c 'import sys,json;print(json.load(sys.stdin)["workflow_runs"][0]["id"])' 2>/dev/null)
fi
[ -n "$run_id" ] || {
  echo "could not find a run (rate limit? $(budget) requests left this hour)"
  exit 1
}

echo "run $run_id — https://github.com/$REPO/actions/runs/$run_id"

while :; do
  body=$(curl -s "$API/actions/runs/$run_id")
  read -r status conclusion < <(
    echo "$body" | python3 -c 'import sys,json
d=json.load(sys.stdin)
print(d.get("status","?"), d.get("conclusion") or "-")' 2>/dev/null
  )
  echo "$(date +%H:%M:%S)  $status  $conclusion"
  [ "$status" = completed ] && break
  [ "$status" = "?" ] && {
    echo "  (unreadable — $(budget) requests left this hour)"
    exit 1
  }
  sleep "$GAP"
done

echo
curl -s "$API/actions/runs/$run_id/jobs" | python3 -c 'import sys,json
d=json.load(sys.stdin)
for j in d.get("jobs", []):
    print(f"  {str(j.get(\"conclusion\")):<10} {j[\"name\"]}")
    for s in j.get("steps", []):
        if s.get("conclusion") == "failure":
            print(f"      FAILED: {s[\"name\"]}")
    if j.get("conclusion") == "failure":
        print(f"      annotations: {j[\"id\"]}")' 2>/dev/null

echo
echo "budget: $(budget) requests left this hour"
echo "annotations for a failing job:"
echo "  curl -s $API/check-runs/<job id>/annotations"
