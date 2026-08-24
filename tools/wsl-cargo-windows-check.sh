#!/usr/bin/env bash
#
# `cargo check --target x86_64-pc-windows-msvc`, which is the gate CI calls the Windows cross-check.
#
# WHY IT EXISTS AS ITS OWN SCRIPT. ADR-0006's central claim is that the agent's core — request
# dispatch, authorization, audit — contains no `cfg` attributes and compiles everywhere, with
# every platform-specific thing behind one of four seams. That claim is only worth anything if
# something checks it, and `cargo test` on Linux does not: a `std::os::unix` import that leaks into
# the core passes every local gate and fails only here.
#
# `check` and not `build`: the target's std is enough to typecheck against, and no MSVC linker is
# needed. That is what lets this run in the same Linux distro as everything else.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TERM_COLOR=never
cd /mnt/c/Users/HUAWEI/Desktop/xdepsisOS

rustup target add x86_64-pc-windows-msvc >/dev/null
exec cargo check --locked --target x86_64-pc-windows-msvc "$@"
