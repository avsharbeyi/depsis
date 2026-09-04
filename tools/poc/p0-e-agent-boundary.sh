#!/usr/bin/env bash
# P0-E — prove threat-model boundary TB4: the line between the unprivileged API and the root
# system agent.
#
# TB4 is described in the threat model as the most critical boundary in DEPSIS, and until this
# script runs it is the only one with no evidence behind it. ADR-0006 is `Accepted (provisional,
# P0-E)` for exactly that reason: it makes four behavioural claims that documentation cannot
# settle.
#
#   1. There is no way to ask the agent to run an arbitrary command. Not a hidden variant, not a
#      pass-through argument, not a string that reaches a shell.
#   2. Caller identity comes from the kernel (SO_PEERCRED) and nothing on the wire can influence
#      it — including a request that literally says {"uid":0}.
#   3. `acltype=nfsv4` is unrepresentable. P0-B measured nfsv4 reporting itself as configured
#      while enforcing nothing, so a typo in a config file must not be able to produce a dataset
#      that silently enforces no ACLs.
#   4. The core compiles for a non-Unix target, i.e. the platform-specific code really is
#      confined to one module. This is the claim most likely to rot silently, because nothing
#      about day-to-day work on a Linux box would ever reveal a stray `cfg`.
#
# It also measures one thing the unit file argues about rather than asserts: whether a dataset
# created *through the agent* is visible to the rest of the system. If systemd's sandboxing puts
# the service in a private mount namespace, `zfs create` mounts the dataset where only the agent
# can see it, the agent reports success, and Samba serves an empty directory. No error anywhere.
# That is the Phase 0 failure signature, so it gets a measurement rather than an argument.

POC_ID=p0-e
# shellcheck source=lib/common.sh
. "$(dirname "$(readlink -f "$0")")/lib/common.sh"

require_test_environment

AGENT_SRC="${DEPSIS_AGENT_SRC:-$HOME/agent}"
INSTALL_DIR=/usr/local/lib/depsis
SOCKET_PATH=/run/depsis/agent.sock
API_USER=depsis-api
API_GROUP=depsis-api
OTHER_USER=depsis_poc_mallory
TEST_DS="$DEPSIS_TEST_POOL/agentds"

# ─── helpers ──────────────────────────────────────────────────────────────────

# Send one envelope to the agent as a given user, print the response line.
#
# Written in Python rather than socat because socat is not installed by default and because a
# raw socket gives us control over the exact bytes: several assertions below depend on sending
# something deliberately malformed, which a convenience wrapper would normalise away.
agent_call() {
  local as_user="$1" payload="$2"
  # The payload goes in on stdin rather than argv. Linux caps one argv entry at MAX_ARG_STRLEN
  # (32 pages = 128 kB), so the 400 kB over-size case below failed with E2BIG before exec and
  # took the whole run down with rc=126. stdin has no such limit and preserves the bytes exactly,
  # which matters because several assertions turn on the presence of a trailing newline.
  printf '%s' "$payload" | runuser -u "$as_user" -- python3 -c '
import socket, sys
payload = sys.stdin.buffer.read()
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(20)
try:
    s.connect(sys.argv[1])
except OSError as e:
    print("CONNECT_ERROR: %s" % e)
    sys.exit(0)
s.sendall(payload)
s.shutdown(socket.SHUT_WR)
buf = b""
while b"\n" not in buf:
    chunk = s.recv(65536)
    if not chunk:
        break
    buf += chunk
sys.stdout.write(buf.decode(errors="replace").strip() or "NO_RESPONSE")
' "$SOCKET_PATH" 2>&1
}

envelope() { # op-json [reason]
  # Note there is no trailing newline: command substitution strips it anyway, so every call
  # below exercises the "client sent a complete request and shut down its write side" path.
  # That path is what P0-E's first run caught the agent mishandling.
  printf '{"correlation_id":"p0e-%s","reason":"%s","request":%s}' \
    "$RANDOM" "${2:-p0-e assertion}" "$1"
}

# The pool is not shared state between PoCs: each one creates and destroys its own, so that a
# run never depends on which script happened to go first. P0-E needs one only for section 8,
# where it asks the agent to create a real dataset.
if ! zpool list -H -o name 2>/dev/null | grep -qx "$DEPSIS_TEST_POOL"; then
  mapfile -t VDEVS < <(poc_vdevs 2)
  [ "${#VDEVS[@]}" -ge 2 ] || { fail 'could not find two by-id vdevs'; poc_summary; }
  zpool create -f -m "$DEPSIS_POC_ROOT" "$DEPSIS_TEST_POOL" mirror "${VDEVS[0]}" "${VDEVS[1]}"     || { fail 'zpool create failed'; poc_summary; }
  note "created $DEPSIS_TEST_POOL for this run" "${VDEVS[0]} + ${VDEVS[1]}"
  POOL_IS_OURS=1
fi

# ─── 1. build ─────────────────────────────────────────────────────────────────
section '1. Build the agent from source'

if [ ! -f "$AGENT_SRC/Cargo.toml" ]; then
  fail "agent source not found at $AGENT_SRC" \
       "set DEPSIS_AGENT_SRC, or copy services/system-agent to the VM"
  poc_summary
fi

export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
# RUSTUP_HOME too, not just CARGO_HOME. `cargo` in ~/.cargo/bin is a rustup shim that resolves
# the toolchain from RUSTUP_HOME; under sudo that defaults to /root/.rustup, which is empty, and
# every cargo invocation fails with "could not choose a version of cargo to run". The first P0-E
# run recorded four failures that were entirely this.
export RUSTUP_HOME="${RUSTUP_HOME:-$(dirname "$CARGO_HOME")/.rustup}"
export PATH="$CARGO_HOME/bin:$PATH"
export CARGO_TERM_COLOR=never

RUSTC_V=$(rustc --version 2>&1 || echo 'rustc missing')
note "toolchain: $RUSTC_V"
# ADR-0006 pins 1.97.1. A different toolchain is not automatically wrong, but it means the
# evidence in this file was gathered on something other than the pinned version, and that must
# be visible in the record rather than inferred later from a timestamp.
case "$RUSTC_V" in
  *1.97.1*) pass 'toolchain matches the ADR-0006 pin (1.97.1)' "$RUSTC_V" ;;
  *)        warn "toolchain is NOT the pinned 1.97.1 — evidence recorded against $RUSTC_V"
            note 'toolchain differs from ADR-0006 pin' "$RUSTC_V" ;;
esac

cd "$AGENT_SRC" || { fail "cannot cd to $AGENT_SRC"; poc_summary; }

assert_cmd 'cargo build --release succeeds'                ok   -- cargo build --release
assert_cmd 'cargo test passes (unit + openat2 containment)' ok  -- cargo test --all-targets
assert_cmd 'clippy is clean under the crate denials'       ok   -- cargo clippy --all-targets -- -D warnings
assert_cmd 'cargo fmt --check: source matches rustfmt.toml' ok  -- cargo fmt --check

# Claim 4. The check that would otherwise never be run on a Linux box.
if rustup target list --installed 2>/dev/null | grep -q x86_64-pc-windows-msvc; then
  assert_cmd 'the core compiles for x86_64-pc-windows-msvc (ADR-0006 portability claim)' ok \
    -- cargo check --target x86_64-pc-windows-msvc
else
  warn 'x86_64-pc-windows-msvc target not installed; portability claim NOT tested'
  note 'ADR-0006 portability claim untested in this run' \
       'run: rustup target add x86_64-pc-windows-msvc'
fi

BIN="$AGENT_SRC/target/release/depsis-agent"
[ -x "$BIN" ] || { fail 'release binary missing after build'; poc_summary; }

# ─── 2. the operation surface, read off the shipped binary ────────────────────
section '2. The operation surface as the binary itself reports it'

# Not the source, not the ADR — the schema the running binary emits, which is also what the
# TypeScript side is generated from. If these two ever disagree, the generated types are a
# fiction and the API is coding against something that does not exist.
SCHEMA=$("$BIN" --emit-schema 2>&1) || fail '--emit-schema failed' "$SCHEMA"

# Structure, not prose. P0-E's first run grepped the raw JSON text and produced two false
# UNEXPECTEDs: "nfsv4" appears in the doc comment that explains why nfsv4 is absent, and "raw" is
# a field of the smartctl RESPONSE. Both are correct code and neither is a request-side hole.
# Reading the schema as a document instead of as a wall of text is the difference.
REQ=$(jq -c '.request' <<<"$SCHEMA") || { fail 'request schema is not valid JSON'; poc_summary; }

OPS=$(jq -r '[.. | objects | select(.properties?.op?.const) | .properties.op.const] | unique | join(",")' <<<"$REQ")
note "operations advertised by the binary: $OPS"
note "operation count: $(tr ',' '\n' <<<"$OPS" | grep -c .)"

# CONTAINMENT, not an exact list. This used to assert the set was EXACTLY the seven Phase 0
# operations, which turned every later phase into a red run of this script: the agent carries
# dozens of operations now and the assertion measured the calendar, not the boundary. What TB4
# actually needs from §2 is that the seven are still there and that no operation smuggles a
# command or a path — the loop below — so the check is "still present", plus a diff against the
# hand-maintained schema that the TypeScript side is generated from.
for op in create_dataset create_snapshot diff_snapshots ping pool_status \
          publish_samba_config read_smart_summary; do
  if grep -qw -- "$op" <<<"${OPS//,/ }"; then
    pass "the binary still advertises the Phase 0 operation '$op'"
  else
    fail "the Phase 0 operation '$op' is gone from the binary's schema" "$OPS"
  fi
done

# The generated TypeScript is only true if the shipped schema file and the shipped binary agree.
# Skipped rather than failed when the repository is not on this box: the PoC's own layout only
# guarantees $DEPSIS_AGENT_SRC and $DEPSIS_UNIT_SRC.
SCHEMA_FILE="${DEPSIS_AGENT_SCHEMA:-$HOME/packages/agent-protocol/schema/agent.schema.json}"
if [ -f "$SCHEMA_FILE" ]; then
  FILE_OPS=$(jq -r '[.request | .. | objects | select(.properties?.op?.const) | .properties.op.const]
                    | unique | join(",")' <"$SCHEMA_FILE")
  assert_eq 'the checked-in agent.schema.json advertises the same operations as the binary' \
    "$OPS" "$FILE_OPS"
else
  warn "no agent.schema.json at $SCHEMA_FILE; binary-vs-schema comparison NOT tested"
  note 'binary-vs-schema operation comparison skipped' \
       "set DEPSIS_AGENT_SCHEMA to packages/agent-protocol/schema/agent.schema.json"
fi

# Claim 1: no operation carries a free-form command, argument vector or path. Checked against
# the set of property NAMES the request schema actually declares.
PROPS=$(jq -r '[.. | objects | select(has("properties")) | .properties | keys[]] | unique | join(" ")' <<<"$REQ")
note "every property name in the request schema: $PROPS"
for forbidden in raw command cmd exec shell args argv script path passthrough; do
  if grep -qw -- "$forbidden" <<<"$PROPS"; then
    unexpected "the request schema declares a property named '$forbidden'" "$PROPS"
  else
    pass "no request property named '$forbidden'"
  fi
done

# Claim 3: read the enum's permitted values, not the prose around them.
ACL=$(jq -r '[(.["$defs"].AclType // .definitions.AclType).oneOf[].const] | sort | join(",")' <<<"$REQ")
assert_eq 'AclType permits exactly one value, and it is posixacl' 'posixacl' "$ACL"

# ─── 3. install ───────────────────────────────────────────────────────────────
section '3. Install the unit files and start the socket'

getent group  "$API_GROUP" >/dev/null || groupadd --system "$API_GROUP"
getent passwd "$API_USER"  >/dev/null || \
  useradd --system --gid "$API_GROUP" --home-dir /nonexistent --shell /usr/sbin/nologin "$API_USER"
id -u "$OTHER_USER" >/dev/null 2>&1 || useradd -m "$OTHER_USER"

API_UID=$(id -u "$API_USER")
note "api uid = $API_UID"

install -d -m 0755 "$INSTALL_DIR" /etc/depsis
install -m 0755 "$BIN" "$INSTALL_DIR/depsis-agent"
# DEPSIS_SHARES_ROOT too, not just the uid. Without it the agent starts but refuses every
# transfer at runtime ("transfers will be refused"), which reads as a broken boundary in §4-9
# rather than as a PoC that under-configured its own agent.
install -d -m 0755 "$DEPSIS_POC_ROOT/shares"
{
  printf 'DEPSIS_API_UID=%s\n' "$API_UID"
  printf 'DEPSIS_SHARES_ROOT=%s\n' "$DEPSIS_POC_ROOT/shares"
} > /etc/depsis/agent.env
chmod 0644 /etc/depsis/agent.env

UNIT_SRC="${DEPSIS_UNIT_SRC:-$HOME/deploy/systemd}"
if [ ! -f "$UNIT_SRC/depsis-agent.socket" ]; then
  fail "unit files not found at $UNIT_SRC"; poc_summary
fi
# BOTH sockets. depsis-agent.service carries `Requires=depsis-agent.socket
# depsis-agent-data.socket`, so installing only the control socket left the service unstartable:
# the first client connection failed the dependency, systemd never ran the agent, and every
# measurement from §4 onwards came back NO_RESPONSE — a red run that said nothing about TB4.
install -m 0644 "$UNIT_SRC/depsis-agent.socket" "$UNIT_SRC/depsis-agent-data.socket" \
  "$UNIT_SRC/depsis-agent.service" /etc/systemd/system/
systemctl daemon-reload

assert_cmd 'systemd-analyze verify accepts both units' ok \
  -- systemd-analyze verify /etc/systemd/system/depsis-agent.socket

systemctl stop depsis-agent.service depsis-agent.socket depsis-agent-data.socket 2>/dev/null || true
assert_cmd 'depsis-agent.socket starts' ok -- systemctl start depsis-agent.socket
assert_cmd 'depsis-agent-data.socket starts' ok -- systemctl start depsis-agent-data.socket

# The service must NOT be running yet — that is the whole point of socket activation.
if systemctl is-active --quiet depsis-agent.service; then
  unexpected 'the service is running before any client connected' \
             'socket activation is not actually deferring startup'
else
  pass 'the service is not running until a client connects (socket activation)'
fi

# ─── 3a. which hardening directives cost a mount namespace ────────────────────
section '3a. Sandboxing directives, measured one at a time'

# The unit file used to assert, from reading the documentation, that its hardening set created
# no mount namespace. Two of the directives did, and the consequence was invisible: a dataset
# created through the agent mounted where only the agent could see it, while `zfs list` on the
# host showed it existing and the agent returned success. The claim is therefore measured here,
# per directive — so the next person to add one has a way to check rather than a paragraph to
# trust.
HOST_MNT_NS=$(readlink /proc/1/ns/mnt)
note "systemd $(systemctl --version | head -1 | awk '{print $2}'), pid 1 mnt ns $HOST_MNT_NS"

# Read the directives out of the installed unit rather than a list kept here, so a directive
# added to the unit is measured automatically instead of quietly escaping the check.
while IFS= read -r d; do
  [ -n "$d" ] || continue
  ns=$(systemd-run -q --wait --pipe -p "$d" readlink /proc/self/ns/mnt 2>/dev/null)
  if [ -z "$ns" ]; then
    fail "could not evaluate directive: $d"
  elif [ "$ns" = "$HOST_MNT_NS" ]; then
    pass "stays in pid 1's mount namespace: $d"
  else
    unexpected "creates a private mount namespace: $d" \
               'zfs mounts made by the agent would be invisible to Samba'
  fi
done < <(grep -E '^(NoNewPrivileges|RestrictAddressFamilies|IPAddressDeny|RestrictNamespaces|RestrictRealtime|RestrictSUIDSGID|LockPersonality|SystemCallArchitectures|Protect[A-Za-z]+|CapabilityBoundingSet|SystemCallFilter)=' \
          /etc/systemd/system/depsis-agent.service)

# The two that were measured unsafe for this workload, kept as a standing check. If a future
# systemd stops namespacing for them, this turns into an UNEXPECTED and says so, rather than the
# unit file silently carrying an out-of-date reason.
for d in ProtectKernelModules=yes ProtectKernelLogs=yes; do
  ns=$(systemd-run -q --wait --pipe -p "$d" readlink /proc/self/ns/mnt 2>/dev/null)
  if [ -n "$ns" ] && [ "$ns" != "$HOST_MNT_NS" ]; then
    pass "still namespaces, still correctly absent from the unit: $d"
  else
    unexpected "$d no longer creates a mount namespace" \
               'the unit file could adopt it again — its comment is now out of date'
  fi
done

# ─── 4. the socket is the first authorization gate ────────────────────────────
section '4. Socket DAC — the gate that acts before the agent reads a byte'

[ -S "$SOCKET_PATH" ] && pass "socket exists at $SOCKET_PATH" || fail "no socket at $SOCKET_PATH"
assert_eq 'socket mode is 0660'      '660'         "$(stat -c '%a' "$SOCKET_PATH")"
assert_eq 'socket owner is root'     'root'        "$(stat -c '%U' "$SOCKET_PATH")"
assert_eq "socket group is $API_GROUP" "$API_GROUP" "$(stat -c '%G' "$SOCKET_PATH")"

# An unprivileged user outside the group must be stopped by the kernel, not by the agent.
OUT=$(agent_call "$OTHER_USER" "$(envelope '{"op":"ping"}')")
assert_contains 'a user outside depsis-api cannot even connect (EACCES from the kernel)' \
  'CONNECT_ERROR' "$OUT"

# ─── 5. identity comes from the kernel ────────────────────────────────────────
section '5. SO_PEERCRED — claim 2'

OUT=$(agent_call "$API_USER" "$(envelope '{"op":"ping"}')")
assert_contains 'the API can ping the agent' '"status":"ok"' "$OUT"
# The framing regression, pinned here as well as in the crate's unit tests: a complete request
# followed by shutdown(SHUT_WR) and no trailing newline must be answered, not called oversized.
if grep -q 'exceeds' <<<"$OUT"; then
  fail 'a complete request with no trailing newline was reported as oversized' "$OUT"
else
  pass 'a request with no trailing newline is answered normally'
fi
OUT_NL=$(agent_call "$API_USER" "$(printf '{"correlation_id":"p0e-nl","reason":"with newline","request":{"op":"ping"}}\n')")
assert_contains 'a request WITH a trailing newline is answered too' '"status":"ok"' "$OUT_NL"
assert_contains 'ping returns the schema version, so a mismatched build fails loudly' \
  '"schema_version"' "$OUT"

# Root is refused. Not a security control — root could bypass the socket entirely — but a root
# script driving privileged ZFS operations must not be able to do so while appearing in the
# audit trail as the API.
OUT=$(agent_call root "$(envelope '{"op":"ping"}')")
assert_contains 'root is refused even though it can open the socket' '"status":"refused"' "$OUT"
assert_contains 'the refusal says why'  'root is not the API' "$OUT"

# The wire cannot influence identity. This request claims to be uid 0 in three different places.
OUT=$(agent_call "$API_USER" \
  '{"correlation_id":"p0e-spoof","reason":"spoof attempt","uid":0,"peer":{"uid":0},"request":{"op":"ping"}}')
assert_contains 'a request asserting uid 0 is still treated as the API, not as root' \
  '"status":"ok"' "$OUT"

# ─── 6. no free-form command exists ───────────────────────────────────────────
section '6. Claim 1 — against the running daemon, not the source'

for attempt in \
  '{"op":"exec","command":"id"}' \
  '{"op":"raw","argv":["/bin/sh","-c","id"]}' \
  '{"op":"ping","extra":"; id"}' \
  '{"op":"pool_status","pool":"depsistest; id"}' \
  '{"op":"pool_status","pool":"-o"}' \
  '{"op":"create_snapshot","dataset":"depsistest","name":"../../etc/shadow"}' \
  '{"op":"read_smart_summary","disk_by_id":"../../../dev/sda"}' \
  '{"op":"create_dataset","dataset":"depsistest/x","acltype":"nfsv4"}' \
  ; do
  OUT=$(agent_call "$API_USER" "$(envelope "$attempt")")
  # "refused" alone is not good enough. On the first run every one of these "passed" while the
  # agent was actually refusing them for being over the size limit — eight green lines that
  # proved nothing. The refusal has to name a parse failure, which is the only outcome that
  # demonstrates the type system stopped it.
  if grep -q 'unparseable request' <<<"$OUT"; then
    pass "refused at parse: $attempt"
  elif grep -q '"status":"refused"' <<<"$OUT"; then
    unexpected "refused, but not at parse — check why: $attempt" "$OUT"
  elif grep -q '"status":"failed"' <<<"$OUT"; then
    # A `failed` here would mean the request PARSED and reached an executor. For these inputs
    # that is the wrong answer even though nothing bad happened: it means the type system did
    # not stop it and only the external command's own error did.
    unexpected "reached an executor instead of being refused at parse: $attempt" "$OUT"
  else
    unexpected "NOT refused: $attempt" "$OUT"
  fi
done

# A typo in a field name must be a refusal, not a silently missing parameter. Serde's default
# is to ignore an unrecognised field, which would mean an API sending `refquota` instead of
# `refquota_bytes` gets a dataset with no quota at all and a success response. P0-E is where that
# was noticed; `deny_unknown_fields` is where it was fixed.
OUT=$(agent_call "$API_USER" "$(envelope '{"op":"create_dataset","dataset":"depsistest/typo","acltype":"posixacl","refquota":100}')")
assert_contains 'a misspelled field is refused rather than ignored' 'unparseable request' "$OUT"
if zfs list -H -o name depsistest/typo >/dev/null 2>&1; then
  unexpected 'the typo request created a dataset anyway' 'quota-less dataset from a typo'
else
  pass 'no dataset was created by the refused request'
fi

# ─── 7. the envelope cannot forge an audit entry ──────────────────────────────
section '7. Audit-log integrity'

OUT=$(agent_call "$API_USER" \
  '{"correlation_id":"p0e-inject","reason":"ok\ndepsis-agent: {\"audit\":1,\"operation\":\"forged\"}","request":{"op":"ping"}}')
assert_contains 'a reason containing a newline is refused (log injection)' \
  'control characters' "$OUT"

BIG=$(python3 -c 'print("x"*300)')
OUT=$(agent_call "$API_USER" "{\"correlation_id\":\"p0e\",\"reason\":\"$BIG\",\"request\":{\"op\":\"ping\"}}")
# Specifically the reason-length rule, not the request-size rule: 'exceeds' alone matched both.
assert_contains 'an over-long reason is refused' "field 'reason' exceeds" "$OUT"

OUT=$(agent_call "$API_USER" '{"op":"ping"}')
assert_contains 'a bare request with no envelope is refused (would be unattributable)' \
  'correlation_id' "$OUT"

HUGE=$(python3 -c 'print("{\"correlation_id\":\"a\",\"reason\":\"b\",\"request\":{\"op\":\"ping\",\"pad\":\"" + "x"*400000 + "\"}}")')
OUT=$(agent_call "$API_USER" "$HUGE")
if grep -qE '"status":"(refused|failed)"' <<<"$OUT"; then
  pass 'a 400 kB request is refused rather than buffered'
else
  unexpected 'an over-size request was not refused' "${OUT:0:200}"
fi

# The audit trail must name the operation and never the request body.
sleep 1
JOURNAL=$(journalctl -u depsis-agent -o cat --since '-3 minutes' 2>/dev/null)
assert_contains 'the journal carries structured audit entries' '"audit":1' "$JOURNAL"
assert_contains 'an audit entry names the operation'           '"operation":"ping"' "$JOURNAL"
assert_contains 'the refusal of root is in the audit trail'    '"outcome":"refused"' "$JOURNAL"
if grep -q 'forged' <<<"$JOURNAL"; then
  unexpected 'the injected text reached the journal' 'log injection succeeded'
else
  pass 'the injected audit line never reached the journal'
fi

# ─── 8. a real privileged operation, and whether anyone else can see it ───────
section '8. A real operation — and the mount-namespace trap'

zfs destroy -r "$TEST_DS" 2>/dev/null || true
OUT=$(agent_call "$API_USER" \
  "$(envelope "{\"op\":\"create_dataset\",\"dataset\":\"$TEST_DS\",\"acltype\":\"posixacl\",\"refquota_bytes\":33554432}")")
assert_contains 'the agent creates a dataset when properly asked' '"status":"created"' "$OUT"

if zfs list -H -o name "$TEST_DS" >/dev/null 2>&1; then
  pass 'the dataset exists outside the agent'
else
  fail 'the dataset does not exist outside the agent' "$OUT"
fi

# THE measurement this section exists for. A private mount namespace would make the mount
# invisible here while the agent reported success.
MP=$(zfs get -H -o value mountpoint "$TEST_DS" 2>/dev/null)
if grep -qF " $MP " /proc/1/mountinfo; then
  pass "the dataset is mounted in pid 1's namespace, i.e. visible to Samba" "$MP"
else
  fail "dataset created but NOT mounted in pid 1's namespace — the silent-empty-share trap" \
       "mountpoint=$MP; check the sandboxing directives in depsis-agent.service"
fi

assert_eq 'the created dataset really has posixacl' 'posix' \
  "$(zfs get -H -o value acltype "$TEST_DS" 2>/dev/null | sed 's/^posixacl$/posix/')"
assert_eq 'refquota was applied as asked' '33554432' \
  "$(zfs get -Hp -o value refquota "$TEST_DS" 2>/dev/null)"

# ─── 8b. NO_XDEV against a real dataset boundary ──────────────────────────────
section '8b. NO_XDEV — a nested dataset is a mount, not a subdirectory'

# ADR-0006 item 5. This cannot be shown in the crate's own tests: they run in a tempdir on ext4,
# where there is no boundary to cross, so the assertion would pass while proving nothing. On a
# DEPSIS box every share is a dataset and every nested dataset is a separate mount, which is
# exactly the shape that lets a caller walk out of the share they were confined to.
zfs create "$TEST_DS/nested" 2>/dev/null || zfs create -p "$TEST_DS/nested"
XROOT=$(zfs get -H -o value mountpoint "$TEST_DS")
if [ "$(stat -c '%d' "$XROOT")" = "$(stat -c '%d' "$XROOT/nested")" ]; then
  fail 'the nested dataset is not a separate mount; the NO_XDEV test would prove nothing' \
       "same st_dev on $XROOT and $XROOT/nested"
else
  pass 'the nested dataset really is a separate mount (different st_dev)'
  assert_cmd 'openat2 NO_XDEV refuses to cross into the nested dataset' ok \
    -- env DEPSIS_XDEV_ROOT="$XROOT" DEPSIS_XDEV_CHILD=nested \
       cargo test --manifest-path "$AGENT_SRC/Cargo.toml" \
       --bin depsis-agent -- --ignored --exact unix::tests::no_xdev_refuses_crossing_into_a_nested_mount
fi
zfs destroy -r "$TEST_DS/nested" 2>/dev/null || true

# ─── 8c. no secret reaches the agent's environment ────────────────────────────
section '8c. What the privileged process carries in its environment'

# ADR-0006 item 7 asked whether a `LoadCredential=` secret leaks into logs or /proc/<pid>/environ.
# The unit ships no LoadCredential= at all, because the agent has no secret: the only thing it is
# configured with is the API's uid, which is not confidential. Item 7 is therefore not applicable
# as written — and the useful assertion is the one that keeps it that way, since the day someone
# adds a database password to that EnvironmentFile is the day it starts appearing in a
# world-readable /proc entry.
AGENT_PID=$(systemctl show -p MainPID --value depsis-agent.service)
if [ -z "$AGENT_PID" ] || [ "$AGENT_PID" = 0 ]; then
  fail 'the agent is not running; cannot inspect its environment'
else
  ENVIRON=$(tr '\0' '\n' < "/proc/$AGENT_PID/environ")
  note "agent environment: $(tr '\n' ' ' <<<"$ENVIRON")"
  assert_contains 'the agent has the API uid in its environment' 'DEPSIS_API_UID=' "$ENVIRON"
  for pattern in PASSWORD SECRET TOKEN CREDENTIAL PRIVATE_KEY DATABASE_URL; do
    if grep -q "$pattern" <<<"$ENVIRON"; then
      unexpected "the agent's environment contains '$pattern'" \
                 'a secret in EnvironmentFile= is readable from /proc — use LoadCredential='
    else
      pass "no '$pattern' in the agent's environment"
    fi
  done
  if grep -q 'LoadCredential' /etc/systemd/system/depsis-agent.service; then
    note 'the unit now uses LoadCredential=' 'ADR-0006 item 7 becomes testable as written'
  else
    pass 'the unit declares no LoadCredential=, consistent with the agent having no secret'
  fi
fi

# ─── 9. the agent survives what it refuses ────────────────────────────────────
section '9. Robustness of the listener'

MAIN_PID_BEFORE=$(systemctl show -p MainPID --value depsis-agent.service)
for junk in '' 'not json' '[]' 'null' '{"correlation_id":1,"reason":2,"request":3}'; do
  agent_call "$API_USER" "$junk" >/dev/null 2>&1 || true
done
OUT=$(agent_call "$API_USER" "$(envelope '{"op":"ping"}')")
MAIN_PID_AFTER=$(systemctl show -p MainPID --value depsis-agent.service)

assert_contains 'the agent still answers after a run of malformed input' '"status":"ok"' "$OUT"
assert_eq 'the agent did not restart (no crash on malformed input)' \
  "$MAIN_PID_BEFORE" "$MAIN_PID_AFTER"

# ─── cleanup ──────────────────────────────────────────────────────────────────
section 'Cleanup'
zfs destroy -r "$TEST_DS" 2>/dev/null || true
systemctl stop depsis-agent.service depsis-agent.socket depsis-agent-data.socket 2>/dev/null || true
userdel -r "$OTHER_USER" 2>/dev/null || true
[ "${POOL_IS_OURS:-0}" = 1 ] && cleanup_pool
info 'units left installed but stopped; binary left in place for re-runs'

poc_summary
