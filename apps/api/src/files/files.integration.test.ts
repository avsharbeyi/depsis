import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentService } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import {
  EntryNotFoundError,
  FilesService,
  InvalidNameError,
  NameTakenError,
} from './files.service.js';

/**
 * The file tree, against a real PostgreSQL.
 *
 * Everything here is the database's behaviour rather than this repository's logic, which is why a
 * fake would settle none of it: the partial unique indexes, the two different name normalisations,
 * `IS NOT DISTINCT FROM` at a share root, and row-level security keeping one tenant's tree out of
 * another's listing.
 *
 * Skipped unless `DEPSIS_TEST_DATABASE_URL` points at a migrated database. A gated test that
 * silently passes when its precondition is missing is worse than no test, so the skip is visible.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];

const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

/** The agent is not reached by any test here; every one of them is metadata only. */
const noAgent = {
  isAvailable: () => false,
  call: () => Promise.reject(new Error('no test here should call the agent')),
} as unknown as AgentService;

describeDb('the file tree, against a real PostgreSQL', () => {
  let db: DbService;
  let owner: DbService;
  let files: FilesService;
  let orgA = '';
  let orgB = '';
  let shareA = '';
  let userA = '';

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name)
         VALUES ('files-a','Files A'), ('files-b','Files B')
         ON CONFLICT (slug) DO NOTHING`,
      );
      const orgs = await q.query<{ slug: string; id: string }>(
        `SELECT slug, id::text AS id FROM organizations WHERE slug IN ('files-a','files-b')`,
      );
      orgA = orgs.find((r) => r.slug === 'files-a')?.id ?? '';
      orgB = orgs.find((r) => r.slug === 'files-b')?.id ?? '';

      // A user, because trashing records who did it.
      const users = await q.query<{ id: string }>(
        // `email_normalized` is GENERATED, so it is not written here — the schema derives it.
        `INSERT INTO users (organization_id, username, display_name)
         VALUES ($1, 'afiles', 'A')
         ON CONFLICT DO NOTHING
         RETURNING id::text AS id`,
        [orgA],
      );
      userA =
        users[0]?.id ??
        (
          await q.query<{ id: string }>(
            `SELECT id::text AS id FROM users WHERE organization_id = $1 LIMIT 1`,
            [orgA],
          )
        )[0]?.id ??
        '';
    });

    files = new FilesService(db, noAgent);
    shareA = (await files.defaultShare(orgA, 'files-a')).id;
  });

  afterAll(async () => {
    // Children before parents, and rows before organizations: every reference is ON DELETE
    // RESTRICT on purpose, so a teardown in the wrong order fails loudly rather than cascading
    // away metadata whose bytes still exist.
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM upload_sessions WHERE organization_id = ANY($1)`, [
          [orgA, orgB],
        ]);
        await q.query(
          `DELETE FROM file_entries WHERE organization_id = ANY($1) AND parent_id IS NOT NULL`,
          [[orgA, orgB]],
        );
        await q.query(`DELETE FROM file_entries WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM shares WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM users WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM organizations WHERE id = ANY($1)`, [[orgA, orgB]]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  it('creates a folder and lists it', async () => {
    const folder = await files.createFolder(orgA, shareA, null, 'Belgeler');
    expect(folder.kind).toBe('folder');

    const page = await files.list(orgA, shareA, null, null, 50);
    expect(page.items.map((i) => i.name)).toContain('Belgeler');
    expect(page.hasMore).toBe(false);
  });

  it('refuses a second entry with the same name, case-folded', async () => {
    // Two shares on one box are served over SMB, where clients are case-insensitive: 'Rapor' and
    // 'rapor' side by side are two files a Windows user cannot tell apart or address separately.
    await files.createFolder(orgA, shareA, null, 'Rapor');
    await expect(files.createFolder(orgA, shareA, null, 'rapor')).rejects.toBeInstanceOf(
      NameTakenError,
    );
    await expect(files.createFolder(orgA, shareA, null, 'RAPOR')).rejects.toBeInstanceOf(
      NameTakenError,
    );
  });

  it('allows names that differ only by accent, because uniqueness is not search', async () => {
    // The two normalisations are deliberately different columns. If uniqueness used the SEARCH
    // normaliser — which strips accents so a search for 'cagri' finds 'Çağrı' — then creating
    // 'Çağrı.txt' beside an existing 'Cagri.txt' would be refused, and the user would be told two
    // plainly different names are the same name.
    await files.createFolder(orgA, shareA, null, 'Cagri');
    const accented = await files.createFolder(orgA, shareA, null, 'Çağrı');
    expect(accented.name).toBe('Çağrı');
  });

  it('constrains the share root as well as a folder, which one index cannot do', async () => {
    // `UNIQUE (organization_id, parent_id, name_fold)` alone leaves the root unconstrained:
    // parent_id is NULL there and NULL is distinct from NULL, so every top level would accept
    // unlimited duplicates. The schema splits the index on the null for exactly this.
    const parent = await files.createFolder(orgA, shareA, null, 'Ust');
    await files.createFolder(orgA, shareA, parent.id, 'ayni');
    await expect(files.createFolder(orgA, shareA, parent.id, 'AYNI')).rejects.toBeInstanceOf(
      NameTakenError,
    );

    await files.createFolder(orgA, shareA, null, 'kokte');
    await expect(files.createFolder(orgA, shareA, null, 'KOKTE')).rejects.toBeInstanceOf(
      NameTakenError,
    );
  });

  it('frees the name when an entry is trashed, and can refuse a restore that would collide', async () => {
    const first = await files.createFolder(orgA, shareA, null, 'yeniden');
    await files.trash(orgA, first.id, userA);

    // The unique indexes are partial on `trashed_at IS NULL` precisely so this works: a user who
    // deleted `rapor.pdf` must be able to upload a new one without emptying the trash first.
    const second = await files.createFolder(orgA, shareA, null, 'yeniden');
    expect(second.id).not.toBe(first.id);

    // And the consequence, which is correct rather than unfortunate: restoring the old one now
    // collides, and saying so beats silently restoring it under a suffixed name.
    await expect(files.restore(orgA, first.id)).rejects.toBeInstanceOf(NameTakenError);
  });

  it('hides a trashed entry from listings but keeps its id', async () => {
    const folder = await files.createFolder(orgA, shareA, null, 'gidecek');
    await files.trash(orgA, folder.id, userA);

    const page = await files.list(orgA, shareA, null, null, 100);
    expect(page.items.map((i) => i.name)).not.toContain('gidecek');

    // The row survives, because a trashed file's id is still referenced by whatever linked to it.
    const still = await files.find(orgA, folder.id);
    expect(still.trashed_at).not.toBeNull();
  });

  it('renames and keeps the derived path in step', async () => {
    const folder = await files.createFolder(orgA, shareA, null, 'eski');
    const renamed = await files.rename(orgA, folder.id, 'yeni');
    expect(renamed.name).toBe('yeni');
    expect(renamed.path.endsWith('/yeni')).toBe(true);
  });

  it('refuses a name the agent would refuse, before a row exists', async () => {
    // A row the database accepts and openat2 rejects is a file that exists in one store and not
    // the other — the "two realities" this project forbids.
    for (const bad of ['..', 'a/b', '-rf', '.depsis', '']) {
      await expect(files.createFolder(orgA, shareA, null, bad)).rejects.toBeInstanceOf(
        InvalidNameError,
      );
    }
  });

  it("does not let one tenant see or address another tenant's tree", async () => {
    const mine = await files.createFolder(orgA, shareA, null, 'gizli');

    // Same id, other tenant. RLS makes the row invisible to the query, so the service cannot tell
    // "no such row" from "not yours" — and neither can the caller, which is the point: any
    // distinguishable answer here is an existence oracle.
    await expect(files.find(orgB, mine.id)).rejects.toBeInstanceOf(EntryNotFoundError);

    const shareB = await files.defaultShare(orgB, 'files-b');
    const theirPage = await files.list(orgB, shareB.id, null, null, 100);
    expect(theirPage.items.map((i) => i.name)).not.toContain('gizli');
  });

  it('pages with a cursor rather than an offset', async () => {
    const parent = await files.createFolder(orgA, shareA, null, 'sayfali');
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      await files.createFolder(orgA, shareA, parent.id, name);
    }

    const first = await files.list(orgA, shareA, parent.id, null, 2);
    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await files.list(orgA, shareA, parent.id, first.nextCursor, 2);
    expect(second.items).toHaveLength(2);
    // No overlap: an offset page would repeat or skip rows as soon as anything was inserted, which
    // on a NAS is continuously.
    const seen = new Set(first.items.map((i) => i.id));
    expect(second.items.some((i) => seen.has(i.id))).toBe(false);
  });

  it('makes a file findable by its search normalisation, accents and Turkish letters folded', async () => {
    await files.createFolder(orgA, shareA, null, 'Çağrı Işık Raporu');
    const hits = await db.withTenant(orgA, (q) =>
      q.query<{ name: string }>(
        `SELECT name FROM file_entries
          WHERE organization_id = $1 AND name_norm LIKE '%' || public.depsis_norm($2) || '%'`,
        [orgA, 'cagri isik'],
      ),
    );
    expect(hits.map((h) => h.name)).toContain('Çağrı Işık Raporu');
  });
});
