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
- İfade indeksleri: `public.unaccent('public.unaccent'::regdictionary, name)`

Sonuncusu özellikle öğretici. P0-H, `unaccent(...)` niteliksiz çağrısının sorgularda ve
`GENERATED` sütunlarda çalıştığını ama **ayrı bir oturum ifade indeksi kurarken başarısız
olduğunu** ölçtü: indeks derlemesi sırasında `search_path` kısıtlanıyor. Bir DSL'in ürettiği SQL'i
bu ayrıntıya zorlamak, DSL'i kullanmamaktan daha zahmetli.

Karışık bir kod tabanı — bazı göçler JS, bazıları SQL — gözden geçirenin ikisini birden bilmesini
gerektirir ve "bu politika gerçekte hangi SQL'e dönüşüyor?" sorusunu her incelemede yeniden
sordurur. Bu yüzden **tüm göçler `.sql`**; JS göçü yazmak yasak.

### 2. Araç: `node-pg-migrate` 9.0.0, sürücü `pg` 8.23.0

Araç bir _koşucu_ olarak seçildi, bir şema yöneticisi olarak değil. Aşağıdakiler paketin
**kendisinden** doğrulandı (npm tarball'ı açılıp `dist/` okundu; belgeye güvenilmedi):

| Gereksinim                       | Doğrulama                                                         |
| -------------------------------- | ----------------------------------------------------------------- |
| Ham `.sql` göç dosyaları         | `parseSqlFile` `<id>.up.sql` / `<id>.down.sql` çiftlerini tanıyor |
| Eşzamanlı koşuya karşı kilit     | `pg_advisory_lock` çağrısı `dist/bundle/index.js`'te mevcut       |
| Geçmiş tablosu adı ayarlanabilir | `migrationsTable` seçeneği mevcut                                 |
| Bağımlılık yüzeyi                | `glob`, `jiti`, `yargs` — üç doğrudan bağımlılık                  |

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
| Kısmi uygulanmış bir göçten kurtarma davranışı                       | **unverified** → P1-A ile ölçülecek                 |
| İki eşzamanlı göç sürecinin advisory lock ile serileştiği            | **unverified** → P1-A ile ölçülecek                 |
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

## P1-A — bu ADR'yi doğrulayacak PoC

1. Göç `depsis_owner` ile koşup bittikten sonra `depsis_app` gerçekten **DDL yapamıyor** mu?
2. Aynı anda başlatılan iki göç süreci advisory lock ile serileşiyor mu, yoksa ikisi de mi yazıyor?
3. Ortasında patlayan bir göç, geçmiş tablosunda **uygulanmış** görünüyor mu? (kısmi durum)
4. `down` koşulduktan sonra şema gerçekten başlangıç durumuna dönüyor mu? (yalnız "hata vermedi"
   değil — `pg_dump --schema-only` farkı boş mu?)
5. `public.unaccent(...)` nitelikli ifade indeksi göç oturumunda kuruluyor mu?

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
- Uygulanmış bir göç dosyası düzenlenemez — yeni göç yazılır.
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
