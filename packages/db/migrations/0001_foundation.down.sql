-- Reverse of 0001.
--
-- ADR-0014 requires a real `down` for every migration, and requires that an irreversible one fail
-- loudly rather than sit there as an empty file pretending to be reversible. This one IS
-- reversible in schema terms and destroys data in the process, which is exactly why running it
-- anywhere but a test database falls under §0.5 — preview, warning, explicit confirmation.

-- Dropped in reverse dependency order. `users` first: it references `organizations`.
DROP TRIGGER IF EXISTS users_set_updated_at         ON public.users;
DROP TRIGGER IF EXISTS organizations_set_updated_at ON public.organizations;

DROP TABLE IF EXISTS public.users;
DROP TABLE IF EXISTS public.organizations;

DROP FUNCTION IF EXISTS public.set_updated_at();
DROP FUNCTION IF EXISTS public.current_organization_id();

-- Extensions are deliberately NOT dropped.
--
-- pg_trgm and unaccent are database-wide and another migration, or another schema, may depend on
-- them. Dropping an extension to undo a migration that merely required it is the kind of tidiness
-- that takes an unrelated index with it. P1-A item 4 compares `pg_dump --schema-only` before and
-- after, so this asymmetry is measured rather than assumed harmless.

-- Roles are deliberately NOT dropped.
--
-- A role can own objects in other databases in the same cluster, and DROP ROLE fails if it does —
-- so a down migration that dropped them would either fail confusingly or, worse, succeed on a
-- development box and fail in production. Roles are cluster-level provisioning, not schema.
-- Removing them is a deployment action, done knowingly.

-- The schema-level revoke is not undone either: re-granting CREATE on public to PUBLIC would
-- leave the database less safe than this migration found it.
