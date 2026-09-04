# ADR-0021: Klasör izinlerinin anlamı — miras, öncelik, ve neden deny yok

- **Durum:** Accepted
- **Tarih:** 2026-08-22
- **Faz:** 1
- **Etkilenen bileşenler:** `packages/db`, `packages/authz`, `apps/api/src/files`, `services/system-agent`

## Bağlam

§6.2 izinleri sayıyor ve bir şart koşuyor:

> İzinler kullanıcı veya gruba atanır; klasör ağacında miras alır. Açık `deny` desteği varsa
> öncelik kuralları **tek ve belgelenmiş** olmalı.

ADR-0004 otorite modelini seçmişti: uygulanan substrat POSIX ACL, uygulama katmanı onun üstüne
biner, ve **uygulama yetkisi dosya sistemi yetkisinin her zaman bir alt kümesidir.**

Geriye tek soru kalıyordu ve bu ADR onu cevaplıyor: bir kullanıcının belirli bir klasörde neyi
yapabileceği, hangi kuralla hesaplanır.

## Karar

### Açık deny YOK

Üç gerekçe, ve üçüncüsü tek başına yeterli:

1. **Deny + miras, kimsenin baştan tahmin edemediği kurallar üretir.** "Neden bu klasörü
   göremiyorum" sorusunun cevabı bir algoritma olur, ve bir yetki modelinin en kötü özelliği
   sahibi tarafından anlaşılamamasıdır.
2. **Uygulanan substratın deny'ı yok.** POSIX ACL yalnızca izin verir. Uygulama katmanındaki bir
   deny dosya sistemine yansıtılamaz, yani SMB'den açılabilen bir klasör web'de kapalı görünür —
   §6.2'nin ilk cümlesinin yasakladığı "iki ayrı gerçeklik" tam olarak bu.
3. **Eksiltmek her zaman güvenli yön.** Deny'sız bir modelde uygulama katmanının bir hatası, en
   kötü ihtimalle kullanıcıyı dosya sisteminin izin verdiğinden AZINA bırakır. Deny'lı bir
   modelde ise deny'ın uygulanmaması, izin verdiğinden FAZLASINA bırakır.

Daraltma yine mümkün ve §6.2'nin diyagramındaki "İstisna: daha dar izin" durumu bununla karşılanır
— aşağıdaki miras kuralı sayesinde.

### Miras: en yakın ata kazanır, kişi başına

Bir kullanıcının bir klasördeki izinleri şöyle hesaplanır:

1. Kullanıcının **temsilcileri** (principal) toplanır: kendisi, ve üyesi olduğu her ekip.
2. Her temsilci için ayrı ayrı, klasörden köke doğru yürünür ve o temsilci için grant taşıyan
   **EN YAKIN** düğüm bulunur. Bulunan grant, o temsilcinin izin kümesidir. Daha yukarıdaki
   grant'lar o temsilci için **yok sayılır** — daraltma buradan geliyor.
3. Bütün temsilcilerin izin kümeleri **birleştirilir** (union).

Neden temsilci başına en-yakın, ama temsilciler arası birleşim:

- **En-yakın**, "bu alt klasörde daha az yetkin olsun" cümlesini yazılabilir kılar. Birleşim
  olsaydı bir alt klasöre dar bir grant koymak hiçbir şey daraltmazdı ve daraltmanın tek yolu
  deny olurdu — reddettiğimiz şey.
- **Temsilciler arası birleşim**, çünkü bir kişiyi iki ekibe koymak yetkisini azaltmamalı. İki
  ekipten birinin dar grant'ının diğerinin geniş grant'ını kesmesi, üyeliğin sırasına bağlı bir
  sonuç olurdu.

Organizasyon yöneticisi bu hesabın dışındadır: her şeye erişir. Bu bir kısayol değil, §6.1'in
hiyerarşisi — ve yönetici olmayan hiç kimse için istisna yoktur.

### Grant paylaşımın köküne de verilebilir

`folder_grants.entry_id` NULL ise grant paylaşımın tamamına ait. Ayrı bir "share_grants" tablosu
olmamasının sebebi: kök de bir düğüm, ve iki tablo aynı miras yürüyüşünü iki kez yazdırırdı.

### Her paylaşımın EN AZ BİR grant'ı vardır

Bu bir değişmez, bir tavsiye değil, ve modelin geri kalanı ona yaslanıyor.

§6.2 ilk sunulduğunda `LEGACY_OPEN_SHARE` diye bir istisna vardı: bir paylaşımın hiç grant satırı
yoksa, kiracının her üyesi §6.2 öncesi yedi izni alıyordu. Gerekçesi sağlamdı — o gün hiçbir
paylaşımın grant'ı yoktu ve kuralı olduğu gibi uygulamak her cihazı bomboş bırakırdı. Ama koşul
`folder_grants` üzerinde bir VARLIK SORUSUYDU ve her istekte yeniden soruluyordu, yani hangi
tarafta olduğunu hiçbir yer kalıcı olarak tutmuyordu. Sonuç: **bir paylaşımın son grant'ını
silmek onu kapatmıyor, HERKESE AÇIYORDU.** Bir kök grant'la `manage` verilmiş, yönetici olmayan
biri oraya varabiliyordu. Denetim bunu kritik olarak işaretledi.

`LastGrantError` o kapıyı kapattı ama istisnayı kaldırmadı: sıfır grant'lı bir paylaşım üretebilen
her yeni kod yolu onu geri getirirdi. Kalıcı çözüm, istisnanın kendi belgesinin yazdığı koşulu
sağlamak — sıfır grant'lı bir paylaşım mümkün olmasın — ve o koşul üç parçadan oluşuyor:

1. **Migration 0016**, grant'sız her mevcut paylaşımın köküne bir grant yazdı.
2. **Paylaşım yaratan her yol**, satırı ve ilk grant'ı AYNI İŞLEMDE yazıyor. İkisi vardır ve
   ikisini de saymak gerekiyor: `POST /shares` (yönetici açar) ve `FilesService.defaultShare`
   (kimse açmaz, ilk istekte kendiliğinden oluşur). İkincisi ilk aramada gözden kaçtı ve onu
   düzeltmeden 0016 hiçbir şey garanti etmezdi — taze bir cihazdaki ilk istek değişmezi aynı
   saniyede bozardı.
3. **`LastGrantError`**, son grant'ı silmeyi reddediyor; artık koşulsuz, çünkü öncülü her zaman
   doğru.

İstisna gittiği için `manage`'in bootstrap'ı da netleşti: bir paylaşımın ilk grant'ı her zaman bir
yöneticinin kararıdır, çünkü ondan önce hiç kimsenin `manage` miras alabileceği bir düğüm yoktur.

Kimin adına yazıldığı, paylaşımı kimin açtığına bağlı ve ayrım niyette:

| Paylaşımı açan                 | İlk grant               | Neden                                        |
| ------------------------------ | ----------------------- | -------------------------------------------- |
| Yönetici (`POST /shares`)      | Onu açan yönetici       | Kime açtığını söyleyebilirdi; söylemedi      |
| Kendiliğinden (`defaultShare`) | `everyone_team()` ekibi | Kimse seçmedi; cevap cihazdaki herkes        |
| Migration 0016 (eski satır)    | `everyone_team()` ekibi | Aynı sebep: o dönem izin sorusu sorulmamıştı |

Ekip, kullanıcı başına satır yerine, çünkü ADR-0004 ACL girdilerinin GRUBA verilmesini istiyor:
POSIX ACL ~30 girdiden sonra hantallaşıyor, yani iki yüz kullanıcılı bir cihazda kullanıcı başına
bir kök grant `AclApplyService`'i dosya sistemi tarafında düşürürdü. `everyone_team()` bir SQL
fonksiyonu ve tek tanım — migration da API de onu çağırıyor, çünkü iki dilde iki sabit, kaydıkları
gün grant'sız bir paylaşım üretirdi.

'Herkes' ekibi SIRADAN bir ekip: bayrağı yok, kod onu isimle aramıyor, yönetici yeniden
adlandırabilir ya da silebilir. Amaç bir sistem grubu icat etmek değil, örtük bir kuralı GÖRÜNÜR
bir satıra çevirmek — örtük kural denetlenemez, bir grant satırı denetlenebilir.

**Bu karar sahadan gelen bir bulguyla değişti.** Bu ADR ve migration 0016 önce şunu söylüyordu:
"bu ekibe sonradan açılan kullanıcılar otomatik girmez; yeni bir üyeyi kendiliğinden her eski
paylaşıma sokmak, erişimi GENİŞLETEN bir otomatizm olurdu." Gerçekte olan şuydu: ilk kurulumdan
sonra açılan her hesap hiçbir paylaşımı göremiyordu, ve sahibi bunu bir arıza olarak bildirdi —
cihazın vaadi "aile/ofis paylaşımı", boş bir Dosyalar ekranı değil. `UsersService.create` bugün
her hesap açılışında AYNI işlemde `everyone_team()` çağırıyor ve hesabı 'Herkes' ekibine üye
yapıyor.

Genişleyen şey bir paylaşımın izinleri değil, ekibin ÜYELİĞİ: 'Herkes' ekibinin hangi klasörlere
eriştiği hâlâ yalnız grant satırlarında yazılı ve yalnız bir yönetici değiştirebiliyor, ve ekip
sıradan bir ekip olduğu için yönetici üyeyi çıkarabiliyor ya da ekibi tamamen silebiliyor. Yani
"örtük kural yok, yalnız denetlenebilir satırlar" kuralı yerinde duruyor; değişen, yeni bir
hesabın varsayılan olarak hangi tarafta başladığı.

0016'nın o dönem doğru olan notu olduğu gibi bırakıldı: göç dosyaları o günün kararını taşıyan bir
tarih kaydı, yaşayan belge burası.

### Paylaşımın KÖKÜ de kapatılmak zorunda

Modelin dosya sistemi tarafı yalnız ACL girdilerinden ibaret değil; altındaki üçlü de sayılıyor,
ve paylaşımın kökünde o üçlü hiç kimse tarafından ayarlanmıyordu.

`zfs create` bir dataset'in bağlama noktasını ZFS'in varsayılanında bırakıyor: **0755 root:root**,
yani `other::r-x`. `ApplyFolderAcl` bunu düzeltemez ve DÜZELTMEMELİ — o işlem
`user::`/`group::`/`other::` üçlüsüne bilinçli olarak dokunmuyor ve üçlü altından değişirse
reddediyor, çünkü "izinler uygulandı" cevabı verirken her erişimin geri düştüğü üç girdiyi sessizce
yeniden yazmak yalanların en kötüsü olurdu.

Sonuç: her cihazdaki her paylaşımın kökü, Samba'nın kimlik doğruladığı HERKES tarafından
listelenebilir ve içine girilebilirdi — `folder_grants` ne kadar dar olursa olsun. Aşağıya inmek
yine kapalıydı (ajanın açtığı her klasör 0750 ve kendi ACL'ini taşıyor), yani sızıntı bir dizinin
İSİMLERİ ve o dizine giriş; içeriği değil. İlk okunduğundan daha küçük bir delik, ve yine de
"özel" bir paylaşımın klasör adlarını bütün cihaza okutan bir delik.

`SecureShareRoot` bunu kapatıyor: kök `0750`, sahibi `root:root`. Sahip operandı YOK ve bu eksiklik
değil bir karar — root zaten her ACL'i aşıyor, hiçbir DEPSIS principal'ı bir paylaşımın tepesine
sahip olmamalı, ve onu açan yöneticiye vermek bir kişinin hesabını dosya sistemine gömmek olurdu.
`0750` + root sahipliğiyle `user::` ve `group::` cihazın eşlediği hiç kimseye ulaşmıyor, `other::`
hiç kimseye ulaşmıyor, ve her gerçek izin adlandırılmış bir ACL girdisi olarak geliyor — ADR-0004'ün
tarif ettiği model tam olarak bu.

**Sıra POSIX kuralı, tercih değil.** Zaten bir ACL taşıyan bir dosyada `chmod`, grup bitlerinden
`group::` girdisini değil MASKEYİ ayarlıyor. Kökü ACL'den SONRA kapatmak, adlandırılmış her girdiyi
sessizce `r-x`'e kırpardı. Bu yüzden `AclApplyService` kökü yazmadan hemen ÖNCE çağırıyor; arada
kalan pencere genişletmiyor, daraltıyor — yanılmak istenen yön bu.

Yeni bir işlem, `CreateDataset`'e bir alan değil: hâlihazırda var olan paylaşımlar da açık, ve
yaratma anındaki bir operand yalnızca bir sonrakini düzeltirdi. İşlem idempotent, o yüzden hangi
paylaşımın kapatıldığını kaydetmeye gerek yok — her kök uygulamasında bir gidiş dönüş, ve eski
paylaşımlar bir sonraki izin değişikliğinde kendiliğinden kapanıyor.

### `manage` ayrı bir izin

Bir klasöre yazabilen herkesin o klasörün izinlerini de değiştirebilmesi, yetki modelinin kendi
kendini geçersiz kılmasıdır. `manage` bu yüzden `modify`'dan ayrı ve ayrıca verilir.

### Dry-run zorunlu

§6.2: _"Her izin değişimi dry-run ile etkilenecek kullanıcı/klasör sayısını göstermeli."_

Bir grant'ı yazan uç nokta, yazmadan önce kaç kullanıcının ve kaç klasörün etkileneceğini
döndürebilmeli. Bu bir kolaylık değil: miras kuralı bir alt ağacın tamamını değiştiriyor ve bir
kişinin "şu klasörü ekibe açayım" tıklaması, farkında olmadığı beş yüz dosyayı açabilir.

### POSIX'e yansıma

Her grant, ADR-0004'ün kuralıyla dosya sistemine iner: **girdiler gruba verilir, kullanıcıya
değil.** Kullanıcıya verilen bir grant için de ajan, o kullanıcının kendi POSIX grubunu kullanır —
POSIX ACL'ler ~30 girdiden sonra hantallaşıyor ve mask semantiği ısırıyor.

Miras, POSIX default ACL ile (`setfacl -d`). Bu, DEPSIS'in miras kuralıyla **tam olarak
örtüşmüyor** ve bu farkın bilinmesi gerekiyor: POSIX default ACL yeni oluşturulan çocuklara
kopyalanır, DEPSIS'in kuralı ise her okumada yeniden hesaplanır. Bir grant değiştiğinde alt
ağacın POSIX ACL'lerinin yeniden yazılması gerekir ve bu bir iştir, bir tetikleyici değil.

## Çelişen iki uygulama, ve hangisinin kazandığı

Bu ADR yazıldığında `packages/authz` Faz 0'dan beri duruyordu ve BAŞKA bir model uyguluyor:

|                | `packages/authz/resolve.ts` (Faz 0)         | bu ADR                        |
| -------------- | ------------------------------------------- | ----------------------------- |
| miras          | zincir boyunca BİRLEŞİM                     | temsilci başına EN YAKIN ata  |
| daraltma       | düğümde `inherit: false`                    | alt düğüme daha dar grant     |
| şema karşılığı | yok — 0015'te `inherit` kolonu yok          | `folder_grants` satırı        |
| izin adları    | `manage_acl`, `view_versions`, `view_audit` | `manage`, `versions`, `audit` |

Üç artefakt üç farklı şey söylüyordu: paket, bu ADR, ve migration 0015. Karar:

**Bu ADR kazanır ve `packages/authz` ona uydurulur.** Gerekçe, ikisinin daraltmayı nasıl ifade
ettiği:

`inherit: false` bir düğümde mirası HERKES için kesiyor. "Bu alt klasör stajyerlere daha dar
olsun" demek için, o düğümde mirası kapatıp geri kalan HERKESİ yeniden listelemek gerekir — ve
listede unutulan biri sessizce erişimini kaybeder. Bir yetki modelinin en kötü özelliği, doğru
kullanımının bir listeyi eksiksiz hatırlamayı gerektirmesidir.

Temsilci başına en yakın ata, daraltmayı YEREL yapıyor: yalnız daraltmak istediğin temsilci için
alt düğüme bir satır koyuyorsun, başka kimse etkilenmiyor. §6.2'nin diyagramı da bunu çiziyor —
"İstisna: daha dar izin", miras düğümünden sarkan tek bir dal.

Ayrıca 0015'te `inherit` kolonu yok ve eklemek istemiyoruz: kolon, yukarıdaki footgun'ı şemaya
kalıcı hâle getirmek olurdu.

**İzin adları da sözleşmeye uyar**, pakete değil: `folder_permission` enum'u veritabanında ve
`FolderPermission` yayımlanmış sözleşmede. İkisini değiştirmek bir migration ve üretilmiş her
istemcinin kırılması demek; paket ise iç bir modül ve on testi var. Geniş yüzey dar olanı
belirler.

ADR-0004'ün "Grant modeli" bölümündeki çözümleme kuralları bu noktada BU ADR tarafından
geçersiz kılınır. ADR-0004'ün geri kalanı — POSIX ACL'in tek uygulanan substrat olması, girdilerin
gruba verilmesi, uygulama yetkisinin dosya sistemi yetkisinin alt kümesi olması — aynen geçerli.

## Sonuçlar

**Kazanılan:** çok kullanıcılı bir NAS'ın en temel işi — bir klasörü yalnızca birine açmak.

**Kabul edilen sınır:** deny yok. "Şu kişi hariç herkes" ifade edilemez; bunun yolu, o kişiyi
grant taşıyan ekipten çıkarmak. Bu bir eksiklik ve bilinçli.

**Kabul edilen sınır:** bir paylaşımı silmenin yolu yok, çünkü grant'ları onu tutuyor
(`folder_grants.share_id` ON DELETE RESTRICT) ve son grant'ı silmek de reddediliyor. Bu bilinçli:
paylaşımı silmek dataset'i silmek demek ve ADR-0007 yıkıcı havuz işlemlerini üründen dışarıda
tutuyor. Paylaşımı kapatmanın yolu, kimseyi adlandırmayan bir kök grant.

**Kabul edilen borç:** grant değişikliğinden sonra POSIX ACL'lerin yeniden yazılması bir iş
kuyruğu görevi ve tamamlanana kadar iki katman AYRIŞIK. Bu pencere ölçülmeli ve arayüzde
görünmeli; "izinler uygulanıyor" diyen bir gösterge, yalan söyleyen bir onay kutusundan iyidir.

**Reddedilen seçenek:** izinleri doğrudan `security.NTACL`'e yazmak. ADR-0004 bunu zaten
reddetti; blob bir Samba iç detayı ve bozuk bir blob `smbd`'nin itaat edeceği şey.

## Doğrulama

`tools/poc/p1-h-permissions.sh`, gerçek ZFS ve Samba ile:

- iki ekip, iki klasör: her ekip yalnız kendi klasörünü listeleyebiliyor
- alt klasöre dar grant konunca üst klasörün geniş grant'ı O temsilci için geçmiyor
- iki ekibe üye bir kullanıcı ikisinin BİRLEŞİMİNİ alıyor
- `manage` olmadan izin değiştirmek reddediliyor
- dry-run, gerçekten etkilenen klasör sayısını veriyor
- web'de görülen izin ile SMB'den ölçülen erişim AYNI: bir klasör web'de kapalıysa `smbclient`
  ile de açılamıyor (ADR-0004'ün alt küme değişmezi)
- POSIX uid/gid ayrılması eşzamanlı iki hesap oluşturmada çakışmıyor

`tools/ci/permissions-schema-check.sh`, yalnız PostgreSQL ile, her push'ta — ve o betiğin kendisi
de bu turda onarıldı: assertion'ları yalnızca EKRANA yazıyordu, çıkış kodu her zaman 0'dı. Yani
kısıtların ısırıp ısırmadığını ölçmek için yazılmış kapı, kendisi ısırmıyordu. Şimdi ısırıyor, ve
ilk ısırdığı şey kendi yeni assertion'ının yanlış yazılmış grep deseni oldu.
