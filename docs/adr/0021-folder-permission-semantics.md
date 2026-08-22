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
