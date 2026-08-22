-- 0015 — ekipler, klasör izinleri, ve POSIX kimliği.
--
-- §6.2'nin istediği şey: "İzinler kullanıcı veya gruba atanır; klasör ağacında miras alır."
-- Bugüne kadar bu şemada organizasyon düzeyinde iki rol vardı (admin, member) ve bir klasörü
-- yalnızca birine açmanın hiçbir yolu yoktu — yani çok kullanıcılı bir NAS'ın en temel işi.
--
-- ADR-0004 modeli zaten seçmişti ve bu migration onun veritabanı yarısı:
--
--   * Uygulanan substrat POSIX ACL'dir. Çekirdeğin ZFS üzerinde gerçekten uyguladığı tek şey o.
--   * ACL girdileri KULLANICIYA DEĞİL GRUBA verilir; POSIX ACL ~30 girdiden sonra hantallaşıyor
--     ve mask semantiği ısırıyor.
--   * Uygulama yetkisi, dosya sistemi yetkisinin her zaman bir ALT KÜMESİDİR. Web katmanındaki
--     bir hata, çekirdeğin uyguladığı izinleri aşamaz.
--
-- Bu tablolar o modelin "DEPSIS otoritedir" yarısını tutuyor. Diğer yarısı — POSIX ACL'lerin
-- gerçekten yazılması — ayrıcalıklı ajanın işi ve ayrı bir turda.

-- Up Migration

SELECT public.assert_rls_roles_sane();

-- ─── izin kümesi ──────────────────────────────────────────────────────────────
--
-- §6.2'nin saydığı on bir izin, birebir. Ayrı bir tip olarak, bir dizi metin olarak değil:
-- yazım hatası olan bir izin adı, sessizce hiçbir şeye izin vermeyen bir satırdır.
--
-- `manage` (izin yönet) ayrı bir izin ve bu önemli: bir klasöre yazabilen herkesin o klasörün
-- iznini de değiştirebilmesi, yetki modelinin kendi kendini geçersiz kılmasıdır.
CREATE TYPE public.folder_permission AS ENUM (
  'list',      -- listele
  'read',      -- oku
  'download',  -- indir
  'create',    -- yükle/oluştur
  'modify',    -- değiştir
  'move',      -- taşı
  'delete',    -- sil
  'share',     -- paylaş
  'manage',    -- izin yönet
  'versions',  -- sürüm gör
  'audit'      -- audit gör
);

-- ─── ekipler ──────────────────────────────────────────────────────────────────
--
-- §6.1'in hiyerarşisinde ekip, organizasyon ile kullanıcı arasındaki katman. İzinler ekibe
-- verilir ve kullanıcı ekibe girer; ADR-0004'ün "girdiler gruba verilir" kuralı bu.
--
-- `posix_gid` boş bırakılamaz olmalıydı ama olamıyor: grubu ayrıcalıklı ajan yaratıyor ve satır
-- ondan önce var oluyor. NULL, "henüz dosya sistemine yansıtılmadı" demek — ve bu durumdaki bir
-- ekibe verilen izin, uygulama katmanında görünür ama SMB'de görünmez. API bunu bilmek ve
-- söylemek zorunda; iki gerçeklik üretmemenin bedeli bu alanı okumak.
CREATE TABLE public.teams (
  id              uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,

  name            text        NOT NULL,
  name_fold       text        GENERATED ALWAYS AS (public.fold_identity(name)) STORED,

  posix_gid       integer,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT teams_name_present CHECK (btrim(name) <> '' AND length(name) <= 64),
  -- Ayrılmış aralık. Sistem gruplarıyla çakışan bir gid, cihazdaki bir servis hesabına
  -- kullanıcının dosyalarını açmaktır.
  CONSTRAINT teams_posix_gid_range CHECK (posix_gid IS NULL OR posix_gid BETWEEN 300000 AND 399999)
);

CREATE UNIQUE INDEX teams_name_unique ON public.teams (organization_id, name_fold);

-- gid CİHAZ GENELİNDE tek. Kiracı kapsamlı olsaydı iki kiracının ekibi aynı gid'i alır ve
-- dosya sisteminde birbirinin dosyalarını görürdü — uygulama katmanı ne derse desin.
-- `tools/ci/migration-check.sh` izin listesinde, gerekçesiyle.
CREATE UNIQUE INDEX teams_posix_gid_unique ON public.teams (posix_gid) WHERE posix_gid IS NOT NULL;

CREATE TRIGGER teams_set_updated_at
  BEFORE UPDATE ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams FORCE  ROW LEVEL SECURITY;

CREATE POLICY teams_owner_full ON public.teams
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY teams_tenant_isolation ON public.teams
  FOR ALL TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

-- ─── ekip üyeliği ─────────────────────────────────────────────────────────────
--
-- `team_admin` §6.1'in "Ekip yöneticisi" satırı: kendi ekibi içindeki kullanıcı ve klasörler.
-- Organizasyon yöneticisinden farkı kapsamı; ayrı bir rol sütunu yerine üyelik satırında bir
-- bayrak olması, "hangi ekipte yönetici" sorusunun tek cevabı olmasını sağlıyor.
CREATE TABLE public.team_members (
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  team_id         uuid        NOT NULL REFERENCES public.teams (id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,

  team_admin      boolean     NOT NULL DEFAULT false,
  added_at        timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (organization_id, team_id, user_id)
);

-- "Bu kullanıcı hangi ekiplerde" — yetki hesabının her adımda sorduğu soru.
CREATE INDEX team_members_by_user ON public.team_members (organization_id, user_id);

ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members FORCE  ROW LEVEL SECURITY;

CREATE POLICY team_members_owner_full ON public.team_members
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY team_members_tenant_isolation ON public.team_members
  FOR ALL TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

-- ─── klasör izinleri ──────────────────────────────────────────────────────────
--
-- Bir izin satırı: şu klasörde, şu kişiye ya da şu ekibe, şu izinler.
--
-- **AÇIK DENY YOK, ve bu bilinçli bir karar.** §6.2 "açık deny desteği VARSA öncelik kuralları
-- tek ve belgelenmiş olmalı" diyor; biz desteklemiyoruz, üç gerekçeyle:
--
--   1. Deny + miras, kimsenin baştan tahmin edemediği öncelik kuralları üretir. "Neden bu
--      klasörü göremiyorum" sorusunun cevabı bir algoritma olur.
--   2. Uygulanan substrat POSIX ACL ve onun deny'ı YOK. Uygulama katmanındaki bir deny dosya
--      sistemine yansıtılamaz, yani SMB'den erişilebilen bir klasör web'de kapalı görünür —
--      ADR-0004'ün yasakladığı iki gerçeklik tam olarak bu.
--   3. Deny'sız model, "uygulama yetkisi dosya sistemi yetkisinin alt kümesidir" değişmezini
--      korumayı kolaylaştırır: eksiltmek her zaman güvenli yön.
--
-- Daraltma yine mümkün: alt klasöre daha DAR bir grant koymak §6.2'nin diyagramındaki
-- "İstisna: daha dar izin" durumu. Miras kuralı aşağıda.
CREATE TABLE public.folder_grants (
  id              uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,

  -- Klasör. NULL, PAYLAŞIMIN KÖKÜ demek — bir paylaşımın tamamına izin vermenin yolu.
  entry_id        uuid        REFERENCES public.file_entries (id) ON DELETE CASCADE,
  share_id        uuid        NOT NULL REFERENCES public.shares (id) ON DELETE RESTRICT,

  -- Tam olarak biri dolu. İki ayrı kolon yerine bir "principal_type + principal_id" çifti de
  -- olabilirdi; yabancı anahtar veremeyeceği için olmadı — silinen bir ekibe verilmiş izin,
  -- kimseye ait olmayan bir izindir.
  user_id         uuid        REFERENCES public.users (id) ON DELETE CASCADE,
  team_id         uuid        REFERENCES public.teams (id) ON DELETE CASCADE,

  permissions     public.folder_permission[] NOT NULL,

  granted_by      uuid        REFERENCES public.users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT folder_grants_one_principal
    CHECK ((user_id IS NULL) <> (team_id IS NULL)),
  -- Boş bir izin kümesi, "hiçbir şey yapamaz" ile "burada bir kural yok" arasındaki farkı
  -- silerdi. Kaldırmak istiyorsan satırı sil.
  --
  -- `cardinality`, `array_length(permissions, 1)` DEĞİL: ikincisi boş dizide 0 değil NULL döner,
  -- NULL >= 1 de NULL'dur, ve bir CHECK kısıtı NULL sonucu GEÇİRİR. İlk hâli tam olarak bu
  -- yüzden hiçbir şeyi engellemiyordu ve boş bir grant kabul ediliyordu; kısıtın kendisi
  -- yazılmış ama çalışmıyordu. Şemaya karşı koşulan bir test bunu yakaladı.
  CONSTRAINT folder_grants_not_empty
    CHECK (cardinality(permissions) >= 1),
  -- Dizinin İÇİNDE NULL da olamaz. `ARRAY[NULL]::folder_permission[]` bir elemanlıdır, yani
  -- yukarıdaki kısıttan geçer, ve "izni NULL olan bir izin satırı" hiçbir kodun beklemediği bir
  -- şeydir — yetki hesabında sessizce hiçbir şeyle eşleşir.
  CONSTRAINT folder_grants_no_null_permission
    CHECK (array_position(permissions, NULL) IS NULL)
);

-- Bir kişi/ekip için bir klasörde en fazla bir satır. İki satır olsaydı hangisinin geçerli
-- olduğu bir birleştirme kuralı gerektirirdi ve o kural yine tahmin edilemez olurdu.
CREATE UNIQUE INDEX folder_grants_user_unique
  ON public.folder_grants (organization_id, share_id, COALESCE(entry_id, share_id), user_id)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX folder_grants_team_unique
  ON public.folder_grants (organization_id, share_id, COALESCE(entry_id, share_id), team_id)
  WHERE team_id IS NOT NULL;

-- Yetki hesabı: "şu klasörün ata zincirinde bu kişi ya da ekipleri için grant var mı".
CREATE INDEX folder_grants_by_entry ON public.folder_grants (organization_id, entry_id);

CREATE TRIGGER folder_grants_set_updated_at
  BEFORE UPDATE ON public.folder_grants
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.folder_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.folder_grants FORCE  ROW LEVEL SECURITY;

CREATE POLICY folder_grants_owner_full ON public.folder_grants
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY folder_grants_tenant_isolation ON public.folder_grants
  FOR ALL TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

-- ─── POSIX kimliği ────────────────────────────────────────────────────────────
--
-- ADR-0004'ün ve ajanın istediği şey. `PublishTransfer` işlemi `owner_uid` ve `owner_gid`
-- alıyor ve ajan SIFIRI REDDEDİYOR — yorumu şunu söylüyor: "eşlemeyi atlayan bir API sessizce
-- hatayı üretmek yerine gürültülü biçimde başarısız olmalı". Bugüne kadar API o eşlemeye sahip
-- değildi ve yayımlanan dosyalar servis hesabına ait kalıyordu.
--
-- uid de gid gibi CİHAZ GENELİNDE tek. Kiracı kapsamlı bir uid, iki kiracının aynı dosya
-- sahibi olması demek.
ALTER TABLE public.users ADD COLUMN posix_uid integer;

ALTER TABLE public.users
  ADD CONSTRAINT users_posix_uid_range
  CHECK (posix_uid IS NULL OR posix_uid BETWEEN 300000 AND 399999);

CREATE UNIQUE INDEX users_posix_uid_unique ON public.users (posix_uid) WHERE posix_uid IS NOT NULL;

COMMENT ON COLUMN public.users.posix_uid IS
  'Dosya sistemindeki sahibi. NULL, hesabın henüz dosya sistemine yansıtılmadığı anlamına '
  'gelir ve bu hesap adına yayımlanan bir dosya olamaz — ajan uid 0''ı reddediyor ve API '
  'boş bir eşlemeyle çağrı yapmamalı (ADR-0004, migration 0015).';

-- Sıradaki uid/gid'i vermenin tek yeri. Uygulama katmanında "en büyüğü bul, bir ekle" yapmak,
-- iki eşzamanlı hesap oluşturmanın aynı uid'i alması demektir — ve bunun sonucu, iki kişinin
-- birbirinin dosyalarına sahip olması.
--
-- SECURITY DEFINER, çünkü aralık cihaz genelinde ve sorgunun kiracı yalıtımını AŞMASI gerekiyor:
-- bir sonraki boş uid'i bulmak için başka kiracıların aldıklarını da görmek şart. Döndürdüğü tek
-- şey bir tam sayı; hiçbir satır okunabilir hâle gelmiyor.
CREATE FUNCTION public.allocate_posix_id(kind text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  next_id integer;
BEGIN
  IF kind NOT IN ('user', 'team') THEN
    RAISE EXCEPTION 'kind must be user or team' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Tek bir sayaç, iki tablo için. uid ve gid uzaylarının ayrı olması gerekmiyor ve ortak
  -- olması, bir kullanıcının uid'i ile bir ekibin gid'inin asla karışmamasını sağlıyor —
  -- `ls -l` çıktısında ikisi yan yana duruyor.
  SELECT COALESCE(MAX(id_value), 299999) + 1 INTO next_id
    FROM (
      SELECT posix_uid AS id_value FROM public.users WHERE posix_uid IS NOT NULL
      UNION ALL
      SELECT posix_gid FROM public.teams WHERE posix_gid IS NOT NULL
    ) AS taken;

  IF next_id > 399999 THEN
    RAISE EXCEPTION 'the reserved POSIX id range is exhausted'
      USING ERRCODE = 'program_limit_exceeded';
  END IF;

  RETURN next_id;
END
$$;

REVOKE ALL ON FUNCTION public.allocate_posix_id(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.allocate_posix_id(text) TO depsis_app;

COMMENT ON FUNCTION public.allocate_posix_id(text) IS
  'Bir sonraki boş POSIX kimliği. Uygulama katmanında hesaplanamaz: iki eşzamanlı hesap '
  'oluşturma aynı değeri alır ve iki kişi birbirinin dosyalarına sahip olur. Çağıran, dönen '
  'değeri AYNI işlem içinde yazmalı.';

-- ─── grants ───────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.teams, public.team_members, public.folder_grants
  TO depsis_app;

GRANT SELECT ON public.teams, public.team_members, public.folder_grants TO depsis_backup;

-- Down Migration

DROP FUNCTION IF EXISTS public.allocate_posix_id(text);

DROP INDEX IF EXISTS public.users_posix_uid_unique;
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_posix_uid_range;
ALTER TABLE public.users DROP COLUMN IF EXISTS posix_uid;

DROP TABLE IF EXISTS public.folder_grants;
DROP TABLE IF EXISTS public.team_members;
DROP TABLE IF EXISTS public.teams;

DROP TYPE IF EXISTS public.folder_permission;
