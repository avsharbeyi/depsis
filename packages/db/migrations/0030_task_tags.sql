-- §7'nin son maddesi: etiket.
--
-- Etiket, panoyu KESEN ikinci bir eksen. Pano kişiye göre gruplanıyor — "kim ne yapıyor" — ve o
-- soru işlerin yarısını cevaplıyor; ötekisi "hangi konu". Durum, öncelik ve son tarih işin kendi
-- hâli hakkında; etiket, işin neye AİT olduğu hakkında, ve o bilgi bugün hiçbir yerde yok.

-- Up Migration

SELECT public.assert_rls_roles_sane();

-- ── 1. Etiketin kendisi ─────────────────────────────────────────────────────────────────────────
--
-- KİRACININ SÖZLÜĞÜ, işin bir alanı değil. Etiketi `tasks` üzerinde bir metin dizisi olarak tutmak
-- daha az tablo olurdu ve tam olarak bir sözlüğün çözdüğü şeyi çözmezdi: "acil", "Acil" ve "acıl"
-- üç ayrı etiket olur, ve kimse hangisini yazdığını hatırlamaz. Bir satır olduğunda yeniden
-- adlandırılabiliyor, rengi değişebiliyor, ve kaç işte kullanıldığı sayılabiliyor.
CREATE TABLE public.task_tags (
  id              uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,

  name            text        NOT NULL,

  -- Benzersizlik KATLANMIŞ ad üzerinden, ve `fold_identity` kullanıcı adlarındaki aynı fonksiyon:
  -- büyük/küçük harf ve Türkçe i ailesi katlanıyor, aksanlar KATLANMIYOR. "Çağrı" ile "Cagri"yi
  -- birleştirmek arama için doğru, kimlik için yanlış — ve bir etiket adı burada bir kimlik.
  name_folded     text        GENERATED ALWAYS AS (public.fold_identity(name)) STORED,

  -- Renk, SABİT BİR PALETTEN. Serbest bir hex alanı, arayüzü birkaç hafta içinde okunmaz kılıyor:
  -- karanlık zemine karşı görünmeyen bir etiket, olmayan bir etiket. Palet, tasarımın kendi
  -- vurgu renkleri.
  color           text        NOT NULL DEFAULT 'iris',
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT task_tags_name_sane
    CHECK (btrim(name) <> '' AND length(name) <= 40),
  CONSTRAINT task_tags_color_known
    CHECK (color IN ('iris', 'mint', 'cyan', 'amber', 'rose', 'slate')),

  -- `organization_id` anahtarda — tehdit modeli §5.3: kiracı sütununu içermeyen bir benzersizlik
  -- kısıtı bir covert channel, çünkü RLS satırı gizlerken kısıt ihlali onun VARLIĞINI söyler.
  CONSTRAINT task_tags_unique UNIQUE (organization_id, name_folded)
);

ALTER TABLE public.task_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_tags FORCE ROW LEVEL SECURITY;

CREATE POLICY task_tags_owner_full ON public.task_tags
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY task_tags_tenant ON public.task_tags
  FOR ALL TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_tags TO depsis_app;

-- ── 2. İşe bağlanması ───────────────────────────────────────────────────────────────────────────
CREATE TABLE public.task_tag_links (
  id              uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  task_id         uuid        NOT NULL REFERENCES public.tasks (id) ON DELETE CASCADE,

  -- `ON DELETE CASCADE`: etiket silinince bağları da gidiyor. Alternatifi, adı olmayan bir etikete
  -- işaret eden bir bağ — panoda boş bir çip. Etiket silmenin bu yan etkisi var ve arayüz onu
  -- silmeden önce söylüyor: kaç işten kalkacağını.
  tag_id          uuid        NOT NULL REFERENCES public.task_tags (id) ON DELETE CASCADE,

  -- Kim etiketledi. Denetim için değil — `task_activity` o işi görüyor — bir çipin üstünde
  -- gösterilebilmesi için: bir işin neden "acil" olduğunu soran kişinin ilk sorusu kimin öyle
  -- dediği.
  tagged_by       uuid        REFERENCES public.users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT task_tag_links_unique UNIQUE (organization_id, task_id, tag_id)
);

-- "Bu işin etiketleri" — pano her yüklendiğinde, bütün işler için.
CREATE INDEX task_tag_links_by_task ON public.task_tag_links (organization_id, task_id);
-- Ters yön: "bu etiketli işler", ve etiket silinirken CASCADE'in tarayacağı indeks de bu.
CREATE INDEX task_tag_links_by_tag ON public.task_tag_links (organization_id, tag_id);

ALTER TABLE public.task_tag_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_tag_links FORCE ROW LEVEL SECURITY;

CREATE POLICY task_tag_links_owner_full ON public.task_tag_links
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY task_tag_links_tenant ON public.task_tag_links
  FOR ALL TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, DELETE ON public.task_tag_links TO depsis_app;

-- ── 3. Denetim ──────────────────────────────────────────────────────────────────────────────────
--
-- Bir işin etiketlenmesi ve etiketinin kaldırılması, §7'nin "kim, neyi, ne zaman" listesine giren
-- bir değişiklik: bir işin "acil" olması ve sonra olmaması, o işi bekleyen herkes için bir bilgi.
ALTER TABLE public.task_activity DROP CONSTRAINT task_activity_field_known;
ALTER TABLE public.task_activity ADD CONSTRAINT task_activity_field_known
  CHECK (field IN ('status', 'priority', 'due_at', 'assignee_id', 'body', 'file_link', 'comment',
                   'parent_id', 'checklist', 'tag'));

-- Down Migration

DELETE FROM public.task_activity WHERE field = 'tag';
ALTER TABLE public.task_activity DROP CONSTRAINT task_activity_field_known;
ALTER TABLE public.task_activity ADD CONSTRAINT task_activity_field_known
  CHECK (field IN ('status', 'priority', 'due_at', 'assignee_id', 'body', 'file_link', 'comment',
                   'parent_id', 'checklist'));

DROP TABLE IF EXISTS public.task_tag_links;
DROP TABLE IF EXISTS public.task_tags;
