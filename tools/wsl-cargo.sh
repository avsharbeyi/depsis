#!/usr/bin/env bash
# Run cargo inside the WSL distro that has the Rust toolchain.
#
# The repository lives on the Windows filesystem and the toolchain does not, so every Rust command
# in this project is a `wsl.exe` call. Quoting a PATH assignment through PowerShell into bash is a
# reliable way to lose an argument, so it lives in a file instead.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TERM_COLOR=never
cd /mnt/c/Users/HUAWEI/Desktop/xdepsisOS/services/system-agent
exec cargo "$@"
