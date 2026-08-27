#!/usr/bin/env bash
#
# DEPSIS — kurulum ISO'sunun ilk açılış adımı.
#
# Debian kurulumu bitti, kutu ilk kez kendi diskinden açıldı; bu betik `depsis-firstboot.service`
# tarafından bir kez çalıştırılır. İşi: DEPSIS'in Debian depolarında OLMAYAN bağımlılıklarını
# kurmak (PostgreSQL 18, Node 24, Rust) ve sonra işi asıl kurulum betiğine devretmek —
# /opt/depsis-install/depsis-src.tar.gz içindeki tools/install/install.sh, yani elle kurulumda
# çalıştırılacak betiğin TA KENDİSİ. İki yol tek betikte birleşir; ISO ayrı bir kurulum yolu
# değildir, aynı yolun başına eklenmiş bir taşıttır.
#
# İDEMPOTENT, install.sh ile aynı gerekçeyle: her adım önce bakar. İlk açılışta ağ yoksa ya da
# bir indirme düşerse birim BAŞARISIZ kalır ve bir SONRAKİ açılışta yeniden dener; başarıyla
# bitince kendini kapatır ve /var/lib/depsis/firstboot.done yazar.
#
# Günlük hem journal'da hem konsolda (birim dosyası öyle yönlendiriyor): kutuya monitör
# bağlayan biri ne olduğunu ekranda görür.

set -Eeuo pipefail

MARKER=/var/lib/depsis/firstboot.done
SRC=/opt/depsis-install
REPO=/opt/depsis

say() { printf '\n== DEPSIS ilk açılış: %s\n' "$1"; }

if [ -f "$MARKER" ]; then
  echo "DEPSIS ilk açılış zaten tamamlanmış ($MARKER); bir şey yapılmadı."
  exit 0
fi

# ── 1. ağ ────────────────────────────────────────────────────────────────────
say 'ağ bekleniyor'
for _ in $(seq 1 60); do
  getent hosts deb.debian.org >/dev/null 2>&1 && break
  sleep 2
done
getent hosts deb.debian.org >/dev/null 2>&1 || {
  echo 'HATA: ağa ulaşılamıyor. Kablo/DHCP kontrol edin; bu adım bir sonraki açılışta yeniden dener.'
  exit 1
}

export DEBIAN_FRONTEND=noninteractive
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# ── 2. Debian'ın kendi paketleri ─────────────────────────────────────────────
say 'temel paketler'
apt-get update -qq
apt-get install -y -qq nginx openssl iproute2 build-essential pkg-config \
  postgresql-common linux-headers-amd64 smartmontools >/dev/null

say 'ZFS (contrib deposundan, dkms derlemesi birkaç dakika sürer)'
apt-get install -y zfsutils-linux || {
  echo 'UYARI: zfsutils-linux kurulamadı; havuz kurulana kadar depolama uçları 503 döner.'
}

# ── 3. PostgreSQL 18 (resmî PGDG deposu; Debian 13 kendi deposunda 17 taşıyor) ─
#
# `command -v psql` YETMEZ ve bunu ilk saha kurulumu öğretti: postgresql-common, gerçek istemci
# kurulu olmadan da /usr/bin/psql diye bir SARMALAYICI koyuyor. O sarmalayıcı sürüm sorulunca
# hata basıp boş dönüyor, boş dize sayı karşılaştırmasını patlatıyor ve `if` koşulu sessizce
# yanlışa düşüyordu — PostgreSQL hiç kurulmadan geçiliyordu. Sürümü hatayı yutarak oku; boşsa
# "yok" say.
# Sondaki `|| true` süs değil: psql yokken grep "eşleşme yok" ile 1 döner, `pipefail` bunu
# komut değiştirmenin durumuna taşır ve `set -e` betiği TAM BURADA öldürür — üç saha kurulumu
# arka arkaya, ZFS'ten hemen sonra, tek satır iz bırakmadan böyle düştü.
PG_MAJOR="$( (psql -V 2>/dev/null || true) | grep -oE '[0-9]+' | head -1 || true )"
if [ -z "$PG_MAJOR" ] || [ "$PG_MAJOR" -lt 18 ]; then
  say 'PostgreSQL 18'
  # Çıktı bilerek SUSTURULMUYOR: bu adım sahada gerekçesiz bir FAILED bırakarak düştü.
  /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
  apt-get install -y postgresql-18
fi

# ── 4. Node 24 (NodeSource; Debian 13 kendi deposunda daha eskisini taşıyor) ─
NODE_MAJOR="$( (node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true) | head -1 || true )"
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 24 ]; then
  say 'Node 24'
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
command -v pnpm >/dev/null 2>&1 || { corepack enable >/dev/null 2>&1 || npm install -g pnpm >/dev/null; }
# pnpm'in kendisi ilk çağrıda iner; burada, sorusuz ortam değişkeni altında bir kez ısıtılıyor.
pnpm --version >/dev/null 2>&1 || true

# ── 5. Rust (ajan ve konsol ikilileri bu kutuda derlenir) ────────────────────
if ! command -v cargo >/dev/null 2>&1 && [ ! -x /root/.cargo/bin/cargo ]; then
  say 'Rust'
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal >/dev/null
fi
export PATH="/root/.cargo/bin:$PATH"

# ── 5b. ZeroTier ─────────────────────────────────────────────────────────────
#
# ADR-0020 "DEPSIS onu kurmaz" diyordu; sahibi ilk gerçek kurulumda uzaktan erişimi açmak
# isteyince karşısına terminal çıktı, ve bu ürünün ilkesine aykırı: cihaz sahibi terminale
# girmez. Karar değişti — cihaz uzaktan erişim YETENEĞİYLE gelir; bir ağa katılmak yine
# arayüzden, yine sahibinin kararıyla olur. Kurulamazsa uyarı: uçlar 503 döner, cihaz çalışır.
if ! command -v zerotier-cli >/dev/null 2>&1; then
  say 'ZeroTier'
  curl -fsSL https://install.zerotier.com | bash ||     echo 'UYARI: ZeroTier kurulamadı; uzaktan erişim uçları 503 döner.'
fi

# ── 6. kaynak ────────────────────────────────────────────────────────────────
say 'DEPSIS kaynağı'
if [ ! -f "$REPO/tools/install/install.sh" ]; then
  mkdir -p "$REPO"
  tar -xzf "$SRC/depsis-src.tar.gz" -C "$REPO"
fi

# ── 7. asıl kurulum ──────────────────────────────────────────────────────────
# `--unattended`: kurtarma anahtarını EKRANA BASMAZ — buradaki her satır journal'a yazılır ve
# journal kalıcıdır; bir sırrın orada durması, hiç gösterilmemesinden kötüdür. Anahtarın yeri
# betiğin çıktısında söylenir ve yedeklenmesi yöneticiye kalır.
say 'DEPSIS kuruluyor (tools/install/install.sh)'
bash "$REPO/tools/install/install.sh" \
  --hostname "$(hostname)" \
  --shares-root /srv/depsis \
  --unattended

# ── 8. bitiş ─────────────────────────────────────────────────────────────────
install -d -m 0755 /var/lib/depsis
date -Is > "$MARKER"
systemctl disable depsis-firstboot.service >/dev/null 2>&1 || true

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<DONE

  ────────────────────────────────────────────────────────────
  DEPSIS hazır.

  Tarayıcıdan açın:   https://${IP:-<bu-kutunun-ip-adresi>}/
  Sahiplenme jetonu:  sudo journalctl -u depsis-api | grep -B2 -A2 token
  Kurtarma anahtarı:  /etc/depsis/secret.key — cihaz DIŞINA yedekleyin;
                      kaybolursa iki adımlı doğrulama kayıtları geri gelmez.
  ────────────────────────────────────────────────────────────
DONE
