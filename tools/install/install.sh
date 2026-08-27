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
#   ZeroTier     — ADR-0020: DEPSIS onu paketlemiyor ve kurmuyor. Varsa bulur ve söyler.
#   PostgreSQL   — dağıtımın paketi. Erişilebilir olmasını ister, kurmaz.
#   İlk yönetici — /setup/claim, tarayıcıdan. Betik adresi ve jetonun nerede olduğunu yazar.
#
# ── kullanım ─────────────────────────────────────────────────────────────────
#
#   sudo bash tools/install/install.sh --hostname depsis --shares-root /srv/depsis
#   sudo bash tools/install/install.sh --check-only          yalnız ön kontroller
#   sudo bash tools/install/install.sh --renew-cert          sertifikayı yenile ve çık

set -Eeuo pipefail

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
  # ADR-0020: paketlemiyoruz, kurmuyoruz. Varlığı bir yapılandırma kararı, ve `zerotier-one`ın
  # kendisi controller — ayrı bir servis yok.
  if command -v zerotier-cli >/dev/null 2>&1; then
    ok 'zerotier-one kurulu — uzaktan erişim ve kendi ağını kurma açılabilir'
  else
    same 'zerotier-one kurulu değil — uzaktan erişim uçları 503 döner (ADR-0020: DEPSIS onu kurmaz)'
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
  # HER ZAMAN, --skip-build verilse bile. Bir migration bir derleme çıktısı değil, veritabanının
  # şemasıdır; ikisini tek bayrağın arkasına koymak, "yalnız ikilileri yeniden kopyala" demek
  # isteyen operatöre şemayı da atlatırdı — ve şemasız bir yükseltme, ilk isteğinde düşen bir API.
  ( cd "$REPO" && DEPSIS_MIGRATION_DATABASE_URL="$owner_url" \
      pnpm --filter @depsis/db run migrate:up >/dev/null )
  ok 'şema güncel'
}

# ─── 5. yükleme ───────────────────────────────────────────────────────────────

payload() {
  step 'derleme ve yerleştirme'

  if [ "$SKIP_BUILD" = no ]; then
    ( cd "$REPO" && pnpm install --frozen-lockfile >/dev/null )
    ( cd "$REPO" && pnpm turbo run build >/dev/null )
    ok 'TypeScript derlendi'
    if command -v cargo >/dev/null 2>&1; then
      ( cd "$REPO" && cargo build --release --bin depsis-agent --bin depsis-console >/dev/null )
      ok 'Rust ikilileri derlendi'
    else
      warn 'cargo yok; target/release altındaki mevcut ikililer kullanılacak'
    fi
  else
    same '--skip-build: mevcut çıktı kullanılıyor'
  fi

  local bin
  for bin in depsis-agent depsis-console; do
    [ -x "$REPO/target/release/$bin" ] || die "$bin derlenmemiş: cargo build --release --bin $bin"
    install -m 0755 "$REPO/target/release/$bin" "$PREFIX/$bin"
  done
  ok "ajan ve konsol ikilileri $PREFIX altında"

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
DEPSIS_ZFS_POOLS=$ZFS_POOLS
DEPSIS_SMART_DISKS=$SMART_DISKS
ENV
  chmod 0644 "$ETC/api.env"

  printf 'DEPSIS_API_UID=%s\nDEPSIS_SHARES_ROOT=%s\n' "$(id -u depsis-api)" "$SHARES_ROOT" > "$ETC/agent.env"
  chmod 0644 "$ETC/agent.env"
  ok "$ETC/api.env ve $ETC/agent.env"

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

tls() {
  step 'TLS sertifikası'
  local crt="$TLS_DIR/depsis.crt" key="$TLS_DIR/depsis.key"

  local need=no
  if [ ! -s "$crt" ] || [ ! -s "$key" ]; then need=yes
  elif [ "$RENEW_CERT" = yes ]; then need=yes; same 'sertifika --renew-cert ile yenileniyor'
  # 30 gün kalmışsa yenile. `-checkend` saniye alıyor.
  elif ! openssl x509 -in "$crt" -noout -checkend 2592000 >/dev/null 2>&1; then
    need=yes; warn 'sertifikanın bitmesine 30 günden az kaldı; yenileniyor'
  fi

  if [ "$need" = no ]; then
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

# ─── 9. systemd ───────────────────────────────────────────────────────────────

units() {
  step 'systemd birimleri'
  local f
  for f in "$REPO"/deploy/systemd/*; do
    install -m 0644 "$f" "/etc/systemd/system/$(basename "$f")"
  done
  systemctl daemon-reload
  ok 'birimler kuruldu'

  # Soketler önce: ajan soket etkinlemeli, ve API kalkarken soketin orada olması gerekiyor.
  systemctl enable --now depsis-agent.socket depsis-agent-data.socket depsis-console.socket >/dev/null 2>&1
  ok 'soketler açık'

  systemctl enable depsis-api.service depsis-worker.service >/dev/null 2>&1
  systemctl restart depsis-api.service depsis-worker.service
  ok 'API ve worker başlatıldı'
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
    printf "\n  İlk yönetici Kurulum sihirbazı bekliyor. Tek kullanımlık jeton API'nin günlüğünde:\n"
    printf '               %ssudo journalctl -u depsis-api.service | grep -A2 "setup token"%s\n' "$D" "$Z"
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
units
verify
finish
