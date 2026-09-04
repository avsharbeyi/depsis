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

# TEK BİR CEVAP YETMİYOR, ve bu betik artık gerçekten kırmızı olabildiği için önemli.
#
# Sorgu `gh api ... >/dev/null 2>&1` idi ve tek bir hata "action.yml yok" sayılıyordu. Ölçüldü:
# sekiz referans arka arkaya sorulduğunda her koşumda BAŞKA biri düşüyor — bir koşumda
# actions/checkout@v5 ve dtolnay/rust-toolchain@stable, sonrakinde pnpm/action-setup@v4 — ve
# düşenler tek tek sorulduğunda action.yml döndürüyor. GitHub'ın contents API'si geçici 404
# üretiyor, yani "yok" cevabı da ağ hatası kadar güvenilmez. Kapı `|| true` yüzünden hep 0
# çıktığı sürece bunun bedeli yoktu; şimdi var, ve yanlış kırmızı kapıyı işe yaramaz yapar.
#
# Bu yüzden 404 de yineleniyor: gerçekten action.yml taşımayan bir depo HER denemede 404 der,
# geçici olan ise ilk yinelemede çözülür.
#
# probe_action <owner/repo> <yol> → 0 var, 1 yok (üç denemede de 404), 2 hiç cevap alamadım
#
# Başarı ilk denemede döndüğü için, üç denemenin üçünde de 404 gören bir yol GERÇEKTEN yoktur;
# geçici 404 yinelemede 200'e döner. "Soramadım" ise yalnız hiçbir denemenin net bir cevap
# vermediği hâl: net 404 gördüysek karar odur, aradaki taşıma hatası onu bulandırmaz.
probe_action() {
  local out attempt=1 saw_404=0
  while [ "$attempt" -le 3 ]; do
    out=$(gh api "repos/$1/contents/$2" --jq '.name' 2>&1) && return 0
    case "$out" in
      *'HTTP 404'*|*'Not Found'*) saw_404=1 ;;
      *) printf '  ! %s: %s\n' "$1/$2" "$(head -1 <<<"$out")" >&2 ;;
    esac
    attempt=$((attempt + 1))
    [ "$attempt" -le 3 ] && sleep 2
  done
  [ "$saw_404" = 1 ] && return 1
  return 2
}

# Döngü boru hattının sağ ucunda DEĞİL, süreç ikamesinden besleniyor: boru hattı sağ tarafı bir alt
# kabukta koşturur, orada atanan `bad=1` bu kabuğa hiç dönmez ve betik çözülmeyen bir referansı
# ekrana yazıp yine 0 ile çıkardı — yani kapı vardı ama hiçbir zaman kırmızı olamıyordu.
bad=0
unknown=0
while read -r ref; do
  # docker:// and local ./ references are not repositories.
  case "$ref" in
    docker://*|./*) printf '%-34s %s\n' "$ref" 'yerel/docker — atlandı'; continue ;;
  esac
  repo=${ref%@*}
  # A subdirectory action (owner/repo/path@ref) lives under that path, not at the root.
  owner_repo=$(echo "$repo" | cut -d/ -f1,2)
  sub=$(echo "$repo" | cut -s -d/ -f3-)
  found=''
  failed=0
  for f in action.yml action.yaml; do
    p=${sub:+$sub/}$f
    probe_action "$owner_repo" "$p"
    case $? in
      0) found=$p; break ;;
      2) failed=1; break ;;
    esac
  done
  if [ -n "$found" ]; then
    printf '%-34s OK   (%s)\n' "$ref" "$found"
  elif [ "$failed" = 1 ]; then
    printf '%-34s SORULAMADI — gh yanıt vermedi\n' "$ref"
    unknown=$((unknown + 1))
  else
    printf '%-34s ÇÖZÜLMÜYOR — GitHub bütün dosyayı reddeder\n' "$ref"
    bad=1
  fi
done < <(grep -hoE '^\s*(-\s*)?uses:\s*\S+' "$REPO"/.github/workflows/*.yml \
  | sed -E 's/.*uses:\s*//' | sort -u)

# Çözülmeyen bir referans kapıyı kırmızı yapar; sorulamayan bir referans kapıyı SÖYLEYEREK durdurur.
# İkisini tek çıkış koduna toplamak, ağ yokken her `pnpm check`i "iş akışın bozuk" diye kırmızı
# yapmak demekti — o da kimsenin bakmadığı bir kırmızıya dönüşürdü.
if [ "$bad" -ne 0 ]; then
  exit 1
fi
if [ "$unknown" -gt 0 ]; then
  echo
  echo "$unknown referans sorulamadı: gh oturumu, hız sınırı ya da ağ."
  echo 'gh auth status ile bakın; bu koşum iş akışı dosyaları hakkında bir sonuç vermiyor.'
  exit 2
fi
exit 0
