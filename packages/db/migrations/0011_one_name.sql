-- 0011 — one name per account.
--
-- `display_name` and `username` were two fields for one thing. On an appliance whose owner creates
-- every account by hand, the distinction bought nothing and cost a field in every form: the setup
-- wizard asked for both, the user-creation form asked for both, and the two were the same string
-- every time anyone filled them in.
--
-- The column is dropped rather than left nullable. A column nothing writes and nothing reads is a
-- column the next person has to work out the status of, and "it is vestigial" is not something a
-- schema can say. The rollback re-creates it from the username, so nothing is lost that was not
-- already a copy.

-- Up Migration

SELECT public.assert_rls_roles_sane();

ALTER TABLE public.users DROP COLUMN display_name;

COMMENT ON COLUMN public.users.username IS
  'The account name: the sign-in identifier and the name shown in the interface. There is no '
  'separate display name — on a box where the owner creates every account, the two were the same '
  'string every time (migration 0011).';

-- `claim_system_setup` loses the argument with it. Five parameters became four, so the old
-- signature is dropped rather than replaced: PostgreSQL would otherwise keep both and the
-- application would bind to whichever it resolved.
DROP FUNCTION IF EXISTS public.claim_system_setup(text, text, text, text, text);
CREATE FUNCTION public.claim_system_setup(
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

-- Down Migration

DROP FUNCTION IF EXISTS public.claim_system_setup(text, text, text, text);

-- NOT NULL in two steps, because the column has to be filled before it can be required. Filled
-- from the username, which is what it held in practice anyway.
ALTER TABLE public.users ADD COLUMN display_name text;
UPDATE public.users SET display_name = username;
ALTER TABLE public.users ALTER COLUMN display_name SET NOT NULL;

CREATE FUNCTION public.claim_system_setup(
  org_slug       text,
  org_name       text,
  admin_username text,
  admin_name     text,
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
  INSERT INTO public.users (organization_id, username, display_name, password_hash, role)
    VALUES (new_org, admin_username, admin_name, admin_pw_hash, 'admin')
    RETURNING id INTO new_user;
  INSERT INTO public.system_setup (organization_id, admin_user_id)
    VALUES (new_org, new_user);
  RETURN QUERY SELECT new_org, new_user;
END
$$;
REVOKE ALL ON FUNCTION public.claim_system_setup(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_system_setup(text, text, text, text, text) TO depsis_app;
