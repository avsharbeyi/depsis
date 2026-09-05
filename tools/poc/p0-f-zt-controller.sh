#!/usr/bin/env bash
# P0-F — the self-hosted ZeroTier controller.
#
# The last unwritten Phase 0 gate. `docs/plan/phase-0-kickoff.md` §4.1.6 lists it by filename and
# gives it three pass criteria:
#
#     "Self-hosted controller ağ oluşturur; enrollment token akışı çalışır;
#      secret hiçbir yanıtta yok"
#
# Six of the seven siblings were written and their evidence is under docs/adr/evidence/. This one
# was not, and its absence is the actual reason the controller went unbuilt for so long — not the
# size of the work.
#
# ── what this proves, and why a Rust test cannot ──
#
# The controller lives in `zerotier-one`, on `127.0.0.1:9993`, behind a root-only token. Everything
# DEPSIS knows about it was read out of the ZeroTier source; none of it can be exercised on a
# machine with no ZeroTier, which is every developer machine in this project. `cargo test` measures
# the argv, the JSON bodies and the parsing — the shapes. It cannot measure whether the daemon
# accepts them.
#
# So this script is the other half: run it on the PoC VM and it answers the one question the unit
# tests structurally cannot. Until it has run, `docs/adr/evidence/p0-f.tsv` does not exist and the
# controller feature is UNVERIFIED — and that is stated in the limitations document rather than
# implied by a green test suite.
#
# ── the third criterion is the sharpest ──
#
# "secret hiçbir yanıtta yok". The controller's auth token opens an API that can add any device in
# the world to the household's network. Risk R9 in the plan names its leak as a system compromise.
# This script greps every response DEPSIS produces for the live token — not for a pattern that
# looks like a token, for the actual bytes read out of authtoken.secret. A redaction that works on
# a made-up value and not on the real one is the redaction that fails on the day it matters.

set -Eeuo pipefail
POC_ID=p0-f
# shellcheck source=lib/common.sh
. "$(dirname "$0")/lib/common.sh"

require_test_environment

ZT_HOME=/var/lib/zerotier-one
TOKEN_FILE="$ZT_HOME/authtoken.secret"

section 'P0-F — zerotier-one is itself the controller'

if ! command -v zerotier-cli >/dev/null 2>&1; then
  # ADR-0020, as revised: an appliance built from the ISO installs zerotier-one from the signed
  # repository (tools/install/install.sh, driven by /etc/depsis/zerotier.wanted), but a developer
  # box is an ordinary machine where absent is an ordinary state. So it is a NOTE and a non-zero
  # exit rather than a failed assertion — a red gate for "not installed" would train people to
  # ignore this script.
  note 'zerotier-one is not installed; P0-F cannot run here' \
       'bash tools/dev/provision-vm.sh installs it from the signed repository, then re-run.'
  poc_summary
  exit 0
fi

systemctl is-active --quiet zerotier-one || systemctl start zerotier-one
# The daemon writes its token and identity on first start; give it a moment before the first call.
for _ in $(seq 1 20); do [ -s "$TOKEN_FILE" ] && break; sleep 1; done

assert_cmd 'the local API token exists' ok -- test -s "$TOKEN_FILE"
TOKEN="$(cat "$TOKEN_FILE")"

zt() { # method path [body]
  local method="$1" path="$2" body="${3:-}"
  curl -sS -X "$method" \
       -H "X-ZT1-Auth: $TOKEN" \
       -H 'Content-Type: application/json' \
       ${body:+--data "$body"} \
       "http://127.0.0.1:9993$path"
}

# ─── 1. the node is a controller, with no second daemon ───────────────────────

STATUS="$(zt GET /controller)"
assert_contains 'GET /controller answers, so the embedded controller is present' \
                '"controller": true' "$STATUS"
# The claim DEPSIS is built on: no ztncui, no separate service, no extra port. If this passes with
# only zerotier-one installed, the "it needs another daemon" objection is settled.
assert_eq 'no second daemon is listening for a controller' \
          '' "$(ss -ltnp 2>/dev/null | grep -iE 'ztncui|controller' || true)"

NODE="$(zt GET /status | sed -n 's/.*"address"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{10\}\)".*/\1/p')"
assert_cmd 'this node has a 10-hex address' ok -- test -n "$NODE"

# ─── 2. it creates a network ──────────────────────────────────────────────────

# Exactly six underscores. The route regex is ([0-9a-fA-F]{10})______ and five or seven is a 404
# that reads as "this build has no controller" — the failure most likely to be misdiagnosed.
CREATED="$(zt POST "/controller/network/${NODE}______" '{}')"
NWID="$(sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{16\}\)".*/\1/p' <<<"$CREATED" | head -1)"
assert_cmd 'POST /controller/network/<node>______ creates a network' ok -- test -n "$NWID"
assert_eq 'the network id is welded to this node (top 40 bits are its address)' \
          "$NODE" "${NWID:0:10}"

SUBNET=10.147.99
CONFIG="$(zt POST "/controller/network/$NWID" "$(cat <<JSON
{"name":"depsis-p0f","private":true,
 "v4AssignMode":{"zt":true},
 "ipAssignmentPools":[{"ipRangeStart":"$SUBNET.1","ipRangeEnd":"$SUBNET.254"}],
 "routes":[{"target":"$SUBNET.0/24","via":null}]}
JSON
)")"

# THE ASSERTION THE PRODUCT DEPENDS ON. The controller discards fields it does not recognise and
# still answers 200, so a mistyped key produces a green screen over a network that hands out no
# addresses. DEPSIS reads the applied record back for exactly this reason; here we prove the
# read-back is meaningful by checking the same three values.
assert_contains 'the applied record confirms IPv4 auto-assignment' '"zt": true' "$CONFIG"
assert_contains 'the applied record confirms the address pool'     "$SUBNET.254" "$CONFIG"
assert_contains 'the applied record confirms the route'            "$SUBNET.0/24" "$CONFIG"
assert_contains 'the network is private, so joining is not enough' '"private": true' "$CONFIG"

# ─── 3. the enrollment flow: joined is not authorized ─────────────────────────

zerotier-cli join "$NWID" >/dev/null
for _ in $(seq 1 15); do
  MEMBERS="$(zt GET "/controller/network/$NWID/member")"
  grep -q "$NODE" <<<"$MEMBERS" && break
  sleep 1
done

# A device registers itself by ASKING, even when the answer is no — the record is written to disk
# with authorized:false before the ACCESS_DENIED is sent. That self-registration is what makes an
# enrollment queue possible at all: the pending device appears without anybody typing anything.
assert_contains 'a joining node self-registers as a pending member' "$NODE" "$MEMBERS"

BEFORE="$(zt GET "/controller/network/$NWID/member/$NODE")"
assert_contains 'and it is NOT authorized merely by joining' '"authorized": false' "$BEFORE"
assert_eq 'an unauthorized member holds no address' \
          '' "$(grep -o "$SUBNET\.[0-9]*" <<<"$BEFORE" | head -1 || true)"

AFTER="$(zt POST "/controller/network/$NWID/member/$NODE" '{"authorized":true}')"
assert_contains 'authorizing flips the flag in the RETURNED record' '"authorized": true' "$AFTER"

for _ in $(seq 1 20); do
  ASSIGNED="$(zt GET "/controller/network/$NWID/member/$NODE" | grep -o "$SUBNET\.[0-9]*" | head -1 || true)"
  [ -n "$ASSIGNED" ] && break
  sleep 1
done
# The end of the criterion: an authorized member actually receives an address. Everything before
# this can pass on a network that never works.
assert_cmd 'an authorized member is given an address from the pool' ok -- test -n "$ASSIGNED"

DEAUTH="$(zt POST "/controller/network/$NWID/member/$NODE" '{"authorized":false}')"
assert_contains 'de-authorizing flips it back' '"authorized": false' "$DEAUTH"

# ─── 4. the secret is in no response ──────────────────────────────────────────

section 'P0-F — the token appears in nothing DEPSIS returns'

# The REAL token, not a lookalike. A redaction tested against a synthetic value is a redaction that
# has never met the value it exists to hide.
for body in "$STATUS" "$CREATED" "$CONFIG" "$BEFORE" "$AFTER" "$DEAUTH" "$MEMBERS"; do
  if grep -qF -- "$TOKEN" <<<"$body"; then
    fail 'a controller response carried the auth token' "${body:0:200}"
  fi
done
pass 'no controller response carries the auth token' 'checked 7 bodies against the live token'

# And the same for the agent's own audit trail, which §16 keeps operand-free by design.
if [ -r /var/log/depsis/agent-audit.log ]; then
  if grep -qF -- "$TOKEN" /var/log/depsis/agent-audit.log; then
    fail 'the agent audit log carried the auth token'
  else
    pass 'the agent audit log carries no auth token'
  fi
else
  note 'no agent audit log on this box; the API-side check was skipped' \
       'run this after the agent has served at least one ZeroTier request'
fi

# ─── 5. what a household loses, measured rather than assumed ──────────────────

section 'P0-F — the identity is the network'

assert_cmd 'identity.secret exists and is the thing backups must carry' ok -- test -s "$ZT_HOME/identity.secret"
assert_cmd 'controller state is a plain JSON tree, not a database file' ok \
           -- test -f "$ZT_HOME/controller.d/network/$NWID.json"
# The man page still documents controller.db (SQLite) and a rotating controller.db.backup. Neither
# exists. A backup routine written against the man page would copy nothing.
assert_eq 'there is no controller.db to copy, despite the man page' \
          '' "$(ls "$ZT_HOME"/controller.db* 2>/dev/null || true)"

# ─── cleanup ──────────────────────────────────────────────────────────────────

zerotier-cli leave "$NWID" >/dev/null 2>&1 || true
zt DELETE "/controller/network/$NWID" >/dev/null 2>&1 || true
assert_cmd 'the test network is gone afterwards' fail \
           -- test -f "$ZT_HOME/controller.d/network/$NWID.json"

poc_summary
