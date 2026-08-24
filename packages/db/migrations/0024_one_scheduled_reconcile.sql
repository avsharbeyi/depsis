-- 0024 — Paylaşım başına tek bir zamanlanmış mutabakat.
--
-- `files.reconcile` de çöp temizlemesi gibi kendi ardılını kuyruğa alıyor ve API her açılışta
-- yeniden tohumluyor. İki yol da zinciri kurtarabilmeli, ama ikisi birden ikinci bir çalışma
-- üretmemeli — ve `ON CONFLICT DO NOTHING`'in çakışacak bir şeye ihtiyacı var. Bu indeks olmadan
-- o cümle hiçbir zaman tetiklenmez ve her açılış bir kopya daha bırakır.
--
-- ── Neden ifade indeksi ───────────────────────────────────────────────────────
--
-- Temizleme organizasyon başına tek; mutabakat PAYLAŞIM başına. `payload->>'shareId'` bu yüzden
-- anahtarın parçası: iki paylaşımın aynı anda kuyrukta olması normal, aynı paylaşımın iki kez
-- olması değil.
--
-- `IMMUTABLE` bir ifade gerekiyor ve `->>` öyle — jsonb'den metin çıkarmak girdiye bağlı, saate ya
-- da locale'e değil.
--
-- ── Neden yalnız `queued` ─────────────────────────────────────────────────────
--
-- 0023'ün aynı gerekçesi, ve orada bir tasarım incelemesinin bulduğu çelişki: `running` de
-- kapsansaydı işleyicinin kendi ardılını kuyruğa alması bir unique_violation olurdu, çünkü
-- ebeveyn satır işleyici koşarken hâlâ `running`. Zincir hiç ilerlemezdi.

-- Up Migration

SELECT public.assert_rls_roles_sane();

CREATE UNIQUE INDEX job_queue_one_scheduled_reconcile
  ON public.job_queue (organization_id, kind, (payload ->> 'shareId'))
  WHERE kind = 'files.reconcile' AND status = 'queued';

COMMENT ON INDEX public.job_queue_one_scheduled_reconcile IS
  'Paylaşım başına tek zamanlanmış mutabakat. `ON CONFLICT DO NOTHING`''in çakışacağı şey bu; '
  'olmadan her açılış bir kopya daha bırakır. Yalnız `queued`: `running` de kapsansaydı '
  'işleyicinin kendi ardılı çakışır ve zincir ilerlemezdi.';

-- Down Migration

DROP INDEX IF EXISTS public.job_queue_one_scheduled_reconcile;
