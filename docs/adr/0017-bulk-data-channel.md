# ADR-0017: Ayrıcalıklı ajana toplu veri kanalı

- **Durum:** Accepted
- **Tarih:** 2026-08-22
- **Faz:** 1
- **Etkilenen bileşenler:** `services/system-agent`, `deploy/systemd`, `apps/api` (tus katmanı)

## Bağlam

ADR-0008 içinde çözülmemiş bir çelişki vardı ve yük taşıyordu:

- _"Dayanıklılık sırası (**sistem aracısı sahiplenir, Node değil**)"_ — parçaları yazmak dahil.
- Ama aynı belge `@tus/server` 2.4.4'ü Node middleware olarak mount ediyor, ve bir tus file-store
  baytları **kendisi** yazar.

İkisi aynı anda doğru olamaz. Üstelik `deploy/systemd/depsis-api.service` bir tarafı zaten seçmişti:
`ReadWritePaths=` boş, yani API hiçbir yere yazamıyor.

### En temiz tasarım ulaşılamaz

Doğru cevap normalde şudur: ajan dosyayı `openat2(RESOLVE_BENEATH)` ile açar ve **tanımlayıcıyı**
`SCM_RIGHTS` ile devreder; API sahteleyemeyeceği bir yetenek üzerinden yazar, hiçbir yol çözmez.

**Node bunu yapamıyor.** `net` modülünde ancillary data desteği yok (resmi belgeden doğrulandı), ve
`child_process` üzerinden handle geçirme yalnız Node ebeveyn–çocuk arasında çalışır — bir Rust
süreci ondan fd alamaz. Yerli bir eklenti, yetkisiz servise derlenmiş bir bağımlılık eklerdi.

Seçenekler proje sahibine sunuldu ve karar alındı: **baytlar seyahat edecek, ajan yazacak.**

## Karar

### Şekil

İki soket. Kontrol kanalı bugünkü hâliyle kalıyor: satır sonlu JSON, 256 kB üst sınır, mutlak okuma
son tarihi, ve **seri** — çünkü ayrıcalıklı operasyonlar küresel durumu değiştirir ve denetim
kaydını gerçek bir sıralı tarih yapan şey budur (ADR-0006).

Veri kanalı ayrı bir sokettir ve **eşzamanlıdır**. 10 GB'lık bir yükleme kontrol soketini tutsaydı,
süresi boyunca başka her ayrıcalıklı çağrıyı bloke ederdi.

```
kontrol:  OpenTransfer{share, staging_name}  →  Transfer{token, offset}
veri:     {"token":…,"offset":…,"length":…}\n  →  {"status":"ready"}\n
          … tam olarak `length` bayt …          →  {"status":"stored","bytes":…}\n
kontrol:  PublishTransfer{…, expected_bytes}  →  Publish{bytes}
```

### Jeton, dosyayı adlandırır — yolu değil

`OpenTransfer` yolu `openat2(RESOLVE_BENEATH|NO_SYMLINKS|NO_MAGICLINKS|NO_XDEV)` altında çözer,
**tanımlayıcıyı tutar** ve tek kullanımlık bir jeton döndürür. Veri soketinde gönderilen hiçbir şey
hangi dosyaya yazıldığını değiştiremez. Bir yüklemeyi iki bağlantıya bölmeyi güvenli kılan tek
özellik budur, ve veri kanalının dosya adını tekrarlamak yerine jeton almasının sebebi de budur.

### İlk satır bir BİLDİRİM, sonlandırıcı yarı-kapatma DEĞİL

İlk tasarım `<token>\n` sonrası "istemci yarı kapatana kadar akıt" diyordu. Üç bağımsız açı bunu
ayrı ayrı reddetti ve gerekçeleri farklıydı:

- **EOF niyet taşımaz.** OOM ile öldürülmüş bir istemci, bir proxy reset'i ve düzgün bir
  `shutdown(SHUT_WR)` ajana **bayt bayt aynı** görünür. Yarım kalmış bir parça `fsync`lenip başarı
  olarak raporlanır.
- **Ajanın reddedecek bir miktarı yoktur.** Kayıp bir onaydan sonra yeniden gönderilen bir parça
  ikinci bir kopya ekler; taşan bir gövde API'nin kaydettiği offset'in ötesine yazar.
- **Yarı kapatma zaten ölçülmüş bir risk.** `apps/api/src/agent/agent.service.ts` yarı kapalı bir
  bağlantı üzerinde yanıtın kaybolduğunu belgeliyor (adlandırılmış boruda 5'in 4. ve 5.'si). Bu
  tasarım tam o şekli taşıyıcı yapardı, üstelik önüne bir `fsync` gecikmesi koyarak.

Bildirilen `length` yarı kapatma ihtiyacını tümden kaldırır ve ölçülmüş-iyi olan "yaz ve iki yönü
de açık tut" deyimini korur.

**Offset kaynağı dosyanın kendisidir.** Ajan `claim` anında tutulan tanımlayıcının gerçek EOF'unu
okur — `OpenTransfer` sırasında önbelleklenen sayıyı değil, ki o `TRANSFER_TTL` kadar bayat
olabilir — ve bildirilenle uyuşmazsa `offset_mismatch` ile reddeder. tus deposundaki sayı bir
önbellektir; kayıt tutan şey dosyadır.

### Veri kanalı kendi okuyucusunu ister

`read_request_line_within` veri soketinde **asla** çağrılmamalı. Satır sonunu gördüğünde 8 kB'lık
yığının **tamamını** tampona ekliyor ve sonra `String::from_utf8_lossy` uyguluyor. Bildirimi ve ilk
yük baytlarını tek bir syscall'da yazan bir istemci — ki `pipeline(body, socket)` bunu yapar, ve
paket birleştirme zaten yapar — dosya içeriğinin ilk ~8 kB'ını geri döndürülemez biçimde U+FFFD'ye
kaybeder. Hiçbir katman hata vermez, çünkü offset aritmetiği kendi içinde tutarlı kalır.

Veri okuyucusu satırı **ve satırdan sonraki artık baytları** döndürür; kopyalama döngüsü artığı ilk
`read(2)`'sinden önce dosyaya yazar.

### Kayıt defteri dosyaya göre anahtarlanır, jetona göre değil

Tek kullanımlılık jetonun değil **dosyanın** özelliğidir. Bugünkü kayıt defteri yalnız jetonla
anahtarlı olduğu için aynı dosyayı adlandıran iki canlı transferi göremiyor. Ve `claim` girdiyi
tamamen düşürdüğü için, ilk bayttan sonuncusuna kadar ajanın elinde dosyanın **uçuşta olduğuna**
dair hiçbir kayıt yok — o pencerede gelen bir `PublishTransfer`, hâlâ yazılmakta olan bir dosyayı
`renameat2` ile kullanıcının ağacına taşır. Atomik yayınlamanın var olma sebebi tam olarak budur.

Bu yüzden: `(share, staging_name)` anahtarı, ayrı bir **uçuşta** durumu, `Drop` ile temizlenen bir
koruma nesnesi, ve **sert bir üst sınır**. Her girdi root'un tuttuğu bir tanımlayıcı; sınırsız bir
`HashMap` demek, bir saniyeden kısa sürede ~1000 `OpenTransfer` ile `RLIMIT_NOFILE`'ı tüketip
**kontrol soketini de** düşürmek demek.

### Veri soketinde de `SO_PEERCRED`

Birim dosyasının `0660` DAC'ı **tek kapı değil**. ADR-0006'nın bütün argümanı iki kapı olmasıdır,
çünkü DAC tek başına root'u API'den ayırt edemez — ve `authz` kasten uid 0'ı reddeder ki ayrıcalıklı
çağrılar atfedilebilir kalsın. İkinci sokette peercred kontrolü olmazsa o ret bir deliğe dönüşür, ve
`depsis-worker.service` (`User=depsis-api`) API'den ayırt edilemez.

Sıra önemli: **peer → yetki → bildirim → kayıt defteri**. Reddedilen bir eş, çıkarken canlı bir
jetonu yakamaz.

### İki farklı zaman disiplini, ve nedeni yazılı

- **Bildirim:** birkaç saniyelik **mutlak son tarih** + 256 baytlık sınır.
- **Akış:** her okumadan önce yeniden kurulan sabit bir **boşta kalma** bütçesi (30 sn).

İkisinin de bariz uygulaması yanlıştır. Kontrol kanalının mutlak bütçesini kopyalamak her meşru
büyük yüklemeyi 30 saniyede öldürür (10 GB @ 100 MB/s = 100 sn). Düz `set_read_timeout` ise P1-D'nin
düzelttiği hatayı birebir geri getirir: `SO_RCVTIMEO` tek bir `recv(2)`'yi sınırlar, yani 29 saniyede
bir bayt gönderen bir eş pencereyi süresiz yeniler — bu kez tek bağlantı yerine N bağlantıda.

Toplam bir son tarihe gerek yok: bildirilen `length` transferi yapısı gereği sınırlar.

### Hatalar makine tarafından okunabilir olmalı

ADR-0008, `refquota` tükendiğinde tus katmanının **507** dönmesini şart koşuyor (P0-G `EDQUOT`
ölçtü). Ajanın elindeki tek yapısal kanal `Response::Failed { reason: String }` — yani
`std::io::Error`'ın yerel ayara ve çekirdeğe bağlı `strerror` metni. ADR'nin gereğine ulaşmak,
bir güven sınırının yanlış tarafında `"Disk quota exceeded"` dizgisini eşleştirmek demek olurdu; ve
eşleşme tutmadığı gün istemci 500 görür, geçici sanır, aynı parçayı aynı dolu dataset'e sonsuza
kadar yeniden dener.

`Response::Failed` bir `kind` alanı kazanır: `out_of_space` | `io` | `refused`, `raw_os_error()`
üzerinden `ENOSPC`/`EDQUOT` eşleştirilerek. ZFS'te bu koşul `write` yerine `fsync`'te yüzeye
çıkabilir — muhasebe txg commit'inde yapılır — yani `fsync` dalı da sınıflandırmak zorunda.

### Ajan kısaltabilmeli ve silebilmeli

Bugün hiçbiri mümkün değil, ve bu bir çıkmaz: tus'un checksum uzantısı bir parçanın digest'inin
**yazıldıktan ve fsync'lendikten sonra** başarısız olmasına izin verir, ama kapalı işlem kümesinde
geri alma yok. API de düzeltemez — bir paylaşımın içine hiç yazamaz. Yani her başarısız parça, her
kesilmiş akış ve her `EDQUOT` **kalıcıdır**.

Aynı çıkmaz terk edilmiş dosyaları da kapsar: `.depsis/staging` kullanıcının `refquota`'sına sayılır,
Samba `/.depsis/`'i veto eder ve API listelemesi öneki sunucu tarafında filtreler — yani çöp
kullanıcıya görünmez, kullanıcı silemez, API silemez, ajan silemez. ADR-0008 _"expiration + systemd
timer reaper"_ vaat ediyor; `deploy/systemd/` altında ne bir `.timer` var ne de onu besleyecek bir
operasyon. Dahası `expire_old` durumu **kötüleştiriyor**: `PendingTransfer`'ı düşürüp tanımlayıcıyı
kapatıyor ve dosyayı geride bırakıyor. Bugünkü hâliyle süre dolumu bir temizlik değil, bir **çöp
üreticisi**.

Üç parça: (a) hata ile biten her bağlantı yanıt vermeden önce `ftruncate(fd, start_offset)` yapar,
yani başarısız bir bağlantı dosyayı bulduğu gibi bırakır; (b) `DiscardTransfer` işlemi eklenir —
aynı `openat2` hapsi altında bir `unlinkat`, ve isim uçuştayken reddedilir; (c) süpürme **ajanda**
koşar, harici bir zamanlayıcıda değil, çünkü hem paylaşım kök fd'sini hem kayıt defterini tutan tek
bileşen odur — mtime'a bakan harici bir toplayıcı "eski" ile "eski ama şu anda akmakta" arasını
ayırt edemez ve eninde sonunda canlı bir yüklemeyi siler.

**Üçü de uygulandı** (`data.rs`'te `rollback`, `dispatch::discard_transfer`, `sweep.rs`). İki şey
uygulama sırasında karara dönüştü ve burada duruyor:

`DiscardTransfer` bekleyen bir transferi de **iptal eder**, sadece dosyayı silmez. Aksi hâlde
vazgeçen bir API'nin geri dönüşü yoktu: isim `TRANSFER_TTL` boyunca rezerve kalır ve rezerveyken
dosya silinemez, yani iptal edilen her yüklemeden sonra beş dakika o ad kullanılamaz. Bu, ergeç
kilidi kaldırarak "düzeltilecek" cinsten bir davranış. AKAN bir transfer buradan iptal edilmiyor:
kaydı canlı bir veri bağlantısının altından çekmek, dosyanın bir işçi hâlâ ona eklerken silinmesine
izin verir ve işçi bağlantısı kesilmiş bir inode'a yazmaya devam edip `stored` bildirir.

Süpürme yaşı bir yapılandırma (`DEPSIS_STAGING_MAX_AGE_HOURS`, varsayılan 24 saat), ve **onu
güvenli kılan sayı API'de**: API'nin tus istemcilerine ilan ettiği yükleme ömründen uzun olmak
zorunda. API 48 saat diyor ve bu 24'e ayarlıysa, ajan API'nin saklamaya söz verdiği yüklemeleri
siler ve istemcinin bir sonraki PATCH'i artık var olmayan bir dosyaya devam etmeye çalışır. Bu
bağlanma ajanın içinden doğrulanamıyor; doğrulanabilen tek şey, hangi politika altında olursa olsun
yanlış olacak kadar kısa bir değerin reddedilmesi (`MIN_MAX_AGE`, `TRANSFER_TTL`'in çok üstünde),
ve bu yapılıyor. Gerisi burada yazılı duruyor.

Ayrıca süpürücü, kök daemon'da dosya silen tek döngü olduğu için **her silmeyi tek tek günlüğe
yazıyor** ve her dosya için kayıt defterine YENİDEN soruyor — listeleme ile silme arasında bir veri
bağlantısı başlayabilir, ve tam o pencere canlı bir yüklemenin yok edileceği yer.

### `fsync`'in bir hata dalı olmalı

Linux geri yazma hatalarını dosya tanımı başına **bir kez** raporlar (errseq): kirli sayfalar çoktan
gitmiş olabilir ve aynı tanımlayıcı üzerinde ikinci bir `fsync` hiçbir şey yazmadan başarı
döndürebilir. Loglayıp devam etmek, ortası hayatta kalanlardan ibaret bir dosyayı kullanıcının
ağacına taşıyıp başarı bildirmek demektir.

Hata durumunda: `ftruncate` ile bağlantının başlangıç offset'ine dön, ve tipli bir hata döndür —
asla başarı, asla aynı tanımlayıcı üzerinde sessiz bir yeniden deneme.

### `PublishTransfer` bir beklenen boyut alır ve uçuştakini reddeder

Bugün beklenen bir boyut almıyor ve uçuş durumuna bakmıyor, yani doğruluğu tamamen API'nin
yüklemenin bittiğine karar vermiş olmasına dayanıyor — ADR-0006'nın tehdit modelinin ajanın
**yapmaması gerektiğini** söylediği tek varsayım. %90'da ölen bir istemci artı hatalı ya da ele
geçirilmiş bir API, kısa bir dosyanın kullanıcının seçtiği ada taşınması demek; ve yayınlama
`RENAME_NOREPLACE` kullandığı için **iyi kopya bir daha asla üstüne yazılamaz**. "Yayınlama
kullanıcının sahip olduğu bir dosyayı yok etmez" kuralı, adı kalıcı olarak bozuk olana vermiş olur.

### Eşzamanlılığın bir tavanı olmalı

Bağlantı başına iş parçacığı, `depsis-agent.socket`'in `Accept=no` yorumunun bir katman aşağıda
reddettiği şeyi geri getirir: _"bağlantı hızını, asla bir hizmet reddi hedefi olmaması gereken tek
daemon üzerinde süreç sayısına çevirmek."_ Sabit bir havuz, sınırlı bir `mpsc` kanalı, ve tavan
aşıldığında **kabul et, tek satırlık bir ret yaz, kapat** — kabul edip park etmek asla, çünkü bir
tanımlayıcıya mal olur ve istemciye hiçbir şey söylemez.

Bunun bir önkoşulu var: `Agent`'ın paylaşılan tipleri bugün `Sync` **değil** (`&'a dyn TokenSource`
çıplak bir trait nesnesi; `Sink`'in `Sync` sınırı yok ve `MemorySink` `RefCell` üzerine kurulu). Veri
döngüsünü ilk yazan kişi bir derleyici hatası duvarına çarpar, ve en az direnç gösteren yol
**denetimi atmaktır**. Tipleri önce düzeltmek, derleyicinin veri kanalının denetlenebilir olduğunu
zorlamasını sağlar.

### systemd tesisatı isimle eşlenir

`listener_from_systemd` bugün `LISTEN_FDS != 1` olduğunda reddediyor ve tasarımın kullanmak
istediği değişkeni — `LISTEN_FDNAMES` — okunmadan önce siliyor. fd sırasına göre eşleme
denetlenemez: iki soket de `0660 root:depsis-api` taşır, yani roller yer değiştirirse eşzamanlı ve
yalnız-jeton işleyici, herkesin peercred kapılı kontrol kanalı sandığı sokete oturur ve DAC hiçbir
şey yakalamaz.

`FileDescriptorName=` ile isim bazlı eşleme, eksik/tekrarlı/bilinmeyen/fazla isimde **kapalı
başarısızlık**.

Ve `RuntimeDirectory=` **tek bir birimde** bildirilir. İkinci `.socket` birimi mevcut olandan
kopyalanırsa `RuntimeDirectory=depsis` ve `RemoveOnStop=yes`'i miras alır; o zaman birimlerden
birini durdurmak `/run/depsis`'i siler ve **diğerinin canlı soket dosyasını** kaldırır, systemd her
ikisini de sağlıklı raporlarken. Bu, P1-D'nin bu dağıtımda zaten bulduğu hata sınıfı: systemd'nin
kabul ettiği ama dosyanın söylediğinden başka bir şey ifade eden bir direktif.

### Denetim

Veri bağlantısı başına **bir** giriş, `correlation_id` ve `reason` kayıt defterinden alınarak — veri
telinden **asla**. Kontrol kanalındaki her çağrı `parse → authorize → audit(intent) → execute →
audit(outcome)` sırasını izliyor; veri kanalı denetlemezse, journal `open_transfer` ile
`publish_transfer`'ı gösterir ve baytları kimin yazdığı hakkında hiçbir şey söylemez. §16'nın
gereği, iki ucuz operasyon için tutar ve **root olarak kullanıcı verisi yazan** tek operasyon için
düşer.

Veri teli yalnız bildirim-sonra-bayt kalır: oraya bir korelasyon kimliği kabul etmek, yetkisiz
tarafın kendi denetim üstverisini yazmasına izin vermek olurdu.

## Ölçüldü

`tools/poc/` altındaki ölçümlerden ayrı olarak, bu tasarımın **istemci yarısı** gerçek AF_UNIX
üzerinde ölçüldü (Debian 13 / WSL2, Node 24.19.0), 12 assertion, sıfır hata:

| İddia                                                           | Sonuç                                   |
| --------------------------------------------------------------- | --------------------------------------- |
| Satır yaz → ham bayt akıt → yanıt oku, Node'dan yapılabiliyor   | ✅                                      |
| Bildirimle **aynı pakette** gelen yük baytları kaybolmuyor      | ✅ (sunucunun artığı işlemesi şartıyla) |
| İki pakete bölünmüş bildirim doğru çerçeveleniyor               | ✅                                      |
| 128 MiB akış bütün geliyor                                      | ✅ 409 MiB/s                            |
| Ölen bir istemci, düzgün yarı-kapatmadan **ayırt edilebiliyor** | ✅ `end` olayı üretilmiyor              |
| Kaybolan son yanıt istemciye görünüyor                          | ✅                                      |
| 32 eşzamanlı yükleme                                            | ✅ hepsi tamamlandı                     |

### Uygulandıktan sonra ölçülenler

Yukarıdaki tablo tasarımı ölçüyordu. Bunlar, kodu ve birim dosyalarını gerçek systemd altında
(pid 1 olarak systemd 257, Debian 13) çalıştırınca çıkanlar.

**`RestrictSUIDSGID=yes`, `openat2(2)`'yi tamamen kapatıyor.** Bu ADR'nin dayandığı bütün
sınırlandırma mekanizması o çağrı. systemd bu direktifi, dosya yaratan her sistem çağrısının mod
argümanını süzen bir seccomp filtresiyle uyguluyor; `openat2`'de mod kullanıcı alanındaki bir
`struct open_how`'un içinde duruyor ve seccomp işaretçiyi çözemediği için çağrıyı setuid dosya
riskine girmektense komple reddediyor. Sonuç: her yükleme başarısız.

Bunu bulmayı zorlaştıran şey benim kendi hata eşlemem oldu. `openat2`'den dönen her `errno`
`SeamError::PathEscape`'e çevriliyordu, yani ENOSYS **"path escapes the share root:
alice/.depsis/staging/probe.part"** diye rapor ediliyordu — hiçbir yerden kaçmayan bir yol için bir
sınırlandırma ihlali. Sebebi bulmak birim dosyasını direktif direktif ikiye bölmeyi gerektirdi.

İki taraf da düzeltildi:

- `depsis-agent.service`'ten `RestrictSUIDSGID` kaldırıldı, neyin verildiği ve neyin karşıladığı
  dosyaya yazıldı: ajan dosyayı tek bir yerde, `OpenIntent`'ten türeyen sabit 0600 moduyla yaratıyor
  ve çağıran mod diye bir işlenen ifade edemiyor.
- `Openat2SafePath::open_root` artık başlangıçta bir kez `.`'yi çözerek `openat2`'nin gerçekten
  çalıştığını **kanıtlıyor**. Çalışmıyorsa servis hiç ayağa kalkmıyor. Aksi hâlde ajan kendini sağlıklı
  ilan ederken her yükleme tek tek bir sınırlandırma hatasıyla düşüyor.

**Yarım soket kümesi, birim grafiği üzerinden ulaşılamaz.** P1-D'ye önce "yalnız kontrol soketi
başlatılırsa ajan reddetmeli" diye bir test yazdım; ajan yine de başladı ve test düştü. Sebep
`depsis-agent.service`'in kendi `Requires=depsis-agent.socket depsis-agent-data.socket` satırı:
servisi tetiklemek veri soketini bağımlılık olarak çekiyor. Ajanın fail-closed kontrolü yanlış
değil, ama systemd'nin garantisi ondan önce devreye giriyor. Test ikiye ayrıldı — birincisi
`Requires=`'in gerçekten çalıştığını ölçüyor, ikincisi ajanın kendi reddini `systemd-socket-activate
--fdname=control` ile, birim grafiğinin dışında ölçüyor.

**`serve`'deki peer→kayıt sıralaması güvenliği değil atfı sağlıyor.** Yorumu "aksi hâlde yetkisiz
biri başkasının canlı jetonunu yakardı" diye yazmıştım; bir mutasyon testi bunu yalanladı.
`TransferRegistry::claim` uyuşmayan uid'i zaten reddedip kaydı geri koyuyor, dolayısıyla peer
kontrolünü tamamen silmek hiçbir yüklemeyi kaybettirmiyor. Kontrolün kazandırdığı gerçek şey daha
küçük ve yine de değerli: API olmayan bir süreç önsöz ayrıştırıcısına ve kayıt defterine hiç
ulaşamadan reddediliyor, ve günlüğe "jeton hatası" değil "yetkisiz çağıran" olarak geçiyor.

**Ölçülmemiş, ve tasarım kararı olarak duruyor:** ZFS `refquota` altında `EDQUOT`'un `write`'ta mı
`fsync`'te mi yüzeye çıktığı (P0-G `EDQUOT`'u ölçtü ama hangi çağrıda olduğunu değil), ve gerçek bir
`RENAME_NOREPLACE`'in uçuştaki bir dosya üzerindeki davranışı. İkisi de Debian VM'e ait.

## Elenenler

Bir sonraki okuyanın aynı tartışmaları yeniden açmaması için, **reddedilenler de gerekçesiyle**
kayıtlı:

| İddia                                                                | Neden elendi                                                                                                                                                                           |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claim`'in doğrulamadan önce jetonu kaldırması bir açıktır           | Dört açıdan üçü bu sıralamayı **sağlam** buldu; bak-sonra-kaldır bir sıralama sorununu düzeltmek için bir yarış koşulu geri getirir. Asıl zarar, sıra (peer→yetki→kayıt) ile kapanıyor |
| `expire_old`'un O(N) süpürmesi seri kontrol döngüsünü bekletir       | 64 girdilik tavandan sonra teorik: en fazla 64 karşılaştırma, çağrı hızı "dakikada birkaç" olan bir kutuda                                                                             |
| systemd'nin `RuntimeDirectory=`'yi iki birimde sayıp saymadığını ölç | Ölçüm düzeltmeden pahalı, ve düzeltme her iki cevapta da doğru                                                                                                                         |
| Veri kanalına bir taban hız üzerinden toplam son tarih koy           | Bildirilen `length` transferi yapısı gereği sınırlıyor; ikinci bir sınır yalnız ADSL'deki dürüst bir istemciyi öldürmenin ikinci bir yolu olur                                         |
| Havuzun boş alanı bir rezervin altındaysa `OpenTransfer`'ı reddet    | Her yükleme açılışının sıcak yoluna root daemon'da bir alt süreç koyar, ve `refquota` ile bildirilen `length` bunu zaten iki katmanda karşılıyor                                       |
| `HashMap::remove` üzerinden zamanlama yan kanalı                     | Yerel AF_UNIX üzerinde 256 bitlik `getrandom` entropisi. Bunu **ortaya atan açı kendisi reddetti**; uydurulmamış bir bulguyu reddetmek doğru karardı ve yeniden açılmamalı             |

## Sonuçlar

Yetkisiz API bir paylaşımın içine hâlâ **yazamıyor**: bir yol adlandıramıyor, bir tanımlayıcı
tutmuyor, ve gönderdiği baytlar ancak ajanın kendi çözüp açtığı bir nesneye gidiyor. TB4 olduğu gibi
duruyor.

Bedeli, ajanın artık eşzamanlı olması. Seri bir daemon için doğru olan üç davranış — zehirlenmiş
mutex'te kalıcı ret, geçici `errno`'da çıkış, tavansız kayıt defteri — N iş parçacığıyla birer hata
moduna dönüşüyor. Üçü de kapatıldı (commit `3e2386a`), ama bu, eşzamanlılığın ücretsiz olmadığının
kaydı olarak burada duruyor.

## Geri alma maliyeti

Orta. Veri soketi ayrı bir birim ve ayrı bir modül; kaldırılırsa `OpenTransfer`/`PublishTransfer`
kullanılamaz hâle gelir ama başka hiçbir şey bozulmaz. Asıl bağlanma noktası `Agent`'ın `Sync`
tiplerine geçişi — o, geri alınırsa denetimi de geri alır.

## Güvenlik ve veri kaybı etkisi

Bu ADR ayrıcalık sınırını **genişletmiyor**: ajan zaten root, ve API zaten hangi paylaşımı
adlandıracağını seçebiliyordu. Değişen şey, kullanıcı verisi yazan yolun ilk kez var olması — ve
bu yüzden §16'nın denetim gereği ile ADR-0008'in dayanıklılık sırası, tasarımın merkezinde duruyor,
kenarında değil.

Yeni veri kaybı riski: bildirilen `length` ile gerçek akış arasında bir uyuşmazlık, ya da
`ftruncate` geri alma yolunun eksik uygulanması. İkisi de testle sabitlenecek.
