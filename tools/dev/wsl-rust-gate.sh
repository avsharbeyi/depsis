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

# Windows çapraz denetimi de BU kapıda, ayrı bir betikte değil — ve bunun kendi bedeli ödendi:
# ayrı durduğu için koşulmuyordu, ve dispatch.rs'e giren iki doğrudan Unix çağrısı (bir
# MetadataExt, bir rustix::process) ancak CI'da yakalandı. ADR-0006'nın çekirdek iddiası bu:
# dağıtıcı platformdan bağımsız derlenebilmeli, çünkü platforma bağlı olan her şey seam'in
# arkasında durmalı. Bir kapı, iddiayı sınayan adımı dışarıda bırakırsa iddiayı korumaz.
printf '
-> cargo check --target x86_64-pc-windows-msvc
'
bash "$(dirname "${BASH_SOURCE[0]}")/../wsl-cargo-windows-check.sh"

# ŞEMA TAZE Mİ — CI'ın bu işteki beşinci adımı, ve yine yalnız burada sınanabilir: sınırın
# sözleşmesini ikili üretiyor (ADR-0006), depodaki JSON onun bir KOPYASI, ve bir kopya ancak
# biri onu aslıyla karşılaştırdığı sürece dürüst kalır. op.rs değişip şema yenilenmezse
# TypeScript tarafı var olmayan bir ajanı tarif eder.
printf '
-> sema tazeligi (--emit-schema, depodakiyle karsilastirma)
'
here="$(dirname "${BASH_SOURCE[0]}")"
emitted="$(mktemp)"
trap 'rm -f "$emitted"' EXIT
bash "$here/../wsl-cargo.sh" run --quiet -- --emit-schema >"$emitted"
if ! diff -u "$here/../../packages/agent-protocol/schema/agent.schema.json" "$emitted"; then
  printf '
HATA: agent.schema.json bayat. Tazelemek icin:
'
  printf '  bash tools/wsl-emit-schema.sh && pnpm --filter @depsis/agent-protocol generate
'
  exit 1
fi

printf '
Rust kapisi gecti (fmt - clippy --all-targets - test - Windows caprazi - sema).
'
