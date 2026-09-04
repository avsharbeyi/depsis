-- 0058 — `job_history` sonsuza kadar büyümesin, ve İşler ekranı onu indekssiz taramasın.
--
-- ── NE OLUYORDU ──────────────────────────────────────────────────────────────────────────────
--
-- `finish_job` biten HER işi `job_history`'ye yazıyor (0007), ve depoda o tablodan hiçbir şey
-- silmiyordu. Aynı zamanda `files.index-drain` zinciri kendini beş saniyede bir yeniden kuyruğa
-- alıyor: kiracı başına günde ~17.300 satır, kutu bir yıl açık kalırsa ~6,3 milyon satır.
--
-- Tabloda tek bir indeks vardı — `(organization_id, finished_at DESC)` — ve onu kullanan bir
-- sorgu yoktu:
--
--   `EventsService.jobsSince`  iki saniyede bir  `... WHERE organization_id = $1 AND updated_at > $2`
--   `JobsService.list`         ekran her açıldığında  `... ORDER BY created_at DESC, id DESC`
--
-- İkisi de sıralı tarama. Sonucu, aylar içinde yavaşlayan bir İşler ekranı ve sürekli büyüyen
-- bir disk — ve hiçbir ekranın söylemediği, terminalsiz budanamayan bir birikme.
--
-- ── ÜÇ İNDEKS, VE NEDEN `job_queue`'YA HİÇBİRİ ───────────────────────────────────────────────
--
-- İlk ikisi yukarıdaki iki sorgunun tam şekli. Aynı sorgular `job_queue`'ya da bakıyor ama oraya
-- indeks EKLENMİYOR: 0007'nin kendi gerekçesiyle o tablo küçük kalıyor (biten iş history'ye
-- TAŞINIYOR) ve UPDATE ağır — her claim, her heartbeat, her ilerleme raporu satırı yeniden
-- yazıyor. Orada fazladan bir indeks, kazandırmadığı bir sıralamayı her yazmada ödetirdi.
--
-- Üçüncüsü budama zincirinin tekilliği: 0023/0024/0025'in aynı deseni. `ON CONFLICT DO NOTHING`
-- ile çakışacak bir şey olmadan her açılış bir kopya daha bırakır. Yalnız `queued` — `running`
-- de kapsansaydı işleyicinin kendi ardılı çakışır ve zincir hiç ilerlemezdi.
--
-- ── SAKLAMA SÜRESİ NEDEN BURADA DEĞİL ────────────────────────────────────────────────────────
--
-- Silme `JobsService.pruneHistory` içinde, `withTenant` ile ve PARÇALI koşuyor. SECURITY DEFINER
-- bir fonksiyon gerekmiyor: `depsis_app`'in `job_history` üzerinde DELETE yetkisi (0007) ve kendi
-- kiracı politikası zaten var, yani budama RLS'in altında kalabiliyor — kiracı bağlamı olmadan
-- okunan bir tablo, bu depoda kapıyla yasaklanmış bir şey.
--
-- Parçalı olması ADR-0003'ün uzun transaction yasağı: sahadaki bir cihazda birikmiş milyonlarca
-- satırı tek DELETE ile silmek kuyruğu dakikalarca kilitlerdi.
--
-- `dead` satırlar ötekilerden UZUN duruyor (90 güne karşı 7). ADR-0003 §17'nin gerekçesi bu:
-- ölü bir iş "sessizce kaybolmuyor, alarm onu bulabiliyor" — ve bir haftada silinen bir kayıt,
-- kimsenin bakmadığı bir tatilde kaybolur.

-- Up Migration

SELECT public.assert_rls_roles_sane();

-- `EventsService.jobsSince`: iki saniyede bir, kiracı + `updated_at > $2`, `updated_at` sıralı.
CREATE INDEX job_history_org_updated_idx
  ON public.job_history (organization_id, updated_at);

-- `JobsService.list`: UNION'ın history yarısı, `created_at DESC, id DESC` ile sıralanıyor.
-- Var olan `(organization_id, finished_at DESC)` bu sıralamaya hiç yaramıyor.
CREATE INDEX job_history_org_created_idx
  ON public.job_history (organization_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX job_queue_one_scheduled_jobs_prune
  ON public.job_queue (organization_id, kind)
  WHERE kind = 'jobs.prune' AND status = 'queued';

COMMENT ON INDEX public.job_queue_one_scheduled_jobs_prune IS
  'Kiracı başına tek zamanlanmış budama turu. `ON CONFLICT DO NOTHING`''in çakışacağı şey bu; '
  'olmadan her açılış bir kopya daha bırakır. Yalnız `queued`: `running` de kapsansaydı '
  'işleyicinin kendi ardılı çakışır ve zincir ilerlemezdi.';

-- Down Migration

DROP INDEX IF EXISTS public.job_queue_one_scheduled_jobs_prune;
DROP INDEX IF EXISTS public.job_history_org_created_idx;
DROP INDEX IF EXISTS public.job_history_org_updated_idx;
