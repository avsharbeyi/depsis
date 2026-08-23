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

- Dosya sistemi olaylarından metadata'yı besleyen endeksleyici. Bu olmadan yalnız DEPSIS
  üzerinden yüklenen dosyalar listede görünür; SMB'den yazılanlar görünmez.
- ZFS havuzu yaratma. Ajan dataset ve anlık görüntü yaratabiliyor, havuz yaratamıyor — mirror
  sihirbazı bu yüzden yok. `POST /shares` bir dataset açar ama havuzu operatör kurar.
- Paylaşımı SİLMEK. Grant'ları paylaşımı tutuyor (`ON DELETE RESTRICT`) ve son grant'ı silmek de
  reddediliyor. Bilinçli: paylaşımı silmek dataset'i silmek demek, ve ADR-0007 yıkıcı havuz
  işlemlerini üründen dışarıda tutuyor. Kapatmanın yolu, kimseyi adlandırmayan bir kök izni.
- Samba'nın kullanıcı eşlemesi. Yapılandırma gerçekten yazılıyor (atomik + `testparm` + canlı
  bağlantı denemesi + başarısızlıkta geri dönüş) ama bölümlerde `valid users` yok: bir paylaşımı
  SMB'den kimin açabileceği POSIX izinlerine bırakılmış durumda. Web tarafındaki izin modeli
  (§6.2) çalışıyor ve ACL'ler yazılıyor; eksik olan `smb.conf`'un kendi filtresi.
- **5000 klasörden büyük bir paylaşımda hiçbir ACL uygulanamıyor.** `AclApplyService.folderRows`
  sınırı aşınca hata FIRLATıyor — ilk klasörü bile yazmadan, yani kısmi değil TOTAL bir
  başarısızlık. Deterministik olduğu için bütün denemeler aynı şekilde düşüyor ve iş ölüyor. Alt
  ağaca daraltılmış bir iş bile düşüyor, çünkü sayım paylaşımın tamamını sayıyor. Doğru çözüm
  parçalı uygulama (imleçli, kendini yeniden kuyruğa koyan bir iş); bu tur yapılmadı.
- **`MAX_TREE_DEPTH` 256'dan derindeki klasörleri SESSİZCE atlıyor.** 5000 sınırının aksine bir
  hata yok: satırlar dönmüyor, iş yeşil bitiyor, o klasörler eski ACL'iyle kalıyor. Yalnız
  `TeamsService`'in kök uygulamasından erişilebilir — `PermissionsService.write` bir seviye önce
  reddediyor.
- **`claim_job` `max_attempts`'i kontrol etmiyor.** Kirası dolan bir iş sınırsız yeniden
  alınabiliyor: `attempt` tavansız artıyor, iş ne başarıyor ne ölüyor. Bunun tersi de var —
  temiz başarısız olan bir iş, `finish_job`'da sınıra çarpıp ölüyor.
- **Paylaşım kökünün `other::` bitleri yönetilmiyor.** `zfs create` mountpoint'i 0755 root:root
  bırakıyor ve `ApplyFolderAcl` temel üçlüye bilinçli olarak dokunmuyor, yani kimlik doğrulaması
  geçen her SMB principal'ı paylaşım kökünün üst düzey adlarını listeleyebiliyor. Alt klasörler
  etkilenmiyor (ajanın açtığı klasörler 0750 + kendi ACL'i). Ajan tarafında bir değişiklik
  gerektiriyor.
- **Ölen bir `permissions.apply` işini kimse izlemiyor.** Deneme bütçesi 5'ten 20'ye çıktı (yaklaşık
  bir saat, 30 saniye yerine), yani ajan yeniden başlatmasını ve yükseltmeyi atlatıyor. Ama sonunda
  ölen bir iş `job_history`'de duruyor ve onu listeleyen bir uç ya da ekran yok.
- Anlık görüntü listesi havuzun envanteri DEĞİL. Ajanda "listele" işlemi yok, o yüzden `/backups`
  yalnız DEPSIS'in kendi aldıklarını gösterir ve yanıtta `complete: false` ile bunu söyler.
- §21'in belgeleri: yönetici kılavuzu, son kullanıcı kılavuzu, yedekleme ve felaket kurtarma.
  Hiçbiri yok.

## CI şu an hiç koşmuyor — hesap kilitli

Bu depoda GitHub Actions çalışmıyor, ve sebebi kodda değil:

```
The job was not started because your account is locked due to a billing issue.
```

Koşular oluşuyor, işler listeleniyor, sonra her biri **sıfır adımla** beş saniyede düşüyor —
GitHub runner atamıyor. Depoyu public yapmak da çözmedi (public depolarda Actions ücretsiz, ama
kilit hesap düzeyinde). Ödeme yöntemi düzelene kadar buradan ölçüm gelmeyecek.

Bu yüzden **doğrulama bugün tamamen yerel**, ve sırası şu:

```bash
pnpm check                                   # format · lint · typecheck · generate · unit
bash tools/ci/permissions-schema-check.sh    # izin şemasının kısıtları gerçekten ısırıyor mu
DB_NAME=depsis_gate_ci bash tools/ci/migration-check.sh
pnpm --filter @depsis/api exec vitest run    # DEPSIS_TEST_*_URL ayarlıyken
bash tools/dev/e2e-stack.sh && pnpm test:e2e
```

## CI dosyasını değiştirdiysen

```bash
pnpm lint:workflows
```

`actionlint` gerekiyor (`winget install rhysd.actionlint`, ya da dağıtımın paketi).

Bu adım isteğe bağlı görünüyor ve değil. GitHub'ın workflow şeması YAML'dan katı: iş düzeyindeki
bir `env:` içinde `${{ runner.temp }}` sorunsuz ayrıştırılır ve GitHub **bütün dosyayı** reddeder.
Reddedilen bir workflow hiç başlamaz, hiç başlamayan bir workflow rapor da veremez — bu depoda
bir gün boyunca her push sıfır saniyelik `startup_failure` üretti ve kimse görmedi.

Belirtisi şu: `gh run list` çıktısında süre `0s` ve durum `startup_failure`, ve
`gh api .../actions/workflows` çıktısında workflow'un adı yerine kendi yolu görünüyor — GitHub
`name:` alanını okuyacak kadar bile ayrıştıramadığı için.

CI'ın İÇİNDE actionlint adımı **yok**, ve olmaması bilinçli. Bir tane eklenmişti ve dosyayı
kıran şey o oldu: `uses: rhysd/actionlint@main` aracın kaynak deposu ve `action.yml` taşımıyor,
yani GitHub referansı çözemedi ve bütün workflow'u reddetti — geçersiz workflow dosyalarını
önlemek için eklenen adım, workflow dosyasını geçersiz yaptı. Başka bir sarmalayıcıyla geri
koymaya da değmez: dosya geçersizse o iş zaten hiç çalışmaz, ve tam olarak gerektiği anda
atlanan bir denetim denetim değildir.

`pnpm lint:workflows` bu yüzden iki şey koşuyor: actionlint, ve her `uses:` referansının GitHub
API'sinde gerçekten bir `action.yml`'a çözüldüğünü tek tek doğrulayan
`tools/ci/check-action-refs.sh`. İkincisini actionlint yapmıyor.

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
