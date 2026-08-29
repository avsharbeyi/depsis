#!/usr/bin/env bash
#
# Rust kapısı — CI'ın `system-agent` işiyle BİREBİR aynı komutlar.
#
# Bu betiğin var olma sebebi ölçülmüş bir hata: yerel alışkanlık `cargo clippy -- -D warnings`
# koşuyordu, CI ise `--all-targets` ile koşuyor. Fark tek kelime ama kapsamı büyük — `--all-targets`
# TEST kodunu da denetliyor. `procs.rs`'in test modülü, diğer bütün test modüllerinin taşıdığı
# `#[allow(clippy::unwrap_used, ...)]` bloğunu taşımıyordu; yerelde hiç görünmedi, CI'da on dört
# hatayla düştü ve `main` günlerce kırmızı kaldı.
#
# Komutlar .github/workflows/ci.yml'den kopyalanmıştır ve orayla birlikte değişmelidir. Sondaki
# Windows çapraz denetimi ADR-0006'nın çekirdek iddiası (ajan platformdan bağımsız derlenebilmeli)
# ve kendi betiğinde duruyor: tools/wsl-cargo-windows-check.sh.
set -euo pipefail

run() {
  printf '\n→ cargo %s\n' "$*"
  bash "$(dirname "${BASH_SOURCE[0]}")/../wsl-cargo.sh" "$@"
}

run fmt --all -- --check
run clippy --locked --all-targets -- -D warnings
run test --locked --all

printf '\nRust kapısı geçti (fmt · clippy --all-targets · test).\n'
