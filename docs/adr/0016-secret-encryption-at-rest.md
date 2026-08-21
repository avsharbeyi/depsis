# ADR-0016: TOTP sırlarının durağan hâlde şifrelenmesi ve anahtar yönetimi

- **Durum:** Accepted
- **Tarih:** 2026-08-21
- **Faz:** 1
- **Etkilenen bileşenler:** `apps/api/src/auth`, `packages/db/migrations/0006`, `deploy/systemd`

## Bağlam

Migration 0004 TOTP sırrını düz metin sakladı ve bunu **gizlemek yerine yazdı**. Gerekçesi de
sağlamdı: kendi kendine barındırılan bir NAS'ta uygulama, veritabanı ve akla gelebilecek her anahtar
dosyası aynı makinededir; yerel bir anahtarla şifrelemek **ana makine ele geçirilmesine** karşı
neredeyse hiçbir şey satın almaz. Sunduğu karşılık `depsis_backup` rolüne bu tabloyu RLS ile
kapatmaktı, ve şöyle diyordu: _"sırlar durağan hâlde şifreli olmadığı için bu politika işin
tamamını yapıyor."_

Bu ADR o gerekçeyi **kısmen** çürütüyor. Ana makine argümanı hâlâ doğru. İşin tamamını yaptığı
iddiası değil.

**Birinci boşluk — RLS ile filtrelenmiş bir yedek, yedek değildir.** `depsis_backup` bu tabloyu
göremiyor, dolayısıyla o rolle alınmış bir döküm sistemi **geri yükleyemez**. Gerçek bir felaket
kurtarma dökümü `depsis_owner` ya da `postgres` ile alınır, ve o döküm her ikinci faktörü düz metin
taşır. Yedek rolüne dayanan savunma, yalnızca yedekler gerçekten o rolle alınıyorsa savunmadır.

**İkinci ve asıl boşluk — `depsis_app` her sırrı okuyabiliyor.** Okumak zorunda: beklenen kodu
hesaplamak sırrın kendisini gerektirir. Yani sızmış bir uygulama veritabanı parolası, ya da tek bir
SQL enjeksiyonu, dosya sistemine hiç dokunmadan tüm MFA envanterini devreder. Bu, ana makine ele
geçirilmesinden **çok daha olası** bir senaryo.

Anahtarı `depsis_app`'in SQL erişiminin ulaşamayacağı bir yere koymak, veritabanı erişiminin **tek
başına yetmemesi** demektir. Bu, ajanın `SO_PEERCRED` ile yaptığı ayrımın aynısıdır, başka bir
sınıra uygulanmış hâli.

Parolalar Argon2id ile, kurtarma kodları SHA-256 ile saklanıyor çünkü hiçbiri geri okunmaya
ihtiyaç duymuyor. TOTP sırrı farklı: **geri okunabilir olmak zorunda**, ve onu korunmaya değer
kılan tam olarak bu.

## Karar

### Şifre: AES-256-GCM, satıra bağlı

Her sır bir zarfta saklanır: `sürüm(1) || nonce(12) || şifreli metin || etiket(16)`.

**İlişkili veri (AAD) `user_id|organization_id`.** Bu süs değil. Bu tabloda UPDATE yetkisi olan ama
çözemeyen biri, Alice'in saklanan sırrını Bob'un satırına kopyalayıp Alice'in telefonuyla Bob olarak
giriş yapabilirdi — şifreli metin kusursuz çözülürdü, çünkü içinde kimin olduğunu söyleyen hiçbir
şey yoktur. Bağlama ile etiket doğrulaması düşer. Ayırıcı `|` bir UUID'de bulunamaz, yani `aa|bb`
ile `aab|b` farklı ilişkili veridir.

**Her şifrelemede taze rastgele nonce.** GCM nonce tekrarında felaket biçimde başarısız olur: aynı
anahtar ve nonce altındaki iki mesaj XOR'larını ve **kimlik doğrulama anahtarını** sızdırır.

**Her başarısızlık aynı hikâyeyi anlatır.** Yanlış anahtar, oynanmış bir bayt ve başka bir satırdan
gelen şifreli metin dışarıdan ayırt edilemez; hangisinin daha yakın olduğu yalnız saldırganın işine
yarar.

### Anahtar: bir dosya, ortam değişkeni değil

`DEPSIS_SECRET_KEY_FILE` bir **yola** işaret eder. Ortam değişkeni değil, çünkü:

- `/proc/<pid>/environ` üzerinden aynı kullanıcı olarak koşan her şey okuyabilir,
- API'nin başlattığı her çocuk sürece miras kalır,
- çökme raporlarında ve süreç listelerinde görünür.

systemd dağıtımında bu `LoadCredential=`'ın `$CREDENTIALS_DIRECTORY` altında sunduğu şeydir: mode
0400, servis kullanıcısına ait, `NoNewPrivileges=yes` altında. ADR-0006 aynı deseni zaten
kullanıyor.

Dosya **base64** tutar ve tam 32 bayta çözülmelidir. Ham bayt dosyası, kesilmiş veya bozulmuş bir
dosyadan ayırt edilemez ve sondaki tek bir satır sonu anahtarı sessizce değiştirir. Base64,
gürültüyle başarısız olur. Üretmek için: `openssl rand -base64 32`.

### Anahtar yoksa: reddet, düşürme

Anahtar yapılandırılmamış veya okunamıyorsa:

| Ne olur                      | Neden                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| API **yine de açılır**       | Açılmayı reddetmek ikinci faktörü olmayan kullanıcıları da kilitler — ve bozulan şey anahtarken geri dönüş yolu olan kurtarma kodlarını da |
| Kayıt **reddedilir**         | Şifreleme yapılandırdığını sanan bir operatöre sessizce düz metin vermek, kapattığını sandığı açığın aynısıdır                             |
| Mühürlü sırlar doğrulanmaz   | Açacak bir şey yok; error seviyesinde loglanır                                                                                             |
| Kurtarma kodları **çalışır** | SHA-256 ile hash'lenmişler, anahtar gerektirmezler — bu, onları mühürlememenin büyük bir gerekçesi                                         |

Düşürme yolunun **olmaması** kasıtlıdır: yanlış bir yol ya da bağlanmamış bir credential yüzünden
düz metne dönmek, en çok ihtiyaç duyulan anda korumayı sessizce kaldırır.

### Mevcut satırlar: tembel yükseltme, ve görünür bir kuyruk

`key_version` sütunu satırın **ne olduğunu söyler**: `0` migration 0004'ün ham sırrı, `1` zarf.
Şifrelemeyi göç yapamaz — anahtar tanım gereği veritabanının dışındadır. Bunun yerine uygulama, bir
düz metin satırını ilk okuduğunda kullanır ve **yerinde mühürler**. UPDATE, satırın hâlâ düz metin
olmasına koşulludur, yani iki eşzamanlı giriş ikisi birden mühürleyemez.

Düz metin satırlar doğrulanmaya devam eder. İnsanları kilitleyen bir yükseltme, düzelttiği hatadan
daha kötü bir hatadır.

### Kalan kuyruğu saymak: `SECURITY DEFINER`, ve nedeni bir hataydı

Açılışta "kaç sır hâlâ açıkta" sorusunu sormak istiyoruz. Doğrudan `count(*)` yazmak **sonsuza
kadar 0 döndürür**: sayım hiçbir kiracı bilinmeden önce koşar, dolayısıyla kiracı bağlamı yoktur; ve
tablo kiracıya göre korunduğu için `current_organization_id()` NULL iken RLS her satırı gizler.
Açılış satırı, her sırrın açıkta olduğu bir makinede "0 açıkta" derdi — güven verici ve kör.

`public.unsealed_totp_secret_count()` tanımlayıcı güvenliğiyle koşar, `search_path` sabitlenmiştir
ve **yalnızca bir sayı** döndürür — sır yok, kullanıcı kimliği yok, organizasyon kimliği yok. Açığa
çıkardığı tek şey operasyoneldir.

Bu hatayı yakalayan şey, sayımın bir satırı **görebildiğini** doğrulayan tek bir assertion oldu.

### Anahtar döndürme: şema hazır, mekanizma değil

`key_version` bir sonraki anahtarın var olabilmesi için yer bırakır, ama döndürme **uygulanmadı**.
Yapıldığında kod gerektirecek, başka bir göç değil. Bunu şimdi yazmamak bilinçli: iki anahtarı aynı
anda tutan bir mekanizma, onu sınayacak gerçek bir döndürme senaryosu olmadan yazılırsa yanlış
yazılır.

### Geri alma dürüsttür

Göç 0006 geri alınırken **çözmez** — çözemez. Mühürlenmiş satır varsa geri alma, tabloyu bozmak ya
da kontrolü sessizce genişletmek yerine **açık bir hatayla reddeder**. Kurtarma yolu manueldir:
etkilenen kullanıcılar yeniden kayıt olur. Bu, temiz bir geri almadan kötü ve hiçbir şeyin
okuyamadığı değerleri sessizce kabul eden bir şemadan iyidir.

## Kanıt

Ölçüm: Debian 13 / WSL2, PostgreSQL 18.6, Node 24.19.0.

| İddia                                                                             | Nasıl ölçüldü                                                                       | Güven    |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------- |
| Sütunda saklanan baytlar sırrı içermiyor                                          | Kayıt sonrası ham sütun okundu; `secret.includes(rawSecret)` false                  | verified |
| Mühürlü sır yine de doğruluyor (okunamaz ≠ kullanılamaz)                          | Aynı testte onay kodu kabul edildi ve 10 kurtarma kodu üretildi                     | verified |
| Aynı sır iki kez aynı şifreli metni üretmiyor                                     | 200 mühürleme, 200 farklı sonuç                                                     | verified |
| Alice'in mührü Bob'un satırında çalışmıyor                                        | Ham UPDATE ile taşındı; doğrulama reddetti                                          | verified |
| Ayırıcı kaydırması ilişkili veriyi çakıştırmıyor (`aa\|bb` ≠ `aab\|b`)            | Birim test                                                                          | verified |
| Oynanmış bayt, yanlış anahtar ve taşınmış metin **aynı** mesajı veriyor           | Üç yolun mesajları toplandı; küme boyutu 1                                          | verified |
| Migration 0004'ün bıraktığı satır ilk kullanımda yerinde mühürleniyor             | key_version 0 satır kuruldu; giriş sonrası ham sütun okundu, sürüm 1 ve ham sır yok | verified |
| Yükseltme sonrası aynı authenticator çalışmaya devam ediyor                       | Yükseltmeden sonra bir sonraki adımın kodu kabul edildi                             | verified |
| Şema, formu hakkında yalan söyleyen satırı reddediyor                             | `key_version = 1` + zarf olmayan değer → `user_totp_secret_envelope_tagged` ihlali  | verified |
| Anahtar yokken kayıt reddediliyor                                                 | `SecretKeyUnavailableError`                                                         | verified |
| Kalan düz metin sayımı RLS altında gerçekten görüyor                              | Definer fonksiyon; assertion olmadan 0 dönüyordu ve bu hata böyle bulundu           | verified |
| Altı göç temiz bir veritabanına uygulanıyor, geri alınıyor ve yeniden uygulanıyor | `migrate:up` → `down` → `up`                                                        | verified |

**Ölçülmemiş / kapsam dışı:**

| İddia                                              | Durum                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| `LoadCredential=` ile gerçek bir systemd dağıtımı  | **unverified** — `deploy/systemd` birimi henüz anahtarı taşımıyor |
| Anahtar döndürme                                   | **uygulanmadı** — şema hazır, mekanizma yok                       |
| Ana makine ele geçirilmesine karşı koruma          | **yok, ve olmayacak** — bu ADR bunu iddia etmiyor                 |
| Oturum belirteçleri ve bekleyen giriş belirteçleri | Zaten hash'li; bu ADR'nin kapsamında değil                        |

## Sonuçlar

Veritabanına erişim artık ikinci faktörü ele geçirmek için **yeterli değil**. Anahtar dosyasına da
erişmek gerekiyor, ve bu iki farklı yetenek: biri bir veritabanı parolası ya da bir SQL enjeksiyonu,
diğeri dosya sistemi erişimi.

Bunun bedeli, kaybedilebilecek yeni bir şeyin var olması. Anahtar kaybolursa mühürlü sırlar
kurtarılamaz ve ilgili kullanıcılar kurtarma kodlarıyla girip yeniden kayıt olmak zorunda kalır.
Anahtar **yedeklenmelidir**, ve veritabanı yedeğinden **ayrı** yedeklenmelidir — ikisini bir arada
tutan bir yedek, şifrelemenin satın aldığı şeyi geri verir.

## Geri alma maliyeti

Orta. Şema geri alınabilir ama yalnızca hiçbir sır mühürlenmemişse; mühürlenmişse etkilenen
kullanıcıların yeniden kayıt olması gerekir. Kod tarafı tek bir sınıfın arkasında (`SecretBox`) ve
`MfaService`'e iki çağrıyla giriyor.

## Güvenlik ve veri kaybı etkisi

§16 denetim izinde sır bulunmamasını şart koşuyor; bu ADR aynı kuralı **veritabanına** genişletiyor.
Yeni veri kaybı riski anahtarın kaybıdır ve yukarıda açıkça yazıldı: ayrı yedekleyin.
