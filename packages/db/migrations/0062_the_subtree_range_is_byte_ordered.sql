-- 0062 — Alt ağaç aralığı gerçekten bayt sırasına otursun.
--
-- ── 0048'İN YORUMU YANLIŞTI ─────────────────────────────────────────────────────────────────
--
-- 0048 bir klasörün altındaki her şeyi tek bir aralıkla topluyor:
--
--   d.path >= f.path || '/'  AND  d.path < f.path || '0'
--
-- ve indeksi `text_pattern_ops` ile kurup şunu yazdı: *"`text_pattern_ops` karşılaştırmayı bayt
-- sırasına sabitliyor — aralığın anlamlı olmasının tek yolu bu."* Bu cümle iki kere yanlış.
--
-- Bir opclass bir SORGUYU değiştirmez, yalnız bir indeksin hangi operatörleri karşılayabileceğini
-- söyler. `text_pattern_ops` `~<~`, `~<=~`, `~>=~`, `~>~` ve `LIKE` önekini karşılıyor; sorgudaki
-- düz `<` ve `>=` operatörlerini karşılamıyor. Yani (a) karşılaştırma hâlâ veritabanının
-- harmanlamasıyla — `bootstrap.sql` veritabanını ICU `und-x-icu` ile kuruyor — yapılıyor, ve
-- (b) o indeks bu sorgular tarafından hiç seçilemiyor, yani yalnız yazma maliyeti.
--
-- ── BUNUN GÖRÜNEN HÂLİ ──────────────────────────────────────────────────────────────────────
--
-- ICU kök harmanlamasında noktalama ve simgeler "değişken ağırlıklı": `&`, `+`, `%`, `~`, `#`,
-- `$`, `=`, `€` ve harf büyüklüğü, `/` ile `0` arasındaki aralığa DÜŞÜYOR. Yani `Fotograflar`
-- klasörünün alt ağacı, yanındaki `Fotograflar+yedek.zip` dosyasını ve `Fotograflar&eski`
-- klasörünü de topluyor:
--
--   * klasör satırında görünen boyut, komşusunun baytları kadar fazla,
--   * arşivlemeden önceki "diske sığar mı" kontrolü aynı şişmiş toplamla karar veriyor ve
--     sığacak bir klasörü "yer yok" diye reddedebiliyor.
--
-- ── DÜZELTME İKİ PARÇA ──────────────────────────────────────────────────────────────────────
--
-- Bu göç indeksi kuruyor: `(share_id, path COLLATE "C")`. `C` harmanlaması BAYT sırası, yani
-- `/` (0x2F) ile `0` (0x30) arasında başka hiçbir şey yok ve aralık tam olarak alt ağaç.
--
-- ÖTEKİ PARÇA SORGUDA, ve bu göç onu yapamaz: `files.service.ts` içindeki iki aralık — alt ağaç
-- boyutu ve arşiv yer kontrolü — her iki tarafı da `COLLATE "C"` ile yazmalı:
--
--   AND d.path COLLATE "C" >= (f.path || '/') COLLATE "C"
--   AND d.path COLLATE "C" <  (f.path || '0') COLLATE "C"
--
-- İfade indekstekiyle BİREBİR aynı olmadıkça planlayıcı bu indeksi seçmez. O değişiklik yapılana
-- kadar aralık hâlâ ICU sırasında ve indeks yine kullanılmıyor — bu göç tek başına bir hızlanma
-- değil, doğru sorgunun kurulabileceği zemin.
--
-- ── ESKİ İNDEKS DÜŞÜYOR ─────────────────────────────────────────────────────────────────────
--
-- `file_entries_share_path_prefix` hiçbir sorgu tarafından kullanılmıyor (yukarıdaki sebep) ve
-- `file_entries` bu ürünün en çok yazılan tablosu: her dizin turu, her kopya, her yükleme onu
-- güncelliyor. Kazandırmadığı bir sıralamayı her yazmada ödemenin sebebi yok. Down onu geri
-- kuruyor.

-- Up Migration

SELECT public.assert_rls_roles_sane();

CREATE INDEX IF NOT EXISTS file_entries_share_path_c
  ON public.file_entries (share_id, path COLLATE "C")
  WHERE trashed_at IS NULL;

COMMENT ON INDEX public.file_entries_share_path_c IS
  'Alt ağaç aralığı: `path COLLATE "C" >= f.path || ''/''` ve `< f.path || ''0''`. Harmanlama '
  'indeksin ANAHTARINDA, çünkü veritabanı ICU ile kurulu ve o sırada `&`, `+`, `%`, `~`, `€` '
  'gibi karakterler `/` ile `0` arasına düşerek kardeş dosyaları alt ağaca sokuyor. Sorgu '
  'karşılaştırmayı da `COLLATE "C"` ile yazmalı; yoksa planlayıcı bu indeksi seçemez.';

DROP INDEX IF EXISTS public.file_entries_share_path_prefix;

-- Down Migration

CREATE INDEX IF NOT EXISTS file_entries_share_path_prefix
  ON public.file_entries (share_id, path text_pattern_ops)
  WHERE trashed_at IS NULL;

DROP INDEX IF EXISTS public.file_entries_share_path_c;
