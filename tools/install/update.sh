#!/usr/bin/env bash
#
# DEPSIS'in kendini güncellemesi.
#
# ── bu betiğin var olma nedeni ───────────────────────────────────────────────
#
# Cihazın sahibi olağan hiçbir iş için terminale girmemeli. Bu ilke uzun süre kurulum ve kullanım
# için geçerliydi ama GÜNCELLEME için değildi: depoda düzelen bir şey, sahadaki kutuya ancak ISO
# yeniden üretilip yeniden kurularak ya da kutuda bir kabuk açılarak gidiyordu. Bir güvenlik
# düzeltmesinin kullanıcıya ulaşamaması, düzeltmenin kendisinden daha büyük bir kusurdur.
#
# ── neden ajan değil de ayrı bir birim ───────────────────────────────────────
#
# Ajanın birimi `IPAddressDeny=any` taşıyor: kök yetkili bir daemon internete çıkmaz. Güncelleme
# ise tanımı gereği ağdan bir şey indirmek. Doğru uzlaşma, ajanın kapısını açmak değil, indirmeyi
# BU betiğe vermek. Ajan yalnızca `systemctl start` ediyor ve durumu okuyor.
#
# ── ne kadarına güveniliyor, ve ne kadarına güvenilmiyor ─────────────────────
#
# İndirilen şey kök yetkiyle KURULACAK koddur, yani bu betiğin güven zinciri ürünün en hassas
# yeri. Bugün dayandığı tek şey HTTPS ve adresin BURADA sabit olması: depo adı istekten gelmiyor,
# çağıran hangi kaynaktan indirileceğini seçemiyor. Bu, aradaki ağı dışarıda tutar; GitHub'ın
# kendisini dışarıda tutmaz. Gerçek cevap imzalı sürümlerdir (§21'in 13. teslimatı) ve o gelene
# kadar bu sınır burada yazılı duruyor — bilinen bir sınır, bilinmeyen bir sınırdan iyidir.
#
# ── geri alma ────────────────────────────────────────────────────────────────
#
# Yeni kaynak yerine konmadan önce eskisi saklanıyor. `install.sh` düşerse eski ağaç geri konup
# yeniden kuruluyor. Bir güncelleme mekanizmasının geri alması yoksa, o mekanizma cihazı
# çalışmaz hâlde bırakabilecek tek düğmedir.
#
# ── kullanım ─────────────────────────────────────────────────────────────────
#
#   update.sh check    yeni sürüm var mı (indirmez, kurmaz)
#   update.sh apply    DENETİMİN BULDUĞU sürümü kur
#
# İkisi de systemd birimleri üzerinden çalışır; elle çağrılması gerekmez ve gerekmemelidir.

set -Eeuo pipefail

# ── kendi üstüne yazılmaya karşı ─────────────────────────────────────────────
#
# `install.sh` bu betiği DE yeniler, ve bash betikleri tembel okur: çalışan bir betiğin dosyası
# yerinde değiştirilirse yorumlayıcı kaldığı bayt konumundan yeni içeriği okumaya devam eder ve
# ortaya çıkan şey ne eski ne yeni betiktir. Bu yüzden ilk iş kendini tmpfs'e kopyalayıp oradan
# devam etmek.
if [ "${DEPSIS_UPDATE_DETACHED:-}" != "1" ]; then
  cp -f "${BASH_SOURCE[0]}" /run/depsis-update.sh
  chmod 0755 /run/depsis-update.sh
  exec env DEPSIS_UPDATE_DETACHED=1 bash /run/depsis-update.sh "$@"
fi

# ── ayarlar ──────────────────────────────────────────────────────────────────

SRC_TREE=/opt/depsis
STATE_DIR=/var/lib/depsis/update
STATE="$STATE_DIR/state.json"
LOG="$STATE_DIR/log"
ARGS_FILE=/etc/depsis/install.args

# Kaynağın adresi BURADA sabit. Bir istekten gelmemesi, bu betiğin güvenlik iddiasının tamamı.
# `/etc/depsis/update.env` ile değiştirilebilir olması bir çelişki değil: o dosyayı yazabilen
# birinin kutuda zaten kök yetkisi vardır.
UPDATE_REPO=avsharbeyi/depsis
UPDATE_BRANCH=main
# `if`, `[ … ] && …` değil: dosya YOKKEN test düşer, ve `set -e` altında bir AND-OR listesinin
# son çalışan komutunun düşmesi betiği sonlandırır — yani dosyanın olmaması güncellemeyi
# sessizce öldürürdü. install.sh aynı tuzağı aynı yorumla taşıyor.
if [ -f /etc/depsis/update.env ]; then
  # shellcheck source=/dev/null
  . /etc/depsis/update.env
fi

NODE=${DEPSIS_UPDATE_NODE:-node}

install -d -m 0700 "$STATE_DIR"

# ── çıktı ────────────────────────────────────────────────────────────────────

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

log() {
  printf '%s  %s\n' "$(now)" "$*" | tee -a "$LOG"
}

# JSON kodlaması node'a bırakılıyor. Kabuğun içinde tırnak kaçırmak, commit başlığı gibi ne
# içerdiğini bilmediğimiz bir metinle uğraşırken bozuk bir durum dosyası üretmenin en kısa yolu.
json_string() {
  "$NODE" -e 'process.stdout.write(JSON.stringify(process.argv[1] ?? ""))' "$1"
}

# stdin'deki JSON nesnesini durum dosyasına birleştirir. ATOMİK: geçici dosya, sonra rename —
# tam yazma anında kesilen bir güç, ajanın okuduğu dosyayı yarım bırakmamalı.
state_merge() {
  "$NODE" -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    let current = {};
    try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    let patch = {};
    try { patch = JSON.parse(fs.readFileSync(0, "utf8")); } catch (error) {
      console.error("yama okunamadi: " + error);
      process.exit(1);
    }
    fs.writeFileSync(file + ".tmp", JSON.stringify({ ...current, ...patch }, null, 2) + "\n");
    fs.renameSync(file + ".tmp", file);
  ' "$STATE"
}

phase() {
  printf '{"phase":%s}\n' "$(json_string "$1")" | state_merge
  log "faz: $1"
}

fail() {
  local message="$1"
  printf '{"phase":"failed","error":%s,"finished_at":%s}\n' \
    "$(json_string "$message")" "$(json_string "$(now)")" | state_merge
  log "HATA: $message"
  exit 1
}

# Beklenmeyen her düşüş de bir cevaptır. Bu tuzak olmadan `set -e` ile ölen bir güncelleme,
# durum dosyasında sonsuza kadar "installing" bırakırdı.
trap 'fail "güncelleyici beklenmedik biçimde durdu (satır $LINENO)"' ERR

need() {
  command -v "$1" >/dev/null 2>&1 || fail "gerekli araç yok: $1"
}

# ── denetim ──────────────────────────────────────────────────────────────────

cmd_check() {
  need curl
  need "$NODE"
  printf '{"phase":"checking","error":null}\n' | state_merge
  log "denetim: $UPDATE_REPO ($UPDATE_BRANCH)"

  local meta
  if ! meta=$(curl -fsSL --max-time 60 \
    -H 'Accept: application/vnd.github+json' \
    -H 'User-Agent: depsis-update' \
    "https://api.github.com/repos/$UPDATE_REPO/commits/$UPDATE_BRANCH" 2>&1); then
    fail "sürüm bilgisi alınamadı (ağ ya da GitHub): $(printf '%s' "$meta" | tail -c 300)"
  fi

  local found
  if ! found=$(printf '%s' "$meta" | "$NODE" -e '
    const meta = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const commit = String(meta.sha ?? "");
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      console.error("beklenen commit kimligi gelmedi");
      process.exit(1);
    }
    const subject = String(meta.commit?.message ?? "").split("\n")[0].slice(0, 200);
    const committed_at = String(meta.commit?.committer?.date ?? "");
    process.stdout.write(JSON.stringify({ commit, subject, committed_at }));
  ' 2>&1); then
    fail "sürüm bilgisi anlaşılamadı: $(printf '%s' "$found" | tail -c 200)"
  fi

  printf '{"phase":"idle","checked_at":%s,"available":%s,"error":null}\n' \
    "$(json_string "$(now)")" "$found" | state_merge
  log "bulunan sürüm: $(printf '%s' "$found" | "$NODE" -e '
    process.stdout.write(JSON.parse(require("node:fs").readFileSync(0, "utf8")).commit);
  ')"
}

# ── kurulum ──────────────────────────────────────────────────────────────────

cmd_apply() {
  need curl
  need tar
  need "$NODE"
  [ -f "$ARGS_FILE" ] || fail "kurulum ayarları yok ($ARGS_FILE): bu kutu güncellenebilir bir kurulumdan gelmiyor"

  local commit
  commit=$("$NODE" -e '
    const fs = require("node:fs");
    let state = {};
    try { state = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
    process.stdout.write(String(state.available?.commit ?? ""));
  ' "$STATE")
  case "$commit" in
    [0-9a-f]*) [ "${#commit}" -eq 40 ] || fail 'kurulacak sürüm geçersiz; önce denetim çalıştırın' ;;
    *) fail 'kurulacak sürüm bilinmiyor; önce denetim çalıştırın' ;;
  esac

  printf '{"phase":"downloading","started_at":%s,"finished_at":null,"error":null}\n' \
    "$(json_string "$(now)")" | state_merge
  log "kurulacak sürüm: $commit"

  local work="$STATE_DIR/work"
  rm -rf "$work"
  install -d -m 0700 "$work"

  # Adres BURADA kuruluyor; commit kimliği de yalnızca [0-9a-f]{40} olabildiği için URL'ye
  # kaçabilecek hiçbir şey taşımıyor.
  if ! curl -fsSL --max-time 900 -H 'User-Agent: depsis-update' \
    -o "$work/src.tar.gz" \
    "https://codeload.github.com/$UPDATE_REPO/tar.gz/$commit"; then
    fail 'kaynak indirilemedi'
  fi

  # Arşivin ÜST DİZİNİ, istenen commit'i taşımalı. GitHub bu dizini `<depo>-<commit>` diye
  # adlandırıyor; bu, imza yerine geçmez ama yanlış bir sürümün sessizce kurulmasını engeller.
  local top
  top=$(tar -tzf "$work/src.tar.gz" | head -1 | cut -d/ -f1)
  case "$top" in
    *"-$commit") : ;;
    *) fail "indirilen arşiv istenen sürümü taşımıyor: $top" ;;
  esac

  tar -xzf "$work/src.tar.gz" -C "$work"
  [ -f "$work/$top/tools/install/install.sh" ] || fail 'indirilen arşivde kurulum betiği yok'
  printf '%s\n' "$commit" >"$work/$top/.depsis-version"

  # ESKİSİ ÖNCE SAKLANIYOR. Bundan sonrasında düşen her şey geri alınabilir olmalı.
  rm -rf "$SRC_TREE.previous"
  if [ -d "$SRC_TREE" ]; then mv "$SRC_TREE" "$SRC_TREE.previous"; fi
  mv "$work/$top" "$SRC_TREE"
  rm -rf "$work"

  phase installing
  log 'kurulum başlıyor (derleme dahil; bu uzun sürebilir)'

  # Boş satırlar ELENİYOR: `install.sh`e boş bir argüman gitmesi "bilinmeyen seçenek: " ile
  # düşmek demek, ve dosyanın sonundaki tek bir satır sonu bunu üretmeye yeter.
  local args=()
  mapfile -t args < <(grep -v '^$' "$ARGS_FILE")
  if bash "$SRC_TREE/tools/install/install.sh" "${args[@]}" >>"$LOG" 2>&1; then
    printf '{"phase":"done","finished_at":%s,"error":null}\n' "$(json_string "$(now)")" | state_merge
    log "güncelleme bitti: $commit"
    rm -rf "$SRC_TREE.previous"
    return 0
  fi

  # ── geri alma ──────────────────────────────────────────────────────────────
  phase rolling_back
  log 'kurulum düştü; eski sürüme dönülüyor'
  if [ -d "$SRC_TREE.previous" ]; then
    rm -rf "$SRC_TREE"
    mv "$SRC_TREE.previous" "$SRC_TREE"
    if bash "$SRC_TREE/tools/install/install.sh" "${args[@]}" >>"$LOG" 2>&1; then
      fail 'güncelleme kurulamadı; cihaz eski sürüme geri alındı ve çalışır durumda'
    fi
    fail 'güncelleme kurulamadı VE geri alma da düştü; günlüğe bakın'
  fi
  fail 'güncelleme kurulamadı; geri alınacak eski sürüm yoktu'
}

# ── akış ─────────────────────────────────────────────────────────────────────

case "${1:-}" in
  check) cmd_check ;;
  apply) cmd_apply ;;
  *)
    printf 'kullanım: update.sh check|apply\n' >&2
    exit 2
    ;;
esac
