-- İki şey, tek sürümün parçası olarak: katalogda bir tarayıcı, ve kataloğun yanında sahibin
-- kendi ekleyebildiği uygulamalar.
--
-- ── Chromium ─────────────────────────────────────────────────────────────────
--
-- Sahibin isteği bire bir: "chromium ekle, ana bilgisayardan ekranı kontrol edelim, internete
-- çıkabilelim." linuxserver.io'nun chromium imajı tarayıcıyı KasmVNC ile bir web sayfası olarak
-- sunuyor — kutuda koşan Chromium, herhangi bir cihazın tarayıcısından kullanılır. `shm_bytes`
-- kolonu da bunun için geliyor: tarayıcılar /dev/shm'de yaşar ve podman'ın 64 MB varsayılanıyla
-- sekmeler oturur oturmaz çöker; 1 GiB, tek kullanıcılık gezinme için ölçülü bir taban.
--
-- ── Özel uygulamalar ─────────────────────────────────────────────────────────
--
-- ADR-0019 kataloğu migration'a kilitlemişti: kullanıcı imaj adı YAZAMAZ. Sahibi tam tersini
-- istedi ("mağaza devasa olsun") ve karar, kapılı genişletme: yalnız yönetici, yalnız bilinen
-- kayıt defterlerinden (docker.io, ghcr.io, lscr.io, quay.io), köksüz motorda. Eklenen imajın
-- İÇERİĞİNE kefalet yok ve arayüz bunu açıkça söylüyor; kefalet olmayan yerde en azından yazım
-- hatası taklidi (typosquat) yüzeyini kayıt defteri allowlist'i daraltıyor.

-- Up Migration

SELECT public.assert_rls_roles_sane();

ALTER TABLE public.app_catalogue_containers ADD COLUMN shm_bytes bigint;
ALTER TABLE public.app_catalogue_containers
  ADD CONSTRAINT app_catalogue_containers_shm_sane
  CHECK (shm_bytes IS NULL OR (shm_bytes >= 67108864 AND shm_bytes <= 4294967296));


CREATE TABLE public.app_custom (
  id              uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,

  slug            text        NOT NULL,
  name            text        NOT NULL,
  -- Bir iki karakterlik simge — harf ya da emoji. Uzak sayfalardan ikon KAZINMIYOR: cihaz,
  -- sahibi bir form doldurdu diye internetten sayfa çekip ayrıştırmaz.
  icon            text        NOT NULL DEFAULT '📦',

  image           text        NOT NULL,
  tag             text        NOT NULL,
  container_port  integer     NOT NULL,
  env             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Kalıcı dizinler: konteynerin içinde adlandırılmış birim bağlanacak yollar.
  volumes         jsonb       NOT NULL DEFAULT '["/config"]'::jsonb,

  created_by      uuid        REFERENCES public.users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT app_custom_slug_format  CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  CONSTRAINT app_custom_name_sane    CHECK (btrim(name) <> '' AND length(name) <= 80),
  CONSTRAINT app_custom_icon_sane    CHECK (btrim(icon) <> '' AND length(icon) <= 8),
  CONSTRAINT app_custom_port_sane    CHECK (container_port BETWEEN 1 AND 65535),
  CONSTRAINT app_custom_image_sane   CHECK (length(image) <= 255 AND length(tag) <= 128),
  CONSTRAINT app_custom_slug_unique  UNIQUE (organization_id, slug)
);

ALTER TABLE public.app_custom ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_custom FORCE  ROW LEVEL SECURITY;

CREATE POLICY app_custom_owner_full ON public.app_custom
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY app_custom_tenant_isolation ON public.app_custom
  FOR ALL
  TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_custom TO depsis_app;

-- Kurulum kayıtları artık iki kaynaktan birine işaret edebilir: katalog satırı ya da özel
-- uygulama. Tek kolon, iki hedef — FK bu yüzden kalkıyor. Bedeli biliniyor ve kabul: silinen bir
-- özel uygulamanın kurulumunu artık veritabanı değil servis koruyor (`removeCustom`, kurulum
-- varken reddediyor), ve zaten "stale install" durumu ürünün bildiği bir durum.
ALTER TABLE public.app_instances DROP CONSTRAINT app_instances_catalogue_id_fkey;

-- Katalog eklemeleri EN SONDA — bilerek: `app_catalogue` üstündeki ertelenmiş tetikleyici
-- (her girdinin birincil konteyneri olsun) commit'e kadar beklerken aynı işlemde `app_instances`
-- FK'sını düşürmek "pending trigger events" ile ölüyor. Önce bütün ALTER'lar, sonra satırlar.
INSERT INTO public.app_catalogue (slug, name, summary, icon, container_port)
VALUES ('chromium', 'Chrome (Chromium)',
        'Kutunun üstünde koşan, her cihazın tarayıcısından kullanılan bir Chromium. ' ||
        'İnternete kutu üzerinden çıkılır; profil kutuda kalır.',
        '🌐', 3000);

INSERT INTO public.app_catalogue_containers
       (catalogue_id, role, ordinal, is_primary, image, tag, env, mounts, volumes, shm_bytes)
SELECT id, 'app', 0, true,
       -- Katalog 'latest' yasağına tabi (sabitlenmiş sürüm); bu, yazım anında lscr'nin en yeni
       -- yayın damgasıydı. Yükseltme, katalog satırını güncelleyen bir migration'la yapılır.
       'lscr.io/linuxserver/chromium', '6edd71b2-ls16',
       '{"TZ":"Europe/Istanbul"}'::jsonb,
       '[]'::jsonb,
       '[{"target":"/config","purpose":"Tarayıcı profili ve ayarları"}]'::jsonb,
       1073741824
  FROM public.app_catalogue
 WHERE slug = 'chromium';

-- Down Migration

ALTER TABLE public.app_instances
  ADD CONSTRAINT app_instances_catalogue_id_fkey
  FOREIGN KEY (catalogue_id) REFERENCES public.app_catalogue (id) ON DELETE RESTRICT;

DROP TABLE public.app_custom;

DELETE FROM public.app_catalogue_containers
 WHERE catalogue_id IN (SELECT id FROM public.app_catalogue WHERE slug = 'chromium');
DELETE FROM public.app_catalogue WHERE slug = 'chromium';

ALTER TABLE public.app_catalogue_containers DROP CONSTRAINT app_catalogue_containers_shm_sane;
ALTER TABLE public.app_catalogue_containers DROP COLUMN shm_bytes;
