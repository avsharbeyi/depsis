import { Injectable, Logger } from '@nestjs/common';
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

/** What `finish` did with the job, or null if the caller no longer held the lease. */
export type FinishOutcome = 'succeeded' | 'dead' | 'queued' | null;

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
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  /** Identifies this process in `worker_id`, so a lease can be traced to who holds it. */
  readonly workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;

  constructor(private readonly db: DbService) {}

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
}
