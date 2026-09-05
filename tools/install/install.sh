#!/usr/bin/env bash
#
# DEPSIS — denetlenebilir bootstrap installer.
#
# §19'un istediği şey: "Temiz Debian Stable üzerinde imzalı .deb/repository veya DENETLENEBİLİR
# bootstrap installer" ve "Installer: donanım kontrolü, port çakışması, disk planı, hostname, TLS,
# ilk admin, ZeroTier modu, recovery key" ile "Kurulum script'i idempotent; yarıda kesilirse
# güvenle devam eder veya geri alır".
#
# ── bu betiğin var olma nedeni ───────────────────────────────────────────────
#
# Bu depoda çalışan bir API, çalışan bir ajan, otuz beş migration ve tam bir arayüz var. Hiçbirine
# gerçek bir kutuda ULAŞILAMIYORDU: `deploy/systemd/` birimleri kimsenin kurmadığı dosyalar,
# `apps/web/dist` kimsenin sunmadığı bir paket, ve TLS diye bir şey yoktu. Yazılmış olan bir
# ürün, kurulamıyorsa henüz bir ürün değil.
#
# ── idempotentlik ve yarıda kesilme ──────────────────────────────────────────
#
# Her adım ÖNCE BAKAR, sonra yapar. Bu, bir durum dosyasından güçlü: durum dosyası "adım 6 bitti"
# der ve adım 6'nın ürünü el ile silinmişse yalan söyler. Betiği ikinci kez çalıştırmak, birinci
# çalıştırmanın yarıda kaldığı yeri bulup oradan devam etmekle aynı şey, ve her şey yerindeyse
# hiçbir şeyi değiştirmez.
#
# GERİ ALMA YAPILMIYOR, ve bunu söylemek gizlemekten iyi. Yarıda kesilen bir kurulumu geri almak,
# veritabanını düşürmek demek olurdu — ve o veritabanı ikinci denemede zaten kaldığı yerden
# kullanılabilir durumda. Bir adım düşerse betik hangi adımda düştüğünü, kutunun o anda hangi
# hâlde olduğunu ve yeniden çalıştırmanın güvenli olduğunu söyleyip duruyor.
#
# ── kurmadığı şeyler ─────────────────────────────────────────────────────────
#
#   ZFS havuzu   — kurulum sihirbazının işi (§8.1'in sırası: analiz, plan, yazılı onay, yeniden
#                  kimlik doğrulama). Bu betik diskleri LİSTELER ve planı sihirbaza bırakır.
#   ZeroTier     — paket firstboot'un işi (cihazla gelir); bu betik varsa bulur ve söyler.
#   Samba        — aynı ayrım: paketi firstboot kurar, bu betik yalnız BAĞLAR (samba_conf).
#   PostgreSQL   — dağıtımın paketi. Erişilebilir olmasını ister, kurmaz.
#   İlk yönetici — /setup/claim, tarayıcıdan. Betik adresi ve jetonun nerede olduğunu yazar.
#
# ── kullanım ─────────────────────────────────────────────────────────────────
#
#   sudo bash tools/install/install.sh --hostname depsis --shares-root /srv/depsis
#   sudo bash tools/install/install.sh --check-only          yalnız ön kontroller
#   sudo bash tools/install/install.sh --renew-cert          sertifikayı yenile ve çık

set -Eeuo pipefail

# corepack, pnpm'i İLK kullanımda indirir ve varsayılan olarak SORAR; stdin'i olmayan bir
# kurulumda o soru EOF ile ölür. Soru kapalı: indirme zaten corepack'in işi.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ─── ayarlar ──────────────────────────────────────────────────────────────────

PREFIX=/usr/local/lib/depsis
ETC=/etc/depsis
VAR=/var/lib/depsis
TLS_DIR="$ETC/tls"
NGINX_SITE=/etc/nginx/sites-available/depsis.conf
NGINX_ENABLED=/etc/nginx/sites-enabled/depsis.conf
NGINX_HEADERS=/etc/nginx/snippets/depsis-headers.conf
API_PREFIX=/api/v1/

HOSTNAME_WANTED=''
SERVER_NAME=''
API_PORT=3000
DB_NAME=depsis
DB_HOST=127.0.0.1
DB_PORT=5432
DB_SUPERUSER=postgres
SHARES_ROOT=/srv/depsis
SHARE_PARENT_DATASET=''
ZFS_POOLS=''
SMART_DISKS=''
WANT_HSTS=no
CHECK_ONLY=no
RENEW_CERT=no
SKIP_BUILD=no
UNATTENDED=no

# ─── çıktı ────────────────────────────────────────────────────────────────────

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; Z=$'\033[0m'
else B=''; G=''; Y=''; R=''; D=''; Z=''; fi

# ── süperkullanıcı psql'i ─────────────────────────────────────────────────────
#
# Yerel bir kutuda süperkullanıcıya giden DOĞRU yol soket + peer kimlik doğrulamasıdır: taze bir
# PostgreSQL kurulumunda `postgres` rolünün TCP parolası YOKTUR — ve olmaması doğrudur, o parola
# kimsenin bilmediği bir sır olarak kalmalıdır. İlk saha kurulumu bunu öğretti: betik 127.0.0.1'e
# parolayla bağlanmaya çalışıp durdu, oysa root'uz ve `runuser` ile postgres kullanıcısı olarak
# doğrudan bağlanabiliriz. Uzak bir --db-host verilirse TCP + PGPASSWORD yolu duruyor.
PSQL_LOCAL=no

adminq() {
  if [ "$PSQL_LOCAL" = yes ]; then
    runuser -u postgres -- psql -qX -p "$DB_PORT" "$@"
  else
    psql -qX -h "$DB_HOST" -p "$DB_PORT" -U "$DB_SUPERUSER" "$@"
  fi
}

STEP=''
step()  { STEP="$1"; printf '%s→ %s%s\n' "$B" "$1" "$Z"; }
ok()    { printf '  %s✓%s %s\n' "$G" "$Z" "$1"; }
same()  { printf '  %s·%s %s\n' "$D" "$Z" "$1"; }
warn()  { printf '  %s!%s %s\n' "$Y" "$Z" "$1"; }
die()   { printf '%sHATA%s %s\n' "$R" "$Z" "$1" >&2; exit 1; }

# Hangi adımda düştüğünü söyleyen tuzak. Bir kurulum betiğinin en kötü davranışı, yarıda ölüp
# operatöre nerede olduğunu söylememektir — çünkü o zaman tek güvenli hamle her şeyi silmek gibi
# görünür, ve silinecek şeylerin arasında veritabanı vardır.
on_error() {
  local code=$?
  printf '\n%sKurulum "%s" adımında durdu (çıkış %s).%s\n' "$R" "${STEP:-başlangıç}" "$code" "$Z" >&2
  printf 'Kutu şu anda YARIM bir kurulumda: buraya kadarki adımlar yapıldı, sonrakiler yapılmadı.\n' >&2
  printf 'Sorunu giderdikten sonra AYNI komutu yeniden çalıştırın — her adım önce bakıp sonra\n' >&2
  printf 'yaptığı için tamamlananlar atlanır ve kurulum kaldığı yerden sürer.\n' >&2
  exit "$code"
}
trap on_error ERR

# ─── argümanlar ───────────────────────────────────────────────────────────────

while [ $# -gt 0 ]; do
  case "$1" in
    --hostname)             HOSTNAME_WANTED="${2:?}"; shift 2 ;;
    --server-name)          SERVER_NAME="${2:?}"; shift 2 ;;
    --api-port)             API_PORT="${2:?}"; shift 2 ;;
    --db-name)              DB_NAME="${2:?}"; shift 2 ;;
    --db-host)              DB_HOST="${2:?}"; shift 2 ;;
    --db-port)              DB_PORT="${2:?}"; shift 2 ;;
    --db-superuser)         DB_SUPERUSER="${2:?}"; shift 2 ;;
    --shares-root)          SHARES_ROOT="${2:?}"; shift 2 ;;
    --share-parent-dataset) SHARE_PARENT_DATASET="${2:?}"; shift 2 ;;
    --zfs-pools)            ZFS_POOLS="${2:?}"; shift 2 ;;
    --smart-disks)          SMART_DISKS="${2:?}"; shift 2 ;;
    --hsts)                 WANT_HSTS=yes; shift ;;
    --check-only)           CHECK_ONLY=yes; shift ;;
    --renew-cert)           RENEW_CERT=yes; shift ;;
    --skip-build)           SKIP_BUILD=yes; shift ;;
    # Gözetimsiz kip (kurulum ISO'sunun ilk açılışı): çıktı journal'a gider ve journal KALICIDIR,
    # o yüzden kurtarma anahtarı ekrana basılmaz — yalnız dosyasının yolu söylenir.
    --unattended)           UNATTENDED=yes; shift ;;
    -h|--help)              sed -n '2,45p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)                      die "bilinmeyen seçenek: $1" ;;
  esac
done

[ -n "$HOSTNAME_WANTED" ] || HOSTNAME_WANTED="$(hostname)"
[ -n "$SERVER_NAME" ]     || SERVER_NAME="$HOSTNAME_WANTED"
case "$DB_HOST" in 127.0.0.1|localhost|::1) PSQL_LOCAL=yes ;; esac

# ─── 1. ön kontroller ─────────────────────────────────────────────────────────
#
# §19'un "donanım kontrolü, port çakışması" maddesi. Hepsi kurulumdan ÖNCE, çünkü yarıda düşen bir
# kurulumu toplamak, hiç başlamamış olandan pahalı.

preflight() {
  step 'ön kontroller'
  local fatal=0

  [ "$(id -u)" -eq 0 ] || die 'root gerekiyor: sudo ile çalıştırın'
  ok 'root'

  [ "$(ps -p 1 -o comm=)" = systemd ] || die 'pid 1 systemd değil; bu kurulum systemd birimleri kuruyor'
  ok 'systemd pid 1'

  # Debian dışı bir dağıtım bir RET değil bir UYARI: birim dosyaları ve yollar Debian'a göre
  # yazıldı, ama systemd'si ve nginx'i olan bir kutuda çalışmaması için bir neden yok. Yanlış
  # olabilecek şeyi söyleyip devam etmek, çalışacak bir kurulumu reddetmekten iyi.
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    case "${ID:-}:${ID_LIKE:-}" in
      debian:*|*:*debian*) ok "dağıtım: ${PRETTY_NAME:-$ID}" ;;
      *) warn "dağıtım Debian türevi değil (${PRETTY_NAME:-${ID:-bilinmiyor}}); yollar Debian'a göre" ;;
    esac
  fi

  case "$(uname -m)" in
    x86_64|aarch64) ok "mimari: $(uname -m)" ;;
    *) die "desteklenmeyen mimari: $(uname -m) (x86_64 ya da aarch64 gerekiyor)" ;;
  esac

  # Bellek. 2 GiB altı reddediliyor: PostgreSQL, Node API'si, worker ve ajan aynı kutuda, ve
  # 2 GiB'nin altında ilk indeksleme işi OOM killer'a takılıyor.
  local mem_kb; mem_kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
  if   [ "$mem_kb" -lt 2000000 ]; then printf '  %s✗%s bellek %s MiB — en az 2 GiB gerekiyor\n' "$R" "$Z" "$((mem_kb/1024))"; fatal=1
  elif [ "$mem_kb" -lt 4000000 ]; then warn "bellek $((mem_kb/1024)) MiB — çalışır, 4 GiB önerilir"
  else ok "bellek $((mem_kb/1024)) MiB"; fi

  # Kök dosya sisteminde yer. Paket ağacı, derlenmiş API ve node_modules birlikte ~1.5 GiB.
  local free_mb; free_mb=$(df -Pm / | awk 'NR==2{print $4}')
  if [ "$free_mb" -lt 4096 ]; then
    printf '  %s✗%s / üzerinde %s MiB boş — en az 4 GiB gerekiyor\n' "$R" "$Z" "$free_mb"; fatal=1
  else ok "/ üzerinde $free_mb MiB boş"; fi

  local missing=''
  for cmd in node psql runuser nginx openssl curl systemctl hostnamectl journalctl install useradd getent ss awk sed grep; do
    command -v "$cmd" >/dev/null 2>&1 || missing="$missing $cmd"
  done
  if [ -n "$missing" ]; then
    printf '  %s✗%s eksik komutlar:%s\n' "$R" "$Z" "$missing"
    printf '      apt install -y nodejs postgresql-client nginx openssl curl iproute2\n'
    fatal=1
  else ok 'gereken komutlar var'; fi

  # pnpm HER ZAMAN gerekiyor, --skip-build verilse bile: migration'ları o çalıştırıyor
  # (`pnpm --filter @depsis/db run migrate:up`) ve API ile worker'ın kendi kendine yeten
  # dizinlerini o üretiyor (`pnpm deploy --prod`). --skip-build yalnız DERLEMEYİ atlıyor.
  if ! command -v pnpm >/dev/null 2>&1; then
    printf '  %s✗%s pnpm yok (corepack enable && corepack prepare pnpm@latest --activate)\n' "$R" "$Z"
    fatal=1
  fi

  # Node sürümü. .nvmrc bu depodaki tek doğru kaynak, ve API'nin derlemesi onunla yapıldı.
  local want_major have_major
  want_major="$(cut -d. -f1 < "$REPO/.nvmrc")"
  have_major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$have_major" -lt "$want_major" ]; then
    printf '  %s✗%s node %s — en az %s gerekiyor (.nvmrc)\n' "$R" "$Z" "$(node -v)" "$want_major"; fatal=1
  else ok "node $(node -v)"; fi

  # ── port çakışması ──
  #
  # "Dinleyen var" ile "BİZİM dinleyenimiz var" ayrı şeyler: ikinci kez çalıştırılan bir kurulum,
  # kendi nginx'ini çakışma sanıp durmamalı.
  #
  # AYIRIM PID ÜZERİNDEN, SÜREÇ ADI ÜZERİNDEN DEĞİL. İlk hâli `ss`'in bildirdiği ada bakıyordu ve
  # ikinci çalıştırmada kendi API'sini yabancı sanıp durdu: Node ana iş parçacığına `MainThread`
  # adını veriyor, `node` değil. systemd'ye "bu birimin ana süreci hangisi" diye sormak, adın
  # hangi sürümde ne olduğuna bağlı olmayan tek cevap.
  port_pid()  { ss -lntpH "sport = :$1" 2>/dev/null | sed -n 's/.*pid=\([0-9]\{1,\}\).*/\1/p' | head -1; }
  port_desc() { ss -lntpH "sport = :$1" 2>/dev/null | sed -n 's/.*users:((\("[^"]*"\).*/\1/p' | head -1; }
  local pair p unit pid mine
  for pair in "80:nginx.service" "443:nginx.service" "$API_PORT:depsis-api.service"; do
    p="${pair%%:*}"; unit="${pair#*:}"
    pid="$(port_pid "$p")"
    mine="$(systemctl show -p MainPID --value "$unit" 2>/dev/null || echo 0)"
    if   [ -z "$pid" ];                          then ok "port $p boş"
    elif [ -n "$mine" ] && [ "$pid" = "$mine" ]; then same "port $p zaten $unit birimine ait"
    else printf '  %s✗%s port %s kullanımda: pid %s %s\n' "$R" "$Z" "$p" "$pid" "$(port_desc "$p")"; fatal=1
    fi
  done

  # ── PostgreSQL ──
  local pgver
  pgver="$(PGCONNECT_TIMEOUT=5 adminq -tA -d postgres -c 'SHOW server_version_num' 2>/dev/null || true)"
  if [ -z "$pgver" ]; then
    if [ "$PSQL_LOCAL" = yes ]; then
      printf '  %s✗%s PostgreSQL bu kutuda yanıt vermiyor (soket, port %s)
' "$R" "$Z" "$DB_PORT"
      printf '      Kurulu mu, çalışıyor mu: systemctl status postgresql
'
    else
      printf '  %s✗%s PostgreSQL %s:%s adresinde %s olarak erişilemiyor
' "$R" "$Z" "$DB_HOST" "$DB_PORT" "$DB_SUPERUSER"
      printf '      Parola gerekiyorsa PGPASSWORD ile verin, ya da .pgpass kullanın.
'
    fi
    fatal=1
  elif [ "$pgver" -lt 160000 ]; then
    printf '  %s✗%s PostgreSQL %s — en az 16 gerekiyor
' "$R" "$Z" "$pgver"; fatal=1
  else
    ok "PostgreSQL $((pgver/10000)) erişilebilir"
  fi

  # ── disk planı: LİSTELE, planlama ──
  #
  # §19 "disk planı" diyor ve §8.1 havuz kurmayı yazılı onay ve yeniden kimlik doğrulama arkasına
  # koyuyor. İkisi çelişmiyor: burada yapılacak olan, operatörün ne olduğunu GÖRMESİ. Havuzu
  # kuran şey sihirbaz, ve orada bir onay ekranı var.
  if command -v lsblk >/dev/null 2>&1; then
    printf '  %s·%s bulunan diskler (havuz planı kurulum sihirbazında yapılır):\n' "$D" "$Z"
    lsblk -dno NAME,SIZE,MODEL,TYPE 2>/dev/null | awk '$4=="disk"{printf "      /dev/%-8s %-8s %s\n", $1, $2, substr($0, index($0,$3))}'
  fi

  # ── ZeroTier ──
  #
  # ADR-0020 REVİZE EDİLDİ: cihaz uzaktan erişim yeteneğiyle geliyor, çünkü sahibi onu açmak
  # isteyince karşısına terminal çıkması bir eksikti. `zerotier-one`ın kendisi controller —
  # ayrı bir servis yok.
  #
  # Kararı ISO veriyor ve kararını `$ETC/zerotier.wanted` ile söylüyor; kuran taraf aşağıdaki
  # `zerotier()`. Kendi Debian'ına DEPSIS kuran birinin kutusuna ağ katmanı EKLENMİYOR.
  if command -v zerotier-cli >/dev/null 2>&1; then
    ok 'zerotier-one kurulu — uzaktan erişim ve kendi ağını kurma açılabilir'
  elif [ -f "$ETC/zerotier.wanted" ]; then
    same 'zerotier-one yok — bu kutu onu istiyor, kurulum aşağıda deneyecek'
  else
    same 'zerotier-one yok — uzaktan erişim uçları 503 döner (DEPSIS ISO ile kurulan kutularda kurulum onu kurar)'
  fi

  # ── işletim sistemi güvenlik güncellemeleri ──
  #
  # Bu kutu 443'ü ve 445'i dinliyor, ve dinleyen yazılım DEPSIS'in değil Debian'ın: nginx, smbd,
  # openssl. `update.sh` yalnız DEPSIS'in kendi kaynağını yeniliyor, Debian paketlerine hiç
  # dokunmuyor. ISO'nun ilk açılışı bunun için `unattended-upgrades` kuruyor; elle kurulan bir
  # kutuda o adım YOK, ve söylenmezse kimse fark etmez. Kurulumu durduran bir eksik değil —
  # kurulum sahibinin kendi Debian'ına dokunmuyor — ama bilinmesi gereken bir eksik.
  if systemctl is-enabled apt-daily-upgrade.timer >/dev/null 2>&1; then
    ok 'işletim sistemi güvenlik yamaları kendiliğinden uygulanıyor (unattended-upgrades)'
  else
    same 'unattended-upgrades kapalı — Debian güvenlik yamaları uygulanmıyor (DEPSIS ISO onu kurar)'
  fi

  [ "$fatal" -eq 0 ] || die 'ön kontroller geçmedi; yukarıdaki ✗ satırlarını giderip yeniden çalıştırın'
}

# ─── 2. hesaplar ve dizinler ──────────────────────────────────────────────────

accounts() {
  step 'servis hesapları ve dizinler'
  local u
  for u in depsis-api depsis-console; do
    if id -u "$u" >/dev/null 2>&1; then same "$u var"
    else
      useradd --system --no-create-home --shell /usr/sbin/nologin "$u"
      ok "$u oluşturuldu"
    fi
  done

  install -d -m 0755 "$PREFIX" "$ETC" "$VAR" "$SHARES_ROOT"
  # 0700 root: sertifikanın özel anahtarı burada. Dizinin kendisi de kapalı olmalı, çünkü 0400 bir
  # dosya, listelenebilir bir dizinde en azından adını söyler.
  install -d -m 0700 "$TLS_DIR"
  # Güncelleyicinin durumu ve günlüğü. 0700: içindeki günlük bir kurulumun tam çıktısı ve
  # kurulum çıktısı, kutunun yapılandırmasını satır satır anlatır.
  install -d -m 0700 "$VAR/update"
  ok "dizinler: $PREFIX, $ETC, $TLS_DIR, $VAR, $SHARES_ROOT"
}

# ─── 3. sırlar ────────────────────────────────────────────────────────────────
#
# §19'un "recovery key"i. DEPSIS'te kurtarma anahtarı diye ayrı bir şey yok ve uydurulmadı: at-rest
# şifrelemenin anahtarı /etc/depsis/secret.key, ve KAYBEDİLİRSE mühürlenmiş TOTP sırları geri
# gelmiyor (ADR-0016). Kurtarma anahtarı odur. Bir kez, yalnız ekrana yazılıyor.

RECOVERY_PRINTED=''

secrets() {
  step 'sırlar'

  if [ -s "$ETC/secret.key" ]; then
    same 'secret.key var — dokunulmuyor (yenisi, mühürlü her TOTP sırrını okunamaz yapardı)'
  else
    ( umask 077; openssl rand -base64 32 > "$ETC/secret.key" )
    RECOVERY_PRINTED="$(cat "$ETC/secret.key")"
    ok 'secret.key üretildi'
  fi
  chown root:root "$ETC/secret.key"; chmod 0400 "$ETC/secret.key"

  # Veritabanı parolaları. Bir kez üretilip saklanıyor: ikinci çalıştırmada yeniden üretmek,
  # çalışan bir API'yi kendi veritabanından kilitlemek demek olurdu.
  if [ ! -s "$ETC/db-password-app" ]; then
    ( umask 077; openssl rand -base64 24 | tr -d '\n/+=' > "$ETC/db-password-app" )
    ok 'depsis_app parolası üretildi'
  else same 'depsis_app parolası var'; fi
  if [ ! -s "$ETC/db-password-owner" ]; then
    ( umask 077; openssl rand -base64 24 | tr -d '\n/+=' > "$ETC/db-password-owner" )
    ok 'depsis_owner parolası üretildi'
  else same 'depsis_owner parolası var'; fi
  chown root:root "$ETC"/db-password-*; chmod 0400 "$ETC"/db-password-*
}

# ─── 4. veritabanı ────────────────────────────────────────────────────────────

database() {
  step 'veritabanı'
  local app_pw owner_pw
  app_pw="$(cat "$ETC/db-password-app")"
  owner_pw="$(cat "$ETC/db-password-owner")"

  if adminq -tA -d "$DB_NAME" -c 'SELECT 1' >/dev/null 2>&1; then
    same "$DB_NAME veritabanı var"
  else
    # bootstrap.sql rolleri ve veritabanını yaratıyor; parola YAZMIYOR, çünkü
    # `log_statement = 'ddl'` altında sunucu günlüğüne düşerdi. Parolalar aşağıda ayrıca.
    # İçerik STDIN'den: postgres kullanıcısının /opt altını okuma izni olmayabilir, root'un var.
    adminq -d postgres -v db_name="$DB_NAME" -f - < "$REPO/packages/db/bootstrap.sql" >/dev/null
    ok "$DB_NAME veritabanı ve roller oluşturuldu"
  fi

  # ALTER ROLE her çalıştırmada: parola dosyası burada tek doğru kaynak, ve kümedeki rol parolası
  # onunla eşleşmiyorsa API bağlanamıyor. Yeniden yazmak idempotent ve düzeltici.
  adminq -d postgres -c "ALTER ROLE depsis_app   PASSWORD '$app_pw'"   >/dev/null
  adminq -d postgres -c "ALTER ROLE depsis_owner PASSWORD '$owner_pw'" >/dev/null
  ok 'rol parolaları yazıldı'

  local app_url owner_url
  app_url="postgresql://depsis_app:$app_pw@$DB_HOST:$DB_PORT/$DB_NAME"
  owner_url="postgresql://depsis_owner:$owner_pw@$DB_HOST:$DB_PORT/$DB_NAME"

  ( umask 077; printf '%s\n' "$app_url"   > "$ETC/db-url" )
  # Göç URL'i AYRI bir dosyada ve servise hiç verilmiyor. ADR-0014: uygulama asla migration
  # rolüyle bağlanmamalı, çünkü o rol satır seviyesi güvenliği aşıyor. Burada duruyor ki
  # yükseltmeler migration'ları yeniden çalıştırabilsin.
  ( umask 077; printf '%s\n' "$owner_url" > "$ETC/db-url-owner" )
  chown root:root "$ETC/db-url" "$ETC/db-url-owner"; chmod 0400 "$ETC/db-url" "$ETC/db-url-owner"

  step 'migration'
  # BAĞIMLILIKLAR MİGRATION'DAN ÖNCE — üçüncü saha dersi: bakir bir kutuda node_modules yok ve
  # node-pg-migrate oradan geliyor; adım sırası (veritabanı → yerleştirme) bunu görünmez kılmıştı,
  # çünkü her test kutusunda bağımlılıklar zaten kuruluydu.
  if [ ! -d "$REPO/node_modules" ]; then
    ( cd "$REPO" && pnpm install --frozen-lockfile >/dev/null )
    ok 'bağımlılıklar kuruldu'
  fi
  # HER ZAMAN, --skip-build verilse bile. Bir migration bir derleme çıktısı değil, veritabanının
  # şemasıdır; ikisini tek bayrağın arkasına koymak, "yalnız ikilileri yeniden kopyala" demek
  # isteyen operatöre şemayı da atlatırdı — ve şemasız bir yükseltme, ilk isteğinde düşen bir API.
  ( cd "$REPO" && DEPSIS_MIGRATION_DATABASE_URL="$owner_url" \
      pnpm --filter @depsis/db run migrate:up >/dev/null )
  ok 'şema güncel'
}

# ─── 5. yükleme ───────────────────────────────────────────────────────────────

# Ajan ve konsol ikilileri: ya arşivden hazır gelirler ya burada derlenirler.
#
# ── neden ayrı bir işlev ─────────────────────────────────────────────────────
#
# İlk hâli üç satırdı — `cargo varsa derle, yoksa uyar` — ve sahadaki ilk yazılım güncellemesi
# tam bu üç satırda düştü. Sebebi ikiye bölünüyor ve ikisi de burada karşılanıyor.
#
# BİR: sürüm arşivi yalnız KAYNAK taşıyordu (`git archive`), yani `target/release` boştu; cargo
# da bulunamayınca elde kurulacak bir ikili kalmadı ve kurulum "derlenmemiş" deyip düştü. Bu,
# 2009 model bir kutuya her güvenlik düzeltmesi için tam bir Rust derlemesi yaptırmanın da
# yanlış olduğunu gösterdi: sürümü üreten taraf zaten derliyor. Artık arşiv ikilileri hazır
# getiriyor, `.depsis-prebuilt` işaretiyle, ve arşivin tamamı imzalı olduğu için o ikililer de
# imzalı — kutuda derlemekten daha güvenli, çünkü derleme zincirine hiç güvenmiyoruz.
#
# İKİ: cargo aslında KUTUDAYDI. `firstboot.sh` rustup'ı /root/.cargo/bin altına kuruyor ve
# systemd'nin bir birime verdiği PATH orayı içermiyor; elle kurulumda çalışan şey, güncelleme
# yolunda görünmez oluyordu. Aşağıdaki arama tam olarak bunu kapatıyor.
rust_binaries() {
  local marker="$REPO/target/release/.depsis-prebuilt"
  local arch
  arch="$(uname -m)"

  # HAZIR İKİLİLER. İşaret dosyası, ikililerin hangi mimari için üretildiğini söylüyor: yanlış
  # mimarideki bir ikiliyi kurmak, "Exec format error" ile açılışta düşen bir servis demektir ve
  # o hatanın kurulum günlüğünde hiçbir izi olmazdı.
  if [ -f "$marker" ]; then
    local built
    built="$(head -n1 "$marker" | tr -d '[:space:]')"
    if [ "$built" = "$arch" ]; then
      local bin missing=no
      for bin in depsis-agent depsis-console; do
        [ -x "$REPO/target/release/$bin" ] || missing=yes
      done
      if [ "$missing" = no ]; then
        same "sürüm arşivi $arch ikililerini hazır getiriyor; derleme yok"
        return 0
      fi
      warn 'hazır ikili işareti var ama ikililer eksik; derlemeye düşülüyor'
    else
      warn "hazır ikililer $built için üretilmiş, bu kutu $arch; derlemeye düşülüyor"
    fi
  fi

  # RUSTUP'IN YERİ. `command -v` yetmiyor: rustup $HOME/.cargo/bin'e kuruyor ve bu betik bir
  # systemd biriminden koştuğunda o dizin PATH'te olmuyor.
  if ! command -v cargo >/dev/null 2>&1; then
    local candidate
    for candidate in "${HOME:-/root}/.cargo/bin" /root/.cargo/bin; do
      if [ -x "$candidate/cargo" ]; then
        PATH="$candidate:$PATH"
        export PATH
        break
      fi
    done
  fi

  if command -v cargo >/dev/null 2>&1; then
    ( cd "$REPO" && cargo build --release --bin depsis-agent --bin depsis-console >/dev/null )
    ok 'Rust ikilileri derlendi'
  else
    warn 'cargo yok; target/release altındaki mevcut ikililer kullanılacak'
  fi
}

payload() {
  step 'derleme ve yerleştirme'

  if [ "$SKIP_BUILD" = no ]; then
    ( cd "$REPO" && pnpm install --frozen-lockfile >/dev/null )
    ( cd "$REPO" && pnpm turbo run build >/dev/null )
    ok 'TypeScript derlendi'
    rust_binaries
  else
    same '--skip-build: mevcut çıktı kullanılıyor'
  fi

  local bin
  for bin in depsis-agent depsis-console; do
    [ -x "$REPO/target/release/$bin" ] || die "$bin yok: bu ağaç ne hazır ikili taşıyor ne de derlenebildi"
    install -m 0755 "$REPO/target/release/$bin" "$PREFIX/$bin"
  done
  ok "ajan ve konsol ikilileri $PREFIX altında"

  # Güncelleyici. $PREFIX altında, ÇÜNKÜ kaynak ağacı (/opt/depsis) güncelleme sırasında
  # yerinden oynuyor — betiğin altındaki zemin, o betik koşarken kaybolmamalı.
  install -m 0755 "$REPO/tools/install/update.sh" "$PREFIX/update.sh"
  ok "güncelleyici $PREFIX/update.sh"

  # SÜRÜM İMZA ANAHTARI, varsa. Bu dosyanın varlığı güncelleyicinin kipini belirliyor: varsa
  # yalnız imzalı sürümler kurulur, yoksa dalın son commiti kurulur ve arayüz bunu söyler.
  # Deponun içinde olmaması olağan — özel anahtarı üreten ve saklayan taraf cihazın sahibi
  # (bkz. deploy/release/README.md), ve açık anahtar ancak o adım atıldığında depoya girer.
  if [ -f "$REPO/deploy/release/release-key.pub" ]; then
    install -m 0444 "$REPO/deploy/release/release-key.pub" "$PREFIX/release-key.pub"
    ok 'sürüm imza anahtarı kuruldu; yalnız imzalı sürümler kabul edilecek'
  else
    rm -f "$PREFIX/release-key.pub"
    warn 'sürüm imza anahtarı yok; güncelleme imzasız kaynaktan yapılacak (deploy/release/README.md)'
  fi

  # LİSANS AÇIK ANAHTARI. Gizli değil — gizli olan, satıcının elindeki özel anahtar. Yoksa
  # arayüz "lisans doğrulaması yapılandırılmamış" der; "lisanssız" DEĞİL, çünkü ikisi ayrı
  # şeyler ve ekranın söyleyeceği cümle de ayrı.
  if [ -f "$REPO/deploy/release/license-key.pub" ]; then
    install -m 0444 "$REPO/deploy/release/license-key.pub" "$ETC/license-key.pub"
    ok 'lisans doğrulama anahtarı kuruldu'
  else
    same 'lisans doğrulama anahtarı yok; lisans kurulamayacak'
  fi

  # `pnpm deploy --prod` bir SELF-CONTAINED dizin üretiyor: düz bir node_modules ve dist/.
  # Çalışma alanını kopyalamak işe yaramıyor, çünkü pnpm'in paket başına node_modules'ü depo
  # köküne göre sembolik bağ ağacı — kısmi kopya hiçbir şeyi çözemiyor, tam kopya kaynakları
  # da gönderiyor.
  local app
  for app in api worker; do
    rm -rf "$PREFIX/$app.new"
    ( cd "$REPO" && pnpm --filter "@depsis/$app" deploy --prod --legacy "$PREFIX/$app.new" >/dev/null )
    rm -rf "$PREFIX/$app.old"
    # `if`, not `[ … ] && mv`: under `set -e` a bare `&&` list that fails ends the script, and
    # on a FIRST install the directory is absent — so the short form would abort the very run
    # it exists to make safe.
    if [ -d "$PREFIX/$app" ]; then mv "$PREFIX/$app" "$PREFIX/$app.old"; fi
    mv "$PREFIX/$app.new" "$PREFIX/$app"
    rm -rf "$PREFIX/$app.old"
    rm -rf "$PREFIX/$app/src" "$PREFIX/$app"/*.tsbuildinfo
  done
  # `deploy --prod` çalışma alanını "üretim kurulumu" olarak işaretliyor; bir sonraki pnpm komutu
  # geliştirme bağımlılıklarını bulamıyor. Geri alınıyor.
  ( cd "$REPO" && pnpm install --frozen-lockfile >/dev/null 2>&1 || true )
  ok "API ve worker $PREFIX altında"

  [ -f "$REPO/apps/web/dist/index.html" ] || die 'apps/web/dist boş: pnpm turbo run build --filter=@depsis/web'
  rm -rf "$PREFIX/web.new"
  install -d -m 0755 "$PREFIX/web.new"
  cp -a "$REPO/apps/web/dist/." "$PREFIX/web.new/"
  rm -rf "$PREFIX/web.old"
  if [ -d "$PREFIX/web" ]; then mv "$PREFIX/web" "$PREFIX/web.old"; fi
  mv "$PREFIX/web.new" "$PREFIX/web"
  rm -rf "$PREFIX/web.old"
  ok "arayüz $PREFIX/web altında"

  # nginx (www-data) okuyabilmeli, kimse yazamamalı.
  chmod -R a+rX "$PREFIX"

  # ADR belgeleri: birim dosyalarındaki Documentation= satırları bu yolları gösteriyor, ve
  # olmayan bir belgeyi gösteren bir birim, `systemctl help` çalıştıran operatöre yalan söylüyor.
  if [ -d "$REPO/docs/adr" ]; then
    install -d -m 0755 /usr/share/doc/depsis
    cp -a "$REPO/docs/adr" /usr/share/doc/depsis/
    ok 'ADR belgeleri /usr/share/doc/depsis altında'
  fi
}

# ─── 6. yapılandırma ──────────────────────────────────────────────────────────

configuration() {
  step 'yapılandırma'

  if [ "$(hostname)" != "$HOSTNAME_WANTED" ]; then
    hostnamectl set-hostname "$HOSTNAME_WANTED"
    ok "hostname: $HOSTNAME_WANTED"
  else same "hostname zaten $HOSTNAME_WANTED"; fi

  # api.env — SIR DEĞİL, yapılandırma. Sırlar LoadCredential= ile geliyor (ADR-0016).
  cat > "$ETC/api.env" <<ENV
# tools/install/install.sh tarafından yazıldı. El ile düzenlenebilir; bir sonraki kurulum
# ÜZERİNE YAZAR, o yüzden kalıcı değişiklikler installer argümanlarıyla verilmeli.
NODE_ENV=production
DEPSIS_API_PORT=$API_PORT

# Yalnız döngü arayüzü. Dışarıya açılan tek şey nginx, ve TLS orada sonlanıyor. Bu satır
# kalkarsa API'nin tamamı — oturum çerezi dahil — yanındaki portta düz http ile servis edilir.
DEPSIS_API_BIND=127.0.0.1

# nginx'in X-Forwarded-Proto'suna YALNIZ döngü arayüzünden gelirse inanılır. Bu olmadan çerez
# Secure almaz ve CSRF kontrolü her yazma isteğini 403'ler.
DEPSIS_TRUST_PROXY=loopback

DEPSIS_AGENT_SOCKET=/run/depsis/agent.sock
DEPSIS_AGENT_DATA_SOCKET=/run/depsis/agent-data.sock
DEPSIS_CONSOLE_SOCKET=/run/depsis/console.sock

DEPSIS_SHARES_ROOT=$SHARES_ROOT
# Bu ikisi AYNI dizini tarif ediyor: biri paylaşımın nerede OLDUĞU, öteki oraya bağlı dataset.
# Havuz henüz yoksa boş kalıyor — boş, uçları 503'e ve o 503 ayarın adını söylüyor; yanlış bir
# değer ise sessizce çalışmayan bir paylaşım.
DEPSIS_SHARE_PARENT_DATASET=$SHARE_PARENT_DATASET

DEPSIS_SMB_HOST=$HOSTNAME_WANTED
$( if id -u depsis-apps >/dev/null 2>&1; then
     printf '# Köksüz podman (ADR-0019): kataloğun konteynerleri yetkisiz depsis-apps hesabında koşar.
DEPSIS_PODMAN_SOCKET=/run/depsis-apps/podman.sock'
   else
     printf '# podman köksüz hesabı yok; varsayılan (kök) soket ve katalog kurulumları kapalı kalır.'
   fi )
DEPSIS_ZFS_POOLS=$ZFS_POOLS
DEPSIS_SMART_DISKS=$SMART_DISKS
ENV
  chmod 0644 "$ETC/api.env"

  printf 'DEPSIS_API_UID=%s\nDEPSIS_SHARES_ROOT=%s\n' "$(id -u depsis-api)" "$SHARES_ROOT" > "$ETC/agent.env"
  chmod 0644 "$ETC/agent.env"

  # ── ajanın SIRRI: gecelik veritabanı dökümünün bağlantı dizesi ──
  #
  # ZFS anlık görüntüleri kullanıcının DOSYALARINI koruyor; hesapları, paylaşım tanımlarını ve
  # izinleri koruyan tek şey PostgreSQL dökümü, ve o döküm sistem diskinde. `dbdump.rs`
  # DEPSIS_BACKUP_DATABASE_URL yoksa işlemi REDDEDİYOR — doğru davranış, çünkü uydurulmuş bir
  # bağlantı dizesi yanlış veritabanının dökümünü alıp "yedeğiniz var" derdi.
  #
  # DEĞİŞKENİ HİÇBİR KURULUM YOLU YAZMIYORDU. Sonucu her kutuda aynıydı: backup-tick zinciri her
  # gece `dump_database` çağırıyor, ajan reddediyor, Yedekleme ekranı "bağlantı dizesi
  # yapılandırılmamış" diyor, ve çıkış yolu terminalde bir dosya düzenlemek — yani ürün kuralının
  # dışı.
  #
  # AYRI BİR DOSYA, agent.env'e eklenmiş bir satır DEĞİL: agent.env 0644 ve yapılandırma taşıyor,
  # bu satır ise veritabanı parolasının kendisi. 0600 root:root — ajan zaten root koşuyor
  # (ADR-0006), o yüzden ayrı bir grup gerekmiyor.
  #
  # ROL depsis_owner: her tablonun `FORCE ROW LEVEL SECURITY`si var ve yalnız owner'ın
  # `USING (true)` politikası tüm satırları görüyor. `depsis_backup` ile alınan bir döküm RLS
  # süzgecinden geçer — 0006'nın deyişiyle, RLS ile süzülmüş bir yedek yedek değildir.
  ( umask 077; printf 'DEPSIS_BACKUP_DATABASE_URL=%s\n' "$(cat "$ETC/db-url-owner")" > "$ETC/agent-secrets.env" )
  chown root:root "$ETC/agent-secrets.env"
  chmod 0600 "$ETC/agent-secrets.env"

  # console.env — birim dosyası bunu okumadan BAŞLAMIYOR ve ilk saha kurulumunda eksikti: konsol
  # soketi "No such file or directory" ile beş kez düşüp kilitlendi. Ayrıcalıksız kabuk (ADR-0018);
  # 1 yapmak bilinçli bir operatör kararıdır ve buradan değil o dosyadan verilir.
  if [ ! -f "$ETC/console.env" ]; then
    printf 'DEPSIS_CONSOLE_PRIVILEGED=0
' > "$ETC/console.env"
  fi
  # DEPSIS_API_UID DE BURAYA. Konsol, kendisine bağlanan tarafın uid'ini SO_PEERCRED ile bu
  # değere karşı sınıyor ve değer yoksa "DEPSIS_API_UID is unset; refusing to start" deyip
  # çıkıyor — yani konsol hiç açılmıyor.
  #
  # İlk saha kurulumunda tam bu oldu. Eksik dosya düzeltilirken dosya YARIM yazıldı: birim
  # dosyasının kendi açıklaması "written by the installer" diyordu ama kurulum uid'i yalnız
  # agent.env'e yazıyordu. Sonuç, kullanıcının gördüğü hâliyle, "Konsol servisi çalışmıyor".
  #
  # Satır her kurulumda TAZELENİYOR, `console.env` yokken bir kez yazılmıyor: depsis-api hesabı
  # silinip yeniden açılırsa uid değişir, ve o gün konsol sessizce yanlış uid'e bakardı.
  # Dosyanın geri kalanına dokunulmuyor — operatörün DEPSIS_CONSOLE_PRIVILEGED=1 kararı burada.
  local console_uid
  console_uid="DEPSIS_API_UID=$(id -u depsis-api)"
  if grep -q '^DEPSIS_API_UID=' "$ETC/console.env"; then
    sed -i "s|^DEPSIS_API_UID=.*|$console_uid|" "$ETC/console.env"
  else
    printf '%s\n' "$console_uid" >> "$ETC/console.env"
  fi
  chmod 0644 "$ETC/console.env"
  ok "$ETC/api.env, $ETC/agent.env, $ETC/agent-secrets.env ve $ETC/console.env"

  # Bir kurulum kaydı. Atlamak için DEĞİL — her adım zaten kendi başına bakıyor — hangi sürümün
  # ne zaman kurulduğunu söyleyebilmek için. Bir kutuya bakan kişinin ilk sorusu budur.
  {
    printf 'installed_at=%s\n' "$(date -Is)"
    printf 'git_commit=%s\n' "$(cd "$REPO" && git rev-parse HEAD 2>/dev/null || echo bilinmiyor)"
    printf 'server_name=%s\n' "$SERVER_NAME"
    printf 'api_port=%s\n' "$API_PORT"
    printf 'database=%s\n' "$DB_NAME"
  } > "$VAR/install.record"
  chmod 0644 "$VAR/install.record"
}

# ─── 7. TLS ───────────────────────────────────────────────────────────────────
#
# §17: üretimde HTTPS zorunlu. §3 satır 110: "IP ile ilk kurulumda yerel sertifika/onboarding
# akışı; önerilen kullanımda kullanıcı tarafından güvenilen sertifika veya alan adı."
#
# Kendinden imzalı sertifika, tarayıcıda bir uyarı üretiyor ve bu uyarı GERÇEK: bir NAS'a ilk kez
# bağlanan tarayıcının o sertifikayı doğrulamasının yolu yok. Betik bu yüzden PARMAK İZİNİ
# yazdırıyor — operatörün tarayıcıdaki uyarı ekranında karşılaştırabileceği tek şey o.
#
# ── SAHİBİNİN SERTİFİKASINA DOKUNULMAZ ───────────────────────────────────────
#
# Bu işlev HER kurulumda koşuyor, ve bir güncelleme de bir kurulumdur (update.sh, install.args ile
# aynı betiği çağırıyor). Sahibi arayüzden kendi CA imzalı sertifikasını kurduysa dosyalar TAM
# BURAYA yazılmış olur — `tls.rs`in DEFAULT_CERT_PATH/DEFAULT_KEY_PATH'i bu ikisi. Aşağıdaki
# "30 günden az kaldı, yenile" dalı verene hiç bakmadığı için, 90 günlük bir Let's Encrypt
# sertifikasının 65. gününde yapılan bir güncelleme onu sessizce kendinden imzalıyla değiştirirdi:
# tarayıcı yeniden uyarır, Sertifika ekranı "kendinden imzalı" der ve hiçbir yerde bunu
# güncellemenin yaptığı yazmaz.
#
# Bu yüzden yenilemeden önce sertifikanın KİMİN verdiği soruluyor. Ölçüt `tls.rs`in
# `parse_facts`iyle birebir aynı — konu ile veren aynıysa kendinden imzalı — ki arayüzün
# "sahibinin sertifikası" dediği şeye kurulum da aynı adı versin.

# Konu ile veren aynı mı? İki boş dizgeyi "aynı" saymamak önemli: sertifika okunamadığında
# kendinden imzalı DEMEK, ekranda olgu gibi duran bir tahmin olurdu — ve o tahminin yanlış tarafı
# sahibinin sertifikasını ezmek. Okunamayan sertifika ayrı bir dal olarak ele alınıyor.
self_signed_cert() {
  local subject issuer
  subject="$(openssl x509 -in "$1" -noout -subject 2>/dev/null | sed 's/^subject=[[:space:]]*//')"
  issuer="$(openssl x509 -in "$1" -noout -issuer 2>/dev/null | sed 's/^issuer=[[:space:]]*//')"
  [ -n "$subject" ] && [ "$subject" = "$issuer" ]
}

tls() {
  step 'TLS sertifikası'
  local crt="$TLS_DIR/depsis.crt" key="$TLS_DIR/depsis.key"

  local need=no foreign=no
  if [ ! -s "$crt" ] || [ ! -s "$key" ]; then need=yes
  # Ayrıştırılamayan bir sertifika, olmayan bir sertifikadan farksız: nginx onunla başlamıyor.
  # Bu dal, "veren okunamadı" hâlini sahibinin sertifikası sanıp kutuyu erişilemez bırakmamak için.
  elif ! openssl x509 -in "$crt" -noout >/dev/null 2>&1; then
    need=yes; warn 'mevcut sertifika okunamıyor; yenisi üretiliyor'
  elif ! self_signed_cert "$crt"; then foreign=yes
  elif [ "$RENEW_CERT" = yes ]; then need=yes; same 'sertifika --renew-cert ile yenileniyor'
  # 30 gün kalmışsa yenile. `-checkend` saniye alıyor.
  elif ! openssl x509 -in "$crt" -noout -checkend 2592000 >/dev/null 2>&1; then
    need=yes; warn 'sertifikanın bitmesine 30 günden az kaldı; yenileniyor'
  fi

  if [ "$foreign" = yes ]; then
    # --renew-cert dahil: o bayrak "kendinden imzalıyı tazele" demek, "sahibinin sertifikasını at"
    # demek değil. update.sh install.args'ı aynen tekrarladığı için bayrağın bir gün oradan
    # gelmesi de mümkün, ve o gün sessizce eziyor olurdu.
    local issuer enddate
    issuer="$(openssl x509 -in "$crt" -noout -issuer | sed 's/^issuer=[[:space:]]*//')"
    enddate="$(openssl x509 -in "$crt" -noout -enddate | cut -d= -f2)"
    warn "sahibinin kurduğu sertifika korunuyor (veren: $issuer)"
    if ! openssl x509 -in "$crt" -noout -checkend 2592000 >/dev/null 2>&1; then
      warn "bitişine 30 günden az kaldı ($enddate); yenisini Sertifika ekranından yükleyin"
    else
      same "sertifika geçerli ($enddate)"
    fi
  elif [ "$need" = no ]; then
    same "sertifika geçerli ($(openssl x509 -in "$crt" -noout -enddate | cut -d= -f2))"
  else
    # SAN listesi: hostname, kısa ad, localhost ve makinenin BÜTÜN IPv4 adresleri. Bir NAS'a
    # çoğunlukla IP ile bağlanılıyor, ve SAN'ında IP olmayan bir sertifika o adreste tarayıcının
    # "devam et" düğmesini bile zorlaştırıyor.
    local san="DNS:$SERVER_NAME,DNS:$HOSTNAME_WANTED,DNS:localhost,IP:127.0.0.1"
    local ip
    while read -r ip; do
      case "$ip" in 127.*) continue ;; esac
      san="$san,IP:$ip"
    done < <(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' || true)

    # EC P-256: RSA-2048'den hızlı el sıkışma, ve 2026'da her tarayıcıda var. 825 gün, tarayıcı
    # ekosisteminin kendinden imzalı sertifikalar için kabul ettiği üst sınırın altında.
    openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
      -days 825 -sha256 \
      -subj "/CN=$SERVER_NAME/O=DEPSIS" \
      -addext "subjectAltName=$san" \
      -addext 'keyUsage=critical,digitalSignature,keyEncipherment' \
      -addext 'extendedKeyUsage=serverAuth' \
      -keyout "$key" -out "$crt" >/dev/null 2>&1
    chown root:root "$crt" "$key"; chmod 0400 "$key"; chmod 0444 "$crt"
    ok "kendinden imzalı sertifika üretildi ($san)"
  fi

  CERT_FINGERPRINT="$(openssl x509 -in "$crt" -noout -fingerprint -sha256 | cut -d= -f2)"
}

# ─── 8. nginx ─────────────────────────────────────────────────────────────────

reverse_proxy() {
  step 'ters vekil'

  install -d -m 0755 /etc/nginx/snippets /etc/nginx/sites-available /etc/nginx/sites-enabled

  local hsts=''
  if [ "$WANT_HSTS" = yes ]; then
    # HSTS yalnız --hsts ile, ve §17 de "uygun alan adı senaryosunda" diyor. Bir IP adresine
    # HSTS koymak, o IP'yi kullanan HER servisi tarayıcıda kalıcı olarak https'e kilitler — ve
    # kendinden imzalı bir sertifikayla birlikte, cihazı erişilemez hâle getirebilir.
    hsts='add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;'
  else
    hsts='# HSTS kapalı. --hsts ile açılır; yalnız güvenilen bir sertifika ve gerçek bir alan adı varken.'
  fi

  sed -e "s|@HSTS@|$hsts|" "$REPO/deploy/nginx/depsis-headers.conf.in" > "$NGINX_HEADERS"
  chmod 0644 "$NGINX_HEADERS"

  sed -e "s|@SERVER_NAME@|$SERVER_NAME|g" \
      -e "s|@API_PORT@|$API_PORT|g" \
      -e "s|@API_PREFIX@|$API_PREFIX|g" \
      -e "s|@WEB_ROOT@|$PREFIX/web|g" \
      -e "s|@CERT@|$TLS_DIR/depsis.crt|g" \
      -e "s|@KEY@|$TLS_DIR/depsis.key|g" \
      -e "s|@HEADERS@|$NGINX_HEADERS|g" \
      "$REPO/deploy/nginx/depsis.conf.in" > "$NGINX_SITE"
  chmod 0644 "$NGINX_SITE"
  ok "$NGINX_SITE yazıldı"

  ln -sfn "$NGINX_SITE" "$NGINX_ENABLED"
  # Debian'ın varsayılan sitesi de `default_server` olarak 80'i tutuyor; ikisi birlikte nginx'i
  # başlatmıyor. Kaldırmak, kurmayı bitirmenin parçası.
  if [ -e /etc/nginx/sites-enabled/default ]; then
    rm -f /etc/nginx/sites-enabled/default
    ok 'Debian varsayılan sitesi devre dışı'
  fi

  # nginx -t ÖNCE. Bozuk bir yapılandırmayla reload, çalışan bir nginx'i olduğu gibi bırakıp
  # sessizce başarısız oluyor — yani "kurulum bitti" derken eski site hâlâ ayakta olurdu.
  nginx -t >/dev/null 2>&1 || { nginx -t; die 'nginx yapılandırması geçersiz'; }
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl reload nginx 2>/dev/null || systemctl restart nginx
  ok 'nginx yeniden yüklendi'
}

# ─── 8b. samba ────────────────────────────────────────────────────────────────
#
# Paket firstboot'un işi (bkz. "kurmadığı şeyler" ayrımı); burası paketi bulur ve BAĞLAR.
# Bağ, samba.rs'in modül notundaki tek satır: smb.conf, DEPSIS'in sahibi olduğu depsis.conf'u
# içermeli. O satır olmadan ajan her yayını "smbd bu paylaşımları sunmuyor" diye geri çevirir —
# ilk sahada tam bu yaşandı: arayüz \\depsis yazdı, 445 hiç dinlemiyordu.
samba_conf() {
  step 'Samba (Windows dosya paylaşımı)'
  if ! command -v smbd >/dev/null 2>&1; then
    printf '  %s!%s samba kurulu değil; paylaşımlar yayınlanamaz. Kurulum: apt install -y samba smbclient\n' "$Y" "$Z"
    return 0
  fi

  # Ajanın yazacağı dosya, boş da olsa şimdi var olmalı: smb.conf'taki include, dosya yoksa
  # testparm'da uyarıya dönüşür ve ilk yayına kadar smbd her başlangıçta onu okumaya çalışır.
  [ -f /etc/samba/depsis.conf ] || { : > /etc/samba/depsis.conf; chmod 0644 /etc/samba/depsis.conf; }

  # Dosyanın SONUNA, [global]'in içine değil: depsis.conf yalnız kendi bölüm başlıklarıyla
  # başlar (samba.rs'in render'ı), bu yüzden konum bağımsız — ve smb.conf'un geri kalanına
  # dokunmamak, o dosyanın işletmene ait olması kuralının kendisi.
  if ! grep -q 'include = /etc/samba/depsis.conf' /etc/samba/smb.conf 2>/dev/null; then
    printf '\n# DEPSIS paylaşımları — üretilen dosya; bu satır olmadan smbd hiçbirini sunmaz\ninclude = /etc/samba/depsis.conf\n' >> /etc/samba/smb.conf
    ok 'smb.conf include satırı eklendi'
  fi

  # Debian'ın `map to guest = bad user` varsayılanı bir tuzak, ve sahada ödendi: Windows
  # bilinmeyen bir kullanıcı adıyla gelince Samba oturumu MİSAFİR olarak kabul eder, paylaşım
  # misafiri reddeder — ve Windows, oturum "başarılı" olduğu için parola penceresini HİÇ açmaz,
  # doğrudan "erişim engellendi" gösterir. Never, yanlış kimliği yanlış diye söyler ve Windows
  # parola sorar. (Samba'nın kendi varsayılanı da zaten Never.)
  if grep -qiE '^[[:space:]]*map to guest' /etc/samba/smb.conf; then
    sed -i 's/^\([[:space:]]*\)[Mm]ap to guest = .*/\1map to guest = Never/' /etc/samba/smb.conf
    ok 'misafire düşürme kapalı (map to guest = Never)'
  fi

  systemctl enable --now smbd nmbd >/dev/null 2>&1 || true
  # wsdd2 varsa: Gezgin'in "Ağ" görünümünde kendiliğinden görünmek. Yoksa sorun değil —
  # \\depsis adresi nmbd (NetBIOS) ile zaten çözülür.
  systemctl enable --now wsdd2 >/dev/null 2>&1 || true
  ok 'smbd, nmbd açık'
}

# ─── 8c. ZeroTier ─────────────────────────────────────────────────────────────
#
# Uzaktan erişimin altındaki ağ katmanı. `zerotier-one`ın kendisi controller, yani bir ağa
# katılmak da kendi ağını kurmak da bu tek daemon ile oluyor (ADR-0020, revize).
#
# KİM İSTİYOR: `$ETC/zerotier.wanted`. Dosyayı ISO'nun ilk açılışı yazıyor; kendi Debian'ına
# DEPSIS kuran birinin kutusunda o dosya olmadığı için buradan hiçbir paket kurulmuyor.
#
# NEDEN BURADA, ilk açılışta değil: `deploy/iso/firstboot.sh` bir kez çalışıp kendini devre dışı
# bırakıyor. Kurulum o gün düşerse — ağ, depo, imza anahtarı — kutu bir daha hiç denemez ve
# uzaktan erişim uçları sonsuza kadar 503 döner; terminalsiz çıkış yolu da kalmaz. Bu betik her
# güncellemede yeniden koşuyor, yani adım kendiliğinden yeniden deniyor.
#
# NEDEN İMZALI DEPO: ilk hâli ZeroTier'ın ön sayfasındaki gibi `curl … | bash` idi, yani her
# cihaz ilk açılışında doğrulanmamış bir betiği kök kabuğunda koşturuyordu. apt yolunda anahtar
# tek kaynağa sabitleniyor ve bundan sonraki her yükseltme imza doğrulamasından geçiyor.
zerotier() {
  [ -f "$ETC/zerotier.wanted" ] || return 0
  step 'ZeroTier (uzaktan erişim)'

  if ! command -v zerotier-cli >/dev/null 2>&1; then
    local codename
    codename="$( (. /etc/os-release 2>/dev/null && printf '%s' "${VERSION_CODENAME:-trixie}") \
      || printf 'trixie' )"
    install -d -m 0755 /usr/share/keyrings
    if curl -fsSL 'https://download.zerotier.com/contact%40zerotier.com.gpg' \
         -o /usr/share/keyrings/zerotier.gpg; then
      printf 'deb [signed-by=/usr/share/keyrings/zerotier.gpg] https://download.zerotier.com/debian/%s %s main\n' \
        "$codename" "$codename" > /etc/apt/sources.list.d/zerotier.list
      apt-get update -qq >/dev/null 2>&1 || true
      if DEBIAN_FRONTEND=noninteractive apt-get install -y -qq zerotier-one >/dev/null 2>&1; then
        ok 'zerotier-one imzalı depodan kuruldu'
      else
        warn 'zerotier-one kurulamadı; uzaktan erişim uçları 503 döner, bir sonraki güncellemede yeniden denenir'
      fi
    else
      # Anahtar inmediyse depo YAZILMIYOR — hatta varsa siliniyor. İmzasız bir apt kaynağı
      # eklemek, borulanmış bir betikten daha iyi değil; bu adımın var olma sebebi tam olarak o.
      rm -f /etc/apt/sources.list.d/zerotier.list
      warn 'ZeroTier imza anahtarı indirilemedi; kurulum yapılmadı (uzaktan erişim uçları 503 döner)'
    fi
  fi

  # Daemon kimliğini ve yerel API jetonunu İLK ÇALIŞTIĞINDA üretiyor; o ana kadar ne ajan ne de
  # API onunla konuşabiliyor, yani "kurulu ama hiç koşmamış" hâli kurulu olmamakla aynı.
  if command -v zerotier-cli >/dev/null 2>&1; then
    systemctl enable --now zerotier-one >/dev/null 2>&1 || true
    ok 'zerotier-one çalışıyor'
  fi
}

# ─── 9. systemd ───────────────────────────────────────────────────────────────

units() {
  step 'systemd birimleri'
  local f
  # tmpfiles: podman'ın paylaşılan çalışma dizini, doğru sahiplikle (gerekçe dosyanın içinde).
  install -m 0644 "$REPO/deploy/tmpfiles/depsis-apps.conf" /etc/tmpfiles.d/depsis-apps.conf
  systemd-tmpfiles --create /etc/tmpfiles.d/depsis-apps.conf || true

  # ── SMB DENETİM AKIŞI: AĞDAN YAZILAN DOSYALARIN HIZLI YOLU ──────────────────────────────
  #
  # Ajan her paylaşım bölümüne `full_audit` satırlarını yazıyor, yani smbd her değişiklik için
  # local5'e bir satır basıyor. Bu kural o satırları işçinin izlediği dosyaya ayırıyor.
  #
  # BU ADIM YOKTU ve dosyası deponun içinde kimsenin kurmadığı bir dosya olarak duruyordu —
  # `deploy/systemd/` birimlerinin başına gelenin aynısı. Sonucu, ağ sürücüsünden gönderilen
  # dosyaların Dosyalar ekranında saniyeler yerine on beş dakika sonra görünmesi.
  #
  # 49, Debian'ın kendi 50-default.conf'undan önce: `stop` ancak o zaman denetim satırlarını
  # /var/log/syslog dışında tutuyor. Yoğun bir paylaşım saatte on binlerce satır yazıyor.
  #
  # Dizin 0750 ve grubu depsis-api: işçi okuyor, yazmıyor.
  if [ -d /etc/rsyslog.d ]; then
    install -d -m 0750 -o root -g depsis-api /var/log/depsis
    install -m 0644 "$REPO/deploy/rsyslog/depsis-smb-audit.conf" \
      /etc/rsyslog.d/49-depsis-smb-audit.conf
    systemctl restart rsyslog >/dev/null 2>&1 || true
    ok 'SMB denetim akışı ayrıldı (hızlı indeksleme)'
  else
    # rsyslog yoksa ürün ÇALIŞIYOR, yalnız ağdan yazılanlar on beş dakikalık yürüyüşle
    # indeksleniyor. Söylenmesi gereken bir gecikme, kurulumu durduracak bir eksik değil.
    warn 'rsyslog yok; ağdan yazılan dosyalar düzenli taramayla indekslenecek'
  fi

  # ── VE O AKIŞIN DÖNDÜRÜLMESİ ────────────────────────────────────────────────
  #
  # Kuralın kendisi deponun içinde duruyordu ve hiçbir kurulum yolu onu KURMUYORDU — yukarıdaki
  # rsyslog kuralının başına gelenin aynısı, bir adım geriden. Sonucu şu: yoğun bir paylaşımda
  # /var/log/depsis/smb-audit.log hiç döndürülmüyor ve sistem diskini — PostgreSQL'in de durduğu
  # diski — dolduruyor. O disk dolduğunda veritabanı yazamıyor ve arayüzün tamamı 500 veriyor.
  #
  # rsyslog dalından AYRI bir koşul, çünkü ikisi ayrı paketler: rsyslog'suz bir kutuda da logrotate
  # olabilir, ve dosya `missingok` taşıdığı için günlük hiç doğmamışsa kural sessizce geçiyor.
  #
  # accounts()'tan SONRA olması şart: dosyadaki `su root depsis-api` satırı, depsis-api grubu yoksa
  # logrotate'in tamamını hata verdirir — yalnız bu kuralı değil, o koşudaki her kuralı.
  if [ -d /etc/logrotate.d ]; then
    install -m 0644 "$REPO/deploy/logrotate/depsis-smb-audit" /etc/logrotate.d/depsis-smb-audit
    ok 'SMB denetim günlüğü döndürülüyor (logrotate)'
  else
    warn 'logrotate yok; /var/log/depsis/smb-audit.log sınırsız büyür'
  fi

  for f in "$REPO"/deploy/systemd/*; do
    install -m 0644 "$f" "/etc/systemd/system/$(basename "$f")"
  done

  # ── YETKİLİ KONSOL: OPERATÖRÜN KARARI, DEPONUN DOSYASINDA DEĞİL ─────────────
  #
  # Yukarıdaki döngü birimleri KOŞULSUZ üzerine yazıyor, ve yazmalı: birim dosyaları ürünün
  # parçası. Ama yetkili konsolun tek yolu uzun süre "depsis-console.service'te User=root yap"
  # diye BELGELENMİŞTİ — yani operatörün elle düzenlediği dosya, her güncellemede depodaki hâline
  # dönüyordu. Sonucu sessiz ve tam olarak yanlış yönde: console.env'deki
  # DEPSIS_CONSOLE_PRIVILEGED=1 yerinde kalıyor, birim yeniden depsis-console kullanıcısına
  # dönüyor, ve session.rs uyuşmazlığı görüp başlamayı reddediyor — arayüzde yalnız "Konsol
  # servisi çalışmıyor" yazıyor, sebebi hiçbir ekranda görünmüyor.
  #
  # Karar artık TEK YERDE, console.env'de; User= satırını buradaki drop-in yazıyor. Drop-in
  # ana birimi ezer ve güncelleme onu silmez, çünkü ayrı bir dosya.
  #
  # YALNIZ privileged.conf siliniyor, `.service.d` dizini değil: operatörün kendi drop-in'leri
  # olabilir ve dizini toptan silmek onları da götürürdü.
  local console_dropin=/etc/systemd/system/depsis-console.service.d
  if grep -qE '^DEPSIS_CONSOLE_PRIVILEGED=1[[:space:]]*$' "$ETC/console.env" 2>/dev/null; then
    install -d -m 0755 "$console_dropin"
    cat > "$console_dropin/privileged.conf" <<'DROPIN'
# DEPSIS kurulumu tarafından yazıldı — elle düzenlemeyin.
#
# /etc/depsis/console.env içinde DEPSIS_CONSOLE_PRIVILEGED=1 olduğu için var. O satırı 0 yapıp
# kurulumu yeniden çalıştırmak bu dosyayı siler; konsol yetkisiz hesabına döner.
[Service]
User=root
Group=root
DROPIN
    chmod 0644 "$console_dropin/privileged.conf"
    warn 'yetkili konsol AÇIK (console.env): kabuk root olarak koşacak'
  elif [ -f "$console_dropin/privileged.conf" ]; then
    rm -f "$console_dropin/privileged.conf"
    rmdir "$console_dropin" 2>/dev/null || true
    ok 'yetkili konsol kapatıldı; konsol kendi hesabına döndü'
  fi

  systemctl daemon-reload
  # Çalışan konsol süreci aşağıda ZATEN durduruluyor (soket etkinlemeli servislerin eski süreci
  # ikili değişince yenilenmiyor), yani drop-in bir sonraki bağlantıda yürürlüğe giriyor.
  ok 'birimler kuruldu'

  # Soketler önce: ajan soket etkinlemeli, ve API kalkarken soketin orada olması gerekiyor.
  systemctl enable --now depsis-agent.socket depsis-agent-data.socket depsis-console.socket >/dev/null 2>&1
  # Podman cifti yalniz hesap varsa: hesabi ISO'nun ilk acilisi ya da operator acar. Soket
  # /run/depsis-apps altinda ve depsis-api grubuna 0660 — kullanici oturum dizini (0700) degil;
  # ilk saha kurulumunda EACCES'in dersi bu satirlarin varligi.
  if id -u depsis-apps >/dev/null 2>&1; then
    systemctl enable --now depsis-podman.socket >/dev/null 2>&1 || true
    # Açılışta kurulu uygulamalar geri gelsin: köksüz podman'ın restart politikası yeniden
    # başlatmayı taşımaz — bkz. depsis-apps-restore.service.
    systemctl enable depsis-apps-restore.service >/dev/null 2>&1 || true
  fi
  # Kiosk: paketleri ve hesabı firstboot kurar; ekran kartı da varsa cihaz ekranı arayüz olur.
  # Koşullar birimin kendisinde de var (Condition*); buradaki if yalnız gereksiz enable'ı atlar.
  if id -u depsis-kiosk >/dev/null 2>&1 && [ -e /dev/dri/card0 ]; then
    systemctl enable depsis-kiosk.service >/dev/null 2>&1 || true
  fi
  ok 'soketler açık'

  # pasta'nın AppArmor profili yalnız /run/user/<uid> yolunu tanır; motorumuz oturumsuz hesapla
  # /run/depsis-apps altında koşar. Kural olmadan her konteyner "Couldn't open network namespace
  # ... Permission denied" ile ölür — ilk sahada tam bu yaşandı. Yerel kural + profile include:
  # paket güncellemesi profili tazelese de local/ dosyası kalır.
  if [ -f /etc/apparmor.d/usr.bin.pasta ]; then
    install -d -m 0755 /etc/apparmor.d/local
    printf '# DEPSIS: uygulama kataloğu köksüz podman ile /run/depsis-apps altında çalışır\n/run/depsis-apps/** rw,\n' \
      > /etc/apparmor.d/local/usr.bin.pasta
    grep -q 'local/usr.bin.pasta' /etc/apparmor.d/usr.bin.pasta || \
      sed -i 's|^}$|  include if exists <local/usr.bin.pasta>\n}|' /etc/apparmor.d/usr.bin.pasta
    apparmor_parser -r /etc/apparmor.d/usr.bin.pasta 2>/dev/null || true
    ok 'pasta AppArmor kuralı yerinde'
  fi

  # Soket etkinlemeli servislerin ESKİ SÜRECİ, ikili değişince kendiliğinden yenilenmez — saha
  # bunu şema uyuşmazlığı olarak buldu: API 24 konuşuyor, aylık süreç 23'te. Durdurmak yeter;
  # soket dinlemede kalır ve bir sonraki bağlantı YENİ ikiliyi başlatır.
  systemctl stop depsis-agent.service depsis-console.service 2>/dev/null || true

  systemctl enable depsis-api.service depsis-worker.service >/dev/null 2>&1
  systemctl restart depsis-api.service depsis-worker.service
  ok 'API ve worker başlatıldı; ajan ve konsol yeni ikiliye çevrildi'
}

# ─── 9b. sürüm ve kurulum argümanları ─────────────────────────────────────────
#
# İkisi de GÜNCELLEME İÇİN var, ve ikisi de olmadan güncelleme yapılamaz.
#
# `/etc/depsis/version` kutunun hangi kaynaktan kurulduğunu söyler. Onsuz "yeni sürüm var mı"
# sorusunun karşılaştıracak bir şeyi olmaz; DEPSIS'in sürüm kavramı bir commit kimliğidir, çünkü
# kutuya kurulan şey deponun bir anıdır (etiketli sürüm akışı §21'in 13. teslimatı).
#
# `/etc/depsis/install.args` bu kurulumun ETKİN argümanlarıdır, satır başına bir tane.
# Güncelleyici kurulumu tekrar koşarken onları AYNEN tekrarlar — çünkü bir güncellemenin
# yapmaması gereken tek şey, kutunun yapılandırmasını sessizce değiştirmektir: farklı bir
# `--shares-root` ile koşan bir kurulum, paylaşımları bulunmayan bir yere taşırdı.

version_and_args() {
  step 'sürüm ve kurulum argümanları'

  # Sırayla: güncelleyicinin ağaca yazdığı kimlik, git çalışma ağacı, ISO'nun yazdığı dosya.
  # Hiçbiri yoksa DOSYA YAZILMAZ — "bilinmiyor" diye bir sürüm yazmak, güncelleme ekranına
  # karşılaştırılabilir görünen bir değer verirdi.
  local version=''
  if [ -f "$REPO/.depsis-version" ]; then
    version="$(head -1 "$REPO/.depsis-version" | tr -d '[:space:]')"
  elif git -C "$REPO" rev-parse HEAD >/dev/null 2>&1; then
    version="$(git -C "$REPO" rev-parse HEAD)"
  elif [ -f /opt/depsis-install/VERSION ]; then
    version="$(head -1 /opt/depsis-install/VERSION | tr -d '[:space:]')"
  fi
  if [ -n "$version" ]; then
    printf '%s
' "$version" > "$ETC/version"
    ok "kurulu sürüm: $version"
  else
    warn 'kurulan kaynağın sürümü belirlenemedi; güncelleme denetimi karşılaştırma yapamayacak'
  fi

  # ETKİN değerler, verilen argümanlar değil: `--hostname` verilmediyse burada `hostname`in
  # cevabı yazılı olur, ve güncelleme o adı korur. Verilmemiş bir argümanı yazmamak, bir sonraki
  # kurulumun başka bir cevap bulmasına ve kutunun adının kendiliğinden değişmesine yol açardı.
  {
    printf -- '--hostname
%s
' "$HOSTNAME_WANTED"
    printf -- '--server-name
%s
' "$SERVER_NAME"
    printf -- '--api-port
%s
' "$API_PORT"
    printf -- '--db-name
%s
' "$DB_NAME"
    printf -- '--db-host
%s
' "$DB_HOST"
    printf -- '--db-port
%s
' "$DB_PORT"
    printf -- '--db-superuser
%s
' "$DB_SUPERUSER"
    printf -- '--shares-root
%s
' "$SHARES_ROOT"
    # `if`, `[ … ] && …` DEĞİL. `set -e` altında bir AND-OR listesinin son çalışan komutunun
    # düşmesi betiği sonlandırır, ve bu dört testin düşmesi olağan hâl: çoğu kutuda ayrı bir üst
    # veri kümesi, elle verilmiş havuz listesi ya da HSTS yok. Kısa biçim, kurulumu tam da bu
    # dosyanın `payload` bölümünde yorumlanan tuzağa düşürürdü.
    if [ -n "$SHARE_PARENT_DATASET" ]; then printf -- '--share-parent-dataset
%s
' "$SHARE_PARENT_DATASET"; fi
    if [ -n "$ZFS_POOLS" ]; then printf -- '--zfs-pools
%s
' "$ZFS_POOLS"; fi
    if [ -n "$SMART_DISKS" ]; then printf -- '--smart-disks
%s
' "$SMART_DISKS"; fi
    if [ "$WANT_HSTS" = yes ]; then printf -- '--hsts
'; fi
    # Güncelleme HER ZAMAN gözetimsizdir: ekranda duran kimse yok.
    printf -- '--unattended
'
  } > "$ETC/install.args"
  chmod 0600 "$ETC/install.args"
  ok 'kurulum argümanları güncelleme için kaydedildi'
}

# ─── 10. sağlık ───────────────────────────────────────────────────────────────

verify() {
  step 'doğrulama'

  local i=0
  until curl -fsS "http://127.0.0.1:$API_PORT${API_PREFIX}health" >/dev/null 2>&1; do
    i=$((i+1))
    [ "$i" -lt 60 ] || {
      printf '  %s✗%s API 60 saniyede yanıt vermedi\n' "$R" "$Z"
      journalctl -u depsis-api.service -n 30 --no-pager
      die 'API başlamadı'
    }
    sleep 1
  done
  ok 'API sağlıklı (döngü arayüzünde)'

  # Ve dışarıdan, TLS üzerinden. `-k`, kendinden imzalı sertifikayı kabul etmek için — parmak
  # izini zaten aşağıda yazdırıyoruz, ve buradaki soru sertifikanın güvenilirliği değil,
  # zincirin uçtan uca çalışıp çalışmadığı.
  curl -fsSk "https://127.0.0.1${API_PREFIX}health" >/dev/null \
    || die "nginx üzerinden API'ye ulaşılamıyor"
  ok 'https → nginx → API zinciri çalışıyor'

  curl -fsSk "https://127.0.0.1/" | grep -q '<div id="root">' \
    || die 'arayüz sunulmuyor'
  ok 'arayüz sunuluyor'

  # Güvenlik başlıkları GERÇEKTEN gidiyor mu. nginx'in `add_header` kalıtımı üzerine yazmayla
  # çalıştığı için bu, "yapılandırmada var" ile "yanıtta var" arasındaki farkı ölçen tek adım.
  local head_web head_api missing=''
  head_web="$(curl -sSk -D - -o /dev/null "https://127.0.0.1/")"
  head_api="$(curl -sSk -D - -o /dev/null "https://127.0.0.1${API_PREFIX}health")"
  local h
  for h in 'content-security-policy' 'x-content-type-options' 'referrer-policy'; do
    grep -qi "^$h:" <<<"$head_web" || missing="$missing web/$h"
    grep -qi "^$h:" <<<"$head_api" || missing="$missing api/$h"
  done
  if [ -n "$missing" ]; then die "güvenlik başlıkları eksik:$missing"; fi
  ok "güvenlik başlıkları hem arayüzde hem API'de"

  # Ajan. Yoksa bu bir hata değil — havuz kurulmamış bir kutu olağan — ama söylenmeli.
  if [ "$(systemctl is-active depsis-agent.socket)" = active ]; then
    ok 'ajan soketi dinliyor'
  else warn 'ajan soketi aktif değil; depolama uçları 503 döner'; fi
}

# ─── kapanış ──────────────────────────────────────────────────────────────────

finish() {
  local claimed
  claimed="$(curl -fsSk "https://127.0.0.1${API_PREFIX}setup/status" 2>/dev/null || echo '')"

  printf '\n%s%s kuruldu.%s\n\n' "$B" "DEPSIS" "$Z"
  printf '  Adres        https://%s/\n' "$SERVER_NAME"
  local ip
  for ip in $(hostname -I 2>/dev/null || true); do printf '               https://%s/\n' "$ip"; done
  printf '  Sertifika    SHA-256 %s\n' "$CERT_FINGERPRINT"
  printf '               %sTarayıcı uyarı verecek: sertifika kendinden imzalı. Uyarı ekranındaki%s\n' "$D" "$Z"
  printf '               %sparmak izini yukarıdakiyle karşılaştırın — bu, ortadaki adamı ayırt%s\n' "$D" "$Z"
  printf "               %seden tek şey. Kendi sertifikanız varsa %s içine koyup nginx'i yenileyin.%s\n" "$D" "$TLS_DIR" "$Z"

  if grep -q '"setupRequired":true' <<<"$claimed" 2>/dev/null; then
    printf '\n  İlk yönetici Kurulum sihirbazı bekliyor: yukarıdaki adresi tarayıcıda açın ve\n'
    printf '               ilk hesabı kurun. İlk kuran cihazın yöneticisi olur ve sihirbaz kapanır;\n'
    printf '               jeton ya da anahtar yok.\n'
  else
    printf '\n  İlk yönetici Kurulmuş. Oturum açabilirsiniz.\n'
  fi

  if [ -n "$RECOVERY_PRINTED" ]; then
    if [ "$UNATTENDED" = yes ]; then
      printf '
%s  KURTARMA ANAHTARI ÜRETİLDİ — EKRANA BASILMADI%s
' "$Y" "$Z"
      printf '  %sGözetimsiz kurulumda bu çıktı kalıcı bir günlüğe gider ve bir sır orada%s
' "$D" "$Z"
      printf '  %sdurmamalı. Anahtar: %s (yalnız root okur). İlk fırsatta cihazın DIŞINA%s
' "$D" "$ETC/secret.key" "$Z"
      printf '  %syedekleyin — kaybolursa mühürlü TOTP sırları ve SMB parolaları geri gelmez.%s
' "$D" "$Z"
    else
      printf '
%s  KURTARMA ANAHTARI — BİR KEZ GÖSTERİLİYOR%s
' "$Y" "$Z"
      printf '  %s
' "$RECOVERY_PRINTED"
      printf '  %sBu, at-rest şifreleme anahtarının (%s) kendisi. Kaybederseniz mühürlü%s
' "$D" "$ETC/secret.key" "$Z"
      printf '  %sTOTP sırları geri gelmez ve iki adımlı doğrulama kullanan hesaplar kurtarma%s
' "$D" "$Z"
      printf '  %skodlarıyla girmek zorunda kalır. Cihazın dışında, kâğıtta ya da bir parola%s
' "$D" "$Z"
      printf '  %skasasında saklayın. Bu satır hiçbir yere yazılmadı; yalnız bu ekranda.%s
' "$D" "$Z"
    fi
  fi

  printf '\n  Günlükler    %ssudo journalctl -u depsis-api -u depsis-worker -u depsis-agent -f%s\n' "$D" "$Z"
  printf '  Durum        %ssystemctl status depsis-api depsis-worker depsis-agent nginx%s\n\n' "$D" "$Z"
}

# ─── akış ─────────────────────────────────────────────────────────────────────

CERT_FINGERPRINT=''

preflight
if [ "$CHECK_ONLY" = yes ]; then
  printf '\n%sÖn kontroller geçti.%s --check-only verildiği için hiçbir şey değiştirilmedi.\n' "$G" "$Z"
  exit 0
fi
if [ "$RENEW_CERT" = yes ] && [ -f "$NGINX_SITE" ]; then
  # Yalnız sertifikayı yenilemek, kurulumun tamamını tekrarlamadan yapılabilmeli: bunun için
  # gelen operatör 825 günde bir gelir ve o gün API'yi yeniden başlatmak istemez.
  accounts; tls; systemctl reload nginx
  printf '\nSertifika yenilendi. SHA-256 %s\n' "$CERT_FINGERPRINT"
  exit 0
fi

accounts
secrets
database
payload
configuration
tls
reverse_proxy
samba_conf
zerotier
units
version_and_args
verify
finish
