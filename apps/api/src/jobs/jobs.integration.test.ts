import { randomUUID } from 'node:crypto';
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
    //
    // SCOPED TO THIS SUITE'S ORGANISATIONS. It used to be an unqualified `DELETE FROM
    // public.job_queue`, and vitest runs test files concurrently against one database — so this
    // emptied every other suite's queue in the middle of their runs. A suite that enqueues a job
    // and then counts it to prove the enqueue happened would measure zero and fail on an assertion
    // about its own tenant. It was a race that had simply not lost yet; two slower tests added
    // elsewhere were enough to make it lose.
    await owner.withoutTenant('migration-status', async (q) => {
      await q.query('DELETE FROM public.job_queue WHERE organization_id = ANY($1)', [[orgA, orgB]]);
      await q.query('DELETE FROM public.job_history WHERE organization_id = ANY($1)', [
        [orgA, orgB],
      ]);
    });
  });

  afterAll(async () => {
    await owner.withoutTenant('migration-status', async (q) => {
      await q.query('DELETE FROM public.job_queue WHERE organization_id = ANY($1)', [[orgA, orgB]]);
      await q.query('DELETE FROM public.job_history WHERE organization_id = ANY($1)', [
        [orgA, orgB],
      ]);
      await q.query('DELETE FROM public.organizations WHERE slug = ANY($1)', [[SLUG_A, SLUG_B]]);
    });
    await db.onModuleDestroy();
    await owner.onModuleDestroy();
  });

  it('lists dead jobs, which is the only way anybody finds one', async () => {
    // A dead job is work the queue gave up on. For `permissions.apply` that means a permission
    // applied in the database and never on the filesystem — a folder the web reports as closed and
    // SMB keeps serving. ADR-0003 says the row "lands in history where an alarm can find it", and
    // until this listing existed nothing could: `GET /jobs/{jobId}` answers only to whoever still
    // holds the id, and the page that held it closed long before the job died.
    const id = await jobs.enqueue(orgA, 'test.doomed', {}, { maxAttempts: 1 });
    const claimed = await jobs.claim(['test.doomed']);
    expect(claimed?.id).toBe(id);
    expect(await jobs.finish(id, 'failed', 'nothing on the other end')).toBe('dead');

    // It has left `job_queue` for `job_history` by now, so a listing that read only the live table
    // would answer "no dead jobs" on an appliance full of them — the worst available answer.
    const dead = await jobs.list(orgA, ['dead'], 50);
    expect(dead.map((job) => job.id)).toContain(id);
    expect(dead.find((job) => job.id === id)?.lastError).toBe('nothing on the other end');

    // And the filter narrows rather than decorates.
    const queued = await jobs.list(orgA, ['queued'], 50);
    expect(queued.map((job) => job.id)).not.toContain(id);

    // No filter means everything, both tables included.
    expect((await jobs.list(orgA, [], 50)).map((job) => job.id)).toContain(id);
  });

  it('does not show one tenant the other tenant\u2019s jobs', async () => {
    // The listing reads two tables through `withTenant`, so RLS is what confines it — the same
    // property the single-job lookup has, asserted here because a listing is where a missing
    // policy would show up as somebody else's work appearing on an administrator's screen.
    const mine = await jobs.enqueue(orgA, 'test.mine');
    const theirs = await jobs.enqueue(orgB, 'test.theirs');

    const listed = (await jobs.list(orgA, [], 50)).map((job) => job.id);
    expect(listed).toContain(mine);
    expect(listed).not.toContain(theirs);
  });

  it('stops re-claiming a job whose worker keeps dying, and dead-letters it', async () => {
    // THE OPPOSITE FAILURE TO THE ONE `finish_job` GUARDS. A job that fails CLEANLY reaches
    // `finish_job`, which compares `attempt` to `max_attempts` and kills it. A job whose worker is
    // SIGKILLed, OOMs, or simply overruns its lease never reaches `finish_job` at all —
    // `WorkerService.execute` skips it when the lease is gone, and it must, because a late write
    // would overwrite the result of whoever legitimately took the job over.
    //
    // `claim_job`'s predicate did not look at `max_attempts`, so such a job was re-claimed without
    // bound: `attempt` climbed past the ceiling, `last_error` was never written, and the job
    // neither succeeded nor died. The worker takes one job at a time, so a job that kills its
    // worker starves everything behind it forever.
    //
    // A NEGATIVE lease is how the death is simulated: `lease_until` lands in the past, so the row
    // is immediately reclaimable — exactly the state a worker that died mid-job leaves behind,
    // without this test having to sleep through a real lease.
    const id = await jobs.enqueue(orgA, 'test.suicidal', {}, { maxAttempts: 3 });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = await jobs.claim(['test.suicidal'], -1);
      expect(claimed?.id, `attempt ${attempt} should still be claimable`).toBe(id);
      expect(claimed?.attempt).toBe(attempt);
      // No `finish` — the worker died holding it.
    }

    // The fourth claim must find nothing, and the job must be DEAD rather than a ghost sitting in
    // `job_queue` as `running` with a lease nobody holds. Both halves matter: the predicate alone
    // would leave the row unclaimable and unfinished forever, with `GET /jobs/{id}` reporting
    // "running" for good.
    expect(await jobs.claim(['test.suicidal'], -1)).toBeNull();

    const found = await jobs.find(orgA, id);
    expect(found?.status).toBe('dead');
    expect(found?.lastError).toMatch(/attempts are exhausted/);

    const left = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ n: string }>(`SELECT count(*)::text AS n FROM job_queue WHERE id = $1`, [id]),
    );
    expect(left[0]?.n).toBe('0');
  });

  it('does not reap a job another worker is still running', async () => {
    // The reaping step only takes rows whose lease has EXPIRED. Killing a job that is still being
    // worked on would do precisely what idempotency cannot cover for: two "finished" records for
    // one piece of work, one of them written by a process still running.
    const id = await jobs.enqueue(orgA, 'test.busy', {}, { maxAttempts: 1 });

    // One claim exhausts the budget, but the lease is live and this worker is still on it.
    const claimed = await jobs.claim(['test.busy'], 60);
    expect(claimed?.id).toBe(id);
    expect(claimed?.attempt).toBe(1);

    // Another worker sweeping for work must leave it alone.
    expect(await other.claim(['test.busy'], 60)).toBeNull();
    expect((await jobs.find(orgA, id))?.status).toBe('running');

    // And the holder can still finish it, which is the whole point of not reaping it.
    expect(await jobs.finish(id, 'succeeded')).toBe('succeeded');
  });

  it('keeps the first real error rather than overwriting it with the reaper\u2019s note', async () => {
    // A job can fail cleanly, be requeued, and THEN have its worker die. What an operator wants to
    // read is why it failed the first time, not that a process stopped — so the reaper only fills
    // `last_error` in when there is nothing there.
    const id = await jobs.enqueue(orgA, 'test.twoways', {}, { maxAttempts: 2 });

    const first = await jobs.claim(['test.twoways'], 60);
    expect(first?.id).toBe(id);
    expect(await jobs.finish(id, 'failed', 'the disk said no')).toBe('queued');

    // Requeued with a backoff, so bring it forward rather than waiting it out.
    await owner.withoutTenant('migration-status', (q) =>
      q.query(`UPDATE job_queue SET run_after = now() WHERE id = $1`, [id]),
    );

    // Second and last attempt, and this time the worker dies holding it.
    expect((await jobs.claim(['test.twoways'], -1))?.id).toBe(id);
    expect(await jobs.claim(['test.twoways'], -1)).toBeNull();

    const found = await jobs.find(orgA, id);
    expect(found?.status).toBe('dead');
    expect(found?.lastError).toBe('the disk said no');
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

  it('drops a chain turn instead of crashing when its successor is queued', async () => {
    // A self-scheduling handler queues its successor BEFORE doing the work — 0054 paid for that
    // ordering in the field, because a chain that only continues after a SUCCESSFUL turn stops
    // forever the first time three attempts burn out in a few seconds. Every such kind therefore
    // carries a partial unique index on `status = 'queued'`.
    //
    // `finish_job`'s retry branch set the RUNNING row back to `queued` as well, which is a second
    // row under that index: 23505, thrown out of `JobsService.finish` where nothing caught it, and
    // the worker process died. So a momentary agent restart cost two worker crashes and two
    // minutes of an idle queue.
    //
    // The index is created here rather than borrowed from `files.reconcile`, so this test cannot
    // race whatever another suite has on the queue.
    await owner.withoutTenant('migration-status', async (q) => {
      // Dropped first, so a run that was killed part-way through does not poison the next one.
      await q.query('DROP INDEX IF EXISTS public.test_one_scheduled_chain');
      await q.query(
        `CREATE UNIQUE INDEX test_one_scheduled_chain ON public.job_queue (organization_id, kind)
          WHERE kind = 'test.chain' AND status = 'queued'`,
      );
    });
    try {
      const id = await jobs.enqueue(orgA, 'test.chain', {}, { maxAttempts: 3 });
      expect((await jobs.claim(['test.chain']))?.id).toBe(id);

      // What the handler does on its first line.
      const successor = await jobs.enqueue(orgA, 'test.chain');

      // `failed`, not `dead`: the attempts were not exhausted, the turn simply could not be
      // re-queued. Blurring the two would blunt the one alarm ADR-0003 §17 asks for.
      expect(await jobs.finish(id, 'failed', 'the agent was restarting')).toBe('failed');

      const found = await jobs.find(orgA, id);
      expect(found?.status).toBe('failed');
      // Both halves of the story survive: what threw, and why it was not tried again.
      expect(found?.lastError).toContain('the agent was restarting');
      expect(found?.lastError).toContain('successor');

      // THE CHAIN IS INTACT. Losing the turn is the cost; losing the schedule would be the bug.
      expect((await jobs.find(orgA, successor))?.status).toBe('queued');

      // And it left the queue rather than sitting there as a `running` ghost nobody can reclaim.
      const left = await owner.withoutTenant('migration-status', (q) =>
        q.query<{ n: string }>(`SELECT count(*)::text AS n FROM job_queue WHERE id = $1`, [id]),
      );
      expect(left[0]?.n).toBe('0');
    } finally {
      await owner.withoutTenant('migration-status', (q) =>
        q.query('DROP INDEX IF EXISTS public.test_one_scheduled_chain'),
      );
    }
  });

  it('prunes expired history in batches, and keeps dead jobs far longer', async () => {
    // `finish_job` writes every completed job to `job_history` and nothing ever removed one, while
    // `files.index-drain` re-queues itself every five seconds: ~17,300 rows per tenant per day. A
    // box left on for a year carried six million of them, and the jobs screen and the event stream
    // both scan that table.
    //
    // The two retentions are deliberately different. ADR-0003 §17 keeps a dead job precisely so
    // "an alarm can find it", and a week is not long enough for that to be true.
    const seed = async (org: string, status: string, ageDays: number): Promise<string> => {
      const rows = await owner.withoutTenant('migration-status', (q) =>
        q.query<{ id: string }>(
          `INSERT INTO public.job_history
             (organization_id, kind, status, created_at, updated_at, finished_at)
           VALUES ($1, 'test.pruned', $2,
                   now() - make_interval(days => $3::integer),
                   now() - make_interval(days => $3::integer),
                   now() - make_interval(days => $3::integer))
           RETURNING id::text AS id`,
          [org, status, ageDays],
        ),
      );
      return rows[0]?.id ?? '';
    };

    const fresh = await seed(orgA, 'succeeded', 1);
    const stale = await seed(orgA, 'succeeded', 30);
    const recentlyDead = await seed(orgA, 'dead', 30);
    const longDead = await seed(orgA, 'dead', 200);
    const neighbour = await seed(orgB, 'succeeded', 30);

    // One batch at a time: a single unbounded DELETE over a year of backlog is the long
    // transaction ADR-0003 rules out, on the table two screens read.
    expect(await jobs.pruneHistory(orgA, 1), 'the batch size is a real ceiling').toBe(1);
    expect(await jobs.pruneHistory(orgA), 'the rest on the next pass').toBe(1);
    expect(await jobs.pruneHistory(orgA), 'and then there is nothing left to take').toBe(0);

    expect(await jobs.find(orgA, fresh), 'a week has not passed').not.toBeNull();
    expect(await jobs.find(orgA, stale), 'a month has').toBeNull();
    expect(await jobs.find(orgA, recentlyDead), 'a dead job outlives the rest').not.toBeNull();
    expect(await jobs.find(orgA, longDead), 'but not forever').toBeNull();
    // `withTenant`, so RLS is what confines the sweep — the other tenant's expired rows are not
    // this tenant's to delete.
    expect(await jobs.find(orgB, neighbour), 'one tenant must not prune another').not.toBeNull();
  });

  it('keeps exactly one scheduled prune per tenant, however often it is seeded', async () => {
    // The chain's own uniqueness (migration 0058), and the thing `ON CONFLICT DO NOTHING` needs to
    // conflict WITH: without it every restart would leave one more copy of the sweep behind.
    await jobs.schedulePrune(orgA, new Date());
    await jobs.schedulePrune(orgA, new Date());
    await jobs.schedulePrune(orgB, new Date());

    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM job_queue
          WHERE organization_id = $1 AND kind = 'jobs.prune' AND status = 'queued'`,
        [orgA],
      ),
    );
    expect(rows[0]?.n).toBe('1');
    // Per TENANT, not per box: the other organisation gets its own.
    const neighbour = await jobs.list(orgB, ['queued'], 50);
    expect(neighbour.some((job) => job.kind === 'jobs.prune')).toBe(true);
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

  it('cancels a queued job so no worker ever claims it', async () => {
    // §5.1. Yanlış klasöre başlatılmış bir kopyalamanın duracak yeri olmalı, ve "duracak" demek
    // satırın kuyruktan ÇIKMASI demek: bayrak bırakmak claim_job'a, heartbeat_job'a ve çöken
    // işçinin satırını toplayacak birine ayrı ayrı iş çıkarırdı.
    const id = await jobs.enqueue(orgA, 'test.cancel');
    expect(await jobs.cancel(orgA, id)).toBe(true);

    expect((await jobs.find(orgA, id))?.status).toBe('cancelled');
    expect(await jobs.claim(['test.cancel']), 'a cancelled job must never be claimed').toBeNull();
  });

  it('stops a RUNNING job at its next heartbeat', async () => {
    // İptalin çalışan iş üzerindeki mekanizması: satır gittiği için `heartbeat_job` false döner,
    // ve worker.service.ts'in sözleşmesinde false "dur" demektir — CopyService de tam olarak
    // bunu yapıyor, düğüm aralarında `report()` çağırıp döndüğü değere bakarak.
    const id = await jobs.enqueue(orgA, 'test.cancel.running');
    const claimed = await jobs.claim(['test.cancel.running']);
    expect(claimed?.id).toBe(id);
    expect(await jobs.heartbeat(id), 'the lease is live before the cancel').toBe(true);

    expect(await jobs.cancel(orgA, id)).toBe(true);
    expect(await jobs.heartbeat(id), 'false is the signal the handler stops on').toBe(false);
    // Ve geç gelen bir sonuç yazımı iptali ezmiyor: kira artık kimsede değil.
    expect(await jobs.finish(id, 'succeeded')).toBeNull();
    expect((await jobs.find(orgA, id))?.status).toBe('cancelled');
  });

  it('will not let one tenant cancel another’s job', async () => {
    const mine = await jobs.enqueue(orgA, 'test.cancel.tenant');
    // Aynı cevap: olmayan bir iş de false döner. Uç, hangi iş kimliklerinin var olduğunu söyleyen
    // bir kehanet hâline gelmemeli.
    expect(await jobs.cancel(orgB, mine)).toBe(false);
    expect((await jobs.find(orgA, mine))?.status).toBe('queued');
    // Bitmiş bir iş de iptal edilemez — kuyrukta satırı yok.
    expect(await jobs.cancel(orgA, randomUUID())).toBe(false);
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
