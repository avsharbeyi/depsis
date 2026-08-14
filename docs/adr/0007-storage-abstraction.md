# ADR-0007: Depolama soyutlaması — ZFS, Mock ve Btrfs'in gerçek maliyeti

- **Durum:** Accepted
- **Tarih:** 2026-08-14
- **Faz:** 0
- **Etkilenen bileşenler:** `services/system-agent/src/ops`, `apps/api/src/storage`, `packages/contracts`

## Bağlam

§2.1: _"OpenZFS öncelikli. Donanım/çekirdek uyumsuzluğunda Btrfs destek planı ayrı adaptör olarak
tasarlanabilir; aynı havuzda iki yaklaşımı karıştırma."_

§19: dev ortamı root ve disk gerektirmeden mock adapter'larla ayağa kalkmalı.

Bu ADR bir soyutlama kuruyor — ama Faz 0 araştırması, soyutlamanın **ne kadarının gerçekten
taşınabilir olduğu** konusunda dürüst olmayı gerektiriyor.

## Karar

### İki ayrı soyutlama, tek değil

Yaygın hata, "depolama adaptörü" diye tek bir arayüz kurup ZFS'e özgü kavramları içine
sızdırmaktır. Bunun yerine iki katman:

**Katman 1 — `FileStore` (gerçekten taşınabilir).** POSIX dosya sistemi işlemleri: güvenli
`openat2` çözümleme, oku/yaz, `renameat`, `linkat`, `unlink`, `statx`, POSIX ACL (`getfacl`/
`setfacl`). Bu katman ZFS, Btrfs, ext4 ve testte tempdir üzerinde **aynı** çalışır.

**Katman 2 — `VolumeManager` (taşınabilir değil, ve öyleymiş gibi davranmayacak).** Havuz/dataset
yaşam döngüsü, snapshot, replikasyon, kota, scrub, disk sağlığı, kapasite raporlama. Bu katmanın
her uygulaması **kendi semantiğini** taşır.

`apps/api` çoğunlukla Katman 1'i görür. Katman 2 yalnız sistem aracısı üzerinden ve yalnız
`apps/api/src/storage` içinden erişilir.

### Uygulamalar

| Uygulama | Katman 1                          | Katman 2                                | Nerede                          |
| -------- | --------------------------------- | --------------------------------------- | ------------------------------- |
| `zfs`    | `openat2` tabanlı                 | `zfs`/`zpool` argv çağrıları (ADR-0006) | Üretim, Debian VM               |
| `mock`   | tempdir'e köklenmiş `std::fs`     | bellek içi durum makinesi               | Windows dev, birim testleri, CI |
| `btrfs`  | **aynı Katman 1 kodunu kullanır** | yazılmadı                               | Faz 4'te değerlendirilir        |

Mock'un Katman 1'i **gerçek POSIX semantiğini taklit etmeye çalışmaz** — tempdir'de gerçek dosya
sistemi kullanır, yalnız kök farklıdır. Sahte bir dosya sistemi yazmak, testlerin gerçekte
olmayan davranışları doğrulamasına yol açardı.

### Btrfs hakkında dürüst olmak

Faz 0 araştırması, Btrfs'in "ayrı adaptör yazarız" ile çözülmeyecek üç bağımlılık ortaya çıkardı:

| Bağımlılık                                                                | Nerede karara bağlandı | Btrfs'te durum                                                               |
| ------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------- |
| `acltype=posixacl` + `xattr=sa`; Samba `acl_xattr`                        | ADR-0004               | Btrfs POSIX ACL destekler → **taşınabilir**                                  |
| Subvolume/dataset sınırında `rename()` EXDEV; staging aynı dataset içinde | ADR-0008               | Btrfs subvolume'leri de ayrı mount → **aynı kısıt, aynı çözüm**              |
| `ino_generation` reconciliation anahtarı                                  | ADR-0005               | Btrfs generation kavramı **farklı** → adaptör gerekli                        |
| `zfs diff` ile snapshot mutabakatı                                        | ADR-0011 Katman 3      | Btrfs karşılığı `btrfs subvolume find-new` — **farklı semantik, farklı kod** |
| ZFS send/receive replikasyonu                                             | Faz 2 yedekleme        | `btrfs send/receive` benzer ama **eşdeğer değil**                            |

Yani Btrfs desteği bir **port**tur, bir yapılandırma seçeneği değil. Bu ADR onu mümkün kılacak
sınırları kuruyor ama **Faz 1–3'te yazılmayacak** ve UI'da "desteklenir" diye gösterilmeyecek.

§2.1'in _"aynı havuzda iki yaklaşımı karıştırma"_ emri şema düzeyinde uygulanır: `storage_pools`
tablosunda `backend` sütunu vardır, havuz oluşturulduğunda sabitlenir ve **değiştirilemez**.

### Yıkıcı işlemler soyutlamanın dışında kalır

Havuz oluşturma, disk rol atama ve vdev değiştirme **kasıtlı olarak** genel bir arayüzün arkasına
konmuyor. Bunlar risk R1'dir (yanlış diski silmek) ve her backend için ayrı ayrı, açıkça yazılır.
Bir "generic `createPool(disks)`" arayüzü, bir backend'in semantiğini diğerine taşıma hatasını
davet eder.

Her yıkıcı operasyon şu sırayı izler (§8.1): analiz → plan → etkilenen disklerin **seri/WWN
listesi** → yazılı onay → yeniden kimlik doğrulama → job. Bu sıra soyutlamanın **üstünde**, API
katmanındadır ve backend'e devredilmez.

### Kapasite raporlama

ADR-0008'de doğrulandı: `statvfs` ZFS'te `refquota`'yı sürümler arasında tutarsız yansıtır.
`VolumeManager` bu yüzden kapasiteyi **backend'e özgü** biçimde raporlar
(`zfs get -Hp used,usedbysnapshots,available,refquota,quota`) ve ortak bir `CapacityReport`
tipine çevirir. `statvfs` **kullanılmaz**.

## Kanıt

Bu ADR yeni bir dış iddia getirmiyor; ADR-0004, 0005, 0006, 0008 ve 0011'de doğrulanmış bulguların
mimari sonucudur. Btrfs'e özgü davranışlar (`find-new` semantiği, generation kavramı)
**doğrulanmadı** — Faz 4'e kadar gerekmediği için araştırılmadı ve bu ADR onlara dayanan hiçbir
söz vermiyor.

## Sonuçlar

**Olumlu:** `apps/api`'nin büyük kısmı taşınabilir Katman 1'e karşı yazılır ve Windows'ta test
edilebilir. ZFS'e özgü her şey tek bir yerde toplanır. Btrfs'in gerçek maliyeti gizlenmiyor.

**Olumsuz / kabul edilen bedel:** İki katman, iki arayüz. Mock Katman 2 gerçek ZFS davranışını
kanıtlamaz — bu yüzden ADR-0012'nin çift hattı zorunlu kalır ve her raporda mock/gerçek ayrımı
belirtilir (§22).

**Bu kararın yasakladığı şeyler:**

- ZFS'e özgü kavramlar (dataset, snapshot, scrub, resilver) Katman 1 arayüzüne sızamaz.
- `statvfs` kapasite raporlamada kullanılamaz.
- Bir havuzun `backend` değeri oluşturulduktan sonra değiştirilemez.
- Yıkıcı disk operasyonları için generic bir arayüz yazılamaz.
- Mock backend ile alınan sonuçlar depolama davranışının kanıtı sayılamaz.
- Btrfs, yazılmadan önce UI'da veya belgelerde "desteklenen" olarak gösterilemez.

## Geri alma maliyeti

Düşük. Soyutlama sınırlarını sonradan sıkılaştırmak mümkün; asıl maliyet yanlış yere konmuş bir
sınırın Katman 1'e ZFS kavramı sızdırmasıdır — bu yüzden yasak listesi açık yazıldı.

## Güvenlik ve veri kaybı etkisi

En önemli kısım yıkıcı işlemlerin **kasıtlı olarak soyutlanmaması**. Risk R1'in gerçekleşme yolu
tam olarak şudur: bir backend için doğru olan disk seçim mantığının, generic bir arayüz üzerinden
başka bir backend'e uygulanması. Ayrı yazmak kod tekrarıdır ama burada tekrar, yanlış diski
silmekten ucuzdur.
