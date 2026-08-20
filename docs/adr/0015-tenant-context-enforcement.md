# ADR-0015: Kiracı bağlamının API tarafında zorlanması

- **Durum:** Accepted
- **Tarih:** 2026-08-20
- **Faz:** 1
- **Etkilenen bileşenler:** `apps/api`, `apps/worker`, `packages/db`

## Bağlam

ADR-0013 kiracı yalıtımını `SET LOCAL` + `current_setting()` üzerine kurdu ve **kritik koşulu**
açıkça yazdı: her istek bir transaction içinde koşmalı, bağlamsız bir sorgu hiçbir satır
görmemeli. P0-C bunu ölçtü, P1-A ve CI kapısı her push'ta yeniden ölçüyor. Veritabanı tarafı
sağlam.

Sorun bir katman yukarıda ve ADR-0013'ün yazıldığı sırada görülmemişti.

**Fail-closed davranışı sıfır satır döndürüyor, hata değil.** Bir API işleyicisi için bu, "bu
kiracının verisi yok"tan ayırt edilemez. Yani veritabanının güvenlik ağı, tam olarak bu projenin
Faz 0 boyunca avladığı imzayı üretiyor: yanlış davranış, hiçbir katmanda hata mesajı olmadan.
Bağlamı kurmayı unutan bir uç nokta 500 vermez — **boş bir liste döner**, ve bu üretimde aylarca
fark edilmeyebilir.

ADR-0013 bunun için "bir disiplin gerektirir" dedi. Disiplin, kod tabanı büyüdükçe kaybolan
şeydir. Bu ADR onu yapısal hâle getiriyor.

## Karar

### 1. Tek boğaz noktası: havuza doğrudan erişim yok

`packages/db`'nin dışa açtığı tek şey iki fonksiyon. `Pool` ve `PoolClient` dışa **aktarılmaz**;
bir modülün ham bağlantı alabileceği bir yol yoktur.

```ts
withTenant(organizationId, fn); // SET LOCAL kurulur, doğrulanır, sonra fn koşar
withoutTenant(justification, fn); // kiracı tablosuna dokunmayan işler için, gerekçe zorunlu
```

`withoutTenant` bir kaçış kapısı değil, **isimlendirilmiş bir istisna**: gerekçe bir dize
parametresidir, log'a düşer, ve bu ADR onu sayılı işe sınırlar. Yenisi için bu ADR'nin
güncellenmesi gerekir.

| Gerekçe                        | Neden bağlam kurulamıyor                              |
| ------------------------------ | ----------------------------------------------------- |
| `health-check`                 | Kiracı tablosuna dokunmuyor                           |
| `migration-status`             | Kiracı tablosuna dokunmuyor                           |
| `resolve-organization-by-slug` | Kiracı kimliği **henüz bilinmiyor** — §5              |
| `resolve-session`              | Aynısı, bir adım daha içeride — göç 0003, aşağıda §5b |

Dördüncüsü, bu ADR yazıldıktan sonra oturum katmanı tasarlanırken eklendi — yani kural işledi:
listeyi genişletmek kod değişikliği değil, karar değişikliği oldu.

### 5b. Oturum çözümü: aynı desen, bir adım içeride

İstek bir çerezle geliyor; çerez bir belirteç, belirteç bir oturum, oturum bir kiracı veriyor. Ama
`sessions` üzerindeki politika kiracıyı biliyor olmayı gerektiriyor — §5'teki tavuk-yumurtanın
aynısı.

`public.resolve_session(bytea)` aynı biçimde dar: belirtecin **hash'ini** alıyor (ham belirteç
veritabanına ve loglarına hiç ulaşmıyor), yalnız bağlamı kurmaya yetecek dört alanı döndürüyor, ve
süresi dolmuş / iptal edilmiş / kullanıcısı devre dışı bir oturum için **hiçbir şey** döndürmüyor —
çağıran bu üç durumu "böyle bir oturum yok"tan ayıramıyor ve ölü bir oturumla kazara işlem yapamıyor.

`sessions.token_hash` üzerindeki `UNIQUE` ise ADR-0013'ün `organization_id` kuralının bilinçli tek
istisnası. Gerekçe göç 0003'te tam olarak yazılı ve özeti şu: bu kısıtta çakışma üretebilmek için
saldırganın **zaten geçerli bir belirtece sahip olması** gerekiyor, dolayısıyla sızan bilgi
("bu 32 bayt kullanımda") çağıranın sormadan önce zaten sahip olduğu bilgi. Diğer bütün UNIQUE
kısıtlarında durum bunun tersi.

### 2. `SET LOCAL` bind parametresi almaz — `set_config` alır

```sql
SELECT set_config('depsis.organization_id', $1, true)
```

`SET LOCAL depsis.organization_id = '...'` bir bind parametresi kabul etmiyor, dolayısıyla
kullanılsaydı kiracı kimliğinin SQL'e **dize olarak yapıştırılması** gerekirdi. Kiracı kimliği bir
oturum belirtecinden geliyor; oraya yapıştırma yapmak, yalıtımın tamamını bir kaçış hatasına
bağlamak demektir. `set_config`'in üçüncü argümanı `is_local` ve `SET LOCAL` ile aynı semantiği
taşıyor — P1-B bunu ölçüyor, çünkü "aynı olduğu söyleniyor" bu projede yeterli değil.

### 3. Bağlamın kurulduğu **doğrulanır**, varsayılmaz

`set_config` çağrısından hemen sonra, aynı transaction içinde:

```sql
SELECT public.current_organization_id()
```

Dönen değer beklenen kiracıya eşit değilse transaction geri alınır ve **hata fırlatılır**. Bu
kontrol bir sorgu turu maliyetinde değil — `set_config` zaten değeri döndürüyor, ve doğrulama aynı
`SELECT` içinde yapılıyor.

Neden gerekli: `SET LOCAL`'in sessizce uygulanmadığı gerçek senaryolar var. PgBouncer **session**
havuzlamasında (ADR-0013 yasaklıyor ama yapılandırma hatası mümkün) bağlam transaction dışına
sızar ya da hiç uygulanmaz; bir `SET` ifadesinin yanlış GUC adına yazılması sessizce başarılıdır.
Her ikisinde de sonuç boş sonuç kümesidir. Doğrulama, bunu bir başlatma hatası hâline getiriyor.

### 4. Başlangıçta rol kapısı

API açılırken bağlandığı rolün `rolsuper` veya `rolbypassrls` taşımadığını doğrular ve
taşıyorsa **başlamayı reddeder**.

Gerekçesi ölçülmüş bir olay: P1-A, önceden var olan bir `depsis_app` rolünün `BYPASSRLS` ile
kalabildiğini ve bu durumda bütün politikaların dekoratif hâle geldiğini gösterdi. `bootstrap.sql`
bunu artık koşulsuz düzeltiyor, ama bağlantı dizesi yanlışlıkla `depsis_owner`'ı gösteriyorsa —
ki ADR-0014 tam olarak bunu engellemek için iki ayrı ortam değişkeni kullanıyor — uygulama her
kiracıyı görür ve hiçbir şey hata vermez. Kapı ucuz ve tam da doğru yerde: bir kez, açılışta.

### 5. Slug → kiracı çözümü: dar, `SECURITY DEFINER` bir delik

Girişte bir tavuk-yumurta var. Kullanıcı bir slug ile geliyor; kiracı kimliğini bilmek için
`organizations` okunmalı; ama o tablodaki uygulama politikası `id = current_organization_id()` —
yani **kiracıyı bilmeden kiracı okunamıyor**.

Çözüm, `depsis_owner`'ın sahip olduğu `SECURITY DEFINER` bir fonksiyon:

```sql
public.resolve_organization_by_slug(slug text) RETURNS uuid
```

Bu bilinçli olarak dar: yalnız tam eşleşen bir slug için **yalnız kimliği** döndürür, başka hiçbir
sütunu değil, ve bulunamazsa `NULL` verir. Politikayı gevşetmiyor — `organizations` üzerindeki
`SELECT` politikası olduğu gibi kalıyor.

Kabul edilen bedel: bu bir **varlık oracle'ı**. Bir slug'ın var olup olmadığı kimliği doğrulanmamış
bir çağıran tarafından öğrenilebilir. ADR-0013 ve göç 0001 zaten `organizations_slug_key`'in aynı
sızıntıyı taşıdığını kaydediyor ve aynı gerekçeyle kabul ediyor: slug bir kiracıyı adlandırır,
kiracıya kapsanamaz, ve operatör tarafından atanır — son kullanıcı üretmiyor. Bu fonksiyon o
kabul edilmiş sızıntının yüzeyini genişletmiyor, yalnızca kullanılabilir kılıyor.

Sızıntıyı **daraltan** iki şey fonksiyonun içinde: sabit `search_path`, ve slug'ın 0001'deki aynı
`CHECK` biçimine uyması — uymayan bir girdi veritabanına hiç ulaşmıyor.

### 6. Kiracı kimliği asla istekten okunmaz

Bağlam, doğrulanmış oturumdan gelir. Bir başlık, sorgu parametresi veya gövde alanı kiracı
kimliğini **belirleyemez**. Bu, ADR-0006'nın `SO_PEERCRED` kuralının veritabanı tarafındaki
karşılığı: kimlik, çağıranın söylediği şey değil, sunucunun bildiği şeydir.

## Kanıt

| İddia                                                            | Güven                                                |
| ---------------------------------------------------------------- | ---------------------------------------------------- |
| Bağlamsız sorgu sıfır satır döndürüyor (hata değil)              | verified — [P0-C](evidence/p0-c.tsv)                 |
| `BYPASSRLS` taşıyan bir rol bütün politikaları dekoratif yapıyor | verified — [P1-A](evidence/p1-a.tsv)                 |
| `SET LOCAL` bind parametresi kabul etmiyor                       | ✅ ölçüldü — P1-B, gerçek PG 18.6                    |
| `set_config(..., true)` bağlamı transaction bitince düşüyor      | ✅ ölçüldü — havuzdan tekrar alınan bağlantıda NULL  |
| Doğrulama aynı turda dönüyor (ek round trip yok)                 | ✅ tek `SELECT`, iki sütun                           |
| PgBouncer session havuzlamasında bağlamın sızdığı                | **unverified** — ADR-0013 P0-C'de de açıkta kalmıştı |

### P1-B'nin ortaya çıkardığı açık — ve §4'ün değişmesi

§4 ilk hâlinde rol **niteliklerine** bakıyordu: `rolsuper` veya `rolbypassrls`. Testi yazarken
görüldü ki `depsis_owner` bunların **ikisini de taşımıyor** — göç 0001 ona `USING (true)` politikası
veriyor, backfill koşabilsin diye. Yani nitelik tabanlı kapı, tam da engellemesi gereken bağlantıyı
temiz geçiriyordu: sahibe bağlanan bir API her kiracıyı okur ve hiçbir yerde hata çıkmaz.

Kapı artık **davranışsal**: bağlam kurulmadan `organizations` sorgulanır, ve bir satır bile
görünüyorsa API başlamayı reddeder. Bu hem `BYPASSRLS`'i hem sahibi yakalıyor, çünkü ikisinin de
gözlemlenebilir sonucu aynı.

Tek sınırı açıkça yazılmalı: **hiç organizasyon yokken kontrol boşlukta geçer.** Yanlış bir ret
üretemez ve boş bir sistemde sızacak bir şey yoktur, ama kapı ancak ilk kiracı yaratıldıktan sonra
anlamlı hâle gelir. P1-B bunu iki kez koşarak ayırt ediyor: önce boş veritabanında, sonra iki
kiracı varken.

## P1-B — bu ADR'yi doğrulayacak PoC

1. `withTenant` dışından bir sorgu çalıştırmanın **derleme zamanında** imkânsız olduğu (havuz dışa
   aktarılmıyor) ve çalışma zamanında da bir yolu bulunmadığı.
2. `set_config` ile kurulan bağlamın transaction bitince **kendiliğinden düştüğü** — bir sonraki
   `withTenant` çağrısı önceki kiracıyı görmemeli. Havuzdan gelen bağlantı yeniden kullanıldığı
   için bu, sızıntının en olası yolu.
3. Doğrulama adımının, bağlam kurulmadığında gerçekten **hata fırlattığı** (yapay olarak
   `set_config` atlanarak).
4. Rol kapısının `depsis_owner` bağlantı dizesiyle açılışı **reddettiği**.
5. `resolve_organization_by_slug`'ın yalnız kimliği döndürdüğü ve `organizations` politikasını
   gevşetmediği — çözümlenen kimlikle bağlam kurulmadan tablo hâlâ boş görünmeli.
6. Bir istek başlığının kiracı bağlamını **değiştiremediği**.

## Sonuçlar

**Olumlu:** Yalıtım bir konvansiyon değil, tip sistemi ve tek bir fonksiyon tarafından zorlanıyor.
"Bağlamı kurmayı unuttum" hatası yazılamıyor. Bağlamın sessizce kurulmaması, boş liste yerine
gürültülü hata üretiyor.

**Olumsuz / kabul edilen bedel:** Her sorgu bir transaction açıyor; salt okuma uçları için bu ek
maliyet. Ölçülmedi, ve §18.2'nin p95 hedefleri zaten hiçbir koşuda test edilmedi — burada da
edilmiş gibi sunulmuyor. `withoutTenant` bir kaçış kapısı ve listesi büyürse bu ADR'nin koruması
aşınır; bu yüzden liste ADR'de, kodda değil.

**Bu kararın yasakladığı şeyler:**

- `packages/db` dışında bir `Pool` veya `PoolClient` tutulamaz.
- Kiracı kimliği SQL'e dize olarak yapıştırılamaz; `set_config` bind parametresi zorunlu.
- Bağlamın kurulduğu varsayılamaz; her transaction'da doğrulanır.
- Kiracı kimliği HTTP başlığından, sorgu parametresinden veya gövdeden okunamaz.
- `withoutTenant` bu ADR'de sayılan üç iş dışında kullanılamaz.
- API, `rolsuper` veya `rolbypassrls` taşıyan bir rolle başlayamaz.

## Geri alma maliyeti

Düşük. Boğaz noktası tek dosya; kaldırmak isteyen onu havuzu dışa açacak şekilde değiştirir. Asıl
maliyet geri almakta değil, **geri alındığının fark edilmemesinde** — bu yüzden P1-B maddesi 1 bir
tercih değil, kapıdır.

## Güvenlik ve veri kaybı etkisi

Doğrudan R4 (kiracı sızıntısı). Bu ADR'nin bütün amacı, veritabanının doğru olan davranışının
uygulama katmanında sessizce yanlış bir sonuca dönüşmesini engellemek.
