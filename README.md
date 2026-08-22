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

## Cihazın dışındaki üç şey

Konsol, uygulamalar ve uzak erişim; üçü de DEPSIS'in **paketlemediği** bir şeyi yönetiyor.
Kuruluysa yönetir, değilse arayüz "kurulu değil" der. Hiçbiri sessizce bozulmaz: eksik bir arka uç
503 döner ya da `available: false` ile 200 — asla 500.

Geliştirme kutusuna üçünü de kuran betik:

```bash
sudo bash tools/dev/provision-vm.sh
```

- **Konsol** (ADR-0018) — yalnız yönetici, üstelik oturum açıkken bile parola sorar. Ayrıcalıklı
  ajanda ÇALIŞMAZ: `services/console` kendi systemd birimi, varsayılan olarak ayrıcalıksız bir
  kullanıcıda. `systemctl disable depsis-console` özelliği tamamen kapatır. Girilen her satır
  denetime yazılır, çıktı yazılmaz. Root kabuk isteyen kurulum birim dosyasını elle düzenler.
- **Uygulamalar** (ADR-0019) — Podman. Katalog küratörlü: kullanıcı imaj adı yazamaz, çünkü
  serbest imaj adı "internetten indirilen keyfi kodu çalıştır" demektir. Kaldırma konteyneri
  siler, **bağlanan paylaşımlara dokunmaz**.
- **Uzak erişim** (ADR-0020) — ZeroTier. Jeton root okunabilir olduğu için ajanın arkasından,
  dört tiplenmiş işlemle. Bir ağa katılmak, ağ yöneticisi cihazı onaylayana kadar bağlantı
  sağlamaz; arayüz bunu "onay bekliyor" diye gösterir, "bağlanıyor" diye değil.

DEPSIS hiçbirini indirmez ve `curl | bash` çalıştırmaz — `provision-vm.sh` ZeroTier'i kendi
imzalı apt deposundan kurar.

## Faz 1'de henüz olmayanlar

Ürünün hangi kısmının bittiğini iddia etmek yerine ölçüyoruz. Bugün itibarıyla eksik olanlar:

- **Klasörler diskte YOK, yalnızca veritabanı satırı.** Ajanda `mkdir` işlemi olmadığı için
  `POST /files/folders` bir satır yazıyor ve dizin yaratmıyor. Sonucu: bir klasörü taşımak dosya
  sistemi tarafında hiçbir zaman çalışamaz, ve bir klasörün adını değiştirmek yalnız satırı
  değiştirir. Dosyalar için ikisi de gerçek — `MoveEntry` ile ajandan geçiyor.

  Bu, listelemenin ve indirmenin bugün çalışmasını engellemiyor (yol her zaman satırlardan
  kuruluyor) ama SMB'den bakan biri klasörleri göremez. Ajana `mkdir` eklemek ayrı bir tur.

- Ekip (`teams`) ve klasör bazlı ACL (§6.2). Şu an yalnız organizasyon düzeyinde admin/member var.
- Dosya sistemi olaylarından metadata'yı besleyen endeksleyici. Bu olmadan yalnız DEPSIS
  üzerinden yüklenen dosyalar listede görünür; SMB'den yazılanlar görünmez.
- ZFS havuzu yaratma. Ajan dataset ve anlık görüntü yaratabiliyor, havuz yaratamıyor — mirror
  sihirbazı bu yüzden yok.
- Samba'nın kullanıcı eşlemesi. Yapılandırma artık gerçekten yazılıyor (atomik + `testparm` +
  canlı bağlantı denemesi + başarısızlıkta geri dönüş) ama bölümlerde `valid users` yok: bir
  paylaşımı kimin açabileceği henüz POSIX izinlerine bırakılmış durumda. §6.2'nin API'siyle
  birlikte gelecek.
- Kullanıcı → POSIX uid eşlemesi (ADR-0004). Yayımlanan dosyalar şimdilik API'nin servis hesabına
  ait.
- İzin arayüzü. Şema (0015) ve sözleşme yazıldı, uçlar yazılmadı — `contract.test.ts` on bir
  işlemi "tarif edilmiş ama sunulmuyor" olarak sayıyor ve her birinin gerekçesi kayıtlı.
  `FileEntry.permissions` bugün herkese aynı yedi izni döndürüyor; bu bir yer tutucu değil,
  bugünün doğru cevabı — her `/files` ucu kiracının her üyesini kabul ediyor ve yalnız RLS
  daraltıyor.
- Tarayıcı (e2e) testleri. CI'da `echo` yapan bir iş olarak duruyor.
- Anlık görüntü listesi havuzun envanteri DEĞİL. Ajanda "listele" işlemi yok, o yüzden `/backups`
  yalnız DEPSIS'in kendi aldıklarını gösterir ve yanıtta `complete: false` ile bunu söyler.

## Depo düzeni

```
apps/api        NestJS API
apps/web        React arayüz
apps/worker     iş kuyruğu tüketicisi
packages/db     SQL migration'ları
packages/contracts   OpenAPI ve ondan üretilen istemci tipleri
packages/agent-protocol  ajanın şeması, Rust'tan üretilir
services/system-agent    ayrıcalıklı ajan (Rust, root)
services/console         yönetici konsolu (Rust, ayrı birim — ajan DEĞİL)
deploy/systemd  birim dosyaları
docs/adr        mimari kararlar
tools/poc       ölçüm betikleri
```
