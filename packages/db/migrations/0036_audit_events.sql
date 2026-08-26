-- Cihazın denetim kaydı: kim, neyi, ne zaman.
--
-- Master prompt üç yerde istiyor ve üçü üç ayrı gereksinim: §13 tablo listesinde "audit_events
-- (append-only)", §16 "Audit'te parola, token, secret, dosya içeriği ve gereksiz kişisel veri
-- yok", §9 "gerekli dosya olaylarını correlation ID ile tutar". Bugüne kadar bunun yalnız
-- parçaları vardı: iş panosunun kendi `task_activity`'si, ZeroTier üyeliklerinin
-- `remote_members`'ı, ajanın işlem-adı-düzeyinde kendi günlüğü, ve oturumların `sessions`
-- satırları. "Bu kutuda dün ne oldu" sorusunun TEK cevabı yoktu — bir hesap kapatıldığında,
-- bir izin değiştiğinde, bir havuz kurulduğunda bakılacak yer burasıdır.
--
-- ── append-only'nin gerçek mekanizması GRANT ────────────────────────────────
--
-- `depsis_app` yalnız SELECT ve INSERT alıyor. UPDATE ve DELETE yok, ve RLS politikası da yalnız
-- bu ikisini kapsıyor: API'nin bağlandığı rol bir denetim satırını NE değiştirebilir NE silebilir,
-- kendi kiracısında bile. Bu, uygulama katmanında "silme kodu yazmadık" demekten güçlü — kod
-- yazılsa da çalışmaz, ve bunu ölçen test var.
--
-- `depsis_owner` teknik olarak her şeyi yapabilir; o rol migration'ların rolü ve API'nin
-- erişemediği bir bağlantı dizesinde duruyor (ADR-0014). Diski elinde tutan birine karşı
-- kurcalama kanıtı bu ürünün verebileceği bir söz değil.
--
-- ── hash zinciri: değerlendirildi, ŞİMDİLİK yok ─────────────────────────────
--
-- §13: "önceki hash zinciri veya imzalı periyodik checkpoint ile kurcalama tespiti DEĞERLENDİR".
-- Değerlendirme şu: bir zincir her eklemeyi son satıra bağlar, yani üründeki her denetimli
-- mutasyonu tek bir satırın kilidinden geçirir — ve doğrulayacak araç yazılmadıkça zincir yalnız
-- yavaşlatır, kanıtlamaz. Grant tabanlı append-only bugünkü tehdit modelini (kötü niyetli
-- standart kullanıcı, ele geçirilmiş API) karşılıyor; zincir, imzalı yedek doğrulaması gibi
-- dışarıya taşınan bir bütünlük hedefiyle birlikte anlamlı olur ve o gün bu tabloya checkpoint
-- tablosu eklemek geriye dönük mümkün.
--
-- ── satırın içinde ne VAR, ne YOK ───────────────────────────────────────────
--
--   VAR:  eylem adı, hedefin türü/kimliği/o anki adı, bir cümlelik özet, correlation id,
--         aktörün kimliği VE o anki kullanıcı adı (hesap silinse de satır okunur kalsın diye).
--   YOK:  parola, jeton, sır, dosya içeriği (§16). IP yalnız kimlik doğrulama olaylarında —
--         orada "nereden" sorusu güvenlik sorusudur; bir not düzenlemesinde kişisel veridir.

-- Up Migration

SELECT public.assert_rls_roles_sane();

CREATE TABLE public.audit_events (
  id              uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,

  /* KİM. `ON DELETE SET NULL` + yanında metin kopyası: §7'nin görev aktivitesi için söylediği
   * kural burada da geçerli — "kullanıcı silinse bile denetim kaydı korunmalı". Kimlik sütunu
   * anonimleşir, ad sütunu kalır; en çok bakılacağı an, birinin hesabının kapatıldığı andır.
   *
   * NULL aktör MEŞRU bir durum: kurulum talebi (henüz hesap yok) ve sistemin kendi işleri
   * (zamanlanmış yedek) bir kullanıcı adına değil. `actor_username` o durumda da doluyor —
   * 'sistem' gibi bir değerle — çünkü okunacak satırda boş bir "kim" sorunun kendisidir. */
  actor_id        uuid        REFERENCES public.users (id) ON DELETE SET NULL,
  actor_username  text        NOT NULL,

  /* NE. Noktalı ad: 'auth.login', 'user.role-changed', 'permissions.changed'. Serbest metin
   * DEĞİL — biçim kısıtı var, çünkü bu sütun filtrelenecek ve 'user.created' ile 'User Created'
   * aynı ekranda iki ayrı olay gibi görünürdü. */
  action          text        NOT NULL,

  /* NEYİN ÜZERİNDE. Tür + kimlik + O ANKİ ad. Ad bilerek denormalize: hedef (bir hesap, bir
   * paylaşım, bir dosya) silindikten sonra kimliği hiçbir yere çözülmez, ve denetim kaydının işi
   * tam da artık var olmayan şeyler hakkında konuşabilmektir. Kimlik metin, uuid değil: ZeroTier
   * üye adresi ve havuz adı gibi uuid olmayan hedefler var. */
  target_kind     text,
  target_id       text,
  target_label    text,

  /* Bir cümle, okunmak için. Makine `action`+`target_*` okur, insan bunu okur. §16'nın listesi
   * burada da geçerli: parola, jeton, sır, dosya içeriği asla. Bunu tutan şey test değil, her
   * çağrı yerinin gözden geçirilmesi — özetler sabit cümleler ve sınırlı ad listeleri taşır,
   * serbest kullanıcı girdisi taşımaz. (Testle ölçülen, append-only ve kiracı sınırı.) */
  summary         text        NOT NULL,

  /* §9: dosya olayları correlation ID ile. Ajanla konuşan her işlemde zaten üretiliyor; burada
   * durması, bir denetim satırından ajanın kendi günlüğündeki karşılığına atlamayı sağlar. */
  correlation_id  uuid,

  /* Yalnız kimlik doğrulama olayları için. Üstteki blok yorumda gerekçe. */
  ip              text,

  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT audit_events_action_shape
    CHECK (action ~ '^[a-z][a-z-]*(\.[a-z][a-z-]*)+$'),
  CONSTRAINT audit_events_actor_named    CHECK (char_length(actor_username) BETWEEN 1 AND 128),
  CONSTRAINT audit_events_summary_bounds CHECK (char_length(summary) BETWEEN 1 AND 500),
  CONSTRAINT audit_events_label_bounds
    CHECK (target_label IS NULL OR char_length(target_label) BETWEEN 1 AND 255),
  -- Tür ile kimlik birlikte: türsüz bir kimlik çözülemez, kimliksiz bir tür hiçbir şeyi
  -- adlandırmaz. İkisi de boş olabilir (auth.login'in hedefi yok).
  CONSTRAINT audit_events_target_pair CHECK ((target_kind IS NULL) = (target_id IS NULL))
);

-- Liste her zaman "en yeni önce, bu kiracıda" okunur ve sayfalama imleci son görülen satırın
-- `id`'sidir: uuidv7 zaman sıralı, yani `id` sırası zaman sırasıdır ve tek sütunlu bir imleç
-- aynı milisaniyedeki iki satırı sayfa sınırında yitirmez. İndeks bu yüzden `created_at` değil
-- `id` üzerinde.
CREATE INDEX audit_events_by_time
  ON public.audit_events (organization_id, id DESC);

ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events FORCE  ROW LEVEL SECURITY;

CREATE POLICY audit_events_owner_full ON public.audit_events
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

-- İki ayrı politika, FOR ALL değil: politika da yalnız var olan iki yetkiyi tarif etsin. FOR ALL
-- yazmak bugün zararsız olurdu (grant yok), ama yarın birinin verdiği bir UPDATE grant'ı o gün
-- kimse politikaya bakmadan çalışırdı.
CREATE POLICY audit_events_tenant_read ON public.audit_events
  FOR SELECT TO depsis_app
  USING (organization_id = public.current_organization_id());

CREATE POLICY audit_events_tenant_append ON public.audit_events
  FOR INSERT TO depsis_app
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT ON public.audit_events TO depsis_app;
GRANT SELECT ON public.audit_events TO depsis_backup;

-- Down Migration

DROP TABLE IF EXISTS public.audit_events;
