# Bilinen sınırlamalar, teknik borç ve sonraki faz backlog'u

§21'in 11. teslimatı. Üç ayrı liste, ve ayrı olmaları önemli:

- **Sınırlama** — bilerek yapılmadı. Bir karar, ve gerekçesi var.
- **Borç** — yapıldı ama yanlış yerde ya da yarım. Bir gün ödenecek.
- **Backlog** — henüz sırası gelmedi.

Bir maddeyi yanlış listeye koymak, bu belgenin işe yaramaz hâle gelmesinin yolu: her sınırlamanın
borç gibi okunduğu bir liste, kimsenin bakmadığı bir listedir.

---

## 1. Sınırlamalar — bilerek

### 1.1 Depolama

| Ne                                                                                       | Neden                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Havuzu yok etmek, vdev değiştirmek, disk temizlemek yok.** Havuz OLUŞTURMA var (§3.9). | Ajan `zpool`'a hiçbir zaman `-f` geçmiyor, yani üstünde bir şey olan bir disk havuza katılamıyor. Bu kapıyı açmak, diğer bütün korumaları süs yapardı: sistem diski reddi ve WWN doğrulaması, ancak "temizle" düğmesi olmadığı sürece anlamlı. |
| **Çok diskli stripe ifade edilemiyor.**                                                  | Herhangi bir diski kaybetmenin her şeyi kaybettirdiği düzen, dosya saklamak için var olan bir cihazda bir listeden yanlış maddeyi seçerek ulaşılabilecek bir şey olmamalı. `single` var ve ne olduğunu söylüyor.                               |
| **Paylaşım silinemiyor.**                                                                | Grant'lar paylaşımı tutuyor (`ON DELETE RESTRICT`) ve son grant'ı silmek de reddediliyor: paylaşımı silmek dataset'i silmek demek. Kapatmanın yolu, kimseyi adlandırmayan bir kök izni.                                                        |
| **Anlık görüntü listesi havuzun envanteri değil.**                                       | Ajanda anlık görüntü için "listele" işlemi yok, o yüzden `/backups` yalnız DEPSIS'in kendi aldıklarını gösteriyor — ve yanıtta `complete: false` ile bunu söylüyor.                                                                            |
| **Btrfs yok ve "destekleniyor" diye gösterilmiyor.**                                     | ADR-0007: Btrfs bir PORT, yapılandırma seçeneği değil. `ino_generation` ve `zfs diff` karşılıkları farklı semantik.                                                                                                                            |

### 1.2 Ajan

| Ne                                                                                           | Neden                                                                                                                            |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Özyinelemeli işlem yok**: ne özyinelemeli silme, ne özyinelemeli kopyalama, ne `mkdir -p`. | §2.2 ve ADR-0006: hiçbir çağrının yarıçapını çağıran seçmemeli. Ağacı API yürüyor, çünkü ağacı saklayan taraf o.                 |
| **Sembolik bağ, soket ve aygıt düğümü listelenmiyor.**                                       | DEPSIS'in onlar için satır şekli yok, ve öyle bir satır ajanın kendisinin açmayı reddedeceği bir dosyayı arayüzde sunmak olurdu. |
| **Kontrol soketi sıralı.**                                                                   | Ayrıcalıklı işlemler yarışmasın diye (ADR-0006). Baytlar bu yüzden ayrı bir veri soketinden geçiyor.                             |

### 1.3 Kopyalama ve çatışma

`POST /file-operations` yalnız `operation: copy` ve `conflictPolicy: keep_both`. Diğerleri 422, ve
her birinin gerekçesi ucun kendi açıklamasında: `replace` ajana sahip olmadığı bir üzerine-yazma
vermek olurdu, `version` var olmayan bir sürüm deposu istiyor, `skip` savunulabilir ve yazılmadı.

### 1.4 İzleme

Yönetici panolarında keylogger, ekran izleme ya da mahrem davranış takibi **yok ve olmayacak**
(§7). Ölçülen şey işin ilerlemesi.

---

## 2. Teknik borç — yapıldı ama düzeltilmeli

### 2.1 İki yönetici kavramı çelişiyor

`GET /system/telemetry`, `GET /system/disks` ve `POST /storage/pools` **kurulumu yapan tek hesabı**
(`system_setup.admin_user_id`) istiyor. `POST /backups` ise `AdminGuard` kullanıyor, yani
`role = 'admin'` olan herkesi kabul ediyor — ve bu küme diğerinin katı üst kümesi.

Sonuç bugün ters duruyor: terfi ettirilmiş bir yönetici havuz durumunu OKUYAMIYOR ama ayrıcalıklı
ajana ZFS anlık görüntüsü ALDIRABİLİYOR. Zayıf kapı daha ayrıcalıklı işlemin önünde.

Bu, bir denetim düzeltmesinin yan etkisi olarak çözülecek bir şey değil: `system/` için TEK bir
karar gerekiyor — ya telemetri `AdminGuard`'a taşınır ve tek-hesap yalnız kurulum ve kurtarma için
kalır, ya da yedekleme tek-hesaba geçer. `SystemService.isSystemAdministrator`'ın yorumunda da
yazıyor.

### 2.2 SMART'ın üçüncü hâli yok

Sözleşmede `DiskStatus.healthy` bir boolean. "smartctl reddedildi" ile "bu sürücü arızalı" iki
farklı olgu ve tek değere sıkışıyorlar.

Kısmen hafifletildi: KEŞFEDİLEN bir diskin okunamayan özeti artık kırmızı bir satır değil, hiç
satır değil — kimse o diski sormadı. ADLANDIRILMIŞ bir disk kırmızı kalıyor, çünkü onu soran biri
var. Ama asıl çözüm sözleşmede: ya `healthy: { type: [boolean, 'null'] }` ya da
`status: healthy|unhealthy|unknown`, artı sebebi taşıyacak bir alan. O gün geldiğinde
`SystemService.disks` iki satır oluyor.

### 2.3 Tehdit modelinin güncel kalması — ödendi, ve borç olarak kalan kısmı

`docs/threat-model/README.md` Faz 0'da yazıldı ve "Faz 1 kodu yazıldıkça güncellenir" diyordu.
Güncellenmemişti; §11 olarak eklendi — Faz 0'dan sonra gelen altı yüzey, havuz oluşturma, ve Faz
1'de bulunan altı sessiz açık.

Kalan borç, belgenin kendisi değil ALIŞKANLIK: bu güncelleme bir kez elle yapıldı ve modeli koda
bağlayan hiçbir şey yok. Bir sonraki yüzey — replikasyon, bildirimler — aynı sessizlikle
eklenebilir. Bunu kapatmanın ucuz yolu, yeni bir ADR'nin şablonuna "tehdit modelinde karşılığı"
satırı koymak.

### 2.4 Ölçülmemiş sayılar

§18.2'nin gecikme hedefleri bu projede hiç ölçülmedi. `LoginThrottleService`'in eşikleri
(on hata, bir saniye tavan) **gerekçelendirildi, kalibre edilmedi** ve sınıfın kendi yorumunda
böyle yazıyor. `MAX_DATA_CONNECTIONS = 16`, `MAX_STREAMS = 64`, `MAX_POOL_DISKS = 24` de aynı
sınıftan: makul, ölçülmemiş.

### 2.5 Bu makinede koşmayanlar

`zpool create`, `prepare_share_root`, `full_audit` akışının host tarafı ve gerçek Samba bağlantısı
burada hiç çalışmadı — geliştirme distrosunda ZFS ve Samba yok. Komutların ÖNÜNDEKİ her şey testli
(argv'nin tam biçimi, reddedişler, reddedilen bir planda komutun hiç çalışmadığı), ama komutun
kendisi Debian VM'de doğrulanmalı.

### 2.6 SSE akışı ve tarayıcı sınırı

`EventsService.MAX_STREAMS = 64`. Bir vekil sunucu arkasında birden fazla sekmesi olan birkaç
yönetici bunu doldurabilir; ucun cevabı 429 ve `Retry-After`, yani `EventSource` geri dönüyor —
ama sınırın doğru sayı olduğu ölçülmedi.

---

## 3. Sonraki faz backlog'u

### Faz 2

1. **Görev modülü §7'ye göre TAMAM.** Durum, öncelik, son tarih, aktivite, dosya bağı, yorum,
   mention, izleyici, alt görev, kontrol listesi ve etiket yazıldı. Kalanlar birer sınırlama, eksik
   madde değil:

   **Etiket süzmesi İSTEMCİDE ve VE'li.** Pano zaten bütün işleri tek çağrıda getiriyor, o yüzden
   süzgeç bir sorgu parametresi değil; iki etiket seçmek daraltıyor ("acil VE depolama"), ve
   "acil ya da depolama" sorulamıyor. Pano büyüdüğünde ikisi de sunucuya taşınmalı.

   Alt görev **tek seviye** ve bu bilinçli: keyfi derinlikte bir ağaç, bir yapılacaklar panosunu
   bir dosya yöneticisine çevirir. Parçalar panoda kendi satırları olarak, atananının sütununda
   duruyor — bir parça da birine verilen iş, ve yalnız üstünün panelinde göstermek onu panodan
   kaldırmak olurdu. Parçaların KENDİ SIRASI yok: pano sırası atanana göre, ve bir üst işin
   parçalarını elle dizmek ancak parçalar tek bir listede gösterilseydi anlamlı olurdu.

2. **Yorumda biçimlendirme yok.** Gövde düz metin: kalın, liste, kod bloğu ya da bağlantı yok.
   Markdown eklemek bir işaretleme çözümleyicisi ve onunla birlikte bir XSS yüzeyi getiriyor, ve
   bir NAS'ın iş panosunda düz metnin yetmediği ölçülmedi. `@ad` işaretleniyor ama TIKLANABİLİR
   değil — istemci bir adın gerçek bir kullanıcı olduğunu bilmiyor, ve bilmediği bir şeyi iddia
   eden bir bağlantı, bozuk bir bağlantı.
3. **Yorum düzenlemenin geçmişi tutulmuyor.** `edited_at` düzenlendiğini söylüyor, önceki hâli
   söylemiyor. Sürüm geçmişi tutmak yeni bir tablo, ve düzenlemenin denetim değeri bugün
   "değişti"nin ötesine geçmiyor.
4. **Bildirim, akışta değil yoklamada.** Zil altmış saniyede bir `/notifications` soruyor; SSE
   akışı (`/events`) bildirim taşımıyor. Taşısaydı bildirim anında düşerdi — bugün en kötü ihtimalle
   bir dakika gecikiyor. Ölçülüp değiştirilecek bir sayı, çalışmayan bir şey değil.
5. **Replikasyon ve restore.** Yedek listesi artık HAVUZLA karşılaştırılıyor (`list_snapshots`):
   kayıtta olup havuzda olmayan bir görüntü `missing`, kabuktan alınmış olan `unmanaged` görünüyor.
   Ekrandaki "bu liste havuzun envanteri değil" uyarısı kalktı; yerine yalnız ajana ulaşılamadığında
   çıkan bir uyarı geldi.

   **Kalan iki şey ve neden kaldıkları:**

   _Ayrı hedefe `zfs send` — ARTIK BAŞKA BİR MAKİNEYE DE._ Bu madde bir taşıma katmanı (SSH), bir
   kimlik deposu, host anahtarı doğrulaması ve kopan bir bağlantı için bir hata modeli istiyordu.
   Dördü de yazıldı.

   `POST /storage/replication` ikinci bir HAVUZA kopyalıyor ve bir diskin ölmesini atlatıyor;
   `POST /storage/offsite/replicate` başka bir MAKİNEYE kopyalıyor ve kutunun çalınmasını, evin
   yanmasını, fidye yazılımının bağlı her veri kümesine ulaşmasını atlatıyor — ki insanlar "yedek"
   derken çoğunlukla bunu kastediyor. İkisi de §8.1'in dizisini izliyor; ikincisinin onay metni
   `kullanıcı@makine:veri-kümesi`, çünkü yok edilen şey karşı tarafta ve aynı ada sahip yerel bir
   veri kümesi olabilir.

   **Anahtar ayrıcalıklı tarafta üretiliyor ve orada kalıyor.** Hiçbir uç özel yarısını okuyamıyor;
   okunabilen tek şey açık yarı — kullanıcının karşı tarafın `authorized_keys` dosyasına
   yapıştıracağı satır. ADR-0016 cihazı, veritabanına erişimin tek başına yetmeyeceği şekilde
   bölüyor, ve bir HTTP ucundan okunabilen özel anahtar o bölmeyi başka bir makineye ulaşan tek
   kimlik bilgisi için ortadan kaldırırdı.

   **İlk kullanımda güven yok.** `scan` karşı tarafın anahtarını soruyor ve hiçbir şeye güvenmiyor;
   `trust` kullanıcının GÖRDÜĞÜ ve parmak izini karşılaştırdığı satırı yazıyor. İkisi ayrı uç, ve
   birleştirilmemeleri kararın kendisi: "bağlan ve ne çıkarsa kabul et" bir replikasyonda
   saldırganın bu cihazdaki her dosyanın kopyasını alması demek. `ssh` `StrictHostKeyChecking=yes`
   ile çağrılıyor, `accept-new` ile değil.

   **Host anahtarı DEĞİŞTİYSE kendi cevabı var.** Ya sunucu yeniden kuruldu ya da araya biri girdi,
   ve DEPSIS hangisi olduğunu tahmin etmiyor — iş, kullanıcının bilerek yeniden onaylamasını
   isteyen bir cümleyle duruyor.

   **Yapılmayan:** IPv6 literalleri (`known_hosts` onları köşeli parantezle yazıyor ve yarım
   ayrıştırılmış bir adres hiçbir şeyle eşleşmeyen bir arama anahtarı üretir — ad kullanmak
   gerekiyor), ve gerçek bir uzak makineye karşı ölçüm: bu depoda ikinci bir makine yok, yani
   ölçülen şey argv'nin şekli, parmak izi eşleştirmesi ve reddedişler; baytların gerçekten karşıya
   varması değil.

   **Zamanlama YAPILDI.** `storage.backup-tick` altıncı kendi kendini zamanlayan zincir: beş
   dakikada bir vakti gelmiş zamanlamaları buluyor, görüntüyü alıyor, çoğaltmayı kuyruğa alıyor ve
   fazlalıkları buduyor. Saatlik, günlük ya da haftalık; cron ifadesi değil, çünkü cron bir ev
   NAS'ının sahibinin yanlış yazabileceği ve yanlış yazdığında sessizce hiç çalışmayan bir dil.

   **Budama yalnız KENDİ aldıklarına dokunuyor** — her zamanlamanın görüntüleri kendi ritminin ön
   ekini taşıyor. Elle alınmış bir görüntüyü ya da başka bir aracın aldığını silen bir budama, veri
   kaybının fark edilmeyen biçimi olurdu.

   **Yedekler DOĞRULANIYOR, ve doğrulamanın ne kanıtladığı yazılı.** Zamanlamanın `last_result`
   alanı bir tek şeyi söylüyordu: `zfs snapshot` komutunun hata vermediğini. Bir yedeğin sessizce
   işe yaramaz olmasının üç yolu o cümlenin dışında kalıyordu — görüntü kabuktan silinmiş,
   görüntü mount edilemiyor, ya da görüntü BOŞ. Turda bir zamanlama (en eski doğrulanmış olandan
   başlayarak) en yeni görüntüsünü açıp listeliyor, ve sonucun cümlesi ekranda ayrı bir sütunda
   duruyor.

   **Baytların sağlam olduğunu göstermiyor**, ve bu da yazılı: onu ZFS'in sağlama toplamları ve
   `zpool scrub` yapıyor. Taramanın SONUCU artık Yedekleme panelinde her havuz satırının altında
   (`zpool status`'ün kendi sözleriyle, ayrıştırılmadan) ve bir "Şimdi tara" düğmesi yanında.
   DEPSIS tarama ZAMANLAMIYOR — Debian'ın `zfsutils-linux` paketi zaten aylık bir tarama koyuyor,
   yani eksik olan şey zamanlama değil görünürlüktü. Veri kümesi bir
   paylaşımın kümesi değilse görüntünün içine bakılamıyor; cümle onu da söylüyor, çünkü
   "doğrulandı" deyip yalnız satır sayan bir alan kapalı görünüp hiçbir şey tutmayan bir kapı
   olurdu.

   **Zamanlanmış çoğaltma ARTIMLI gönderiyor.** Taban, en son BAŞARIYLA gönderilmiş görüntü;
   zamanlamanın kendi satırında duruyor çünkü hedef başka bir makinede olabilir ve ona her tur
   "sende ne var" diye sormak fazladan bir bağlantı demek. İlk turda ve başarısız bir turdan sonra
   taban `null` — yani tam gönderim. İkincisi bilerek kaba: kopmuş bir gönderimden sonra hedefin ne
   tuttuğu bu taraftan bilinmiyor, ve olmayan bir tabana dayanan artımlı bir akış reddedilir, yani
   bir sonraki tur da başarısız olurdu. Bir fazladan tam gönderim, sessizce hiç çoğaltmayan bir
   zamanlamadan ucuz.

   **İlerleme göstergesi yok, ve bu bilinçli.** `zfs send` ilerlemeyi yalnız `-v` ile kendi
   stderr'ine yazıyor; ajan onu ayrıştırmıyor. Bir zamanlayıcıyla ilerleyen çubuk, hiçbir şeyin
   resmi olurdu. İş "çalışıyor" diyor, bitince `zfs recv`'in kendi sözlerini gösteriyor.

   _Dosya bazında geri yükleme YAPILDI._ Bu madde bir TASARIM ENGELİ olarak yazılmıştı ve engel
   gerçekti: ZFS'te bir anlık görüntü `.zfs/snapshot/<ad>/` altında AYRI BİR MOUNT olarak beliriyor,
   ve ajanın güvenli yol dikişi `openat2`'yi `RESOLVE_NO_XDEV` ile çağırıyor — mount sınırını
   geçmeyi kasten reddediyor. O bayrak paylaşım ağacından çıkmayı engelleyen şey.

   Çözüm, bayrağı kaldırmak değil, TEK BİR ADIMDA düşürmek oldu. Yürüyüş dört adım ve yalnız
   üçüncüden dördüncüye geçerken sınır aşılıyor: `<paylaşım>` tam bayrak kümesiyle, `.zfs` ve
   `snapshot` yine tam bayrak kümesiyle (ikisi de paylaşımın kendi mount'unda), sonra TEK BİR
   bileşen — görüntünün adı — `NO_XDEV` olmadan ama `BENEATH`, `NO_SYMLINKS` ve `NO_MAGICLINKS`
   hâlâ açıkken, ve nihayet görüntünün içindeki yol yine tam bayrak kümesiyle. İç içe bir dataset
   bir üst görüntünün parçası olmadığı için geçilecek ikinci bir sınır zaten yok; olsaydı son adım
   reddederdi.

   **VE ÖLÇÜLDÜ.** Bu maddenin eski hâli "körlemesine yazılmış bir kapı, açık olduğunu sanılan bir
   kapıdır" diyordu; ölçüm o yüzden şart. Bu makinede ZFS yok, ama `RESOLVE_NO_XDEV` mount'ları
   karşılaştırıyor, dosya sistemi TÜRLERİNİ değil — yani `mount --bind` tam olarak aynı sınırı
   üretiyor. Testler gerçek bir bind mount kuruyor ve dört şeyi ölçüyor: sıradan çözümlemenin aynı
   dizini REDDETTİĞİNİ (yoksa test hiçbir şey kanıtlamazdı), yeni metodun okuduğunu, görüntünün
   İÇİNDEN dışarı çıkmanın hâlâ reddedildiğini, ve görüntünün içine konmuş İKİNCİ bir mount'un
   reddedildiğini. `DEPSIS_REQUIRE_MOUNT_TESTS=1` atlamayı hataya çeviriyor; WSL koşucusu onu
   veriyor.

   **ÖLÇÜLMEYEN, ve açıkça yazılıyor:** ZFS bir görüntüyü ilk erişimde mount ediyor, ve o otomatik
   mount'un `openat2` altında tetiklenip tetiklenmediğini bir bind mount cevaplayamaz. Tetiklenmezse
   sonuç sessiz bir boş liste DEĞİL, görüntüyü adıyla anan bir hata — bu ayrım bilerek kuruldu,
   çünkü boş bir liste "bu görüntüde bir şey yok" diye okunur ve silinmiş dosyasını arayan biri onu
   okuyup arayışı bırakır.

   Ürün tarafı: paylaşımın geçmiş sürümleri `Dosyalar` panelinden açılıyor, bir görüntü seçilip
   içinde gezilebiliyor, ve tek bir dosya canlı ağaca geri getirilebiliyor. Geri getirme, kaynağı
   değişmez olan bir KOPYALAMA — aynı dilimli hazırlık, aynı yer-yok cevabı, aynı sahiplik
   düzeltmesi, aynı `RENAME_NOREPLACE` yayını. Üzerine asla yazmıyor: ad doluysa sunucu boş bir ad
   seçiyor ve SEÇTİĞİNİ söylüyor.

   **Yetki paylaşım çapında**, ve bu bir daraltma. İzinler klasör bazlı, ama bir görüntünün ağacı
   onlara eşlenemiyor — geri istenen klasör çoğu zaman artık yok, yani izni taşıyacak canlı bir
   satır yok. Kural, paylaşımın KÖKÜNDE `download`: yalnız bir alt klasöre yetkisi olan biri
   geçmişe hiç bakamıyor. Kapalı tarafa düşüyor, ve sözleşmede yazıyor.

   **Yapılmayan:** bir klasörün tamamını geri getirmek (ajanın kapalı işlem kümesi tek dosya
   kopyalıyor; bir ağaç, çağıranın maliyetini seçtiği bir çağrı olurdu), ve görüntüler arası fark
   göstermek.

6. **Önizleme ve küçük resim — yarısı var, ve eksik olan yarı bilinçli.**

   Satırdaki kare, JPEG'in EXIF'ine GÖMÜLÜ küçük resmi gösteriyor: telefon ve fotoğraf makinesi
   fotoğraflarının neredeyse hepsi onu taşıyor, ve çıkarmak bayt dilimlemek — sunucu hiçbir
   görüntünün kodunu ÇÖZMÜYOR.

   **Kapsamayan:** ekran görüntüleri, PNG, WebP, EXIF'siz JPEG ve videolar. Onlar için kare tür
   simgesinde kalıyor.

   Eksik olanın yolu belli ve bilerek seçilmedi: sunucuda bir görüntü kütüphanesi (`sharp`/libvips)
   çalıştırıp yeniden boyutlandırmak. Maliyeti, güvenilmeyen kullanıcı baytlarını çözen onlarca
   megabaytlık yerel bir ikiliyi — tarihsel olarak en verimli RCE yüzeylerinden birini — oturumları
   ve veritabanı bağlantısını tutan sürecin içine koymak. Bir NAS'ın en çok yüklenen şeyi fotoğraf,
   yani o kod her gün güvenilmeyen veri görürdü. Yapılacaksa ayrı, ayrıcalıksız ve zaman sınırlı
   bir süreçte yapılmalı; API'nin içinde değil.

   İkinci ara adım, istemcinin dosyayı indirip kendi canvas'ında küçültmesi: tarayıcının çözücüsü
   sandbox'lı ve bu iş için sertleştirilmiş. Bedeli bant genişliği — 27 piksellik bir kare için tam
   çözünürlüklü bir dosya — ve ZeroTier üzerinden uzaktan bakan biri için kabul edilemez. Bir boyut
   eşiğiyle yapılabilir, ama ölçülmeden değil.

   **Önbellek BELLEKTE ve süreçle birlikte gidiyor** (32 MB, en eski atılır). Diskte bir önbellek
   bir dizin, bir yapılandırma ve bir temizleme işi demek; yeniden üretmek 128 kB'lık bir okuma.
   Fotoğraf kütüphanesi büyüdükçe ölçülüp değiştirilecek bir sayı.

7. **Masaüstü istemci — Windows sürücü eşleme yapıldı, AYRI UYGULAMA yapılmadı.**

   Paylaşımlar ekranındaki "Bu bilgisayara bağla", her paylaşım için Windows (Gezgin adresi ve
   kalıcı `net use`), macOS (`smb://`) ve Linux (`mount -t cifs`) komutlarını kullanıcı adıyla
   birlikte veriyor. Adres TARAYICININ bağlandığı addan alınıyor, sunucunun yapılandırılmış
   adından değil: sunucunun birkaç adresi olabiliyor ve hangisinin bu istemciye ulaştığını
   bilmiyor, ama tarayıcının bağlandığı ad tanım gereği az önce çalışmış olan.

   Ayrı bir masaüstü uygulaması YAPILMADI: paketleme, imzalama, otomatik güncelleme ve platform
   başına bir yükleyici demek, ve §21'in teslimat listesinde "imzalı derleme ve güncelleme
   prosedürü" olarak zaten ayrı bir madde. Bir uygulamanın çözeceği asıl sürtünme — adresi,
   kullanıcı adını ve `net use`'un söz dizimini bilmek — bu ekranla çözülüyor; kalanı senkronizasyon
   ve tepsi simgesi.

   **Otomatik eşleme yok:** komut kopyalanıp çalıştırılıyor. Tarayıcıdan bir `.cmd` indirtmek
   mümkündü ve yapılmadı — indirilen bir betiği çalıştırmak, kullanıcıya öğretilmemesi gereken bir
   alışkanlık.

### Faz 3

8. **ZeroTier: bağlantı tanılaması YAPILDI, self-hosted controller ve QR yapılmadı.**

   `GET /remote/peers` bu düğümün kimi gördüğünü ve NASIL ulaştığını söylüyor. Eksik olan tam da
   buydu: `GET /remote` "çevrimiçi" ve "ağa katıldı" diyor, ve her baytı bir ZeroTier kökü
   üzerinden aktarılan bir bağlantı için de aynı şeyi diyor — doğru, ve bir kat daha yavaş.
   Kullanıcının "neden yavaş" sorusunun cevabı başka hiçbir ekranda yoktu.

   `direct` ZeroTier tarafından bildirilmiyor, ajanda türetiliyor (aktif yol var mı), ve türetme
   orada duruyor ki API ile tarayıcı kendi kopyalarını büyütmesin.

   **Self-hosted controller yok.** Kendi ağ kimliklerini ÜRETEN ve üyeleri yetkilendiren bir
   controller, ayrı bir servis (`ztncui` ya da `zerotier-one`'ın controller API'si) ve kendi kalıcı
   durumu demek. Bugün DEPSIS başkasının ağına KATILIYOR; ağı kendisi kurmuyor.

   **Enrollment QR yok.** Ağ kimliğini bir QR'a çevirmek küçük bir iş ama bir QR kütüphanesi
   demek, ve tek kazancı telefonda on altı hane yazmamak. Controller geldiğinde onunla birlikte
   anlamlı olur.

9. **Nextcloud ve Immich reçeteleri YAPILDI**, ve yapılırken katalogdaki bir yalan düzeltildi.

   Immich zaten katalogdaydı — tek konteyner olarak, `immich-server` diye. O imaj tek başına
   ÇALIŞMIYOR: açılışta bir PostgreSQL ve bir Redis arıyor, bulamayınca çıkıyor. Yani katalogda,
   kullanıcıya "kur" düğmesi gösteren, bastığında birkaç yüz megabayt indiren ve sonra sessizce
   ölen bir satır duruyordu.

   Migration 0031 kataloğu gerçek uygulamaların şekline getirdi: bir katalog satırı artık sıralı
   bir konteyner listesi tarif ediyor, ve bir kurulum bir podman POD'u — üyeler ağ ad alanını
   paylaşıyor, yani birbirlerine 127.0.0.1 üzerinden ulaşıyorlar. Immich dört konteyner (sunucu,
   makine öğrenmesi, `pgvecto.rs` uzantılı veritabanı, önbellek), Nextcloud iki (sunucu ve
   PostgreSQL — SQLite ile değil, çünkü bir NAS'ta "deneme kurulumu" diye bir şey yok).

   Sunucuyla veritabanının anlaşması gereken parola **saklanmıyor, türetiliyor**: cihazın kendi
   anahtarından ve (kiracı, uygulama, ad) üçlüsünden HKDF ile. Veritabanı bir sunucu parolası
   tutmadığı için bir `pg_dump` onu evden çıkaramıyor, ve türetme deterministik olduğu için
   yükseltmeden sonra yeniden yaratılan konteyner kendi veri dizinini açmaya devam ediyor.
   Anahtarı olmayan bir kutuda kurulum REDDEDİLİYOR — sabit bir parola her DEPSIS'te aynı olurdu,
   rastgele bir parola ise saklanmak zorunda kalırdı.

   **Yapılmayan:** birden fazla podu olan uygulamalar, konteynerler arası hazır-olma beklemesi
   (bugün onu imajların kendi yeniden deneme döngüleri ve `restart_policy: on-failure` taşıyor),
   ve uygulama başına kaynak sınırı.

10. **Android** yerel bağlantı kabuğu.

### Faz 4

11. Off-site backup, PITR, otomatik restore testi.
12. Güncelleme ve geri alma, HA controller, relay.
13. Performans, chaos ve penetrasyon testleri. **Erişilebilirlik testleri yazıldı**
    (`e2e/a11y.spec.ts`): giriş ekranı, masaüstü, beş panel ve iki açılır panel, WCAG 2 A/AA
    kurallarıyla, iki projede.

    Kontrast dahil, ve bu ölçülerek karar verildi: kural bir kez açılıp koşuldu ve hiçbir ekranda
    ihlal çıkmadı, yani palet AA eşiğini karşılıyor. Süitte bir de kendini denetleyen bir test var
    — sayfaya bilerek adsız bir düğme koyup axe'ın onu gördüğünü doğruluyor. Yalnız geçebilen bir
    süit, bir süit değil.

    **Kapsamadığı:** klavyeyle gezilebilirlik, odak sırası, ve ekran okuyucunun okuduğu cümlenin
    anlamlı olması. axe bunları göremiyor ve göremediğini söylemek gerekiyor — makine tarafından
    karara bağlanabilir olanlar bittiğinde geriye kalan, insan işi.

### §21'in kalan teslimatları

12. **Storybook / tasarım sistemi.**
13. **İmzalı build ve güncelleme üretim prosedürü.**

---

## 4. Bu kutudan çıkmayacaklar

Bunları "yapılmadı" diye saymak yanıltıcı olur; yapılamıyorlar:

- **iOS.** Mac, Apple geliştirici hesabı ve entitlement onayı gerekiyor. Spec'in kendisi "iOS,
  entitlement doğrulamasından sonra" diyor (§3.3, Faz 3).
- **Android'in derlenmesi.** SDK bu makinede kurulu değil; kod yazılabilir, üretilemez.
- **Gerçek ZFS/Samba davranışı.** Bkz. 2.5 — Debian VM gerekiyor.
