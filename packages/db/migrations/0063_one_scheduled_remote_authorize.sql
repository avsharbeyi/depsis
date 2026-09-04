-- 0063 — Kiracı başına tek bir zamanlanmış `remote.authorize`.
--
-- ── ÇAKIŞACAK BİR ŞEY YOKTU ─────────────────────────────────────────────────────────────────
--
-- `RemoteService.scheduleAuthorize` şunu yazıyor ve yanına da şunu not düşüyor — *"aynı anda
-- yalnız bir tane kuyrukta olabilir"*:
--
--   INSERT INTO public.job_queue (...) VALUES (..., 'remote.authorize', ...)
--   ON CONFLICT DO NOTHING
--
-- Ama `job_queue` üzerinde bu tür için kısmi tekil indeks hiç yoktu — 0023/0024/0025/0027/0032/
-- 0044/0045/0058'in kurduğu `job_queue_one_scheduled_*` listesinde yeri boştu. Arbiter'ı olmayan
-- bir `ON CONFLICT DO NOTHING` çakışacak bir kısıt bulamazsa hiçbir zaman tetiklenmez: satır her
-- seferinde ekleniyordu.
--
-- ── SONUCU, VE NEDEN SESSİZ ─────────────────────────────────────────────────────────────────
--
-- `RemoteService.onModuleInit` HEM API'de HEM işçide koşuyor, yani her açılış iki zincir daha
-- doğuruyor ve her zincir kendi ardılını yirmi saniyede bir kuyruğa alıyor. Bir güncelleme iki
-- süreci de yeniden başlatıyor; on güncelleme sonra kutuda yirmi paralel zincir var, hepsi
-- ZeroTier denetleyicisine ayrı ayrı soruyor ve her turda `job_history`'ye satır yazıyor.
-- Kopya, ACL ve dizin işleri o kalabalığın arasına giriyor.
--
-- Hiçbir ekran bunu söylemiyor, çünkü zincirlerin her biri tek başına DOĞRU çalışıyor.
--
-- ── ÖNCE FAZLALIKLAR ────────────────────────────────────────────────────────────────────────
--
-- Sahadaki bir cihazda bu satırlardan birden çok var, ve tekil indeks onların üstüne kurulamaz.
-- Kiracı başına EN ESKİSİ kalıyor: `run_after` en küçük olan, yani sıradaki tur. En yenisini
-- tutmak zinciri gereksiz yere geciktirirdi.
--
-- Yalnız `queued`. `running` de kapsansaydı, işleyicinin kendi ardılını kuyruğa alması bir
-- unique_violation olurdu — ebeveyn satır işleyici koşarken hâlâ `running` — ve zincir hiç
-- ilerlemezdi. 0024'ün aynı gerekçesi.
--
-- Bu indeksin ikinci bir etkisi var ve o artık güvenli: bir zincir işi ardılını çoktan kuyruğa
-- almışken düşerse `finish_job`ın yeniden deneme yolu 23505 verebiliyor. 0056 o hâli `finish_job`
-- içinde ele aldı ve işçi döngüsü de sonucu yazamamayı artık yutuyor, yani indeks eklemek yeni
-- bir çökme yolu açmıyor.

-- Up Migration

SELECT public.assert_rls_roles_sane();

DELETE FROM public.job_queue AS j
 WHERE j.kind = 'remote.authorize'
   AND j.status = 'queued'
   AND j.id <> (
     SELECT k.id
       FROM public.job_queue AS k
      WHERE k.kind = 'remote.authorize'
        AND k.status = 'queued'
        AND k.organization_id IS NOT DISTINCT FROM j.organization_id
      ORDER BY k.run_after, k.id
      LIMIT 1
   );

CREATE UNIQUE INDEX job_queue_one_scheduled_remote_authorize
  ON public.job_queue (organization_id, kind)
  WHERE kind = 'remote.authorize' AND status = 'queued';

COMMENT ON INDEX public.job_queue_one_scheduled_remote_authorize IS
  'Kiracı başına tek zamanlanmış yetkilendirme turu. `ON CONFLICT DO NOTHING`''in çakışacağı şey '
  'bu; olmadan API ve işçinin her açılışı bir zincir daha bırakıyordu ve hiçbiri durmuyordu. '
  'Yalnız `queued`: `running` de kapsansaydı işleyicinin kendi ardılı çakışır ve zincir '
  'ilerlemezdi.';

-- Down Migration

DROP INDEX IF EXISTS public.job_queue_one_scheduled_remote_authorize;
