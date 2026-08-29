#!/usr/bin/env bash
#
# İş akışı kapısı: `pnpm lint:workflows`.
#
# Bu betiğin var olma sebebi ölçülmüş bir hata. Kapı önceden doğrudan `actionlint` çağırıyordu,
# actionlint hiçbir yerde kurulu değildi, ve `lint:workflows` de `check`in içinde değildi — yani
# kapı VARDI ama hiç koşmadı. O aralıkta bir adıma ikinci bir `env:` anahtarı girdi; GitHub dosyayı
# reddetti, koşum sıfır saniyede `startup_failure` verdi ve hiçbir iş çalışmadı.
#
# Bu yüzden zorunlu olan kısım kurulum istemeyen kısım: depoda duran iki denetim. actionlint varsa
# ayrıca koşuyor, yoksa yokluğu söyleniyor ve kapı yeşil kalıyor — kurulu olmayan bir araç yüzünden
# her yerel `pnpm check`in düşmesi, kapıyı kimsenin koşmamasıyla biten yolun ta kendisi.
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

node tools/ci/workflow-lint.mjs
bash tools/ci/check-action-refs.sh

if command -v actionlint >/dev/null 2>&1; then
  actionlint .github/workflows/*.yml
  printf 'actionlint temiz.\n'
else
  printf 'actionlint kurulu degil, atlandi (kurmak icin: go install github.com/rhysd/actionlint/cmd/actionlint@latest).\n'
fi
