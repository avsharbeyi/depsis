-- §7'nin kalan iki parçası: yorum ve izleyici.
--
-- Bunlar tek bir değişiklik çünkü tek bir nedensel zincir. Bir mention bir YORUMUN içinde yaşıyor;
-- bir yorumun kime ulaşacağı İZLEYİCİ listesinin cevabı; ve bugün o listenin yerinde bir tahmin
-- duruyor — `TasksService.announce` "atanan + oluşturan" diyor. Tahmin çalışıyor ama bir işi
-- izlemek isteyen üçüncü bir kişinin yolu yok, ve olmadığı da hiçbir yerde görünmüyor.

-- Up Migration

-- ── 0. 0026'dan beri eksik olan sahip kaçışı ────────────────────────────────────────────────────
--
-- BU GÖÇÜN KENDİSİ BU YÜZDEN ÇALIŞMIYORDU, ve nasıl bulunduğu kaydedilmeye değer.
--
-- 0025'e kadar her kiracı tablosu İKİ politika taşıyor: `*_owner_full FOR ALL TO depsis_owner
-- USING (true) WITH CHECK (true)` ve `*_tenant_isolation FOR ALL TO depsis_app`. 0026, 0027 ve
-- 0028'in ilk hâli yalnız ikincisini yazdı, ve `TO` cümleciği olmadığı için o politika
-- `TO PUBLIC` — yani `depsis_owner`'a da uygulanıyor. `bootstrap.sql` sahibi `NOBYPASSRLS`
-- yaptığı ve `FORCE ROW LEVEL SECURITY` açık olduğu için, göçün kendisi kendi tablosuna yazamıyor.
--
-- Somut sonuç: aşağıdaki geri doldurma, üzerinde EN AZ BİR GÖREV OLAN her cihazda
-- `new row violates row-level security policy` ile ölüyor ve sürüm kurulamıyor. Boş bir
-- veritabanında ise sıfır satır yazıldığı için hiç değerlendirilmiyor — `migration-check.sh` tam
-- olarak bunu yapıyor, ve o yüzden 56/56 yeşil veriyordu.
--
-- Bir kapının en kötü hâli, kontrol ettiği şeyin hiç ÇALIŞMADIĞI durumda geçmesi. Bu göçle
-- birlikte kapıya canlı bir kontrol eklendi: FORCE RLS olan ama sahibi kabul eden bir politikası
-- olmayan tablo, kırmızı build.
--
-- 0026 ve 0027'nin tabloları da aynı eksikle doğdu; ileri yönlü tek bir düzeltme hepsini kapatıyor.

CREATE POLICY task_file_links_owner_full ON public.task_file_links
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);
CREATE POLICY task_activity_owner_full ON public.task_activity
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);
CREATE POLICY notifications_owner_full ON public.notifications
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

-- Kiracı politikaları da `TO depsis_app`'e daraltılıyor. Sahip artık kendi kaçışından geçiyor, ve
-- iki politikanın da `PUBLIC` olması hangisinin hangi rolü taşıdığını okunmaz yapardı.
ALTER POLICY task_file_links_tenant ON public.task_file_links TO depsis_app;
ALTER POLICY task_activity_tenant   ON public.task_activity   TO depsis_app;
ALTER POLICY notifications_tenant   ON public.notifications   TO depsis_app;

-- ── 1. Yorumlar ─────────────────────────────────────────────────────────────────────────────────

CREATE TABLE public.task_comments (
  id              uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  task_id         uuid        NOT NULL REFERENCES public.tasks (id) ON DELETE CASCADE,

  -- Yazan. Hesap silinince NULL'a düşüyor ve yorum KALIYOR — `task_activity` ile aynı gerekçe:
  -- yorum işin bilgisi, yazanın hesabının bir eklentisi değil. Bir tartışmanın yarısını, taraflardan
  -- biri işten ayrıldı diye silmek, geriye okunamayan bir yarım tartışma bırakır.
  author_id       uuid        REFERENCES public.users (id) ON DELETE SET NULL,

  body            text        NOT NULL,

  -- YUMUŞAK SİLME. Satır duruyor, gövdesi duruyor, ve API silinmiş bir yorumun gövdesini asla
  -- döndürmüyor.
  --
  -- Gövdeyi gerçekten silmek iki şeyi birden kaybettirirdi: denetimi (bir yorumun silinmiş olması,
  -- en çok bakılacak an geldiğinde ne yazdığını da bilmeyi gerektirir) ve tutarlılığı (o yorum bir
  -- mention içeriyorsa bildirimi çoktan gitti — geri alınamayan bir şeyin kaynağını yok etmek,
  -- bildirimi açıklanamaz hâle getirir).
  --
  -- Arayüz "bu yorum silindi" diyor, ki söylenmesi gereken doğru şey bu: bir konuşmadan sessizce
  -- kaybolan bir replika, okuyanı kendi hafızasından şüphe ettirir.
  deleted_at      timestamptz,
  deleted_by      uuid        REFERENCES public.users (id) ON DELETE SET NULL,

  -- Düzenleme zamanı. NULL = hiç düzenlenmedi, ve arayüz farkı söylüyor: sonradan değişmiş bir
  -- cümleyi hiç değişmemiş gibi göstermek, alıntılanabilir olmayan bir kayıt üretir.
  edited_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- Dört bin karakter. Bir yorum kutusu, bir dosya değil; sınırı olmayan bir metin alanı, tek
  -- satırla bir sayfayı okunmaz yapmanın yolu. Boşluk-yalnız gövde de reddediliyor — gönderildiği
  -- an hiçbir şey söylemeyen bir yorum, listede yer kaplayan bir boşluk.
  CONSTRAINT task_comments_body_sane
    CHECK (btrim(body) <> '' AND length(body) <= 4000),

  -- SİLME OTORİTESİ `deleted_at`, ve YALNIZ O.
  --
  -- Burada bir zamanlar "ikisi birlikte var ya da birlikte yok" diyen bir CHECK vardı, ve o CHECK
  -- `deleted_by`'ın `ON DELETE SET NULL` olmasıyla doğrudan çelişiyordu: bir yorumu silen kişinin
  -- hesabı kapatıldığında `deleted_by` NULL'a düşüyor, `deleted_at` duruyor, ve kısıt ihlal
  -- ediliyor — yani KULLANICI SİLME işlemi bir kısıt hatasıyla başarısız oluyordu. Bir hesabın
  -- kapatılabilmesi, o hesabın bir yorum silmiş olmasına bağlı olamaz.
  --
  -- Yani "kim sildi" bilgisi kaybolabilir, "silindi" bilgisi kaybolamaz — ve doğru öncelik bu:
  -- denetim izinin ilk cevaplaması gereken soru, bir şeyin var olup olmadığı.
  CONSTRAINT task_comments_deleted_by_needs_deletion
    CHECK (deleted_by IS NULL OR deleted_at IS NOT NULL)
);

-- Bir görevin yorumları, ESKİ ÖNCE: bir tartışma yukarıdan aşağı okunuyor. Bildirim listesi en yeni
-- önce çünkü orada okunacak olan son olay; burada okunacak olan konuşmanın kendisi.
CREATE INDEX task_comments_by_task
  ON public.task_comments (organization_id, task_id, created_at);

ALTER TABLE public.task_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_comments FORCE ROW LEVEL SECURITY;

CREATE POLICY task_comments_owner_full ON public.task_comments
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY task_comments_tenant ON public.task_comments
  FOR ALL TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

-- DELETE YOK, ve bu bir eksiklik değil: silme `deleted_at` ile yapılıyor, yani bir UPDATE.
-- Uygulamanın satırı gerçekten kaldıracak bir yolu olmaması, yumuşak silmenin gerçekten yumuşak
-- kalmasının tek garantisi — aksi hâlde bir gün bir kod yolu "temizlik" adına onu sertleştirir.
GRANT SELECT, INSERT, UPDATE ON public.task_comments TO depsis_app;

-- ── 2. İzleyiciler ──────────────────────────────────────────────────────────────────────────────
--
-- §7 "izleyici" istiyor, ve bugün bildirim onun yerine bir tahmin kullanıyor: atanan ve oluşturan.
-- Tahminin yanlış olduğu yer, ilgilenen ÜÇÜNCÜ kişi — bir işi verenle yapan arasında duran, ama
-- sonucunu bekleyen biri. Bu tablo o kişiye bir yol açıyor.
CREATE TABLE public.task_watchers (
  id              uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  task_id         uuid        NOT NULL REFERENCES public.tasks (id) ON DELETE CASCADE,

  -- `ON DELETE CASCADE`, bildirimlerdeki gibi ve `task_activity`'nin tersine: bir abonelik, abone
  -- olan kişi gittiğinde anlamını kaybediyor. Kimseye ait olmayan bir izleyici satırı, hiç kimseye
  -- gönderilecek bir bildirim üretirdi.
  user_id         uuid        NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,

  -- Kendi mi seçti, yoksa bir eylem yüzünden mi eklendi. Fark ürün açısından gerçek: bir işten
  -- çıkan kişi ('manual' → satır silinir) ile bir daha atanmayan kişi arasında, ikincisinin
  -- yeniden atandığında yeniden izlemesi doğru.
  --
  -- Bugün ikisi de aynı davranıyor; sütun, ayrımın kaybolmaması için burada. Bir kolon eklemek
  -- ucuz, kaybolmuş bir ayrımı sonradan geri getirmek değil.
  source          text        NOT NULL DEFAULT 'manual',
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT task_watchers_source_known
    CHECK (source IN ('manual', 'created', 'assigned', 'commented')),

  -- Bir kişi bir işi iki kez izleyemez. `organization_id` de anahtarda — tehdit modeli §5.3: kiracı
  -- sütununu içermeyen bir benzersizlik kısıtı bir covert channel, çünkü RLS satırı gizlerken kısıt
  -- ihlali onun VARLIĞINI söyler.
  CONSTRAINT task_watchers_unique UNIQUE (organization_id, task_id, user_id)
);

-- "Bu işi kim izliyor" — bildirim üretilirken her seferinde sorulan soru.
CREATE INDEX task_watchers_by_task ON public.task_watchers (organization_id, task_id);
-- Ters yön: "ben neyi izliyorum". Panonun kişisel görünümü buradan geliyor.
CREATE INDEX task_watchers_by_user ON public.task_watchers (organization_id, user_id);

ALTER TABLE public.task_watchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_watchers FORCE ROW LEVEL SECURITY;

CREATE POLICY task_watchers_owner_full ON public.task_watchers
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY task_watchers_tenant ON public.task_watchers
  FOR ALL TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, DELETE ON public.task_watchers TO depsis_app;

-- ── 3. Var olan işlerin izleyicileri ─────────────────────────────────────────────────────────────
--
-- Bugüne kadarki davranış "atanan + oluşturan"dı. Göç o davranışı SATIRA çeviriyor: aksi hâlde bu
-- sürüm, var olan her işin bildirimlerini sessizce durdururdu — kimse izlemiyor olurdu, ve kimse
-- gelmeyen bir bildirimi fark etmezdi.
--
-- Kapanmış işler dahil: bir iş yeniden açılabiliyor, ve açıldığında eski taraflarının haberi olmalı.
INSERT INTO public.task_watchers (organization_id, task_id, user_id, source)
SELECT t.organization_id, t.id, t.created_by, 'created'
  FROM public.tasks t
 WHERE t.created_by IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO public.task_watchers (organization_id, task_id, user_id, source)
SELECT t.organization_id, t.id, t.assignee_id, 'assigned'
  FROM public.tasks t
 WHERE t.assignee_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ── 4. İki yeni bildirim türü ───────────────────────────────────────────────────────────────────
--
-- `task.comment` ve `task.mention`. Mention artık BOŞ BİR SÖZ DEĞİL: onu üretecek bir şey var, ve
-- 0027'de türü eklememenin sebebi tam olarak buydu.
ALTER TABLE public.notifications DROP CONSTRAINT notifications_kind_known;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_kind_known
  CHECK (kind IN ('task.assigned', 'task.unassigned', 'task.status', 'task.due', 'task.overdue',
                  'task.comment', 'task.mention'));

-- `task_activity.field` da bir tane kazanıyor: bir yorumun SİLİNMESİ bir denetim olayı. Eklenmesi
-- değil — yorum listesinin kendisi zaten o kaydı tutuyor, ve iki yere yazmak iki farklı doğruluk
-- kaynağı demek. Kaybolan şeyin izi ise başka hiçbir yerde kalmıyor.
ALTER TABLE public.task_activity DROP CONSTRAINT task_activity_field_known;
ALTER TABLE public.task_activity ADD CONSTRAINT task_activity_field_known
  CHECK (field IN ('status', 'priority', 'due_at', 'assignee_id', 'body', 'file_link', 'comment'));

SELECT public.assert_rls_roles_sane();

-- Down Migration

-- Türler önce geri alınıyor, tablolar sonra: sırası ters olsaydı `task.comment` taşıyan bir satır
-- kısıtı ihlal ederdi. Silme, kısıt daralmadan ÖNCE olmalı.
DELETE FROM public.notifications WHERE kind IN ('task.comment', 'task.mention');
ALTER TABLE public.notifications DROP CONSTRAINT notifications_kind_known;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_kind_known
  CHECK (kind IN ('task.assigned', 'task.unassigned', 'task.status', 'task.due', 'task.overdue'));

DELETE FROM public.task_activity WHERE field = 'comment';
ALTER TABLE public.task_activity DROP CONSTRAINT task_activity_field_known;
ALTER TABLE public.task_activity ADD CONSTRAINT task_activity_field_known
  CHECK (field IN ('status', 'priority', 'due_at', 'assignee_id', 'body', 'file_link'));

DROP TABLE IF EXISTS public.task_watchers;
DROP TABLE IF EXISTS public.task_comments;
