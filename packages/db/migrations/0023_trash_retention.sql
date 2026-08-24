-- 0023 — Çöp kutusunun saklama süresi, ve onu çalıştıracak zamanlayıcı.
--
-- §7 "çöp kutusu, geri yükleme, SAKLAMA SÜRESİ ve yönetici temizleme politikası" istiyor. İlk
-- ikisi vardı; son ikisi yoktu, yani çöpe atılan hiçbir şey kendiliğinden gitmiyordu ve bir
-- kullanıcının sildiği baytlar refquota'sını sonsuza kadar tutuyordu.
--
-- ── Varsayılan NULL, ve bu bir karar ──────────────────────────────────────────
--
-- NULL "süresiz sakla" demek — yani bugünkü davranış. Bir göç, kimsenin istemediği bir anda
-- kullanıcı verisi silmeye BAŞLAMAMALI. Politikayı açmak yöneticinin bilinçli bir hareketi
-- olmalı, ve açtığı ekranın ona ne kadar veri gideceğini söylemesi gerekiyor.
--
-- ── Neden en az bir gün ───────────────────────────────────────────────────────
--
-- `trash_retention_days >= 1`. Sıfır, "sil düğmesine basıldığı an kalıcı olarak sil" demek
-- olurdu — çöp kutusunu tamamen ortadan kaldırır, ve çöp kutusu bu üründe bir kullanıcı ile
-- kalıcı veri kaybı arasındaki tek tıklama. Yanlışlıkla 0 yazmanın sonucu geri alınamaz, o yüzden
-- veritabanı bunu hiç kabul etmiyor.
--
-- ── Neden ayrı bir tablo ──────────────────────────────────────────────────────
--
-- `organizations`'a bir sütun eklemek de olurdu. Ayrı tablo, ilerideki her organizasyon ayarının
-- gideceği yeri şimdi belirliyor ve `organizations`'ı kimlik tablosu olarak bırakıyor — ADR-0015
-- boyunca "kiracı kim" sorusunu cevaplayan tablo o, ve ona bir tercih sütunu eklemek onu iki iş
-- yapan bir tablo yapardı.

-- Up Migration

SELECT public.assert_rls_roles_sane();

CREATE TABLE public.organization_settings (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations (id) ON DELETE CASCADE,

  -- NULL: süresiz sakla. Bugünkü davranış, ve bir göçün varsayılanı bu olmak zorunda.
  trash_retention_days integer,

  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Kimin açtığı, denetimin cevaplaması gereken soru. Hesap silinince ayar kalmalı.
  updated_by uuid REFERENCES public.users (id) ON DELETE SET NULL,

  CONSTRAINT organization_settings_retention_sane
    CHECK (trash_retention_days IS NULL OR trash_retention_days BETWEEN 1 AND 3650)
);

COMMENT ON COLUMN public.organization_settings.trash_retention_days IS
  'NULL süresiz sakla demek. En az 1: sıfır, çöpe atmanın kalıcı silmeye eşit olması demek '
  'olurdu ve çöp kutusu bu üründe kullanıcı ile geri alınamaz veri kaybı arasındaki tek tıklama.';

ALTER TABLE public.organization_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_settings FORCE  ROW LEVEL SECURITY;

CREATE POLICY organization_settings_owner_full ON public.organization_settings
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY organization_settings_tenant_isolation ON public.organization_settings
  FOR ALL TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.organization_settings TO depsis_app;
GRANT SELECT ON public.organization_settings TO depsis_backup;

-- ─── zamanlanmış işin tekilliği ───────────────────────────────────────────────
--
-- Ürünün TypeScript tarafında zamanlayıcı yok ve olmasını istemiyoruz: bir `setInterval`,
-- yalnız o süreç ayaktayken çalışan ve yeniden başlatmada kaybolan bir zamanlayıcıdır. Kuyruğun
-- kendisi `run_after` ile dayanıklı bir zamanlayıcı zaten — eksik olan tek şey, aynı işten iki
-- tane kuyruğa girmemesi.
--
-- İndeks yalnız `queued` üzerinde, `running` üzerinde DEĞİL. İkisini de kapsasaydı, işleyicinin
-- kendi ardılını kuyruğa alması bir unique_violation olurdu — çünkü ebeveyn satır işleyici
-- koşarken hâlâ `running`. Bu tam olarak bir incelemenin bu tasarımın önceki hâlinde bulduğu
-- çelişki: zincir hiç ilerleyemezdi.
CREATE UNIQUE INDEX job_queue_one_scheduled_purge
  ON public.job_queue (organization_id, kind)
  WHERE kind = 'files.trash.purge' AND status = 'queued';

COMMENT ON INDEX public.job_queue_one_scheduled_purge IS
  'Yalnız `queued`: `running` da kapsansaydı işleyicinin kendi ardılını kuyruğa alması '
  'çakışırdı ve zincir hiç ilerlemezdi.';

-- Down Migration

DROP INDEX IF EXISTS public.job_queue_one_scheduled_purge;
DROP TABLE IF EXISTS public.organization_settings;
