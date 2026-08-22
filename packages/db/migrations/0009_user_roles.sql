-- 0009 — a second user, and something to tell the two apart.
--
-- Until now an appliance had exactly one account and no way to make another. That is not only a
-- missing feature: it made the §20 access-control gate untestable, because "an unauthorised user is
-- refused" needs an unauthorised user to exist. Everything here is in service of that sentence.
--
-- An ORGANISATION-level role, deliberately separate from the per-node ACL in `packages/authz`.
-- They answer different questions and conflating them is a mistake that is hard to undo: the ACL
-- says who may read this folder, and the role says who may create accounts and hand out ACLs at
-- all. ADR-0004's model is allow-only and per-node; it has nowhere to express "may administer the
-- organisation", and stretching it to do so would put an unenforceable-at-the-substrate permission
-- into a vocabulary whose whole point is that every entry maps onto a POSIX ACE.

-- Up Migration

SELECT public.assert_rls_roles_sane();

ALTER TABLE public.users
  ADD COLUMN role text NOT NULL DEFAULT 'member';

ALTER TABLE public.users
  ADD CONSTRAINT users_role_known CHECK (role IN ('admin', 'member'));

COMMENT ON COLUMN public.users.role IS
  'Organisation-level role. Distinct from the per-node ACL (ADR-0004), which cannot express '
  '"may administer the organisation" and should not be taught to.';

-- The account that claimed the box is the administrator. Backfilled from the singleton rather than
-- guessed at from creation order: `system_setup.admin_user_id` is the recorded fact, and on a box
-- claimed before this migration it is the only one.
UPDATE public.users u
   SET role = 'admin'
  FROM public.system_setup s
 WHERE u.id = s.admin_user_id;

-- Finding the administrators of a tenant is the question the lockout guard below asks on every
-- demotion, so it gets an index rather than a sequential scan of every account.
CREATE INDEX users_admins ON public.users (organization_id)
  WHERE role = 'admin' AND disabled_at IS NULL;

-- ─── the lockout guard ────────────────────────────────────────────────────────
--
-- An organisation must never reach zero usable administrators. Once it does, nothing inside DEPSIS
-- can restore one: creating accounts requires an administrator, `claim_system_setup` refuses to run
-- a second time, and the only remaining route is a root shell and hand-written SQL — on an
-- appliance whose owner is not expected to have either.
--
-- A TRIGGER rather than a check in the API, and the reason is not defence in depth. A CHECK
-- constraint cannot see other rows, and an application-level count is a read followed by a write
-- with a gap in between: two administrators demoting each other concurrently both read "two
-- admins", both proceed, and the organisation is locked out with neither request having done
-- anything wrong. The trigger runs inside the writing transaction, so the second one sees the
-- first.
CREATE OR REPLACE FUNCTION public.refuse_last_admin_removal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  remaining integer;
BEGIN
  -- Only the transitions that can REMOVE an administrator are interesting. A promotion, a rename
  -- or a password change must not pay for a count.
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

-- BEFORE, so the refusal happens before the row changes rather than being rolled back after.
-- FOR EACH ROW, because a statement-level trigger cannot see which rows are being demoted.
CREATE TRIGGER users_keep_one_admin
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.refuse_last_admin_removal();

-- Deleting an administrator outright is not guarded here because nothing deletes a user: accounts
-- are disabled, never removed, so their audit entries and their files keep an owner. The FK from
-- system_setup is ON DELETE RESTRICT and makes that structural for the first admin at least.

-- ─── the claim creates an administrator ───────────────────────────────────────
--
-- Replaced rather than patched from the outside: the function is SECURITY DEFINER and the account
-- it creates is the only one that will ever exist without an administrator to create it, so the
-- role has to be set in the same statement. Setting it afterwards would leave a window — however
-- short — in which the box has an account and no administrator.
CREATE OR REPLACE FUNCTION public.claim_system_setup(
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

-- ─── the session carries the role ─────────────────────────────────────────────
--
-- Added to `resolve_session` rather than fetched separately, because a second query is a second
-- moment in time: an administrator demoted between the two would still be treated as one for the
-- request in flight. One statement, one snapshot.
--
-- DROP first, and not by preference: `CREATE OR REPLACE` cannot change a function's OUT parameters
-- — PostgreSQL answers 42P13 "Row type defined by OUT parameters is different" — so adding a
-- returned column means replacing the function outright. The GRANT below is re-issued for the same
-- reason: dropping a function takes its privileges with it, and an un-granted `resolve_session`
-- makes every request fail closed at the first query.
DROP FUNCTION IF EXISTS public.resolve_session(bytea);
CREATE FUNCTION public.resolve_session(token_hash bytea)
RETURNS TABLE (session_id uuid, organization_id uuid, user_id uuid, role text, expires_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s.organization_id, s.user_id, u.role, s.expires_at
    FROM public.sessions s
    JOIN public.users u ON u.id = s.user_id
   WHERE s.token_hash = $1
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
     AND u.disabled_at IS NULL
$$;

REVOKE ALL ON FUNCTION public.resolve_session(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_session(bytea) TO depsis_app;

-- Down Migration

-- The old four-column shape. A signature change cannot be replaced in place, so the new one is
-- dropped first — otherwise the rollback leaves a function returning a column nothing reads.
DROP FUNCTION IF EXISTS public.resolve_session(bytea);
CREATE FUNCTION public.resolve_session(token_hash bytea)
RETURNS TABLE (session_id uuid, organization_id uuid, user_id uuid, expires_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s.organization_id, s.user_id, s.expires_at
    FROM public.sessions s
    JOIN public.users u ON u.id = s.user_id
   WHERE s.token_hash = $1
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
     AND u.disabled_at IS NULL
$$;
REVOKE ALL ON FUNCTION public.resolve_session(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_session(bytea) TO depsis_app;

CREATE OR REPLACE FUNCTION public.claim_system_setup(
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
  INSERT INTO public.users (organization_id, email, display_name, password_hash)
    VALUES (new_org, admin_email, admin_name, admin_pw_hash)
    RETURNING id INTO new_user;
  INSERT INTO public.system_setup (organization_id, admin_user_id)
    VALUES (new_org, new_user);
  RETURN QUERY SELECT new_org, new_user;
END
$$;
REVOKE ALL ON FUNCTION public.claim_system_setup(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_system_setup(text, text, text, text, text) TO depsis_app;

DROP TRIGGER IF EXISTS users_keep_one_admin ON public.users;
DROP FUNCTION IF EXISTS public.refuse_last_admin_removal();
DROP INDEX IF EXISTS public.users_admins;
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_known;
ALTER TABLE public.users DROP COLUMN IF EXISTS role;
