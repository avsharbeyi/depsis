import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { DbService } from '../db/db.service.js';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead';

export interface Job {
  id: string;
  kind: string;
  status: JobStatus;
  progress: number;
  createdAt: Date;
  lastError: string | null;
}

export interface ClaimedJob {
  id: string;
  organizationId: string | null;
  kind: string;
  payload: unknown;
  attempt: number;
  maxAttempts: number;
}

/**
 * What `finish` did with the job, or null if the caller no longer held the lease.
 *
 * `failed` is the narrow fourth case and it is NOT `dead`: the job still had attempts left, but
 * re-queueing it would have produced a second scheduled job of a kind that allows only one — its
 * own successor, which the handler queues before doing the work. The turn is lost; the chain is
 * not. `dead` means the queue gave up after exhausting the attempts, and blurring the two would
 * blunt the one alarm ADR-0003 §17 asks for.
 */
export type FinishOutcome = 'succeeded' | 'dead' | 'queued' | 'failed' | null;

interface JobRow {
  id: string;
  kind: string;
  status: JobStatus;
  progress: number;
  created_at: Date;
  last_error: string | null;
}

interface ClaimRow {
  id: string;
  organization_id: string | null;
  kind: string;
  payload: unknown;
  attempt: number;
  max_attempts: number;
}

/**
 * The queue ADR-0003 designed.
 *
 * Two audiences, and the split matters. Enqueue and lookup run under the caller's tenant context,
 * because they happen on behalf of a user and row level security is exactly what should apply.
 * Claim, heartbeat and finish are the WORKER's side: a worker is not a tenant, it runs on behalf of
 * the system, and it must be able to take a job from any organization — including the system jobs
 * that belong to none. Those three go through SECURITY DEFINER functions rather than through a
 * connection with wider rights, so the widening is a named function with a fixed shape rather than
 * a role that could be pointed anywhere.
 *
 * Delivery is AT LEAST ONCE. A worker can miss a heartbeat, have its job reclaimed, and finish
 * anyway; the functions refuse the late write, but by then both may have run the work. §17's
 * requirement that jobs be idempotent is not advice.
 */
@Injectable()
export class JobsService implements OnModuleInit {
  private readonly logger = new Logger(JobsService.name);

  /** Identifies this process in `worker_id`, so a lease can be traced to who holds it. */
  readonly workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;

  /** The self-scheduling chain that keeps `job_history` from growing without end. */
  static readonly PRUNE_KIND = 'jobs.prune';
  /** A day between rounds. Retention is measured in weeks, so anything finer is churn. */
  static readonly PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
  /** Rows per DELETE. ADR-0003 forbids the long transaction a single unbounded DELETE would be. */
  static readonly PRUNE_BATCH = 5_000;
  /** Batches per round, so one turn cannot hold a worker for an hour on a year of backlog. */
  static readonly PRUNE_BATCHES_PER_ROUND = 20;
  /** Ordinary rows: a week. Long enough to explain what happened yesterday. */
  static readonly PRUNE_KEEP_DAYS = 7;
  /**
   * `dead` and `failed` rows: three months.
   *
   * ADR-0003 §17 keeps a dead job precisely so "an alarm can find it", and a week is not long
   * enough for that to be true — a failure that lands during a holiday would be swept away before
   * anybody came back to look.
   */
  static readonly PRUNE_KEEP_TERMINAL_DAYS = 90;

  constructor(private readonly db: DbService) {}

  /**
   * Seed the pruning chain for every tenant on this box.
   *
   * SEEDED AT BOOT rather than only chained, and 0055 is the reason: `job_queue.run_after` is the
   * only durable timer this product has, so a chain whose last link never queued its successor is
   * a chain that stops forever with no symptom at all. The same shape cost the appliance its whole
   * indexing run in the field.
   *
   * `all_organization_ids()` rather than a plain read of `organizations`: there is no tenant
   * context at boot, and under RLS a context-free read of that table returns zero rows — silently.
   */
  async onModuleInit(): Promise<void> {
    try {
      for (const organizationId of await this.db.tenantIds()) {
        await this.schedulePrune(organizationId, new Date());
      }
    } catch (error) {
      // Not fatal. A box that cannot seed the sweep still works; it just accumulates history, and
      // saying so is what makes that finite rather than invisible.
      this.logger.error(
        `could not seed the job history sweep: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Put a job on the queue for one tenant.
   *
   * Deliberately takes the tenant explicitly and writes through `withTenant`: a job enqueued
   * without a tenant context would be a system job, and that is a different decision that should
   * not be reachable by forgetting an argument.
   */
  async enqueue(
    organizationId: string,
    kind: string,
    payload: Record<string, unknown> = {},
    options: { priority?: number; maxAttempts?: number; runAfter?: Date } = {},
  ): Promise<string> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ id: string }>(
        `INSERT INTO job_queue (organization_id, kind, payload, priority, max_attempts, run_after)
         VALUES ($1, $2, $3::jsonb, $4, $5, coalesce($6, now()))
         RETURNING id::text AS id`,
        [
          organizationId,
          kind,
          JSON.stringify(payload),
          options.priority ?? 0,
          options.maxAttempts ?? 5,
          options.runAfter ?? null,
        ],
      ),
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`could not enqueue a '${kind}' job`);
    return id;
  }

  /**
   * Look one up, under the caller's own tenant context.
   *
   * Returns null both for "no such job" and for "a job belonging to somebody else", because row
   * level security makes them the same query result — and they should be the same answer, or the
   * endpoint becomes an oracle for which job ids exist.
   */
  async find(organizationId: string, jobId: string): Promise<Job | null> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<JobRow>(
        `SELECT id::text AS id, kind, status, progress, created_at, last_error
           FROM public.find_job($1)`,
        [jobId],
      ),
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      progress: row.progress,
      createdAt: row.created_at,
      lastError: row.last_error,
    };
  }

  /**
   * The tenant's jobs, newest first — the listing `GET /jobs/{jobId}` cannot substitute for.
   *
   * It exists for one status in particular. A `dead` job is a piece of work the queue gave up on
   * after exhausting its attempts, and for `permissions.apply` that means a permission applied in
   * the database and never applied to the filesystem: a folder the web reports as closed and SMB
   * keeps serving. The row is preserved in `job_history` rather than deleted, which ADR-0003 calls
   * "an alarm can find it" — but nothing could, because the only way to reach a job was to already
   * hold its id, and the page holding it is long gone by the time the job dies.
   *
   * BOTH TABLES, because a job lives in `job_queue` until it reaches a terminal state and in
   * `job_history` afterwards. A listing that read only one of them would answer "no dead jobs" on
   * an appliance full of them, which is the worst available answer.
   *
   * `withTenant`, so RLS decides what is visible rather than a WHERE clause anyone could forget.
   */
  async list(
    organizationId: string,
    statuses: readonly JobStatus[],
    limit: number,
  ): Promise<Job[]> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<JobRow>(
        `SELECT id::text AS id, kind, status, progress, created_at, last_error
           FROM (
             SELECT id, kind, status, progress, created_at, last_error FROM public.job_queue
             UNION ALL
             SELECT id, kind, status, progress, created_at, last_error FROM public.job_history
             -- NOT "AS both": BOTH is a reserved word in PostgreSQL, as in TRIM(BOTH ...), and a
             -- bare alias by that name is a syntax error. (No backticks here -- template literal.)
           ) AS every_job
          WHERE cardinality($1::text[]) = 0 OR status = ANY($1::text[])
          ORDER BY created_at DESC, id DESC
          LIMIT $2`,
        [[...statuses], limit],
      ),
    );
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      progress: row.progress,
      createdAt: row.created_at,
      lastError: row.last_error,
    }));
  }

  // ─── the worker's side ──────────────────────────────────────────────────────

  /**
   * Take one job of a kind this worker can run, or nothing.
   *
   * `leaseSeconds` is a promise about how often this worker will check in, not a guess at how long
   * the job takes: the work may run for an hour under a sixty-second lease as long as the heartbeat
   * keeps extending it. Sizing the lease to the WORK instead would mean a crashed worker's job sits
   * unreclaimed for that long.
   */
  async claim(kinds: readonly string[], leaseSeconds = 60): Promise<ClaimedJob | null> {
    if (kinds.length === 0) return null;
    const rows = await this.db.withoutTenant('job-queue-worker', (q) =>
      q.query<ClaimRow>(
        `SELECT id::text AS id, organization_id::text AS organization_id, kind, payload,
                attempt, max_attempts
           FROM public.claim_job($1, $2, $3)`,
        [this.workerId, kinds, leaseSeconds],
      ),
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      organizationId: row.organization_id,
      kind: row.kind,
      payload: row.payload,
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
    };
  }

  /**
   * Extend the lease, and report progress while doing it.
   *
   * Returns false when this worker no longer holds the job — its lease expired and somebody else
   * took it. A worker that ignores a false here is a worker racing another one over the same work,
   * so the return value is the signal to STOP, not a diagnostic.
   */
  async heartbeat(jobId: string, leaseSeconds = 60, progress?: number): Promise<boolean> {
    const rows = await this.db.withoutTenant('job-queue-worker', (q) =>
      q.query<{ ok: boolean }>(`SELECT public.heartbeat_job($1, $2, $3, $4) AS ok`, [
        jobId,
        this.workerId,
        leaseSeconds,
        progress ?? null,
      ]),
    );
    return rows[0]?.ok === true;
  }

  /**
   * Report the outcome. Returns what actually happened to the job, or null if the lease was lost.
   *
   * A failure is not necessarily the end: the function decides between another attempt and `dead`
   * by comparing attempts, and a retry gets exponential backoff so five instant failures cannot
   * consume every attempt inside a second.
   */
  async finish(
    jobId: string,
    outcome: 'succeeded' | 'failed',
    error?: string,
  ): Promise<FinishOutcome> {
    const rows = await this.db.withoutTenant('job-queue-worker', (q) =>
      q.query<{ result: FinishOutcome }>(`SELECT public.finish_job($1, $2, $3, $4) AS result`, [
        jobId,
        this.workerId,
        outcome,
        // §16: the queue is durable storage and a failure message is written by whatever threw.
        // Bounded here so a stack trace carrying a connection string cannot be stored whole.
        error === undefined ? null : error.slice(0, 2000),
      ]),
    );
    const result = rows[0]?.result ?? null;
    if (result === 'dead') {
      // §17 and ADR-0003: a job that exhausted its attempts must not disappear quietly.
      this.logger.error(
        `job ${jobId} is dead after exhausting its attempts: ${error ?? 'no reason given'}`,
      );
    }
    if (result === 'failed') {
      // Denemesi kalmıştı ama yeniden kuyruğa alınamadı: ardılı zaten kuyrukta. Ölü değil, ama
      // sessiz de değil — bu tur kaybedildi, ve neyi kaybettiğini yalnız burası söylüyor.
      this.logger.warn(
        `job ${jobId} was not retried because a successor of its kind is already queued: ` +
          `${error ?? 'no reason given'}`,
      );
    }
    return result;
  }

  /**
   * Run `work` while holding an advisory lock on a named resource, or refuse.
   *
   * §17 requires this for administrative operations that would otherwise split-brain — creating a
   * pool, changing a disk's role, starting a resilver, publishing Samba configuration. The lock is
   * transaction-scoped, so a caller that crashes cannot hold it forever, and `try` rather than the
   * blocking form: a caller that queues is a caller holding a connection open on the guess that the
   * other operation will finish, when the useful answer is "something else is already working on
   * this".
   */
  async withResourceLock<T>(
    namespace: number,
    resource: string,
    work: () => Promise<T>,
  ): Promise<{ acquired: true; value: T } | { acquired: false }> {
    return this.db.withoutTenant('job-queue-worker', async (q) => {
      const rows = await q.query<{ locked: boolean }>(
        `SELECT public.try_lock_resource($1, $2) AS locked`,
        [namespace, resource],
      );
      if (rows[0]?.locked !== true) return { acquired: false };
      return { acquired: true, value: await work() };
    });
  }

  // ─── history retention ──────────────────────────────────────────────────────

  /**
   * Put the next sweep on the queue, or leave the one that is already there.
   *
   * `ON CONFLICT DO NOTHING` against `job_queue_one_scheduled_jobs_prune` (migration 0058), the
   * same shape the reconciliation and drain chains use: without something to conflict WITH, every
   * restart would leave one more copy behind.
   */
  async schedulePrune(organizationId: string, runAfter: Date): Promise<void> {
    await this.db.withTenant(organizationId, (q) =>
      q.query(
        `INSERT INTO public.job_queue (organization_id, kind, payload, run_after, max_attempts)
         VALUES ($1, $2, '{}'::jsonb, $3, 3)
         ON CONFLICT DO NOTHING`,
        [organizationId, JobsService.PRUNE_KIND, runAfter],
      ),
    );
  }

  /** Bring the waiting sweep forward, for when a round hit its ceiling with rows still to go. */
  async hurryUpPrune(organizationId: string): Promise<void> {
    await this.db.withTenant(organizationId, (q) =>
      q.query(
        `UPDATE public.job_queue SET run_after = now()
          WHERE organization_id = $1 AND kind = $2 AND status = 'queued'`,
        [organizationId, JobsService.PRUNE_KIND],
      ),
    );
  }

  /**
   * Delete ONE BATCH of expired history rows, and say how many went.
   *
   * `finish_job` writes every completed job here and nothing ever removed one, while the drain
   * chain re-queues itself every five seconds: roughly seventeen thousand rows per tenant per day,
   * six million in a year. Nothing on any screen said so and there was no way to prune without a
   * terminal.
   *
   * ONE BATCH PER CALL, on purpose. ADR-0003 rules out the long transaction a single unbounded
   * DELETE would be on an appliance that has been running for a year — it would hold locks on the
   * table the jobs screen and the event stream both read, for minutes. The caller loops.
   *
   * `withTenant`, not a SECURITY DEFINER function: `depsis_app` already holds DELETE on this table
   * and its tenant policy already limits it to its own rows, so the sweep runs UNDER row level
   * security rather than around it.
   */
  async pruneHistory(organizationId: string, batch = JobsService.PRUNE_BATCH): Promise<number> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ id: string }>(
        `DELETE FROM public.job_history
           WHERE id IN (
             SELECT id FROM public.job_history
              WHERE organization_id = $1
                AND CASE
                      WHEN status IN ('dead', 'failed')
                        THEN finished_at < now() - make_interval(days => $2::integer)
                      ELSE finished_at < now() - make_interval(days => $3::integer)
                    END
              LIMIT $4
           )
         RETURNING id::text AS id`,
        [organizationId, JobsService.PRUNE_KEEP_TERMINAL_DAYS, JobsService.PRUNE_KEEP_DAYS, batch],
      ),
    );
    return rows.length;
  }
}
