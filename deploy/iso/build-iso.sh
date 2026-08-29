#!/usr/bin/env bash
#
# DEPSIS kurulum ISO'sunu üret.
#
# Debian'ın RESMÎ netinst ISO'sunu alır ve içine dört şey ekler: ön-yanıt dosyası (preseed.cfg),
# ilk açılış betiği ve birimi, ve deponun o anki kaynağı. Önyükleme menüsüne "DEPSIS kur" girdisi
# ekler; o girdiyle açılan kurulum yalnız iki soru sorar (hangi disk, ilk hesap), gerisi kendi
# kendine akar ve kutu ilk açılışında DEPSIS'i kurar.
#
# NEDEN BAŞTAN İMAL DEĞİL, YENİDEN PAKETLEME. Debian'ın imzalı kurulum zinciri — çekirdek,
# initrd, UEFI shim, grub — olduğu gibi kalıyor; eklenenler yalnız VERİ dosyaları. `xorriso`'nun
# `-boot_image any replay` kipi El Torito/isohybrid önyükleme kayıtlarını kaynaktan kopyalar,
# yani çıkan ISO da hem BIOS hem UEFI ile, USB'ye ham yazılarak açılır. Denetlenebilirlik de
# bundan geliyor: bu betiğin diff'i, ISO'nun Debian'dan farkının TAMAMI.
#
#   bash deploy/iso/build-iso.sh                        # ISO'yu indirir, doğrular, üretir
#   bash deploy/iso/build-iso.sh --iso debian-13.6.0-amd64-netinst.iso
#   bash deploy/iso/build-iso.sh --out /tmp/depsis.iso
#
# Gereksinim: xorriso, wget, git (Linux/WSL üzerinde; Windows'ta tools/dev/wsl-* kalıbıyla).

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

SRC_ISO=''
OUT_ISO=''
MIRROR='https://cdimage.debian.org/debian-cd/current/amd64/iso-cd'

while [ $# -gt 0 ]; do
  case "$1" in
    --iso) SRC_ISO="${2:?}"; shift 2 ;;
    --out) OUT_ISO="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "bilinmeyen seçenek: $1" >&2; exit 1 ;;
  esac
done

for cmd in xorriso wget git sha512sum; do
  command -v "$cmd" >/dev/null || { echo "eksik: $cmd (apt install xorriso wget git)" >&2; exit 1; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── 1. kaynak ISO: verilmemişse İNDİR ve İMZALI TOPLAMLA DOĞRULA ─────────────
#
# SHA512SUMS her koşuda tazelenir ve ISO ona karşı doğrulanır. Yarım inmiş ya da değiştirilmiş
# bir kaynaktan üretilen "DEPSIS ISO'su", üzerine ne yazarsak yazalım Debian değildir.
if [ -z "$SRC_ISO" ]; then
  wget -q -O "$WORK/SHA512SUMS" "$MIRROR/SHA512SUMS"
  NAME="$(awk '/ debian-[0-9.]+-amd64-netinst\.iso$/ {print $2; exit}' "$WORK/SHA512SUMS")"
  [ -n "$NAME" ] || { echo 'netinst adı SHA512SUMS içinde bulunamadı' >&2; exit 1; }
  SRC_ISO="$REPO/deploy/iso/$NAME"
  if [ ! -f "$SRC_ISO" ]; then
    echo "→ indiriliyor: $NAME (~800 MB)"
    wget -q --show-progress -O "$SRC_ISO.part" "$MIRROR/$NAME"
    mv "$SRC_ISO.part" "$SRC_ISO"
  fi
  echo '→ sağlama doğrulanıyor'
  ( cd "$(dirname "$SRC_ISO")" \
    && grep " $(basename "$SRC_ISO")\$" "$WORK/SHA512SUMS" | sha512sum -c --quiet - ) \
    || { echo 'SHA512 doğrulaması BAŞARISIZ; dosya silinip yeniden indirilmeli' >&2; exit 1; }
fi
[ -f "$SRC_ISO" ] || { echo "ISO yok: $SRC_ISO" >&2; exit 1; }

# İKİ BİÇİM, ve ikisinin işi ayrı. Kısası ISO dosyasının adında — insan okur. TAMI kutuya
# yazılır, çünkü güncelleme denetimi onu GitHub’ın verdiği kırk haneli kimlikle karşılaştırır
# ve kısaltılmış bir kimlik o karşılaştırmayı sessizce hep "farklı" yapardı.
VERSION="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo dev)"
# ETIKETLI BIR COMMIT ISE ETIKET, degilse commit kimligi.
#
# Sebebi guncelleme denetimi: imzali kipte cihaz YAYINLANMIS SURUMLERE bakiyor ve onlarin adi
# `v0.1.0` gibi bir etiket. ISO commit kimligi yazsaydi, o ISOdan kurulan kutu daha ilk gun
# "yeni surum var" derdi — zaten kurulu olan surumu isaret ederek.
VERSION_FULL="$(git -C "$REPO" describe --exact-match --tags HEAD 2>/dev/null \
  || git -C "$REPO" rev-parse HEAD 2>/dev/null || echo dev)"
[ -n "$OUT_ISO" ] || OUT_ISO="$REPO/deploy/iso/depsis-installer-$VERSION.iso"

# ── 2. yük: /depsis dizini ────────────────────────────────────────────────────
PAY="$WORK/depsis"
mkdir -p "$PAY"
cp "$HERE/preseed.cfg" "$HERE/firstboot.sh" "$HERE/depsis-firstboot.service" "$PAY/"
# Varsa uzaktan destek anahtarı — preseed onu /root/.ssh/authorized_keys yapar. İsteğe bağlı:
# dosya yoksa ISO anahtarsız çıkar ve kutuya yalnız konsoldan girilir.
[ -f "$REPO/deploy/destek-anahtari.pub" ] && cp "$REPO/deploy/destek-anahtari.pub" "$PAY/"
chmod 0755 "$PAY/firstboot.sh"

# Deponun O ANKİ kaynağı, git archive ile: çalışma ağacındaki kaydedilmemiş kirlilik ISO'ya
# sızmaz, ve ISO'nun içeriği tek bir commit'le adlandırılabilir.
echo "→ kaynak paketleniyor (HEAD = $VERSION)"
git -C "$REPO" archive --format=tar.gz -o "$PAY/depsis-src.tar.gz" HEAD
printf '%s\n' "$VERSION_FULL" > "$PAY/VERSION"

# ── 3. önyükleme menüleri ────────────────────────────────────────────────────
#
# İki menü var çünkü iki önyükleme yolu var: BIOS isolinux'u okur, UEFI grub'ı. İkisine de aynı
# girdi ekleniyor ve VARSAYILAN yapılıyor — bu ISO'yu yazan kişinin niyeti DEPSIS kurmak.
# `priority=high`: preseed'in yanıtlamadığı iki soru (disk, hesap) sorulur, gerisi susar.
echo '→ önyükleme menüleri'
xorriso -osirrox on -indev "$SRC_ISO" \
  -extract /isolinux/txt.cfg "$WORK/txt.cfg" \
  -extract /boot/grub/grub.cfg "$WORK/grub.cfg" \
  -extract /md5sum.txt "$WORK/md5sum.txt" >/dev/null 2>&1
chmod +w "$WORK/txt.cfg" "$WORK/grub.cfg" "$WORK/md5sum.txt"

# `vga=788` YOK, ve bu bir saha dersi: Debian'ın kendi metin girdisindeki o eski VESA kipi bazı
# ekran kartlarında "Trying to enable the frame buffer" satırında donuyor. Çekirdeğin kendi
# kipini seçmesi her donanımda güvenli olan yol.
KARGS='auto=true priority=high preseed/file=/cdrom/depsis/preseed.cfg'

{
  printf 'default depsis\nlabel depsis\n\tmenu label ^DEPSIS kur (otomatik)\n'
  printf '\tkernel /install.amd/vmlinuz\n'
  printf '\tappend %s initrd=/install.amd/initrd.gz ---\n' "$KARGS"
  cat "$WORK/txt.cfg" | sed 's/^default .*//'
} > "$WORK/txt.cfg.new"
mv "$WORK/txt.cfg.new" "$WORK/txt.cfg"

{
  printf 'set default=0\nset timeout=8\n'
  printf 'menuentry "DEPSIS kur (otomatik)" {\n'
  printf '    linux    /install.amd/vmlinuz %s ---\n' "$KARGS"
  printf '    initrd   /install.amd/initrd.gz\n}\n'
  cat "$WORK/grub.cfg"
} > "$WORK/grub.cfg.new"
mv "$WORK/grub.cfg.new" "$WORK/grub.cfg"

# ── 4. md5sum.txt: eklenen ve değişen her dosya için ─────────────────────────
#
# Kurulumun isteğe bağlı bütünlük denetimi bu dosyayı okur. Eklediklerimizi yazmamak, o denetimi
# çalıştıran ilk kişide "ISO bozuk" diye görünür — bozuk olmayan bir ISO'da.
echo '→ md5sum.txt'
grep -v -e './isolinux/txt.cfg' -e './boot/grub/grub.cfg' "$WORK/md5sum.txt" > "$WORK/md5sum.new"
( cd "$WORK" \
  && md5sum txt.cfg | sed 's| txt.cfg| ./isolinux/txt.cfg|' >> md5sum.new \
  && md5sum grub.cfg | sed 's| grub.cfg| ./boot/grub/grub.cfg|' >> md5sum.new \
  && cd "$PAY" \
  && for f in *; do md5sum "$f" | sed "s| $f| ./depsis/$f|" >> "$WORK/md5sum.new"; done )
mv "$WORK/md5sum.new" "$WORK/md5sum.txt"

# ── 5. yeniden paketle ───────────────────────────────────────────────────────
echo "→ ISO yazılıyor: $OUT_ISO"
rm -f "$OUT_ISO"
xorriso -indev "$SRC_ISO" -outdev "$OUT_ISO" \
  -map "$PAY" /depsis \
  -map "$WORK/txt.cfg" /isolinux/txt.cfg \
  -map "$WORK/grub.cfg" /boot/grub/grub.cfg \
  -map "$WORK/md5sum.txt" /md5sum.txt \
  -boot_image any replay 2>&1 | grep -E 'replay|Written|NOTE|WARNING' || true

# ── 6. doğrula ───────────────────────────────────────────────────────────────
echo '→ doğrulama'
xorriso -indev "$OUT_ISO" -find /depsis -type f 2>/dev/null | sed 's/^/    /'
SIZE="$(du -h "$OUT_ISO" | cut -f1)"
SHA="$(sha256sum "$OUT_ISO" | cut -d' ' -f1)"

cat <<DONE

DEPSIS kurulum ISO'su hazır.

  Dosya    $OUT_ISO ($SIZE)
  SHA-256  $SHA
  Kaynak   $(basename "$SRC_ISO") + depo $VERSION

USB'ye yazın (Windows'ta Rufus/balenaEtcher "dd kipi", Linux'ta):

  sudo dd if=$OUT_ISO of=/dev/sdX bs=4M conv=fsync status=progress

Kutu USB'den açılınca menüde "DEPSIS kur (otomatik)" seçili gelir. Kurulum iki şey sorar —
hangi disk ve ilk hesap — gerisini kendi yapar; ilk açılışta bağımlılıkları indirip DEPSIS'i
kurar (ağ gerekir) ve ekrana adresi yazar.
DONE
