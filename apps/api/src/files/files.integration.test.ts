import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentService } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import {
  EntryNotFoundError,
  FilesService,
  InvalidNameError,
  NameTakenError,
  TrashedParentError,
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
  let shareB = '';
  let userA = '';
  let userB = '';

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

      // A user per organisation, because trashing records who did it — and the trash tests below
      // run in the second tenant, whose bin no other test writes to.
      const seedUser = async (organizationId: string, username: string): Promise<string> => {
        // `email_normalized` is GENERATED, so it is not written here — the schema derives it.
        const inserted = await q.query<{ id: string }>(
          `INSERT INTO users (organization_id, username)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING
           RETURNING id::text AS id`,
          [organizationId, username],
        );
        return (
          inserted[0]?.id ??
          (
            await q.query<{ id: string }>(
              `SELECT id::text AS id FROM users WHERE organization_id = $1 AND username = $2`,
              [organizationId, username],
            )
          )[0]?.id ??
          ''
        );
      };
      userA = await seedUser(orgA, 'afiles');
      userB = await seedUser(orgB, 'bfiles');
    });

    files = new FilesService(db, noAgent);
    shareA = (await files.defaultShare(orgA, 'files-a')).id;
    shareB = (await files.defaultShare(orgB, 'files-b')).id;
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

    const theirPage = await files.list(orgB, shareB, null, null, 100);
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

  // ─── the trash ──────────────────────────────────────────────────────────────
  //
  // These run in the SECOND tenant. The trash is share-wide by nature — it has no parent to scope
  // it to — so a test that asserted anything about page contents in the first tenant would depend
  // on which other tests had run, and the suite is required to be order-independent.

  it('lists what is in the trash and leaves what is not out of it', async () => {
    const kept = await files.createFolder(orgB, shareB, null, 'cop-kalan');
    const thrown = await files.createFolder(orgB, shareB, null, 'cop-atilan');
    await files.trash(orgB, thrown.id, userB);

    const bin = await files.listTrash(orgB, shareB, null, 100);
    const ids = bin.items.map((i) => i.id);
    expect(ids).toContain(thrown.id);
    expect(ids).not.toContain(kept.id);
    // Every row in the bin really is in the bin — the filter is on `trashed_at`, and a listing
    // that leaked a live row would be a user staring at a file they can still see in its folder.
    expect(bin.items.every((i) => i.trashed_at !== null)).toBe(true);
  });

  it('pages the trash by (trashed_at, id), which a timestamp alone cannot do', async () => {
    // Emptying a folder trashes many rows in ONE statement, and `now()` is fixed for a whole
    // transaction — so these four share a `trashed_at` to the microsecond. A cursor keyed on the
    // timestamp alone would, at a page boundary inside this batch, either repeat the batch or skip
    // the rest of it. Written through the owner connection because there is no bulk-trash API and
    // inventing one to test the cursor would be testing the wrong thing.
    const made: string[] = [];
    for (const name of ['toplu-1', 'toplu-2', 'toplu-3', 'toplu-4']) {
      made.push((await files.createFolder(orgB, shareB, null, name)).id);
    }
    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `UPDATE file_entries SET trashed_at = now(), trashed_by = $2 WHERE id = ANY($1::uuid[])`,
        [made, userB],
      );
    });

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const bin = await files.listTrash(orgB, shareB, cursor, 2);
      seen.push(...bin.items.map((i) => i.id));
      if (!bin.hasMore) break;
      cursor = bin.nextCursor;
      expect(cursor).not.toBeNull();
    }

    // All four, each exactly once. That is the assertion the tie-break exists for.
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of made) expect(seen).toContain(id);
  });

  it("does not show one tenant the other tenant's trash", async () => {
    const mine = await files.createFolder(orgA, shareA, null, 'cop-gizli');
    await files.trash(orgA, mine.id, userA);

    const theirs = await files.listTrash(orgB, shareB, null, 200);
    expect(theirs.items.map((i) => i.id)).not.toContain(mine.id);
    // And the other direction: the id is not addressable either, so a client cannot restore its
    // way into another tenant's tree with an id it guessed or was leaked.
    await expect(files.restore(orgB, mine.id)).rejects.toBeInstanceOf(EntryNotFoundError);
  });

  // ─── restore ────────────────────────────────────────────────────────────────

  it('restores an entry and puts it back in its folder', async () => {
    const folder = await files.createFolder(orgA, shareA, null, 'geri-alinacak');
    await files.trash(orgA, folder.id, userA);
    const restored = await files.restore(orgA, folder.id);

    expect(restored.trashed_at).toBeNull();
    // The SAME id. The trash is a column and not a second table precisely so that whatever pointed
    // at this row before the delete still points at it after the undo.
    expect(restored.id).toBe(folder.id);
    const page = await files.list(orgA, shareA, null, null, 200);
    expect(page.items.map((i) => i.id)).toContain(folder.id);
  });

  it('is a no-op when the entry was never in the trash, so a retried restore is safe', async () => {
    const folder = await files.createFolder(orgA, shareA, null, 'hic-silinmedi');
    const again = await files.restore(orgA, folder.id);
    expect(again.id).toBe(folder.id);
    expect(again.trashed_at).toBeNull();
  });

  it('refuses to restore a child while its parent is still in the trash', async () => {
    // The trash is a column, so trashing the parent leaves the child's own `trashed_at` alone and
    // trashing the child leaves the parent's alone. Restoring the child by itself would clear a
    // flag on a row whose parent is still filtered out of every listing: the entry would appear in
    // no folder and in no bin, reachable only by an id nothing on screen would ever show.
    const parent = await files.createFolder(orgA, shareA, null, 'ust-cop');
    const child = await files.createFolder(orgA, shareA, parent.id, 'alt-cop');
    await files.trash(orgA, child.id, userA);
    await files.trash(orgA, parent.id, userA);

    await expect(files.restore(orgA, child.id)).rejects.toBeInstanceOf(TrashedParentError);

    // In the right order it works, which is what makes the refusal an instruction rather than a
    // dead end: the error names the parent, and restoring that first unblocks the child.
    await files.restore(orgA, parent.id);
    const restored = await files.restore(orgA, child.id);
    expect(restored.trashed_at).toBeNull();
  });

  // ─── search ─────────────────────────────────────────────────────────────────
  //
  // Every one of these builds its own folder and searches with that folder as the scope, so the
  // result set is exactly what the test created no matter what else has run.

  it('finds a name however the query is cased or accented, because both sides are normalised', async () => {
    const scope = await files.createFolder(orgA, shareA, null, 'ara-normal');
    await files.createFolder(orgA, shareA, scope.id, 'İstanbul Notları');

    for (const query of ['istanbul', 'İSTANBUL', 'Istanbul', 'notlari', 'Notları']) {
      const hits = await files.search(orgA, shareA, scope.id, query, null, 50);
      expect(
        hits.items.map((i) => i.name),
        `query ${query}`,
      ).toContain('İstanbul Notları');
    }
  });

  it('ranks a prefix match above a name that merely contains the query', async () => {
    // Trigram similarity on its own puts the SHORTER name first, so `x-rapor-y` would beat
    // `Rapor 2026 Q1` for the query `rapor`. Someone typing the beginning of a filename is
    // navigating, not exploring, and the file they are typing has to be the first row.
    const scope = await files.createFolder(orgA, shareA, null, 'ara-siralama');
    await files.createFolder(orgA, shareA, scope.id, 'yillik-rapor-ozeti');
    await files.createFolder(orgA, shareA, scope.id, 'rapor 2026');

    const hits = await files.search(orgA, shareA, scope.id, 'rapor', null, 50);
    expect(hits.items[0]?.name).toBe('rapor 2026');
    expect(hits.items.map((i) => i.name)).toContain('yillik-rapor-ozeti');
  });

  it('never returns something that is in the trash', async () => {
    const scope = await files.createFolder(orgA, shareA, null, 'ara-cop');
    const gone = await files.createFolder(orgA, shareA, scope.id, 'silinen-belge');
    const here = await files.createFolder(orgA, shareA, scope.id, 'duran-belge');
    await files.trash(orgA, gone.id, userA);

    const hits = await files.search(orgA, shareA, scope.id, 'belge', null, 50);
    expect(hits.items.map((i) => i.id)).toEqual([here.id]);
  });

  it('searches only inside the scope it was given, to any depth', async () => {
    const scope = await files.createFolder(orgA, shareA, null, 'ara-kapsam');
    const deep = await files.createFolder(orgA, shareA, scope.id, 'ara');
    const deeper = await files.createFolder(orgA, shareA, deep.id, 'daha');
    const target = await files.createFolder(orgA, shareA, deeper.id, 'kapsamli-hedef');
    // A namesake three folders away and outside the scope. If the scope were a path prefix rather
    // than a walk of `parent_id`, a stale `path` on any ancestor would let this one through.
    const outside = await files.createFolder(orgA, shareA, null, 'kapsamli-hedef');

    const scoped = await files.search(orgA, shareA, scope.id, 'kapsamli-hedef', null, 50);
    expect(scoped.items.map((i) => i.id)).toEqual([target.id]);

    const unscoped = await files.search(orgA, shareA, null, 'kapsamli-hedef', null, 50);
    const ids = unscoped.items.map((i) => i.id);
    expect(ids).toContain(target.id);
    expect(ids).toContain(outside.id);
  });

  it('treats % and _ as characters the user typed, not as wildcards', async () => {
    // Unescaped, a query of `a%b` becomes `LIKE '%a%b%'` and matches every name with an a before a
    // b. The user gets results that do not contain what they typed and no way to tell why.
    const scope = await files.createFolder(orgA, shareA, null, 'ara-joker');
    await files.createFolder(orgA, shareA, scope.id, 'a%b');
    await files.createFolder(orgA, shareA, scope.id, 'axb');

    const hits = await files.search(orgA, shareA, scope.id, 'a%b', null, 50);
    expect(hits.items.map((i) => i.name)).toEqual(['a%b']);
  });

  it('matches a one- or two-character query as a prefix, where the trigram index cannot help', async () => {
    // Below three characters there is no trigram to look up, so 0008 ships a `text_pattern_ops`
    // B-tree for the prefix form instead. The branch is a performance decision with a visible
    // consequence, and this is that consequence: a two-letter query anchors at the start.
    const scope = await files.createFolder(orgA, shareA, null, 'ara-kisa');
    await files.createFolder(orgA, shareA, scope.id, 'zq-bastan');
    await files.createFolder(orgA, shareA, scope.id, 'ortada-zq-var');

    const hits = await files.search(orgA, shareA, scope.id, 'zq', null, 50);
    expect(hits.items.map((i) => i.name)).toEqual(['zq-bastan']);
  });

  it('pages search results with a cursor and repeats nothing', async () => {
    const scope = await files.createFolder(orgA, shareA, null, 'ara-sayfa');
    const names = ['sayfali-a', 'sayfali-b', 'sayfali-c', 'sayfali-d', 'sayfali-e'];
    for (const name of names) await files.createFolder(orgA, shareA, scope.id, name);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const hits = await files.search(orgA, shareA, scope.id, 'sayfali', cursor, 2);
      seen.push(...hits.items.map((i) => i.name));
      if (!hits.hasMore) break;
      cursor = hits.nextCursor;
      expect(cursor).not.toBeNull();
    }

    // Five names across three pages, each seen exactly once. An offset would repeat or skip as
    // soon as anything else was written to the share, which on a NAS is continuously.
    expect(new Set(seen).size).toBe(names.length);
    for (const name of names) expect(seen).toContain(name);
  });

  it('does not let a search cross into another tenant, even for an exact name', async () => {
    await files.createFolder(orgA, shareA, null, 'kiracıya-özel-dosya');
    const theirs = await files.search(orgB, shareB, null, 'kiracıya-özel-dosya', null, 50);
    expect(theirs.items).toHaveLength(0);
  });
});
