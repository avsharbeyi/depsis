-- 0001 — foundation: tenant context, the first two tables, and the RLS they carry.
--
-- ONE FILE, with `-- Up Migration` and `-- Down Migration` markers. This is not a style choice.
--
-- The first version of this migration was a `0001_foundation.up.sql` / `0001_foundation.down.sql`
-- pair, on the strength of `parseSqlFile` in node-pg-migrate's `dist/` recognising those suffixes.
-- P1-A measured what actually happens: the default `.sql` strategy is `legacySql`, which treats
-- ONE FILE AS ONE MIGRATION and gives the suffixes no meaning at all. `up` therefore applied
-- `0001_foundation.down.sql` first — it sorts before `.up` — and then the up file, recording two
-- migrations and printing "Migrations complete!".
--
-- It was harmless only because this particular down file is entirely `DROP ... IF EXISTS` and ran
-- against an empty database. With a second migration present the sorted order becomes 0001.down,
-- 0001.up, 0002.down, 0002.up, so every deploy would run 0002's rollback against the schema 0001
-- had just built. On a cluster that already has data — which is exactly the state this project's
-- own test VM was left in — the first real deploy would drop every tenant row, recreate the
-- tables empty, and exit zero.
--
-- The grouped loader that does pair the suffixes can only be selected through
-- `migrationLoaderStrategies`, and P1-A measured that the CLI ignores that option from a config
-- file in every shape tried. So the pair layout is unreachable from the command line, and the
-- marker layout — the tool's default, needing no configuration whatsoever — is what is used here.
-- It also makes the whole failure class structurally impossible: there is no separate down file
-- that could ever be run forward.
--
-- What this migration establishes is the part ADR-0013 marked as a HIGH revert cost if deferred:
-- row level security with FORCE, and the rule that no UNIQUE may omit organization_id.

-- Up Migration

-- ─── preconditions ────────────────────────────────────────────────────────────
--
-- Roles, the database, and the two extensions are created by `bootstrap.sql`, run once by a
-- superuser during provisioning. They are NOT created here: CREATE ROLE needs privileges the
-- migration role must not have, and a migration that created `depsis_owner` would have to run as
-- something stronger than `depsis_owner`, which every later migration would then inherit for no
-- reason.
--
-- The role ATTRIBUTES are checked, not just the names. A pre-existing `depsis_app` that someone
-- once gave BYPASSRLS while debugging — or that another product in the same cluster created —
-- passes a name-only check, and then every policy below is installed onto a role that ignores all
-- of them. The application connects, reads every tenant's rows, and nothing errors anywhere.

DO $$
DECLARE
  missing text;
  ignoring text;
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

  -- A role that bypasses RLS makes every policy in this file decorative.
  SELECT string_agg(rolname || CASE WHEN rolsuper THEN ' (SUPERUSER)' ELSE ' (BYPASSRLS)' END, ', ')
    INTO ignoring
    FROM pg_roles
   WHERE rolname IN ('depsis_app', 'depsis_backup')
     AND (rolsuper OR rolbypassrls);

  IF ignoring IS NOT NULL THEN
    RAISE EXCEPTION
      'refusing to install row level security for role(s) that ignore it: %. '
      'Re-run bootstrap.sql, which applies NOSUPERUSER NOBYPASSRLS unconditionally.',
      ignoring;
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
-- setting is absent. That is deliberate and is the whole fail-closed mechanism: a query outside a
-- transaction that did `SET LOCAL` gets NULL, every policy comparison against NULL is NULL rather
-- than true, and no rows are visible. P0-C measured this rather than assuming it.
--
-- STABLE, not IMMUTABLE: the value changes between transactions. IMMUTABLE would let the planner
-- cache one tenant's value into a plan reused by another.

CREATE OR REPLACE FUNCTION public.current_organization_id()
RETURNS uuid
LANGUAGE sql
STABLE
-- A fixed search_path so the body cannot be redirected by a caller's. The function is SQL and
-- calls nothing, but the habit is cheap and the exception is what gets forgotten.
SET search_path = pg_catalog
AS $$
  SELECT nullif(current_setting('depsis.organization_id', true), '')::uuid
$$;

COMMENT ON FUNCTION public.current_organization_id() IS
  'Tenant context for RLS. NULL outside a transaction that did SET LOCAL depsis.organization_id, '
  'which makes every policy fail closed. See ADR-0013 and P0-C.';

GRANT EXECUTE ON FUNCTION public.current_organization_id() TO depsis_app, depsis_backup;

-- ─── identity folding for uniqueness keys ─────────────────────────────────────
--
-- `lower()` is NOT a case-folding function for this project's users, and the difference is not
-- academic. Measured on the ICU database bootstrap.sql actually creates:
--
--     lower('İsmail')  ->  69 cc87 736d61696c     (i, U+0307 COMBINING DOT ABOVE, smail)
--     lower('ismail')  ->  69 736d61696c          (i, smail)
--
-- They are different strings. ICU implements the Unicode SpecialCasing rule U+0130 -> i + U+0307
-- unconditionally, so a UNIQUE index on `lower(email)` puts `İsmail@firma.com` and
-- `ismail@firma.com` in different buckets. Two accounts, one address, one tenant, no error and no
-- log line — and the application's own "is this address taken?" check, which must use the same
-- expression to hit the index, also returns nothing. A Turkish-locale phone keyboard produces the
-- capitalised form by itself.
--
-- The same measurement showed NFC and NFD spellings of 'josé' folding apart, which `normalize`
-- fixes.
--
-- This deliberately does NOT strip accents. P0-H measured that DEPSIS's search normaliser
-- collides 'Çağrı' with 'Cagri' — correct for search, fatal for identity, because it would merge
-- two genuinely different people into one account. Folding here is limited to case, the Turkish
-- i-family, and Unicode composition.
CREATE OR REPLACE FUNCTION public.fold_identity(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
  SELECT lower(translate(normalize(value, NFKC), 'İIı', 'iii'))
$$;

COMMENT ON FUNCTION public.fold_identity(text) IS
  'Case and i-family folding for UNIQUENESS keys only. Accent-preserving on purpose: merging '
  'Çağrı with Cagri is correct for search and wrong for identity. Never use this for search.';

GRANT EXECUTE ON FUNCTION public.fold_identity(text) TO depsis_app, depsis_backup;

-- ─── organizations ────────────────────────────────────────────────────────────
--
-- The tenant root. The one table whose rows are not scoped by organization_id, because it defines
-- them.

CREATE TABLE public.organizations (
  id          uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  slug        text        NOT NULL,
  name        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- ASCII-only by construction, so the i-family problem cannot arise here at all.
  CONSTRAINT organizations_slug_format CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
);

-- Globally unique, and unavoidably so — a slug identifies a tenant, so it cannot be scoped to
-- one. P0-C measured what that costs: a UNIQUE violation is visible across tenants and therefore
-- an existence oracle. Accepted rather than hidden, because a slug is chosen by an administrator
-- during provisioning, not by an end user probing the API.
--
-- Written as a table CONSTRAINT rather than a bare CREATE UNIQUE INDEX so it appears in
-- pg_constraint. P1-A measured that a bare unique index has no pg_constraint row at all, which
-- makes it invisible to any audit written the obvious way — including the one in P0-C that is
-- supposed to enforce the organization_id rule.
ALTER TABLE public.organizations ADD CONSTRAINT organizations_slug_key UNIQUE (slug);

COMMENT ON CONSTRAINT organizations_slug_key ON public.organizations IS
  'Deliberately global. A slug names a tenant so it cannot be tenant-scoped. This IS a '
  'cross-tenant existence oracle (P0-C), acceptable only because slugs are set during '
  'provisioning. No other UNIQUE in this schema may omit organization_id.';

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations FORCE ROW LEVEL SECURITY;

-- FORCE means the OWNER is subject to policies too, so the owner needs one or it cannot touch a
-- single row. Without this, the migration succeeds and then every data backfill fails — and,
-- worse, nothing can create an organization at all, because the app policy below requires the
-- row's id to equal the current tenant, which a brand-new organization by definition does not yet
-- have. That chicken-and-egg only became visible by running the schema, not by reading it.
--
-- This does not weaken what FORCE was for. The point was never that the owner is untrusted — it
-- runs DDL and is trusted by construction. The point is that the APPLICATION must not connect as
-- the owner, and that is unchanged (ADR-0013, P0-C).
CREATE POLICY organizations_owner_full ON public.organizations
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

-- The application may READ its own organization and nothing else. Creating, renaming or deleting
-- a tenant is an operator action performed with the owner role, in the same category as creating
-- the roles. Granting the app INSERT here would mean an API bug could mint tenants.
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

  -- Stored, not computed at query time. The uniqueness key and the lookup key are then the same
  -- column by construction: an application that filters on `email_normalized` cannot drift from
  -- the expression the constraint enforces, which is exactly how a case-folding bug survives.
  email_normalized text        NOT NULL
                               GENERATED ALWAYS AS (public.fold_identity(email)) STORED,

  display_name     text        NOT NULL,
  -- Argon2id encoded string, or NULL for an account that authenticates another way. The algorithm
  -- and its parameters live inside the encoded string, so a parameter change needs no migration.
  password_hash    text,
  disabled_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT users_email_has_at CHECK (position('@' IN email) > 1)
);

-- organization_id FIRST, which is the rule ADR-0013 states as a prohibition.
--
-- A global UNIQUE(email) leaks across tenants in a way RLS cannot stop: P0-C measured it. The
-- uniqueness check runs as an internal system operation that ALWAYS bypasses row level security,
-- so tenant A inserting an address tenant B already uses gets a constraint violation and thereby
-- learns the address exists somewhere. Scoping the constraint closes it.
--
-- A CONSTRAINT, not a bare unique index, for the pg_constraint visibility reason above. That is
-- possible here only because the folding lives in a stored column rather than in the index
-- expression — an expression index cannot be a constraint, which is the other reason the column
-- exists.
ALTER TABLE public.users
  ADD CONSTRAINT users_org_email_key UNIQUE (organization_id, email_normalized);

-- Foreign key checks also bypass RLS. This index is not for that — it is so the ON DELETE
-- RESTRICT scan on organizations does not become a sequential scan of users.
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
-- each have to remember, and the one that forgets produces rows whose updated_at is a lie.
--
-- What this column is NOT: a cursor for change feeds. `now()` is transaction START time, so a row
-- written by a transaction that commits thirty seconds later carries a timestamp thirty seconds
-- older than the moment it became visible. A poller doing `WHERE updated_at > $cursor` advances
-- its watermark past that timestamp while the row is still invisible, and never returns it — the
-- change is dropped with no error at any layer, and the window is the length of the writing
-- transaction rather than of a statement. clock_timestamp() would shrink that window without
-- closing it.
--
-- An earlier version of this comment asserted that reconciliation and cursor pagination read this
-- column. That was a design claim with no measurement behind it and it is withdrawn: a
-- commit-ordered watermark (an outbox, or a sequence bumped in the same trigger) is what those
-- need, and it will be introduced by the migration that introduces the first consumer.
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
-- No DDL is granted anywhere. P1-A asserts that against a live database rather than trusting this
-- comment.
--
-- Two layers say the same thing about organizations on purpose: the policy above already stops the
-- app writing, and withholding the privilege as well means a future policy edit cannot quietly
-- open it. The error a developer sees is then "permission denied" rather than a silent zero-row
-- update, which is what an RLS-only refusal looks like from the client side.
GRANT SELECT                         ON public.organizations TO depsis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users         TO depsis_app;
GRANT SELECT                         ON public.organizations, public.users TO depsis_backup;

-- Down Migration

-- Reversible in schema terms, and destructive of data in the process — which is why running it
-- anywhere but a test database falls under §0.5: preview, warning, explicit confirmation.

DROP TRIGGER IF EXISTS users_set_updated_at         ON public.users;
DROP TRIGGER IF EXISTS organizations_set_updated_at ON public.organizations;

-- users first: it references organizations.
DROP TABLE IF EXISTS public.users;
DROP TABLE IF EXISTS public.organizations;

DROP FUNCTION IF EXISTS public.set_updated_at();
DROP FUNCTION IF EXISTS public.fold_identity(text);
DROP FUNCTION IF EXISTS public.current_organization_id();

-- Extensions are deliberately NOT dropped. pg_trgm and unaccent are database-wide and another
-- schema may depend on them; dropping an extension to undo a migration that merely required it is
-- the kind of tidiness that takes an unrelated index with it. P1-A compares `pg_dump --schema-only`
-- across an up/down cycle, so this asymmetry is measured rather than assumed harmless.
--
-- Roles are deliberately NOT dropped either. A role can own objects in other databases in the same
-- cluster and DROP ROLE fails if it does, so a down migration that dropped them would either fail
-- confusingly or succeed on a development box and fail in production. Roles are cluster-level
-- provisioning, not schema.
