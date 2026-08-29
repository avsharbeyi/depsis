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

# İMZALI KİP İLE İMZASIZ KİP ARASINDAKİ TEK FARK BU DOSYA. Varsa, güncelleyici yalnız
# YAYINLANMIŞ VE İMZALI sürümleri kabul eder; yoksa dalın son commit’ini kurar ve arayüz
# bunu "imzasız kaynak" diye söyler.
#
# Yedek yol bilerek YOK: imza doğrulanamazsa kurulum düşer, "o zaman imzasız devam edelim"
# demez. Öyle bir yedek yol, tam olarak saldırganın kullanacağı yoldur.
RELEASE_PUBKEY=/usr/local/lib/depsis/release-key.pub
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

# YAYINLANMIŞ SÜRÜM. Kimlik bir etiket (`v0.1.0`), commit değil: imzalanan şey bir etiketin
# arşividir, ve kutuya kurulan şeyin adı da o olmalı.
check_release() {
  log "denetim: $UPDATE_REPO yayinlanmis surumler (imzali kip)"
  local meta
  if ! meta=$(curl -fsSL --max-time 60 \
    -H 'Accept: application/vnd.github+json' \
    -H 'User-Agent: depsis-update' \
    "https://api.github.com/repos/$UPDATE_REPO/releases/latest" 2>&1); then
    fail "surum bilgisi alinamadi (ag ya da GitHub): $(printf '%s' "$meta" | tail -c 300)"
  fi

  local found
  if ! found=$(printf '%s' "$meta" | "$NODE" -e '
    const meta = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const commit = String(meta.tag_name ?? "");
    // Etiket bir URL parcasi olacak: harf, rakam, nokta, tire ve alt cizgi disinda hicbir sey.
    if (!/^v[A-Za-z0-9._-]{1,60}$/.test(commit)) {
      console.error("beklenen etiket gelmedi");
      process.exit(1);
    }
    const subject = String(meta.name ?? commit).split("\n")[0].slice(0, 200);
    const committed_at = String(meta.published_at ?? "");
    process.stdout.write(JSON.stringify({ commit, subject, committed_at }));
  ' 2>&1); then
    fail "surum bilgisi anlasilamadi: $(printf '%s' "$found" | tail -c 200)"
  fi

  printf '{"phase":"idle","checked_at":%s,"available":%s,"signed":true,"error":null}\n' \
    "$(json_string "$(now)")" "$found" | state_merge
  log "bulunan surum: $(printf '%s' "$found" | "$NODE" -e '
    process.stdout.write(JSON.parse(require("node:fs").readFileSync(0, "utf8")).commit);
  ')"
}

cmd_check() {
  need curl
  need "$NODE"
  printf '{"phase":"checking","error":null}\n' | state_merge

  if [ -f "$RELEASE_PUBKEY" ]; then
    check_release
    return 0
  fi
  log "denetim: $UPDATE_REPO ($UPDATE_BRANCH) — imzasiz kaynak"

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

  printf '{"phase":"idle","checked_at":%s,"available":%s,"signed":false,"error":null}\n' \
    "$(json_string "$(now)")" "$found" | state_merge
  log "bulunan sürüm: $(printf '%s' "$found" | "$NODE" -e '
    process.stdout.write(JSON.parse(require("node:fs").readFileSync(0, "utf8")).commit);
  ')"
}

# ── imza ─────────────────────────────────────────────────────────────────────

# Bir Ed25519 imzasını doğrular.
#
# `pkeyutl -rawin`, `dgst -sha256 -verify` DEĞİL, ve bu ayrım ölçüldü: Ed25519 "saf" bir imza
# algoritması — özeti kendi içinde alıyor ve ona dışarıdan bir özet dayatmak openssl
# tarafından reddediliyor ("Explicit digest not allowed with EdDSA operations"). İlk hâli tam
# olarak bunu yapıyordu; kimse bir sürüm çıkarmayı denemediği için de görünmüyordu.
#
# KENDİ ALT KOMUTU OLMASININ SEBEBİ bu: `appliance` kapısı bu komutu ÜRÜNÜN kendi kodundan
# çağırıyor. Kapının kendi kopyasını yazmış olsaydı, doğruladığı şey kendi kopyası olurdu.
# İkinci faydası bir insana: indirdiği bir arşivi elle doğrulamak isteyen biri de bunu
# çağırabilir.
verify_signature() {
  local pubkey="$1" file="$2" signature="$3"
  openssl pkeyutl -verify -rawin -pubin -inkey "$pubkey" \
    -sigfile "$signature" -in "$file" >/dev/null 2>&1
}

# ── kurulum ──────────────────────────────────────────────────────────────────

# İmzalı bir sürümü indirir, DOĞRULAR, ve kurar.
#
# Doğrulama açmadan ÖNCE: bir arşivi açmak, içindekilere disk ayırmak ve dosya adlarına
# güvenmek demek. İmza tutmuyorsa o arşiv hiç açılmamalı.
apply_release() {
  local tag="$1"
  local base="https://github.com/$UPDATE_REPO/releases/download/$tag"
  local work="$STATE_DIR/work"
  rm -rf "$work"
  install -d -m 0700 "$work"

  printf '{"phase":"downloading","started_at":%s,"finished_at":null,"error":null}\n' \
    "$(json_string "$(now)")" | state_merge
  log "kurulacak surum: $tag (imzali)"

  if ! curl -fsSL --max-time 900 -H 'User-Agent: depsis-update' \
    -o "$work/src.tar.gz" "$base/depsis-$tag.tar.gz"; then
    fail 'surum arsivi indirilemedi'
  fi
  if ! curl -fsSL --max-time 120 -H 'User-Agent: depsis-update' \
    -o "$work/src.tar.gz.sig" "$base/depsis-$tag.tar.gz.sig"; then
    fail 'surum imzasi indirilemedi'
  fi

  phase verifying
  if ! verify_signature "$RELEASE_PUBKEY" "$work/src.tar.gz" "$work/src.tar.gz.sig"; then
    rm -rf "$work"
    fail 'IMZA DOGRULANAMADI: bu arsiv bu cihazin guvendigi anahtarla imzalanmamis. Hicbir sey kurulmadi.'
  fi
  log "imza dogrulandi"

  local top="depsis-$tag"
  tar -xzf "$work/src.tar.gz" -C "$work"
  [ -f "$work/$top/tools/install/install.sh" ] || fail 'indirilen arsivde kurulum betigi yok'
  printf '%s\n' "$tag" >"$work/$top/.depsis-version"
  install_tree "$work" "$top" "$tag"
}

# Yeni agaci yerine koyar, kurulumu kosturur, duserse eskisine doner.
#
# İki cagirani var (imzali ve imzasiz kip) ve tek yerde durmasinin sebebi bu: geri alma
# mantiginin iki kopyasi, bir gun ikisinden birinde eksik kalir.
install_tree() {
  local work="$1" top="$2" version="$3"

  rm -rf "$SRC_TREE.previous"
  if [ -d "$SRC_TREE" ]; then mv "$SRC_TREE" "$SRC_TREE.previous"; fi
  mv "$work/$top" "$SRC_TREE"
  rm -rf "$work"

  phase installing
  log 'kurulum basliyor (derleme dahil; bu uzun surebilir)'

  local args=()
  mapfile -t args < <(grep -v '^$' "$ARGS_FILE")
  if bash "$SRC_TREE/tools/install/install.sh" "${args[@]}" >>"$LOG" 2>&1; then
    printf '{"phase":"done","finished_at":%s,"error":null}\n' "$(json_string "$(now)")" | state_merge
    log "guncelleme bitti: $version"
    rm -rf "$SRC_TREE.previous"
    return 0
  fi

  phase rolling_back
  log 'kurulum dustu; eski surume donuluyor'
  if [ -d "$SRC_TREE.previous" ]; then
    rm -rf "$SRC_TREE"
    mv "$SRC_TREE.previous" "$SRC_TREE"
    if bash "$SRC_TREE/tools/install/install.sh" "${args[@]}" >>"$LOG" 2>&1; then
      fail 'guncelleme kurulamadi; cihaz eski surume geri alindi ve calisir durumda'
    fi
    fail 'guncelleme kurulamadi VE geri alma da dustu; gunluge bakin'
  fi
  fail 'guncelleme kurulamadi; geri alinacak eski surum yoktu'
}

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

  # İMZALI KİP. Kimlik bir etiket, ve indirilen arşiv doğrulanmadan hiçbir yere konmuyor.
  if [ -f "$RELEASE_PUBKEY" ]; then
    case "$commit" in
      v[A-Za-z0-9._-]*) : ;;
      *) fail 'kurulacak surum bilinmiyor; once denetim calistirin' ;;
    esac
    apply_release "$commit"
    return 0
  fi

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

  # Bundan sonrasi iki kipte de AYNI, ve tek yerde duruyor: geri alma mantiginin iki kopyasi,
  # bir gun ikisinden birinde eksik kalir.
  install_tree "$work" "$top" "$commit"
}

# ── akış ─────────────────────────────────────────────────────────────────────

case "${1:-}" in
  check) cmd_check ;;
  apply) cmd_apply ;;
  # Kapının ve elle doğrulamak isteyen bir insanın kullandığı yol. Hiçbir şey değiştirmiyor.
  verify)
    [ $# -eq 4 ] || {
      printf 'kullanim: update.sh verify <acik-anahtar> <dosya> <imza>\n' >&2
      exit 2
    }
    if verify_signature "$2" "$3" "$4"; then
      printf 'imza dogrulandi\n'
    else
      printf 'IMZA DOGRULANAMADI\n' >&2
      exit 1
    fi
    ;;
  *)
    printf 'kullanım: update.sh check|apply\n' >&2
    exit 2
    ;;
esac
