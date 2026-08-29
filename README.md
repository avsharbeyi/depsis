# DEPSIS

Yerel ağda çalışan bir NAS cihazının yazılımı: web arayüzü, SMB paylaşımı, ZFS depolama, uygulama
kataloğu, uzaktan erişim ve ayrıcalıklı işlemleri yapan küçük bir sistem ajanı. Önyüklenebilir bir
kurulum ISO'su olarak paketleniyor; kurulan kutu monitöre takılınca kendi ekranında arayüzü açıyor.

**Ölçüt terminalsizlik.** Bu bir tüketici cihazı, "Linux bilenler için" bir sunucu dağıtımı değil:
bir özelliğin çalıştığı, ancak arayüzden — kabuğa hiç girmeden — kullanılabildiğinde söylenebilir.
Bağımlılıklar (Samba, ZeroTier, Podman, ZFS, tarayıcı) cihazla birlikte gelir; "şunu apt ile
kurun" bir kurulum adımı değil, ürünün eksiğidir.

Tasarım kararları `docs/adr/` altında, ölçümler `tools/poc/` altında. Bu dosya "nasıl kurarım,
nasıl çalıştırırım, ne çalışıyor" sorularını cevaplıyor.

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

İki adımlı doğrulamanın hem girişi hem kaydı var: `SignIn.tsx` kod ekranını çiziyor (kurtarma
kodu dahil), `Mfa.tsx` — Hesap panelinin altında — kaydı açıyor, kapatıyor ve kurtarma kodlarını
bir kez gösteriyor. (Bu paragraf iki kez bayat çıktı; iki seferinde de koda karşı doğrulanarak
düzeltildi.)

Giriş kullanıcı adı ve parolayla yapılır — e-posta adresi ve ayrı bir "görünen ad" yoktur.

Baytların gerçekten aktığı tam kurulum `deploy/systemd/` altındaki birim dosyalarıdır ve
`tools/poc/p1-d-systemd-deployment.sh` onu uçtan uca ölçer — klasör aç, yükle, dosya sisteminden
oku, indir, adını değiştir, çöpe at.

```bash
sudo PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=... bash tools/poc/p1-d-systemd-deployment.sh
```

## Gerçek kurulum

### Kurulum ISO'su (asıl yol)

```bash
bash deploy/iso/build-iso.sh          # Debian netinst'i indirir, doğrular, DEPSIS'i içine koyar
```

Çıkan ISO USB'ye ham yazılır (Rufus/balenaEtcher "dd kipi"). Debian'ın **imzalı** kurulum zinciri
olduğu gibi kalır; eklenen tek şey veri dosyalarıdır — ön-yanıt (`preseed.cfg`), ilk açılış betiği
ve deponun o anki kaynağı. Yani `deploy/iso/build-iso.sh`'in diff'i, ISO'nun Debian'dan farkının
tamamıdır.

Kurulum iki şey sorar (hangi disk, ilk hesap), gerisini kendi yapar. İlk açılışta
`deploy/iso/firstboot.sh` bağımlılıkları kurar — PostgreSQL 18, Node 24, Rust, ZFS, Samba (+ wsdd2),
`acl`, Podman, ZeroTier, kiosk için cage + Chromium — ve sonra işi aşağıdaki betiğe devreder.

### Elle kurulum (kurulu bir Debian üstüne)

```bash
sudo bash tools/install/install.sh --hostname depsis --shares-root /srv/depsis
```

Ön kontroller (donanım, portlar, PostgreSQL, Node), servis hesapları, sırlar, veritabanı +
migration'lar, derleme ve yerleştirme, kendinden imzalı TLS sertifikası, güvenlik başlıklarıyla
nginx ters vekili, systemd birimleri ve uçtan uca doğrulama — hepsi idempotent: yarıda kesilirse
aynı komut kaldığı yerden sürer. `--check-only` yalnız ön kontrolleri koşar; `--renew-cert`
sertifikayı yeniler. Betik bitince adresi, sertifikanın SHA-256 parmak izini ve — ilk kurulumda,
yalnız bir kez — kurtarma anahtarını yazar. Ayrıntı: `docs/operations/01-yonetici-kilavuzu.md` §2.

## Cihazla gelen dört şey

Bu bölüm bir kararın TERSİNE ÇEVRİLİŞİNİ anlatıyor, ve durduğu yerde durması önemli. İlk tasarım
Samba'yı, ZeroTier'i ve Podman'ı "DEPSIS paketlemez, kurmaz" diye dışarıda bırakıyordu (ADR-0019,
ADR-0020) — kâğıt üstünde temiz bir sınırdı. İlk gerçek kurulumda sahibi uzaktan erişimi açmak
istedi ve karşısına terminal çıktı; paylaşımlar "yayınlandı" göründü ama 445 hiç dinlemiyordu,
çünkü Samba kutuda yoktu. Bir tüketici cihazında bu sınır, ürünün eksiğinin adıydı.

Artık dördü de cihazla geliyor — kurulumu ISO'nun ilk açılışı yapıyor, yapılandırmayı
`tools/install/install.sh`:

- **Samba** — paylaşımların var olma sebebi. `smb.conf`'a tek satır `include` eklenir, ajanın
  yazdığı `depsis.conf` oradan okunur; `map to guest = Never` (Debian'ın varsayılanı bilinmeyen
  kullanıcıyı misafire düşürüyor ve Windows o yüzden parola penceresini hiç açmıyordu). `wsdd2`
  ile cihaz Gezgin'in "Ağ" görünümünde kendiliğinden belirir.
- **Uzak erişim / ZeroTier** (ADR-0020, revize) — cihaz uzaktan erişim YETENEĞİYLE gelir; bir ağa
  katılmak yine arayüzden, yine sahibinin kararıyla olur. Kendi denetleyicisini de kendisi
  koşuyor: ağı kutu kuruyor, cihazları kutu yetkilendiriyor, `my.zerotier.com` gerekmiyor. Her
  cihaza takma ad verilir ki "kimin cihazı" sorusu cevaplanabilsin.
- **Uygulamalar / Podman** (ADR-0019, revize) — KÖKSÜZ: kataloğun kurduğu bir imaj ele geçse bile
  kutuda root değil, yetkisiz bir hesabın ad alanındadır. Katalog küratörlü (migration ile yazılır)
  **ve** yönetici kendi imajını ekleyebilir: yalnız bilinen kayıt defterlerinden (docker.io,
  ghcr.io, lscr.io, quay.io), çünkü serbest bir imaj adı "internetten indirilen keyfi kodu
  çalıştır" demektir ve DEPSIS eklenen imajın içeriğine kefil olmaz — arayüz bunu aynen söyler.
  Kaldırma konteyneri siler, **bağlanan paylaşımlara dokunmaz**. Uygulamanın verisi paylaşımın
  köküne değil içinde kendi klasörüne bağlanır (`prepare_app_data_dir`), ve açılışta kurulu
  uygulamaları `depsis-apps-restore.service` geri getirir — köksüz podman'ın restart politikası
  yeniden başlatmayı taşımıyor.
- **Kiosk tarayıcısı** — cage + Chromium. Monitör takılan kutu açılınca kendi ekranında tam ekran
  DEPSIS arayüzünü gösterir (`depsis-kiosk.service`). Ekran kartı olmayan kutuda birim hiç
  başlamaz; cihaz ekransız NAS olarak çalışmaya devam eder.

**Konsol** (ADR-0018) bunlardan ayrı: DEPSIS'in kendi ikilisi, yalnız yönetici, oturum açıkken bile
parola sorar. Ayrıcalıklı ajanda ÇALIŞMAZ — `services/console` kendi systemd birimi, varsayılan
olarak ayrıcalıksız bir kullanıcıda. `systemctl disable depsis-console` özelliği tamamen kapatır.
Girilen her satır denetime yazılır, çıktı yazılmaz.

Hiçbiri sessizce bozulmaz: eksik bir arka uç 503 döner ya da `available: false` ile 200 — asla 500.

Geliştirme kutusuna bunları kuran betik ayrı duruyor:

```bash
sudo bash tools/dev/provision-vm.sh
```

ZeroTier'in kendi kurulum betiği (`curl | bash`) yalnız ISO'nun ilk açılışında koşuyor;
`provision-vm.sh` onu imzalı apt deposundan kuruyor. Fark bilinçli ve bedeli kabul: ilk açılış
zaten ağdan Node, Rust ve PostgreSQL çekiyor, ve ZeroTier'in apt deposunu elle kurmak aynı güven
zincirinin daha uzun yazılmış hâli.

## İlk açılış: jeton yok

Cihaz sahiplenilmemişken tarayıcıda kurulum sihirbazı açılır ve **ilk kurulan hesap yönetici olur**;
sonra sihirbaz sonsuza dek kapanır (`claim_system_setup`, tek atımlık bir veritabanı kaydı).

İlk tasarım günlüğe basılan tek kullanımlık bir jeton istiyordu — ADR-0009'un argümanı doğruydu:
yerel ağdaki bir NAS'ı ilk gören sahiplenmemeli. Ama o jetonu okumanın tek yolu terminaldi, yani
her kurulum bir SSH oturumuyla başlıyordu. Kalan risk açıkça küçük (kurulumla tarayıcının açılması
arasındaki birkaç dakika, kendi ev ağında) ve sihirbaz onu söylüyor: "bu cihazı siz kurmadıysanız
fişini çekin ve yeniden kurun." Sahiplenme denetim kaydının ilk satırı olarak düşüyor.

## Faz 1: neyin eksik olduğu, ve kapananlar

Bu liste elle tutuluyordu ve dört yerde bayat çıktı, o yüzden koda karşı DOĞRULANDI: spec'in her
maddesi tarandı ve her bulgu ayrıca çürütülmeye çalışıldı. Bugün geçerli hâli
[`docs/bilinen-sinirlamalar.md`](docs/bilinen-sinirlamalar.md)'de — üç ayrı liste olarak: bilerek
yapılmayan (sınırlama), yanlış yerde yapılan (borç), sırası gelmeyen (backlog).

### En pahalı sınıftı: yazıldı, ulaşılamıyordu — kapandı

Eksiklerin en ağırı yazılmamış özellikler değildi. **Yazılmış, test edilmiş ve hiçbir ekranın
çağırmadığı** uçlardı; somut sonucu da şuydu: _ikinci bir kullanıcıya hiçbir şeye erişim
veremiyordun._ Bu kümenin tamamı artık arayüzde:

- **İzin paneli** — `Permissions.tsx`, hem `Files.tsx`'te seçili tek klasör için hem de
  `Shares.tsx`'te satır düğmesiyle. §6.2'nin istediği dry-run önizlemesi her değişiklikte
  çalışıyor ve `applyingJobId: null` geldiğinde "dosya sistemine yazılamadı" diye söylüyor.
- **Ekipler** — `Teams.tsx`: ekip aç, adını değiştir, üye ekle/çıkar, silmeden önce fiyatını gör.
  `posix_gid` boş olan ekip "dosya sistemine yansımadı" etiketiyle görünüyor.
- **MFA kaydı** — `Mfa.tsx`, `Account.tsx`'in altında. Kurtarma kodları bir kez gösteriliyor.
- **İşler** — `Jobs.tsx`, yalnız yöneticiye. Liste `dead` ile açılıyor: ölü bir `permissions.apply`,
  veritabanında uygulanmış ama dosya sistemine hiç yazılmamış bir izin demek.
- **Çoklu paylaşım** — `/files` ve `/search` artık `shareId` alıyor, dosya yöneticisinde paylaşım
  değiştirici var, ve klasör/dosya uçları paylaşımı girdinin kendisinden çözüyor.

### Diğerleri

- **Sözleşmenin söz verip sunucunun yapmadıkları — kapandı.** RFC 9457 `ProblemDetails` artık her
  hatada üretiliyor ve `correlationId` her yanıtta; `Idempotency-Key` üç uçta gerçekten çalışıyor;
  `If-Match`/412 uygulandı ve `GET /files/{id}` `ETag` veriyor; `sort` üç sıralamayı da yapıyor;
  `Upload-Checksum` akarken doğrulanıyor. §14'ün olay akışı da var: tek bir SSE ucu
  (`GET /events`), `job` ve `transfer` olayları, `Last-Event-ID` ile kaldığı yerden devam.
  İşler panosu ve aktarımlar paneli artık iki saniyelik yoklama yerine bunu dinliyor.
- **Yönetici parola sıfırlama var.** Yönetici parolayı BELİRLEMİYOR — tek kullanımlık bir bilet
  açıyor, kullanıcı parolayı kendisi yazıyor, ve bilet tek kullanımlık olduğu için yönetici
  kullanırsa kurban durumu öğreniyor. İkinci faktör atlanmıyor.

- **Kopyalama var** (`POST /file-operations`), ve `contract.test.ts`'in
  "ilan edilmiş ama sunulmuyor" listesi artık boş.

  Tasarımı bir ölçüm belirledi. Bariz olan — API'nin veri kanalından okuyup geri yazması — ajanın
  veri soketinde iki bağlantıyı aynı anda tutar, ve o soket bağlantıları on altı iş parçacığına
  bir randevu kanalıyla dağıtıyor: on altı eşzamanlı kopyalama, hiçbir işçinin kabul edemeyeceği
  bir yazma bağlantısı bekleyerek cihazdaki HER yüklemeyi ve indirmeyi kilitlerdi. İki uç da aynı
  kökün altında olduğu için ajan iki descriptor arasında kendisi kopyalıyor (`copy_file_range`) ve
  baytlar süreç sınırını hiç geçmiyor.

  Ağacı API yürüyor — klasör başına bir `CreateDirectory`, dosya başına bir `CopyFile` — çünkü
  ajanın kapalı işlem kümesinde yarıçapını çağıranın seçtiği bir işlem olamaz (§2.2).

  Yeniden teslimi soğurmak `copied_from_entry_id` sütununu gerektirdi (0022): `keep_both` adı
  hedefte o an ne olduğuna göre türetiyor ve ilk deneme tam da onu değiştiriyor, yani "bunu buraya
  zaten kopyaladım mı" sorusunun ADLA cevabı yok. Aynı bağ, dosya sistemine ulaşıp veritabanına
  ulaşamamış bir kopyayı da kurtarıyor.

  Şu an yalnız `operation: copy` ve `conflictPolicy: keep_both`. Diğerleri 422 ile reddediliyor;
  hangisinin neden reddedildiği ucun kendi açıklamasında yazıyor — `replace` ajana sahip olmadığı
  bir üzerine-yazma vermek demek olurdu, `version` var olmayan bir sürüm deposu istiyor, `skip`
  savunulabilir ve yazılmadı.

- **Çöp kutusunun saklama süresi ve temizleme politikası var** (0023, `/system/trash-policy`).

  Varsayılan "süresiz sakla", ve bu güvenlik argümanının kendisi: bir göç, kimsenin seçmediği bir
  anda kullanıcı verisi silmeye başlamamalı. En az 1 gün — sıfır, çöpe atmanın kalıcı silmeye eşit
  olması demek olurdu ve çöp kutusu bu üründe kullanıcı ile geri alınamaz kayıp arasındaki tek
  tıklama.

  Kontrol, ayarlar panelinde değil ÇÖP KUTUSUNUN İÇİNDE: kalıcı silmeyi silahlandıran bir düğme,
  sileceği verinin göründüğü ekranda durmalı. Bir süre seçmek onu kaydetmeden fiyatlıyor — kaç
  öğe, kaç dosya, kaç bayt — çünkü o sayı, bir yöneticinin fikrini değiştirebilecek tek şey.

  Tasarım incelemesinin bulduğu iki tuzak kapalı. Bayt toplamı köklerin değil altlarındaki
  DOSYALARIN toplamı: `file_entries_folder_has_no_size` bir klasörün boyutunu 0'a sabitliyor, yani
  kökleri toplamak 10 GB'lık bir klasörü "1 öğe, 0 bayt" diye gösterirdi. Ve zamanlama indeksi
  yalnız `queued` üzerinde: `running`'i de kapsasaydı işleyicinin kendi ardılını kuyruğa alması
  çakışır, zincir hiç ilerlemez ve her temizleme sonunda `dead` olurdu.

  Zamanlayıcı kuyruğun kendisi. TypeScript tarafında `setInterval` yok — yalnız o süreç ayaktayken
  çalışan ve yeniden başlatmada kaybolan bir zamanlayıcı, bir saklama politikasının sessizce
  durması demek. `run_after` dayanıklı; her çalışma bir sonrakini kuyruğa alıyor ve API her
  açılışta yeniden tohumluyor.

  Çöp listesindeki her satır ne zaman gideceğini söylüyor. Politika kapalıysa tarih YOK — bir tarih
  gösterip o tarihte hiçbir şey olmaması, çöp kutusunun tutmadığı bir söz olurdu. Çöpe atılmış bir
  klasörün İÇİNDEKİ dosyada da yok: o, kendi tarihinde değil kökünün tarihinde gider.

- **SMB'den yazılan dosyalar artık görünüyor** — ürünün en büyük deliği kapandı.

  `file_entries` yalnız DEPSIS'in kendi yarattığı bir dosyayı öğreniyordu, yani SMB'den yazılan
  her şey — bir NAS'ın var olma sebebi — web arayüzüne, aramaya ve izin yürüyüşüne görünmezdi.
  §5.3 ve §18.2 bunu bir kabul kriteri yapıyor.

  Ajanın kapalı işlem kümesine `ListDirectory` eklendi: bir dizini `RESOLVE_BENEATH` altında
  okuyup her girdiyi `SYMLINK_NOFOLLOW` ile `fstatat`'lıyor. Ad ve üstveri, içerik değil. Tek
  seviye, ağaç değil — yarıçapını çağıranın seçtiği bir çağrı olmasın diye (§2.2). Sembolik bağ,
  soket ve aygıt düğümü bildirilmiyor: DEPSIS'in onlar için satır şekli yok ve öyle bir satır,
  ajanın kendisinin açmayı reddedeceği bir dosyayı arayüzde sunmak olurdu.

  Üstüne `files.reconcile` işi: paylaşımı genişlik-öncelikli yürüyüp veritabanını diske
  uyduruyor. Diskte olup satırı olmayan öğrenilir, satırı olup diskte olmayan unutulur, boyutu
  değişmiş olan tazelenir.

  ADR-0011'in birinci katmanı — Samba'nın `full_audit` akışı — da yazıldı: ajan her paylaşım
  bölümüne P0-B'nin ölçtüğü opname listesini yazıyor, worker rsyslog'un dosyasını `tail -F` gibi
  izliyor, ve DEĞİŞEN DİZİNİ `index_queue`'ya koyuyor. Boşaltma işi o dizini — yalnız onu, altına
  inmeden — yeniden okuyor. Saniyeler, on beş dakika değil.

  Alttaki yürüyüş kalıyor ve kalmalı: diğer her katman ona düşüyor — kaçırılan bir denetim satırı,
  bir kuyruk taşması, Samba'dan hiç geçmeyen bir yazma. Yalnız yürüyüşü olan bir ürün GEÇ, yalnız
  hızlı yolu olan bir ürün SESSİZCE YANLIŞ.

  Bir uyarı, ve ürünün en keskin kenarı: Samba'nın bilmediği bir opname "denetim çalışmaz" demek
  değil — smbd **bağlantıyı reddeder**, ve `testparm` bunu yakalamaz. Liste ajanın testlerinde tam
  eşleşmeyle sabitlenmiş durumda ve yayım `testparm`'dan sonra gerçek bir bağlantı denemesi yapıp
  kanıtlayamadığında geri alıyor. rsyslog tarafı elle kurulur; kurulmazsa ürün çalışmaya devam
  eder, yalnız yavaş indeksler ve worker bunu açılışta söyler
  ([yönetici kılavuzu §3.7](docs/operations/01-yonetici-kilavuzu.md)).

  Hiçbir bayt silinmiyor. Diskte olmayan bir satır VERİTABANINDAN kalkıyor ve hiçbir şey unlink
  edilmiyor — dosya zaten yok, satırın kalkma sebebi o. Bu sınıftan yıkıcı bir ajan çağrısına yol
  yok, ve gözetimsiz bir zamanlamada güvenli olmasının sebebi bu.

  İki tuzak testlerle kapandı: kırpılmış bir listeleme altında HİÇBİR ŞEY silinmiyor (yarım bir
  dizini uzlaştırıp kalan satırları silmek, tek suçu büyük olmak olan bir klasörün indeksini yok
  ederdi), ve çöpteki bir satır adını "hesaba katıyor" ama başka hiçbir işlem görmüyor — çöp bir
  sütun, klasör değil, yani baytları hâlâ yerinde ve satırı görmeyen bir yürüyüş kullanıcının
  zaten sildiği şey için her on beş dakikada bir İKİNCİ satır yazardı.

- **Kutuda hangi disklerin olduğu artık biliniyor** — ve bu, olmadığı sürece havuz sihirbazının
  yazılamayacağı parçaydı. Kimlik zinciri artık her push'ta ölçülüyor: `appliance` işi
  `scsi_debug` ile udev'in gördüğü gerçek SCSI diskleri yaratıyor, `/dev/disk/by-id` bağlantısının
  aygıta çözüldüğünü, WWN'in okunduğunu, ajanın envanterinin ikisini de taşıdığını, ve **yanlış
  WWN ile gelen bir havuz kurma ya da disk silme isteğinin reddedildiğini** kanıtlıyor — risk
  R1'in tek gerçek azaltması buydu ve hiçbir otomatik kapıda koşmuyordu.

  Ajanın kapalı işlem kümesinde `ReadSmartSummary` vardı, "diskleri listele" yoktu. İki sonucu
  oldu. `DEPSIS_SMART_DISKS` bir operatörün `api.env`'e ELLE yazdığı `/dev/disk/by-id` adları
  listesiydi, ve o adları alacak bir yer yoktu — kılavuzun kendi örneği bile `/dev/sda` yazıyordu,
  ajanın yapı gereği reddettiği bir biçim. Ve §8.1 her yıkıcı depolama işleminden önce etkilenen
  diskleri SERİ/WWN ile adlandıran bir analiz istiyor; envanter olmadan o analiz üretilemez.

  `ListDisks` OPERANDSIZ, ve güvenlik argümanının tamamı bu: çağıran bir aygıt, bir yol ya da bir
  bayrak adlandıramıyor, yani içinden bir `-d` geçirilebilecek hiçbir şey yok. Ajan tek bir sabit
  argv koşuyor (`lsblk --json --bytes`) ve söylediğini bildiriyor.

  `serial` NULL OLABİLİR ve bu bir eksiklik değil: ADR-0000 ölçtü, SCSI VPD sayfa 0x80 Hyper-V'de
  bozuk. Kimlik zinciri sayfa 0x83 — yani WWN — sonra partuuid, sonra ZFS etiket GUID'i. Yalnız
  seriye dayanan bir onay kutusu, projenin geliştirildiği hipervizörde boş bir alan gösterirdi.

  Diskler ekranı yalnız yöneticiye açık ve okunacak sütun **üstünde ne var**: boş, tek güvenli
  durum. `/`, `/boot` ya da `/boot/efi` taşıyan bir disk kendi etiketini alıyor, çünkü bu asla bir
  yorum meselesi olmamalı — o diski silmek cihazın kendisini siler.

  `DEPSIS_SMART_DISKS` artık bir DARALTMA, tek kaynak değil: boş bırakılırsa DEPSIS kutuya soruyor
  ve çıkarılabilir olmayan her diski izliyor. Çıkarılabilirler bilerek dışarıda — giden bir USB
  belleği "dizi sağlıklı" diye okunan bir panoda gürültüdür.

- **Havuz oluşturma var** — ve bu, ürünün disk silen tek yolu.

  ADR-0007 bunu yasaklamıyor. Yıkıcı işlemleri GENEL bir depolama arayüzünün dışında tutuyor ve
  her backend için ayrı ayrı, açıkça yazılmasını istiyor; §8.1 de etrafındaki sırayı yazıyor:
  analiz → plan → seri/WWN listesi → yazılı onay → yeniden kimlik doğrulama → iş. `ListDisks`
  analiz; gerisi `POST /storage/pools` ile Diskler ekranının altındaki sihirbaz.

  **Reddedişler ajanın içinde, diyaloğun içinde değil** — çünkü diyalog geçilen bir şeydir, ve
  API'de yapılan bir kontrol API'ye VERİLMİŞ bir listeye karşı yapılır:

  1. `/`, `/boot`, `/boot/efi` ya da `/efi` taşıyan bir disk hiçbir onayla üye olamaz.
  2. Üstünde bir şey olan bir disk, ve bağlı bir disk, üye olamaz. Bu ikisi `lsblk`'in FARKLI
     sütunlarından türüyor, yani birini atlatan bir aygıtın diğerlerini de atlatması gerekiyor.
  3. Çıkarılabilir bir disk üye olamaz.
  4. Her diskin WWN'i, havuz kurulduğu ANDA kutunun bildirdiğiyle karşılaştırılıyor. Ajan
     envanteri kendisi, tam o anda okuyor. Bu, risk R1'in asıl olduğu şeyi kapatan tek kontrol:
     sihirbazın diskleri listelediği ekranla düğmeye basıldığı an arasında bir disk çıkarılıp
     yerine başkası takılabilir, ve `/dev/disk/by-id` bir YUVAYI değil bir AYGITI adlandırır —
     yani aynı ad başka bir disk olabilir. Adı kontrol etmek hiçbir şeyi doğrulamazdı.
  5. `-f` hiç geçilmiyor. `zpool create`, üstünde dosya sistemi olan bir aygıtı zorlanmadıkça
     reddediyor, ve bu ürün o reddi geçersiz kılmıyor. **Üstünde bir şey olan bir diski
     temizlemek, operatörün kabuktan bilerek yaptığı bir iş olarak kalıyor** — ve bunu böyle
     bırakmak, diğer reddedişleri süs olmaktan kurtaran şey.

  Liste (2) ve (3) ile bir inceleme sonrası uzadı, ve uzama sebebi öğreticiydi: (1) tek bir
  `lsblk` sütununa dayanıyordu. Btrfs subvolume düzeninde — Debian/Ubuntu `@`/`@home`, openSUSE,
  Fedora — kökü taşıyan bölümün hiçbir mountinfo girdisinin fs-root'u `/` değil, o yüzden tekil
  `MOUNTPOINT` sütunu `/home` cevaplıyor ve cihazın kendi açılış diski `holds_system: false` diye
  çıkıyordu. "Disk boş olmalı" cümlesini ise sihirbaz, OpenAPI açıklaması ve bu README söylüyordu
  ama YALNIZ tarayıcıdaki JavaScript uyguluyordu.

  ADR-0007 "bu sıra API katmanındadır ve backend'e devredilmez" diyordu; o cümle düzeltildi. Sıranın
  ADIMLARI API'de, ama bu üç DOĞRULAMA ajanda olmak zorunda: API'de yapılan bir kontrol, API'ye
  VERİLMİŞ bir listeye karşı yapılır — istemcinin kendi ekranını doğru kopyaladığını kanıtlar,
  diskin ne olduğunu değil.

  Çok diskli stripe **bilerek ifade edilemez**. Herhangi bir diski kaybetmenin her şeyi
  kaybettirdiği düzen, dosya saklamak için var olan bir cihazda bir listeden yanlış maddeyi
  seçerek ulaşılabilecek bir şey olmamalı. `single` var ve ne olduğunu söylüyor.

  İş kuyruğa `maxAttempts: 1` ile giriyor, ama bu **bir kez koşacağı anlamına gelmiyor** ve öyle
  sanmak bir hataydı: `claim_job`, kirası dolmuş RUNNING bir işi `max_attempts`'e hiç bakmadan
  geri alıyor — sayaç yalnız `finish_job`'da, `failed` ile `dead` arasında seçim yapmak için
  okunuyor. Yani `maxAttempts: 1` yalnız BİLDİRİLMİŞ bir hatadan sonraki yeniden denemeyi
  engelliyor; `zpool create`'in ortasında öldürülen bir worker'ın işi altmış saniye sonra geri
  alınıyor, ki kuyruğun çökmüş worker'ı fark etme yolu tam olarak bu.

  İkinci bir `zpool create`'i durduran şey bu yüzden işleyicinin varlık kontrolü, ve o kontrolün
  iki durumu ayırması gerekiyor: BİRİNCİ denemede var olan bir havuz bu işten önce vardı — başarı
  demek, operatöre dokunulmamış disklerinin kullanıldığını söylemek olurdu — İKİNCİ denemede var
  olan bir havuzu ise bir önceki deneme kurmuş ve cevabı kaybolmuştur.

  Ajan çağrısı zaman aşımına uğrarsa işleyici havuzun var olup olmadığına BAKIYOR: "cevap
  kayboldu" ile "iş olmadı" aynı şey değil, ve diskleri çoktan gitmiş bir operatöre "olmadı"
  demek en kötü cevap.

  Havuz ADR-0004'ün özellikleriyle ve HAVUZ düzeyinde kuruluyor (`acltype=posixacl`, `xattr=sa`):
  `CreateDataset` bunları veri kümesi başına ayarlıyor, ve varsayılanı `off` olan bir havuz,
  söylemeyi unutan her veri kümesini ACL'siz bırakırdı — ADR-0004'ün yeniden yazılmasına sebep
  olan hata. `ashift=12` sabit, çünkü DÜZELTİLEMEZ.

- **Sihirbazdan sonra kabuk gerekmiyor** — ve gerekmesi, sihirbazın kendi amacını yarıda
  bırakmasıydı.

  Havuz kuruluyordu ve cihaz hâlâ paylaşım açamıyordu: `DEPSIS_ZFS_POOLS` yeni havuzu bilmediği
  için telemetride görünmüyor, `DEPSIS_SHARE_PARENT_DATASET` bir şey adlandırmadığı için
  `POST /shares` 503 veriyordu. İkisi de bir dosya düzenleyip API'yi yeniden başlatmak demekti —
  yani sihirbazın ortadan kaldırmak için var olduğu şeyin tam ortasında bir kabuk.

  Üç işlem daha, ve ikisi operandsız: `ListPools` (`zpool list -H -o name`), `ShareRootStatus`
  (`zfs list -H -o name,mountpoint`, ve cevap Rust'ta süzülüyor — komut satırında çağırandan gelen
  hiçbir şey yok), ve `PrepareShareRoot`.

  `PrepareShareRoot`'ta **bağlanma noktası operand DEĞİL**: ajanın kendi `DEPSIS_SHARES_ROOT`'u, ve
  veri kümesi adı `<havuz>/depsis` diye türetiliyor. `CreateDataset` mountpoint operandını tam da
  bu yüzden reddediyor — onu seçebilen bir çağıran bir kiracının verisini kutunun herhangi bir
  yerine bağlayabilirdi — ve burada çağıranın seçtiği tek şey HAVUZ.

  İki reddediş: oraya zaten bir veri kümesi bağlıysa, ve **dizin boş değilse**. İkincisi asıl
  olanı: `zfs create -o mountpoint=X` X'in üstüne şikâyet etmeden bağlanıyor, altındaki her şey
  görünmez oluyor — silinmeden, diski işgal etmeye devam ederek. Hiçbir şey silinmediği için
  teşhisi uzun süren bir veri kaybı raporu.

  `DEPSIS_ZFS_POOLS` ve `DEPSIS_SHARE_PARENT_DATASET` artık DARALTMA. Yazılırsa kazanıyorlar —
  yedek havuzunu panoda istemeyen bir kurulumun meşru sebebi var — yazılmazsa kutuya soruluyor.
  Aynı değişikliği `DEPSIS_SMART_DISKS` de geçirmişti; üç değişkenin üçü de "ajanın kapalı işlem
  kümesinde bunu soracak bir şey yok" diye yapılandırmaydı, ve üçünün de sebebi artık yok.

  `POST /shares`'in üst veri kümesi de bu yüzden artık ÇAĞRI BAŞINA soruluyor: `SharesService`
  onu yapımda sabitlenmiş bir dizge olarak alıyordu, yani değiştirmenin tek yolu API'yi yeniden
  başlatmaktı.

- Paylaşımı SİLMEK. Grant'ları paylaşımı tutuyor (`ON DELETE RESTRICT`) ve son grant'ı silmek de
  reddediliyor. Bilinçli: paylaşımı silmek dataset'i silmek demek, ve ADR-0007 yıkıcı havuz
  işlemlerini üründen dışarıda tutuyor. Kapatmanın yolu, kimseyi adlandırmayan bir kök izni.
- **SMB kimlik zinciri uçtan uca çalışıyor ve ölçüldü.**

  `tools/poc/p2-c-identity-end-to-end.sh` (14/14) derlenmiş ajana gerçek bir soket üzerinden
  gerçek bir `sync_posix_identity` gönderiyor ve sonra makineye ve smbd'ye soruyor:

  - tek istek iki hesap, üç grup (iki özel + bir ekip) ve iki parola yaratıyor;
  - hesaplar DEPSIS'in verdiği uid'lerde, nologin, ev dizinsiz;
  - **ali, Samba'nın düz metin olarak hiç görmediği parolasıyla paylaşıma giriyor**;
  - veli doğrulanıyor ama ACL onu paylaşıma sokmuyor;
  - ikinci senkron hiçbir şey yaratmıyor (idempotent);
  - ali ekipten çıkarılınca paylaşım ona gerçekten kapanıyor;
  - `nt_hash` göndermeyen bir senkron mevcut parolayı bozmuyor.

  `valid users` de artık üretiliyor. Bölüm başına yazılan ad kümesi, o paylaşımın ağacındaki
  HERHANGİ bir grant'ta adı geçen her principal'in birleşimi — `AclApplyService`'in ACL girdisine
  çevirdiği kümenin aynısı, aynı tablodan okunuyor, ki ikisi kimin var olduğu konusunda ayrışmasın.
  Parametre yalnız DARALTABİLİR, o yüzden bu kümenin ACL'in izin verdiğinin üst kümesi olması
  güvenli yön. Kapalı hesap listede yok; gid'i olmayan ekip de yok. Ad `PosixName` tipiyle
  taşınıyor, yani satır sonu içeren bir "kullanıcı adı" dosyaya yeni bir direktif yazamıyor.

- Anlık görüntü listesi artık havuzla KARŞILAŞTIRILIYOR. Ajanın `ListSnapshots` işlemi eklendikten
  sonra `/backups`'ın her satırı bir durum taşıyor: havuzda, havuzda yok (kayıt duruyor ama görüntü
  gitmiş — var olmayan bir geri dönüş noktası), kabuktan alınmış, ya da doğrulanamadı. `complete:
false` artık "listeleyemiyoruz" değil, "havuza sorulamadı" demek.
- **§21'in dört operatör belgesi yazıldı** — [`docs/operations/`](docs/operations/): yönetici
  kılavuzu, son kullanıcı kılavuzu, yedekleme, felaket kurtarma. Her komut ve her sayı depodaki
  karşılığına bakılarak yazıldı, ve her belge ürünün o alanda YAPMADIKLARIYLA bitiyor — yedekleme
  belgesinin PITR'ın olmadığını söylemesi, o belgenin en kullanışlı cümlesi olabilir.

  Yedekleme belgesinin en pahalı uyarısı: `depsis_backup` rolüyle alınan bir döküm **geri
  yüklenemez**. O rol bilerek eksik — TOTP sırlarını, kurtarma kodlarını ve NT hash'leri okuyamaz
  — yani onunla alınan bir yedekten dönen sistemde kimsenin ikinci faktörü ve kimsenin SMB
  erişimi olmaz. Geri yüklenebilir döküm `depsis_owner` ile alınır.

- **ER diyagramı yazıldı** — [`docs/er-diagram.md`](docs/er-diagram.md), yirmi beş göçten
  çıkarıldı. Mermaid ile üç diyagram, ve diyagramın TAŞIYAMADIĞI iki şey yazıyla: kiracı
  yalıtımını çizilen oklar değil RLS yapıyor, ve klasör erişimini `folder_grants` ile POSIX
  ACL'ler BİRLİKTE belirliyor — birini güncelleyip diğerini güncellememek, "izni kaldırdım" ile
  "erişim gerçekten kapandı" arasındaki fark.

- **Mimari diyagramlar yazıldı** — [`docs/architecture.md`](docs/architecture.md): süreçler ve
  güven sınırı, iki soketin neden iki olduğu, bir dosyanın iki gerçekliği, erişimin iki
  uygulayıcısı, ve yıkıcı işlemin yolu. ADR'lerin yerini almıyor — burası ne olduğu,
  `docs/adr/` neden öyle olduğu, ve çelişirlerse ADR'ler haklı.

- **Bilinen sınırlamalar, teknik borç ve backlog yazıldı** —
  [`docs/bilinen-sinirlamalar.md`](docs/bilinen-sinirlamalar.md). Üç AYRI liste, ve ayrı
  olmaları önemli: sınırlama bilerek yapılmadı, borç yanlış yerde yapıldı, backlog'un sırası
  gelmedi. Hepsini bir listeye koymak, kimsenin bakmadığı bir liste üretir.

- **Tehdit modeli Faz 1'e getirildi** — [`docs/threat-model/`](docs/threat-model/README.md)
  §11. Faz 0'dan sonra eklenen altı yüzeyin hiçbirinin modelde karşılığı yoktu; havuz
  oluşturma ayrı bir bölüm, ve Faz 1'de bulunan altı sessiz açık — üçünde belge doğruydu ve
  kod onu yapmıyordu — kendi tablosunda.

- **Test raporları artefakt oluyor.** Yeşil koşumda da: "testler geçti" bir cümle, teslimat o
  cümlenin dayandığı sayıların dışarıdan okunabilmesi.

- §21'in kalan teslimatları: Storybook ve imzalı build prosedürü.

## Sahada eklenenler

Cihaz gerçek donanıma kurulduktan sonra sahibinin kullanımından çıkan işler. Hepsinin ortak yanı,
listenin başındaki ilkeyi uygulaması: bir şey ancak arayüzden yapılabildiğinde var sayılıyor.

- **Denetim kaydı** (`audit_events`, 0036) — "bu kutuda dün ne oldu" sorusunun tek cevabı. Ekle-only
  ve bu uygulama katmanında değil GRANT'ta: `depsis_app` rolünün UPDATE ve DELETE yetkisi yok, yani
  silme kodu yazılsa da çalışmaz. Giriş, oturum kapatma, parola değişikliği, izin, paylaşım, havuz,
  disk silme, uygulama, uzak erişim — hepsi yazıyor.
- **Diski arayüzden sıfırlama** — §8.1'in töreni (ne silineceğin listesi, yazılı onay, parola) ile.
  Sistem diski ve bağlı disk hiçbir onayla geçmiyor; WWN silme ANINDA yeniden doğrulanıyor.
- **Görev yöneticisi ve sistem ekranı** — arka plan süreçleri, sistem olmayanı kapatma (SIGTERM,
  SIGKILL yok), ve işlemci/bellek/sıcaklık/havuz grafikleri. "Sistem süreci" kararı tek yerde,
  ajanda: arayüzün düğme çizmediğine ajan zaten "hayır" diyor.
- **İşler panosu büyüdü** — her işin altında yönergesi (açıklama), biten işler için arşiv ve
  arşivden `.xlsx` dışa aktarma (bağımlılıksız yazıcı; CSV'nin Excel yerel-ayar kumarı yok), ve
  bütün panonun izi olan iş günlüğü: kim, neyi, ne zaman, neyden neye.
- **Dosyalar ↔ işler köprüsü** — dosya seçip "İşe bağla"; bağ işin tartışmasında listeleniyor.
  Görülemeyen bağlar sayı olarak söyleniyor, içerikleri değil.
- **Kod okutma kestirmesi** — arama kutusundaki düğme kamerayı açar, okunan QR/barkod aranır,
  bulunan klasöre girilir ve fotoğraf yükleme açılır. Çözme cihazda: tarayıcının yerli çözücüsü,
  yoksa pakete gömülü ZXing (`apps/web/src/scan.ts`). Sayfa içi canlı kamera DENENDİ ve düştü —
  Chrome, kendinden imzalı sertifikalı sayfaya kamerayı sormadan reddediyor, iOS Safari de çözücü
  API'yi hiç vermiyor; telefonun kendi kamerasıyla fotoğraf ikisinde de çalışıyor.
- **Yedek ile aynanın farkı ekranda** — "ilk diski ikinciye kopyalama" zaten ayna havuzun kendisi
  ve sürekli; aynanın korumadığı şey geçmiş. Yedekleme ekranı bunu söylüyor, çünkü söylemeyen bir
  ürün, kullanıcısına var olan bir özelliği yok sandırıyor.

### Sahada bulunan, kod tarafında kalıcı olarak kapatılan hatalar

Sırf sahada göründükleri için değil, bir daha aynı biçimde doğmasınlar diye burada:

- **Paylaşım çözümü EXDEV veriyordu** — her paylaşım kendi ZFS veri kümesi, yani kendi bağlama
  noktası; `RESOLVE_NO_XDEV` kök→paylaşım sıçramasını reddediyordu. Çözüm iki aşamalı: o tek adım
  gevşetilmiş bayraklarla, paylaşımın İÇİ tam kümeyle.
- **`setfacl` hiçbir izni yazmıyordu** — ajan hedefi `/proc/self/fd/N` diye veriyordu, ama tanıtıcı
  CLOEXEC; çocuk süreçte o numara yok. `/proc/<ajan pid>/fd/N` oldu, ve testi artık gerçek bir
  exec'in ardından ölçüyor.
- **Yüklemenin ilk parçası "no such file" ile ölüyordu** — taze bir paylaşımda `.depsis/staging`
  iskeletini kimse kurmuyordu; klasörler yükleniyor, dosyalar yüklenmiyordu.
- **Açılışta ajan soketi rastgele düşüyordu** — Samba kurulunca doğan birim döngüsü
  (soketler → ajan soketi → `zfs.target` → `zfs-share` → `smbd` → `basic.target` → soketler).
  systemd döngüyü kırmak için rastgele bir işi siliyor: bir açılışta başkasını, ertesinde ajanı.
  Soket artık geç hedefleri beklemiyor.
- **Parola özeti eski işlemcide çöküyordu** — `@node-rs/argon2`'nin hazır ikilisi x86-64-v2
  istiyor; 2009 model bir işlemcide API açılırken SIGILL. Bir cihaz sahibinin en eski
  bilgisayarında da çalışmak zorunda: kurulduğu makinede derlenen C `argon2`.
- **Konteynerlerin ağ ad alanı açılamıyordu** — AppArmor'ın `pasta` profili yalnız
  `/run/user/<uid>`'i tanıyor, bizim motor `/run/depsis-apps` altında koşuyor. Yerel kural
  `install.sh` ile yerine konuyor.

## CI koşuyor, ve ilk tamamlanan koşumunda beş kusur buldu

Hesap kilidi kalkana kadar bu depoda GitHub Actions hiç çalışmadı — koşular oluşuyor, işler
listeleniyor, her biri **sıfır adımla** beş saniyede düşüyordu. Kilit kalktı, 41 commit tek seferde
itildi, ve iş akışı hayatında ilk kez tamamlandı.

Altı işin altısı yeşil oldu. Oraya varmak beş düzeltme aldı, ve **beşi de aynı aileden**: bu
makinede doğru olduğu için hiç sınanmamış varsayımlar.

Sonra saha turları başladı ve `main` günlerce kırmızı kaldı — üç işte, ve üçü de yine aynı
aileden. Yerel kapılar yeşildi çünkü **CI'ın koştuğunu koşmuyorlardı**: clippy `--all-targets`
almıyordu (test modülleri denetlenmiyordu), tümleşik süitler bir veritabanı istediği için
`pnpm check`'e girmiyor ve elle koşulmuyordu, e2e yığını da öyle. Üçü de düzeltildi ve kapı
listesi CI'a eşitlendi; ders listenin kendisinde yazıyor.

| Ne                                                                     | Neden yerelde görünemezdi                                                                                        |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `identity.rs` `std::os::unix`'i doğrudan çağırıyordu (ADR-0006 ihlali) | Linux'ta `cargo test` diğer platformu hiç denemiyor. Kapı `cargo check --target x86_64-pc-windows-msvc`.         |
| Tenant işi paketleri derlemeden test koşuyordu                         | `dist/` bir geliştirici makinesinde zaten duruyor. turbo.json bu tuzağı `lint` üstünde geçmiş zamanla anlatıyor. |
| e2e ajanı ayrıcalıksız koşuyordu, DEPSIS uid'sine chown edemiyordu     | WSL'de script zaten root; varsayım yalnız doğru olduğu yerde deneniyordu.                                        |
| Raporu okuyan kapı raporun yolunu bilmiyordu                           | O adıma hiç ulaşılmamıştı; iş her zaman daha önce düşüyordu.                                                     |
| Keşif her telemetri poll'ünde aynı uyarıyı yazıyordu                   | ZFS'i olan bir kutuda hiç tetiklenmiyor.                                                                         |

## Tasarım sistemi

`docs/tasarim-sistemi.html` — tarayıcıda doğrudan açılır. Renk jetonları ve bileşen sözlüğü
(rozetler, düğmeler, satırlar, uyarı kutusu, tablo, boş durum) tek sayfada.

Sayfa `apps/web/src/styles.css`i **kopyalamıyor, içe aktarıyor**: bir kopya ilk gün doğru, ikinci
ay yanlıştır ve yanlış olduğunu kimseye söylemez. Kopyalanamayan tek şey sınıf adları — bir sınıf
stil dosyasından silindiğinde sayfa hiçbir şey söylemeden çizmeye devam ederdi. `pnpm lint:design`
tam onu ölçüyor ve `pnpm check`in içinde koşuyor.

Storybook bilerek kurulmadı; gerekçesi `docs/bilinen-sinirlamalar.md` §21 madde 12’de.

## Lisans

Sistem ekranında **Lisans** bölümü: kime, hangi plan, ne zamana kadar, ve bu cihazın kodu. Okumak oturum
açmış herkese açık (bir cihazın ne zaman desteksiz kalacağı sır değil), kurmak kurucu yöneticiye.

Lisans anahtarı **imzalı bir veridir** ve cihaz onu **internete çıkmadan** doğrular; elindeki tek
şey açık anahtardır (`/etc/depsis/license-key.pub`). Klasik `XXXX-XXXX-XXXX` anahtarlar bunu
yapamaz: o kadar kısa bir dizgeye imza sığmadığı için ya sunucuya sormak gerekir — bir NAS’ın
interneti olmayabilir, ve müşterinin cihazının satıcıya rapor vermesi bu ürünün duruşuna aykırı —
ya da kırılabilir bir algoritma kullanılır.

**Süresi dolmuş bir lisans kimseyi kendi dosyalarından kilitlemez.** Ekranda söylenir, o kadar.
Bir yedekleme cihazını bir takvim gününde kullanılamaz hâle getirmek, verinin kendisini rehin
almaktır. Zorlama istenirse bu ayrı ve bilinçli bir karardır; varsayılan olarak alınmadı.

Satıcı tarafı `tools/license/keygen.mjs`:

```bash
node tools/license/keygen.mjs issue --key ~/depsis-anahtarlar/depsis-license.key --to “Ad Soyad” --plan ev --device XXXX-XXXX-XXXX --until 2027-12-31
```

Anahtar çiftini bir kez `keygen.mjs init <dizin>` üretir. **Özel anahtar depoya girmez**; depoda
duran `deploy/release/license-key.pub` yalnızca açık anahtardır ve cihazlara o gider.

## Sertifika ve alan adı

Sistem ekranında **Sertifika** bölümü: kutunun sunduğu sertifikanın kimliği, geçerli adresleri,
bitiş tarihi ve **parmak izi**. Sonuncusu önemli — kendinden imzalı bir sertifikada tarayıcının
uyarı ekranında karşılaştırılacak tek şey odur, ve onu görmenin tek yolu bugüne kadar kurulum
çıktısına bakmaktı: bir daha açılmayan bir pencere.

Kendi alan adınız varsa, sağlayıcınızdan aldığınız sertifikayı (zincir olabilir) ve özel anahtarı
aynı ekrandan yapıştırıp kurabilirsiniz. Ajan üç şeye bakar: sertifika ayrıştırılabiliyor mu,
anahtar O sertifikaya mı ait, ve süresi dolmuş mu. Zincir doğrulaması bilerek YOK — hangi CA’nın
güvenilir olduğu tarayıcının kararı, ve kendi CA’sını kuran bir ev ağı da meşru.

nginx önce sınanır, sonra yeniden yüklenir, ve **herhangi bir adım düşerse eski sertifika geri
konur**: bir sertifika kurulumunun asla üretmemesi gereken sonuç, HTTPS sunamayan bir kutudur.
Bu geri alma yolu her push’ta `appliance` işinde gerçekten yürütülüyor — o koşucuda nginx kurulu
değil, yani kurulum orada her seferinde düşüyor ve her seferinde geri alınıyor.

Sertifikayı DEPSIS **almaz**: Let’s Encrypt’in HTTP-01 doğrulaması kutuya internetten 80
portuyla ulaşılmasını, DNS-01 ise alan adı sağlayıcınızın API anahtarını ister — ikisi de bir ev
cihazında güvenilemeyecek varsayımlar.

## Cihazı güncellemek

Sistem ekranında **Yazılım sürümü** bölümü: kurulu sürüm, `Sürüm denetle`, ve bulunan sürüm için
`Güncelle`. Terminal yok. Yalnız kurucu yönetici, parolayla yeniden kimlik doğrulama, ve ikisi de
denetim kaydına yazılıyor.

Cihaz KENDİLİĞİNDEN sürüm denetimi yapmaz — ne zamanlayıcısı vardır ne açılışta çalışır. Bir
NAS’ın sahibinin haberi olmadan dışarıya bağlanmaması, denetimin bir düğmeye bağlı olmasının
sebebidir.

Kurulacak sürümü istek seçmez: kurulan şey bir önceki denetimin bulduğu sürümdür, yani ekranda
gördüğünü onaylayan yönetici tam onu kurar. Kurulum düşerse cihaz eski sürüme geri alınır.
İndirmeyi ajan yapmaz — birimi `IPAddressDeny=any` taşır; indiren ve kuran taraf ayrı bir systemd
birimidir (`depsis-update.service`).

Kalan sınır ve gerekçesi: `docs/bilinen-sinirlamalar.md` §2.7 — bugün güven HTTPS ve kaynağın
adresinin betikte sabit olmasına dayanıyor; imzalı sürümler §21’in 13. teslimatı.

Yerel kapılar hâlâ geçerli ve hâlâ ilk savunma hattı — CI'a itmeden önce:

```bash
pnpm check                                   # format · lint · iş akışı · typecheck · generate · unit
bash tools/dev/rust-gate.sh                  # fmt · clippy --all-targets · test · Windows · şema
sudo bash tools/ci/appliance-check.sh        # gerçek ZFS + Samba + ajan (atılabilir bir Linux'ta)
bash tools/ci/permissions-schema-check.sh    # izin şemasının kısıtları gerçekten ısırıyor mu
DB_NAME=depsis_gate_ci bash tools/dev/wsl-migration-check.sh
bash tools/dev/wsl-itest.sh                  # dört veritabanı URL'siyle tümleşik süitler
bash tools/dev/wsl-e2e-stack.sh && pnpm test:e2e --workers=3
bash tools/wsl-cargo-windows-check.sh        # ADR-0006'nın çekirdek iddiası
```

`rust-gate.sh`, `wsl-rust-gate.sh`'i araç zincirinin **gerçekten kurulu olduğu** WSL dağıtımında
koşturur. Depodaki `wsl-*.sh` betikleri `wsl.exe`'yi dağıtım seçmeden çağırıyor, yani varsayılan
dağıtımda koşuyorlar — ve bu makinede `cargo` bir başkasında kurulu. Ortaya çıkan hata
("cd: No such file or directory", "cargo: command not found") bir derleyici hatasına değil bir
ortam kazasına benziyor, ve kapı atlanıyor. Bir kapının koşmaması, kırmızı vermesinden daha
tehlikelidir: kırmızı bakılacak yeri söyler.

`pnpm check` artık iş akışı dosyalarını da denetliyor (`tools/ci/workflow-lint.mjs`), ve bu da
ödenmiş bir bedelin karşılığı: bir adıma ikinci bir `env:` anahtarı girdiğinde GitHub dosyayı
**reddetti**, koşum sıfır saniyede `startup_failure` verdi, hiçbir iş çalışmadı. Böyle bir hatayı
CI yakalayamaz — CI zaten başlamıyor. Yakalanacak tek yer yerel kapı, ve tek gereken hoşgörülü bir
ayrıştırıcı yerine katı olanı kullanmak.

`wsl-rust-gate.sh` listeye sonradan eklendi ve sebebi kayda değer: yerel alışkanlık clippy'yi
`--all-targets` OLMADAN koşuyordu, yani test kodu hiç denetlenmiyordu. `procs.rs`'in test modülü
diğerlerinin taşıdığı `#[allow(clippy::unwrap_used, …)]` bloğunu taşımıyordu; yerelde görünmedi,
CI'da on dört hatayla düştü. Bir kapı, CI'ın koştuğunun aynısını koşmuyorsa kapı değildir.

Koşumu izlemek için `bash tools/dev/ci-watch.sh` — kimliksiz API saatte altmış istek, ve otuz
saniyelik bir yoklama onu bir koşumda bitiriyor.

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
deploy/iso      kurulum ISO'su: üretici betik, ön-yanıt, ilk açılış
deploy/nginx    TLS ters vekil şablonları
tools/install   cihaza kurulum betiği (install.sh)
docs/adr        mimari kararlar
docs/operations §21'in operatör belgeleri: kurulum, kullanım, yedekleme, kurtarma
docs/threat-model  güven sınırları
tools/poc       ölçüm betikleri
```
