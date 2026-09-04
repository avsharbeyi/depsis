-- 0059 — §5.1'in "mümkünse iptal edilir" cümlesinin karşılığı.
--
-- Yanlış klasörü seçip bin dosyalık bir kopyalamayı başlatan kullanıcının duracak hiçbir düğmesi
-- yoktu: iş bitene kadar hedef klasör dolmaya devam ediyor, sonra elle temizlemek gerekiyordu.
--
-- İPTAL BİR BAYRAK DEĞİL, BİR TAŞIMA. `cancel_requested_at` gibi bir sütun üç yolu ayrı ayrı
-- öğretmeyi gerektirirdi (claim_job almasın, heartbeat_job yalan söylemesin, çöken işçinin satırını
-- biri toplasın) ve üçüncüsü hiçbir zaman bitirilemeyen bir `running` satır bırakırdı. Satırı tek
-- deyimde kuyruktan geçmişe taşımak üçünü de tek duruma indiriyor:
--
--   * kuyrukta bekleyen iş  — satır yok, `claim_job` onu hiç görmez;
--   * çalışan iş            — `heartbeat_job` satırı bulamaz, false döner, ve her handler bunu
--                             zaten "dur" olarak okur (worker.service.ts'in sözleşmesi);
--   * işçisi çökmüş iş      — toplanacak bir şey kalmadı.
--
-- Yarı yapılmış iş geri alınmıyor: iptal edilen bir kopyalamanın o ana kadar yazdığı dosyalar
-- yerinde kalır. Kuyruk en-az-bir-kez, işler idempotent (§17); "yaptığını geri al" bu katmanın
-- verebileceği bir söz değil, ve verilmiş gibi görünmesi daha kötü olurdu.

-- Up Migration

SELECT public.assert_rls_roles_sane();

-- `cancelled`, bilinen durumlar kümesine. job_history tablosu 0007'de `LIKE ... INCLUDING
-- CONSTRAINTS` ile üretildiği için kısıtın KENDİ kopyasını taşıyor; ikisi de genişletilmeli, yoksa
-- taşınan satır geçmişin kısıtına çarpar. Adı arayarak değil TANIMI arayarak buluyoruz: kopyalanan
-- kısıtın adının aynı kalacağına dayanmak, tutmadığı gün sessizce eski kısıtı yerinde bırakırdı.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT conrelid::regclass AS tbl, conname
      FROM pg_catalog.pg_constraint
     WHERE conrelid IN ('public.job_queue'::regclass, 'public.job_history'::regclass)
       AND contype = 'c'
       AND pg_catalog.pg_get_constraintdef(oid) LIKE '%succeeded%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;

ALTER TABLE public.job_queue
  ADD CONSTRAINT job_status_known
  CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled'));

ALTER TABLE public.job_history
  ADD CONSTRAINT job_status_known
  CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled'));

-- İptal.
--
-- SECURITY DEFINER DEĞİL, ve bu `find_job` ile aynı gerekçe: bu fonksiyona bir HTTP isteği adına
-- gelinir, dolayısıyla uygulanması gereken şey tam olarak satır düzeyi güvenliktir. Başka bir
-- kiracının işi, olmayan bir işten ayırt edilemez olmalı — ve `depsis_app` zaten her iki tablo
-- üzerinde kendi kiracı politikasıyla sınırlı INSERT/DELETE hakkına sahip, yani süpürme RLS'in
-- ETRAFINDAN değil ALTINDAN geçiyor.
--
-- `finish_job` ile aynı taşıma deyimi kullanılıyor: satırın tamamı geçmişe kopyalanır, sonra
-- durumu ve kirası düzeltilir, sonra kuyruktan silinir. Tek işlem içinde olduğu için iş hiçbir an
-- iki tabloda birden ya da hiçbirinde değildir.
CREATE OR REPLACE FUNCTION public.cancel_job(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_job public.job_queue;
BEGIN
  SELECT * INTO v_job FROM public.job_queue WHERE id = p_id FOR UPDATE;

  IF NOT FOUND THEN
    -- Bitmiş, hiç var olmamış ya da başka bir kiracının işi. Üçü de aynı cevap.
    RETURN false;
  END IF;

  INSERT INTO public.job_history
  SELECT (j).*, now()
    FROM (SELECT j FROM public.job_queue j WHERE j.id = p_id) s(j);

  UPDATE public.job_history
     SET status = 'cancelled', lease_until = NULL, updated_at = now()
   WHERE id = p_id;

  DELETE FROM public.job_queue WHERE id = p_id;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.cancel_job(uuid) IS
  'Move one job out of the queue into history as cancelled. NOT security definer: it is reached on '
  'behalf of a user, so row level security decides whose job it is.';

REVOKE ALL     ON FUNCTION public.cancel_job(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.cancel_job(uuid) TO depsis_app;

-- Down Migration

DROP FUNCTION IF EXISTS public.cancel_job(uuid);

-- Geri alırken önce iptal edilmiş satırları temizlemek zorundayız: dar kısıt onların varlığında
-- eklenemez, ve bir göçün "geri alınamıyor" demesi geri alınmamasından beterdir.
DELETE FROM public.job_history WHERE status = 'cancelled';
DELETE FROM public.job_queue   WHERE status = 'cancelled';

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT conrelid::regclass AS tbl, conname
      FROM pg_catalog.pg_constraint
     WHERE conrelid IN ('public.job_queue'::regclass, 'public.job_history'::regclass)
       AND contype = 'c'
       AND pg_catalog.pg_get_constraintdef(oid) LIKE '%succeeded%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;

ALTER TABLE public.job_queue
  ADD CONSTRAINT job_status_known
  CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead'));

ALTER TABLE public.job_history
  ADD CONSTRAINT job_status_known
  CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead'));
