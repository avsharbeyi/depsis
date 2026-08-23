-- 0018 — kirasını kaybeden bir iş sonsuza kadar yeniden alınmasın.
--
-- Kuyruğun iki karşıt başarısızlık kipi vardı ve hiçbiri istenen değildi.
--
-- TEMİZ başarısız olan bir iş `finish_job`'a ulaşıyor, orada `attempt >= max_attempts`
-- karşılaştırması yapılıyor ve iş ölüyor. Doğru.
--
-- Kirasını KAYBEDEN bir iş oraya hiç ulaşmıyor. `WorkerService.execute` kirayı artık tutmuyorsa
-- `finish`'i atlıyor — atlamak zorunda, çünkü geç gelen bir yazma, işi meşru biçimde devralan
-- worker'ın sonucunu ezerdi. Ama `claim_job`'ın yüklemi yalnızca `kind`, `run_after` ve
-- "queued ya da kirası dolmuş" diye bakıyor: `max_attempts`'e HİÇ bakmıyor. Yani SIGKILL yiyen,
-- OOM olan ya da sadece kirasını kaçıran bir iş sınırsız yeniden alınıyor. `attempt` tavansız
-- büyüyor, `last_error` hiç yazılmıyor, ve iş ne başarıyor ne ölüyor.
--
-- Bu turda `permissions.apply`'ın deneme bütçesi 5'ten 20'ye çıktı ve büyük bir paylaşım artık
-- kendini yeniden kuyruğa koyuyor; ikisi de bu döngüyü daha uzun ve daha pahalı yapıyor. Worker
-- aynı anda tek iş alıyor, yani kendini öldüren bir iş arkasındaki her şeyi aç bırakıyor.
--
-- ── İki parça, ve ikisi de gerekli ────────────────────────────────────────────
--
-- 1. Yüklem `attempt < max_attempts` istiyor. Bütçesini tüketmiş bir iş bir daha alınmıyor.
-- 2. Ama yalnız bunu yapmak, `job_queue`'da sonsuza kadar `running` kalan bir HAYALET bırakırdı:
--    kimse almıyor, kimse bitirmiyor, `GET /jobs/{id}` "çalışıyor" diyor. O yüzden claim, almadan
--    önce tükenmişleri `job_history`'ye `dead` olarak taşıyor.
--
-- Reaping'i claim'in içine koymak, ayrı bir süpürücüye yeğlendi: çağrılması unutulamayan tek yer
-- burası. Worker zaten saniyede bir claim ediyor, ve temizlenen satırlar tam olarak onun almak
-- isteyip de alamayacağı satırlar.
--
-- Reaping ÇAĞIRANIN İSTEDİĞİ TÜRLERLE sınırlı, claim gibi. Bütün kuyruğu süpürmek, bir worker'ın
-- hiç çalıştırmadığı bir türü — belki başka bir sürümün henüz kaydetmediği bir handler'ı —
-- öldürmesi demek olurdu.

-- Up Migration

SELECT public.assert_rls_roles_sane();

CREATE OR REPLACE FUNCTION public.claim_job(
  p_worker_id  text,
  p_kinds      text[],
  p_lease_secs integer DEFAULT 60
)
RETURNS SETOF public.job_queue
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_exhausted uuid[];
BEGIN
  -- ── 1. Bütçesini tüketmiş ve kirası dolmuş işleri öldür.
  --
  -- `lease_until < now()` şart: HÂLÂ koşan bir işi öldürmek, tam da idempotency'nin koruyamadığı
  -- şeyi yapardı — iki yerde birden "bitti" kaydı. Yalnız kimsenin tutmadığı satırlar.
  --
  -- `FOR UPDATE SKIP LOCKED`: iki worker aynı anda süpürürse biri diğerini beklemesin.
  SELECT array_agg(id) INTO v_exhausted
    FROM (
      SELECT id
        FROM public.job_queue
       WHERE kind = ANY (p_kinds)
         AND attempt >= max_attempts
         AND (status = 'queued' OR (status = 'running' AND lease_until < now()))
       FOR UPDATE SKIP LOCKED
    ) AS ready;

  IF v_exhausted IS NOT NULL AND cardinality(v_exhausted) > 0 THEN
    INSERT INTO public.job_history
    SELECT j.*, now() FROM public.job_queue AS j WHERE j.id = ANY (v_exhausted);

    UPDATE public.job_history
       SET status      = 'dead',
           lease_until = NULL,
           -- Var olan bir hatanın üstüne YAZMIYOR. Bir iş temiz başarısız olup sonra kirasını
           -- kaybettiyse, operatörün okumak isteyeceği şey ilk sebeptir; "worker durdu" onun
           -- yerine geçerse asıl neden kaybolur.
           last_error  = coalesce(
             last_error,
             'the worker holding this job stopped without finishing it, and its attempts are '
               || 'exhausted (' || attempt || '/' || max_attempts || ')'
           ),
           updated_at  = now()
     WHERE id = ANY (v_exhausted);

    DELETE FROM public.job_queue WHERE id = ANY (v_exhausted);
  END IF;

  -- ── 2. Sonra, her zamanki gibi bir iş al.
  RETURN QUERY
  UPDATE public.job_queue
     SET status      = 'running',
         lease_until = now() + make_interval(secs => p_lease_secs),
         attempt     = attempt + 1,
         worker_id   = p_worker_id,
         updated_at  = now()
   WHERE id = (
     SELECT id
       FROM public.job_queue
      WHERE kind = ANY (p_kinds)
        AND run_after <= now()
        -- YENİ. Bütçesini tüketmiş bir iş bir daha alınmıyor; yukarıdaki adım onu zaten
        -- taşımış olmalı, ve bu satır o adımın kaçırdığı her şey için ikinci kapı.
        AND attempt < max_attempts
        AND (
          status = 'queued'
          -- Çöken bir worker'ın işini devralmak. Kiranın dolması ÇÖKÜŞ TESPİTİNİN kendisi:
          -- taranacak bir heartbeat tablosu ve yazılması unutulacak bir restart hook'u yok.
          OR (status = 'running' AND lease_until < now())
        )
      ORDER BY priority DESC, run_after, id
      -- SKIP LOCKED'ın tek göründüğü yer. Bunu eşzamanlı koşan iki worker aynı satırı
      -- beklemek yerine farklı satırlar alıyor.
      FOR UPDATE SKIP LOCKED
      LIMIT 1
   )
  RETURNING *;
END;
$$;

COMMENT ON FUNCTION public.claim_job(text, text[], integer) IS
  'Bir iş al, ya da hiç satır döndürme. SECURITY DEFINER, çünkü bir worker kiracı değil ve hiçbir '
  'organizasyona ait olmayan sistem işlerini de koşabilmeli. Çağırandan yüklem almıyor. '
  'Almadan ÖNCE, bütçesini tüketmiş ve kirası dolmuş işleri job_history''ye dead olarak taşıyor: '
  'yüklem max_attempts''e bakmadığı için böyle bir iş sonsuza kadar yeniden alınıyordu ve ne '
  'başarıyor ne ölüyordu (migration 0018).';

REVOKE ALL     ON FUNCTION public.claim_job(text, text[], integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.claim_job(text, text[], integer) TO depsis_app;

-- Down Migration

-- 0007'deki hâline: sql, reaping yok, `max_attempts` yüklemde yok.
CREATE OR REPLACE FUNCTION public.claim_job(
  p_worker_id  text,
  p_kinds      text[],
  p_lease_secs integer DEFAULT 60
)
RETURNS SETOF public.job_queue
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.job_queue
     SET status      = 'running',
         lease_until = now() + make_interval(secs => p_lease_secs),
         attempt     = attempt + 1,
         worker_id   = p_worker_id,
         updated_at  = now()
   WHERE id = (
     SELECT id
       FROM public.job_queue
      WHERE kind = ANY (p_kinds)
        AND run_after <= now()
        AND (
          status = 'queued'
          OR (status = 'running' AND lease_until < now())
        )
      ORDER BY priority DESC, run_after, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
   )
  RETURNING *;
$$;

COMMENT ON FUNCTION public.claim_job(text, text[], integer) IS
  'Claim one job, or return no rows. SECURITY DEFINER because a worker is not a tenant and must be '
  'able to run system jobs, which belong to no organization. Takes no caller-supplied predicate.';

REVOKE ALL     ON FUNCTION public.claim_job(text, text[], integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.claim_job(text, text[], integer) TO depsis_app;
