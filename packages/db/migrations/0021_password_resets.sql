-- 0021 — Parola sıfırlama: yöneticinin ÖĞRENEMEDİĞİ bir kurtarma yolu.
--
-- Parolasını unutan bir kullanıcı üründen kurtarılamıyordu. Tek çare, veritabanına elle girip
-- `password_hash` yazmaktı — yani ürünün dışında, denetim izi olmadan.
--
-- ── Neden `PATCH /users/{id}` ile parola belirlenmiyor ────────────────────────
--
-- Sözleşme bunu açıkça reddediyor ve gerekçesi doğru: "Yöneticinin belirlediği bir parola,
-- yöneticinin bildiği bir paroladır — her hesabı denetimde ayırt edilemeyecek şekilde taklit
-- edilebilir kılar." Bir yönetici o parolayla giriş yapsa, kayıtlarda kullanıcının kendi
-- girişinden farkı olmazdı.
--
-- Bu tablo o itirazı ortadan kaldırmıyor, GÖRÜNÜR kılıyor. Yönetici bir parola belirlemiyor;
-- tek kullanımlık bir jeton üretiyor ve kullanıcıya elden veriyor (bu cihazda e-posta yok).
-- Parolayı kullanıcı kendisi yazıyor.
--
-- Yönetici jetonu kendisi kullanabilir mi? Evet — cihazın yöneticisi zaten root eşdeğeri, ve
-- bunu tasarımla engellemek mümkün değil. Değişen şey şu: jeton TEK KULLANIMLIK. Yönetici
-- kullanırsa kullanıcının kendi denemesi başarısız olur, yani kurban olayı öğrenir. Sessiz
-- taklit, gürültülü bir hırsızlığa dönüşüyor — sözleşmenin istediği "denetimde ayırt
-- edilebilirlik" tam olarak bu.
--
-- İki adım daha aynı amaca hizmet ediyor:
--
--   * MFA sıfırlamayı ATLATMIYOR. Kullanıcı ikinci faktöre kayıtlıysa jetonu kullanmak için
--     doğrulayıcı kodu ya da kurtarma kodu gerekiyor; yani parola sıfırlaması tek başına hesabı
--     ele geçirmeye yetmiyor. Bunu API uyguluyor, tablo değil — burada yazılmasının sebebi,
--     bunun tablonun güvenlik gerekçesinin bir parçası olması.
--   * Kullanılan jeton kullanıcının BÜTÜN oturumlarını iptal ediyor. Parolasını değiştiren
--     birinin eski oturumlarının ayakta kalması, değişikliği anlamsız kılardı.
--
-- ── Neden `created_by` var ────────────────────────────────────────────────────
--
-- Satır tüketildikten sonra da duruyor (`consumed_at` doluyor, satır silinmiyor): kimin, kim için,
-- ne zaman sıfırlama açtığı denetimin cevaplaması gereken soru. Silinen bir satır bu soruyu
-- cevaplayamaz.

-- Up Migration

SELECT public.assert_rls_roles_sane();

CREATE TABLE public.password_resets (
  id               uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id  uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  user_id          uuid        NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  -- ON DELETE SET NULL, silinmiş bir yöneticinin açtığı sıfırlamanın kaydını da tutmak için:
  -- denetim satırı, onu yazan hesap gittiğinde yok olmamalı.
  created_by       uuid        REFERENCES public.users (id) ON DELETE SET NULL,
  token_hash       bytea       NOT NULL,

  attempts         integer     NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  consumed_at      timestamptz,

  CONSTRAINT password_resets_token_hash_len CHECK (octet_length(token_hash) = 32),
  CONSTRAINT password_resets_expires_after  CHECK (expires_at > created_at),
  CONSTRAINT password_resets_attempts_sane  CHECK (attempts >= 0)
);

-- Global, 0003'ün `sessions_token_hash_key` ve 0004'ün `pending_logins_token_hash_key` ile aynı
-- gerekçeyle: arama kiracı bağlamı var olmadan yapılıyor, ve bir çakışmayı zorlamak zaten değeri
-- elinde tutmayı gerektiriyor. Benzersizlik denetiminin izin listesindeki DÖRDÜNCÜ giriş.
ALTER TABLE public.password_resets
  ADD CONSTRAINT password_resets_token_hash_key UNIQUE (token_hash);

COMMENT ON CONSTRAINT password_resets_token_hash_key ON public.password_resets IS
  'sessions_token_hash_key ile aynı gerekçe: kiracı bilinmeden aranıyor ve çakışma ancak değeri '
  'zaten elinde tutan biri için erişilebilir.';

CREATE INDEX password_resets_expires_at_idx ON public.password_resets (expires_at);

-- Bir kullanıcının aynı anda birden çok açık sıfırlaması olamaz. Olsaydı, üç kez sıfırlama açan
-- bir yönetici üç ayrı deneme bütçesi ve üç ayrı jeton bırakırdı — ve eskisini elinde tutan biri
-- yenisi verildikten sonra da girebilirdi.
CREATE UNIQUE INDEX password_resets_one_open_per_user
  ON public.password_resets (organization_id, user_id)
  WHERE consumed_at IS NULL;

ALTER TABLE public.password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.password_resets FORCE ROW LEVEL SECURITY;

CREATE POLICY password_resets_owner_full ON public.password_resets
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY password_resets_tenant_isolation ON public.password_resets
  FOR ALL TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

-- Yedek rolü bunları okumaz. Jeton özeti tek başına parolayı vermez ama süresi dolmamış bir
-- yedek, açık bir sıfırlamanın özetini taşır ve bu okunacak bir şey değil.
CREATE POLICY password_resets_backup_denied ON public.password_resets
  FOR SELECT TO depsis_backup USING (false);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.password_resets TO depsis_app;

-- ─── kiracısız çözümleyici ────────────────────────────────────────────────────
--
-- ADR-0015 §1'in kapalı kümesine YEDİNCİ giriş, ve eklenmesi ADR'de yazılı bir karar (ADR-0015
-- §5e). Gerekçe `resolve_session` ve `resolve_pending_login` ile birebir aynı: jetonu getiren
-- kişi tanımı gereği giriş yapamıyor, yani kiracı bağlamı yok ve jetonun kendisi kiracıyı
-- adlandıran tek şey.
--
-- Süresi dolmuş, tüketilmiş, deneme hakkı bitmiş ve hiç var olmamış bir jeton AYNI cevabı
-- veriyor — hiçbir satır. Çağıran bunları birbirinden ayıramıyor, ve özellikle bir jetonun bir
-- zamanlar GEÇERLİ olduğunu öğrenemiyor.
CREATE FUNCTION public.resolve_password_reset(token_hash bytea)
RETURNS TABLE (reset_id uuid, organization_id uuid, user_id uuid, attempts integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT r.id, r.organization_id, r.user_id, r.attempts
    FROM public.password_resets r
    JOIN public.users u ON u.id = r.user_id
   WHERE r.token_hash = $1
     AND r.consumed_at IS NULL
     AND r.expires_at > now()
     AND r.attempts < 6
     AND u.disabled_at IS NULL
$$;

COMMENT ON FUNCTION public.resolve_password_reset(bytea) IS
  'ADR-0015 §1, yedinci kiracısız işlem. Devre dışı bir hesabın jetonu çözülmez: devre dışı '
  'bırakmak, parolayı unutmuş olmakla aynı kapıdan geri girilebilecek bir şey olmamalı.';

REVOKE ALL ON FUNCTION public.resolve_password_reset(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_password_reset(bytea) TO depsis_app;

-- Down Migration

DROP FUNCTION IF EXISTS public.resolve_password_reset(bytea);
DROP TABLE IF EXISTS public.password_resets;
