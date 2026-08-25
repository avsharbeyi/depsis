import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentRequest, AgentResponse, AgentService } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import {
  BACKUP_TICK_KIND,
  BackupSchedulesService,
  type ScheduleInput,
} from './backup-schedules.service.js';

/**
 * A schedule that runs, prunes, and queues its successor — against a real PostgreSQL.
 *
 * The pure decisions (which snapshots die, when the next run is) are measured in
 * `backup-schedules.test.ts`, where they can be. What is measured HERE is the wiring, and the
 * wiring is where a scheduled backup fails in the way nobody notices: the chain stops, no job is
 * queued, and the only symptom is a snapshot that was never taken — which somebody finds out about
 * on the day they need it.
 *
 * Skipped unless `DEPSIS_TEST_DATABASE_URL` and `DEPSIS_TEST_OWNER_DATABASE_URL` point at a
 * migrated database.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];
const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

interface Behaviour {
  /** What `list_snapshots` reports. Unix seconds, as the agent sends them. */
  inventory?: { name: string; used_bytes: number; created_at: number }[];
  /** Make `create_snapshot` fail, as a full pool or a missing dataset would. */
  snapshotFails?: boolean;
  /** The dataset is gone: `zfs list` says so, and every recorded snapshot with it. */
  datasetMissing?: boolean;
  /** What `snapshot_entries` answers — the check that the snapshot actually opens. */
  entries?: AgentResponse;
}

function stubAgent(behaviour: Behaviour = {}): { agent: AgentService; calls: AgentRequest[] } {
  const calls: AgentRequest[] = [];
  const agent = {
    isAvailable: () => true,
    call: (request: AgentRequest): Promise<AgentResponse> => {
      calls.push(request);
      if (request.op === 'create_snapshot') {
        if (behaviour.snapshotFails === true) {
          return Promise.resolve<AgentResponse>({
            status: 'failed',
            reason: 'out of space on the pool',
          });
        }
        return Promise.resolve<AgentResponse>({
          status: 'snapshot',
          full_name: `${request.dataset}@${request.name}`,
        });
      }
      if (request.op === 'list_snapshots') {
        return Promise.resolve<AgentResponse>({
          status: 'snapshots',
          snapshots: behaviour.datasetMissing === true ? [] : (behaviour.inventory ?? []),
          missing: behaviour.datasetMissing === true,
        });
      }
      if (request.op === 'snapshot_entries') {
        return Promise.resolve<AgentResponse>(
          behaviour.entries ?? {
            status: 'listing',
            truncated: false,
            entries: [{ name: 'belgeler', directory: true, size: 0, modified_unix: 1_787_000_000 }],
          },
        );
      }
      if (request.op === 'destroy_snapshot') {
        return Promise.resolve<AgentResponse>({
          status: 'snapshot_destroyed',
          full_name: `${request.dataset}@${request.snapshot}`,
        });
      }
      return Promise.resolve<AgentResponse>({ status: 'ok', schema_version: 19 });
    },
  } as unknown as AgentService;
  return { agent, calls };
}

const INPUT: ScheduleInput = {
  dataset: 'tank/sched',
  label: 'Gecelik',
  cadence: 'daily',
  atHour: 3,
  atMinute: 0,
  weekday: null,
  keep: 2,
  // A local replication target, so the tick has a job to queue and the incremental base
  // has somewhere to show up.
  replicateTarget: 'yedek/sched',
  offsite: null,
  enabled: true,
};

describeDb('a scheduled backup', () => {
  let db: DbService;
  let owner: DbService;
  let org = '';
  let admin = '';

  function service(behaviour?: Behaviour): {
    schedules: BackupSchedulesService;
    calls: AgentRequest[];
  } {
    const { agent, calls } = stubAgent(behaviour);
    return {
      schedules: new BackupSchedulesService(db, agent, new JobsService(db)),
      calls,
    };
  }

  /** The `storage.replicate` job the tick queued, if any. */
  async function queuedReplication(): Promise<{
    base: string | null;
    snapshot: string;
    scheduleId: string;
  } | null> {
    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ payload: { base: string | null; snapshot: string; scheduleId: string } }>(
        `SELECT payload FROM job_queue
          WHERE organization_id = $1 AND kind = 'storage.replicate'
          ORDER BY created_at DESC LIMIT 1`,
        [org],
      ),
    );
    return rows[0]?.payload ?? null;
  }

  async function clearJobs(): Promise<void> {
    await owner.withoutTenant('migration-status', (q) =>
      q.query(`DELETE FROM job_queue WHERE organization_id = $1 AND kind = 'storage.replicate'`, [
        org,
      ]),
    );
  }

  /** Put the verification clock back so the next call picks this schedule up. */
  async function unverify(id: string): Promise<void> {
    await owner.withoutTenant('migration-status', (q) =>
      q.query(`UPDATE public.backup_schedules SET last_verified_at = NULL WHERE id = $1`, [id]),
    );
  }

  async function makeDue(id: string): Promise<void> {
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `UPDATE public.backup_schedules SET next_run_at = now() - interval '1 minute'
                WHERE id = $1`,
        [id],
      ),
    );
  }

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name) VALUES ('sched-a','Sched A')
         ON CONFLICT (slug) DO NOTHING`,
      );
      org =
        (
          await q.query<{ id: string }>(
            `SELECT id::text AS id FROM organizations WHERE slug = 'sched-a'`,
          )
        )[0]?.id ?? '';
      await q.query(`DELETE FROM backup_schedules WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM job_queue WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM users WHERE organization_id = $1`, [org]);
      admin =
        (
          await q.query<{ id: string }>(
            `INSERT INTO users (organization_id, username, role, password_hash)
             VALUES ($1,'sched-admin','admin','x') RETURNING id::text AS id`,
            [org],
          )
        )[0]?.id ?? '';
    });
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM backup_schedules WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM job_queue WHERE organization_id = $1`, [org]);
        // The verification test makes a share so the snapshot walk has somewhere to go; its
        // implicit grant and team have to come out first, both being ON DELETE RESTRICT.
        await q.query(`DELETE FROM folder_grants WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM shares WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM team_members WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM teams WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM users WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM organizations WHERE id = $1`, [org]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  it('queues its first tick as soon as a schedule exists', async () => {
    // Without this, a box whose chain had stopped would accept a new schedule and never run it —
    // and the user would find out on the day they needed the backup.
    const { schedules } = service();
    const created = await schedules.create(org, admin, INPUT);
    expect(created.label).toBe('Gecelik');

    const queued = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ kind: string }>(
        `SELECT kind FROM job_queue WHERE organization_id = $1 AND kind = $2 AND status = 'queued'`,
        [org, BACKUP_TICK_KIND],
      ),
    );
    expect(queued).toHaveLength(1);
  });

  it('queues exactly ONE tick however many times it is asked', async () => {
    // The partial unique index in migration 0032. Two ticks in the queue would run every schedule
    // twice on the same minute — two snapshots, and a pruning that counts them both.
    const { schedules } = service();
    await schedules.scheduleTick(org, new Date());
    await schedules.scheduleTick(org, new Date());
    const queued = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ id: string }>(
        `SELECT id::text AS id FROM job_queue
          WHERE organization_id = $1 AND kind = $2 AND status = 'queued'`,
        [org, BACKUP_TICK_KIND],
      ),
    );
    expect(queued).toHaveLength(1);
  });

  it('runs a due schedule, prunes only its own snapshots, and moves its clock forward', async () => {
    const rows = await service().schedules.list(org);
    const schedule = rows[0];
    expect(schedule).toBeDefined();
    if (schedule === undefined) return;
    await makeDue(schedule.id);

    // Four snapshots this schedule made and two it did not. `keep: 2` means the two oldest of its
    // OWN must go, and the hand-made ones must be left where they are.
    const { schedules, calls } = service({
      inventory: [
        { name: 'depsis-daily-20260820T030000Z', used_bytes: 1, created_at: 1_787_000_000 },
        { name: 'depsis-daily-20260821T030000Z', used_bytes: 1, created_at: 1_787_086_400 },
        { name: 'depsis-daily-20260822T030000Z', used_bytes: 1, created_at: 1_787_172_800 },
        { name: 'depsis-daily-20260823T030000Z', used_bytes: 1, created_at: 1_787_259_200 },
        { name: 'yukseltmeden-once', used_bytes: 1, created_at: 1_787_100_000 },
        { name: 'zfs-auto-snap_daily-2026-08-22', used_bytes: 1, created_at: 1_787_180_000 },
      ],
    });

    const { ran, failed } = await schedules.runDue(org, new Date());
    expect({ ran, failed }).toEqual({ ran: 1, failed: 0 });

    // It took one.
    const taken = calls.filter((call) => call.op === 'create_snapshot');
    expect(taken).toHaveLength(1);
    expect(taken[0]).toMatchObject({ dataset: 'tank/sched' });

    // And destroyed exactly the two oldest of its own, oldest first.
    const destroyed = calls
      .filter((call) => call.op === 'destroy_snapshot')
      .map((call) => (call as { snapshot: string }).snapshot);
    expect(destroyed).toEqual(['depsis-daily-20260820T030000Z', 'depsis-daily-20260821T030000Z']);
    // THE ASSERTION THAT MATTERS. A retention policy that reached past its own snapshots would be
    // data loss the user discovers months later, looking for the copy they took by hand.
    expect(destroyed).not.toContain('yukseltmeden-once');
    expect(destroyed).not.toContain('zfs-auto-snap_daily-2026-08-22');

    const after = (await schedules.list(org))[0];
    expect(after?.last_result).toBe('ok');
    expect(after?.last_run_at).not.toBeNull();
    expect(after?.next_run_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('records a failure and STILL moves the clock forward', async () => {
    // If a permanently failing schedule kept its due time in the past, it would be retried on
    // every tick for ever and the tick itself would stop making progress through the others.
    const rows = await service().schedules.list(org);
    const schedule = rows[0];
    if (schedule === undefined) return;
    await makeDue(schedule.id);

    const { schedules } = service({ snapshotFails: true });
    const { ran, failed } = await schedules.runDue(org, new Date());
    expect({ ran, failed }).toEqual({ ran: 0, failed: 1 });

    const after = (await schedules.list(org))[0];
    expect(after?.last_result).not.toBe('ok');
    expect(after?.last_result ?? '').toContain('failed');
    expect(after?.next_run_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('leaves a disabled schedule alone', async () => {
    const rows = await service().schedules.list(org);
    const schedule = rows[0];
    if (schedule === undefined) return;
    await makeDue(schedule.id);

    const { schedules, calls } = service();
    await schedules.update(org, schedule.id, { ...INPUT, enabled: false });
    // `update` recomputes the next run, so put it back in the past to prove the refusal is about
    // `enabled` and not about the clock.
    await makeDue(schedule.id);

    const { ran } = await schedules.runDue(org, new Date());
    expect(ran).toBe(0);
    expect(calls.filter((call) => call.op === 'create_snapshot')).toHaveLength(0);
  });

  it('sends incrementally from the last success, and fully again after a failure', async () => {
    // 0032 shipped without this and said so: every run was a FULL send. On a terabyte share that
    // is a terabyte a night, for ever. The base is the last snapshot that actually arrived.
    const rows = await service().schedules.list(org);
    const schedule = rows[0];
    if (schedule === undefined) return;

    // The test above left it disabled, and an earlier one left a job in the queue. Both are
    // cleared FIRST — reading a job an earlier test queued would have made this pass while
    // measuring nothing, which is exactly what it did the first time it was written.
    const first = service();
    await first.schedules.update(org, schedule.id, INPUT);
    await clearJobs();

    // First run: no base yet, so a full send. The job carries `base: null`.
    await makeDue(schedule.id);
    await first.schedules.runDue(org, new Date());
    const firstJob = await queuedReplication();
    expect(firstJob).not.toBeNull();
    expect(firstJob?.base).toBeNull();
    expect(firstJob?.scheduleId).toBe(schedule.id);

    // The job succeeded, so the handler records what arrived.
    const taken = String(firstJob?.snapshot);
    await first.schedules.recordReplicated(org, schedule.id, taken);

    // Second run: incremental from that snapshot.
    await makeDue(schedule.id);
    await clearJobs();
    await service().schedules.runDue(org, new Date());
    expect((await queuedReplication())?.base).toBe(taken);

    // A failure clears it, deliberately bluntly: after a broken send this side does not know what
    // the target holds, and an incremental stream that names a base the target does not have is
    // refused — so the next run, and the one after, would fail too.
    await first.schedules.recordReplicated(org, schedule.id, null);
    await makeDue(schedule.id);
    await clearJobs();
    await service().schedules.runDue(org, new Date());
    expect((await queuedReplication())?.base).toBeNull();
  });

  it('verifies that the newest snapshot actually opens, not just that a job said ok', async () => {
    // HICBIR ZAMAN GERI YUKLENMEMIS BIR YEDEK, YEDEK DEGILDIR. `last_result` says one thing: that
    // `zfs snapshot` did not error. Every failure in the test below it leaves that field saying
    // `ok`, which is why this check exists at all.
    const rows = await service().schedules.list(org);
    const schedule = rows[0];
    if (schedule === undefined) return;

    const inventory = [
      { name: 'depsis-daily-20260824T030000Z', used_bytes: 1, created_at: 1_787_000_000 },
      { name: 'depsis-daily-20260825T030000Z', used_bytes: 1, created_at: 1_787_086_400 },
    ];

    // The dataset is not a share, so the snapshot cannot be opened from here — and the sentence
    // SAYS that rather than claiming a check it did not make.
    await unverify(schedule.id);
    const outside = await service({ inventory }).schedules.verifyOne(org, new Date());
    expect(outside).toContain('depsis-daily-20260825T030000Z');
    expect(outside).toContain('paylaşım değil');

    // Now make it a share, so the agent's `.zfs/snapshot/<name>` walk is what answers.
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO shares (organization_id, name, dataset) VALUES ($1,'Yedekli',$2)
         ON CONFLICT DO NOTHING`,
        [org, INPUT.dataset],
      ),
    );

    await unverify(schedule.id);
    const opened = await service({ inventory }).schedules.verifyOne(org, new Date());
    expect(opened).toContain('açıldı');
    expect(opened).toContain('1 ');

    const after = (await service().schedules.list(org))[0];
    expect(after?.last_verified_at).not.toBeNull();
  });

  it('names each of the three ways a backup is silently useless', async () => {
    const rows = await service().schedules.list(org);
    const schedule = rows[0];
    if (schedule === undefined) return;
    const inventory = [
      { name: 'depsis-daily-20260825T030000Z', used_bytes: 1, created_at: 1_787_086_400 },
    ];

    // ONE: the dataset is gone, and the schedule's own record still says the last run succeeded.
    await unverify(schedule.id);
    expect(await service({ datasetMissing: true }).schedules.verifyOne(org, new Date())).toContain(
      'artık yok',
    );

    // TWO: the snapshot is there and will not open. On ZFS that is a mount which did not
    // materialise — and it reads as an empty folder to anything that does not check.
    await unverify(schedule.id);
    const refused = await service({
      inventory,
      entries: { status: 'refused', reason: 'refused by the path confinement' },
    }).schedules.verifyOne(org, new Date());
    expect(refused).toContain('AÇILAMADI');

    // THREE: it opens and is EMPTY. Sometimes legitimate; almost never for a backup, and calling
    // it "ok" would leave somebody believing they hold a copy of nothing.
    await unverify(schedule.id);
    const empty = await service({
      inventory,
      entries: { status: 'listing', truncated: false, entries: [] },
    }).schedules.verifyOne(org, new Date());
    expect(empty).toContain('BOŞ');

    // And the pool holding no snapshot of this schedule at all.
    await unverify(schedule.id);
    expect(await service({ inventory: [] }).schedules.verifyOne(org, new Date())).toContain(
      'görüntüsü yok',
    );
  });

  it('verifies at most one schedule a turn, and not one it just looked at', async () => {
    // A mount per schedule per tick would be pointless work every five minutes, and re-verifying
    // the one it just did would starve every other schedule for ever.
    const rows = await service().schedules.list(org);
    if (rows[0] === undefined) return;
    await unverify(rows[0].id);

    expect(await service({ inventory: [] }).schedules.verifyOne(org, new Date())).not.toBeNull();
    expect(await service({ inventory: [] }).schedules.verifyOne(org, new Date())).toBeNull();
  });

  it('removing a schedule does not remove what it took', async () => {
    const rows = await service().schedules.list(org);
    const schedule = rows[0];
    if (schedule === undefined) return;

    const { schedules, calls } = service();
    expect(await schedules.remove(org, schedule.id)).toBe(true);
    expect(await schedules.remove(org, schedule.id)).toBe(false);
    // Not one destroy. Removing a schedule means "stop taking new ones", not "throw away the
    // history" — and a button that meant both would take a user's whole backup history in a click.
    expect(calls.filter((call) => call.op === 'destroy_snapshot')).toHaveLength(0);
  });
});
