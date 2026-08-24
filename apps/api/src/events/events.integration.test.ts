import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { firstValueFrom, filter, take, timeout, toArray } from 'rxjs';

import { DbService } from '../db/db.service.js';
import { EventsService, type DepsisEvent } from './events.service.js';

/**
 * The event stream, against a real PostgreSQL.
 *
 * The thing worth measuring here is not that a subject emits. It is WHO each event reaches: a
 * member must never see a job, and a person must never see another person's upload. That is a
 * property of the fan-out reading real rows under real row-level security, so a fake database
 * would test the test.
 *
 * The other one is that a job which FINISHES is still reported. `finish_job` deletes the row from
 * `job_queue` and inserts it into `job_history`, so the single most important transition is the
 * one where the row leaves the table a poller would naturally watch.
 *
 * Skipped unless `DEPSIS_TEST_DATABASE_URL` and `DEPSIS_TEST_OWNER_DATABASE_URL` point at a
 * migrated database.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];
const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

/** Long enough for two poll ticks, short enough that a hang fails rather than hangs. */
const WAIT_MS = 15_000;

describeDb('the event stream', () => {
  let db: DbService;
  let owner: DbService;
  let events: EventsService;
  let org = '';
  let admin = '';
  let ayse = '';
  let veli = '';
  let share = '';

  /** Collect the first `count` events of a type, or fail. */
  const collect = (stream: ReturnType<EventsService['subscribe']>, type: string, count: number) =>
    firstValueFrom(
      stream.pipe(
        filter((event: DepsisEvent) => event.type === type),
        take(count),
        toArray(),
        timeout(WAIT_MS),
      ),
    );

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name) VALUES ('events-a','Events A')
         ON CONFLICT (slug) DO NOTHING`,
      );
      org =
        (
          await q.query<{ id: string }>(
            `SELECT id::text AS id FROM organizations WHERE slug = 'events-a'`,
          )
        )[0]?.id ?? '';

      await q.query(`DELETE FROM upload_sessions WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM job_queue WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM job_history WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM shares WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM users WHERE organization_id = $1`, [org]);

      const people = await q.query<{ username: string; id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1, 'ev-admin', 'admin', 'x'), ($1, 'ev-ayse', 'member', 'x'),
                ($1, 'ev-veli', 'member', 'x')
         RETURNING username, id::text AS id`,
        [org],
      );
      admin = people.find((r) => r.username === 'ev-admin')?.id ?? '';
      ayse = people.find((r) => r.username === 'ev-ayse')?.id ?? '';
      veli = people.find((r) => r.username === 'ev-veli')?.id ?? '';

      share =
        (
          await q.query<{ id: string }>(
            `INSERT INTO shares (organization_id, name, dataset)
             VALUES ($1, 'events', 'tank/depsis/events') RETURNING id::text AS id`,
            [org],
          )
        )[0]?.id ?? '';
    });

    events = new EventsService(db);
  });

  beforeEach(async () => {
    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(`DELETE FROM upload_sessions WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM job_queue WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM job_history WHERE organization_id = $1`, [org]);
    });
  });

  afterEach(() => {
    // Every test opens streams; the service holds a timer while any are open. Tearing it down
    // between tests stops one test's poller from delivering into the next one's subscription.
    events.onModuleDestroy();
    events = new EventsService(db);
  });

  afterAll(async () => {
    events?.onModuleDestroy();
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM upload_sessions WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM job_queue WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM job_history WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM shares WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM users WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM organizations WHERE id = $1`, [org]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  async function enqueue(kind: string): Promise<string> {
    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ id: string }>(
        `INSERT INTO job_queue (organization_id, kind) VALUES ($1, $2) RETURNING id::text AS id`,
        [org, kind],
      ),
    );
    return rows[0]?.id ?? '';
  }

  async function upload(userId: string, filename: string): Promise<string> {
    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ id: string }>(
        `INSERT INTO upload_sessions
           (organization_id, share_id, created_by, filename, staging_name, length_bytes)
         VALUES ($1, $2, $3, $4, $5, 100) RETURNING id::text AS id`,
        [org, share, userId, filename, `${filename}.part`],
      ),
    );
    return rows[0]?.id ?? '';
  }

  it('tells an administrator when a job appears', async () => {
    const stream = events.subscribe(org, admin, true, null);
    const waiting = collect(stream, 'job', 1);
    await enqueue('permissions.apply');

    const [event] = await waiting;
    expect((event?.data as { kind: string }).kind).toBe('permissions.apply');
    expect((event?.data as { status: string }).status).toBe('queued');
  }, 20_000);

  it('reports a job that FINISHED, which is the row that leaves job_queue', async () => {
    // `finish_job` deletes from `job_queue` and inserts into `job_history`. A poller that watched
    // only the queue would show every job progressing and none of them ever ending — which is the
    // exact failure this screen exists to prevent for `permissions.apply`.
    const id = await enqueue('identity.sync');
    const stream = events.subscribe(org, admin, true, null);
    const waiting = collect(stream, 'job', 1);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `UPDATE job_queue SET status='running', lease_until=now()+interval '1 min',
                        worker_id='t' WHERE id=$1`,
        [id],
      );
      await q.query(`SELECT public.finish_job($1, 't', 'succeeded', NULL)`, [id]);
    });

    const [event] = await waiting;
    expect((event?.data as { id: string }).id).toBe(id);
    expect((event?.data as { status: string }).status).toBe('succeeded');
    // Longer than vitest's 5s default: this one does two round trips before the poll can see
    // anything, and the poll itself is on a two-second tick.
  }, 20_000);

  it('never sends a job to a member', async () => {
    // `GET /jobs` is admin-only; a stream that widened that would be a leak with no endpoint to
    // blame it on. The administrator's stream is opened alongside as the control — without it, a
    // test that saw nothing could not tell "correctly withheld" from "the poller never ran".
    const memberStream = events.subscribe(org, ayse, false, null);
    const adminStream = events.subscribe(org, admin, true, null);

    const memberSaw: DepsisEvent[] = [];
    const subscription = memberStream.subscribe((e) => {
      if (e.type === 'job') memberSaw.push(e);
    });
    const adminWaiting = collect(adminStream, 'job', 1);

    await enqueue('permissions.apply');
    await adminWaiting;
    subscription.unsubscribe();

    expect(memberSaw).toEqual([]);
  }, 20_000);

  it('sends an upload only to the person who started it', async () => {
    const mine = events.subscribe(org, ayse, false, null);
    const theirs = events.subscribe(org, veli, false, null);

    const theirSaw: DepsisEvent[] = [];
    const subscription = theirs.subscribe((e) => {
      if (e.type === 'transfer') theirSaw.push(e);
    });
    const waiting = collect(mine, 'transfer', 1);

    await upload(ayse, 'gizli-rapor.pdf');
    const [event] = await waiting;
    subscription.unsubscribe();

    expect((event?.data as { filename: string }).filename).toBe('gizli-rapor.pdf');
    // A tenant-wide transfer feed would tell every member what every other member is uploading,
    // by filename. Veli must not have seen it.
    expect(theirSaw).toEqual([]);
  }, 20_000);

  it('carries a resume point a client can send back', async () => {
    const stream = events.subscribe(org, admin, true, null);
    const waiting = collect(stream, 'job', 1);
    await enqueue('storage.snapshot');
    const [event] = await waiting;

    // §14 asks for last-event-id. The id has to be something the server can turn back into a
    // watermark, which is what makes a dropped connection cost nothing.
    const millis = Number.parseInt(event?.id ?? '', 10);
    expect(Number.isSafeInteger(millis)).toBe(true);
    expect(millis).toBeGreaterThan(Date.now() - 60_000);
  }, 20_000);

  it('replays from a resume point instead of skipping what happened while it was gone', async () => {
    // The whole value of `Last-Event-ID`. A job that appeared while the connection was down must
    // arrive when it comes back.
    const before = new Date();
    await enqueue('permissions.apply');
    // A tick's worth of separation, so the row's `updated_at` is unambiguously after `before`.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const stream = events.subscribe(org, admin, true, before);
    const [event] = await collect(stream, 'job', 1);
    expect((event?.data as { kind: string }).kind).toBe('permissions.apply');
  }, 20_000);

  it('does no work while nobody is listening', async () => {
    // The reason the timer is reference-counted. An appliance with no open screen should make no
    // queries at all, and a poller that ran regardless would be thirty pointless transactions a
    // minute forever.
    expect(events.full).toBe(false);
    const stream = events.subscribe(org, admin, true, null);
    const subscription = stream.subscribe(() => undefined);
    subscription.unsubscribe();

    // Nothing observable to assert on from outside except that a later subscribe still works —
    // which is the property that matters: stopping must not leave the service unusable.
    const again = events.subscribe(org, admin, true, null);
    const waiting = collect(again, 'job', 1);
    await enqueue('identity.sync');
    await expect(waiting).resolves.toHaveLength(1);
  }, 20_000);
});
