# ADR-0009: Oturum ve MFA modeli; WebAuthn'ın ad alanı kısıtı

- **Durum:** Accepted
- **Tarih:** 2026-08-14
- **Faz:** 0 (karar), 1 (uygulama)
- **Etkilenen bileşenler:** `apps/api/src/auth`, `apps/web/src/routes/login`, `apps/web/src/routes/setup`

## Bağlam

Master prompt §6.3 hem TOTP hem **WebAuthn/passkey** MFA istiyor. §3.1 ise sunucuya _"IP'si veya
yerel DNS adı üzerinden"_ erişimi normal kullanım olarak tanımlıyor.

Bu ikisi birbiriyle çelişir. Proje sahibi S4'te durumu netleştirdi: **gerçek bir hostname ve
güvenilen sertifika sağlanamayacak.**

## Neden WebAuthn Faz 1'de teknik olarak imkânsız

WebAuthn'da her kimlik bilgisi bir **Relying Party ID**'ye bağlanır. RP ID geçerli bir alan adı
olmak zorundadır — **çıplak bir IP adresi RP ID olamaz.** Bu bir tarayıcı tercihi veya sertifika
sorunu değil, spesifikasyonun kimlik modelinin temelidir; self-signed bir sertifika kurmak da
çözmez.

Dolayısıyla `https://192.168.1.50` üzerinden erişilen bir DEPSIS'te passkey **kaydedilemez**.
"Yakında" diye gizlenecek bir eksiklik değil, mimari bir kısıttır.

## Karar

### Faz 1 MFA = yalnız TOTP

| Faktör             | Faz 1                               | Koşul sağlandığında                           |
| ------------------ | ----------------------------------- | --------------------------------------------- |
| Parola             | Argon2id                            | —                                             |
| TOTP (RFC 6238)    | **Evet**                            | —                                             |
| Kurtarma kodları   | **Evet** — tek kullanımlık, hash'li | —                                             |
| WebAuthn / passkey | **Hayır** — RP ID yok               | Faz 2, hostname + güvenilen sertifika gelince |

### S4'ün WebAuthn dışına yayılan sonuçları

Hostname/sertifika eksikliği yalnız MFA'yı etkilemiyor:

- **Secure context.** Service Worker, PWA kurulumu ve Web Crypto güvenli bağlam ister. `https://`
  self-signed sertifikayla bu sağlanabilir, ama tarayıcı kullanıcıyı uyarır. Kurulum sihirbazı
  DEPSIS'in ürettiği kök sertifikayı indirtir ve istemciye kurma adımını **açıkça anlatır**.
  Sertifika kurulmadıysa UI hangi özelliklerin kapalı olduğunu **listeler** — sessizce bozulmaz.
- **HSTS gönderilmez.** §16 bunu zaten "uygun alan adı senaryosunda" diye koşullamış. IP tabanlı
  erişimde HSTS göndermek, o IP'yi ileride başka bir servise veren kullanıcıyı kilitler.
- **Çerez kapsamı.** `Secure` + `HttpOnly` + `SameSite=Lax`. IP tabanlı erişimde çerez host'a
  bağlıdır; **sunucunun IP'si değişirse oturum düşer.** Bu davranış kullanıcı belgesine yazılır.
- **Faz 2 kapısı.** WebAuthn, HSTS ve otomatik sertifika yenileme tek bir yapılandırma
  değişikliğiyle açılabilecek biçimde kodlanır. RP ID bir config değeri olur; `null` ise WebAuthn
  uçları 501 döner ve UI özelliği nedeniyle birlikte kilitli gösterir. **Faz 2'de yeniden yazım
  olmayacak.**

### Oturum modeli

- **Parola hash'i:** Argon2id. Parametreler config'te, kurulumda donanıma göre kalibre edilir.
- **Oturum:** sunucu tarafı, kısa ömürlü; `HttpOnly` + `Secure` + `SameSite=Lax` çerez.
  JWT **kullanılmıyor** — iptal edilebilirlik §16'nın "güvenlik olayında tüm oturumları iptal"
  gereksinimi için zorunlu, ve stateless token bunu ucuz yapmaz.
- **Refresh rotasyonu** ve cihaz oturum listesi; kullanıcı kendi oturumlarını görür ve sonlandırır.
- **CSRF:** çerez tabanlı oturum olduğu için double-submit veya origin kontrolü zorunlu.
- **Rate limit + brute-force geciktirme.** Hesap kilitleme, saldırganın başkasının hesabını
  kilitlemesine (DoS) izin vermeyecek biçimde tasarlanır — kilit yerine artan gecikme ve
  IP+hesap birleşik sayaç.
- **Kurtarma kodları:** tek kullanımlık, hash'li saklanır, üretildiğinde bir kez gösterilir.

### İlk yönetici parolası

§6.3 net: **loga, QR'a veya varsayılan config'e düz metin yazılmaz.** Kurulum sihirbazı
tarayıcıda tek seferlik bir akışla parolayı aldırır. Kurulum tamamlanana kadar API yalnız setup
uçlarını açar; tamamlandıktan sonra setup yolu kalıcı olarak kapanır.

## Kanıt

| İddia                                                           | Güven                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| WebAuthn RP ID geçerli bir alan adı olmalıdır; çıplak IP olamaz | verified (W3C WebAuthn Level 2/3, RP ID = geçerli domain string)         |
| Service Worker güvenli bağlam ister                             | verified (W3C Secure Contexts)                                           |
| Argon2id parametre seçimi                                       | **unverified** → ADR-0000 §3, Node argon2 paketi araştırmasıyla birlikte |

## Sonuçlar

**Olumlu:** Faz 1 kapsamı gerçekçi. Kullanıcıya yalan söylenmiyor. Faz 2 geçişi yeniden yazım
gerektirmiyor.

**Olumsuz / kabul edilen bedel:** TOTP, passkey'den zayıftır — phishing'e dayanıklı değildir.
Self-signed sertifika tarayıcı uyarısı üretir; bu kullanıcı deneyimi bedeli kabul ediliyor ve
kurulum sihirbazında dürüstçe anlatılıyor.

**Bu kararın yasakladığı şeyler:**

- UI'da WebAuthn "yakında" olarak gösterilemez; **nedeni yazılmalıdır**.
- IP erişiminde HSTS gönderilemez.
- İlk yönetici parolası hiçbir yere düz metin yazılamaz.
- JWT oturum token'ı olarak kullanılamaz.
- Hesap kilitleme, kilitlemeyi silah hâline getiren biçimde uygulanamaz.

## Geri alma maliyeti

Düşük — RP ID config değeri olarak tasarlandığı için WebAuthn eklemek bir yapılandırma ve bir
uç grubu ekleme işidir.

## Güvenlik ve veri kaybı etkisi

MFA'nın TOTP ile sınırlı olması, phishing'e dayanıklılığı düşürür. Bu, tehdit modelinde
**kabul edilmiş bir kalıntı risk** olarak kaydedilir ve alan adı sağlandığında kapatılır.
Kurtarma kodlarının hash'li saklanması, veritabanı sızıntısında MFA'nın atlanmasını engeller.
