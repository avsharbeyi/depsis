-- Kutuyu sahiplenen fonksiyon, kurucunun ADINI da yazsın.
--
-- ── NE EKSİKTİ ───────────────────────────────────────────────────────────────────────────────
--
-- 0049 `system_setup.admin_username` sütununu ekledi ve VAR OLAN satırı geri doldurdu. Sütunun var
-- olma sebebi şuydu: `admin_user_id` artık `ON DELETE SET NULL`, yani kurucunun hesabı silinince
-- "kutuyu kim kurdu" sorusunu cevaplayacak tek şey satırın kendi içindeki ad.
--
-- Ama kutuyu sahiplenen fonksiyon güncellenmedi. `claim_system_setup` hâlâ yalnız
-- `(organization_id, admin_user_id)` yazıyor, yani 0049'dan SONRA kurulan her cihazda alan NULL —
-- ve sütunun var olma sebebi o cihazlarda hiç işlemiyor. Geri doldurma yalnız bir kez, yalnız o
-- göçün koştuğu cihazlar için çalıştı.
--
-- Bu, ürünün kendi kabul ölçütüne göre bir "yalnızca çalışıyor gibi görünen" durum: şema alanı
-- var, göç onu doldurmuş gibi görünüyor, ve yeni bir kutuda hiçbir zaman dolmuyor.
--
-- ── İMZA DEĞİŞMİYOR ──────────────────────────────────────────────────────────────────────────
--
-- Fonksiyon zaten `admin_username`i parametre olarak alıyor — hesabı onunla açıyor. Eklenen tek
-- şey, aynı değeri ikinci bir sütuna daha yazmak. Uygulama katmanında hiçbir çağrı değişmiyor.

-- Up Migration

SELECT public.assert_rls_roles_sane();

CREATE OR REPLACE FUNCTION public.claim_system_setup(
  org_slug       text,
  org_name       text,
  admin_username text,
  admin_pw_hash  text
)
RETURNS TABLE (organization_id uuid, user_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  new_org  uuid;
  new_user uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.system_setup) THEN
    RAISE EXCEPTION 'setup has already been completed'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  INSERT INTO public.organizations (slug, name) VALUES (org_slug, org_name)
    RETURNING id INTO new_org;

  INSERT INTO public.users (organization_id, username, password_hash, role)
    VALUES (new_org, admin_username, admin_pw_hash, 'admin')
    RETURNING id INTO new_user;

  -- ADI DA YAZILIYOR. `admin_user_id` bir gün NULL olabilir (hesap silinebiliyor, göç 0049); o
  -- gün "kutuyu kim kurdu" sorusunu cevaplayacak olan bu sütun.
  INSERT INTO public.system_setup (organization_id, admin_user_id, admin_username)
    VALUES (new_org, new_user, admin_username);

  RETURN QUERY SELECT new_org, new_user;
END
$$;

REVOKE ALL ON FUNCTION public.claim_system_setup(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_system_setup(text, text, text, text) TO depsis_app;

-- Down Migration

CREATE OR REPLACE FUNCTION public.claim_system_setup(
  org_slug       text,
  org_name       text,
  admin_username text,
  admin_pw_hash  text
)
RETURNS TABLE (organization_id uuid, user_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  new_org  uuid;
  new_user uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.system_setup) THEN
    RAISE EXCEPTION 'setup has already been completed'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  INSERT INTO public.organizations (slug, name) VALUES (org_slug, org_name)
    RETURNING id INTO new_org;

  INSERT INTO public.users (organization_id, username, password_hash, role)
    VALUES (new_org, admin_username, admin_pw_hash, 'admin')
    RETURNING id INTO new_user;

  INSERT INTO public.system_setup (organization_id, admin_user_id)
    VALUES (new_org, new_user);

  RETURN QUERY SELECT new_org, new_user;
END
$$;

REVOKE ALL ON FUNCTION public.claim_system_setup(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_system_setup(text, text, text, text) TO depsis_app;
