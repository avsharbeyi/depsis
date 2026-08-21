-- 0007 — the job queue ADR-0003 designed and nothing implemented.
--
-- PostgreSQL with `FOR UPDATE SKIP LOCKED`, not Redis: §17 requires that losing the queue does not
-- lose the job definition, and a job row in the same database as the data change it accompanies
-- gets that for free — one PITR stream, one backup, and the outbox pattern falls out naturally
-- rather than needing two-phase commit.
--
-- The documented caveat is accepted deliberately. PostgreSQL says SKIP LOCKED "provides an
-- inconsistent view of the data, so this is not suitable for general purpose work" — which is
-- exactly what queue consumption wants, and exactly why it appears here and in no other query.

-- Up Migration

SELECT public.assert_rls_roles_sane();

CREATE TABLE public.job_queue (
  id            uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),

  -- Tenant-scoped like everything else, EXCEPT that a job may belong to the system rather than to
  -- any tenant — a pool scrub is nobody's. Nullable, and the RLS policy below makes a null
  -- organization visible to no tenant at all rather than to all of them, which is the failure this
  -- column would otherwise invite.
  organization_id uuid      REFERENCES public.organizations (id) ON DELETE CASCADE,

  kind          text        NOT NULL,
  -- The job's own arguments. Opaque here on purpose: the queue does not interpret them, and a
  -- schema per kind belongs with the code that runs it.
  payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,

  status        text        NOT NULL DEFAULT 'queued',
  priority      smallint    NOT NULL DEFAULT 0,

  -- Scheduling and retry.
  run_after     timestamptz NOT NULL DEFAULT now(),
  attempt       integer     NOT NULL DEFAULT 0,
  max_attempts  integer     NOT NULL DEFAULT 5,

  -- The lease. `FOR UPDATE` cannot hold a long job open — that is transaction bloat, blocked
  -- vacuum and a consumed connection — so the claim is a short transaction that marks the row and
  -- takes a lease the worker then extends with a heartbeat. A worker that dies stops extending and
  -- the row becomes claimable again, which is §17's "on restart, running jobs' leases are
  -- evaluated" without any restart-time scan.
  lease_until   timestamptz,
  worker_id     text,

  progress      real        NOT NULL DEFAULT 0,
  -- Why the last attempt failed. Kept on the row so a retrying job carries its own history; §16
  -- forbids secrets here exactly as it does in the agent's audit trail.
  last_error    text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT job_status_known CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead')),
  CONSTRAINT job_attempts_sane CHECK (attempt >= 0 AND max_attempts > 0),
  CONSTRAINT job_progress_range CHECK (progress >= 0 AND progress <= 1),
  CONSTRAINT job_kind_not_blank CHECK (length(btrim(kind)) > 0),

  -- A running job without a lease is a job nothing can ever reclaim: it is not queued, so no
  -- worker will pick it up, and it has no deadline, so it never expires. The one shape that turns
  -- a crash into a permanently stuck row, refused at the schema.
  CONSTRAINT job_running_has_lease CHECK (status <> 'running' OR lease_until IS NOT NULL)
);

-- The hot set stays small. A completed job is MOVED to job_history rather than left here, so this
-- partial index covers essentially the whole live table and the queue scan never walks history.
CREATE INDEX job_queue_claimable_idx
  ON public.job_queue (priority DESC, run_after, id)
  WHERE status IN ('queued', 'running');

CREATE INDEX job_queue_org_idx ON public.job_queue (organization_id);

-- This table is UPDATE-heavy by nature: every claim, heartbeat and progress report rewrites a row.
-- Left at the defaults, autovacuum waits for 20% of the table to be dead before acting, which on a
-- small hot table means it effectively never runs while the churn is highest.
ALTER TABLE public.job_queue SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_vacuum_cost_delay = 0
);

ALTER TABLE public.job_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_queue FORCE ROW LEVEL SECURITY;

CREATE POLICY job_queue_owner_full ON public.job_queue
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

-- `organization_id = current_organization_id()` and nothing else. A system job carries NULL, and
-- `NULL = anything` is NULL rather than true, so it is invisible to every tenant — which is the
-- intent. The worker reaches these rows as the owner, not through this policy.
CREATE POLICY job_queue_tenant_isolation ON public.job_queue
  FOR ALL
  TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

-- ─── history ──────────────────────────────────────────────────────────────────

CREATE TABLE public.job_history (
  LIKE public.job_queue INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  finished_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.job_history ADD PRIMARY KEY (id);
CREATE INDEX job_history_org_idx ON public.job_history (organization_id, finished_at DESC);

ALTER TABLE public.job_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_history FORCE ROW LEVEL SECURITY;

CREATE POLICY job_history_owner_full ON public.job_history
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY job_history_tenant_isolation ON public.job_history
  FOR ALL
  TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

-- ─── claiming ─────────────────────────────────────────────────────────────────

-- SECURITY DEFINER, for the same reason the TOTP inventory count is (migration 0006): a worker is
-- not a tenant. It runs on behalf of the system and must be able to claim a job from any
-- organization, including the system jobs that belong to none. Confining it with RLS would mean a
-- worker that can only ever see nothing.
--
-- What keeps that safe is the shape of the function rather than a policy: it takes no predicate
-- from the caller, returns exactly one row, and the only thing a caller can influence is which
-- KINDS it is willing to run.
CREATE OR REPLACE FUNCTION public.claim_job(
  p_worker_id  text,
  p_kinds      text[],
  p_lease_secs integer DEFAULT 60
)
RETURNS SETOF public.job_queue
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.job_queue
     SET status      = 'running',
         lease_until = now() + make_interval(secs => p_lease_secs),
         attempt     = attempt + 1,
         worker_id   = p_worker_id,
         updated_at  = now()
   WHERE id = (
     SELECT id
       FROM public.job_queue
      WHERE kind = ANY (p_kinds)
        AND run_after <= now()
        AND (
          status = 'queued'
          -- Reclaiming a crashed worker's job. The lease expiring IS the crash detection: there is
          -- no heartbeat table to scan and no restart hook to forget to write.
          OR (status = 'running' AND lease_until < now())
        )
      ORDER BY priority DESC, run_after, id
      -- The one place SKIP LOCKED appears. Two workers running this concurrently take different
      -- rows instead of one of them blocking on the other's lock.
      FOR UPDATE SKIP LOCKED
      LIMIT 1
   )
  RETURNING *;
$$;

COMMENT ON FUNCTION public.claim_job(text, text[], integer) IS
  'Claim one job, or return no rows. SECURITY DEFINER because a worker is not a tenant and must be '
  'able to run system jobs, which belong to no organization. Takes no caller-supplied predicate.';

REVOKE ALL     ON FUNCTION public.claim_job(text, text[], integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.claim_job(text, text[], integer) TO depsis_app;

-- Extending the lease, conditional on still holding it. A worker whose lease expired and whose job
-- was reclaimed by someone else must NOT be able to extend it back — that is the moment two
-- workers would both believe they own the job, which is precisely what "at least once" means and
-- why §17 requires jobs to be idempotent.
CREATE OR REPLACE FUNCTION public.heartbeat_job(
  p_id         uuid,
  p_worker_id  text,
  p_lease_secs integer DEFAULT 60,
  p_progress   real DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH extended AS (
    UPDATE public.job_queue
       SET lease_until = now() + make_interval(secs => p_lease_secs),
           progress    = coalesce(p_progress, progress),
           updated_at  = now()
     WHERE id = p_id
       AND status = 'running'
       AND worker_id = p_worker_id
       AND lease_until >= now()
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM extended);
$$;

REVOKE ALL     ON FUNCTION public.heartbeat_job(uuid, text, integer, real) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.heartbeat_job(uuid, text, integer, real) TO depsis_app;

-- Finishing: move the row to history, or send it back for another attempt.
--
-- Moving rather than marking is what keeps the queue table small enough for the partial index to
-- stay useful, and it is done in one statement so a job is never in both tables or neither.
CREATE OR REPLACE FUNCTION public.finish_job(
  p_id        uuid,
  p_worker_id text,
  p_outcome   text,
  p_error     text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_job    public.job_queue;
  v_status text;
BEGIN
  IF p_outcome NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'finish_job: outcome must be succeeded or failed, got %', p_outcome;
  END IF;

  -- Only the holder of a live lease may finish the job. A worker that lost its lease and finishes
  -- late would otherwise overwrite the result of whoever legitimately reclaimed it.
  SELECT * INTO v_job
    FROM public.job_queue
   WHERE id = p_id AND worker_id = p_worker_id AND status = 'running' AND lease_until >= now()
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF p_outcome = 'succeeded' THEN
    v_status := 'succeeded';
  ELSIF v_job.attempt >= v_job.max_attempts THEN
    -- Out of attempts. `dead` rather than `failed`, and it does NOT silently disappear: the row
    -- lands in history where an alarm can find it (ADR-0003, §17).
    v_status := 'dead';
  ELSE
    v_status := 'retry';
  END IF;

  IF v_status = 'retry' THEN
    UPDATE public.job_queue
       SET status      = 'queued',
           lease_until = NULL,
           worker_id   = NULL,
           last_error  = p_error,
           -- Exponential backoff, capped. A job that fails instantly five times in a row would
           -- otherwise burn its attempts inside a second and reach `dead` before the transient
           -- cause — a restarting database, a busy pool — had any chance to clear.
           run_after   = now() + make_interval(secs => least(300, power(2, v_job.attempt)::integer)),
           updated_at  = now()
     WHERE id = p_id;
    RETURN 'queued';
  END IF;

  INSERT INTO public.job_history
  SELECT (j).*, now()
    FROM (SELECT j FROM public.job_queue j WHERE j.id = p_id) s(j);

  UPDATE public.job_history
     SET status = v_status, last_error = p_error, lease_until = NULL, updated_at = now()
   WHERE id = p_id;

  DELETE FROM public.job_queue WHERE id = p_id;
  RETURN v_status;
END;
$$;

REVOKE ALL     ON FUNCTION public.finish_job(uuid, text, text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.finish_job(uuid, text, text, text) TO depsis_app;

-- Reading a job's status from either table, under the caller's own tenant context.
--
-- NOT security definer: this one is reached by an HTTP request on behalf of a user, so row level
-- security is exactly what should apply. A job in another tenant must be indistinguishable from a
-- job that does not exist.
CREATE OR REPLACE FUNCTION public.find_job(p_id uuid)
RETURNS TABLE (
  id uuid, kind text, status text, progress real,
  created_at timestamptz, last_error text
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT id, kind, status, progress, created_at, last_error
    FROM public.job_queue WHERE id = p_id
  UNION ALL
  SELECT id, kind, status, progress, created_at, last_error
    FROM public.job_history WHERE id = p_id
$$;

GRANT EXECUTE ON FUNCTION public.find_job(uuid) TO depsis_app;

-- ─── destructive administrative work ──────────────────────────────────────────

-- §17: "multiple administrative operations that would create split-brain are prevented with an
-- advisory lock." `try`, never the blocking form — a caller that waits in line is a caller holding
-- a connection open on the guess that the other operation will finish, and the useful answer is
-- "something else is already working on this resource" rather than a hang.
CREATE OR REPLACE FUNCTION public.try_lock_resource(p_namespace integer, p_resource text)
RETURNS boolean
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog, public
AS $$
  SELECT pg_try_advisory_xact_lock(p_namespace, hashtext(p_resource))
$$;

COMMENT ON FUNCTION public.try_lock_resource(integer, text) IS
  'Transaction-scoped advisory lock for destructive administrative work (pool creation, disk role '
  'changes, resilver, Samba publish). Released when the transaction ends, so a crashed caller '
  'cannot hold it forever. hashtext collisions only ever cause a spurious refusal, never a '
  'spurious grant.';

GRANT EXECUTE ON FUNCTION public.try_lock_resource(integer, text) TO depsis_app;

-- ─── privileges ───────────────────────────────────────────────────────────────
--
-- Explicit per table, as every migration here does: there are no default privileges to inherit, so
-- a table nobody grants is a table nobody can read. Forgetting this produced "permission denied for
-- table job_queue" on the first run, which is the mechanism working.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_queue   TO depsis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_history TO depsis_app;

-- `depsis_backup` gets the HISTORY and not the QUEUE, and the line between them is the point.
--
-- History is a record of what happened: an operator restoring a system should be able to see that
-- last Tuesday's snapshot job failed. A queued job is not data, it is INTENT — and intent restored
-- from a week-old backup is a system that immediately re-runs a week-old "publish samba config" or
-- "create dataset" against a world that has moved on. Losing queued work in a restore is a smaller
-- problem than silently acting on stale instructions, and a restore is exactly the moment nobody is
-- watching for that.
GRANT SELECT ON public.job_history TO depsis_backup;

-- Down Migration

DROP FUNCTION IF EXISTS public.try_lock_resource(integer, text);
DROP FUNCTION IF EXISTS public.find_job(uuid);
DROP FUNCTION IF EXISTS public.finish_job(uuid, text, text, text);
DROP FUNCTION IF EXISTS public.heartbeat_job(uuid, text, integer, real);
DROP FUNCTION IF EXISTS public.claim_job(text, text[], integer);
DROP TABLE IF EXISTS public.job_history;
DROP TABLE IF EXISTS public.job_queue;
