# ADR-0014: Şema göçü — ham SQL, iki rol, iki hat

- **Durum:** Accepted
- **Tarih:** 2026-08-19
- **Faz:** 1
- **Etkilenen bileşenler:** `packages/db`, `apps/api`, `apps/worker`, CI

## Bağlam

ADR-0013 şemanın taşıması gereken şeyleri belirledi ve P0-C bunları 45 assertion ile ölçtü:
`FORCE ROW LEVEL SECURITY`, üç rol (`depsis_owner` / `depsis_app` / `depsis_backup`), her UNIQUE
kısıtında `organization_id`, `SET LOCAL` ile taşınan kiracı bağlamı ve bağlamsız sorguda
fail-closed davranış.

ADR-0013 ayrıca **uygulamanın tablo sahibi rolüyle bağlanamayacağını** yasak olarak yazdı. Bu tek
cümle, göç aracı seçimini büyük ölçüde belirliyor: göçler `depsis_owner` ile, uygulama
`depsis_app` ile bağlanır, yani araç iki ayrı bağlantıyı ayrı tutabilmeli ve göç sırasında
uygulama rolüne dokunmamalı.

Faz 0'da hiçbir göç aracı kararlaştırılmadı. Bu ADR onu kapatıyor.

## Karar

### 1. Şema ham SQL'dir, bir DSL değil

Şemanın yük taşıyan parçalarının **hiçbiri** bir ORM veya şema DSL'inde ifade edilemiyor:

- `CREATE POLICY … USING (organization_id = current_setting('depsis.organization_id', true)::uuid)`
- `ALTER TABLE … FORCE ROW LEVEL SECURITY` — `ENABLE` yetmiyor (ADR-0013 §2.1, P0-C ile ölçüldü)
- `GRANT`/`REVOKE` matrisi ve rol bazlı politikalar (`TO depsis_app`)
- İfade indeksleri ve onların gerektirdiği `IMMUTABLE` sarmalayıcılar
- Üretilmiş (`GENERATED ... STORED`) kimlik sütunları ve üzerlerindeki kısıtlar

Sonuncular özellikle öğretici, ve bu ADR'nin ilk hâli burayı **yanlış** anlatıyordu. Düzeltmesi
aşağıda, "P1-A'nın çürüttükleri" başlığında.

Karışık bir kod tabanı — bazı göçler JS, bazıları SQL — gözden geçirenin ikisini birden bilmesini
gerektirir ve "bu politika gerçekte hangi SQL'e dönüşüyor?" sorusunu her incelemede yeniden
sordurur. Bu yüzden **tüm göçler `.sql`**; JS göçü yazmak yasak.

### 2. Araç: `node-pg-migrate` 9.0.0, sürücü `pg` 8.23.0

Araç bir _koşucu_ olarak seçildi, bir şema yöneticisi olarak değil. Aşağıdakiler paketin
**kendisinden** doğrulandı (npm tarball'ı açılıp `dist/` okundu; belgeye güvenilmedi):

| Gereksinim                       | Doğrulama                                                          |
| -------------------------------- | ------------------------------------------------------------------ |
| Ham `.sql` göç dosyaları         | ✅ tek dosya + `-- Up/Down Migration` işaretçisi, P1-A ile koşuldu |
| Eşzamanlı koşuya karşı kilit     | ✅ iki yarışan süreç, göç tam bir kez uygulandı (P1-A §6)          |
| Geçmiş tablosu adı ayarlanabilir | ✅ ama **yalnız `-t` CLI bayrağıyla**; config dosyasından değil    |
| Bağımlılık yüzeyi                | `glob`, `jiti`, `yargs` — üç doğrudan bağımlılık                   |

> **Bu tablonun ilk hâli üç satırda yanılıyordu ve üçü de aynı hatanın ürünüydü:** paketin
> `dist/`'inde bir fonksiyonun _var olduğunu_ görüp onun _devrede olduğu_ sonucuna varmak. Kaynağa
> bakmak, belgeye bakmakla aynı tuzağı taşıyor. Ayrıntısı aşağıda.

`prisma` ve `drizzle` elendi: ikisi de şemayı kendi modelinde sahiplenmek ister, oysa burada
şemanın sahibi SQL. `sqitch`/`flyway` elendi: monorepo'ya Node dışı bir çalışma zamanı sokuyorlar.
Kendi koşucumuzu yazmak elendi: kilit, sıralama ve kısmi-uygulama kurtarma doğru yapılması gereken
üç ayrı şey ve bunlar ayrıcalıklı bir yolda değil — ADR-0006'nın `sd_listen_fds`'i elle yazma
gerekçesi (root süreçte denetlenmemiş bağımlılık ağacı) buraya taşınmıyor.

### 3. İki hat, iki rol, tek yön

| Hat      | Rol             | Ne yapar                                               |
| -------- | --------------- | ------------------------------------------------------ |
| Göç      | `depsis_owner`  | DDL, politika, GRANT. Yalnız deploy sırasında çalışır. |
| Uygulama | `depsis_app`    | Yalnız DML. DDL yetkisi yok.                           |
| Yedek    | `depsis_backup` | Yalnız okuma.                                          |

Göç bağlantı dizesi (`DEPSIS_MIGRATION_DATABASE_URL`) ile uygulama bağlantı dizesi
(`DEPSIS_DATABASE_URL`) **ayrı ortam değişkenleridir**. Aynı değişkeni paylaşsalardı, uygulamanın
sahip rolüyle bağlanması bir yapılandırma hatası kadar yakın olurdu — ADR-0013'ün açıkça
yasakladığı şey.

**Rol ve veritabanı oluşturmak göç değildir.** Bunlar `packages/db/bootstrap.sql`'de, bir kez, bir
superuser tarafından yapılır. Gerekçe pratikte ortaya çıktı: `CREATE ROLE` superuser veya
`CREATEROLE` ister, dolayısıyla `depsis_owner`'ı oluşturan bir göç `depsis_owner`'dan daha güçlü
bir rolle koşmak zorunda kalırdı — ve sonraki her göç o gücü sebepsiz devralırdı. Göç bunun yerine
ön koşullarını **kontrol eder** ve eksikse ne yapılacağını söyleyen bir hatayla durur.

`depsis_owner` `NOLOGIN` **değildir** ama parolası yalnız deploy ortamında bulunur. Bunu bir
güvenlik kontrolü olarak sunmuyoruz: aynı makinede `psql` çalıştırabilen biri zaten oradadır. Amaç,
uygulamanın **kazara** sahip rolüyle bağlanmasını imkânsız kılmak.

### 3a. Göç dosyası düzeni: tek dosya, işaretçili — ayrı `.up`/`.down` değil

Bu ADR ilk yazıldığında göçler `0001_foundation.up.sql` + `0001_foundation.down.sql` çifti olarak
tasarlanmıştı. P1-A ölçtü: node-pg-migrate 9.0.0'ın `.sql` için **varsayılan stratejisi
`legacySql`** ve orada **bir dosya bir göçtür**; `.up`/`.down` sonekleri hiçbir anlam taşımaz.

Sonuç sessizdi. Boş bir veritabanında `up` komutu önce `0001_foundation.down.sql`'i (alfabetik
olarak `.up`'tan önce gelir), sonra `0001_foundation.up.sql`'i uyguladı, geçmişe **iki** kayıt yazdı
ve "Migrations complete!" diyerek sıfırla çıktı. Zararsız kalmasının tek sebebi o down dosyasının
tamamen `DROP ... IF EXISTS` olması ve boş bir şemaya çarpmasıydı.

İkinci bir göçle zararsız olmazdı: sıralı düzen `0001.down, 0001.up, 0002.down, 0002.up` olur, yani
**her deploy 0002'nin geri almasını 0001'in az önce kurduğu şemaya karşı koşar.** Zaten verisi olan
bir kümede — ki bu projenin kendi test VM'i tam o durumdaydı — ilk gerçek deploy bütün kiracı
satırlarını düşürür, tabloları boş yeniden yaratır ve sıfırla çıkardı.

Çiftleri gerçekten eşleyen yükleyici (`builtInLoaders.sql`) yalnızca `migrationLoaderStrategies`
ile seçilebiliyor, ve P1-A CLI'ın bu seçeneği **denenen her config dosyası şeklinde yok saydığını**
ölçtü. Yani çift düzeni komut satırından erişilemez.

Bu yüzden düzen **tek dosya + `-- Up Migration` / `-- Down Migration` işaretçisi**: aracın
varsayılanı, hiçbir yapılandırma gerektirmiyor, ve bütün hata sınıfını yapısal olarak imkânsız
kılıyor — ileri koşulabilecek ayrı bir down dosyası yok.

### 3b. Config dosyası yok; her ayar açık bir CLI bayrağı

`migrate.config.js` silindi. P1-A iki şey ölçtü: CLI bir config dosyasını **yalnız `-f` verilirse**
okuyor (hiçbir betiğimiz vermiyordu, dolayısıyla dosya tamamen ölüydü ve geçmiş varsayılan
`pgmigrations` tablosuna yazılıyordu), ve `-f` verilse bile `migrationsTable` ile
`migrationLoaderStrategies` denenen hiçbir şekilde işlemiyordu.

Okunmayan bir config dosyası hiç olmamasından kötüdür: davranışın ikinci, inandırıcı görünen ama
hiç gerçekleşmeyen bir tarifidir — bu projenin başka yerde "iki gerçeklik" diye yasakladığı şeyin
ta kendisi. Ayarlar artık `package.json`'daki üç betikte, açıkça:

    node-pg-migrate -d DEPSIS_MIGRATION_DATABASE_URL -m migrations -t depsis_migrations \
                    --advisory-lock-mode wait --no-single-transaction <up|down>

`--advisory-lock-mode`'un varsayılanı `fail`, `--single-transaction`'ın varsayılanı `true`. İkisi de
bu ADR'nin istediğinin tersi, ve config dosyası okunmadığı için sessizce yürürlükteydiler.

### 4. Organizasyon oluşturmak bir operatör işlemidir, API işlemi değil

Bu, 0001'i koşarken zorunlu hale geldi (aşağıdaki kanıt bölümü). `organizations` üzerinde
`depsis_app`'in yalnızca **okuma** politikası ve yalnızca `SELECT` yetkisi var; kiracı yaratmak
`depsis_owner` ile yapılır. Alternatif — uygulamaya `INSERT` vermek — bir API hatasının kiracı
basabilmesi demekti, ve zaten `id = current_organization_id()` politikasıyla mantıksal olarak
imkânsızdı: henüz var olmayan bir kiracının bağlamı olamaz.

### 5. Her göçün bir `down`'ı var, ve `down` test edilir

Aracın çift dosya düzeni bunu ucuzlatıyor. Geri alınamayan bir göç (veri kaybı içeren) yazılabilir,
ama `down` dosyası o zaman **açıkça başarısız olmalı** ve nedenini söylemelidir — sessizce boş bir
`down` bırakmak, geri alınabilir sanılan bir göçtür.

## Kanıt

| İddia                                                                | Güven                                               |
| -------------------------------------------------------------------- | --------------------------------------------------- |
| `node-pg-migrate` 9.0.0, `engines.node >= 20.11.0`                   | verified — npm registry, 2026-08-19                 |
| `pg` 8.23.0, `engines.node >= 16.0.0`                                | verified — npm registry, 2026-08-19                 |
| peer aralığı `pg >=4.3.0 <9.0.0` — 8.23.0 karşılıyor                 | verified — paketin `package.json`'ı                 |
| `.sql` çifti, advisory lock, ayarlanabilir geçmiş tablosu            | verified — paketin `dist/`'i okundu                 |
| `unaccent` niteliksiz çağrısı ayrı oturumda indeks kurarken patlıyor | verified — [P0-H](evidence/p0-h.tsv)                |
| `FORCE` olmadan sahip rolü RLS'i atlıyor                             | verified — [P0-C](evidence/p0-c.tsv)                |
| Kısmi uygulanmış bir göç **applied olarak kaydedilmiyor**            | ✅ [P1-A](evidence/p1-a.tsv) §5                     |
| İki eşzamanlı göç advisory lock ile serileşiyor                      | ✅ [P1-A](evidence/p1-a.tsv) §6                     |
| `down` sonrası şema gerçekten geri dönüyor (`pg_dump` farkı boş)     | ✅ [P1-A](evidence/p1-a.tsv) §4                     |
| `depsis_app` göçten sonra DDL yapamıyor                              | ✅ [P1-A](evidence/p1-a.tsv) §3                     |
| `uuidv7()` kimliklerinin monoton arttığı                             | **unverified** — ölçmeye çalışıldı, test kusurluydu |

### 0001'in gerçek bir PG 18.6 kümesinde ölçülenleri (2026-08-19)

`bootstrap.sql` superuser ile, göç `SET ROLE depsis_owner` altında koşuldu; ardından davranış
`depsis_app` ile sınandı.

| Ölçüm                                                                   | Sonuç |
| ----------------------------------------------------------------------- | ----- |
| `down` sonra `up` — ikisi de hatasız                                    | ✅    |
| `SET LOCAL` olmadan sorgu **sıfır satır** (fail-closed)                 | ✅    |
| A bağlamında yalnız A'nın satırları; B bağlamında yalnız B'nin          | ✅    |
| Var olmayan bir organizasyon kimliği ile sıfır satır                    | ✅    |
| `depsis_app` DDL yapamıyor (`permission denied for schema public`)      | ✅    |
| `depsis_app` `organizations`'a yazamıyor (yetki **ve** politika)        | ✅    |
| A, B'nin kullandığı e-postayı ekleyebiliyor — çapraz kiracı sızıntı yok | ✅    |
| Aynı kiracıda büyük/küçük harf farkıyla tekrar reddediliyor             | ✅    |
| Başka kiracının satırını yazma denemesi RLS politikasıyla reddediliyor  | ✅    |
| `updated_at` tetikleyicisi çalışıyor                                    | ✅    |

**0001'i yazarken değil, koşarken bulunan iki hata:**

1. **`uuidv7()` `pg_catalog`'ta, `public`'te değil.** Ön koşul kontrolü doğru yazılmıştı, sütun
   varsayılanları yanlış — yani kontrol geçiyor, sonra `CREATE TABLE` patlıyordu.
2. **`FORCE` açıkken sahip rolü için politika yoksa sahip hiçbir satıra dokunamıyor.** Daha kötüsü:
   `organizations` politikası satırın kimliğinin geçerli kiracıya eşit olmasını istiyordu, oysa
   yeni bir organizasyonun tanımı gereği henüz böyle bir bağlamı yok — **hiç kimse organizasyon
   oluşturamıyordu**. Tavuk-yumurta yalnızca şemayı çalıştırınca görünür oldu. Sahip için açık
   politika eklendi ve kiracılık modeli netleşti: organizasyon oluşturmak bir **operatör** işlemi,
   API işlemi değil.

### P1-A'nın çürüttükleri

Üçü de bu ADR'nin **`verified` diye işaretlediği** iddialardı.

1. **"`.up.sql`/`.down.sql` çifti tanınıyor."** Tanınmıyor — varsayılan yükleyici öyle çalışmıyor
   (§3a). İddia paketin `dist/`'inde `parseSqlFile`'ı görüp yazılmıştı. Bir fonksiyonun kaynakta
   bulunması, o fonksiyonun çağrıldığı anlamına gelmiyor; kaynağa bakmak belgeye bakmakla aynı
   tuzağı taşıyor ve bu ADR ona düştü.

2. **"Geçmiş tablosu adı config'den ayarlanabilir."** CLI bayrağından ayarlanabiliyor, config
   dosyasından değil — ve config dosyası zaten hiç okunmuyordu (§3b).

3. **"`unaccent` niteliksiz çağrısı ayrı oturumda ifade indeksi kurarken patlıyor, sebebi
   `search_path`."** Sebep bu değil. PostgreSQL 18'de `unaccent`'in **her iki aşırı yüklemesi de
   `STABLE`** (`provolatile='s'`, P1-A §7'de ölçüldü), dolayısıyla niteleme yapılsın yapılmasın
   ifade indeksinde kullanılamıyor: hata `functions in index expression must be marked IMMUTABLE`.

   P0-H'nin gerçekte ölçtüğü daha dar ve farklı: `depsis_norm is declared IMMUTABLE
(provolatile=i)` ve `an expression index on depsis_norm() can be created`. Ham bir `unaccent`
   çağrısı üzerine hiç indeks kurmadı. ADR-0010 §85 zaten "fonksiyon IMMUTABLE olmalı" diyor;
   **yanlış olan bu ADR'nin P0-H'ye yaptığı atıftı.** Şema niteleme gereksinimi sarmalayıcının
   _içindeki_ sözlük araması için geçerli, indeksin kendisi için değil.

   Çalışan desen P1-A §7'de koşuldu: sabit `search_path`'li `IMMUTABLE` bir SQL sarmalayıcı,
   gövdesinde `public.unaccent('public.unaccent'::regdictionary, …)`.

## P1-A — bu ADR'yi doğrulayacak PoC

1. Göç `depsis_owner` ile koşup bittikten sonra `depsis_app` gerçekten **DDL yapamıyor** mu?
2. Aynı anda başlatılan iki göç süreci advisory lock ile serileşiyor mu, yoksa ikisi de mi yazıyor?
3. Ortasında patlayan bir göç, geçmiş tablosunda **uygulanmış** görünüyor mu? (kısmi durum)
4. `down` koşulduktan sonra şema gerçekten başlangıç durumuna dönüyor mu? (yalnız "hata vermedi"
   değil — `pg_dump --schema-only` farkı boş mu?)
5. `public.unaccent(...)` nitelikli ifade indeksi göç oturumunda kuruluyor mu?

### 0001'in koşarken bulunan diğer iki hatası

Bu ikisi şemanın kendisindeydi ve yalnızca gerçek bir kümede ölçülünce göründü.

4. **`lower(email)` Türkçe noktalı İ'yi katlamıyor.** `bootstrap.sql`'in kurduğu ICU
   veritabanında `lower('İsmail')` = `i` + U+0307 + `smail`, `lower('ismail')`'e **eşit değil**
   (ölçüm: P1-A §9). `UNIQUE (organization_id, lower(email))` bu yüzden `İsmail@firma.com` ile
   `ismail@firma.com`'u ayrı kovalara koyuyordu: aynı kiracıda tek adres için iki hesap, hiçbir
   katmanda hata yok — ve uygulamanın kendi "bu adres alınmış mı?" kontrolü de aynı ifadeyi
   kullanmak zorunda olduğu için hiçbir şey bulmuyor. Türkçe klavye büyük harfli biçimi kendiliğinden
   üretiyor.

   Çözüm `public.fold_identity()`: `NFKC` normalize → i-ailesi `translate` → `lower`, sonucu
   `GENERATED ... STORED` bir sütunda saklanıyor. **Aksan sökmüyor**, çünkü P0-H aramada
   `Çağrı`/`Cagri` çakışmasını ölçtü — arama için doğru, kimlik için ölümcül: iki farklı insanı tek
   hesapta birleştirirdi. P1-A §9 dört yönü de sınıyor: İ, ASCII, NFC/NFD, ve aksanların ayrı
   kalması.

5. **`CREATE UNIQUE INDEX` `pg_constraint`'te görünmüyor.** P0-C'nin, ADR-0013 §2.2'nin
   `organization_id` kuralını uygulayan denetimi `contype IN ('u','x')` tarıyor (p0-c satır 425), ve
   çıplak bir benzersiz indeksin `pg_constraint` satırı yok — P1-A §9'da ölçüldü. Yani 0001'in ilk
   hâlindeki iki benzersiz indeks o denetime **görünmezdi**, ve gelecekteki bir göç aynı deyimle
   global bir benzersiz indeks eklese denetim yine temiz raporlardı.

   İki taraflı düzeltildi: 0001'deki benzersizlikler artık `ALTER TABLE ... ADD CONSTRAINT` ile
   kuruluyor (ifade yerine üretilmiş sütun kullanıldığı için bu mümkün), ve P1-A `pg_index`
   üzerinden — `indisunique OR indisexclusion`, `pg_get_indexdef` ile ifade indeksleri dahil —
   çalışan bir denetim koşuyor.

## Sonuçlar

**Olumlu:** Şemanın tek gerçeği SQL dosyalarının kendisi; gözden geçiren tam olarak çalışacak şeyi
okuyor. Rol ayrımı ilk göçte kuruluyor, sonradan eklenmiyor (ADR-0013 bunu "yüksek maliyet" diye
işaretlemişti).

**Olumsuz / kabul edilen bedel:** Tip güvenliği yok — SQL ile TypeScript tipleri arasında derleyici
bağı bulunmuyor. Bu bilinçli: bağı kurmanın yolu şemayı bir DSL'e taşımaktan geçiyordu ve yukarıdaki
gerekçelerle o kapı kapalı. Yerine, sorgu katmanının tipleri `packages/contracts`'tan gelecek ve
şema ile uyumu **testle** doğrulanacak, derleyiciyle değil. Bu bir zayıflıktır ve öyle yazılmıştır.

**Bu kararın yasakladığı şeyler:**

- JS/TS göç dosyası yazılamaz; tüm göçler `.sql`.
- Uygulama `depsis_owner` ile bağlanamaz; ayrı ortam değişkeni zorunlu.
- `down` dosyası atlanamaz; geri alınamayan göç açıkça başarısız olmalı.
- Uygulanmış bir göç dosyası düzenlenemez — yeni göç yazılır. **İlk sürüme kadar tek istisna:**
  henüz hiçbir yere dağıtılmamış göçler düzenlenebilir, ama o zaman **her mevcut veritabanı
  sıfırdan kurulmalıdır.** Bu istisna ilk sürümle birlikte kalkar.

  Bunu yazmak gerekti çünkü tam olarak burada tökezlendi: `assert_rls_roles_sane` 0001'e sonradan
  eklendi, CI kapısı her koşuda veritabanını sıfırdan kurduğu için sorun görünmedi, ama uzun ömürlü
  test veritabanı eski 0001 ile kalmıştı ve 0003 "böyle bir fonksiyon yok" diyerek patladı. Kural
  düzenlemeyi yasaklıyordu; istisnayı yazmak yerine sessizce kullanmak, kuralın kendisini
  değersizleştirirdi.

- ORM veya şema DSL'i şemanın sahibi olamaz.

## Geri alma maliyeti

Düşük. Göçler ham SQL olduğu için başka bir koşucuya taşımak dosyaları kopyalamak ve geçmiş
tablosunu bir kez doldurmaktır. Asıl kilitlenme aracın kendisinde değil, **rol ayrımında** — ve o
ADR-0013'ün kararı, bunun değil.

## Güvenlik ve veri kaybı etkisi

Doğrudan R4 (kiracı sızıntısı) ile ilgili: RLS politikaları ve `FORCE` bu göçlerde kuruluyor, yani
bir göç hatası doğrudan bir izolasyon hatasıdır. Bu yüzden P1-A maddesi 1 bir tercih değil,
kapıdır. Veri kaybı açısından: `down` göçleri veri düşürebilir, bu nedenle üretimde `down`
çalıştırmak §0.5'in kapsamındadır — önizleme, uyarı ve açık onay olmadan otomatik koşturulamaz.
