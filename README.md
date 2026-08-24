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
  yazılamayacağı parçaydı.

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

- Anlık görüntü listesi havuzun envanteri DEĞİL. Ajanda "listele" işlemi yok, o yüzden `/backups`
  yalnız DEPSIS'in kendi aldıklarını gösterir ve yanıtta `complete: false` ile bunu söyler.
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

- §21'in kalan teslimatları: mimari diyagramlar, Storybook, imzalı build prosedürü,
  ve test raporlarının artefakt hâli (testler koşuyor; CI hesabı kilitli olduğu için yayımlanmış
  rapor yok).

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
docs/operations §21'in operatör belgeleri: kurulum, kullanım, yedekleme, kurtarma
docs/threat-model  güven sınırları
tools/poc       ölçüm betikleri
```
