# DEPSIS

Yerel ağda çalışan bir NAS cihazının yazılımı: web arayüzü, SMB paylaşımı, ZFS depolama ve
ayrıcalıklı işlemleri yapan küçük bir sistem ajanı.

Tasarım kararları `docs/adr/` altında, ölçümler `tools/poc/` altında. Bu dosya yalnızca "nasıl
çalıştırırım, nasıl girerim" sorusunu cevaplıyor.

## Çalıştırmak

Gerekenler: Linux (systemd pid 1 olarak), PostgreSQL 18, Node 24, pnpm.

```bash
pnpm install
bash tools/dev/up.sh
```

Betik veritabanını kurar, migration'ları uygular, API ve web'i derler, ikisini geçici systemd
birimi olarak başlatır ve ilk yöneticiyi yaratır. Bitince adresi ve giriş bilgilerini yazar:

```
  http://<ip>:3200

  Kullanıcı adı : admin
  Parola        : depsis-dev-parola-42
```

Durdurmak için `bash tools/dev/up.sh --down`.

### WSL'de

WSL, kendisine bağlı oturum kalmayınca dağıtımı kapatır ve servisler onunla birlikte ölür. Bir
terminal açık tutun:

```bash
wsl -d <dağıtım>            # bu pencere açık kaldığı sürece servisler ayakta
bash tools/dev/up.sh
```

Windows'tan `http://127.0.0.1:3200` çalışmıyorsa dağıtımın IP'sini kullanın — betik onu zaten
yazıyor, ya da `hostname -I` verir.

## Ne çalışıyor, ne çalışmıyor

`tools/dev/up.sh` ayrıcalıklı ajanı **çalıştırmaz**. Ajan olmadan bir paylaşıma bayt yazılamaz, o
yüzden yükleme ve indirme 503 döner. Listeleme, klasör oluşturma, yeniden adlandırma, çöp kutusu,
kullanıcı yönetimi ve telemetri çalışır.

Arayüzde iki adımlı doğrulama **yok**. Sunucu tarafı duruyor ve test ediliyor, ama hesabı olan
kimsenin açamayacağı bir ekran bir özellik değil; yerel ağdaki bir NAS için istenen de bu değildi.
Giriş kullanıcı adı ve parolayla yapılır — e-posta adresi ve ayrı bir "görünen ad" yoktur.

Baytların gerçekten aktığı tam kurulum `deploy/systemd/` altındaki birim dosyalarıdır ve
`tools/poc/p1-d-systemd-deployment.sh` onu uçtan uca ölçer — klasör aç, yükle, dosya sisteminden
oku, indir, adını değiştir, çöpe at.

```bash
sudo PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=... bash tools/poc/p1-d-systemd-deployment.sh
```

## Faz 1'de henüz olmayanlar

Ürünün hangi kısmının bittiğini iddia etmek yerine ölçüyoruz. Bugün itibarıyla eksik olanlar:

- Arama (`/search`) ve taşıma/kopyalama (`/file-operations`) — sözleşmede tanımlı, uygulanmadı.
- Dosya sistemi olaylarından metadata'yı besleyen endeksleyici. Bu olmadan yalnız DEPSIS
  üzerinden yüklenen dosyalar listede görünür; SMB'den yazılanlar görünmez.
- ZFS havuzu yaratma. Ajan dataset yaratabiliyor, havuz yaratamıyor — mirror sihirbazı bu yüzden
  yok.
- Samba paylaşımı gerçekten yazılmıyor: `publish_samba_config` yalnız `testparm` koşuyor.
- Kullanıcı → POSIX uid eşlemesi (ADR-0004). Yayımlanan dosyalar şimdilik API'nin servis hesabına
  ait.
- ZeroTier / uzaktan bağlantı. Faz 3 (§20); bu depoda hiçbir parçası yok.
- Tarayıcı (e2e) testleri. CI'da `echo` yapan bir iş olarak duruyor.

## Depo düzeni

```
apps/api        NestJS API
apps/web        React arayüz
apps/worker     iş kuyruğu tüketicisi
packages/db     SQL migration'ları
packages/contracts   OpenAPI ve ondan üretilen istemci tipleri
packages/agent-protocol  ajanın şeması, Rust'tan üretilir
services/system-agent    ayrıcalıklı ajan (Rust, root)
deploy/systemd  birim dosyaları
docs/adr        mimari kararlar
tools/poc       ölçüm betikleri
```
