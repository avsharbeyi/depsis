import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AgentRequest, AgentResponse, AgentService } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import { PosixIdentityService } from '../identity/posix.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import { FilesService } from './files.service.js';
import { IndexerService, RECONCILE_KIND } from './indexer.service.js';

/**
 * The reconciliation walk, against a real PostgreSQL and a fake filesystem.
 *
 * The agent's half — that a listing really reads a directory under `RESOLVE_BENEATH` and really
 * drops symlinks — is measured on the Rust side against a real kernel. What only this side can
 * measure is what the walk DECIDES: that an SMB write becomes a row, that a deleted file loses
 * one, that a clipped listing removes nothing, and that a trashed entry does not come back from
 * the dead every fifteen minutes.
 *
 * Skipped unless `DEPSIS_TEST_DATABASE_URL` and `DEPSIS_TEST_OWNER_DATABASE_URL` point at a
 * migrated database.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];
const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

/** A directory, as the fake disk holds it: path (share-relative, '/' joined) → entries. */
type Disk = Map<
  string,
  { entries: Array<{ name: string; directory: boolean; size: number }>; truncated?: boolean }
>;

function stubAgent(disk: Disk): AgentService {
  return {
    isAvailable: () => true,
    call: (request: AgentRequest): Promise<AgentResponse> => {
      if (request.op !== 'list_directory') {
        return Promise.resolve<AgentResponse>({ status: 'ok', schema_version: 10 });
      }
      const key = request.path.join('/');
      const found = disk.get(key);
      if (found === undefined) {
        return Promise.resolve<AgentResponse>({ status: 'not_found', reason: `${key}: gone` });
      }
      return Promise.resolve<AgentResponse>({
        status: 'listing',
        truncated: found.truncated ?? false,
        entries: found.entries.map((entry) => ({
          name: entry.name,
          directory: entry.directory,
          size: entry.size,
          // Fixed, so a second pass over an unchanged disk reports nothing changed.
          modified_unix: 1_700_000_000,
        })),
      });
    },
  } as unknown as AgentService;
}

describeDb('reconciling a share with the disk', () => {
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
        `INSERT INTO organizations (slug, name) VALUES ('index-a','Index A')
         ON CONFLICT (slug) DO NOTHING`,
      );
      org =
        (
          await q.query<{ id: string }>(
            `SELECT id::text AS id FROM organizations WHERE slug = 'index-a'`,
          )
        )[0]?.id ?? '';
      await q.query(`DELETE FROM job_queue WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM file_entries WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM folder_grants WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM shares WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM users WHERE organization_id = $1`, [org]);
      admin =
        (
          await q.query<{ id: string }>(
            `INSERT INTO users (organization_id, username, role, password_hash)
             VALUES ($1, 'index-admin', 'admin', 'x') RETURNING id::text AS id`,
            [org],
          )
        )[0]?.id ?? '';
      share =
        (
          await q.query<{ id: string }>(
            `INSERT INTO shares (organization_id, name, dataset)
             VALUES ($1, 'idx', 'tank/depsis/idx') RETURNING id::text AS id`,
            [org],
          )
        )[0]?.id ?? '';
    });
  });

  beforeEach(async () => {
    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(`DELETE FROM job_queue WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM file_entries WHERE organization_id = $1`, [org]);
    });
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM job_queue WHERE organization_id = $1`, [org]);
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

  function indexer(disk: Disk): IndexerService {
    const agent = stubAgent(disk);
    const files = new FilesService(db, agent, new PosixIdentityService(db), new JobsService(db));
    return new IndexerService(db, agent, files);
  }

  const held = (): Promise<boolean> => Promise.resolve(true);

  async function paths(): Promise<string[]> {
    const rows = await db.withTenant(org, (q) =>
      q.query<{ path: string }>(
        `SELECT path FROM public.file_entries WHERE organization_id = $1 AND trashed_at IS NULL
          ORDER BY path`,
        [org],
      ),
    );
    return rows.map((r) => r.path);
  }

  /** A row DEPSIS already knows about. */
  async function row(
    parent: string | null,
    kind: 'folder' | 'file',
    name: string,
    path: string,
    bytes = 0,
    trashed = false,
  ): Promise<string> {
    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ id: string }>(
        `INSERT INTO file_entries
           (organization_id, share_id, parent_id, kind, name, path, size_bytes,
            updated_at, trashed_at, trashed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp(1700000000),
                 CASE WHEN $8 THEN now() ELSE NULL END,
                 CASE WHEN $8 THEN $9::uuid ELSE NULL END)
         RETURNING id::text AS id`,
        [org, share, parent, kind, name, path, bytes, trashed, admin],
      ),
    );
    return rows[0]?.id ?? '';
  }

  it('writes a row for a file DEPSIS has never seen — the SMB write', async () => {
    // The acceptance criterion, in one test. Before this, a file created from Windows was invisible
    // to the web interface, to search and to the permission walk.
    const disk: Disk = new Map([
      ['', { entries: [{ name: 'windows.docx', directory: false, size: 4096 }] }],
    ]);

    const result = await indexer(disk).reconcile(org, share, held, 'test');
    expect(result).toMatchObject({ discovered: 1, removed: 0 });
    expect(await paths()).toEqual(['/windows.docx']);
  });

  it('walks into folders it discovers', async () => {
    const disk: Disk = new Map([
      ['', { entries: [{ name: 'proje', directory: true, size: 0 }] }],
      ['proje', { entries: [{ name: 'plan.xlsx', directory: false, size: 11 }] }],
    ]);

    const result = await indexer(disk).reconcile(org, share, held, 'test');
    expect(result.discovered).toBe(2);
    expect(await paths()).toEqual(['/proje', '/proje/plan.xlsx']);
  });

  it('changes nothing on a second pass over an unchanged disk', async () => {
    // The property that makes a fifteen-minute schedule bearable. A pass that "found" something
    // every time would rewrite every row forever and make `updated_at` meaningless.
    const disk: Disk = new Map([['', { entries: [{ name: 'a.txt', directory: false, size: 3 }] }]]);
    const service = indexer(disk);
    await service.reconcile(org, share, held, 'test');

    const again = await service.reconcile(org, share, held, 'test');
    expect(again).toMatchObject({ discovered: 0, updated: 0, removed: 0 });
  });

  it('removes a row whose file is gone from disk', async () => {
    await row(null, 'file', 'silinmis.txt', '/silinmis.txt', 5);
    const disk: Disk = new Map([['', { entries: [] }]]);

    const result = await indexer(disk).reconcile(org, share, held, 'test');
    expect(result.removed).toBe(1);
    expect(await paths()).toEqual([]);
  });

  it('removes a whole subtree when its folder is gone', async () => {
    const folder = await row(null, 'folder', 'eski', '/eski');
    await row(folder, 'file', 'a.txt', '/eski/a.txt', 3);
    // The share root lists nothing; `eski` itself is not listable either.
    const disk: Disk = new Map([['', { entries: [] }]]);

    const result = await indexer(disk).reconcile(org, share, held, 'test');
    expect(result.removed).toBe(2);
    expect(await paths()).toEqual([]);
  });

  it('removes NOTHING under a folder whose listing had to be clipped', async () => {
    // The one mistake this pass must never make. A truncated listing says nothing about the names
    // it did not report, so reconciling half a directory and deleting the rest of the rows would
    // destroy the index for a folder whose only crime is being large.
    await row(null, 'file', 'gorunmeyen.txt', '/gorunmeyen.txt', 5);
    const disk: Disk = new Map([
      ['', { truncated: true, entries: [{ name: 'baska.txt', directory: false, size: 1 }] }],
    ]);

    const result = await indexer(disk).reconcile(org, share, held, 'test');
    expect(result.truncated).toBe(1);
    expect(result.removed).toBe(0);
    // The new one is still learned about — a clipped listing is incomplete, not wrong.
    expect(await paths()).toEqual(['/baska.txt', '/gorunmeyen.txt']);
  });

  it('does not resurrect a trashed entry whose bytes are still on disk', async () => {
    // The subtle one. The trash is a COLUMN, not a folder, so a trashed file's bytes are still
    // exactly where they were. A pass that counted trashed rows as missing would create a second
    // row for something the user has already deleted, and the bin would refill itself every
    // fifteen minutes.
    await row(null, 'file', 'atilan.txt', '/atilan.txt', 9, true);
    const disk: Disk = new Map([
      ['', { entries: [{ name: 'atilan.txt', directory: false, size: 9 }] }],
    ]);

    const result = await indexer(disk).reconcile(org, share, held, 'test');
    expect(result.discovered).toBe(0);
    expect(await paths()).toEqual([]);

    const all = await db.withTenant(org, (q) =>
      q.query(`SELECT 1 FROM public.file_entries WHERE organization_id = $1`, [org]),
    );
    expect(all).toHaveLength(1);
  });

  it('updates a row whose file grew', async () => {
    await row(null, 'file', 'buyuyen.log', '/buyuyen.log', 100);
    const disk: Disk = new Map([
      ['', { entries: [{ name: 'buyuyen.log', directory: false, size: 900 }] }],
    ]);

    const result = await indexer(disk).reconcile(org, share, held, 'test');
    expect(result).toMatchObject({ updated: 1, discovered: 0, removed: 0 });
    const rows = await db.withTenant(org, (q) =>
      q.query<{ size_bytes: string }>(
        `SELECT size_bytes::text AS size_bytes FROM public.file_entries WHERE organization_id = $1`,
        [org],
      ),
    );
    expect(rows[0]?.size_bytes).toBe('900');
  });

  it('replaces a row whose kind no longer matches the disk', async () => {
    // Somebody deleted the file over SMB and made a directory with the same name. The row
    // describes something that does not exist; the disk is the authority.
    await row(null, 'file', 'rapor', '/rapor', 12);
    const disk: Disk = new Map([
      ['', { entries: [{ name: 'rapor', directory: true, size: 0 }] }],
      ['rapor', { entries: [{ name: 'ic.txt', directory: false, size: 4 }] }],
    ]);

    const result = await indexer(disk).reconcile(org, share, held, 'test');
    expect(result.removed).toBe(1);
    expect(result.discovered).toBe(2);
    const kinds = await db.withTenant(org, (q) =>
      q.query<{ kind: string; path: string }>(
        `SELECT kind, path FROM public.file_entries WHERE organization_id = $1 ORDER BY path`,
        [org],
      ),
    );
    expect(kinds).toEqual([
      { kind: 'folder', path: '/rapor' },
      { kind: 'file', path: '/rapor/ic.txt' },
    ]);
  });

  it('never asks the agent to delete anything', async () => {
    // What makes an unattended schedule safe. A row goes from the DATABASE because the file is
    // already gone; there is no path from this class to a destructive agent operation.
    const seen: string[] = [];
    const disk: Disk = new Map([['', { entries: [] }]]);
    await row(null, 'file', 'yok.txt', '/yok.txt', 1);

    const agent = {
      isAvailable: () => true,
      call: (request: AgentRequest): Promise<AgentResponse> => {
        seen.push(request.op);
        return stubAgent(disk).call(request, 'r', 'c');
      },
    } as unknown as AgentService;
    const files = new FilesService(db, agent, new PosixIdentityService(db), new JobsService(db));
    await new IndexerService(db, agent, files).reconcile(org, share, held, 'test');

    expect(seen).toEqual(['list_directory']);
  });

  it('stops when the lease is gone and says there is more to do', async () => {
    const disk: Disk = new Map([
      ['', { entries: [{ name: 'a', directory: true, size: 0 }] }],
      ['a', { entries: [] }],
    ]);
    let calls = 0;
    const report = (): Promise<boolean> => {
      calls += 1;
      return Promise.resolve(calls < 2);
    };
    const result = await indexer(disk).reconcile(org, share, report, 'test');
    expect(result.more).toBe(true);
  });

  it('refuses to be scheduled twice for one share, and allows a second share', async () => {
    // Migration 0024 is what makes `ON CONFLICT DO NOTHING` mean anything. Without it every boot
    // would leave another copy, and two passes over one share would race each other's writes.
    const service = indexer(new Map());
    await service.schedule(org, share, new Date());
    await service.schedule(org, share, new Date());

    const other =
      (
        await owner.withoutTenant('migration-status', (q) =>
          q.query<{ id: string }>(
            `INSERT INTO shares (organization_id, name, dataset)
             VALUES ($1, 'idx2', 'tank/depsis/idx2') RETURNING id::text AS id`,
            [org],
          ),
        )
      )[0]?.id ?? '';
    await service.schedule(org, other, new Date());

    const rows = await db.withTenant(org, (q) =>
      q.query(`SELECT 1 FROM public.job_queue WHERE organization_id = $1 AND kind = $2`, [
        org,
        RECONCILE_KIND,
      ]),
    );
    expect(rows).toHaveLength(2);

    await owner.withoutTenant('migration-status', (q) =>
      q.query(`DELETE FROM shares WHERE id = $1`, [other]),
    );
  });
});
