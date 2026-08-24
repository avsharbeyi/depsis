# DEPSIS — Yönetici Kılavuzu

Bu belge, DEPSIS çalıştıran bir cihazı **kuran ve işleten** kişi içindir. Dosyalarını DEPSIS'te
tutan kişi için [Son Kullanıcı Kılavuzu](02-son-kullanici-kilavuzu.md) var.

Yedekleme ve kurtarma ayrı iki belge:
[Yedekleme](03-yedekleme.md) ve [Felaket Kurtarma](04-felaket-kurtarma.md).

> Bu kılavuzdaki her komut ve her dosya adı depodaki gerçek karşılığına bakılarak yazıldı. Bir
> şey burada yazdığı gibi çalışmıyorsa, kılavuz yanlıştır — kod değil. Öyle bir durumda
> `README.md`'nin "Eksikler" bölümüne bakın: bilinen boşluklar orada, isimleriyle duruyor.

---

## 1. Cihaz neyden oluşuyor

Dört süreç, üç güven sınırı.

| Birim            | Kim olarak çalışır | Ne yapar                                                                                                              |
| ---------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `depsis-agent`   | **root**           | Ayrıcalıklı işler: ZFS, POSIX ACL, Samba yapılandırması, dosya baytları. Kapalı ve tipli bir işlem kümesi (ADR-0006). |
| `depsis-api`     | `depsis-api`       | HTTP, oturumlar, izin kararları, web arayüzü. Hiçbir ayrıcalığı yok.                                                  |
| `depsis-worker`  | `depsis-api`       | Arka plan işleri: izin uygulama, kimlik senkronu, kopyalama, çöp temizleme, indeksleme.                               |
| `depsis-console` | root (soket)       | Yönetici konsolu. Yalnız yönetici, yalnız parola onayıyla.                                                            |

Ajan **soketle** başlatılır (`depsis-agent.socket` ve `depsis-agent-data.socket`), boot'ta değil.
İkisi de gerekli: yalnız kontrol soketiyle başlayan bir ajan yükleme jetonu üretir ve gelemeyecek
veri bağlantılarını bekler — her yükleme beş dakika sonra zaman aşımına uğrar ve ağ hatası gibi
görünür. Ajan bunu kendi de reddediyor.

API ajansız da **çalışır**: giriş yapılır, arayüz açılır, depolamaya dokunan uçlar 503 döner ve
sebebini söyler. `depsis-api.service` bu yüzden ajanı `Wants=` ile ister, `Requires=` ile değil —
bir depolama arızası, teşhis için gereken giriş ekranını da götürmemeli.

---

## 2. Kurulum

### 2.1 Gerekenler

- Debian 13 (trixie) veya dengi, **Linux 5.6+** (`openat2` için — daha eskisinde ajan başlamaz)
- **PostgreSQL 18+** (`uuidv7()` şart)
- ZFS 2.2+
- Samba 4.22+ (isteğe bağlı; yoksa `/shares` `smbAvailable: false` der)
- Node.js 24+

### 2.2 Veritabanı

`packages/db/bootstrap.sql` veritabanını, üç rolü ve şemanın adıyla kontrol ettiği iki uzantıyı
(`unaccent`, `pg_trgm`) yaratır. Göçler bu ikisi olmadan çalışmayı reddeder.

```bash
psql -X -v ON_ERROR_STOP=1 -v db_name=depsis -f packages/db/bootstrap.sql
```

Üç rol ve neden üç tane:

| Rol             | Ne için                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `depsis_owner`  | Yalnız göçler. Şemayı bu yaratır.                                                                       |
| `depsis_app`    | API ve worker. RLS **buna** uygulanır.                                                                  |
| `depsis_backup` | Yalnız okuma, ve her şeyi değil — parola özeti, TOTP sırrı, NT hash ve oturum satırları bu role kapalı. |

Göçler **owner** olarak koşar, superuser olarak değil. Superuser satır seviyesi güvenliği sessizce
atlar; yalnız superuser tarafından yaratıldığı için çalışan bir şema burada geçer ve üretimde
çöker.

```bash
cd packages/db
DEPSIS_MIGRATION_DATABASE_URL="postgresql://depsis_owner:PAROLA@127.0.0.1:5432/depsis" \
  npx node-pg-migrate -d DEPSIS_MIGRATION_DATABASE_URL -m migrations -t depsis_migrations \
    --advisory-lock-mode wait --no-single-transaction up
```

### 2.3 Sırlar

İki dosya, ikisi de `/etc/depsis/` altında, ikisi de root'un ve `0400`:

```bash
install -d -m 0750 /etc/depsis
printf 'postgresql://depsis_app:PAROLA@127.0.0.1:5432/depsis' > /etc/depsis/db-url
openssl rand -base64 32 > /etc/depsis/secret.key
chmod 0400 /etc/depsis/db-url /etc/depsis/secret.key
```

`secret.key` **kritik**. TOTP sırlarını ve SMB NT hash'lerini mühürleyen anahtar bu (ADR-0016).
Kaybederseniz iki adımlı doğrulama kayıtları ve SMB parolaları geri gelmez — veritabanı yedeği
tek başına yetmez. [Yedekleme](03-yedekleme.md) bunu ayrıca anlatıyor.

Anahtar yoksa API başlar ama günlüğe uyarı yazar ve **ikinci faktör kaydını ve SMB kimlik bilgisi
saklamayı reddeder**. Sessizce düz metin yazmaz.

İkisi de sistemd **credential**'ı olarak veriliyor, ortam değişkeni olarak değil: ortam değişkeni
aynı kullanıcı olarak koşan her şey tarafından `/proc/<pid>/environ` üzerinden okunur, her alt
sürece miras kalır ve çökme raporlarına düşer.

### 2.4 Yapılandırma

`/etc/depsis/api.env` — sır olmayan her şey:

```ini
DEPSIS_API_PORT=3000
DEPSIS_AGENT_SOCKET=/run/depsis/agent.sock
DEPSIS_AGENT_DATA_SOCKET=/run/depsis/agent-data.sock
DEPSIS_CONSOLE_SOCKET=/run/depsis/console.sock
# Explorer'a yazılacak sunucu adı. Kutunun kendi hostname'i DEĞİL: yalnız `nas.ev` olarak
# erişilebilen bir cihaz `\\depsis\...` reklamı yapmamalı.
DEPSIS_SMB_HOST=depsis
DEPSIS_SHARE_PARENT_DATASET=tank/depsis
DEPSIS_ZFS_POOLS=tank
# İSTEĞE BAĞLI, ve boş bırakmak artık doğru cevap: DEPSIS kutuya kendisi soruyor ve
# çıkarılabilir olmayan her diski izliyor (Diskler ekranı, §3.8). Yalnız BİR ALT KÜMEYİ izlemek
# isterseniz burada adlandırın.
#
# Değerler `/dev/disk/by-id` ADLARIDIR, `/dev/sdX` DEĞİL. Ajan bu operandı o dizin altında tek
# bir bileşen olarak tipliyor ve içinde `/` geçen bir değeri yapı gereği reddediyor — `sdb`
# yeniden başlatmada başka bir fiziksel diski gösterebilir (risk R1). Doğru adları Diskler
# ekranından kopyalayın.
# DEPSIS_SMART_DISKS=ata-Samsung_SSD_860_S3Z8NB0K,ata-WDC_WD40EFRX_WD-WCC4E123
```

Bu dosyayı **hem API hem worker** okuyor, ve bu bilerek böyle: buradaki her ayar — ajan soketleri,
paylaşım kökü, üst veri kümesi — iki süreçte de AYNI şeyi göstermek zorunda. Worker'ın yazdığı
dosyaları API sunuyor. İki ayrı dosya olsaydı, birinde `DEPSIS_SHARES_ROOT` değiştirip ikisini de
yeniden başlatmak, worker'ı API'nin sunmadığı bir ağaca indeksleme yapar hâle getirirdi — hata
vermeden. `DEPSIS_API_PORT` worker'da yok sayılıyor; o süreç hiçbir port açmıyor.

`/etc/depsis/worker.env` — **isteğe bağlı**, ve yalnız worker'a ait olan tek ayar:

```ini
# ADR-0011 Katman 1: Samba denetim akışının dosyası (§3.7). Varsayılanı budur; dosya yoksa da
# worker açılır, yalnız SMB yazmalarını on beş dakikalık yürüyüşle indeksler.
DEPSIS_SMB_AUDIT_LOG=/var/log/depsis/smb-audit.log
```

`/etc/depsis/agent.env` — ajanın tek zorunlu ayarı:

```ini
# API'nin koştuğu uid. ÇALIŞMA ZAMANINDA ADA BAKILMIYOR: bir yeniden adlandırma ya da uid
# yeniden kullanımı, ayrıcalıklı işlemleri kimin sürebileceğini sessizce değiştirirdi.
DEPSIS_API_UID=1001
DEPSIS_SHARES_ROOT=/srv/depsis
DEPSIS_SAMBA_CONFIG=/etc/samba/depsis.conf
```

Ajan `DEPSIS_API_UID` olmadan **başlamaz**, ve uid 0'ı reddeder.

### 2.5 Birimler

```bash
cp deploy/systemd/*.service deploy/systemd/*.socket /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now depsis-agent.socket depsis-agent-data.socket
systemctl enable --now depsis-api.service depsis-worker.service
```

`depsis-agent.service` **enable edilmez** — soketi tarafından, talep üzerine başlatılır. Doğrudan
etkinleştirmek, API var olsun olmasın boot'ta bir root daemon başlatmak demek olurdu.

### 2.6 Samba

DEPSIS `smb.conf`'u **yazmaz**. O dosya operatörün ve DEPSIS'in bilmediği ayarları içerir.
Yazdığı `depsis.conf`, ve `smb.conf`'un tek satıra ihtiyacı var:

```ini
include = /etc/samba/depsis.conf
```

Bu satır olmadan smbd hiçbir DEPSIS paylaşımı sunmaz — ve DEPSIS yayımlamayı **reddeder**, var
olmayan paylaşımları var gibi göstermek yerine.

### 2.7 Sahiplenme

API kurulum bekliyorken **her açılışta** journal'a tek kullanımlık bir talep belirteci basar:

```bash
journalctl -u depsis-api -n 50
```

Belirteci web arayüzündeki kurulum sihirbazına girin, ilk yöneticiyi yaratın. Belirteç her
açılışta yenilenir — eski bir journal'dan toplanan belirteç ölüdür — ve kurulum bitince hiçbir şey
ifade etmez.

Kurulum tamamlandıktan sonra `/setup/claim` kalıcı olarak **410** döner.

---

## 3. Günlük işler

### 3.1 Hesaplar

**Kullanıcılar** panelinde. Bir hesap açmak parolayı orada belirlemenizi ister; bu, o parolanın
SMB NT hash'inin hesaplanabildiği **tek an**ıdır (argon2 tek yönlü).

**Parola sıfırlama.** Yönetici parolayı belirlemez. "Parolayı sıfırla" tek kullanımlık bir anahtar
üretir; onu kullanıcıya elden verirsiniz, parolayı kendisi yazar. Bu taklidi imkânsız kılmaz — bir
NAS'ın yöneticisi zaten root eşdeğeri — ama **sessiz** olmaktan çıkarır: anahtar tek kullanımlık,
yani siz kullanırsanız kullanıcının kendi denemesi başarısız olur ve durumu fark eder.

Hesapta iki adımlı doğrulama açıksa anahtar tek başına yetmez; doğrulayıcı kodu da gerekir.

**Son yöneticiyi düşüremezsiniz.** Bunu veritabanı trigger'ı uyguluyor, uygulama değil: iki
yöneticinin birbirini eşzamanlı düşürmesi uygulama seviyesinde sayılamaz.

### 3.2 Ekipler ve izinler

POSIX ACL girdileri **gruplara** verilir, kişilere değil (ADR-0004): ACL'ler otuz girdiyi geçince
kullanışsızlaşıyor. Yani erişimin bir avuç kullanıcının ötesine ölçeklenme yolu **ekip**.

Bir ekip "dosya sistemine yansımadı" etiketiyle görünüyorsa, `posix_gid`'i yok: o ekibe verilen
izin veritabanında gerçek, SMB'de yok. Bu bir hata değil bir durum, ve arayüz söylüyor.

**İzin paneli** her değişikliği kaydetmeden önce fiyatlıyor: kaç klasör etkilenir, kim erişim
kazanır, kim kaybeder. Miras yüzünden yarıçapı tahmin etmek imkânsız — buradan kaldırılan bir
satır, bu ekranın hiç adlandırmadığı insanlar için birkaç seviye aşağıdaki klasörleri kapatabilir.

Kaydettikten sonra arayüz iki şeyden birini söyler:

- _"İzinler kaydedildi ve dosya sistemine uygulanıyor."_ — bir iş kuyruğa girdi.
- _"...Dosya sistemine henüz yazılamadı — ajana ulaşılamıyor."_ — izin veritabanında geçerli,
  **diskte değil.** Web'de kapalı görünen klasör SMB'den açık olabilir.

İkinci durumu **Sistem işleri** panosundan takip edin.

### 3.3 Paylaşımlar

`POST /shares` bir dataset açar. Havuzu **operatör kurar** — ajan havuz yaratamaz ve ADR-0007
yıkıcı havuz işlemlerini üründen dışarıda tutuyor.

Paylaşım açmak onu yayımlamaz. **Paylaşımlar → Yayımla** `smb.conf` tarafını yazar, ve yazdığını
kanıtlar: `testparm`'dan sonra gerçek bir bağlantı denemesi yapar. Kanıtlanamayan bir yayım geri
alınır ve reddedilir.

> Bu adım kozmetik değil. P0-B'de ölçüldü: geçersiz bir `full_audit` opname'i `testparm`'dan temiz
> geçer ve smbd'nin **her bağlantıyı** reddetmesine yol açar. `testparm` bu hata sınıfı için
> yeterli bir kapı değil.

`published: false` gördüğünüzde paylaşım veritabanında var, smbd sunmuyor demektir. Bu liste
yeniden başlatmada temizlenir: DEPSIS smbd'ye ne sunduğunu soramaz, o yüzden bilmediğini iddia
etmez.

### 3.4 Sistem işleri

Pano **vazgeçilenlerle** açılır, ve sebebi şu: ölü bir `permissions.apply`, veritabanında
uygulanmış ama dosya sistemine hiç yazılmamış bir izin demek. Her şeyle açılsaydı, bir insana
ihtiyacı olan dört satır ihtiyacı olmayan dört yüzün altında kalırdı.

Bir iş `dead` olduysa deneme bütçesini tüketmiştir. Hata başlığı satırda yazıyor.

### 3.5 Çöp kutusunun saklama süresi

Varsayılan **süresiz sakla**. Açmak bilinçli bir hareket olmalı, ve açtığınız ekran ne kadar
verinin gideceğini söylüyor: kaç öğe, kaç dosya, kaç bayt. Bayt sayısı köklerin değil altlarındaki
**dosyaların** toplamı — bir klasörün kendi boyutu her zaman sıfır.

En az bir gün. Sıfır, çöpe atmanın kalıcı silmeye eşit olması demek olurdu.

Kaydettiğiniz an ilk temizleme kuyruğa girer, sonra saatte bir çalışır.

### 3.6 İndeksleme

SMB'den yazılan dosyalar `files.reconcile` işiyle görünür oluyor: paylaşım başına, on beş dakikada
bir, diski veritabanıyla karşılaştırıyor. Diskte olup satırı olmayan öğrenilir, satırı olup diskte
olmayan unutulur.

**Hiçbir bayt silinmez.** Diskte olmayan bir satır veritabanından kalkar; dosya zaten yok, satırın
kalkma sebebi o.

Beş binden fazla girdisi olan bir klasörün listelemesi kırpılır ve o klasörün altında **hiçbir şey
silinmez** — yarım bir dizini uzlaştırıp kalan satırları silmek, tek suçu büyük olmak olan bir
klasörün indeksini yok ederdi. Böyle bir durumda worker günlüğüne uyarı düşer.

### 3.7 SMB olay akışı — hızlı indeksleme (isteğe bağlı)

§3.6'daki mutabakat doğru ama on beş dakikalık. Samba, bir istemci bir şeyi değiştirdiği anda
söyleyebiliyor; DEPSIS'in ürettiği her paylaşım bölümü zaten bunu istiyor:

```ini
vfs objects = full_audit
full_audit:prefix = %u|%I|%S
full_audit:success = create_file renameat unlinkat mkdirat close ftruncate linkat symlinkat
full_audit:failure = none
full_audit:facility = local5
full_audit:priority = notice
```

Eksik olan tek şey, o satırları worker'ın okuyabileceği bir dosyaya yönlendirmek:

```bash
install -d -m 0750 -o root -g depsis-api /var/log/depsis
cp deploy/rsyslog/depsis-smb-audit.conf /etc/rsyslog.d/49-depsis-smb-audit.conf
cp deploy/logrotate/depsis-smb-audit    /etc/logrotate.d/depsis-smb-audit
systemctl restart rsyslog
systemctl restart depsis-worker
```

Bunu yapmazsanız ürün **çalışmaya devam eder** — yalnız SMB yazmaları on beş dakikalık yürüyüşle
indekslenir. Worker açılışta bunu bir kez söylüyor:

> `/var/log/depsis/smb-audit.log does not exist: SMB writes will be indexed by the periodic walk
only.`

#### Bunu doğrulayın

Bu adımın çalıştığını **kanıtlayan** tek dizi:

```bash
# 1. Satırlar akıyor mu? Windows'tan bir dosya kaydedin, sonra:
tail -f /var/log/depsis/smb-audit.log
#    Beklenen biçim:  ... smbd_audit: kullanıcı|10.0.0.5|paylaşım|close|ok|klasor/dosya.txt

# 2. Kuyruğa düşüyor mu?
psql -d depsis -c 'SELECT share_id, path, actor, seen_at FROM index_queue ORDER BY seen_at DESC LIMIT 5'

# 3. Boşalıyor mu? Birkaç saniye içinde satır gitmeli, ve dosya web arayüzünde görünmeli.
journalctl -u depsis-worker -f | grep 'smb audit'
```

> ⚠ **`full_audit` bir paylaşımı tamamen erişilemez yapabilir.** Samba'nın bilmediği bir opname,
> "denetim çalışmaz" demek değil: smbd **bağlantıyı reddeder**, ve `testparm` bunu yakalamaz —
> liste yalnız bağlantı anında doğrulanıyor. P0-B bunu `rmdir` ile ölçtü (Samba 4.22'de böyle bir
> opname yok; dizin silme `unlinkat` üzerinden gider).
>
> Bu yüzden yayım `testparm`'dan sonra **gerçek bir bağlantı denemesi** yapıyor ve
> kanıtlayamadığında geri alıyor. Yukarıdaki listeye elle bir ad eklemeyin; ajanın testleri o
> listeyi tam eşleşmeyle sabitliyor, tam da bu yüzden.

### 3.8 Diskler

**Diskler** ekranı (yalnız yöneticiye) kutuda fiziksel olarak ne olduğunu gösteriyor: kararlı ad,
model, seri, WWN, boyut, ve — okunacak asıl sütun — **üstünde ne var**.

`/system/telemetry` farklı bir soruyu cevaplıyor: "bana söylenen diskler nasıl". Bu ekran "kutuda
ne var" diyor, ve ikisi tam da önemli olan durumda ayrışıyor — kimsenin yapılandırmadığı bir disk
birincisine görünmez, ikincisinin ise bütün konusudur.

| Sütun                      | Ne demek                                                                         |
| -------------------------- | -------------------------------------------------------------------------------- |
| **boş**                    | Ajanın bulabildiği hiçbir şey yok. Bir havuza katmanın güvenli olduğu tek durum. |
| bölüm/dosya sistemi adları | Diskte bir şey var. Kullanmak onu yok eder.                                      |
| **bağlı**                  | Bir bölümü şu anda bir yere bağlı.                                               |
| **sistem diski**           | `/`, `/boot` ya da `/boot/efi` burada. **Bu diske dokunmayın.**                  |

Bir diskin **serisi boş görünebilir** ve bu bir arıza değil: SCSI VPD sayfa 0x80 bazı
hipervizörlerde bozuk bilgi veriyor (ADR-0000'de ölçüldü). Kimlik için WWN kullanılır.

§8.1, her yıkıcı depolama işleminden önce etkilenen diskleri seri/WWN ile adlandıran bir analiz
istiyor. Bu ekran o analizdir — ve bilerek, onaylanacak bir şey olmadan önce, kendi başına
duruyor: cihaz hâlâ güvendeyken okunabilen bir envanter, aynı listeyi geçilmeye çalışılan bir
onay kutusunun içinde göstermekten daha değerli.

### 3.9 Konsol

Yalnız yönetici, ve her oturum parola onayı ister. Bir oturum, birinin açık bırakılmış dizüstünü
ödünç alan kişinin sahip olduğu şeydir; kabuk erişimi için yetmez (ADR-0018).

---

## 4. Bir şeyler ters gittiğinde

### 4.1 Önce nereye bakılır

```bash
systemctl status depsis-agent depsis-api depsis-worker
journalctl -u depsis-api -n 100
journalctl -u depsis-agent -o cat -n 100   # ajanın denetim izi: satır başına bir JSON nesnesi
journalctl -u depsis-worker -n 100
```

Her HTTP yanıtı bir `X-Correlation-Id` taşır, ve aynı isteğin her log satırında aynı id vardır. Bir
kullanıcı ekrandaki hatanın id'sini okuyabilir; siz onunla journal'ı arayabilirsiniz.

```bash
journalctl -u depsis-api --grep '<correlation-id>'
```

### 4.2 Sık görülenler

**"Depolama işlemleri 503 dönüyor."** Ajan ulaşılamıyor. Soketleri kontrol edin. Ajan **iki**
soketle başlar; yalnız biri varsa reddeder ve sebebini söyler.

**"Şema sürümü uyuşmuyor."** Ajan ile API farklı sürümlerden. İkisi kilitli adım ilerler
(`SCHEMA_VERSION` / `EXPECTED_SCHEMA_VERSION`) ve uyuşmazlık **açılışta** yakalanır — bir dataset
yaratmanın ortasında değil. İkisini birlikte güncelleyin.

**"Windows paylaşımı görüyor ama giremiyorum."** Üç ayrı kapı var, sırayla:

1. `valid users` — o paylaşımın ağacında adınızın geçtiği bir grant var mı?
2. POSIX ACL — `permissions.apply` işi koştu mu? Sistem işleri panosuna bakın.
3. Samba kimliği — hesabınızın NT hash'i var mı? Parolanız bu özellik geldiğinden beri hiç
   değişmediyse yoktur; bir kez değiştirmek yeter.

**"Klasör web'de kapalı, SMB'den açık."** Neredeyse her zaman ölü bir `permissions.apply`.

**"openat2 unavailable."** Çekirdek 5.6'dan eski, ya da bir seccomp filtresi engelliyor —
`RestrictSUIDSGID=yes` tam olarak bunu yapar ve ajanın unit dosyası neden yok olduğunu uzun uzun
anlatıyor. Ajan artık bu durumda hiç başlamıyor; her aktarımı tek tek başarısız etmek yerine.

**"Yayım başarısız oldu ve önceki yapılandırma geri gelmedi."** Bu, ürünün söylediği en ciddi
cümle: `/etc/samba/depsis.conf` reddedilmiş bir yapılandırma tutuyor ve SMB dosya elle onarılana
kadar kapalı. Dosyayı düzeltin ya da boşaltın, `systemctl reload smbd`, sonra yeniden yayımlayın.

---

## 5. Bilerek yapılmayanlar

Bunlar eksik değil, karar:

- **ZFS havuzu yaratma.** Ajan dataset ve anlık görüntü yaratır, havuz yaratmaz (ADR-0007).
- **Paylaşım silme.** Grant'lar paylaşımı tutuyor (`ON DELETE RESTRICT`) ve son grant'ı silmek de
  reddediliyor: paylaşımı silmek dataset'i silmek demek. Kapatmanın yolu, kimseyi adlandırmayan
  bir kök izni.
- **Özyinelemeli ajan işlemleri.** Ne özyinelemeli silme, ne özyinelemeli kopyalama, ne
  `mkdir -p`. Ağacı API yürür, çünkü ağacı saklayan taraf o — ve hiçbir çağrının yarıçapını
  çağıran seçmemeli (§2.2, ADR-0006).
- **Anlık görüntü listesi havuzun envanteri değil.** Ajanda "listele" işlemi yok, o yüzden
  `/backups` yalnız DEPSIS'in kendi aldıklarını gösterir ve yanıtta `complete: false` ile söyler.

---

## 6. Sürüm yükseltme

1. `depsis-api` ve `depsis-worker`'ı durdurun. Ajanı **durdurmayın** henüz.
2. Veritabanını yedekleyin ([Yedekleme](03-yedekleme.md)).
3. Göçleri owner olarak koşun.
4. Yeni ajan ikilisini koyun, `systemctl restart depsis-agent`.
5. API ve worker'ı başlatın.
6. `journalctl -u depsis-api -n 20` — şema sürümü uyuşmazlığı varsa burada, açılışta görünür.

Göçler geri alınabilir ve bu her sürümde ölçülüyor: `tools/ci/migration-check.sh` en yeni göçü
geri alıp yeniden uyguluyor. Yine de geri almadan önce **yedek alın** — bir göçün geri alınabilir
olması, sildiği verinin geri geleceği anlamına gelmez.
