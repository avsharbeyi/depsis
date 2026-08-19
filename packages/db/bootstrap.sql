-- Cluster provisioning. Run ONCE, by a superuser, before the first migration.
--
--   sudo -u postgres psql -p <port> -f bootstrap.sql
--
-- This is not a migration and is deliberately not in migrations/. Roles and databases are
-- cluster-level objects: they outlive the schema, they can be referenced from other databases in
-- the same cluster, and creating them needs privileges the migration role must not have.
--
-- The split matters for a specific reason. ADR-0014 says migrations run as `depsis_owner`. If the
-- migration that creates `depsis_owner` also ran as `depsis_owner`, the role would have to exist
-- before it created itself — so in practice migrations would run as a superuser, and every later
-- migration would inherit that privilege for no reason. Keeping role creation here means the
-- migration role can be exactly as weak as it needs to be.
--
-- Passwords are NOT set here. They belong to the deployment. Set them separately, e.g.
--   \password depsis_owner
-- or via ALTER ROLE from a script that reads them from the secret store. A password written into
-- this file would appear in the server log under log_statement = 'ddl'.

\set ON_ERROR_STOP on

-- ─── roles ────────────────────────────────────────────────────────────────────
--
-- NOINHERIT throughout: a role must be assumed explicitly with SET ROLE, never picked up
-- silently through membership.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'depsis_owner') THEN
    -- Owns every schema object and runs migrations. Not a superuser: it needs no CREATEROLE and
    -- no CREATEDB, because this file already did both.
    CREATE ROLE depsis_owner NOINHERIT LOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'depsis_app') THEN
    -- The only role the API and worker connect as. DML only; the migration grants nothing else.
    -- P0-C measured why this cannot be the owner: a table's owner bypasses row level security
    -- unless FORCE is set, so "the app connects as the owner" and "the app sees every tenant"
    -- are the same sentence.
    CREATE ROLE depsis_app NOINHERIT LOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'depsis_backup') THEN
    CREATE ROLE depsis_backup NOINHERIT LOGIN;
  END IF;
END
$$;

-- ─── database ─────────────────────────────────────────────────────────────────
--
-- CREATE DATABASE cannot run inside a transaction block or a DO block, so it is guarded with a
-- \gexec instead: the SELECT produces the statement only when the database is absent, and
-- produces nothing otherwise.
--
-- ICU as the default provider, with a deterministic collation. ADR-0010's Turkish search work
-- depends on collation behaviour, and libc collations change under the operating system without
-- warning, which silently invalidates every index built on them.
SELECT format(
         'CREATE DATABASE depsis OWNER depsis_owner '
         'ENCODING ''UTF8'' LOCALE_PROVIDER icu ICU_LOCALE ''und-x-icu'' TEMPLATE template0'
       )
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'depsis')
\gexec

-- Nobody but the three DEPSIS roles may connect. PUBLIC has CONNECT on every new database by
-- default, which means any role in the cluster can open it and start probing.
REVOKE CONNECT ON DATABASE depsis FROM PUBLIC;
GRANT  CONNECT ON DATABASE depsis TO depsis_owner, depsis_app, depsis_backup;

-- ─── extensions ───────────────────────────────────────────────────────────────
--
-- CREATE EXTENSION needs privileges depsis_owner does not have for some extensions, and both of
-- these are cluster-provided rather than schema content, so they are installed here. The
-- migration checks that they are present and refuses to proceed if they are not.
\connect depsis

CREATE EXTENSION IF NOT EXISTS pg_trgm  WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;

-- ─── the version gate ─────────────────────────────────────────────────────────
--
-- ADR-0013 requires PostgreSQL 18 for the built-in uuidv7(). Debian 13 ships 17, so pointing this
-- at the stock cluster is an easy mistake to make — and one that would otherwise surface as a
-- confusing error partway through the first migration.
DO $$
BEGIN
  IF to_regprocedure('pg_catalog.uuidv7()') IS NULL THEN
    RAISE EXCEPTION
      'uuidv7() is missing: DEPSIS requires PostgreSQL 18 or newer (ADR-0013). This server is %. '
      'On Debian 13 the stock cluster is 17; the PGDG 18 cluster is usually on port 5433.',
      current_setting('server_version');
  END IF;
END
$$;

-- ─── schema privileges ────────────────────────────────────────────────────────
--
-- Done here rather than in the migration because it concerns the database's own public schema,
-- which depsis_owner does not own.
--
-- Removing CREATE from PUBLIC is the PG 15+ default; stating it explicitly means the guarantee
-- does not depend on which major version created the database. It matters more than it looks:
-- without it depsis_app could create its own tables, would own them, and an owner bypasses RLS.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT  CREATE, USAGE ON SCHEMA public TO depsis_owner;
GRANT  USAGE         ON SCHEMA public TO depsis_app, depsis_backup;
