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
5. **Replikasyon ve restore arayüzü.** Anlık görüntü var; ayrı hedefe `zfs send` ve geri yükleme
   ekranı yok. (Bugün `restore` yalnız çöp kutusundan geri alma.)
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

7. **Masaüstü istemci ve Windows sürücü eşleme.**

### Faz 3

8. **Self-hosted ZeroTier controller paneli**, enrollment QR, bağlantı tanılama. Bugün `/remote`
   yalnız durum okuyor, ağa katılıyor ve ayrılıyor.
9. **Nextcloud ve Immich reçeteleri.** Katalog altyapısı (`/apps`) var.
10. **Android** yerel bağlantı kabuğu.

### Faz 4

11. Off-site backup, PITR, otomatik restore testi.
12. Güncelleme ve geri alma, HA controller, relay.
13. Performans, chaos, erişilebilirlik ve penetrasyon testleri.

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
