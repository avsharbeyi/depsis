-- 0064 — Üç yerde adı geçen "retention job"un veritabanı tarafı.
--
-- ── VAR OLMAYAN BİR İŞE YAPILAN ATIFLAR ─────────────────────────────────────────────────────
--
-- Şema üç ayrı yerde, olmayan bir işi anlatıyor:
--
--   0003:38   "Rows are removed by a retention job, not by logout."
--   0003:72   "The retention job scans by expiry" — `sessions_expires_at_idx` bunun için var.
--   0003:179  "DELETE for the retention job only" — `login_attempts` üzerinde DELETE yalnız
--             `depsis_owner`da, "bir hata saldırı kanıtını silemesin" diye.
--   0020:81   "süpürme için tarih üzerinde bir tane var" — `idempotency_keys_created_at`.
--
-- Böyle bir iş hiç yazılmadı. Sonucu veri kaybı değil, sessiz birikme: her giriş denemesi, her
-- oturum, her MFA sorusu, her `Idempotency-Key` kalıcı. İnternete açık bir kutuda `login_attempts`
-- en hızlı büyüyeni — ve sahibinin onu budayacak terminalsiz hiçbir yolu yok. Süresi geçmiş token
-- özetleri de veritabanında ve yedeklerde taşınmaya devam ediyor, ki 0003'ün özeti saklama
-- gerekçesi tam olarak bunun tersiydi.
--
-- ── NEDEN YALNIZ BİR TABLO İÇİN FONKSİYON ───────────────────────────────────────────────────
--
-- Beş tablonun dördü `depsis_app`in kendi eliyle budanabiliyor, çünkü hepsi RLS'li ve hepsinde
-- DELETE yetkisi zaten var: `sessions` (0003), `pending_logins` (0004), `idempotency_keys` (0020),
-- `password_resets` (0021). Onlar için doğru yer `withTenant` içinde bir sorgu — kiracı bağlamı
-- olmadan okunan bir tablo bu depoda kapıyla yasak, ve RLS'i bir SECURITY DEFINER fonksiyonla
-- atlatmak kazanılan hiçbir şeye karşılık gelmezdi.
--
-- `login_attempts` tek istisna, ve ikisi birden yüzünden: kiracısız (0003:137-142 — deneme, kiracı
-- bilinmeden ÖNCE kaydediliyor) ve `depsis_app`in üzerinde DELETE yetkisi YOK. O yetkiyi vermek
-- 0003:178-179'un gerekçesini bozardı: uygulamadaki bir hata, süren bir saldırının kanıtını
-- silebilir hâle gelirdi. Bu yüzden silme dar bir SECURITY DEFINER fonksiyona kapatılıyor —
-- uygulama "şu yaştan eski satırları at" diyebiliyor, "şu satırı at" diyemiyor.
--
-- ── PARÇALI, ÇÜNKÜ TEK DELETE UZUN BİR İŞLEM ────────────────────────────────────────────────
--
-- ADR-0003 uzun transaction yasağı koyuyor. Sahadaki bir kutuda birikmiş milyonlarca satırı tek
-- ifadeyle silmek giriş yolunu dakikalarca kilitlerdi, ki tam da o yol korunmaya çalışılıyor.
-- Fonksiyon en çok `batch` satır siliyor ve KAÇ tane sildiğini döndürüyor; çağıran, dönen sayı
-- tavana değdiği sürece bir tur daha atıyor.
--
-- ── ZİNCİRİN TEKİLLİĞİ ──────────────────────────────────────────────────────────────────────
--
-- Kendini zamanlayan zincirlerin `ON CONFLICT DO NOTHING`i, çakışacak bir kısmi tekil indeks
-- olmadan hiçbir zaman tetiklenmiyor — 0063 bunun bedelini anlatıyor. `auth.retention` için o
-- indeks ZİNCİR YAZILMADAN ÖNCE kuruluyor, çünkü sonradan eklenen bir arbiter önce birikmiş
-- kopyaları temizlemek zorunda kalıyor. Yalnız `queued`: `running` de kapsansaydı işleyicinin
-- kendi ardılı çakışır ve zincir hiç ilerlemezdi (0024'ün gerekçesi).
--
-- ÖTEKİ PARÇA UYGULAMADA, ve bu göç onu yapamaz: `auth.retention` türü işçinin kayıt defterine
-- (`apps/worker/src/handlers/registry.ts`) eklenene kadar burada kurulan indeks de fonksiyon da
-- kullanılmıyor. Bu göç tek başına bir budama değil, budamanın kurulabileceği zemin.

-- Up Migration

SELECT public.assert_rls_roles_sane();

CREATE FUNCTION public.purge_login_attempts(older_than interval, batch integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
-- SECURITY DEFINER bir fonksiyonda isteğe bağlı değil: onsuz çağıran `public.login_attempts`i
-- kendi tablosuyla gölgeleyip bunu sahibin yetkisiyle koşturabilir.
SET search_path = pg_catalog, public
AS $$
DECLARE
  removed integer;
BEGIN
  IF older_than IS NULL OR older_than < interval '1 day' THEN
    RAISE EXCEPTION 'older_than must be at least one day'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF batch IS NULL OR batch < 1 OR batch > 50000 THEN
    RAISE EXCEPTION 'batch must be between 1 and 50000'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  WITH doomed AS (
    SELECT id
      FROM public.login_attempts
     WHERE attempted_at < now() - older_than
     ORDER BY attempted_at
     LIMIT batch
  )
  DELETE FROM public.login_attempts a
   USING doomed d
   WHERE a.id = d.id;

  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;

COMMENT ON FUNCTION public.purge_login_attempts(interval, integer) IS
  'Kiracısız `login_attempts` tablosunun tek budama yolu. Silme yetkisi `depsis_app`e '
  'VERİLMİYOR (0003:178-179: bir hata saldırı kanıtını silememeli); onun yerine uygulama yalnız '
  '"şu yaştan eski en çok N satırı at" diyebiliyor. Parçalı, çünkü tek bir DELETE giriş yolunu '
  'kilitlerdi. Öteki dört kimlik tablosu RLS''li ve `withTenant` ile budanıyor.';

REVOKE ALL ON FUNCTION public.purge_login_attempts(interval, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_login_attempts(interval, integer) TO depsis_app;

CREATE UNIQUE INDEX job_queue_one_scheduled_auth_retention
  ON public.job_queue (organization_id, kind)
  WHERE kind = 'auth.retention' AND status = 'queued';

COMMENT ON INDEX public.job_queue_one_scheduled_auth_retention IS
  'Kiracı başına tek zamanlanmış kimlik-tabloları budaması. `ON CONFLICT DO NOTHING`''in '
  'çakışacağı şey bu; olmadan her açılış bir zincir daha bırakır (0063). Yalnız `queued`: '
  '`running` de kapsansaydı işleyicinin kendi ardılı çakışır ve zincir ilerlemezdi.';

-- Down Migration

DROP INDEX IF EXISTS public.job_queue_one_scheduled_auth_retention;
DROP FUNCTION IF EXISTS public.purge_login_attempts(interval, integer);
