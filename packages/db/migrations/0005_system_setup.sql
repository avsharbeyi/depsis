-- 0005 — the one-time claim that turns a freshly installed box into somebody's box.
--
-- ADR-0009 §"İlk yönetici parolası" says the wizard takes the password in the browser, that §6.3
-- forbids it appearing in a log or a default config, and that the setup path closes permanently
-- once it is done. What it does NOT say is who is allowed to run the wizard, and on a self-hosted
-- appliance that is the whole question: a NAS freshly plugged into a LAN answers to everyone on
-- that LAN, and first-come-first-served means whoever notices first owns the machine.
--
-- The answer this schema supports is a one-time claim token that the API prints to its journal on
-- boot while setup is outstanding. Reading it requires console or SSH access to the machine, which
-- is exactly the authority that ought to decide who the first administrator is. That is NOT the
-- §6.3 prohibition being bent: §6.3 forbids the PASSWORD in a log, and this is not a password —
-- it is single-use, it is worthless once setup completes, and it never authenticates anything
-- afterwards.

-- Up Migration

SELECT public.assert_rls_roles_sane();

-- ─── the singleton ────────────────────────────────────────────────────────────
--
-- `id boolean PRIMARY KEY CHECK (id)` allows exactly one row: the only permitted value is `true`,
-- and the primary key stops it appearing twice. A second setup is then not something the
-- application has to remember to refuse — it is a constraint violation.
CREATE TABLE public.system_setup (
  id            boolean     PRIMARY KEY DEFAULT true,
  completed_at  timestamptz NOT NULL DEFAULT now(),
  -- Which organization and which user the claim produced. Recorded so an operator can answer
  -- "who set this box up, and when" without reading the whole users table.
  organization_id uuid      NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  admin_user_id   uuid      NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,

  CONSTRAINT system_setup_singleton CHECK (id)
);

-- The uniqueness audit flags this primary key, correctly: it carries no organization_id and its
-- column is not a uuid, so it falls outside both of the audit's rules. It is on the allow-list with
-- this argument, and the audit catching it is the mechanism working rather than being in the way.
--
-- Why it leaks nothing: the key is a boolean whose only permitted value is `true`, so provoking a
-- violation tells the caller "setup is already complete" — which `/setup/status` answers to anyone
-- who asks, unauthenticated, on purpose. There is no fact here to learn.
COMMENT ON TABLE public.system_setup IS
  'At most one row, ever. Its existence means setup is complete and the setup endpoints are closed. '
  'Not tenant-scoped, and cannot be: it is the record of the FIRST tenant, so it necessarily '
  'predates tenancy. See ADR-0015 §5d.';

-- No RLS, for the same reason `login_attempts` has none and stated for the same reason: there is no
-- tenant key to filter on, because this row is what brings the first tenant into existence. What
-- protects it is privilege. Do not add organization_id — the row is about the SYSTEM, and scoping
-- it to a tenant would mean a second tenant could claim setup again.
--
-- The application may read it and insert it exactly once. It may not UPDATE or DELETE: reopening
-- setup is an operator action taken deliberately with the owner role, never something an API bug
-- can do.
GRANT SELECT, INSERT ON public.system_setup TO depsis_app;

-- ─── first-administrator provisioning ─────────────────────────────────────────
--
-- Creating the first organization and its administrator is the one thing the application must do
-- that it otherwise cannot: ADR-0014 §4 deliberately withholds INSERT on `organizations` from
-- depsis_app, because an API bug that can mint tenants is a bad thing to have.
--
-- So the capability is granted here, narrowly, as a SECURITY DEFINER function that does the whole
-- claim in one statement and REFUSES if setup is already complete. The application cannot use it to
-- create a second tenant, because the singleton insert inside it fails the second time — and it is
-- one transaction, so a failed claim leaves nothing behind.
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
  -- Checked here rather than only in the application, because the application is not the only
  -- thing that could call this and because a race between two callers has to be settled by the
  -- database, not by whoever read the status first.
  IF EXISTS (SELECT 1 FROM public.system_setup) THEN
    RAISE EXCEPTION 'setup has already been completed'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  INSERT INTO public.organizations (slug, name) VALUES (org_slug, org_name)
    RETURNING id INTO new_org;

  INSERT INTO public.users (organization_id, email, display_name, password_hash)
    VALUES (new_org, admin_email, admin_name, admin_pw_hash)
    RETURNING id INTO new_user;

  -- The singleton insert is what actually closes setup, and it is last: if anything above failed,
  -- the transaction rolls back and setup is still open. Two concurrent claims both reach here and
  -- exactly one survives the primary key.
  INSERT INTO public.system_setup (organization_id, admin_user_id)
    VALUES (new_org, new_user);

  RETURN QUERY SELECT new_org, new_user;
END
$$;

COMMENT ON FUNCTION public.claim_system_setup(text, text, text, text, text) IS
  'The only way the application can create an organization, and it works exactly once. Refuses '
  'once system_setup holds a row; the singleton primary key settles a race between two callers.';

REVOKE ALL ON FUNCTION public.claim_system_setup(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_system_setup(text, text, text, text, text) TO depsis_app;

-- ─── the status question ──────────────────────────────────────────────────────
--
-- Asked before any tenant exists, so it cannot run inside a tenant context. A function rather than
-- a direct SELECT so that the application's grant on the table can stay SELECT-only while the
-- question it actually asks is a boolean — and so an unauthenticated status endpoint returns a
-- boolean rather than a row with an organization id in it.
CREATE FUNCTION public.is_setup_complete()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.system_setup)
$$;

REVOKE ALL ON FUNCTION public.is_setup_complete() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_setup_complete() TO depsis_app;

-- Down Migration

DROP FUNCTION IF EXISTS public.is_setup_complete();
DROP FUNCTION IF EXISTS public.claim_system_setup(text, text, text, text, text);
DROP TABLE IF EXISTS public.system_setup;
