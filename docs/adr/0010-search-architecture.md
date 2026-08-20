# ADR-0010: Arama mimarisi ve Türkçe normalizasyon

- **Durum:** **Accepted** — P0-H koştu ve geçti (2026-08-14), kanıt: [`evidence/p0-h.tsv`](evidence/p0-h.tsv)
- **Tarih:** 2026-08-14
- **Faz:** 0
- **Etkilenen bileşenler:** `apps/api/src/search`, `deploy/migrations`, `apps/web` arama kutusu

## Bağlam

§5.3 kullanıcı yazarken çalışan arama istiyor; §18.2 sıcak indekste p95 < 300 ms hedefliyor.
§15 Türkçe varsayılan dil. Türkçe'nin noktalı/noktasız `i` sorunu (`I/ı`, `İ/i`) bunu sıradan bir
arama probleminden çıkarıyor.

Temel: PostgreSQL 18 (ADR-0013).

## Bulunan gerçek

### Non-deterministic ICU collation bir çıkmaz sokak

Kickoff'ta "case-insensitive + accent-insensitive ICU collation kur, bitsin" varsayımı vardı.
Araştırma bunu hem doğruladı hem çürüttü:

| Operatör                | PG 17             | PG 18                      |
| ----------------------- | ----------------- | -------------------------- |
| `LIKE`                  | ❌ desteklenmiyor | ✅ **destekleniyor**       |
| `ILIKE`                 | ❌                | ❌ **hâlâ desteklenmiyor** |
| `SIMILAR TO`            | ❌                | ❌                         |
| POSIX regex (`~`, `~*`) | ❌                | ❌                         |

PG 18 belgesi birebir: _"SIMILAR TO and POSIX-style regular expressions do not support
nondeterministic collations."_ Ve `ILIKE` için: _"(But this does not support nondeterministic
collations.)"_

Daha önemlisi: **`LIKE`'ın izinli olması, `pg_trgm` ile indekslenebilir olması demek değil.**
`pg_trgm` belgeleri non-deterministic collation konusunda **sessiz** — yani indeks kullanılabilirliği
**doğrulanmamış**.

Ek belgelenmiş bedeller: yalnız `provider=icu` ile mümkün; _"their use leads to a performance
penalty"_; ve _"B-tree cannot use deduplication with indexes that use a nondeterministic
collation"_ — yani daha büyük, daha az verimli B-tree indeksleri.

**Sonuç: non-deterministic collation arama yolunda kullanılmayacak.**

### Türkçe FTS yapılandırması var

`pg_catalog.turkish` snowball yapılandırması Debian'ın `postgresql-17` paketinde mevcut
(`/usr/share/postgresql/17/tsearch_data/turkish.stop` doğrulandı). Yani stemmer + stopword için
üçüncü taraf gerekmiyor.

### `pg_trgm`'in ilk iki tuş vuruşunda çöktüğü nokta

`pg_trgm` **çıkarılabilir trigram olmayan** desenlerde ciddi biçimde bozulur — yani 3 karakterden
kısa arama dizelerinde. Bir dosya adı arama kutusunda bu **tam olarak ilk iki tuş vuruşudur**.

## Karar

### Normalize edilmiş arama kolonu + `pg_trgm` GIN

Collation'a değil, **veriye** normalizasyon uygulanır:

```sql
CREATE FUNCTION depsis_norm(txt text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT lower(
           public.unaccent('public.unaccent'::regdictionary,
             translate(normalize(txt, NFKC),
                       'İIıŞşĞğÜüÖöÇç',
                       'iiissgguuoocc')
           )
         )
$$;
```

Kritik ayrıntılar:

- **`translate()` `lower()`'dan ÖNCE gelir.** PostgreSQL'in `lower()`'ı Türkçe'nin nokta
  kuralını uygulamaz; `İ` → `i̇` (birleşen nokta) üretebilir. Türkçe'ye özgü harfler önce ASCII'ye
  eşlenir, sonra küçültülür.
- **Hedef dize tamamen küçük harf.** Bu ADR'nin ilk taslağı küçük Türkçe harfleri **büyük**
  ASCII'ye eşliyordu (`ş`→`S`, `ğ`→`G`, `ü`→`U`, `ö`→`O`, `ç`→`C`). Sonuç yine doğru çıkıyordu,
  ama yalnız `lower()` sonradan koştuğu için — yani tesadüfen. Boru hattını yeniden sıralayan
  biri her aramayı sessizce bozardı. Fonksiyon çevresindeki çağrılardan **bağımsız olarak**
  doğru olmalı; bu yüzden iki taraf da küçük harf. (P0-H yazılırken fark edildi.)
- `normalize(txt, NFKC)` Unicode denkliğini toplar — aynı görünen iki farklı kodlama aynı satıra düşer.
- Fonksiyon **`IMMUTABLE`** olmalı, yoksa ifade indeksi kurulamaz. Tek argümanlı `unaccent()`
  `STABLE`'dır; bu yüzden sözlük **açıkça** verilir.
- **Hem fonksiyon hem sözlük şema ile nitelenmelidir** (`public.unaccent`,
  `'public.unaccent'::regdictionary`). Bu, P0-H'de ampirik olarak bulundu ve sinsi bir tuzaktır:
  niteliksiz biçim düz sorguda çalışır, `GENERATED STORED` kolonda da çalışır, ve fonksiyonun
  oluşturulduğu oturumda ifade indeksi kurmaya bile izin verir. **Yalnız ayrı bir oturumda
  indeks kurarken** patlar — çünkü PostgreSQL indeks kurulumu sırasında `search_path`'i
  kısıtlar ve `public` aranmaz. Migration'lar tam olarak böyle çalıştığı için bu, üretimde
  ortaya çıkacak bir hataydı.

  Ölçülen davranış (PG 18.6, ayrı oturumda `CREATE INDEX`):

  | Biçim                                                  | Sonuç                                                 |
  | ------------------------------------------------------ | ----------------------------------------------------- |
  | `unaccent('unaccent', x)`                              | ❌ `function unaccent(unknown, text) does not exist`  |
  | `unaccent('unaccent'::regdictionary, x)`               | ❌ `text search dictionary "unaccent" does not exist` |
  | `public.unaccent('public.unaccent'::regdictionary, x)` | ✅                                                    |
  | `public.unaccent(x)` (tek argüman)                     | ✅ ama `STABLE` riski taşır                           |

  **Ölçüm (P1-A §7, PG 18.6):** `unaccent`'in **her iki** aşırı yüklemesi de `provolatile='s'`.
  Yani yukarıdaki ✅'ler yalnızca _çağrının çözülmesi_ içindir; hiçbiri doğrudan bir ifade
  indeksinde kullanılamaz — ikisi de `functions in index expression must be marked IMMUTABLE`
  veriyor. §85'in `IMMUTABLE` sarmalayıcı şartı bu yüzden isteğe bağlı değil, tek yol. Niteleme
  şartı da sarmalayıcının _gövdesi_ için geçerli: indeks derlemesi kısıtlı `search_path` ile koştuğu
  için sözlük orada nitelenmezse bulunamıyor.

Şema:

```sql
ALTER TABLE file_entries
  ADD COLUMN name_norm text GENERATED ALWAYS AS (depsis_norm(name)) STORED;

CREATE INDEX file_entries_name_norm_trgm
  ON file_entries USING gin (name_norm gin_trgm_ops);

CREATE INDEX file_entries_name_norm_prefix
  ON file_entries (organization_id, parent_id, name_norm text_pattern_ops);
```

`GENERATED … STORED` kolon, uygulamanın normalizasyonu unutmasını **imkânsız** kılar.

### Sorgu stratejisi — uzunluğa göre dallanır

`pg_trgm`'in kısa desen zaafı sessizce kabul edilmez, **etrafından dolaşılır**:

| Girdi uzunluğu   | Yol                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| **1–2 karakter** | Yalnız **prefix** araması: `name_norm LIKE 'ab%'` → B-tree `text_pattern_ops` indeksi. Trigram'a hiç gidilmez |
| **≥ 3 karakter** | `name_norm LIKE '%abc%'` → `gin_trgm_ops`; skorlama için `similarity()`                                       |

İkisi de kapsam (`organization_id`, `parent_id`) filtresiyle birleşir ve **RLS altında** koşar.

### ILIKE yasak

Kolon zaten normalize ve küçük harf olduğu için `ILIKE`'a gerek yok. `ILIKE` kullanmak indeksi
atlar ve non-deterministic collation'la zaten çalışmaz. `LIKE` + normalize kolon tek yoldur.

### İçerik araması ayrı

Dosya **adı** araması yukarıdaki gibi. Dosya **içeriği** (§5.3 opsiyonel) `tsvector` +
`pg_catalog.turkish` ile ayrı bir kolon/tabloda, kullanıcı/klasör politikasıyla açılır. İkisi
karıştırılmaz — ad araması her zaman çalışır, içerik araması opsiyoneldir.

### UI sözleşmesi

150–250 ms debounce; önceki istek `AbortController` ile iptal. Cursor pagination.
**Sonuç sayısı, öneri ve hata metni ACL kapsamından üretilir** — §18.2'nin sızıntı kriteri
sonuç listesi kadar sayaçlar için de geçerlidir.

## Kanıt

| İddia                                                                                     | Güven                                                                |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| PG 18 `LIKE`'ı non-det collation'da destekliyor; `ILIKE`/`SIMILAR TO`/regex desteklemiyor | verified                                                             |
| PG 17 hiçbirini desteklemiyor                                                             | verified                                                             |
| Non-det collation: yalnız ICU, performans bedeli, B-tree deduplication yok                | verified                                                             |
| `pg_catalog.turkish` snowball config Debian paketinde mevcut                              | verified                                                             |
| `pg_trgm` 3 karakterden kısa desenlerde bozulur                                           | verified                                                             |
| **`pg_trgm`'in non-det collation'lı kolonu indeksleyip indeksleyemediği**                 | **unverified** (seçilen tasarım bundan kaçındığı için bloke etmiyor) |
| `depsis_norm`'un Türkçe kenar durumlarındaki doğruluğu                                    | **unverified → P0-H**                                                |
| p95 < 300 ms hedefi                                                                       | **unverified → P0-H** (donanıma bağlı, belge kanıtlayamaz)           |

## P0-H — bu ADR'yi doğrulayacak PoC

1. `depsis_norm` Türkçe kenar durumlarını doğru çözüyor mu?
   `İstanbul`/`istanbul`/`ISTANBUL`/`ıstanbul`, `Şişli`/`sisli`, `Çağrı`/`cagri`,
   ve NFC vs NFD kodlanmış aynı ad → hepsi aynı `name_norm` üretmeli.
2. Fonksiyon gerçekten `IMMUTABLE` mi (ifade indeksi kurulabiliyor mu)?
3. 1M `file_entries` satırında: 1, 2, 3 ve 5 karakterlik sorgularda p95 nedir?
   `EXPLAIN (ANALYZE, BUFFERS)` ile hangi indeksin seçildiği doğrulanır.
4. Prefix yolu 1–2 karakterde gerçekten B-tree kullanıyor, seq scan'e düşmüyor mu?
5. RLS açıkken plan değişiyor mu, p95 hedefi hâlâ tutuyor mu?
6. Kiracı A'nın sorgusu, kiracı B'nin dosya adını **sonuç sayısında bile** sızdırmıyor mu?

## Sonuçlar

**Olumlu:** Collation tuzağından tamamen kaçınılıyor. Normalizasyon `GENERATED STORED` ile
uygulama hatasına kapalı. Kısa sorgu zaafı sessizce yaşanmak yerine ayrı bir yola ayrılıyor.

**Olumsuz / kabul edilen bedel:** Her dosya adı için ikinci bir kolon (depolama + yazma maliyeti).
Normalizasyon kayıplıdır: `Çağrı` ve `Cagri` aynı satıra düşer — arama için istenen davranış, ama
`name_norm` **asla** benzersizlik veya kimlik için kullanılamaz.

**Bu kararın yasakladığı şeyler:**

- Non-deterministic collation arama yolunda kullanılamaz.
- `ILIKE` kullanılamaz.
- `depsis_norm` `IMMUTABLE` olmaktan çıkarılamaz.
- `name_norm` benzersizlik kısıtında veya kimlik olarak kullanılamaz.
- 3 karakterden kısa sorgu trigram indeksine gönderilemez.
- Arama sonuç sayısı ACL kapsamı dışından hesaplanamaz.

## Geri alma maliyeti

Düşük–orta. `depsis_norm` değişirse `GENERATED` kolon ve GIN indeksi yeniden üretilir — 1M satırda
maliyetli ama tek seferlik ve migration ile yapılabilir.

## Güvenlik ve veri kaybı etkisi

Aramanın §18.2 sızıntı kriterine uyması bu ADR'nin sorumluluğunda. En kolay atlanan nokta
**sonuç sayacı**: filtrelenmiş bir liste dönerken toplam sayının filtrelenmemiş hesaplanması,
kiracı B'nin dosya varlığını sızdırır. Bu ADR-0013 §2.2'deki covert channel bulgusunun arama
katmanındaki karşılığıdır ve aynı testle kontrol edilir.
