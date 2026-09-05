#!/usr/bin/env bash
#
# Bir servisin BAŞLAMAK İÇİN ŞART KOŞTUĞU her ortam değişkeni, kurulumun o servise verdiği env
# dosyasına gerçekten yazılıyor mu?
#
# ── bu kapının var olma nedeni ────────────────────────────────────────────────
#
# Yönetici konsolu sahaya çıktığı günden beri hiç açılmamıştı. `depsis-console --serve`
# "DEPSIS_API_UID is unset; refusing to start" deyip 3 milisaniyede çıkıyor, systemd beş kez
# deneyip soketi kilitliyor, ve kullanıcının gördüğü tek cümle "Konsol servisi çalışmıyor"
# oluyordu.
#
# Üç parça ayrı ayrı doğruydu. Konsol, uid'i ortamdan okuyup uid 0'ı reddediyor (ADR-0018) —
# doğru. Birim dosyası `EnvironmentFile=/etc/depsis/console.env` diyor ve açıklamasında "written
# by the installer" yazıyor — doğru. Kurulum `DEPSIS_API_UID`i yazıyor — ama `agent.env`e.
# Yanlış olan, aralarındaki SÖZLEŞMEYDİ, ve hiçbir test bir sözleşmeye bakmıyordu.
#
# Böyle bir kusurun birim testiyle yakalanması yapı olarak mümkün değil: üç dosyanın hiçbiri tek
# başına hatalı değil. Uçtan uca kurulum koşturmak yakalardı, ama tam kurulum PostgreSQL, nginx,
# ZFS ve servis hesapları ister — bir yazım hatasını yakalamak için ağır bir bedel. Bu betik
# aradaki yolu tutuyor: kimin neyi şart koştuğunu KAYNAKTAN, kimin nereden okuduğunu BİRİM
# DOSYASINDAN, kimin ne yazdığını KURULUM BETİĞİNDEN okuyup üçünü karşılaştırıyor.
#
# Elle tutulan bir liste YOK, ve bu bilinçli: listeye yeni bir değişken eklemeyi unutmak, tam da
# burada düzeltilen hatanın kendisidir.

set -Eeuo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL="$REPO/tools/install/install.sh"
UNITS="$REPO/deploy/systemd"

fail=0
note() { printf '  %s\n' "$1"; }
bad() { printf '  ✗ %s\n' "$1"; fail=1; }
good() { printf '  ✓ %s\n' "$1"; }

# Bir env dosyasını yazan blok: kurulum betiğinde o dosyaya ilk değinen satırdan, o dosyanın
# `chmod`una kadar. Kurulum her env dosyasını tek ve bitişik bir blokta yazıyor; blok bittiğinde
# izinleri veriliyor. Bloğun dışında geçen bir değişken adı bu dosyaya yazıldığını KANITLAMAZ —
# hatanın kendisi tam olarak buydu: `DEPSIS_API_UID` betikte vardı, ama başka bir dosyanın
# bloğunda.
#
# Dosya ADIYLA aranıyor, tam yoluyla değil: birim `/etc/depsis/console.env` diyor, kurulum
# `"$ETC/console.env"` yazıyor, ve tam yol kurulum betiğinde hiç geçmiyor.
#
# Blok bir YORUM satırıyla başlayamaz. Kurulum betiği yoğun yorumlu, ve bir dosyadan söz eden
# açıklama satırı bloğu erken başlatsaydı, bir önceki dosyanın yazdıkları bu dosyaya sayılırdı —
# yakalaması gereken hatayı kaçıran bir kapı olurdu.
env_block() {
  local file
  file="$(basename "$1")"
  awk -v f="$file" '
    !seen && index($0, f) > 0 && $0 !~ /^[[:space:]]*#/ { seen = 1 }
    seen && $0 !~ /^[[:space:]]*#/ { print }
    seen && $0 ~ ("chmod .*" f) { exit }
  ' "$INSTALL"
}

printf '→ servislerin şart koştuğu ortam değişkenleri\n'

for manifest in "$REPO"/services/*/Cargo.toml; do
  service_dir="$(dirname "$manifest")"
  binary="$(awk -F'"' '/^name = /{print $2; exit}' "$manifest")"
  unit="$UNITS/$binary.service"

  # ŞART KOŞULAN DEĞİŞKENLER, kaynaktan. İkili, eksik değişkeni tam olarak bu cümleyle
  # reddediyor; cümleyi arayarak listeyi ikilinin kendisinden almış oluyoruz.
  #
  # Cümlenin başındaki tırnak ARANMIYOR: ajan `"depsis-agent: DEPSIS_API_UID is unset…"` diye
  # yazıyor, konsol `"DEPSIS_API_UID is unset…"` diye. İkisini de tutan şey değişken adının
  # kendisi ve onu izleyen ` is unset`.
  mapfile -t required < <(
    grep -rhoE 'DEPSIS_[A-Z_]+ is unset' "$service_dir/src" 2>/dev/null |
      sed 's/ is unset$//' | sort -u
  )
  [ "${#required[@]}" -gt 0 ] || continue

  if [ ! -f "$unit" ]; then
    bad "$binary: birim dosyası yok ($unit)"
    continue
  fi

  # Birimin okuduğu env dosyaları ve doğrudan verdiği değişkenler.
  mapfile -t env_files < <(
    grep -oE '^EnvironmentFile=-?[^ ]+' "$unit" | sed 's/^EnvironmentFile=-\?//'
  )
  inline="$(grep -oE '^Environment=[A-Z_]+=' "$unit" | sed 's/^Environment=//; s/=$//' || true)"

  for var in "${required[@]}"; do
    if printf '%s\n' "$inline" | grep -qx "$var"; then
      good "$binary: $var birim dosyasında doğrudan veriliyor"
      continue
    fi
    if [ "${#env_files[@]}" -eq 0 ]; then
      bad "$binary: $var şart ama birim ne EnvironmentFile okuyor ne de değişkeni kendi veriyor"
      continue
    fi

    written=no
    for env_file in "${env_files[@]}"; do
      if env_block "$env_file" | grep -q "$var="; then
        good "$binary: $var → $env_file (kurulum yazıyor)"
        written=yes
        break
      fi
    done
    if [ "$written" = no ]; then
      bad "$binary: $var şart, birim onu ${env_files[*]} dosyasından bekliyor, ama kurulum o dosyaya yazmıyor"
      note "kurulum betiği başka bir env dosyasına yazıyor olabilir; servisin okuduğu dosya bu değil"
    fi
  done
done

# ── YETKİLİ KONSOLUN İKİ YARISI AYNI YERDEN GELMELİ ──────────────────────────
#
# `DEPSIS_CONSOLE_PRIVILEGED=1` tek başına bir şey yapmıyor: konsol, bayrak 1 iken kendi uid'i 0
# değilse başlamayı REDDEDİYOR (`session.rs`). Yani bayrağın ikinci yarısı `User=root`.
#
# Uzun süre o ikinci yarı, operatörün `depsis-console.service`i ELLE düzenlemesiyle veriliyordu ve
# belgelenen yol buydu. Ama kurulum `deploy/systemd/*` birimlerini her güncellemede KOŞULSUZ üzerine
# yazıyor: elle konan `User=root` sessizce geri alınıyor, `console.env`deki 1 yerinde kalıyor, ve
# konsol bir daha hiç açılmıyor — arayüzde görünen tek şey "Konsol servisi çalışmıyor".
#
# Karar artık console.env'de, `User=root` satırını kurulum bir drop-in olarak yazıyor. Bu kontrol
# o düzenin iki tarafını da yerinde tutuyor: birim dosyası root ÇALIŞTIRMAMALI (yoksa bayrak 0 iken
# root bir kabuk açılırdı) ve kurulum drop-in'i yazmayı bırakmamalı (yoksa bayrak 1 iken konsol
# hiç açılmaz).
printf '\n→ yetkili konsolun iki yarısı\n'

CONSOLE_UNIT="$UNITS/depsis-console.service"
if [ ! -f "$CONSOLE_UNIT" ]; then
  bad "konsol birimi yok ($CONSOLE_UNIT)"
elif grep -qE '^User=root[[:space:]]*$' "$CONSOLE_UNIT"; then
  bad 'depsis-console.service `User=root` taşıyor; ayrıcalık kararı console.env ve drop-in ile verilir'
else
  good 'depsis-console.service ayrıcalıksız hesapla koşuyor'
fi

if grep -q 'depsis-console.service.d' "$INSTALL"; then
  good 'kurulum ayrıcalık drop-in dosyasını yönetiyor (depsis-console.service.d)'
else
  bad 'kurulum depsis-console.service.d drop-in dosyasını yazmıyor: DEPSIS_CONSOLE_PRIVILEGED=1 hiç yürürlüğe girmez'
  note 'birim her güncellemede üzerine yazıldığı için elle konan User=root kalıcı olamaz'
fi

if [ "$fail" -ne 0 ]; then
  printf '\nBirim ile kurulum arasındaki sözleşme tutmuyor: bir servis, kurulumun ona vermediği\n' >&2
  printf 'bir ayarı şart koşuyor. Böyle bir servis kurulduğu gün başlamaz ve hatası ancak\n' >&2
  printf 'kullanıcı o ekrana girince, sebebini söylemeyen bir cümleyle görülür.\n' >&2
  exit 1
fi
printf '\nEnv sözleşmesi tutuyor.\n'
