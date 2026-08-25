-- §7'nin "alt görev" ve "kontrol listesi" maddeleri.
--
-- İKİSİ BİR ARADA çünkü aynı ihtiyacın iki ağırlığı: bir işi parçalara ayırmak. Fark, parçanın
-- kendi başına bir iş olup olmadığı — bir ALT GÖREV atanabiliyor, kendi durumu ve son tarihi
-- oluyor, bildirim üretiyor; bir KONTROL LİSTESİ MADDESİ yalnız bir satır ve bir tik.
--
-- İkisi de olmasaydı insanlar birini ötekinin yerine kullanırdı, ve ikisi de kötü olurdu: her
-- alt adım için ayrı bir iş açmak panoyu okunmaz yapıyor, tek bir gövdeye madde madde yazmak da
-- hiçbirini takip edilebilir yapmıyor.

-- Up Migration

SELECT public.assert_rls_roles_sane();

-- ── 1. Alt görevler ─────────────────────────────────────────────────────────────────────────────
--
-- Bir sütun, yeni bir tablo değil: bir alt görev tam olarak bir görev. Ayrı bir tablo, atama,
-- durum, öncelik, son tarih, yorum, izleyici ve denetimin İKİNCİ bir kopyasını gerektirirdi — ve o
-- kopyalar zamanla ayrışırdı.
ALTER TABLE public.tasks
  -- `ON DELETE CASCADE`: bir üst işi silmek parçalarını da siliyor. Alternatifi, işaret ettiği şey
  -- olmayan bir alt görev — panoda "bir şeyin parçası ama neyin bilinmiyor" diye duran bir satır.
  -- Arayüz silmeden önce kaç parçanın gideceğini söylüyor, çünkü sessiz bir kaskat veri kaybının
  -- en sık biçimi.
  ADD COLUMN parent_id uuid REFERENCES public.tasks (id) ON DELETE CASCADE;

-- "Bu işin parçaları" — panonun her yüklenişinde sorulan soru.
CREATE INDEX tasks_children ON public.tasks (organization_id, parent_id)
  WHERE parent_id IS NOT NULL;

/*
 * TEK SEVİYE, ve bunu VERİTABANI tutuyor.
 *
 * Bir iş bir alt göreve sahip olabiliyor; bir alt görev sahip OLAMIYOR. Keyfi derinlikte bir ağaç,
 * bir yapılacaklar panosunu bir dosya yöneticisine çeviriyor — ve dört seviye derindeki bir işin
 * kime ait olduğu hiçbir ekranda okunamıyor.
 *
 * KURALIN BURADA OLMASININ SEBEBİ: bir CHECK bunu ifade edemiyor (başka bir satıra bakması
 * gerekiyor), ve yalnız serviste tutulan bir kural, ikinci bir yazma yolu açıldığı gün sessizce
 * kayboluyor. Bu projede tam olarak o sınıftan yeterince hata bulundu.
 *
 * Kendine ebeveynlik de burada kesiliyor: `parent_id = id` bir CHECK'in yakalayabileceği bir şey
 * ama aynı yerde durması, kuralın tamamını tek bir okumada görünür yapıyor.
 */
CREATE FUNCTION public.tasks_one_level_deep() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS NULL THEN
    -- Üst iş olmaktan çıkmıyor; yalnız parçası olduğu şey yok. Kontrol edilecek bir şey de yok.
    RETURN NEW;
  END IF;

  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'a task cannot be its own parent'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Ebeveynin kendisinin bir ebeveyni varsa, bu satır ikinci seviye olurdu.
  IF EXISTS (SELECT 1 FROM public.tasks p WHERE p.id = NEW.parent_id AND p.parent_id IS NOT NULL)
  THEN
    RAISE EXCEPTION 'a subtask cannot have subtasks of its own'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Ve ters yön: bu satırın kendi parçaları varken bir ebeveyn edinmesi de aynı ağacı kurardı.
  IF EXISTS (SELECT 1 FROM public.tasks c WHERE c.parent_id = NEW.id) THEN
    RAISE EXCEPTION 'a task with subtasks cannot become a subtask'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER tasks_one_level_deep
  BEFORE INSERT OR UPDATE OF parent_id ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.tasks_one_level_deep();

-- ── 2. Kontrol listesi ──────────────────────────────────────────────────────────────────────────
--
-- Bir işin içindeki maddeler. Atanamıyor, son tarihi yok, bildirim üretmiyor — bunların hepsini
-- isteyen şey zaten bir alt görev.
CREATE TABLE public.task_checklist_items (
  id              uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  task_id         uuid        NOT NULL REFERENCES public.tasks (id) ON DELETE CASCADE,

  body            text        NOT NULL,

  -- Zaman damgası, boolean değil — `tasks.done_at` ile aynı gerekçe: "yapıldı" ile "dün 14:02'de
  -- yapıldı" aynı yeri kaplıyor ve ikincisi birincisinin cevaplayamadığı soruları cevaplıyor.
  done_at         timestamptz,
  -- Kim tikledi. Hesap kapanınca NULL'a düşüyor; madde kalıyor, çünkü madde işin bilgisi.
  done_by         uuid        REFERENCES public.users (id) ON DELETE SET NULL,

  -- `tasks.position` ile aynı: float, çünkü iki maddenin arasına sürüklemek tek bir UPDATE.
  position        double precision NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT task_checklist_body_sane
    CHECK (btrim(body) <> '' AND length(body) <= 500),

  -- `done_by` ancak tiklenmiş bir maddede anlamlı. Ters yön SERBEST, ve bilerek: `ON DELETE SET
  -- NULL` yüzünden tikleyen kişinin hesabı kapandığında `done_by` NULL'a düşüyor ve `done_at`
  -- duruyor. Bunu yasaklayan bir kısıt, bir hesabın kapatılmasını o hesabın bir madde tiklemiş
  -- olmasına bağlardı — 0028'de tam olarak bu hata bulundu ve düzeltildi.
  CONSTRAINT task_checklist_done_by_needs_done
    CHECK (done_by IS NULL OR done_at IS NOT NULL)
);

-- Bir işin maddeleri, kullanıcının dizdiği sırayla.
CREATE INDEX task_checklist_by_task
  ON public.task_checklist_items (organization_id, task_id, position, created_at);

ALTER TABLE public.task_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_checklist_items FORCE ROW LEVEL SECURITY;

-- İKİ POLİTİKA, ve 0026-0028'in ilk hâllerinde eksik olan tam olarak birincisiydi: `depsis_owner`
-- `NOBYPASSRLS` ve `FORCE` açık olduğu için, sahibi kabul eden bir politika olmadan göçün kendisi
-- tabloya yazamıyor. `migration-check.sh` artık bunu canlı olarak arıyor.
CREATE POLICY task_checklist_items_owner_full ON public.task_checklist_items
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY task_checklist_items_tenant ON public.task_checklist_items
  FOR ALL TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_checklist_items TO depsis_app;

-- ── 3. Denetimin iki yeni alanı ─────────────────────────────────────────────────────────────────
--
-- `parent_id` bir işin nereye ait olduğunu değiştiriyor, ve bu §7'nin "kim, neyi, ne zaman"
-- listesine giren bir değişiklik. `checklist` ise maddelerin EKLENMESİ ve SİLİNMESİ için — tiklemek
-- için değil: bir tik günde yirmi kez değişebilen bir şey, ve her birini denetime yazmak izi
-- okunmaz yapardı. Yorumdaki karar da aynıydı, ters yönde.
ALTER TABLE public.task_activity DROP CONSTRAINT task_activity_field_known;
ALTER TABLE public.task_activity ADD CONSTRAINT task_activity_field_known
  CHECK (field IN ('status', 'priority', 'due_at', 'assignee_id', 'body', 'file_link', 'comment',
                   'parent_id', 'checklist'));

-- Down Migration

DELETE FROM public.task_activity WHERE field IN ('parent_id', 'checklist');
ALTER TABLE public.task_activity DROP CONSTRAINT task_activity_field_known;
ALTER TABLE public.task_activity ADD CONSTRAINT task_activity_field_known
  CHECK (field IN ('status', 'priority', 'due_at', 'assignee_id', 'body', 'file_link', 'comment'));

DROP TABLE IF EXISTS public.task_checklist_items;

DROP TRIGGER IF EXISTS tasks_one_level_deep ON public.tasks;
DROP FUNCTION IF EXISTS public.tasks_one_level_deep();
DROP INDEX IF EXISTS public.tasks_children;
ALTER TABLE public.tasks DROP COLUMN IF EXISTS parent_id;
