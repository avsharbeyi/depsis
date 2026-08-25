-- Görev modülü §7'nin istediği şeye doğru: durum makinesi, öncelik, son tarih, dosya bağlantısı
-- ve aktivite.
--
-- Bugüne kadar `tasks` dört alandı: gövde, atanan, `done_at`, sıra. Bir paylaşımlı yapılacaklar
-- listesi olarak çalışıyordu ve §7'nin istediği şey o değil — "yönetici alt kullanıcılara iş
-- verebilmeli ve İLERLEMEYİ görebilmeli". İlerleme iki durumlu bir alanda görünmüyor: "atandı" ile
-- "devam ediyor" ile "incelemede" arasındaki fark, o cümlenin tamamı.
--
-- Yorum, alt görev, kontrol listesi, etiket ve izleyici bu göçte YOK ve bilerek: her biri kendi
-- tablosu ve kendi ekranı, ve hepsini bir seferde eklemek beşini de yarım bırakmanın yolu.

-- Up Migration

-- Bu göç RLS politikaları kuruyor. BYPASSRLS bir role uygulanırsa o rol politikaları yok sayar ve
-- kiracı yalıtımı sessizce hiç var olmaz — `migration-check.sh` 0001'den sonraki her göçte bu
-- çağrıyı arıyor.
SELECT public.assert_rls_roles_sane();

-- ── 1. Durum ────────────────────────────────────────────────────────────────────────────────────
--
-- Metin ve enum tipi DEĞİL. Bir PostgreSQL enum'una değer eklemek `ALTER TYPE`, çıkarmak imkânsız,
-- ve §7 organizasyonların kendi akışlarını tanımlayabilmesini istiyor — bugün yazılmıyor ama tipin
-- kendisi onu yasaklamamalı. Kısıt bir CHECK, yani bir göçle genişletilebilir ve daraltılabilir.
ALTER TABLE public.tasks
  ADD COLUMN status text NOT NULL DEFAULT 'draft';

ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_status_known
  CHECK (status IN ('draft', 'assigned', 'in_progress', 'in_review', 'done', 'cancelled'));

-- `done_at` KALDIRILMIYOR, ve bu bir tereddüt değil. Durum "ne olduğu", `done_at` "ne zaman
-- olduğu" — ikisi farklı sorular ve ikincisinin cevabı birinciden türetilemez. Ama artık ikisinin
-- ANLAŞMASI şart: `done_at` dolu bir `in_progress` görevi, iki alanın iki farklı şey söylediği bir
-- satırdır ve hangisinin doğru olduğunu kimse bilemez.
ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_done_at_matches_status
  CHECK ((status = 'done') = (done_at IS NOT NULL));

-- Var olan satırlar: `done_at` doluysa bitmiş, boşsa ve atanmışsa atanmış, hiçbiri değilse taslak.
-- Bu, eski iki durumlu alandan çıkarılabilecek en dürüst eşleme — "devam ediyor" bilgisi hiç
-- kaydedilmemişti, o yüzden uydurulmuyor.
UPDATE public.tasks
   SET status = CASE
                  WHEN done_at IS NOT NULL THEN 'done'
                  WHEN assignee_id IS NOT NULL THEN 'assigned'
                  ELSE 'draft'
                END;

-- ── 2. Öncelik ve son tarih ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.tasks
  ADD COLUMN priority text NOT NULL DEFAULT 'normal',
  -- Tarih değil ZAMAN DAMGASI, ve nullable. "Yarın" bir zaman diliminde yarın, başkasında bugün;
  -- bir son tarihin hangi ana denk geldiği, gecikmiş olup olmadığını belirleyen şeyin ta kendisi.
  ADD COLUMN due_at timestamptz;

ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_priority_known
  CHECK (priority IN ('low', 'normal', 'high', 'urgent'));

-- Gecikmiş işleri bulmak için. Kısmi: son tarihi olmayan ve bitmiş görevler indekste yer
-- kaplamıyor, ve bir yapılacaklar listesinde satırların çoğu zamanla o iki kümeye giriyor.
CREATE INDEX tasks_due ON public.tasks (organization_id, due_at)
  WHERE due_at IS NOT NULL AND status <> 'done' AND status <> 'cancelled';

-- ── 3. Dosya bağlantısı ─────────────────────────────────────────────────────────────────────────
--
-- §7: "Görev klasöre veya dosyaya bağlanabilir; görev erişimi GİZLİ DOSYA ERİŞİMİ VERMEMELİDİR.
-- Eklenen dosya için ayrıca ACL kontrolü gerekir."
--
-- Bu tablo bir BAĞ, bir izin değil. Satırın varlığı hiç kimseye hiçbir şeye erişim vermiyor: API
-- her okumada dosyanın kendi izinlerini ayrıca çözüyor, ve göremeyeceği bir dosyanın bağı ona
-- dosyanın VARLIĞINI bile söylemiyor — liste o satırı hiç döndürmüyor.
--
-- Bunu şemada zorlamanın yolu yok ve olduğunu iddia etmek yanlış olurdu; burada yapılabilecek şey,
-- yanlış anlaşılmayı zorlaştırmak: tablonun adı `task_files` DEĞİL `task_file_links`, çünkü ilki
-- "görevin dosyaları" diye okunuyor.
CREATE TABLE public.task_file_links (
  id              uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  task_id         uuid        NOT NULL REFERENCES public.tasks (id) ON DELETE CASCADE,

  -- `ON DELETE CASCADE`: dosya gerçekten silindiyse bağ da gitmeli. Bir bağın işaret ettiği satır
  -- yoksa, listede "bir şeye bağlı ama neye bilinmiyor" diye görünürdü.
  file_entry_id   uuid        NOT NULL REFERENCES public.file_entries (id) ON DELETE CASCADE,

  -- Kim bağladı. Silinen bir kullanıcıda NULL'a düşüyor; bağ kalıyor, çünkü bağın kendisi işin
  -- bilgisi ve onu ekleyen kişinin hesabından bağımsız.
  linked_by       uuid        REFERENCES public.users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- Aynı dosya bir göreve iki kez bağlanamaz. İkinci bağ hiçbir şey ifade etmiyor ve arayüzde iki
  -- özdeş satır olarak görünürdü.
  --
  -- `organization_id` DA anahtarda, ve iki uuid'nin kiracılar arasında çakışmayacağı doğru olduğu
  -- hâlde. Sebep tehdit modelinin §5.3'ü: kiracı sütununu içermeyen bir benzersizlik kısıtı bir
  -- covert channel'dır — RLS satırı gizlerken kısıt ihlali onun VARLIĞINI söyler, ve fark 409 ile
  -- 201 arasındadır. `migration-check.sh` bunu mutlak bir kural olarak arıyor, tam da "bu sefer
  -- çakışamaz" muhakemesinin her seferinde makul görünmesi yüzünden.
  CONSTRAINT task_file_links_unique UNIQUE (organization_id, task_id, file_entry_id)
);

CREATE INDEX task_file_links_by_task ON public.task_file_links (organization_id, task_id);
-- Ters yön: "bu dosya hangi işlerde geçiyor". Dosya silinirken CASCADE'in tarayacağı indeks de bu.
CREATE INDEX task_file_links_by_file ON public.task_file_links (organization_id, file_entry_id);

ALTER TABLE public.task_file_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_file_links FORCE ROW LEVEL SECURITY;

CREATE POLICY task_file_links_tenant ON public.task_file_links
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, DELETE ON public.task_file_links TO depsis_app;

-- ── 4. Aktivite ─────────────────────────────────────────────────────────────────────────────────
--
-- §7: "Görev audit'i: kim, neyi, ne zaman, hangi eski/yeni değerle değiştirdi. Kullanıcı silinse
-- bile denetim kaydı anonimleştirme/saklama politikası uyarınca korunmalıdır."
--
-- Son cümle `ON DELETE SET NULL`'un sebebi: hesap gidince satır KALIYOR, aktör anonimleşiyor. Bir
-- denetim kaydını silinen bir kullanıcıyla birlikte silmek, denetimin var olma sebebini ortadan
-- kaldırır — en çok bakılacağı an, birinin hesabının kapatıldığı andır.
CREATE TABLE public.task_activity (
  id              uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  task_id         uuid        NOT NULL REFERENCES public.tasks (id) ON DELETE CASCADE,
  actor_id        uuid        REFERENCES public.users (id) ON DELETE SET NULL,

  -- Ne değişti: `status`, `priority`, `due_at`, `assignee_id`, `body`, `file_link`.
  field           text        NOT NULL,
  -- Eski ve yeni, METİN olarak. Tipli sütunlar tutmak alan başına bir sütun demek, ve jsonb
  -- tutmak "eski değer neydi" sorusunu bir sorgu haline getirir. Bu tablo OKUNMAK için var.
  old_value       text,
  new_value       text,

  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT task_activity_field_known
    CHECK (field IN ('status', 'priority', 'due_at', 'assignee_id', 'body', 'file_link'))
);

-- En yeni önce, göreve göre. Aktivite her zaman bir görevin ekranında okunuyor.
CREATE INDEX task_activity_by_task
  ON public.task_activity (organization_id, task_id, created_at DESC);

ALTER TABLE public.task_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_activity FORCE ROW LEVEL SECURITY;

CREATE POLICY task_activity_tenant ON public.task_activity
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

-- DELETE yok, ve bu bir unutma değil. Bir denetim izi, izlediği şeyi yapan uygulamanın
-- silebildiği bir şeyse denetim izi değildir. Satırlar yalnız görev silindiğinde CASCADE ile
-- gidiyor — ve o da bir göçle geri alınacak bir karar, uygulamanın verebileceği bir karar değil.
GRANT SELECT, INSERT ON public.task_activity TO depsis_app;

-- Down Migration

DROP TABLE IF EXISTS public.task_activity;
DROP TABLE IF EXISTS public.task_file_links;

DROP INDEX IF EXISTS public.tasks_due;

ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_priority_known;
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_done_at_matches_status;
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_status_known;

ALTER TABLE public.tasks
  DROP COLUMN IF EXISTS due_at,
  DROP COLUMN IF EXISTS priority,
  DROP COLUMN IF EXISTS status;
