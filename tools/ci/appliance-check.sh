#!/usr/bin/env bash
#
# CİHAZ KATMANI KAPISI — gerçek ZFS, gerçek Samba, gerçek ayrıcalıklı ajan.
#
# ── neden var ────────────────────────────────────────────────────────────────
#
# CI'da "integration (needs Debian VM — ADR-0012)" adında bir iş vardı ve HİÇBİR ŞEY KOŞMUYORDU:
# hangi yarısının hâlâ bir Hyper-V/Debian hedefi beklediğini anlatan birkaç `echo`. Her push'ta
# yeşil yanıyordu, ve yeşil bir kutu "bu kapsanıyor" demektir — kapsamadığı hâlde. Sahte bir
# yeşil, kırmızıdan kötüdür: kırmızı bakılacak yeri söyler, sahte yeşil bakmayı gereksiz kılar.
#
# Bu betik o işin yerine geçiyor. Bekleneni değil, YAPILABİLENİ koşuyor — ve GitHub'ın ubuntu
# koşucusu sanılandan fazlasını yapabiliyor: root var, systemd var, ZFS modülü depoda, Samba
# depoda, döngü aygıtları çalışıyor. Kalan tek gerçek eksik fiziksel disk kimliği (ADR-0012'nin
# `/dev/disk/by-id` zinciri, P0-A §1) ve o hâlâ bir VM işi; betiğin sonunda açıkça söyleniyor.
#
# ── neyi kanıtlıyor ──────────────────────────────────────────────────────────
#
# Buradaki her adım, üründe SAHADA kırılmış bir şeyin karşılığı:
#
#   * `create_directory`in chown'u — ajan root olmadan başka bir uid'e chown edemiyor (e2e bunu
#     bir kez EPERM'le öğrendi).
#   * `apply_folder_acl` — ajan `setfacl`'a `/proc/<pid>/fd/N` veriyor, ve bu ancak GERÇEK bir
#     exec'te sınanabilir; sahada her paylaşımın her izni sessizce yazılamıyordu ve hiçbir birim
#     testi göremezdi.
#   * `publish_samba_config` — `testparm` temiz geçip smbd'nin bağlantı reddettiği durum ADR-0011
#     ve P0-B'nin konusu; ajan yayını canlı bir bağlantıyla kanıtlamak zorunda.
#   * `agent.integration.test.ts` — sınırın iki yarısının (Rust ajan ↔ TypeScript istemci) aynı
#     zarftan bahsettiği, yalnız gerçek bir soket varken ölçülebiliyor. Migration işi onu bilerek
#     DIŞLIYOR; kapsandığı tek yer burası.
#
# ── nasıl koşulur ────────────────────────────────────────────────────────────
#
#   sudo bash tools/ci/appliance-check.sh
#
# Root ister ve DİSK SİLMEZ: havuz iki seyrek DOSYA üzerine kuruluyor. Yine de atılabilir bir
# makine varsayıyor — sonunda kendi havuzunu yok ediyor.
set -Eeuo pipefail

# corepack pnpm'i ILK kullanimda indirir ve varsayilan olarak SORAR; stdin'i olmayan bir
# kapida o soru cevaplanamaz ve adim SONSUZA KADAR bekler. Yerel provada tam bu oldu: kosum
# on alti dakika asili kaldi, tek satir cikti vermeden. Bir kapinin en kotu davranisi dusmek
# degil ASILMAKTIR — dusen kapi bakilacak yeri soyler, asilan kapi yalniz zaman yakar.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
POOL="${DEPSIS_CI_POOL:-depsisci}"
ID_POOL="${DEPSIS_CI_ID_POOL:-depsisid}"
SHARES_ROOT=/srv/depsis-ci
IMAGES=/var/tmp/depsis-ci-disks
SOCKET_DIR=/run/depsis
AGENT_BIN="${DEPSIS_CI_AGENT_BIN:-$REPO/target/release/depsis-agent}"
LOG=/tmp/depsis-ci-agent.log

# API tarafını taşıyacak ayrıcalıksız hesap. Ajanın politikası uid 0'ı REDDEDİYOR (`Policy`), ve
# bu reddin kendisi ADR-0006'nın bir parçası: root'un root'a konuşması sınırı sınamaz.
API_USER="${SUDO_USER:-runner}"
id -u "$API_USER" >/dev/null 2>&1 || API_USER="$(getent passwd 1000 | cut -d: -f1)"
API_UID="$(id -u "$API_USER")"
API_GID="$(id -g "$API_USER")"

pass=0
fail=0
check() {
  local what="$1" got="$2" want="$3"
  if [[ "$got" == *"$want"* ]]; then
    printf '  ✓ %s\n' "$what"
    pass=$((pass + 1))
  else
    printf '  ✗ %s\n      beklenen: %s\n      gelen   : %s\n' "$what" "$want" "${got:0:400}"
    fail=$((fail + 1))
  fi
}

say() { printf '\n── %s\n' "$1"; }

# Ajanı ve havuzu HER çıkışta topluyoruz: yarıda kalan bir koşum, bir sonraki koşumun havuzunu
# "beklenmeyen havuz" diye reddettirir.
cleanup() {
  set +e
  [ -n "${AGENT_PID:-}" ] && kill "$AGENT_PID" 2>/dev/null
  zpool destroy "$POOL" 2>/dev/null
  zpool destroy "$ID_POOL" 2>/dev/null
  # Sahte SCSI diskleri: modul kaldirilmadan birakilirsa bir sonraki kosumun envanterinde
  # beklenmedik diskler olarak durur.
  rmmod scsi_debug 2>/dev/null
  rm -rf "$IMAGES" "$SOCKET_DIR"
}
trap cleanup EXIT

[ "$(id -u)" -eq 0 ] || { echo 'root gerekiyor: sudo ile çalıştırın' >&2; exit 1; }
[ "$API_UID" -ne 0 ] || { echo 'ayrıcalıksız bir hesap gerekiyor (SUDO_USER)' >&2; exit 1; }
[ -x "$AGENT_BIN" ] || { echo "ajan ikilisi yok: $AGENT_BIN" >&2; exit 1; }

# ── 1. ZFS: iki dosyadan ayna havuz ──────────────────────────────────────────
#
# Dosya vdev'leri gerçek disk değil ve olmak zorunda da değil: burada sınanan şey ADR-0007'nin
# dayandığı ZFS PRİMİTİFLERİ (veri kümesi, mountpoint, acltype, anlık görüntü), disk kimliği
# değil. Disk kimliği zinciri fiziksel donanım istiyor ve bu betiğin kapsamı dışında.
say 'ZFS havuzu (iki dosya, ayna)'
modprobe zfs 2>/dev/null || true
zpool version >/dev/null 2>&1 || { echo 'ZFS yok; zfsutils-linux kurulmalı' >&2; exit 1; }

mkdir -p "$IMAGES"
truncate -s 512M "$IMAGES/a.img" "$IMAGES/b.img"
zpool create -f -o ashift=12 -O acltype=posixacl -O xattr=sa "$POOL" mirror "$IMAGES/a.img" "$IMAGES/b.img"
zfs create -o "mountpoint=$SHARES_ROOT" "$POOL/depsis"
check 'havuz kuruldu ve ONLINE' "$(zpool list -H -o health "$POOL")" 'ONLINE'
check 'paylaşım kökü bir veri kümesi' "$(zfs list -H -o name "$POOL/depsis")" "$POOL/depsis"

# ── 2. Samba: DEPSIS'in yazacağı dosyayı içeren bir smb.conf ────────────────
say 'Samba'
install -d -m 0755 /etc/samba
[ -f /etc/samba/depsis.conf ] || : >/etc/samba/depsis.conf
grep -q 'include = /etc/samba/depsis.conf' /etc/samba/smb.conf 2>/dev/null ||
  printf '\ninclude = /etc/samba/depsis.conf\n' >>/etc/samba/smb.conf
systemctl restart smbd 2>/dev/null || smbd -D
# Sayı DEĞİL varlık: smbd hem IPv4 hem IPv6 dinliyor, yani sayı 2 — ve ilk hâli "1" bekleyip
# düşmüştü. Bir kapının kendi iddiası yanlışsa, ölçtüğü şey hakkında hiçbir şey söylemez.
check 'smbd 445 dinliyor' "$(ss -tln 2>/dev/null | grep ':445' | head -1)" ':445'

# ── 3. Ajan: üretimdeki gibi, systemd'nin devrettiği soketlerle ─────────────
#
# `systemd-socket-activate` LISTEN_FDS protokolünü servis yöneticisi olmadan konuşuyor; ajan
# başka türlü başlamayı zaten reddediyor (soketin DAC'ı ilk yetki kapısı). Soket yolları
# ÜRETİMDEKİ yollar, çünkü probe istemcisi (tools/poc/agent-client.mjs) onları biliyor.
say 'ayrıcalıklı ajan'
install -d -m 0755 "$SOCKET_DIR"
DEPSIS_API_UID="$API_UID" DEPSIS_SHARES_ROOT="$SHARES_ROOT" DEPSIS_ZFS_POOLS="$POOL" \
  systemd-socket-activate \
  -l "$SOCKET_DIR/agent.sock" --fdname=control \
  -l "$SOCKET_DIR/agent-data.sock" --fdname=data \
  -E DEPSIS_API_UID -E DEPSIS_SHARES_ROOT -E DEPSIS_ZFS_POOLS \
  "$AGENT_BIN" --serve >"$LOG" 2>&1 &
AGENT_PID=$!

for _ in $(seq 1 50); do
  [ -S "$SOCKET_DIR/agent.sock" ] && break
  sleep 0.2
done
[ -S "$SOCKET_DIR/agent.sock" ] || { echo 'ajan soketi açılmadı:'; cat "$LOG"; exit 1; }
chgrp "$API_GID" "$SOCKET_DIR/agent.sock" "$SOCKET_DIR/agent-data.sock"
chmod 0660 "$SOCKET_DIR/agent.sock" "$SOCKET_DIR/agent-data.sock"

# Her çağrı API HESABIYLA: ajan uid 0'dan gelen bağlantıyı reddediyor, ve o red bu kapının
# ölçtüğü şeylerden biri.
ask() {
  local reason="$1" request="$2"
  # `timeout` ve `</dev/null`: cevap gelmemesi bir SONUCTUR, beklenecek bir sey degil.
  # Ajan sirali calisiyor — asili tek bir cagri butun kapiyi suresiz durdurabilirdi.
  timeout 30 runuser -u "$API_USER" -- node "$REPO/tools/poc/agent-client.mjs" control \
    "{\"correlation_id\":\"ci-$RANDOM\",\"reason\":\"$reason\",\"request\":$request}" \
    </dev/null 2>&1 || echo "CEVAP YOK (zaman asimi ya da hata)"
}

check 'sürüm el sıkışması' "$(ask handshake '{"op":"ping"}')" '"status":"ok"'
check 'havuzlar operandsız listeleniyor' "$(ask pools '{"op":"list_pools"}')" "$POOL"
check 'paylaşım kökünün veri kümesi biliniyor' \
  "$(ask root '{"op":"share_root_status"}')" "$POOL/depsis"
check 'diskler operandsız listeleniyor' "$(ask disks '{"op":"list_disks"}')" '"status":"disks"'

# ── 4. Paylaşım: veri kümesi, klasör, ACL — sahada kırılan üç adım ──────────
say 'paylaşım yaşam döngüsü'
check 'veri kümesi açıldı' \
  "$(ask share "{\"op\":\"create_dataset\",\"dataset\":\"$POOL/depsis/belgeler\",\"acltype\":\"posixacl\",\"refquota_bytes\":null}")" \
  '"status":"created"'
check 've gerçekten posixacl' \
  "$(zfs get -H -o value acltype "$POOL/depsis/belgeler")" 'posix'

# Chown'lu klasör: ajan root olmadan bunu yapamaz, ve DEPSIS'in verdiği uid'ler 300000+.
check 'klasör DEPSIS uid ile açıldı' \
  "$(ask folder '{"op":"create_directory","share":"belgeler","path":["faturalar"],"owner_uid":300001,"owner_gid":300001}')" \
  '"status":"directory_created"'
check 've sahibi gerçekten o uid' \
  "$(stat -c '%u:%g' "$SHARES_ROOT/belgeler/faturalar")" '300001:300001'

# ACL: `setfacl`'a verilen /proc/<pid>/fd/N yolunun GERÇEK bir exec'ten sonra çözüldüğü buradan
# başka hiçbir yerde sınanmıyor — sahada tam bu yüzden hiçbir izin yazılamamıştı.
check 'ACL uygulandı' \
  "$(ask acl '{"op":"apply_folder_acl","share":"belgeler","path":["faturalar"],"entries":[{"gid":300000,"read":true,"write":true,"execute":true}]}')" \
  '"status":"acl_applied"'
check 've kernel onu gerçekten taşıyor' \
  "$(getfacl -p "$SHARES_ROOT/belgeler/faturalar" 2>/dev/null)" 'group:300000:rwx'
check 'varsayılan ACL de yazıldı (kalıtım)' \
  "$(getfacl -p "$SHARES_ROOT/belgeler/faturalar" 2>/dev/null)" 'default:group:300000:rwx'

# ── 5. Anlık görüntü ─────────────────────────────────────────────────────────
say 'anlık görüntü'
check 'alındı' \
  "$(ask snap "{\"op\":\"create_snapshot\",\"dataset\":\"$POOL/depsis/belgeler\",\"name\":\"ci\"}")" \
  '"status":"snapshot"'
check 've havuzda görünüyor' \
  "$(ask list "{\"op\":\"list_snapshots\",\"dataset\":\"$POOL/depsis/belgeler\"}")" 'ci'

# ── 6. Samba yayını: testparm YETMEZ, canlı bağlantı şart ──────────────────
say 'Samba yayını'
check 'yayınlandı ve DOĞRULANDI' \
  "$(ask publish "{\"op\":\"publish_samba_config\",\"shares\":[{\"name\":\"belgeler\",\"dataset\":\"$POOL/depsis/belgeler\",\"read_only\":false,\"valid_users\":[]}]}")" \
  '"verified":true'
check 'smbd paylaşımı gerçekten sunuyor' \
  "$(smbclient -N -L //127.0.0.1 2>/dev/null)" 'belgeler'

# ── 6b. DISK KIMLIGI ZINCIRI (ADR-0012, risk R1) ────────────────────────────
#
# Bu bolum uzun sure "fiziksel donanim ister" diye kapsam disinda birakildi, ve o iddia ZFS icin
# soylenenle ayni cinstendi: yanlis. `scsi_debug` cekirdek modulu udev in gordugu GERCEK SCSI
# diskleri uretiyor — kendi VPD sayfalariyla, yani kendi WWN leriyle ve kendi /dev/disk/by-id
# baglantilariyla. Dosya vdev lerinin tasimadigi tek sey buydu.
#
# Burada sinanan sey ADR-0012 nin urune dusen yari: DEPSIS diski ADIYLA degil KIMLIGIYLE tanir,
# ve havuz kurulurken kimligi ANINDA yeniden dogrular. Risk R1 in tek gercek azaltmasi bu ve
# bugune kadar hicbir otomatik kapida kosmadi — cunku kosacak bir disk yoktu.
say 'disk kimligi zinciri (ADR-0012)'
# Once KALDIRILIYOR: modul baska parametrelerle zaten yukluyse `modprobe` SESSIZCE hicbir sey
# yapmaz ve kapi yanlis boyutta/sayida diskle karsilasir.
rmmod scsi_debug 2>/dev/null || true
modprobe scsi_debug dev_size_mb=128 num_tgts=2 2>/dev/null || true
udevadm settle 2>/dev/null || sleep 2

# Ajanin okudugu KOLONLARIN aynisi (`disks::COLUMNS`): kapinin urunle ayni yerden bakmasi sart,
# yoksa "lsblk boyle diyor" ile "DEPSIS boyle goruyor" ayrisir ve kapi bir sey kanitlamaz.
mapfile -t FAKE < <(lsblk -dn -o NAME,MODEL,ID-LINK,WWN | awk '$2 == "scsi_debug" { print $1 "\t" $3 "\t" $4 }')
check 'iki sahte SCSI diski goruldu' "${#FAKE[@]}" '2'

if [ "${#FAKE[@]}" -ge 2 ]; then
  D1_NAME=$(printf '%s' "${FAKE[0]}" | cut -f1)
  D1_BYID=$(printf '%s' "${FAKE[0]}" | cut -f2)
  D1_WWN=$(printf '%s' "${FAKE[0]}" | cut -f3)
  D2_BYID=$(printf '%s' "${FAKE[1]}" | cut -f2)
  D2_WWN=$(printf '%s' "${FAKE[1]}" | cut -f3)

  # ZINCIRIN BIRINCI HALKASI: kararli ad var, ve gercekten o aygiti gosteriyor.
  check 'by-id baglantisi var ve aygiti gosteriyor' \
    "$(readlink -f "/dev/disk/by-id/$D1_BYID" 2>/dev/null)" "/dev/$D1_NAME"
  # IKINCI HALKA: WWN (VPD sayfa 0x83). ADR-0012 kimligi buna dayandiriyor, seriye degil.
  check 'WWN okunuyor' "$D1_WWN" '0x'

  # UCUNCU HALKA: URUN ayni seyi goruyor mu. lsblk in dogru cevap vermesi yetmez; ajanin
  # envanteri ayni kimlikleri tasimali.
  INVENTORY=$(ask disks '{"op":"list_disks"}')
  check 'ajanin envanteri by-id yi tasiyor' "$INVENTORY" "$D1_BYID"
  check 'ajanin envanteri WWN i tasiyor' "$INVENTORY" "$D1_WWN"

  # SISTEM DISKI: kutunun kendi diski asla havuz adayi olamaz, ve bu bir diyalog meselesi degil.
  # Kokun uzerinde durdugu DISK: bolum ustundeyse ust aygiti (PKNAME), degilse aygitin
  # kendisi — WSL de kok dogrudan bir diskte duruyor ve PKNAME bos donuyor.
  ROOT_SRC=$(findmnt -no SOURCE / 2>/dev/null | head -1)
  printf '    (kök: %s)
' "$ROOT_SRC"
  ROOT_DISK=$(lsblk -no PKNAME "$ROOT_SRC" 2>/dev/null | head -1)
  [ -n "$ROOT_DISK" ] || ROOT_DISK=$(basename "$ROOT_SRC")
  # JSON u NODE ayristiriyor, grep degil: bir kapinin kendi olcumu kirilgan olmamali, ve
  # "holds_system" i satir icinde aramak alanlarin sirasina bagli bir iddiadir.
  check 'kutunun kendi diski sistem diski olarak isaretli' \
    "$(printf '%s' "$INVENTORY" | node "$REPO/tools/ci/holds-system.mjs" "$ROOT_DISK")" \
    'true'

  # HAVUZ, GERCEK DISKLERLE ve DOGRU kimlikle: dosya vdev i buraya kadar gelemiyordu.
  check 'dogru WWN ile havuz kuruldu' \
    "$(ask pool "{\"op\":\"create_pool\",\"pool\":\"$ID_POOL\",\"topology\":\"mirror\",\"disks\":[{\"by_id\":\"$D1_BYID\",\"wwn\":\"$D1_WWN\"},{\"by_id\":\"$D2_BYID\",\"wwn\":\"$D2_WWN\"}]}")" \
    '"status":"pool_created"'
  check 've havuz gercekten var' "$(zpool list -H -o name "$ID_POOL" 2>&1)" "$ID_POOL"
  zpool destroy "$ID_POOL" 2>/dev/null

  # RISK R1 IN TEK GERCEK AZALTMASI: sihirbazin diski listeledigi an ile dugmeye basildigi an
  # arasinda disk degistirilebilir, ve /dev/disk/by-id bir YUVAYI degil bir AYGITI adlandirir —
  # yani ayni ad baska bir disk olabilir. Ajan envanteri KENDISI, tam o anda okuyup WWN i
  # karsilastiriyor. Yanlis WWN ile ayni istek REDDEDILMELI.
  check 'yanlis WWN ile ayni istek reddediliyor' \
    "$(ask pool "{\"op\":\"create_pool\",\"pool\":\"$ID_POOL\",\"topology\":\"mirror\",\"disks\":[{\"by_id\":\"$D1_BYID\",\"wwn\":\"0xdeadbeefdeadbeef\"},{\"by_id\":\"$D2_BYID\",\"wwn\":\"$D2_WWN\"}]}")" \
    'not the one that was confirmed'
  check 've reddedilen havuz gercekten kurulmadi' "$(zpool list -H -o name "$ID_POOL" 2>&1)" 'no such pool'

  # Diski silme de ayni kimlik kapisindan geciyor: yanlis WWN, silme icin de yeterli degil.
  check 'yanlis WWN ile disk silme de reddediliyor' \
    "$(ask wipe "{\"op\":\"wipe_disk\",\"disk\":{\"by_id\":\"$D1_BYID\",\"wwn\":\"0xdeadbeefdeadbeef\"}}")" \
    'not the one that was confirmed'
fi

# ── 7. Sınırın iki yarısı: TypeScript istemci ↔ Rust ajan ──────────────────
#
# Migration işi bu dosyayı DIŞLIYOR (canlı soket yok). Kapsandığı tek yer burası.
say 'AgentService ↔ ajan (P1-C)'
if timeout 600 runuser -u "$API_USER" -- env \
  DEPSIS_AGENT_SOCKET="$SOCKET_DIR/agent.sock" \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  bash -c "cd '$REPO' && pnpm --filter @depsis/api exec vitest run src/agent/agent.integration.test.ts" \
  </dev/null >/tmp/depsis-ci-vitest.log 2>&1; then
  check 'süit geçti' 'ok' 'ok'
else
  printf '  ✗ agent.integration.test.ts düştü:\n'
  tail -40 /tmp/depsis-ci-vitest.log
  fail=$((fail + 1))
fi
# Atlanmış bir süit, koşmamış bir süittir: kapı açıkken sıfır test koşması sessiz bir yeşil olur.
check 've hiçbir testi atlamadı' \
  "$(grep -cE 'skipped' /tmp/depsis-ci-vitest.log || true)" '0'

# ── sonuç ────────────────────────────────────────────────────────────────────
printf '\n%d geçti, %d düştü\n' "$pass" "$fail"
printf 'Kapsanmayan tek sey: ADR-0000/0012 nin HYPER-V e ozgu olgusu — storvsc INQUIRY sayfa\n'
printf '0x80 i bastirdigi icin orada seri numarasi YOK. Bu bir hipervizor davranisi, urun kodu\n'
printf 'degil; kod tarafi (seri opsiyonel, kimlik WWN e dayali) yukarida sinaniyor.\n'
[ "$fail" -eq 0 ]
