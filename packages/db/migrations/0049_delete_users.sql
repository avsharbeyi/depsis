-- Bir hesabın SİLİNEBİLMESİ.
--
-- ── NE İSTENDİ ───────────────────────────────────────────────────────────────────────────────
--
-- Cihazın sahibinin cümlesi: *"kullanıcılar kısmında kullanıcı sadece devredışı bırakılabiliniyor
-- silinebilmeli."* Ekranda gerçekten yalnız "devre dışı bırak" vardı, ve bunun sebebi arayüz
-- değil şemaydı: `users` satırına RESTRICT ile bağlı üç yabancı anahtar hesabı rehin tutuyordu.
--
-- 0009 numaralı göç bunu açıkça yazmıştı: *"nothing deletes a user: accounts are disabled, never
-- removed, so their audit entries and their files keep an owner."* O karar bir gerekçeye
-- dayanıyordu ve gerekçe hâlâ doğru — bir denetim kaydı sahibini kaybetmemeli. Yanlış olan,
-- gerekçeden çıkarılan sonuç: kaydın sahibini korumanın yolu HESABI ÖLÜMSÜZ KILMAK değil, kaydın
-- kendi içine kimin olduğunu YAZMAK. Bu göç üç bağın her birini o şekilde çözüyor.
--
-- ── 1. SİLİNMİŞ HESABIN uid'i BİR DAHA DAĞITILMAMALI ─────────────────────────────────────────
--
-- En tehlikeli kısım burası ve tek başına bu göçün var olma sebebi olabilirdi. `allocate_posix_id`
-- bir sonraki numarayı `MAX(posix_uid) + 1` ile buluyor, yani bir hesabı silmek onun numarasını
-- SERBEST BIRAKIYOR. Silinen kullanıcının dosyaları diskte hâlâ o numarayla damgalı: numara bir
-- sonraki kullanıcıya verilseydi, o kullanıcı hiç görmediği dosyaların SAHİBİ olarak açılırdı —
-- ne bir izin hatası, ne bir uyarı; dosya sistemi düzeyinde gerçekten onun.
--
-- `retired_posix_ids` bu yüzden bir mezar taşı tablosu: numarayı tutuyor, sahibini değil. Dağıtıcı
-- artık onu da "dolu" sayıyor. Tablo kiracı kapsamlı DEĞİL ve olamaz — POSIX numara uzayı cihaz
-- geneli (ADR-0004), tıpkı `users_posix_uid_unique`in kiracı taşımaması gibi.
--
-- ── 2. KONSOL KAYDI KİMİN OLDUĞUNU KENDİ İÇİNDE TAŞISIN ──────────────────────────────────────
--
-- 0013 numaralı göçün kendi yorumu: *"SET NULL değil RESTRICT: bir denetim kaydının kime ait
-- olduğu, hesap silindi diye kaybolmamalı. Hesabı silmek isteyen önce kaydı arşivlemek zorunda
-- kalır, ki doğru sıra bu."* — Bu cihazda o sıra yürümüyor. "Önce kaydı arşivle" diye bir düğme
-- yok, ve olsaydı bile sahibinin bir hesabı silmek için önce bir denetim tablosunu boşaltması
-- gereken bir ürün, terminalsiz kullanılabilir bir ürün değil.
--
-- Kaydın kaybetmemesi gereken şey kullanıcı SATIRI değil, kullanıcı ADI. Ad artık satırın kendi
-- içinde: `user_id` NULL olabiliyor, `username` her zaman dolu. Denetim "bu komutu kim koştu"
-- sorusunu hesap gittikten sonra da cevaplıyor — üstelik daha iyi cevaplıyor, çünkü kullanıcı adı
-- değişse bile kayıt O ANKİ adı taşıyor.
--
-- ── 3. KURULUMU YAPAN HESAP DA SİLİNEBİLİR ───────────────────────────────────────────────────
--
-- `system_setup.admin_user_id` aynı hatanın daha keskin hâliydi: "kutuyu kim kurdu" diye tarihsel
-- bir not, bir hesabı sonsuza kadar rehin tutuyordu. Aynı çözüm — adın kopyası satırın içine,
-- yabancı anahtar SET NULL.
--
-- Bu, son yöneticinin silinebileceği anlamına GELMİYOR: onu 0009'un tetikleyicisi engelliyor, ve
-- bu göç tetikleyiciyi DELETE'i de görecek şekilde genişletiyor. 0009 silmeyi kapsamamıştı çünkü o
-- gün silme diye bir şey yoktu.
--
-- ── 4. YARIM YÜKLEMELER ──────────────────────────────────────────────────────────────────────
--
-- `upload_sessions.created_by` CASCADE oluyor. Sahibi olmayan bir yükleme oturumu çöp: ne
-- tamamlanabilir (tus oturumu sahibinin kimliğiyle yayımlanıyor) ne de bir başkasına devredilebilir.
-- Ara alandaki `.part` dosyasını uygulama katmanı satırlar gitmeden ÖNCE ajana attırıyor;
-- CASCADE'in temizlediği şey yalnızca kayıt.

-- Up Migration

SELECT public.assert_rls_roles_sane();

-- ─── 1. emekli POSIX numaraları ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.retired_posix_ids (
  -- Numaranın kendisi birincil anahtar: aynı numara iki kez emekli olamaz, ve tabloda numaradan
  -- başka aranacak bir şey yok.
  id_value    integer     PRIMARY KEY CHECK (id_value BETWEEN 300000 AND 399999),
  retired_at  timestamptz NOT NULL DEFAULT now(),
  -- Neden emekli olduğu, bir insan için. Kimlik DEĞİL: silinen hesabın adını buraya yazmak, silme
  -- isteğinin geriye ad bırakmadan tamamlanmasını engellerdi.
  note        text        CHECK (note IS NULL OR length(note) <= 200)
);

COMMENT ON TABLE public.retired_posix_ids IS
  'Bir daha dağıtılmayacak POSIX numaraları. Kiracı kapsamlı DEĞİL: numara uzayı cihaz geneli '
  '(ADR-0004). Silinen bir hesabın dosyaları diskte hâlâ onun numarasıyla damgalı, ve numaranın '
  'yeniden dağıtılması yeni kullanıcıyı o dosyaların sahibi yapardı.';

-- RLS YOK, ve `login_attempts` ile aynı gerekçeyle: filtrelenecek bir kiracı anahtarı yok, çünkü
-- satırın kendisi bir kiracıya ait değil. Koruyan şey ayrıcalık — `depsis_app` okuyup ekleyebiliyor,
-- silemiyor: bir numarayı emeklilikten çıkarmak, onu yeniden dağıtılabilir yapmak olurdu.
GRANT SELECT, INSERT ON public.retired_posix_ids TO depsis_app;
GRANT SELECT ON public.retired_posix_ids TO depsis_backup;

CREATE OR REPLACE FUNCTION public.allocate_posix_id(kind text)
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

  -- Tek bir sayaç, üç kaynak. Üçüncüsü yeni: EMEKLİ numaralar. Onlar olmadan bir hesabı silmek
  -- numarasını serbest bırakır, ve diskte o numarayla damgalı dosyalar bir sonraki kullanıcıya
  -- geçer.
  SELECT COALESCE(MAX(id_value), 299999) + 1 INTO next_id
    FROM (
      SELECT posix_uid AS id_value FROM public.users WHERE posix_uid IS NOT NULL
      UNION ALL
      SELECT posix_gid FROM public.teams WHERE posix_gid IS NOT NULL
      UNION ALL
      SELECT id_value FROM public.retired_posix_ids
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

-- ─── 2. konsol kaydı kendi adını taşısın ─────────────────────────────────────────────────────

ALTER TABLE public.console_sessions
  ADD COLUMN IF NOT EXISTS username text;

UPDATE public.console_sessions s
   SET username = u.username
  FROM public.users u
 WHERE u.id = s.user_id AND s.username IS NULL;

-- Geri doldurmadan SONRA zorunlu: sırası tersse var olan her satır kısıtı çiğner.
ALTER TABLE public.console_sessions
  ALTER COLUMN username SET NOT NULL;

ALTER TABLE public.console_sessions
  DROP CONSTRAINT IF EXISTS console_sessions_user_id_fkey;

ALTER TABLE public.console_sessions
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.console_sessions
  ADD CONSTRAINT console_sessions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.console_sessions.username IS
  'Oturumu açan hesabın O ANKİ adı. Yabancı anahtar SET NULL olduğu için kaydın kime ait olduğunu '
  'taşıyan şey bu sütun; hesap silinse de, adı değişse de kayıt doğru adı gösteriyor.';

-- ─── 3. kurulumu yapan hesap ─────────────────────────────────────────────────────────────────

ALTER TABLE public.system_setup
  ADD COLUMN IF NOT EXISTS admin_username text;

UPDATE public.system_setup s
   SET admin_username = u.username
  FROM public.users u
 WHERE u.id = s.admin_user_id AND s.admin_username IS NULL;

ALTER TABLE public.system_setup
  DROP CONSTRAINT IF EXISTS system_setup_admin_user_id_fkey;

ALTER TABLE public.system_setup
  ALTER COLUMN admin_user_id DROP NOT NULL;

ALTER TABLE public.system_setup
  ADD CONSTRAINT system_setup_admin_user_id_fkey
  FOREIGN KEY (admin_user_id) REFERENCES public.users (id) ON DELETE SET NULL;

-- SET NULL bir EMNİYET AĞI, olağan yol değil. Olağan yolda uygulama, kurucunun hesabı silinirken
-- kaydı kalan bir başka yöneticiye DEVREDİYOR — çünkü `admin_user_id` yalnızca tarihsel bir not
-- değil, `isSystemAdministrator` ile konsolun kapısı: NULL kalsaydı terminale kimse giremezdi.
-- Devir için UPDATE yetkisi gerekiyor; tabloda RLS yok, koruyan şey ayrıcalık.
GRANT UPDATE (admin_user_id) ON public.system_setup TO depsis_app;

-- ─── 4. yarım yüklemeler ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.upload_sessions
  DROP CONSTRAINT IF EXISTS upload_sessions_created_by_fkey;

ALTER TABLE public.upload_sessions
  ADD CONSTRAINT upload_sessions_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES public.users (id) ON DELETE CASCADE;

-- ─── 5. son yönetici SİLİNEREK de gitmesin ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.refuse_last_admin_removal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  remaining integer;
  losing    boolean;
  gone_org  uuid;
  gone_id   uuid;
BEGIN
  -- Yönetici KAYBETTİREN geçişler. Artık iki tane: rolü düşüren ya da hesabı kapatan bir UPDATE,
  -- ve yöneticinin kendisini götüren bir DELETE. İkincisi 0009'da yoktu çünkü o gün hiçbir şey bir
  -- kullanıcıyı silmiyordu; 0049 sildiği için tetikleyicinin de görmesi gerekiyor.
  --
  -- SİLMEDE `depsis_owner` MUAF, ve bu bir gedik değil bir kapsam: kural UYGULAMANIN bir kuruluşu
  -- kilitlemesini engelliyor, ve uygulama `depsis_app` olarak bağlanıyor. `depsis_owner` göç,
  -- yedekleme ve operatör cerrahisi; oradaki tek meşru toplu silme bir kuruluşun TAMAMINI
  -- kaldırmak, ve "en az bir yönetici kalsın" o işlemde anlamsız — son kullanıcıyı silmeyi
  -- reddeden bir tetikleyici, kuruluşu silinemez yapardı. UPDATE dalı herkes için geçerli
  -- kalıyor: orada böyle bir toplu durum yok.
  IF TG_OP = 'DELETE' AND pg_has_role(current_user, 'depsis_owner', 'MEMBER') THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'DELETE' THEN
    losing   := OLD.role = 'admin' AND OLD.disabled_at IS NULL;
    gone_org := OLD.organization_id;
    gone_id  := OLD.id;
  ELSE
    losing := OLD.role = 'admin'
          AND OLD.disabled_at IS NULL
          AND (NEW.role <> 'admin' OR NEW.disabled_at IS NOT NULL);
    gone_org := OLD.organization_id;
    gone_id  := OLD.id;
  END IF;

  IF losing THEN
    SELECT count(*) INTO remaining
      FROM public.users
     WHERE organization_id = gone_org
       AND role = 'admin'
       AND disabled_at IS NULL
       AND id <> gone_id;

    IF remaining = 0 THEN
      RAISE EXCEPTION 'an organization must keep at least one enabled administrator'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- BEFORE DELETE tetikleyicisinde NEW yok: NULL döndürmek silmeyi İPTAL ederdi, o yüzden OLD.
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS users_keep_one_admin ON public.users;

CREATE TRIGGER users_keep_one_admin
  BEFORE UPDATE OR DELETE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.refuse_last_admin_removal();

GRANT DELETE ON public.users TO depsis_app;

-- Down Migration

DROP TRIGGER IF EXISTS users_keep_one_admin ON public.users;

CREATE OR REPLACE FUNCTION public.refuse_last_admin_removal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  remaining integer;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.role = 'admin'
     AND OLD.disabled_at IS NULL
     AND (NEW.role <> 'admin' OR NEW.disabled_at IS NOT NULL)
  THEN
    SELECT count(*) INTO remaining
      FROM public.users
     WHERE organization_id = OLD.organization_id
       AND role = 'admin'
       AND disabled_at IS NULL
       AND id <> OLD.id;

    IF remaining = 0 THEN
      RAISE EXCEPTION 'an organization must keep at least one enabled administrator'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER users_keep_one_admin
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.refuse_last_admin_removal();

REVOKE DELETE ON public.users FROM depsis_app;

ALTER TABLE public.upload_sessions
  DROP CONSTRAINT IF EXISTS upload_sessions_created_by_fkey;
ALTER TABLE public.upload_sessions
  ADD CONSTRAINT upload_sessions_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES public.users (id) ON DELETE RESTRICT;

ALTER TABLE public.system_setup
  DROP CONSTRAINT IF EXISTS system_setup_admin_user_id_fkey;
DELETE FROM public.system_setup WHERE admin_user_id IS NULL;
ALTER TABLE public.system_setup ALTER COLUMN admin_user_id SET NOT NULL;
ALTER TABLE public.system_setup
  ADD CONSTRAINT system_setup_admin_user_id_fkey
  FOREIGN KEY (admin_user_id) REFERENCES public.users (id) ON DELETE RESTRICT;
ALTER TABLE public.system_setup DROP COLUMN IF EXISTS admin_username;

ALTER TABLE public.console_sessions
  DROP CONSTRAINT IF EXISTS console_sessions_user_id_fkey;
DELETE FROM public.console_sessions WHERE user_id IS NULL;
ALTER TABLE public.console_sessions ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE public.console_sessions
  ADD CONSTRAINT console_sessions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE RESTRICT;
ALTER TABLE public.console_sessions DROP COLUMN IF EXISTS username;

CREATE OR REPLACE FUNCTION public.allocate_posix_id(kind text)
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

REVOKE UPDATE ON public.system_setup FROM depsis_app;

DROP TABLE IF EXISTS public.retired_posix_ids;
