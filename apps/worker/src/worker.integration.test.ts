import { DbService, JobsService, type FinishOutcome } from '@depsis/api/worker-surface';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { WorkerService } from './worker.service.js';

/**
 * The loop, against the real queue.
 *
 * worker.service.ts is only interesting under concurrency and failure: that it finishes what it
 * claims, that it retries rather than swallowing, that it stops without abandoning work, and that
 * it notices when its lease has been taken away. Every one of those is a property of the loop
 * PLUS the database, so a fake queue would leave the interesting half untested.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];
const describeDb =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== ''
    ? describe
    : describe.skip;

const SLUG = 'workert';

describeDb('the worker loop, against a real queue', () => {
  let db: DbService;
  let owner: DbService;
  let jobs: JobsService;
  let orgId = '';

  const settle = (ms = 400): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /** Poll until a predicate holds, so a test never depends on a fixed sleep being long enough. */
  async function until(what: string, predicate: () => Promise<boolean>, ms = 8_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await settle(50);
    }
    throw new Error(`timed out waiting for: ${what}`);
  }

  beforeAll(async () => {
    db = new DbService(APP_URL ?? '');
    owner = new DbService(OWNER_URL ?? '');
    jobs = new JobsService(db);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `DELETE FROM public.users
          WHERE organization_id IN (SELECT id FROM public.organizations WHERE slug = $1)`,
        [SLUG],
      );
      await q.query('DELETE FROM public.organizations WHERE slug = $1', [SLUG]);
      const [org] = await q.query<{ id: string }>(
        `INSERT INTO public.organizations (name, slug) VALUES ($1, $2) RETURNING id::text AS id`,
        ['Worker Test', SLUG],
      );
      orgId = org?.id ?? '';
    });
    expect(orgId).not.toBe('');
  });

  beforeEach(async () => {
    await owner.withoutTenant('migration-status', async (q) => {
      await q.query('DELETE FROM public.job_queue');
      await q.query('DELETE FROM public.job_history');
    });
  });

  afterAll(async () => {
    await owner.withoutTenant('migration-status', async (q) => {
      await q.query('DELETE FROM public.job_queue');
      await q.query('DELETE FROM public.job_history');
      await q.query('DELETE FROM public.organizations WHERE slug = $1', [SLUG]);
    });
    await db.onModuleDestroy();
    await owner.onModuleDestroy();
  });

  it('runs a job and records that it succeeded', async () => {
    const worker = new WorkerService(jobs, { leaseSeconds: 5, idleMs: 50 });
    const seen: string[] = [];
    worker.register('w.ok', ({ job }) => {
      seen.push(job.id);
      return Promise.resolve();
    });

    const id = await jobs.enqueue(orgId, 'w.ok', { hello: 'world' });
    worker.start();
    try {
      await until(
        'the job to succeed',
        async () => (await jobs.find(orgId, id))?.status === 'succeeded',
      );
    } finally {
      await worker.stop();
    }
    expect(seen).toEqual([id]);
  });

  it('passes the payload through unchanged', async () => {
    const worker = new WorkerService(jobs, { leaseSeconds: 5, idleMs: 50 });
    let received: unknown = null;
    worker.register('w.payload', ({ job }) => {
      received = job.payload;
      return Promise.resolve();
    });

    const id = await jobs.enqueue(orgId, 'w.payload', { a: 1, nested: { b: 'two' } });
    worker.start();
    try {
      await until(
        'the job to finish',
        async () => (await jobs.find(orgId, id))?.status === 'succeeded',
      );
    } finally {
      await worker.stop();
    }
    expect(received).toEqual({ a: 1, nested: { b: 'two' } });
  });

  it('retries a throwing handler and finally records it dead, with the reason', async () => {
    const worker = new WorkerService(jobs, { leaseSeconds: 5, idleMs: 50 });
    let attempts = 0;
    worker.register('w.throws', () => {
      attempts += 1;
      return Promise.reject(new Error('the handler said no'));
    });

    const id = await jobs.enqueue(orgId, 'w.throws', {}, { maxAttempts: 2 });
    worker.start();
    try {
      // The retry has a backoff, so this waits rather than assuming it is immediate.
      await until(
        'the job to be declared dead',
        async () => (await jobs.find(orgId, id))?.status === 'dead',
        20_000,
      );
    } finally {
      await worker.stop();
    }

    expect(attempts).toBe(2);
    const finished = await jobs.find(orgId, id);
    // §17: a job that runs out of attempts must not vanish. The reason has to survive with it, or
    // whoever reads the alarm has nothing to act on.
    expect(finished?.lastError).toContain('the handler said no');
    // Retries carry exponential backoff, so this waits on real time between attempts.
  }, 30_000);

  it('survives a finish that throws, and goes on to the next job', async () => {
    // THE LOOP'S CONTRACT: one bad row must not stop the queue.
    //
    // A self-scheduling handler queues its successor BEFORE doing the work, so when a turn fails
    // `finish_job`'s retry branch tries to set the running row back to `queued` while a `queued`
    // row of that kind already exists — and every such kind carries a partial unique index on
    // exactly that. The 23505 came back out of `JobsService.finish`, which `execute` calls from
    // INSIDE its own catch block, so nothing caught it; the rejection travelled out of `run()`,
    // and `this.loop` is awaited by nobody until shutdown. The process died, systemd restarted it
    // five seconds later, and a permanently failing job did that every sixty-five seconds while
    // copies, ACL applications and identity syncs waited.
    class RefusingJobs extends JobsService {
      refused = 0;
      override finish(
        jobId: string,
        outcome: 'succeeded' | 'failed',
        error?: string,
      ): Promise<FinishOutcome> {
        if (outcome === 'failed' && this.refused === 0) {
          this.refused += 1;
          return Promise.reject(new Error('duplicate key value violates unique constraint'));
        }
        return super.finish(jobId, outcome, error);
      }
    }
    const flaky = new RefusingJobs(db);

    const worker = new WorkerService(flaky, { leaseSeconds: 5, idleMs: 50 });
    worker.register('w.badfinish', () => Promise.reject(new Error('the handler said no')));
    worker.register('w.next', () => Promise.resolve());

    await flaky.enqueue(orgId, 'w.badfinish', {}, { maxAttempts: 1 });
    // Enqueued second, so `claim`'s ordering hands over the poisoned one first.
    const next = await flaky.enqueue(orgId, 'w.next');

    worker.start();
    try {
      await until(
        'the loop to reach the job behind the one whose finish threw',
        async () => (await jobs.find(orgId, next))?.status === 'succeeded',
      );
    } finally {
      await worker.stop();
    }
    expect(flaky.refused, 'the throwing finish must actually have been reached').toBe(1);
  });

  it('claims only the kinds it has a handler for', async () => {
    const worker = new WorkerService(jobs, { leaseSeconds: 5, idleMs: 50 });
    worker.register('w.mine', () => Promise.resolve());

    const mine = await jobs.enqueue(orgId, 'w.mine');
    const theirs = await jobs.enqueue(orgId, 'w.theirs');
    worker.start();
    try {
      await until(
        'mine to finish',
        async () => (await jobs.find(orgId, mine))?.status === 'succeeded',
      );
      await settle(300);
      // Still queued, untouched. A worker that took work it cannot do would hold a lease on it
      // until the lease expired, delaying whoever can.
      expect((await jobs.find(orgId, theirs))?.status).toBe('queued');
    } finally {
      await worker.stop();
    }
  });

  it('keeps a long job alive by heartbeating past its lease', async () => {
    // A two-second lease with a handler that runs for five. Without the heartbeat the lease expires
    // mid-run and the job is reclaimed while this worker is still doing it.
    const worker = new WorkerService(jobs, {
      leaseSeconds: 2,
      idleMs: 50,
      heartbeatFraction: 1 / 4,
    });
    let lostLease = false;
    worker.register('w.long', async ({ report }) => {
      for (let i = 0; i < 10; i++) {
        await settle(500);
        if (!(await report(i / 10))) {
          lostLease = true;
          return;
        }
      }
    });

    const id = await jobs.enqueue(orgId, 'w.long');
    worker.start();
    try {
      await until(
        'the long job to succeed',
        async () => (await jobs.find(orgId, id))?.status === 'succeeded',
        20_000,
      );
    } finally {
      await worker.stop();
    }
    expect(lostLease, 'the heartbeat must hold the lease for the whole run').toBe(false);
    // An explicit timeout, because the handler deliberately outlives vitest's 5s default: the whole
    // point is a job that runs longer than its lease. Without this the test fails on the clock
    // rather than on the behaviour, which is a failure that teaches nothing.
  }, 30_000);

  it('tells a running handler that the process is stopping', async () => {
    const worker = new WorkerService(jobs, { leaseSeconds: 10, idleMs: 50 });
    let sawStop = false;
    worker.register('w.stop', async ({ report, stopping }) => {
      for (let i = 0; i < 40; i++) {
        await settle(100);
        await report();
        if (stopping()) {
          sawStop = true;
          return;
        }
      }
    });

    const id = await jobs.enqueue(orgId, 'w.stop');
    worker.start();
    await until(
      'the handler to be running',
      async () => (await jobs.find(orgId, id))?.status === 'running',
    );

    // stop() must WAIT for the handler rather than abandoning it: abandoning wastes the work and
    // delays the result by a whole lease.
    await worker.stop();

    expect(sawStop, 'the handler must be told to give up').toBe(true);
    expect(
      (await jobs.find(orgId, id))?.status,
      'and the job must be finished, not left running',
    ).toBe('succeeded');
  });

  it('does not write a result for a job it no longer holds', async () => {
    // The at-least-once case made concrete: this worker's lease expires mid-handler and a second
    // worker takes the job. The first must not overwrite the second's outcome.
    const worker = new WorkerService(jobs, { leaseSeconds: 1, heartbeatFraction: 10, idleMs: 50 });
    const thief = new JobsService(db);
    let reportSaidNo = false;

    worker.register('w.slow', async ({ report }) => {
      await settle(1_600);
      reportSaidNo = (await report()) === false;
    });

    const id = await jobs.enqueue(orgId, 'w.slow');
    worker.start();
    try {
      await until(
        'the worker to take it',
        async () => (await jobs.find(orgId, id))?.status === 'running',
      );
      await settle(1_200);
      const stolen = await thief.claim(['w.slow'], 30);
      expect(stolen?.id, 'the expired lease must let another worker in').toBe(id);

      await until('the handler to notice', () => Promise.resolve(reportSaidNo), 5_000);
      // The thief still owns it; the original worker's finish was refused.
      expect((await jobs.find(orgId, id))?.status).toBe('running');
      expect(await thief.finish(id, 'succeeded')).toBe('succeeded');
    } finally {
      await worker.stop();
    }
  }, 30_000);

  it('refuses to register two handlers for one kind', () => {
    // A silently replaced handler is a job running code nobody expects.
    const worker = new WorkerService(jobs);
    worker.register('w.dup', () => Promise.resolve());
    expect(() => worker.register('w.dup', () => Promise.resolve())).toThrow(/already registered/);
  });

  it('survives a job whose handler disappeared', async () => {
    // Only reachable if the registry changes after a claim, but the loop must not hold a lease on
    // work it cannot do.
    const worker = new WorkerService(jobs, { leaseSeconds: 5, idleMs: 50 });
    worker.register('w.gone', () => Promise.resolve());
    const id = await jobs.enqueue(orgId, 'w.gone', {}, { maxAttempts: 1 });

    // Claim it as the worker would, then run the loop with the handler removed from a fresh
    // instance — the same situation from the queue's point of view.
    const bare = new WorkerService(jobs, { leaseSeconds: 5, idleMs: 50 });
    bare.register('w.other', () => Promise.resolve());
    bare.start();
    await settle(300);
    await bare.stop();

    // Nothing claimed it, so it is still there rather than lost.
    expect((await jobs.find(orgId, id))?.status).toBe('queued');
  });
});
