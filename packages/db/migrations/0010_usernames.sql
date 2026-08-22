-- 0010 — sign in with a username, on a box that has exactly one organisation.
--
-- Two pieces of friction removed, both of which produced a real, unrecoverable-looking failure for
-- the owner of this appliance:
--
--   * The sign-in form asked for an ORGANISATION SLUG. `system_setup` is a singleton, so a DEPSIS
--     box has exactly one organisation and always will; asking which one is a question with one
--     possible answer and several ways to get it wrong. A slug with one trailing space fails the
--     server's format check and comes back as the same refusal as a wrong password — measured, on
--     a real sign-in, and it took three rounds of instrumentation to place.
--   * It asked for an EMAIL. A NAS on a home network sends no mail and verifies no address; an
--     address here is a second thing to type and a second thing to typo.
--
-- The multi-tenant machinery underneath is NOT removed and this migration does not weaken it. RLS
-- still scopes every row, every unique key still carries `organization_id`, and the resolver below
-- returns the singleton rather than "whatever tenant the caller named". If DEPSIS ever hosts more
-- than one organisation per box, `resolve_sole_organization` starts refusing and the login form
-- needs the tenant back — which is the right way for that assumption to break.

-- Up Migration

SELECT public.assert_rls_roles_sane();

ALTER TABLE public.users ADD COLUMN username text;

-- Backfilled from the local part of the address, which is what a person would have chosen anyway.
-- Collisions are resolved by appending a counter rather than by failing: this runs on a box that
-- already has accounts, and a migration that refuses to apply because two people share a local part
-- is a migration that strands the appliance.
WITH numbered AS (
  SELECT id,
         organization_id,
         split_part(email, '@', 1) AS base,
         row_number() OVER (
           PARTITION BY organization_id, public.fold_identity(split_part(email, '@', 1))
           ORDER BY created_at, id
         ) AS n
    FROM public.users
)
UPDATE public.users u
   SET username = CASE WHEN numbered.n = 1 THEN numbered.base
                       ELSE numbered.base || numbered.n::text END
  FROM numbered
 WHERE u.id = numbered.id;

ALTER TABLE public.users ALTER COLUMN username SET NOT NULL;

-- Narrow on purpose. A username appears in a URL, in an SMB account name and in a log line, so it
-- is restricted to what all three accept without escaping. No '@', so a username can never be
-- mistaken for an address by a person or by a future parser.
ALTER TABLE public.users
  ADD CONSTRAINT users_username_format
  CHECK (username ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$');

-- Case and the Turkish i-family fold; accents do not. Same rule as the address it replaces, and the
-- same reason: `İSMAİL` and `ismail` are one person, `Çağrı` and `Cagri` are two.
ALTER TABLE public.users
  ADD COLUMN username_folded text
  GENERATED ALWAYS AS (public.fold_identity(username)) STORED;

ALTER TABLE public.users
  ADD CONSTRAINT users_org_username_key UNIQUE (organization_id, username_folded);

-- The address stops being required. Kept rather than dropped: it is the only way to reach a person
-- when notifications arrive, and deleting a column is the one schema change that cannot be undone
-- by a rollback.
ALTER TABLE public.users ALTER COLUMN email DROP NOT NULL;

-- And the column DERIVED from it. `email_normalized` is `GENERATED ALWAYS AS
-- (fold_identity(email)) STORED` and `fold_identity` is STRICT, so a row with no address produces
-- a null here — against a NOT NULL that was correct only while every account had an address.
-- Its UNIQUE constraint is unaffected: nulls do not collide with each other in a unique index, so
-- any number of accounts may have no address while two accounts still cannot share one.
ALTER TABLE public.users ALTER COLUMN email_normalized DROP NOT NULL;

COMMENT ON COLUMN public.users.username IS
  'The sign-in identifier. An email address is optional and is not used to authenticate.';

-- ─── the box knows which organisation it is ───────────────────────────────────
--
-- The fifth untenanted operation (ADR-0015 §1), and deliberately the narrowest one yet: it returns
-- one id and nothing else, and only when the box holds exactly one organisation.
--
-- The `count = 1` guard is the point. Returning "the first one" would silently sign a user into
-- whichever tenant sorted first the day a second one appeared, which is the worst failure this
-- schema can produce. Refusing means the login form gets its tenant field back, loudly.
CREATE OR REPLACE FUNCTION public.resolve_sole_organization()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT id FROM public.organizations
   WHERE (SELECT count(*) FROM public.organizations) = 1
$$;

COMMENT ON FUNCTION public.resolve_sole_organization() IS
  'ADR-0015: untenanted, returns the singleton organisation and NULL when there is not exactly '
  'one. A DEPSIS box is claimed once (system_setup is a singleton), so this is total in practice '
  'and refuses rather than guesses if that ever stops being true.';

REVOKE ALL ON FUNCTION public.resolve_sole_organization() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_sole_organization() TO depsis_app;

-- ─── the claim takes a username ───────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.claim_system_setup(text, text, text, text, text);
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

-- Down Migration

DROP FUNCTION IF EXISTS public.claim_system_setup(text, text, text, text, text);
CREATE FUNCTION public.claim_system_setup(
  org_slug      text,
  org_name      text,
  admin_email   text,
  admin_name    text,
  admin_pw_hash text
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
  INSERT INTO public.users (organization_id, email, display_name, password_hash, role)
    VALUES (new_org, admin_email, admin_name, admin_pw_hash, 'admin')
    RETURNING id INTO new_user;
  INSERT INTO public.system_setup (organization_id, admin_user_id)
    VALUES (new_org, new_user);
  RETURN QUERY SELECT new_org, new_user;
END
$$;
REVOKE ALL ON FUNCTION public.claim_system_setup(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_system_setup(text, text, text, text, text) TO depsis_app;

DROP FUNCTION IF EXISTS public.resolve_sole_organization();

-- A row with no address cannot go back to a NOT NULL column, and inventing one would put a
-- fabricated address in a user record. Filled from the username so the rollback is reversible and
-- obviously synthetic.
UPDATE public.users SET email = username || '@invalid.local' WHERE email IS NULL;
ALTER TABLE public.users ALTER COLUMN email SET NOT NULL;
ALTER TABLE public.users ALTER COLUMN email_normalized SET NOT NULL;

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_org_username_key;
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_username_format;
ALTER TABLE public.users DROP COLUMN IF EXISTS username_folded;
ALTER TABLE public.users DROP COLUMN IF EXISTS username;
