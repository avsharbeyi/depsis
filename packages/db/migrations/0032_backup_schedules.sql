-- Elle başlatılan bir yedek, alınmayan bir yedektir.
--
-- Anlık görüntü Faz 1'den beri var, çoğaltma Faz 2'den, off-site çoğaltma bu oturumdan. Üçünün de
-- ortak eksiği aynıydı ve `docs/bilinen-sinirlamalar.md` onu adıyla yazmıştı: hiçbiri kendiliğinden
-- koşmuyor. Bir NAS'ın verisini kaybetme yolu bozuk bir yedekleme değil, alınmamış bir yedek — ve
-- alınmamış olmasının sebebi neredeyse her zaman birinin bir düğmeye basmayı unutması.
--
-- MEKANİZMA ZATEN VARDI. `job_queue.run_after` bu üründeki tek dayanıklı zamanlayıcı ve beş zincir
-- onu kullanıyor (çöp temizliği, uzlaştırma, indeks boşaltma, gecikme taraması, ve şimdi bu).
-- Eksik olan şey bir politika: neyin, ne sıklıkla, ve kaç tanesinin saklanacağı.
--
-- SAKLAMA POLİTİKASI BU TABLONUN İKİNCİ YARISI ve birincisi kadar önemli. Saatlik görüntü alan ve
-- hiçbirini silmeyen bir zamanlama, havuzu dolduran bir zamanlamadır — ve dolu bir havuz, yedeği
-- olmayan bir havuzdan daha kötü: yazma da duruyor.

-- Up Migration

SELECT public.assert_rls_roles_sane();

-- ─── zamanlanmış yedekler ─────────────────────────────────────────────────────
CREATE TABLE public.backup_schedules (
  id              uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,

  -- Hangi veri kümesi. Kiracıya ait bir paylaşımın veri kümesi ya da havuzun kendisi olabilir;
  -- doğrulaması `DatasetName`'in kendisi, ve gerçekten var olup olmadığını ajan söylüyor.
  dataset         text        NOT NULL,

  -- Kullanıcının verdiği ad. Ekranda bu görünüyor, `tank/depsis` değil.
  label           text        NOT NULL,

  -- `hourly` | `daily` | `weekly`. Dakika hassasiyetinde bir cron ifadesi DEĞİL, ve bu bilinçli:
  -- cron, bir ev NAS'ının sahibinin yanlış yazabileceği ve yanlış yazdığında sessizce hiç
  -- çalışmayan bir dil. Üç seçenek, bir saat ve bir dakika, ürünün ihtiyacının tamamını karşılıyor.
  cadence         text        NOT NULL,

  -- Günlük ve haftalık için saat; saatlik için NULL (her saat).
  at_hour         smallint,
  at_minute       smallint    NOT NULL DEFAULT 0,
  -- Haftalık için gün: 0 = Pazar, PostgreSQL'in `dow`'u ile aynı.
  weekday         smallint,

  -- BU ZAMANLAMANIN kaç görüntüsü saklanacak. Fazlası, en eskisinden başlayarak siliniyor.
  --
  -- "Bu zamanlamanın" olması güvenlik özelliğinin kendisi: budama yalnız kendi ön ekiyle başlayan
  -- görüntülere dokunuyor. Elle alınmış bir görüntüyü ya da başka bir aracın aldığını silen bir
  -- budama, veri kaybının sessiz biçimi olurdu.
  keep            integer     NOT NULL,

  -- Çoğaltma da zamanlanabiliyor. NULL ise bu zamanlama yalnız görüntü alıyor.
  --
  -- Yerel çoğaltma için `replicate_target`; off-site için ayrıca host, port ve hesap. Off-site
  -- çoğaltmanın §8.1 dizisi (yazılı onay ve yeniden kimlik doğrulama) İLK KURULUMDA yapılıyor;
  -- zamanlama, onaylanmış bir hedefe tekrar tekrar göndermek demek, ve her gece parola sormak bir
  -- zamanlamanın olmaması demek olurdu.
  replicate_target text,
  offsite_host    text,
  offsite_port    integer,
  offsite_user    text,

  enabled         boolean     NOT NULL DEFAULT true,

  -- Bir sonraki koşunun ZAMANI, hesaplanmış hâliyle. Kolonda duruyor çünkü zamanlayıcı tur başına
  -- bir sorgu atıyor ve her satırın cron'unu yeniden yorumlamak, o sorguyu tablo taramasına
  -- çevirirdi.
  next_run_at     timestamptz NOT NULL,
  last_run_at     timestamptz,
  -- Son turun ne yaptığı: `ok`, ya da başarısızlığın kendi cümlesi. Ekranın "en son ne oldu"
  -- sorusuna cevabı, ve `job_queue`'daki iş satırı silindikten sonra da duran tek kayıt.
  last_result     text,

  created_by      uuid        REFERENCES public.users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT backup_schedules_dataset_format
    CHECK (dataset ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,254}$'),
  CONSTRAINT backup_schedules_label_length CHECK (char_length(label) BETWEEN 1 AND 80),
  CONSTRAINT backup_schedules_cadence CHECK (cadence IN ('hourly', 'daily', 'weekly')),
  CONSTRAINT backup_schedules_minute CHECK (at_minute BETWEEN 0 AND 59),
  CONSTRAINT backup_schedules_hour CHECK (at_hour IS NULL OR at_hour BETWEEN 0 AND 23),
  CONSTRAINT backup_schedules_weekday CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),
  -- 1'den az saklamak, aldığı görüntüyü hemen silen bir zamanlama olurdu. Üst sınır, saatlik bir
  -- zamanlamanın bir yılını tutmaya yetiyor ve sonsuz büyümeyi kapatıyor.
  CONSTRAINT backup_schedules_keep CHECK (keep BETWEEN 1 AND 10000),

  -- Ritim, ihtiyaç duyduğu alanları TAŞIMAK ZORUNDA. Saati olmayan bir günlük zamanlama gece mi
  -- öğlen mi koşacağını söylemiyor, ve varsayılan uydurmak kullanıcının vermediği bir cevabı
  -- vermek olurdu.
  CONSTRAINT backup_schedules_cadence_fields CHECK (
    (cadence = 'hourly' AND at_hour IS NULL AND weekday IS NULL) OR
    (cadence = 'daily'  AND at_hour IS NOT NULL AND weekday IS NULL) OR
    (cadence = 'weekly' AND at_hour IS NOT NULL AND weekday IS NOT NULL)
  ),

  -- Off-site'ın üç alanı ya birlikte var ya birlikte yok. İkisi dolu biri boş bir satır, gece
  -- yarısı hangi hesapla bağlanılacağını bilmeyen bir işe dönüşürdü.
  CONSTRAINT backup_schedules_offsite_together CHECK (
    (offsite_host IS NULL AND offsite_port IS NULL AND offsite_user IS NULL) OR
    (offsite_host IS NOT NULL AND offsite_port IS NOT NULL AND offsite_user IS NOT NULL)
  ),
  CONSTRAINT backup_schedules_offsite_port CHECK (
    offsite_port IS NULL OR offsite_port BETWEEN 1 AND 65535
  ),
  -- Bir zamanlama YA yerel YA off-site çoğaltır, ikisini birden değil. İkisi de olsaydı tek bir
  -- satır iki farklı hedefe iki farklı hata modeliyle gönderirdi, ve "bu zamanlama başarısız oldu"
  -- hangisi için olduğunu söylemezdi.
  CONSTRAINT backup_schedules_one_destination CHECK (
    replicate_target IS NULL OR offsite_host IS NULL
  )
);

-- Bir veri kümesi için aynı ritimden iki zamanlama, iki kez aynı anda çalışan ve birbirinin
-- görüntüsünü budayan iki politika demek.
CREATE UNIQUE INDEX backup_schedules_one_per_dataset_cadence
  ON public.backup_schedules (organization_id, dataset, cadence);

-- Zamanlayıcının turluk sorgusu: vakti gelmiş ve açık olanlar.
CREATE INDEX backup_schedules_due
  ON public.backup_schedules (organization_id, next_run_at)
  WHERE enabled;

ALTER TABLE public.backup_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backup_schedules FORCE  ROW LEVEL SECURITY;

CREATE POLICY backup_schedules_owner_full ON public.backup_schedules
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY backup_schedules_tenant ON public.backup_schedules
  FOR ALL
  TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.backup_schedules TO depsis_app;
GRANT SELECT ON public.backup_schedules TO depsis_backup;

-- Zincirin kendisi, öteki beşiyle aynı kalıp: `run_after` tek dayanıklı zamanlayıcı, ve aynı anda
-- yalnız bir tur kuyrukta olabilir. `queued` üzerinde KISMİ — `running`'i de kapsasaydı işleyicinin
-- kendi ardılını kuyruğa alması çakışır ve zincir hiç ilerlemezdi. 0027 aynı cümleyi yazıyor,
-- çünkü aynı hatayı iki kez yapmamanın yolu onu iki yerde de yazmak.
CREATE UNIQUE INDEX job_queue_one_scheduled_backup_tick
  ON public.job_queue (organization_id, kind)
  WHERE kind = 'storage.backup-tick' AND status = 'queued';

-- Down Migration

DROP INDEX IF EXISTS public.job_queue_one_scheduled_backup_tick;
DELETE FROM public.job_queue WHERE kind = 'storage.backup-tick';
DROP TABLE IF EXISTS public.backup_schedules;
