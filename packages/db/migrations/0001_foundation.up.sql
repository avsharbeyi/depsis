-- 0001 — foundation: tenant context, the first two tables, and the RLS they carry.
--
-- Roles and extensions are NOT here; see the preconditions block below and `bootstrap.sql`.
-- What IS here is the part ADR-0013 marked as a HIGH revert cost if deferred: row level security
-- with FORCE, and the rule that no UNIQUE may omit organization_id. Both are established before
-- there is a single row to migrate.
--
-- Everything in this file is written to be re-runnable in spirit but is NOT idempotent by design:
-- node-pg-migrate records what ran, and a migration that quietly tolerates being applied twice is
-- a migration that hides a broken history table.

-- ─── preconditions ────────────────────────────────────────────────────────────
--
-- Roles, the database, and the two extensions are created by `bootstrap.sql`, run once by a
-- superuser during provisioning. They are NOT created here, and the reason is not tidiness:
-- CREATE ROLE needs privileges the migration role must not have, and a migration that created
-- `depsis_owner` would have to run as something stronger than `depsis_owner` — which every later
-- migration would then inherit for no reason. The `down` file says the same thing from the other
-- side: it refuses to drop roles because they are cluster provisioning, not schema.
--
-- So the migration asserts its preconditions instead, and fails with a sentence someone can act
-- on rather than a missing-role error three statements later.

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(r, ', ')
    INTO missing
    FROM unnest(ARRAY['depsis_owner', 'depsis_app', 'depsis_backup']) AS r
   WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'missing role(s): %. Run packages/db/bootstrap.sql as a superuser first (ADR-0014).',
      missing;
  END IF;

  IF to_regprocedure('pg_catalog.uuidv7()') IS NULL THEN
    RAISE EXCEPTION
      'uuidv7() is missing: DEPSIS requires PostgreSQL 18 or newer (ADR-0013). This server is %.',
      current_setting('server_version');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'unaccent') THEN
    RAISE EXCEPTION 'the unaccent extension is not installed; run bootstrap.sql first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    RAISE EXCEPTION 'the pg_trgm extension is not installed; run bootstrap.sql first';
  END IF;
END
$$;

-- ─── tenant context ───────────────────────────────────────────────────────────
--
-- Every policy reads the organization through this function rather than calling current_setting
-- inline. One definition means one place to audit, and one place where the fail-closed behaviour
-- is decided.
--
-- The `true` second argument makes current_setting return NULL instead of raising when the
-- setting is absent. That is deliberate and is the whole fail-closed mechanism: a query that runs
-- outside a transaction that did `SET LOCAL` gets NULL, every policy comparison against NULL is
-- NULL rather than true, and no rows are visible. P0-C measured this rather than assuming it.
--
-- STABLE, not IMMUTABLE: the value changes between transactions. Marking it IMMUTABLE would let
-- the planner cache one tenant's value into a plan reused by another.

CREATE OR REPLACE FUNCTION public.current_organization_id()
RETURNS uuid
LANGUAGE sql
STABLE
-- An empty search_path so the body cannot be redirected by a caller's search_path. The function
-- is SQL and calls nothing, but the habit is cheap and the exception is what gets forgotten.
SET search_path = pg_catalog
AS $$
  SELECT nullif(current_setting('depsis.organization_id', true), '')::uuid
$$;

COMMENT ON FUNCTION public.current_organization_id() IS
  'Tenant context for RLS. NULL outside a transaction that did SET LOCAL depsis.organization_id, '
  'which makes every policy fail closed. See ADR-0013 and P0-C.';

GRANT EXECUTE ON FUNCTION public.current_organization_id() TO depsis_app, depsis_backup;

-- ─── organizations ────────────────────────────────────────────────────────────
--
-- The tenant root. This table is the one place where a row is NOT scoped by organization_id,
-- because it defines them.

CREATE TABLE public.organizations (
  id          uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  slug        text        NOT NULL,
  name        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT organizations_slug_format CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
);

-- Globally unique, and unavoidably so — a slug identifies a tenant, so it cannot be scoped to
-- one. P0-C measured what that costs: a UNIQUE violation is visible across tenants and therefore
-- an existence oracle. Here it is accepted rather than hidden, because a tenant slug is chosen by
-- an administrator during provisioning, not by an end user probing the API.
CREATE UNIQUE INDEX organizations_slug_key ON public.organizations (slug);

COMMENT ON INDEX public.organizations_slug_key IS
  'Deliberately global. A slug names a tenant so it cannot be tenant-scoped. This IS a cross-tenant '
  'existence oracle (P0-C) and is acceptable only because slugs are set during provisioning, never '
  'by an end user. No other UNIQUE in this schema may omit organization_id.';

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations FORCE ROW LEVEL SECURITY;

-- FORCE means the OWNER is subject to policies too, so the owner needs one or it cannot touch a
-- single row. Without this, running the migration succeeds and then every data backfill fails —
-- and, worse, nothing can create an organization at all: the app policy below requires the row's
-- id to equal the current tenant, which a brand-new organization by definition does not yet have.
-- That chicken-and-egg only became visible by running the schema, not by reading it.
--
-- This does not weaken what FORCE was for. The point was never "the owner is untrusted" — the
-- owner runs DDL and is trusted by construction. The point was that the APPLICATION must not
-- connect as the owner, and that is unchanged (ADR-0013, P0-C).
CREATE POLICY organizations_owner_full ON public.organizations
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

-- The application may READ its own organization and nothing else. It may not create, rename or
-- delete one: provisioning a tenant is an operator action performed with the owner role, in the
-- same category as creating the roles themselves. Giving the app INSERT here would mean an API
-- bug could mint tenants.
CREATE POLICY organizations_tenant_read ON public.organizations
  FOR SELECT
  TO depsis_app
  USING (id = public.current_organization_id());

CREATE POLICY organizations_backup_read ON public.organizations
  FOR SELECT TO depsis_backup USING (true);

-- ─── users ────────────────────────────────────────────────────────────────────

CREATE TABLE public.users (
  id               uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id  uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  email            text        NOT NULL,
  display_name     text        NOT NULL,
  -- Argon2id encoded string, or NULL for an account that authenticates another way. The algorithm
  -- and its parameters live inside the encoded string, so a parameter change needs no migration.
  password_hash    text,
  disabled_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT users_email_has_at CHECK (position('@' IN email) > 1)
);

-- organization_id FIRST in the UNIQUE, and this is the rule ADR-0013 states as a prohibition.
--
-- A global UNIQUE(email) leaks across tenants in a way RLS cannot stop: P0-C measured it. The
-- uniqueness check runs as an internal system operation that bypasses row level security ALWAYS,
-- so tenant A inserting an address already used by tenant B gets a constraint violation and
-- thereby learns the address exists somewhere. Scoping the constraint closes it.
CREATE UNIQUE INDEX users_org_email_key
  ON public.users (organization_id, lower(email));

-- Foreign keys have the same property: the check bypasses RLS. This index is not for that — it is
-- so the ON DELETE RESTRICT scan on organizations does not become a sequential scan of users.
CREATE INDEX users_organization_id_idx ON public.users (organization_id);

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;

CREATE POLICY users_owner_full ON public.users
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY users_tenant_isolation ON public.users
  FOR ALL
  TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

CREATE POLICY users_backup_read ON public.users
  FOR SELECT TO depsis_backup USING (true);

-- ─── updated_at ───────────────────────────────────────────────────────────────
--
-- A trigger rather than application code. Two writers (the API and the worker) would otherwise
-- each have to remember, and the one that forgets produces rows whose updated_at is a lie —
-- which matters because reconciliation and cursor pagination both read it.

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER organizations_set_updated_at
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── privileges ───────────────────────────────────────────────────────────────
--
-- Granted per table, not via ALTER DEFAULT PRIVILEGES. Default privileges apply to objects created
-- LATER by the role that set them, which makes "does depsis_app have access to this new table?"
-- depend on who ran which migration and in what order. Explicit grants in the migration that
-- creates the table keep the answer in the same file as the question.
--
-- No DDL is granted anywhere: depsis_app cannot CREATE, ALTER or DROP. That is asserted in P1-A
-- against a live database rather than trusted from this comment.

-- Two layers saying the same thing on purpose. The policy above already stops the app writing to
-- organizations; withholding the privilege as well means a future policy edit cannot quietly
-- open it, and the error a developer gets is "permission denied" rather than a silent zero-row
-- update, which is what an RLS-only refusal looks like from the client side.
GRANT SELECT                        ON public.organizations TO depsis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users        TO depsis_app;
GRANT SELECT                        ON public.organizations, public.users TO depsis_backup;
