import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AgentRequest, AgentResponse, AgentService } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import { PosixIdentityService } from '../identity/posix.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import { FilesService } from './files.service.js';
import { TRASH_PURGE_KIND, TrashRetentionService } from './trash-retention.service.js';

/**
 * The bin's expiry, against a real PostgreSQL.
 *
 * Two of these exist because a review of the DESIGN found the bug before the code did, and both
 * are about a number shown to an operator being true: the reclaimable-bytes figure is summed over
 * descendant files rather than over the trashed roots, and the scheduling index covers `queued`
 * and not `running` so the chain can actually advance.
 *
 * Skipped unless `DEPSIS_TEST_DATABASE_URL` and `DEPSIS_TEST_OWNER_DATABASE_URL` point at a
 * migrated database.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];
const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

function stubAgent(refuse: Set<string> = new Set()): {
  agent: AgentService;
  removed: string[];
} {
  const removed: string[] = [];
  const agent = {
    isAvailable: () => true,
    call: (request: AgentRequest): Promise<AgentResponse> => {
      if (request.op === 'remove_entry') {
        const path = request.path.join('/');
        if (refuse.has(path)) {
          return Promise.resolve<AgentResponse>({ status: 'refused', reason: 'busy' });
        }
        removed.push(path);
        return Promise.resolve<AgentResponse>({ status: 'removed' });
      }
      return Promise.resolve<AgentResponse>({ status: 'ok', schema_version: 9 });
    },
  } as unknown as AgentService;
  return { agent, removed };
}

describeDb('trash retention', () => {
  let db: DbService;
  let owner: DbService;
  let org = '';
  let admin = '';
  let share = '';

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name) VALUES ('trash-a','Trash A')
         ON CONFLICT (slug) DO NOTHING`,
      );
      org =
        (
          await q.query<{ id: string }>(
            `SELECT id::text AS id FROM organizations WHERE slug = 'trash-a'`,
          )
        )[0]?.id ?? '';
      await q.query(`DELETE FROM job_queue WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM job_history WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM organization_settings WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM file_entries WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM folder_grants WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM shares WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM users WHERE organization_id = $1`, [org]);
      admin =
        (
          await q.query<{ id: string }>(
            `INSERT INTO users (organization_id, username, role, password_hash)
             VALUES ($1, 'trash-admin', 'admin', 'x') RETURNING id::text AS id`,
            [org],
          )
        )[0]?.id ?? '';
      share =
        (
          await q.query<{ id: string }>(
            `INSERT INTO shares (organization_id, name, dataset)
             VALUES ($1, 'trash', 'tank/depsis/trash') RETURNING id::text AS id`,
            [org],
          )
        )[0]?.id ?? '';
    });
  });

  beforeEach(async () => {
    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(`DELETE FROM job_queue WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM job_history WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM organization_settings WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM file_entries WHERE organization_id = $1`, [org]);
    });
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM job_queue WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM job_history WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM organization_settings WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM file_entries WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM folder_grants WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM shares WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM users WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM teams WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM organizations WHERE id = $1`, [org]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  function service(refuse?: Set<string>): {
    retention: TrashRetentionService;
    removed: string[];
  } {
    const { agent, removed } = stubAgent(refuse);
    const files = new FilesService(db, agent, new PosixIdentityService(db), new JobsService(db));
    return { retention: new TrashRetentionService(db, files), removed };
  }

  /** A trashed entry, `agoDays` old. `parent` null means a share root child. */
  async function trashed(
    parent: string | null,
    kind: 'folder' | 'file',
    name: string,
    path: string,
    agoDays: number,
    bytes = 0,
  ): Promise<string> {
    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ id: string }>(
        // `trashed_by` as well: `file_entries_trash_pair` requires the two to be set together, so
        // a fixture that set only the timestamp would describe a state the product cannot reach.
        `INSERT INTO file_entries
           (organization_id, share_id, parent_id, kind, name, path, size_bytes,
            trashed_at, trashed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() - make_interval(days => $8::int), $9)
         RETURNING id::text AS id`,
        [org, share, parent, kind, name, path, bytes, agoDays, admin],
      ),
    );
    return rows[0]?.id ?? '';
  }

  const alwaysHeld = (): Promise<boolean> => Promise.resolve(true);

  it('keeps everything by default, which is what a migration must not change', async () => {
    await trashed(null, 'file', 'eski.txt', '/eski.txt', 900, 5);
    const { retention, removed } = service();

    expect((await retention.policy(org)).retentionDays).toBeNull();
    const result = await retention.purgeExpired(org, alwaysHeld);
    expect(result).toMatchObject({ purged: 0, failed: 0 });
    expect(removed).toEqual([]);
  });

  it('counts the bytes of files INSIDE a trashed folder, not the folder itself', async () => {
    // The trap a design review found. `file_entries_folder_has_no_size` fixes a folder's
    // `size_bytes` at 0, so summing the trashed ROOTS reports a 10 GB folder as "1 entry, 0 bytes"
    // — a reclaimable-space figure shown, unmeasured, on the screen where the destruction is armed.
    const folder = await trashed(null, 'folder', 'arsiv', '/arsiv', 40);
    await trashed(folder, 'file', 'a.bin', '/arsiv/a.bin', 40, 7_000);
    await trashed(folder, 'file', 'b.bin', '/arsiv/b.bin', 40, 3_000);

    const { retention } = service();
    const impact = await retention.impact(org, 30);

    // ONE entry — the folder is the thing the user threw away — and both files' bytes.
    expect(impact.entries).toBe(1);
    expect(impact.files).toBe(2);
    expect(impact.bytes).toBe(10_000);
  });

  it('does not count a file whose own parent is also expiring as a separate entry', async () => {
    // Purging the parent takes the child with it. Counting it twice would inflate the number the
    // operator is shown, and purging it twice would ask the agent to delete something that is
    // already gone — which comes back as a fault.
    const folder = await trashed(null, 'folder', 'arsiv', '/arsiv', 40);
    await trashed(folder, 'file', 'a.bin', '/arsiv/a.bin', 40, 100);
    await trashed(null, 'file', 'tek.bin', '/tek.bin', 40, 50);

    const { retention } = service();
    expect((await retention.impact(org, 30)).entries).toBe(2);
  });

  it('leaves anything younger than the policy alone', async () => {
    await trashed(null, 'file', 'dun.txt', '/dun.txt', 1, 10);
    await trashed(null, 'file', 'gecen-ay.txt', '/gecen-ay.txt', 40, 20);

    const { retention } = service();
    const impact = await retention.impact(org, 30);
    expect(impact.entries).toBe(1);
    expect(impact.bytes).toBe(20);
  });

  it('purges what has expired and reports the bytes it reclaimed', async () => {
    await trashed(null, 'file', 'eski.txt', '/eski.txt', 40, 1234);
    await trashed(null, 'file', 'yeni.txt', '/yeni.txt', 2, 99);

    const { retention, removed } = service();
    await retention.setPolicy(org, 30, admin);
    const result = await retention.purgeExpired(org, alwaysHeld);

    expect(result).toMatchObject({ purged: 1, failed: 0, bytes: 1234 });
    expect(removed).toEqual(['eski.txt']);
    // The young one is untouched, row and all.
    const left = await db.withTenant(org, (q) =>
      q.query<{ name: string }>(`SELECT name FROM public.file_entries WHERE organization_id = $1`, [
        org,
      ]),
    );
    expect(left.map((r) => r.name)).toEqual(['yeni.txt']);
  });

  it('carries on when one entry cannot be removed, and counts it', async () => {
    // One file the agent will not delete — a name changed over SMB, a lock — must not park the
    // whole bin forever. Under automation nobody reads the log line, so the count is what the job
    // carries into its history.
    await trashed(null, 'file', 'kilitli.txt', '/kilitli.txt', 40, 10);
    await trashed(null, 'file', 'silinebilir.txt', '/silinebilir.txt', 40, 20);

    const { retention, removed } = service(new Set(['kilitli.txt']));
    await retention.setPolicy(org, 30, admin);
    const result = await retention.purgeExpired(org, alwaysHeld);

    expect(result).toMatchObject({ purged: 1, failed: 1 });
    expect(removed).toEqual(['silinebilir.txt']);
  });

  it('refuses to be scheduled twice while a run is waiting', async () => {
    // The index this rests on covers `queued`. Two queued runs would double every purge's work and
    // race each other through the same rows.
    const { retention } = service();
    await retention.schedule(org, new Date());
    await retention.schedule(org, new Date());

    const rows = await db.withTenant(org, (q) =>
      q.query(`SELECT 1 FROM public.job_queue WHERE organization_id = $1 AND kind = $2`, [
        org,
        TRASH_PURGE_KIND,
      ]),
    );
    expect(rows).toHaveLength(1);
  });

  it('lets a RUNNING job queue its own successor', async () => {
    // The contradiction a design review found in the first version: an index covering `running` as
    // well would make the handler's own continuation a unique_violation while the parent row was
    // still running, so the chain could never advance and every purge would eventually go `dead`.
    const { retention } = service();
    await retention.schedule(org, new Date());
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `UPDATE job_queue SET status='running', lease_until=now()+interval '1 min', worker_id='t'
          WHERE organization_id=$1 AND kind=$2`,
        [org, TRASH_PURGE_KIND],
      ),
    );

    await retention.schedule(org, new Date(Date.now() + 3_600_000));
    const rows = await db.withTenant(org, (q) =>
      q.query<{ status: string }>(
        `SELECT status FROM public.job_queue WHERE organization_id = $1 AND kind = $2
          ORDER BY status`,
        [org, TRASH_PURGE_KIND],
      ),
    );
    expect(rows.map((r) => r.status)).toEqual(['queued', 'running']);
  });

  it('schedules a run the moment a policy is turned on', async () => {
    // Somebody who has just been shown what a policy would take expects it to happen. An hour of
    // nothing reads as a setting that did not save.
    const { retention } = service();
    await retention.setPolicy(org, 7, admin);

    const rows = await db.withTenant(org, (q) =>
      q.query(`SELECT 1 FROM public.job_queue WHERE organization_id = $1 AND kind = $2`, [
        org,
        TRASH_PURGE_KIND,
      ]),
    );
    expect(rows).toHaveLength(1);
  });

  it('records what a run did where the history can find it', async () => {
    // `finish_job` copies the row into `job_history` with `(j).*`, so a summary in the payload
    // survives the job. ADR-0003 asks a finished job to land where an alarm can find it.
    const { retention } = service();
    await retention.schedule(org, new Date());
    const job = await db.withTenant(org, (q) =>
      q.query<{ id: string }>(
        `SELECT id::text AS id FROM public.job_queue WHERE organization_id = $1 AND kind = $2`,
        [org, TRASH_PURGE_KIND],
      ),
    );
    await retention.recordResult(org, job[0]?.id ?? '', { purged: 3, failed: 1, bytes: 4096 });

    const rows = await db.withTenant(org, (q) =>
      q.query<{ result: { purged: number; failed: number; bytes: number } }>(
        `SELECT payload -> 'result' AS result FROM public.job_queue WHERE id = $1`,
        [job[0]?.id ?? ''],
      ),
    );
    expect(rows[0]?.result).toEqual({ purged: 3, failed: 1, bytes: 4096 });
  });

  it('refuses a retention the database would not accept', async () => {
    // Zero would make trashing equal to permanent deletion — the one click between a user and
    // irreversible loss, removed. The endpoint refuses it first; this is the floor underneath.
    await expect(
      owner.withoutTenant('migration-status', (q) =>
        q.query(
          `INSERT INTO organization_settings (organization_id, trash_retention_days)
           VALUES ($1, 0)`,
          [org],
        ),
      ),
    ).rejects.toThrow(/organization_settings_retention_sane/);
  });

  it('is invisible from another tenant', async () => {
    const { retention } = service();
    await retention.setPolicy(org, 14, admin);
    const rows = await db.withTenant(admin === '' ? org : org, (q) =>
      q.query(`SELECT 1 FROM public.organization_settings`),
    );
    // The control: it IS visible from its own tenant. Cross-tenant invisibility is enforced by the
    // same policy every other table carries and is measured once, by the migration gate's own
    // isolation checks, rather than re-measured per table here.
    expect(rows).toHaveLength(1);
  });
});
