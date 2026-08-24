# DEPSIS — Son Kullanıcı Kılavuzu

Bu belge, dosyalarını DEPSIS'te tutan kişi içindir. Cihazı kuran kişi için
[Yönetici Kılavuzu](01-yonetici-kilavuzu.md) var.

---

## 1. Giriş

Tarayıcınızdan cihazın adresini açın. Kullanıcı adı ve parola isteyecek — **e-posta değil**.
Bu bir ev/ofis cihazı; posta göndermiyor ve bir adresi doğrulayamıyor, o yüzden adres sormuyor.

Hesabınızda iki adımlı doğrulama açıksa parolanın ardından altı haneli bir kod istenir.
Doğrulayıcı uygulamanız yoksa kurtarma kodlarınızdan birini de yazabilirsiniz.

### Parolamı unuttum

DEPSIS size e-posta gönderemez. Yöneticinize söyleyin: size **tek kullanımlık bir anahtar**
verecek. Giriş ekranındaki **"Parolamı unuttum"** bağlantısına tıklayın, anahtarı ve yeni
parolanızı girin.

Bilmeniz gereken üç şey:

- Anahtar **bir kez** kullanılır. Denediğinizde kabul edilmiyorsa ya süresi dolmuştur (30 dakika)
  ya da **başka biri kullanmıştır** — bu durumda yöneticinize söyleyin.
- Hesabınızda iki adımlı doğrulama açıksa doğrulayıcı kodunuz da gerekir. Anahtar tek başına
  ikinci faktörü geçmez.
- Parolanız değiştiğinde **diğer bütün oturumlarınız kapanır**.

---

## 2. Dosyalar

### Yükleme

Dosyaları pencereye sürükleyip bırakın, ya da **Yükle** düğmesini kullanın. Büyük dosyalar
parça parça gider: bağlantınız koparsa kaldığı yerden devam eder, baştan başlamaz.

### Taşıma, yeniden adlandırma, kopyalama

Bir satırı başka bir klasörün üzerine sürükleyerek taşıyabilirsiniz. Birden fazla satır seçiliyken
sürüklerseniz **hepsi** taşınır, ve DEPSIS taşımadan önce kaç öğe olduğunu söyleyip onay ister —
taşımanın geri alması yok.

**Kopyala** hedefi sorar ve işi arka planda yapar; büyük bir klasörü kopyalamak arayüzü
kilitlemez. Hedefte aynı adda bir şey varsa kopya `rapor (2).pdf` gibi yanına düşer — üzerine
**yazılmaz**. DEPSIS hiçbir zaman adlandırmadığınız bir dosyanın üzerine yazmaz.

### Çöp kutusu

Sildiğiniz şey çöp kutusuna gider, yok olmaz. Oradan geri alabilirsiniz.

Yöneticiniz bir **saklama süresi** ayarladıysa, çöpteki her satırın yanında ne zaman kalıcı olarak
sileceğini gösteren bir tarih (⏳) görürsünüz. Tarih yoksa o öğe kendiliğinden gitmeyecek demektir.

Çöpe atılmış bir **klasörün içindeki** dosyada tarih görünmez: o dosya kendi tarihinde değil,
klasörünün tarihinde gider.

**Kalıcı sil** gerçekten kalıcıdır. Geri getirmenin yolu yok.

### Arama

Arama kutusu adlara bakar, içeriğe değil. Türkçe düzgün çalışıyor: `istanbul` yazan da `İSTANBUL`
yazan da aynı sonucu alır, ve `cagri` yazmak `Çağrı` dosyalarını bulur.

Çöp kutusundayken arama kapalıdır.

### Göremediğim bir dosya var

Üç ihtimal:

1. **Erişim izniniz yok.** DEPSIS erişemediğiniz satırları göstermez — soluk da göstermez, hiç
   göstermez. Bir dosya adı tek başına bilgidir.
2. **Yeni geldi.** SMB'den (Windows'tan) yazılan dosyalar web arayüzüne birkaç dakika içinde
   düşer, anında değil.
3. **Yanlış paylaşımdasınız.** Birden fazla paylaşım varsa dosya yöneticisinin üstündeki
   seçiciden değiştirin.

---

## 3. Windows'tan bağlanma

DEPSIS bir ağ sürücüsü olarak da görünür. **Paylaşımlar** ekranında her paylaşımın adresi yazıyor
(`\\depsis\belgeler` gibi).

Windows'ta: **Bu bilgisayar → Ağ sürücüsüne bağlan**, adresi yapıştırın, DEPSIS kullanıcı adınız ve
parolanızla giriş yapın.

**SMB parolanız web parolanızla aynıdır** — ama yalnız bu özellik geldiğinden beri parolanızı en az
bir kez değiştirdiyseniz. Web'e girebiliyor ama Windows'a giremiyorsanız, **Hesabım** ekranından
parolanızı bir kez değiştirin; aynısını yazsanız bile olur.

Web'de göremediğiniz bir şeyi Windows'ta da göremezsiniz: izinler aynı yerden geliyor.

`.depsis` diye bir klasör görürseniz — göremezsiniz, Samba onu gizliyor — o DEPSIS'in kendi geçici
alanı. Oraya bir şey koymayın.

---

## 4. Hesabım

### Parola değiştirme

**Hesabım** ekranından. Mevcut parolanız istenir: bir oturum, birinin açık bırakılmış dizüstünü
ödünç aldığında sahip olduğu şeydir.

Değiştirdiğinizde **diğer bütün oturumlarınız** kapanır; bulunduğunuz oturum açık kalır.

### İki adımlı doğrulama

**Hesabım → İki adımlı doğrulama → Aç.** Ekrandaki anahtarı doğrulayıcı uygulamanıza girin
(Google Authenticator, Aegis, 1Password — hepsi olur), sonra uygulamanın gösterdiği kodu yazın.

Açtığınızda **kurtarma kodları** verilir. Bunlar **bir kez** gösterilir; sunucu yalnız özetlerini
saklıyor. Kopyalayıp güvenli bir yere koyun.

> Doğrulayıcınızı kaybeder ve kurtarma kodunuz kalmazsa hesabınıza giremezsiniz. Yöneticiniz
> parolanızı sıfırlayabilir ama **ikinci faktörü atlayamaz** — bu, tasarımın kendisi.

Kod kabul edilmiyorsa önce telefonunuzun saatine bakın: TOTP saate dayanır ve birkaç dakikalık
kayma kodları geçersiz kılar.

---

## 5. Aktarımlar ve işler

**Aktarımlar** paneli süren yüklemelerinizi gösterir — yalnız sizinkileri. Bir aktarım "durdu"
diyorsa bağlantı kesilmiş demektir; kaldığı yerden devam edebilirsiniz.

Kopyalama gibi uzun işler arka planda çalışır. İlerlemelerini yönetici **Sistem işleri** panosunda
görebilir.

---

## 6. Bir hata mesajı aldım

DEPSIS'in hata kutularında bazen bir **correlation id** olur — `a1b2c3d4-...` gibi. Yöneticinize
söylerken o id'yi de verin: sunucu günlüğünde o isteğe ait her satırı onunla bulabilir.

Sık görülen birkaçı:

| Mesaj                                                | Anlamı                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| _"Depolama şu an kullanılamıyor"_ (503)              | Cihazın depolama bileşeni yanıt vermiyor. Yöneticinize söyleyin.                  |
| _"Bu işlem için yetkiniz yok"_ (403)                 | O klasörde o işi yapma izniniz yok.                                               |
| _"Kaynak bulunamadı"_ (404)                          | Dosya yok — ya da göremediğiniz bir yerde. DEPSIS ikisini kasıtlı olarak ayırmaz. |
| _"Çakışma"_ (409)                                    | Aynı adda bir şey zaten var, ya da başka biri aynı anda değiştirdi.               |
| _"Bu dosya siz görüntüledikten sonra değişti"_ (412) | Başka biri sizden önce değiştirdi. Sayfayı yenileyip tekrar deneyin.              |
| _"Yetersiz depolama alanı"_ (507)                    | Havuz dolu. Yöneticinize söyleyin.                                                |
