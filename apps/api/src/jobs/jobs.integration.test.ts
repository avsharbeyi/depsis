import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DbService } from '../db/db.service.js';
import { JobsService } from './jobs.service.js';

/**
 * The queue, against a real PostgreSQL.
 *
 * Every claim in ADR-0003 is a claim about what the DATABASE does under concurrency: that two
 * workers running the same statement take different rows, that an expired lease returns a job to
 * the pool, that a worker which lost its lease cannot write its result over the one that replaced
 * it. None of that can be checked with a fake — a fake would be a second implementation of the
 * behaviour being asserted.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];
const describeDb =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== ''
    ? describe
    : describe.skip;

const SLUG_A = 'jobsa';
const SLUG_B = 'jobsb';

describeDb('the job queue, against a real PostgreSQL', () => {
  let db: DbService;
  let owner: DbService;
  let jobs: JobsService;
  let orgA = '';
  let orgB = '';

  /** A second service instance, so two "workers" are genuinely distinct worker_ids. */
  let other: JobsService;

  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    db = new DbService(APP_URL ?? '');
    owner = new DbService(OWNER_URL ?? '');
    jobs = new JobsService(db);
    other = new JobsService(db);
    expect(jobs.workerId, 'two instances must be distinguishable').not.toBe(other.workerId);

    await owner.withoutTenant('migration-status', async (q) => {
      for (const slug of [SLUG_A, SLUG_B]) {
        await q.query('DELETE FROM public.organizations WHERE slug = $1', [slug]);
      }
      const [a] = await q.query<{ id: string }>(
        `INSERT INTO public.organizations (name, slug) VALUES ($1, $2) RETURNING id::text AS id`,
        ['Jobs A', SLUG_A],
      );
      const [b] = await q.query<{ id: string }>(
        `INSERT INTO public.organizations (name, slug) VALUES ($1, $2) RETURNING id::text AS id`,
        ['Jobs B', SLUG_B],
      );
      orgA = a?.id ?? '';
      orgB = b?.id ?? '';
    });
    expect(orgA).not.toBe('');
    expect(orgB).not.toBe('');
  });

  beforeEach(async () => {
    // Both tables, because a job that finished moved between them and residue in either would let
    // a later test claim a job it did not create.
    await owner.withoutTenant('migration-status', async (q) => {
      await q.query('DELETE FROM public.job_queue');
      await q.query('DELETE FROM public.job_history');
    });
  });

  afterAll(async () => {
    await owner.withoutTenant('migration-status', async (q) => {
      await q.query('DELETE FROM public.job_queue');
      await q.query('DELETE FROM public.job_history');
      await q.query('DELETE FROM public.organizations WHERE slug = ANY($1)', [[SLUG_A, SLUG_B]]);
    });
    await db.onModuleDestroy();
    await owner.onModuleDestroy();
  });

  it('hands the same job to exactly one of two workers claiming at once', async () => {
    // The whole reason SKIP LOCKED is here. Without it one claimant blocks on the other's row lock
    // and then takes the row it already saw — or, with a naive SELECT-then-UPDATE, both do.
    await jobs.enqueue(orgA, 'test.solo');

    const [first, second] = await Promise.all([
      jobs.claim(['test.solo']),
      other.claim(['test.solo']),
    ]);

    const winners = [first, second].filter((c) => c !== null);
    expect(winners, 'exactly one worker must get the job').toHaveLength(1);
  });

  it('gives ten jobs to two workers without either seeing a duplicate', async () => {
    for (let i = 0; i < 10; i++) await jobs.enqueue(orgA, 'test.many', { i });

    const claimed: string[] = [];
    for (let round = 0; round < 10; round++) {
      const pair = await Promise.all([jobs.claim(['test.many']), other.claim(['test.many'])]);
      for (const c of pair) if (c !== null) claimed.push(c.id);
    }

    expect(claimed).toHaveLength(10);
    expect(new Set(claimed).size, 'no job may be claimed twice').toBe(10);
  });

  it('claims only the kinds a worker says it can run', async () => {
    await jobs.enqueue(orgA, 'test.known');
    await jobs.enqueue(orgA, 'test.unknown');

    const first = await jobs.claim(['test.known']);
    expect(first?.kind).toBe('test.known');
    // The second call must find nothing, rather than picking up work this worker cannot do.
    expect(await jobs.claim(['test.known'])).toBeNull();
  });

  it('does not claim a job before its run_after', async () => {
    await jobs.enqueue(orgA, 'test.later', {}, { runAfter: new Date(Date.now() + 60_000) });
    expect(await jobs.claim(['test.later'])).toBeNull();
  });

  it('returns a crashed worker’s job to the queue when its lease expires', async () => {
    const id = await jobs.enqueue(orgA, 'test.crash');

    // A one-second lease stands in for a worker that stops heartbeating. Nothing marks it as
    // crashed; the lease simply runs out, which is the point — there is no restart hook to forget.
    const mine = await jobs.claim(['test.crash'], 1);
    expect(mine?.id).toBe(id);
    expect(await other.claim(['test.crash'], 1), 'not while the lease holds').toBeNull();

    await wait(1_200);

    const reclaimed = await other.claim(['test.crash'], 60);
    expect(reclaimed?.id, 'the expired lease must make it claimable again').toBe(id);
    // The attempt counter carries across, so a job that keeps killing its worker still runs out of
    // attempts rather than looping forever.
    expect(reclaimed?.attempt).toBe(2);
  });

  it('refuses a heartbeat from a worker that has lost the job', async () => {
    await jobs.enqueue(orgA, 'test.lost');
    const mine = await jobs.claim(['test.lost'], 1);
    // Extended by ONE second, not sixty. An earlier version of this test heartbeated for 60s and
    // then expected the lease to expire 1.2s later — it asserted the opposite of what it had just
    // asked for, and failed against a queue that was behaving correctly.
    expect(await jobs.heartbeat(mine?.id ?? '', 1), 'while held, it extends').toBe(true);

    await wait(1_400);
    const stolen = await other.claim(['test.lost'], 60);
    expect(stolen?.id).toBe(mine?.id);

    // The moment that matters: the original worker must not be able to extend a lease it no longer
    // holds, because that is when two workers would both believe they own the job.
    expect(await jobs.heartbeat(mine?.id ?? '', 1)).toBe(false);
    expect(await other.heartbeat(stolen?.id ?? '', 60)).toBe(true);
  });

  it('refuses a result from a worker that has lost the job', async () => {
    await jobs.enqueue(orgA, 'test.late');
    const mine = await jobs.claim(['test.late'], 1);
    await wait(1_200);
    const stolen = await other.claim(['test.late'], 60);

    // A late finish would otherwise overwrite the result of whoever legitimately reclaimed it.
    expect(await jobs.finish(mine?.id ?? '', 'succeeded')).toBeNull();
    expect(await other.finish(stolen?.id ?? '', 'succeeded')).toBe('succeeded');
  });

  it('moves a finished job to history, so it is in exactly one table', async () => {
    const id = await jobs.enqueue(orgA, 'test.done');
    const mine = await jobs.claim(['test.done']);
    expect(await jobs.finish(mine?.id ?? '', 'succeeded')).toBe('succeeded');

    const counts = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ in_queue: string; in_history: string }>(
        `SELECT (SELECT count(*) FROM job_queue   WHERE id = $1)::text AS in_queue,
                (SELECT count(*) FROM job_history WHERE id = $1)::text AS in_history`,
        [id],
      ),
    );
    expect(counts[0]).toEqual({ in_queue: '0', in_history: '1' });

    // And it is still findable, because a caller polling for the result should not see it vanish.
    const found = await jobs.find(orgA, id);
    expect(found?.status).toBe('succeeded');
  });

  it('retries a failure with backoff, then declares it dead rather than losing it', async () => {
    const id = await jobs.enqueue(orgA, 'test.flaky', {}, { maxAttempts: 2 });

    const first = await jobs.claim(['test.flaky']);
    expect(await jobs.finish(first?.id ?? '', 'failed', 'first go')).toBe('queued');

    // Backoff is real: the retry is not immediately claimable.
    expect(await jobs.claim(['test.flaky']), 'the retry must wait out its backoff').toBeNull();
    await owner.withoutTenant('migration-status', (q) =>
      q.query(`UPDATE job_queue SET run_after = now() WHERE id = $1`, [id]),
    );

    const second = await jobs.claim(['test.flaky']);
    expect(second?.attempt).toBe(2);
    expect(await jobs.finish(second?.id ?? '', 'failed', 'second go')).toBe('dead');

    const found = await jobs.find(orgA, id);
    expect(found?.status, 'a dead job must remain visible, not disappear').toBe('dead');
    expect(found?.lastError).toContain('second go');
  });

  it('reports progress through the heartbeat', async () => {
    const id = await jobs.enqueue(orgA, 'test.progress');
    await jobs.claim(['test.progress']);
    expect(await jobs.heartbeat(id, 60, 0.42)).toBe(true);
    expect((await jobs.find(orgA, id))?.progress).toBeCloseTo(0.42, 5);
  });

  it('keeps one tenant’s jobs invisible to another', async () => {
    const mine = await jobs.enqueue(orgA, 'test.tenant');
    expect((await jobs.find(orgA, mine))?.id).toBe(mine);
    // Indistinguishable from "no such job", which is the point: otherwise the endpoint tells a
    // caller which job ids exist elsewhere.
    expect(await jobs.find(orgB, mine)).toBeNull();
  });

  it('keeps a system job invisible to every tenant, while a worker can still run it', async () => {
    // organization_id NULL is the system's own work — a pool scrub belongs to nobody. `NULL =
    // current_organization_id()` is NULL rather than true, so the policy hides it from all tenants
    // instead of showing it to all of them, which is the mistake a nullable tenant column invites.
    const [row] = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ id: string }>(
        `INSERT INTO job_queue (organization_id, kind) VALUES (NULL, $1) RETURNING id::text AS id`,
        ['test.system'],
      ),
    );
    const id = row?.id ?? '';
    expect(id).not.toBe('');

    expect(await jobs.find(orgA, id)).toBeNull();
    expect(await jobs.find(orgB, id)).toBeNull();

    const claimed = await jobs.claim(['test.system']);
    expect(claimed?.id, 'the worker is not a tenant and must still see it').toBe(id);
    expect(claimed?.organizationId).toBeNull();
  });

  it('refuses a second holder of the same resource lock', async () => {
    // §17. Two administrative operations on one resource is split-brain; `try` rather than the
    // blocking form so the caller is told, not queued.
    let innerSaw: boolean | null = null;

    const outer = await jobs.withResourceLock(42, 'tank', async () => {
      const inner = await other.withResourceLock(42, 'tank', () => Promise.resolve('ran'));
      innerSaw = inner.acquired;
      return 'outer ran';
    });

    expect(outer.acquired).toBe(true);
    expect(innerSaw, 'the second holder must be refused, not blocked').toBe(false);

    // And released with the transaction, so the next caller gets it.
    const after = await jobs.withResourceLock(42, 'tank', () => Promise.resolve('again'));
    expect(after.acquired).toBe(true);
  });

  it('lets different resources be locked at the same time', async () => {
    let innerSaw: boolean | null = null;
    await jobs.withResourceLock(42, 'tank', async () => {
      const inner = await other.withResourceLock(42, 'backup', () => Promise.resolve(1));
      innerSaw = inner.acquired;
    });
    expect(innerSaw).toBe(true);
  });

  it('refuses a running job with no lease at the schema', async () => {
    // The one shape that turns a crash into a permanently stuck row: not queued, so nothing picks
    // it up, and no deadline, so it never expires.
    await expect(
      owner.withoutTenant('migration-status', (q) =>
        q.query(
          `INSERT INTO job_queue (organization_id, kind, status) VALUES ($1, $2, 'running')`,
          [orgA, 'test.stuck'],
        ),
      ),
    ).rejects.toThrow(/job_running_has_lease/);
  });
});
