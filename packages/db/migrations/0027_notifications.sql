-- Bildirim merkezi. §7: "Hatırlatma, gecikme, mention ve görev değişiklikleri bildirim merkezine
-- düşer."
--
-- MENTION BU GÖÇTE YOK, ve bilerek: bir mention bir yorumun içinde yaşıyor ve yorumlar henüz
-- yazılmadı. Boş bir `kind` değeri eklemek, hiçbir şeyin üretmediği bir tür bırakmak olurdu — ve
-- kısıt bir CHECK olduğu için o gün tek satırlık bir göçle eklenebilir.

-- Up Migration

SELECT public.assert_rls_roles_sane();

-- ── Alıcı başına bir satır ──────────────────────────────────────────────────────────────────────
--
-- Paylaşılan bir olay + kişi başına okundu işareti DEĞİL. İki sebep:
--
-- Birincisi, bir bildirim alıcıya AİT: kendi listesinden silebilmeli, ve paylaşılan bir olayı
-- silmek başkasınınkini de silerdi. İkincisi ve daha önemlisi, aynı olay iki kişiye iki farklı şey
-- söylüyor — bir işin atanması, atanan için "sana iş geldi", oluşturan için "işin devredildi" — ve
-- tek satır, ikisinden birini yanlış cümleyle karşılamak zorunda kalırdı.
--
-- Maliyeti satır sayısı: on kişilik bir organizasyonda bir olay on satır. Bir NAS'ta bu, hiçbir
-- şey.
CREATE TABLE public.notifications (
  id              uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,

  -- Alıcı. Hesap silinirse bildirimleri de gider: kimseye ait olmayan bir bildirim, kimsenin
  -- okumayacağı bir satırdır — `task_activity`'nin tersi, ve fark bilinçli. O bir DENETİM kaydı,
  -- bu bir mesaj.
  user_id         uuid        NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,

  kind            text        NOT NULL,

  -- Neyin hakkında. Bugün her zaman bir görev; `task_id` yerine genel bir `subject_id` yazmak,
  -- yabancı anahtarı kaybetmek olurdu — ve silinmiş bir şeye işaret eden bir bildirim, tıklanınca
  -- hiçbir yere gitmeyen bir satır.
  task_id         uuid        REFERENCES public.tasks (id) ON DELETE CASCADE,

  -- Metin SUNUCUDA üretiliyor, istemcide değil. Bir bildirim "o an ne olduğunu" anlatıyor; iki ay
  -- sonra göreve bakıp cümleyi yeniden kurmak, o zamanki hâli değil BUGÜNKÜ hâli anlatırdı.
  title           text        NOT NULL,

  -- Okundu. Boolean değil zaman damgası, `done_at` ile aynı gerekçe: "okundu" ile "dün 14:02'de
  -- okundu" aynı yeri kaplıyor ve ikincisi birincisinin cevaplayamadığı soruları cevaplıyor.
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notifications_kind_known
    CHECK (kind IN ('task.assigned', 'task.unassigned', 'task.status', 'task.due', 'task.overdue')),
  CONSTRAINT notifications_title_present
    CHECK (btrim(title) <> '' AND length(title) <= 300)
);

-- Zilin sorduğu soru: "benim okunmamışım var mı". Kısmi indeks, çünkü okunmuş bildirimler zamanla
-- satırların çoğunluğu oluyor ve o sorunun cevabında hiç yer almıyorlar.
CREATE INDEX notifications_unread
  ON public.notifications (organization_id, user_id, created_at DESC)
  WHERE read_at IS NULL;

-- Liste görünümü: okunmuşlar dahil, en yeni önce.
CREATE INDEX notifications_inbox
  ON public.notifications (organization_id, user_id, created_at DESC);

-- ── Tekrarı önleyen kısıt ───────────────────────────────────────────────────────────────────────
--
-- Gecikme taraması dakikada bir koşuyor. Onsuz, gecikmiş bir iş her turda yeni bir satır üretir ve
-- bir hafta sonra bin bildirim olur — bildirim merkezinin işe yaramaz hâle gelmesinin standart
-- yolu, ve kullanıcıya zilin hiçbir şey ifade etmediğini öğreten şey.
--
-- OKUNMAMIŞLAR üzerinde kısmi: aynı iş için ikinci bir "gecikti" ancak birincisi okunduktan sonra
-- anlamlı olur, ve o zaman da anlamlı olmaz — ama kısıt onu engellemiyor, çünkü bir kullanıcının
-- okuduğu bir bildirimi yeniden üretmek başka bir hata sınıfı ve burada çözülmesi gereken bu değil.
CREATE UNIQUE INDEX notifications_one_unread_per_task_kind
  ON public.notifications (organization_id, user_id, task_id, kind)
  WHERE read_at IS NULL AND task_id IS NOT NULL;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications FORCE ROW LEVEL SECURITY;

-- Kiracı politikası, ve YALNIZ o. "Yalnız kendi bildirimlerini gör" bir politika DEĞİL, çünkü RLS
-- oturumdaki kullanıcıyı bilmiyor — `depsis.organization_id` var, `depsis.user_id` yok. Kişi
-- filtresi sorgunun kendisinde, ve bu bilinçli: ikinci bir oturum değişkeni eklemek, unutulduğunda
-- SESSİZCE herkesin her şeyi gördüğü bir sistem üretirdi. Kiracı sınırı politikada olduğu için o
-- risk kiracıyı geçemiyor.
CREATE POLICY notifications_tenant ON public.notifications
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO depsis_app;

-- Gecikme taraması için, `files.index-drain` ile aynı kalıp: `run_after` TEK dayanıklı zamanlayıcı,
-- ve aynı anda yalnız bir tane kuyrukta olabilir. `queued` üzerinde kısmi — `running`'i de
-- kapsasaydı işleyicinin kendi ardılını kuyruğa alması çakışır ve zincir hiç ilerlemezdi.
CREATE UNIQUE INDEX job_queue_one_scheduled_overdue_sweep
  ON public.job_queue (organization_id, kind)
  WHERE kind = 'tasks.overdue-sweep' AND status = 'queued';

-- Down Migration

DROP INDEX IF EXISTS public.job_queue_one_scheduled_overdue_sweep;
DROP TABLE IF EXISTS public.notifications;
