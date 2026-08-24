import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AgentRequest, AgentResponse, AgentService } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import { PosixIdentityService } from '../identity/posix.service.js';
import { CopyService, CopyTooLargeError, type CopyPayload } from './copy.service.js';
import { FilesService } from './files.service.js';
import { JobsService } from '../jobs/jobs.service.js';

/**
 * The copy walk, against a real PostgreSQL and a fake agent.
 *
 * The split is the one the rest of this repository draws: whether `copy_file` actually copies
 * bytes without overwriting anything is measured on the Rust side, against a real filesystem and a
 * real `renameat2`. What cannot be measured there is everything this suite is about — that folders
 * are created before their children, that a name collision resolves rather than fails, that a
 * redelivered chunk does not duplicate work, and that a copy which reached the filesystem but not
 * the database is recovered rather than lost.
 *
 * Skipped unless `DEPSIS_TEST_DATABASE_URL` and `DEPSIS_TEST_OWNER_DATABASE_URL` point at a
 * migrated database.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];
const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

interface Recorded {
  op: string;
  from?: string;
  to?: string;
}

/**
 * An agent that succeeds, and remembers what it was asked.
 *
 * `conflicts` names destination paths it should refuse, which is how the redelivery and recovery
 * paths are reached: a real agent answers `conflict` for a name that is already taken because
 * `RENAME_NOREPLACE` decides it in the kernel.
 */
function stubAgent(conflicts: Set<string> = new Set()): {
  agent: AgentService;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const agent = {
    isAvailable: () => true,
    call: (request: AgentRequest): Promise<AgentResponse> => {
      if (request.op === 'copy_file') {
        const to = request.to.join('/');
        calls.push({ op: request.op, from: request.from.join('/'), to });
        if (conflicts.has(to)) {
          return Promise.resolve<AgentResponse>({
            status: 'conflict',
            reason: `${to}: something is already there`,
          });
        }
        return Promise.resolve<AgentResponse>({ status: 'copied', bytes: 11 });
      }
      if (request.op === 'create_directory') {
        calls.push({ op: request.op, to: request.path.join('/') });
        return Promise.resolve<AgentResponse>({ status: 'directory_created' });
      }
      calls.push({ op: request.op });
      return Promise.resolve<AgentResponse>({ status: 'ok', schema_version: 8 });
    },
  } as unknown as AgentService;
  return { agent, calls };
}

describeDb('copying a tree', () => {
  let db: DbService;
  let owner: DbService;
  let org = '';
  let user = '';
  let share = '';
  let docs = '';
  let inner = '';
  let fileA = '';
  let fileB = '';
  let target = '';

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name) VALUES ('copy-a','Copy A')
         ON CONFLICT (slug) DO NOTHING`,
      );
      org =
        (
          await q.query<{ id: string }>(
            `SELECT id::text AS id FROM organizations WHERE slug = 'copy-a'`,
          )
        )[0]?.id ?? '';
      await q.query(`DELETE FROM file_entries WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM folder_grants WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM shares WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM users WHERE organization_id = $1`, [org]);
      user =
        (
          await q.query<{ id: string }>(
            `INSERT INTO users (organization_id, username, role, password_hash)
             VALUES ($1, 'copy-ayse', 'admin', 'x') RETURNING id::text AS id`,
            [org],
          )
        )[0]?.id ?? '';
      share =
        (
          await q.query<{ id: string }>(
            `INSERT INTO shares (organization_id, name, dataset)
             VALUES ($1, 'copy', 'tank/depsis/copy') RETURNING id::text AS id`,
            [org],
          )
        )[0]?.id ?? '';
    });
  });

  beforeEach(async () => {
    // A fresh tree per test: `docs/{a.txt, inner/{b.txt}}` and an empty `target/`.
    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(`DELETE FROM file_entries WHERE organization_id = $1`, [org]);
      const mk = async (
        parent: string | null,
        kind: 'folder' | 'file',
        name: string,
        path: string,
      ): Promise<string> => {
        const rows = await q.query<{ id: string }>(
          `INSERT INTO file_entries (organization_id, share_id, parent_id, kind, name, path, size_bytes)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text AS id`,
          [org, share, parent, kind, name, path, kind === 'file' ? 11 : 0],
        );
        return rows[0]?.id ?? '';
      };
      docs = await mk(null, 'folder', 'docs', '/docs');
      target = await mk(null, 'folder', 'target', '/target');
      fileA = await mk(docs, 'file', 'a.txt', '/docs/a.txt');
      inner = await mk(docs, 'folder', 'inner', '/docs/inner');
      fileB = await mk(inner, 'file', 'b.txt', '/docs/inner/b.txt');
    });
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
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

  function service(conflicts?: Set<string>): { copies: CopyService; calls: Recorded[] } {
    const { agent, calls } = stubAgent(conflicts);
    const posix = new PosixIdentityService(db);
    const files = new FilesService(db, agent, posix, new JobsService(db));
    return { copies: new CopyService(db, agent, files, posix), calls };
  }

  const payload = (sourceIds: string[], destinationId: string | null): CopyPayload => ({
    shareId: share,
    sourceIds,
    destinationId,
    actorId: user,
  });

  /** Run every chunk the operation needs, and return what happened in total. */
  async function runToCompletion(
    copies: CopyService,
    start: CopyPayload,
  ): Promise<{ copied: number; skipped: number; chunks: number }> {
    let current: CopyPayload | null = start;
    let copied = 0;
    let skipped = 0;
    let chunks = 0;
    while (current !== null && chunks < 50) {
      const result: Awaited<ReturnType<CopyService['copy']>> = await copies.copy(
        org,
        current,
        'test',
      );
      copied += result.copied;
      skipped += result.skipped;
      chunks += 1;
      current = result.next;
    }
    return { copied, skipped, chunks };
  }

  async function rowsUnder(parentId: string | null): Promise<string[]> {
    const rows = await db.withTenant(org, (q) =>
      q.query<{ name: string }>(
        `SELECT name FROM public.file_entries
          WHERE organization_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND trashed_at IS NULL
          ORDER BY name`,
        [org, parentId],
      ),
    );
    return rows.map((r) => r.name);
  }

  it('copies a single file and records a row for it', async () => {
    const { copies, calls } = service();
    const result = await copies.copy(org, payload([fileA], target), 'test');

    expect(result).toMatchObject({ copied: 1, skipped: 0, total: 1, next: null });
    expect(calls).toEqual([{ op: 'copy_file', from: 'docs/a.txt', to: 'target/a.txt' }]);
    expect(await rowsUnder(target)).toEqual(['a.txt']);
  });

  it('creates a folder before anything inside it', async () => {
    // The whole correctness of the walk. `CreateDirectory` refuses to `mkdir -p`, so a file whose
    // parent has not been made yet comes back `not_found` — the order is not a preference.
    const { copies, calls } = service();
    await runToCompletion(copies, payload([docs], target));

    const order = calls.map((c) => `${c.op} ${c.to ?? ''}`);
    expect(order.indexOf('create_directory target/docs')).toBeLessThan(
      order.indexOf('copy_file target/docs/a.txt'),
    );
    expect(order.indexOf('create_directory target/docs/inner')).toBeLessThan(
      order.indexOf('copy_file target/docs/inner/b.txt'),
    );
  });

  it('reproduces the whole tree under the destination', async () => {
    const { copies } = service();
    const { copied } = await runToCompletion(copies, payload([docs], target));

    // docs + a.txt + inner + b.txt
    expect(copied).toBe(4);
    expect(await rowsUnder(target)).toEqual(['docs']);

    const copiedDocs = await db.withTenant(org, (q) =>
      q.query<{ id: string }>(
        `SELECT id::text AS id FROM public.file_entries WHERE path = '/target/docs'`,
      ),
    );
    const docsId = copiedDocs[0]?.id ?? '';
    expect(await rowsUnder(docsId)).toEqual(['a.txt', 'inner']);
  });

  it('resolves a name collision instead of failing or overwriting', async () => {
    // `keep_both`, the contract's default and the only policy served. The destination already
    // holds `a.txt`, and the copy must land beside it rather than on top of it.
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO file_entries (organization_id, share_id, parent_id, kind, name, path, size_bytes)
         VALUES ($1, $2, $3, 'file', 'a.txt', '/target/a.txt', 5)`,
        [org, share, target],
      ),
    );

    const { copies, calls } = service();
    await copies.copy(org, payload([fileA], target), 'test');

    expect(calls[0]?.to).toBe('target/a (2).txt');
    expect(await rowsUnder(target)).toEqual(['a (2).txt', 'a.txt']);
  });

  it('does not copy anything twice when a chunk is redelivered', async () => {
    // At-least-once, which the queue guarantees and §17 requires the handler to absorb. The agent
    // refuses the second attempt because the name is taken, and that refusal has to read as "done"
    // rather than as a failure.
    const { copies } = service(new Set(['target/a.txt']));
    const first = await copies.copy(org, payload([fileA], target), 'test');
    expect(first.copied).toBe(1);

    // The same payload again, with no `doneIds` — a redelivery of the very first chunk.
    const again = await copies.copy(org, payload([fileA], target), 'test');
    expect(again).toMatchObject({ copied: 0, skipped: 1 });
    expect(await rowsUnder(target)).toEqual(['a.txt']);
  });

  it('recovers a copy that reached the filesystem and not the database', async () => {
    // The one window the design cannot close: the worker dies between `copy_file` and the INSERT.
    // The bytes are on disk under the user's chosen name, readable over SMB, and invisible to
    // DEPSIS forever unless the retry notices. The agent's `conflict` is the only signal there is.
    const { copies } = service(new Set(['target/a.txt']));
    const result = await copies.copy(org, payload([fileA], target), 'test');

    expect(result.copied).toBe(1);
    expect(await rowsUnder(target)).toEqual(['a.txt']);
  });

  it('chunks a tree larger than one job', async () => {
    // 30 files against a chunk of 25: two jobs, and the second must pick up where the first left
    // off rather than starting again.
    await owner.withoutTenant('migration-status', async (q) => {
      for (let n = 0; n < 30; n += 1) {
        await q.query(
          `INSERT INTO file_entries (organization_id, share_id, parent_id, kind, name, path, size_bytes)
           VALUES ($1, $2, $3, 'file', $4, $5, 3)`,
          [org, share, inner, `f${n}.txt`, `/docs/inner/f${n}.txt`],
        );
      }
    });

    const { copies } = service();
    const { copied, chunks } = await runToCompletion(copies, payload([docs], target));

    // docs + a.txt + inner + b.txt + 30
    expect(copied).toBe(34);
    expect(chunks).toBeGreaterThan(1);
  });

  it('refuses a selection larger than it will attempt', async () => {
    // A refusal rather than a performance bound. Somebody selecting the share root should be told
    // the number, not discover it as a full dataset an hour later.
    const { copies } = service();
    const original = CopyService.MAX_ENTRIES;
    Object.defineProperty(CopyService, 'MAX_ENTRIES', { value: 2, configurable: true });
    try {
      await expect(copies.copy(org, payload([docs], target), 'test')).rejects.toBeInstanceOf(
        CopyTooLargeError,
      );
    } finally {
      Object.defineProperty(CopyService, 'MAX_ENTRIES', {
        value: original,
        configurable: true,
      });
    }
  });

  it('copies into the share root when no destination is named', async () => {
    const { copies, calls } = service();
    await copies.copy(org, payload([fileB], null), 'test');
    expect(calls[0]).toEqual({ op: 'copy_file', from: 'docs/inner/b.txt', to: 'b.txt' });
    expect(await rowsUnder(null)).toContain('b.txt');
  });
});
