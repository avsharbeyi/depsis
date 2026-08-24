#!/usr/bin/env bash
# Refresh packages/agent-protocol/schema/agent.schema.json from the binary that owns it.
#
# ADR-0006: the Rust agent defines the trust-boundary contract, so the committed schema is its
# `--emit-schema` output and never hand-written. Run this after any change to `op.rs`.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TERM_COLOR=never
repo=/mnt/c/Users/HUAWEI/Desktop/xdepsisOS
cd "$repo/services/system-agent"
cargo run --quiet -- --emit-schema >"$repo/packages/agent-protocol/schema/agent.schema.json"
echo "schema emitted"
