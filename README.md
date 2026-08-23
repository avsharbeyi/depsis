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

İki adımlı doğrulamanın **girişi var, KAYDI yok**. `SignIn.tsx` `mfa_required` cevabını işliyor,
kod ekranını çiziyor ve kurtarma kodunu da kabul ediyor — yani ikinci faktörü olan biri giriş
yapabiliyor. Ama `POST /me/mfa/enrolment` ve kardeşlerini çağıran hiçbir ekran yok, yani kimse onu
AÇAMIYOR. Bu satır uzun süre "arayüzde iki adımlı doğrulama yok" diyordu; doğrulama koda karşı
yapılınca yanlış olduğu görüldü.

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

Bu liste elle tutuluyordu ve dört yerde bayat çıktı, o yüzden koda karşı DOĞRULANDI: spec'in her
maddesi tarandı ve her bulgu ayrıca çürütülmeye çalışıldı. Sonuç 85 madde; tamamı
[Eksikler Panosu](https://claude.ai/code/artifact/7949358c-b855-4128-9e99-082e15249ea2)'nda.

### En pahalı sınıf: yazıldı, ulaşılamıyor

Eksiklerin en ağırı yazılmamış özellikler değil. **Yazılmış, test edilmiş ve hiçbir ekranın
çağırmadığı** uçlar — dokuz kalem:

- **İzin paneli yok.** `GET/PUT /files/{id}/permissions` ve `GET/PUT /shares/{id}/permissions`
  sunuluyor, 968 satırlık bir servis ve iki entegrasyon paketi arkasında duruyor, ve
  `apps/web/src` içinde tek bir çağrısı yok. `Shares.tsx` kullanıcıyı hiç var olmayan bir
  "izinler paneline" yönlendiriyor.
- **Ekiplerin hiç arayüzü yok.** Dört yol üzerinde sekiz işlem sunuluyor; web'de sıfır çağrı.
- **MFA kaydının arayüzü yok** (yukarıya bakınız).
- **İşler ekranı yok.** `GET /jobs` yönetici için var; onu okuyan hiçbir yer yok.

**Bunun somut sonucu: ikinci bir kullanıcıya hiçbir şeye erişim veremiyorsun.** Üstelik
`everyone_team()` yalnız o an var olan kullanıcıları ekibe aldığı için, ilk `GET /files`'tan
SONRA açılan bir üye boş bir dosya yöneticisi görüyor — ve bunu düzeltecek iki yolun (ekip
üyeliği, kök izni) ikisinin de ekranı yok.

### Diğerleri

- **Web dosya yöneticisi yalnız TEK paylaşımı görebiliyor.** `FilesService.shareOf` her zaman
  `ORDER BY created_at LIMIT 1` ile ilk paylaşımı seçiyor ve `/files`'ın bir `share` parametresi
  yok — yani `POST /shares` ile açılan bir paylaşım Samba'ya yayımlanıyor ama web'de görünmüyor.
- **Sözleşmenin söz verip sunucunun yapmadıkları.** RFC 9457 `ProblemDetails` gövdesi hiç
  üretilmiyor; `Idempotency-Key` dört uçta tanımlı ve hiçbir yerde okunmuyor; `If-Match`/412
  tanımlı ve uygulanmamış; `GET /files`'ın `sort` parametresi yok sayılıyor; `Upload-Checksum`
  doğrulanmıyor. §14'ün istediği SSE/WebSocket olay akışı da yok.
- **Yönetici parola sıfırlama yok.** Parolasını unutan bir kullanıcı üründen kurtarılamıyor.
- **Kopyalama yok** (`POST /file-operations`, ajanda karşılık gelen tipli işlem olmadığı için).
- **Çöp kutusunun saklama süresi ve temizleme politikası yok.**
- Dosya sistemi olaylarından metadata'yı besleyen endeksleyici. Bu olmadan yalnız DEPSIS
  üzerinden yüklenen dosyalar listede görünür; SMB'den yazılanlar görünmez.
- ZFS havuzu yaratma. Ajan dataset ve anlık görüntü yaratabiliyor, havuz yaratamıyor — mirror
  sihirbazı bu yüzden yok. `POST /shares` bir dataset açar ama havuzu operatör kurar.
- Paylaşımı SİLMEK. Grant'ları paylaşımı tutuyor (`ON DELETE RESTRICT`) ve son grant'ı silmek de
  reddediliyor. Bilinçli: paylaşımı silmek dataset'i silmek demek, ve ADR-0007 yıkıcı havuz
  işlemlerini üründen dışarıda tutuyor. Kapatmanın yolu, kimseyi adlandırmayan bir kök izni.
- **SMB kimlik zinciri artık uçtan uca çalışıyor ve ölçüldü** — eksik kalan tek şey `valid users`.

  `tools/poc/p2-c-identity-end-to-end.sh` (14/14) derlenmiş ajana gerçek bir soket üzerinden
  gerçek bir `sync_posix_identity` gönderiyor ve sonra makineye ve smbd'ye soruyor:

  - tek istek iki hesap, üç grup (iki özel + bir ekip) ve iki parola yaratıyor;
  - hesaplar DEPSIS'in verdiği uid'lerde, nologin, ev dizinsiz;
  - **ali, Samba'nın düz metin olarak hiç görmediği parolasıyla paylaşıma giriyor**;
  - veli doğrulanıyor ama ACL onu paylaşıma sokmuyor;
  - ikinci senkron hiçbir şey yaratmıyor (idempotent);
  - ali ekipten çıkarılınca paylaşım ona gerçekten kapanıyor;
  - `nt_hash` göndermeyen bir senkron mevcut parolayı bozmuyor.

  Kalan: `smb.conf` bölümlerinde `valid users` yok. Yani bir paylaşımı SMB'den açabilmek şu an
  yalnız POSIX ACL'e bakıyor — ki p2-a bunun gerçekten kapıladığını ölçtü — ama operatörün
  globals'ının doğruladığı her principal en azından bölümü GÖREBİLİYOR. `valid users`'ın güvenle
  üretilebileceği de ölçüldü (p2-a: daraltıyor, genişletemiyor, karşılığı olmayan bir ad dosyayı
  düşürmüyor); yazılması kaldı.

- **Ölen işleri gösteren bir EKRAN yok.** `GET /jobs?status=dead` var ve yönetici görebiliyor, ama
  arayüzde onu okuyan bir yer yok — yani bakmayı bilen birinin API'yi çağırması gerekiyor.
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
