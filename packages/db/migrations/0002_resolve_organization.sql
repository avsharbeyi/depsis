-- 0002 — the one narrow way to get a tenant id before you have a tenant context.
--
-- The chicken-and-egg this closes: a user arrives with a slug. To know which tenant they belong
-- to, `organizations` has to be read. But the application policy on that table is
-- `id = public.current_organization_id()`, so the tenant cannot be read without already knowing
-- the tenant. Login is impossible as written.
--
-- ADR-0015 §5 decides the shape of the exception: a SECURITY DEFINER function owned by
-- depsis_owner that returns ONLY the id, for an exact slug match, and nothing else. The policy on
-- organizations is untouched — a caller who resolves an id still sees no rows in that table until
-- a tenant context is set.

-- Up Migration

-- First statement of every migration after 0001. See the comment on the function in 0001: the
-- check used to be inline there, which meant it guarded exactly one migration.
SELECT public.assert_rls_roles_sane();

CREATE FUNCTION public.resolve_organization_by_slug(slug text)
RETURNS uuid
LANGUAGE sql
STABLE
-- SECURITY DEFINER runs as the function's owner, which is depsis_owner — the role whose policy on
-- organizations is USING (true). That is the entire privilege being borrowed, and it is borrowed
-- for exactly one column of exactly one row.
SECURITY DEFINER
-- A fixed search_path is not optional on a SECURITY DEFINER function. Without it a caller can put
-- their own schema ahead of public and have this function resolve `organizations` to a table they
-- control, which would then run with the owner's privileges. This is the classic SECURITY DEFINER
-- escalation and the reason PostgreSQL's own documentation leads with it.
SET search_path = pg_catalog, public
AS $$
  SELECT o.id
    FROM public.organizations o
   -- The same shape 0001's CHECK constraint enforces. Applying it here as well means a malformed
   -- slug never reaches the table at all: the comparison is against a value that could not exist,
   -- so the query is answered without touching a row the caller has no business probing.
   WHERE $1 ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
     AND o.slug = $1
$$;

COMMENT ON FUNCTION public.resolve_organization_by_slug(text) IS
  'ADR-0015 §5. The only way to obtain a tenant id without a tenant context. Returns the id and '
  'nothing else, for an exact slug match, or NULL. This IS an existence oracle for slugs — the '
  'same one organizations_slug_key already carries, accepted because slugs are operator-assigned '
  'and name a tenant. It does not widen that leak, and it does not relax any policy.';

-- Executable by the application, and by nobody else. PUBLIC gets EXECUTE on new functions by
-- default, which on a SECURITY DEFINER function means every role in the cluster can borrow the
-- owner's privileges through it.
REVOKE ALL ON FUNCTION public.resolve_organization_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_organization_by_slug(text) TO depsis_app;

-- Down Migration

DROP FUNCTION IF EXISTS public.resolve_organization_by_slug(text);
