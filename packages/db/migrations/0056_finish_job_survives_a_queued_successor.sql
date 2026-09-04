-- 0056 — ardılını çoktan kuyruğa almış bir zincir işi düştüğünde işçi ölmesin.
--
-- ── NE OLUYORDU ──────────────────────────────────────────────────────────────────────────────
--
-- Kendini zamanlayan her işleyici ARDILINI İŞTEN ÖNCE kuyruğa alıyor, ve bu bilerek böyle:
-- 0054'te sahada ödendi — zincir yalnız BAŞARILI bir turdan sonra devam ederse, üç deneme birkaç
-- saniyede tükendiğinde iş ölüyor, kimse ardılını kurmuyor, ve dizin turu bir daha hiç koşmuyor.
--
-- Ama o sıra ikinci bir şeyi doğuruyor. Tur düşerse `finish_job` yeniden deneme dalına giriyor ve
-- KOŞAN satırı da `status = 'queued'` yapıyor. O anda kuyrukta aynı türden bir satır zaten var —
-- işleyicinin kendi kurduğu ardıl. Kısmi tekil indekslerin hepsi `status = 'queued'` üzerinde:
--
--   job_queue_one_scheduled_trash_purge   (0023)
--   job_queue_one_scheduled_reconcile     (0024)
--   job_queue_one_scheduled_drain         (0025)
--   job_queue_one_scheduled_overdue_sweep (0027)
--   job_queue_one_scheduled_backup_tick   (0032)
--   job_queue_one_scheduled_backup_*      (0044, 0045)
--
-- Yani UPDATE bir unique_violation (23505) veriyor. `JobsService.finish` onu sarmalamıyor,
-- `WorkerService.execute` çağrıyı zaten kendi catch bloğunun İÇİNDE yapıyor, ve `run()` de
-- `execute`i try'a almıyordu: hata yakalanmamış bir reddetme olarak süreci düşürüyordu. Sonuç,
-- geçici bir ajan yeniden başlamasının işçiyi 65 saniyede bir çökertmesi — ve o sırada kopyalama,
-- ACL ve kimlik işlerinin hiç işlenmemesi.
--
-- ── NEDEN "AYNI TÜRDEN KUYRUKTA İŞ VAR MI" KONTROLÜ DEĞİL ────────────────────────────────────
--
-- Akla ilk gelen düzeltme, yeniden denemeden önce "bu türden zaten kuyrukta bir iş var mı" diye
-- bakmak. Bu GENEL BİR KURAL OLARAK YANLIŞ: `files.copy`, `files.acl.apply`, `files.index` gibi
-- türlerde aynı anda birden çok `queued` satır tamamen meşru, ve böyle bir kontrol onların
-- yeniden denemesini sessizce iptal ederdi — bir kopyalama işi tek geçici hatada kaybolurdu.
--
-- Doğru sınır, indeksin kendisinin çizdiği sınır. UPDATE bir alt-işleme (plpgsql'de
-- `BEGIN ... EXCEPTION`) alınıyor: çakışma GERÇEKTEN olursa yalnız o iş düşüyor, olmazsa hiçbir
-- şey değişmiyor. Tek düzeltme yukarıdaki altı indeksin hepsini birden kapsıyor.
--
-- ── DÜŞEN İŞ 'failed', 'dead' DEĞİL ──────────────────────────────────────────────────────────
--
-- İş denemelerini TÜKETMEDİ; yeniden denenemedi. `dead` demek ADR-0003'ün alarm gerekçesini
-- bulandırırdı — o durum "kuyruk pes etti" demek, ve operatörün onu ayrı görebilmesi gerekiyor.
-- `failed` şemada zaten geçerli bir durum (`job_status_known`) ve `GET /jobs?status=failed`
-- filtresi de zaten var; bugüne kadar history'ye hiç yazılmıyordu.
--
-- ZİNCİR KOPMUYOR: düşen tur kaybediliyor, ama ardıl kuyrukta duruyor ve sırası gelince koşuyor.

-- Up Migration

SELECT public.assert_rls_roles_sane();

CREATE OR REPLACE FUNCTION public.finish_job(
  p_id        uuid,
  p_worker_id text,
  p_outcome   text,
  p_error     text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_job    public.job_queue;
  v_status text;
BEGIN
  IF p_outcome NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'finish_job: outcome must be succeeded or failed, got %', p_outcome;
  END IF;

  -- Only the holder of a live lease may finish the job. A worker that lost its lease and finishes
  -- late would otherwise overwrite the result of whoever legitimately reclaimed it.
  SELECT * INTO v_job
    FROM public.job_queue
   WHERE id = p_id AND worker_id = p_worker_id AND status = 'running' AND lease_until >= now()
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF p_outcome = 'succeeded' THEN
    v_status := 'succeeded';
  ELSIF v_job.attempt >= v_job.max_attempts THEN
    -- Out of attempts. `dead` rather than `failed`, and it does NOT silently disappear: the row
    -- lands in history where an alarm can find it (ADR-0003, §17).
    v_status := 'dead';
  ELSE
    v_status := 'retry';
  END IF;

  IF v_status = 'retry' THEN
    -- ALT-İŞLEM. `BEGIN ... EXCEPTION` olan bir blok plpgsql'de bir savepoint açıyor: içerideki
    -- UPDATE çakışırsa yalnız o geri alınıyor, dışarıdaki `FOR UPDATE` kilidi ve bu fonksiyonun
    -- geri kalanı ayakta kalıyor. Maliyeti savepoint başına bir miktar, ve yalnız yeniden deneme
    -- yolunda ödeniyor — başarı yolu hiç buraya girmiyor.
    BEGIN
      UPDATE public.job_queue
         SET status      = 'queued',
             lease_until = NULL,
             worker_id   = NULL,
             last_error  = p_error,
             -- Exponential backoff, capped. A job that fails instantly five times in a row would
             -- otherwise burn its attempts inside a second and reach `dead` before the transient
             -- cause — a restarting database, a busy pool — had any chance to clear.
             run_after   = now() + make_interval(secs => least(300, power(2, v_job.attempt)::integer)),
             updated_at  = now()
       WHERE id = p_id;
      RETURN 'queued';
    EXCEPTION WHEN unique_violation THEN
      -- Bu işin ardılı zaten kuyrukta. Yeniden denemek, "bu türden tek zamanlanmış iş" kuralını
      -- çiğnemek olurdu; o kural da işleyicinin kendi ardılını koruyor. Yani düşen şey BU TUR,
      -- zincir değil.
      v_status := 'failed';
    END;
  END IF;

  INSERT INTO public.job_history
  SELECT (j).*, now()
    FROM (SELECT j FROM public.job_queue j WHERE j.id = p_id) s(j);

  UPDATE public.job_history
     SET status      = v_status,
         last_error  = CASE
           WHEN v_status = 'failed'
             THEN coalesce(p_error, 'the attempt failed')
                    || ' — not retried: a successor of this kind is already queued'
           ELSE p_error
         END,
         lease_until = NULL,
         updated_at  = now()
   WHERE id = p_id;

  DELETE FROM public.job_queue WHERE id = p_id;
  RETURN v_status;
END;
$$;

REVOKE ALL     ON FUNCTION public.finish_job(uuid, text, text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.finish_job(uuid, text, text, text) TO depsis_app;

COMMENT ON FUNCTION public.finish_job(uuid, text, text, text) IS
  'İşin sonucunu yazar: history''ye taşır ya da yeniden kuyruğa alır. Yeniden deneme UPDATE''i bir '
  'alt-işlemde, çünkü kendini zamanlayan işleyiciler ardıllarını İŞTEN ÖNCE kuyruğa alıyor ve '
  '`status = ''queued''` üzerindeki kısmi tekil indeksler o ardılla çakışıyor. Çakışmada iş '
  '''failed'' olarak tarihe geçiyor; ''dead'' değil, çünkü denemeleri tükenmedi.';

-- Down Migration

CREATE OR REPLACE FUNCTION public.finish_job(
  p_id        uuid,
  p_worker_id text,
  p_outcome   text,
  p_error     text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_job    public.job_queue;
  v_status text;
BEGIN
  IF p_outcome NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'finish_job: outcome must be succeeded or failed, got %', p_outcome;
  END IF;

  SELECT * INTO v_job
    FROM public.job_queue
   WHERE id = p_id AND worker_id = p_worker_id AND status = 'running' AND lease_until >= now()
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF p_outcome = 'succeeded' THEN
    v_status := 'succeeded';
  ELSIF v_job.attempt >= v_job.max_attempts THEN
    v_status := 'dead';
  ELSE
    v_status := 'retry';
  END IF;

  IF v_status = 'retry' THEN
    UPDATE public.job_queue
       SET status      = 'queued',
           lease_until = NULL,
           worker_id   = NULL,
           last_error  = p_error,
           run_after   = now() + make_interval(secs => least(300, power(2, v_job.attempt)::integer)),
           updated_at  = now()
     WHERE id = p_id;
    RETURN 'queued';
  END IF;

  INSERT INTO public.job_history
  SELECT (j).*, now()
    FROM (SELECT j FROM public.job_queue j WHERE j.id = p_id) s(j);

  UPDATE public.job_history
     SET status = v_status, last_error = p_error, lease_until = NULL, updated_at = now()
   WHERE id = p_id;

  DELETE FROM public.job_queue WHERE id = p_id;
  RETURN v_status;
END;
$$;

REVOKE ALL     ON FUNCTION public.finish_job(uuid, text, text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.finish_job(uuid, text, text, text) TO depsis_app;
