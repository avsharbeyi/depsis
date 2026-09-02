-- `allocate_posix_id`in advisory lock'u geri geliyor.
--
-- ── NE OLDU ──────────────────────────────────────────────────────────────────────────────────
--
-- 0017 fonksiyonun içine `PERFORM pg_advisory_xact_lock(4919115)` koymuştu ve gerekçesini uzun
-- uzun yazmıştı: `MAX(...) + 1` hiçbir kilit almıyor, iki eşzamanlı işlem aynı maksimumu görüyor
-- ve ikincisi `teams_posix_gid_unique` ya da `users_posix_uid_unique` ile 23505 alıyor. Kilit
-- gerekiyordu çünkü `everyone_team()` SIRADAN BİR İSTEKTEN çağrılıyor (`FilesService.defaultShare`,
-- ilk `GET /files`), yani eşzamanlı ayırma olağan durum.
--
-- 0049 fonksiyonu yeniden tanımlarken — emekli numaraları hesaba katmak için — metnini 0015'ten
-- türetti ve o satırı SESSİZCE DÜŞÜRDÜ. Fonksiyonun COMMENT'i ise 0017'den kalma ve hâlâ "işlem
-- kapsamlı bir advisory lock ile serileştirilmiştir" diyor: yorum yalan söylemeye başladı.
--
-- ── NEDEN UYGULAMA KATMANINDAKİ KİLİT YETMİYOR ───────────────────────────────────────────────
--
-- `PosixIdentityService.allocateWithin` çağırmadan önce `pg_advisory_xact_lock($1, $2)` alıyor —
-- ama o İKİ ARGÜMANLI hâli, ve PostgreSQL'de iki argümanlı ile tek argümanlı advisory lock'lar
-- AYRI UZAYLAR: birbirlerini beklemiyorlar. Üstelik `everyone_team()` saf SQL, yani o sarmalayıcıdan
-- hiç geçmiyor.
--
-- Bu yüzden 0049'dan sonra koruma yalnızca "TypeScript'ten açılan hesaplar birbirini bekliyor"a
-- indi, ve `everyone_team` ile aynı anda koşan her şey korumasız kaldı. CI bunu yakaladı:
-- `duplicate key value violates unique constraint "teams_posix_gid_unique"`.
--
-- ── SATIRDAN BAŞKA BİR ŞEY DEĞİŞMİYOR ────────────────────────────────────────────────────────
--
-- Gövde 0049'unki: üç kaynak (kullanıcılar, ekipler, EMEKLİ numaralar). Eklenen tek şey, 0017'nin
-- ilk satırı.

-- Up Migration

SELECT public.assert_rls_roles_sane();

CREATE OR REPLACE FUNCTION public.allocate_posix_id(kind text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  next_id integer;
BEGIN
  IF kind NOT IN ('user', 'team') THEN
    RAISE EXCEPTION 'kind must be user or team' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 0017'den, ve 0049'da düşmüştü. Sabit, `hashtext` değil: `hashtext`in çıktısı PostgreSQL
  -- sürümleri arasında sabit olmak zorunda değil, ve iki farklı sürüm çalıştıran iki bağlantı
  -- farklı kilitler alırsa kilit yokmuş gibi olur.
  PERFORM pg_advisory_xact_lock(4919115);

  -- Tek bir sayaç, üç kaynak. Üçüncüsü 0049'dan: EMEKLİ numaralar. Onlar olmadan bir hesabı silmek
  -- numarasını serbest bırakır, ve diskte o numarayla damgalı dosyalar bir sonraki kullanıcıya
  -- geçer.
  SELECT COALESCE(MAX(id_value), 299999) + 1 INTO next_id
    FROM (
      SELECT posix_uid AS id_value FROM public.users WHERE posix_uid IS NOT NULL
      UNION ALL
      SELECT posix_gid FROM public.teams WHERE posix_gid IS NOT NULL
      UNION ALL
      SELECT id_value FROM public.retired_posix_ids
    ) AS taken;

  IF next_id > 399999 THEN
    RAISE EXCEPTION 'the reserved POSIX id range is exhausted'
      USING ERRCODE = 'program_limit_exceeded';
  END IF;

  RETURN next_id;
END
$$;

REVOKE ALL ON FUNCTION public.allocate_posix_id(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.allocate_posix_id(text) TO depsis_app;

-- Down Migration

-- 0049'un hâli: kilitsiz. Geri almanın anlamı "yarışı geri getir" olduğu için burada başka bir şey
-- yapılacak bir şey yok — geri alma zincirinin dürüst olması, geri aldığı şeyi aynen geri
-- getirmesi demek.
CREATE OR REPLACE FUNCTION public.allocate_posix_id(kind text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  next_id integer;
BEGIN
  IF kind NOT IN ('user', 'team') THEN
    RAISE EXCEPTION 'kind must be user or team' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT COALESCE(MAX(id_value), 299999) + 1 INTO next_id
    FROM (
      SELECT posix_uid AS id_value FROM public.users WHERE posix_uid IS NOT NULL
      UNION ALL
      SELECT posix_gid FROM public.teams WHERE posix_gid IS NOT NULL
      UNION ALL
      SELECT id_value FROM public.retired_posix_ids
    ) AS taken;

  IF next_id > 399999 THEN
    RAISE EXCEPTION 'the reserved POSIX id range is exhausted'
      USING ERRCODE = 'program_limit_exceeded';
  END IF;

  RETURN next_id;
END
$$;

REVOKE ALL ON FUNCTION public.allocate_posix_id(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.allocate_posix_id(text) TO depsis_app;
