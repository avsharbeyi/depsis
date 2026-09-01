-- Bir klasörün içindekilerin toplam boyutunu sorabilmek için.
--
-- ── NEDEN GEREKİYOR ──────────────────────────────────────────────────────────────────────────
--
-- Klasör satırında boyut hep "—" idi; içindeki öğe sayısı geldi, ama cihazın sahibinin istediği
-- şey ikisi birden: *"disk boyutu da görünecek yalnızca öğe sayısı değil."* Ve aynı sayı bir
-- yerde daha gerekiyor: bir klasörü arşivleyip indirmeden önce, arşivin diske sığıp sığmayacağı.
--
-- ── ALT AĞAÇ, `path` ÖNEKİYLE ────────────────────────────────────────────────────────────────
--
-- Her satır kendi tam yolunu taşıyor (`/a/b/c`), yani bir klasörün altındaki her şey tek bir
-- ARALIK sorgusu: `path >= '/a/b/' AND path < '/a/b0'`. Eğik çizginin bir sonraki karakteri `0`
-- olduğu için bu aralık tam olarak o alt ağacı kapsıyor ve komşusuna taşmıyor.
--
-- `LIKE '/a/b/%'` DEĞİL, ve fark önemli: önek satırın kendisinden geliyor, ve içinde `%` ya da
-- `_` olan bir klasör adı — ikisi de geçerli dosya adı — deseni joker'a çevirip başka klasörleri
-- de toplardı. Aralık karşılaştırması metni metin olarak okuyor.
--
-- ── İNDEKS ──────────────────────────────────────────────────────────────────────────────────
--
-- `text_pattern_ops`: veritabanının harmanlaması Türkçe olduğunda `<` karşılaştırması bayt sırası
-- değil dil sırası demek, ve o sırada `/a/b/` ile `/a/b0` arasındaki aralık beklenen satırları
-- kapsamaz. `text_pattern_ops` karşılaştırmayı bayt sırasına sabitliyor — aralığın anlamlı
-- olmasının tek yolu bu.

-- Up Migration

SELECT public.assert_rls_roles_sane();

CREATE INDEX IF NOT EXISTS file_entries_share_path_prefix
  ON public.file_entries (share_id, path text_pattern_ops)
  WHERE trashed_at IS NULL;

-- Down Migration

DROP INDEX IF EXISTS public.file_entries_share_path_prefix;
