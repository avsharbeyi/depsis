import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AgentRefusedError,
  AgentUnavailableError,
  type AgentService,
} from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import {
  EntryMissingOnDiskError,
  EntryNotFoundError,
  FilesService,
  FolderNotOnDiskError,
  InvalidNameError,
  MoveIntoDescendantError,
  NameTakenError,
  NotTrashedError,
  TrashedParentError,
  type ShareRef,
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

/** Most tests here are metadata only, and reaching the agent from one of them is a bug. */
const noAgent = {
  isAvailable: () => false,
  call: () => Promise.reject(new Error('no test here should call the agent')),
} as unknown as AgentService;

/**
 * An agent that answers from a script and remembers every request.
 *
 * A fake rather than a mock of the socket, because what these tests are about is the ORDER of two
 * stores: the agent is asked first and the row is written second, so a refusal has to leave the
 * database exactly as it was. `calls` is what proves the first half — a test that only checked the
 * rows would pass just as happily against an implementation that never asked the agent at all.
 */
function withAgent(answer: (request: Record<string, unknown>) => Record<string, unknown>): {
  files: FilesService;
  calls: Record<string, unknown>[];
} {
  const calls: Record<string, unknown>[] = [];
  const agent = {
    isAvailable: () => true,
    call: (request: Record<string, unknown>) => {
      calls.push(request);
      // `new Promise` rather than an async function, so that a script which THROWS produces a
      // rejected promise — which is how an unreachable agent arrives at the caller.
      return new Promise<unknown>((resolve) => {
        resolve(answer(request));
      });
    },
  } as unknown as AgentService;
  return { files: new FilesService(db, agent), calls };
}

// Declared out here because `withAgent` above builds a second `FilesService` on the same pool.
let db: DbService;

describeDb('the file tree, against a real PostgreSQL', () => {
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
    const renamed = await files.rename(orgA, folder.id, 'yeni', shareRefA(), 'cid', 'test');
    expect(renamed.name).toBe('yeni');
    expect(renamed.path.endsWith('/yeni')).toBe(true);
  });

  it('rebuilds the path of everything under a renamed folder', async () => {
    // `move` did this and `rename` did not, so the same user-visible change left the cache in two
    // different states depending on which spelling the client used. Nothing authorises on `path`
    // (ADR-0005), which is the only reason it was survivable rather than a bug with a victim.
    const folder = await files.createFolder(orgA, shareA, null, 'ad-kok');
    const child = await files.createFolder(orgA, shareA, folder.id, 'ad-alt');
    const grandchild = await files.createFolder(orgA, shareA, child.id, 'ad-torun');

    await files.rename(orgA, folder.id, 'ad-yeni', shareRefA(), 'cid', 'test');

    expect((await files.find(orgA, child.id)).path).toBe('/ad-yeni/ad-alt');
    expect((await files.find(orgA, grandchild.id)).path).toBe('/ad-yeni/ad-alt/ad-torun');
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
  // ─── move ───────────────────────────────────────────────────────────────────
  //
  // The filesystem first and the database second, always. Every test below is about that order:
  // what the agent was asked, and what the rows look like when it says no.

  /** The share every move and purge below works in. Assigned in `beforeAll`, so read lazily. */
  const shareRefA = (): ShareRef => ({ id: shareA, name: 'files-a' });

  it('moves an entry, and rebuilds the path of everything under it', async () => {
    const moving = withAgent(() => ({ status: 'moved' }));
    const source = await files.createFolder(orgA, shareA, null, 'tas-kaynak');
    const middle = await files.createFolder(orgA, shareA, source.id, 'tas-orta');
    const leaf = await files.createFolder(orgA, shareA, middle.id, 'tas-yaprak');
    const destination = await files.createFolder(orgA, shareA, null, 'tas-hedef');

    const moved = await moving.files.move(
      orgA,
      source.id,
      shareRefA(),
      { parentId: destination.id },
      'cid-move',
      'test',
    );

    expect(moved.parent_id).toBe(destination.id);
    expect(moved.path).toBe('/tas-hedef/tas-kaynak');
    // The subtree is the half a `parent_id` update alone would leave wrong, and a stale `path` is
    // what SMB mapping and search read.
    expect((await files.find(orgA, middle.id)).path).toBe('/tas-hedef/tas-kaynak/tas-orta');
    expect((await files.find(orgA, leaf.id)).path).toBe(
      '/tas-hedef/tas-kaynak/tas-orta/tas-yaprak',
    );

    const inside = await files.list(orgA, shareA, destination.id, null, 50);
    expect(inside.items.map((i) => i.id)).toContain(source.id);
    const atRoot = await files.list(orgA, shareA, null, null, 500);
    expect(atRoot.items.map((i) => i.id)).not.toContain(source.id);

    expect(moving.calls).toEqual([
      { op: 'move_entry', share: 'files-a', from: ['tas-kaynak'], to: ['tas-hedef', 'tas-kaynak'] },
    ]);
  });

  it('renames while moving in ONE call, so the entry is never in the new folder under the old name', async () => {
    const moving = withAgent(() => ({ status: 'moved' }));
    const source = await files.createFolder(orgA, shareA, null, 'tas-iki-isim');
    const destination = await files.createFolder(orgA, shareA, null, 'tas-iki-hedef');

    const moved = await moving.files.move(
      orgA,
      source.id,
      shareRefA(),
      { parentId: destination.id, name: 'yeni-isim' },
      'cid-move2',
      'test',
    );

    expect(moved.name).toBe('yeni-isim');
    expect(moved.path).toBe('/tas-iki-hedef/yeni-isim');
    expect(moving.calls).toHaveLength(1);
    expect(moving.calls[0]).toMatchObject({ to: ['tas-iki-hedef', 'yeni-isim'] });
  });

  it('refuses to move a folder inside itself, and asks the agent nothing', async () => {
    // A cycle in `parent_id` makes every recursive walk in this file non-terminating — the path
    // rebuild, the search scope, `componentsOf`. No constraint in the schema can see it.
    const moving = withAgent(() => ({ status: 'moved' }));
    const outer = await files.createFolder(orgA, shareA, null, 'dongu-ust');
    const inner = await files.createFolder(orgA, shareA, outer.id, 'dongu-orta');
    const deepest = await files.createFolder(orgA, shareA, inner.id, 'dongu-alt');

    for (const target of [outer.id, inner.id, deepest.id]) {
      await expect(
        moving.files.move(orgA, outer.id, shareRefA(), { parentId: target }, 'cid', 'test'),
      ).rejects.toBeInstanceOf(MoveIntoDescendantError);
    }

    expect(moving.calls).toEqual([]);
    const after = await files.find(orgA, outer.id);
    expect(after.parent_id).toBeNull();
    expect(after.path).toBe('/dongu-ust');
    expect((await files.find(orgA, deepest.id)).path).toBe('/dongu-ust/dongu-orta/dongu-alt');
  });

  it('changes nothing in the database when the agent refuses', async () => {
    // The order this suite exists for. If the row moved first, a refusal here would leave it
    // naming a folder the bytes are not in, and every download of that file would 404.
    const moving = withAgent(() => ({ status: 'refused', reason: 'storage is not set up' }));
    const source = await files.createFolder(orgA, shareA, null, 'ret-kaynak');
    const child = await files.createFolder(orgA, shareA, source.id, 'ret-alt');
    const destination = await files.createFolder(orgA, shareA, null, 'ret-hedef');

    await expect(
      moving.files.move(orgA, source.id, shareRefA(), { parentId: destination.id }, 'cid', 'test'),
    ).rejects.toBeInstanceOf(AgentRefusedError);

    const after = await files.find(orgA, source.id);
    expect(after.parent_id).toBeNull();
    expect(after.path).toBe('/ret-kaynak');
    expect((await files.find(orgA, child.id)).path).toBe('/ret-kaynak/ret-alt');
    expect((await files.list(orgA, shareA, destination.id, null, 50)).items).toHaveLength(0);
  });

  it('reports a row whose file is not where the database says, without moving the row', async () => {
    // A file at the share root renamed to another name at the share root: no folder anywhere in
    // either path, so `not_found` cannot be explained by a directory DEPSIS never created. What is
    // left is the genuine article — the two stores disagree — and that is the one case that has
    // earned `EntryMissingOnDiskError`'s message. The folder cases answer `FolderNotOnDiskError`
    // instead, and the two must not be confused: one is a corruption, the other is a feature that
    // has not landed.
    const moving = withAgent(() => ({ status: 'not_found', reason: 'kayip: no such entry' }));
    const source = await files.recordPublishedFile(orgA, shareA, null, 'kayip-kaynak.txt', 3, null);

    await expect(
      moving.files.move(
        orgA,
        source.id,
        shareRefA(),
        { parentId: null, name: 'kayip-hedef.txt' },
        'cid',
        'test',
      ),
    ).rejects.toBeInstanceOf(EntryMissingOnDiskError);

    expect((await files.find(orgA, source.id)).name).toBe('kayip-kaynak.txt');
  });

  it('refuses a name the destination already has, before anything privileged happens', async () => {
    const moving = withAgent(() => ({ status: 'moved' }));
    const destination = await files.createFolder(orgA, shareA, null, 'cakisma-hedef');
    await files.createFolder(orgA, shareA, destination.id, 'ayni-ad');
    const source = await files.createFolder(orgA, shareA, null, 'ayni-ad');

    await expect(
      moving.files.move(orgA, source.id, shareRefA(), { parentId: destination.id }, 'cid', 'test'),
    ).rejects.toBeInstanceOf(NameTakenError);

    // Not one call. The agent's RENAME_NOREPLACE would refuse too, but only for a name that
    // exists ON DISK — and a folder has no directory there, so the kernel cannot see this
    // collision at all.
    expect(moving.calls).toEqual([]);
    expect((await files.find(orgA, source.id)).parent_id).toBeNull();
  });

  it('is a no-op when the entry is already where it is being moved to', async () => {
    // A retried request whose answer the client never saw must not be a second rename.
    const moving = withAgent(() => ({ status: 'moved' }));
    const entry = await files.createFolder(orgA, shareA, null, 'ayni-yer');
    const same = await moving.files.move(orgA, entry.id, shareRefA(), { parentId: null }, 'c', 't');
    expect(same.id).toBe(entry.id);
    expect(moving.calls).toEqual([]);
  });

  it("will not move another tenant's entry", async () => {
    const moving = withAgent(() => ({ status: 'moved' }));
    const mine = await files.createFolder(orgA, shareA, null, 'tas-gizli');
    await expect(
      moving.files.move(
        orgB,
        mine.id,
        { id: shareB, name: 'files-b' },
        { parentId: null },
        'cid',
        'test',
      ),
    ).rejects.toBeInstanceOf(EntryNotFoundError);
    expect(moving.calls).toEqual([]);
  });

  it('renaming a FILE moves its bytes, so the row and the disk cannot drift apart', async () => {
    // The divergence that made a permanent delete leave the data behind. `rename` used to change
    // `name` and `path` and never speak to the agent, so the row said `b.txt` while the disk still
    // held `a.txt`. Nothing noticed until the purge: the agent was asked to remove `b.txt`,
    // answered `not_found`, the row was deleted as a successful retry, and `a.txt` stayed on
    // disk — readable over SMB, counted against the refquota, and unreachable through DEPSIS. The
    // user had been told it was permanently deleted.
    const renaming = withAgent(() => ({ status: 'moved' }));
    const file = await files.recordPublishedFile(orgA, shareA, null, 'a.txt', 4, null);

    const renamed = await renaming.files.rename(orgA, file.id, 'b.txt', shareRefA(), 'cid', 'test');

    expect(renamed.name).toBe('b.txt');
    expect(renaming.calls).toEqual([
      { op: 'move_entry', share: 'files-a', from: ['a.txt'], to: ['b.txt'] },
    ]);
  });

  it('leaves a file under its old name when the agent will not rename it', async () => {
    // The other half: the agent is asked FIRST, so a refusal must leave the row exactly as it was.
    // A row that renamed itself anyway would be the same divergence with the stores swapped.
    const renaming = withAgent(() => ({ status: 'refused', reason: 'read-only filesystem' }));
    const file = await files.recordPublishedFile(orgA, shareA, null, 'sabit.txt', 4, null);

    await expect(
      renaming.files.rename(orgA, file.id, 'degisti.txt', shareRefA(), 'cid', 'test'),
    ).rejects.toBeInstanceOf(AgentRefusedError);

    const after = await files.find(orgA, file.id);
    expect(after.name).toBe('sabit.txt');
    expect(after.path).toBe('/sabit.txt');
  });

  it('renames a FOLDER without the agent, because a folder has no directory to rename', async () => {
    // The deliberate exception, and the reason it is safe: `createFolder` cannot make a directory
    // (the agent has no `mkdir`), so there is nothing on disk for a rename to move. Routing this
    // through the agent would fail every folder rename in the product.
    const renaming = withAgent(() => ({ status: 'moved' }));
    const folder = await files.createFolder(orgA, shareA, null, 'klasor-eski');

    const renamed = await renaming.files.rename(
      orgA,
      folder.id,
      'klasor-yeni',
      shareRefA(),
      'cid',
      'test',
    );

    expect(renamed.name).toBe('klasor-yeni');
    expect(renaming.calls).toEqual([]);
  });

  it('says the folder is not on disk yet, rather than accusing the database of being wrong', async () => {
    // A folder is a row with no directory behind it, so `open_dir` inside the agent fails with
    // ENOENT the moment either end of a move runs through one. The old answer was "the filesystem
    // does not have this entry where the database says it is", which sends whoever reads it
    // hunting a corrupted database that is in fact correct.
    const moving = withAgent(() => ({ status: 'not_found', reason: 'hedef: no such entry' }));
    const destination = await files.createFolder(orgA, shareA, null, 'disk-yok-hedef');
    const file = await files.recordPublishedFile(orgA, shareA, null, 'tasinan.txt', 4, null);

    await expect(
      moving.files.move(orgA, file.id, shareRefA(), { parentId: destination.id }, 'cid', 'test'),
    ).rejects.toBeInstanceOf(FolderNotOnDiskError);

    // The row did not move. The agent is asked first precisely so that a failure here costs
    // nothing but the answer.
    expect((await files.find(orgA, file.id)).parent_id).toBeNull();
  });

  it('says the same about a folder moved at the share root, where no path names a folder', async () => {
    // The case the component counts alone would miss: `from` and `to` are both one component, so
    // nothing in the paths betrays a folder — the ENTRY is the folder, and it is the thing that
    // was never created on disk. Reachable through `PATCH {parentId: null, name}`, which is the
    // spelling `rename`'s folder branch does not cover.
    const moving = withAgent(() => ({ status: 'not_found', reason: 'kok: no such entry' }));
    const folder = await files.createFolder(orgA, shareA, null, 'kok-klasor');

    await expect(
      moving.files.move(
        orgA,
        folder.id,
        shareRefA(),
        { parentId: null, name: 'kok-klasor-yeni' },
        'cid',
        'test',
      ),
    ).rejects.toBeInstanceOf(FolderNotOnDiskError);

    expect((await files.find(orgA, folder.id)).name).toBe('kok-klasor');
  });

  // ─── permanent deletion ─────────────────────────────────────────────────────

  it('refuses to permanently delete something that is not in the trash', async () => {
    const purging = withAgent(() => ({ status: 'removed' }));
    const entry = await files.createFolder(orgA, shareA, null, 'copte-degil');

    await expect(
      purging.files.purge(orgA, entry.id, shareRefA(), 'cid', 'test'),
    ).rejects.toBeInstanceOf(NotTrashedError);

    expect(purging.calls).toEqual([]);
    expect((await files.find(orgA, entry.id)).id).toBe(entry.id);
  });

  it('deletes a folder from the leaves up and leaves no row behind', async () => {
    const purging = withAgent(() => ({ status: 'removed' }));
    const root = await files.createFolder(orgA, shareA, null, 'kalici-kok');
    const middle = await files.createFolder(orgA, shareA, root.id, 'kalici-orta');
    const deep = await files.createFolder(orgA, shareA, middle.id, 'kalici-derin');
    const sibling = await files.createFolder(orgA, shareA, root.id, 'kalici-kardes');
    await files.trash(orgA, root.id, userA);

    await purging.files.purge(orgA, root.id, shareRefA(), 'cid-purge', 'test');

    for (const id of [deep.id, middle.id, sibling.id, root.id]) {
      await expect(files.find(orgA, id)).rejects.toBeInstanceOf(EntryNotFoundError);
    }

    const paths = purging.calls.map((call) => (call['path'] as string[]).join('/'));
    expect(new Set(paths).size).toBe(4);
    // The property, not an exact order: a node is only ever removed after everything under it.
    // `parent_id` is ON DELETE RESTRICT, so the wrong order would fail loudly — but relying on
    // that is relying on the database to catch a bug this code is supposed not to have.
    expect(paths.indexOf('kalici-kok/kalici-orta/kalici-derin')).toBeLessThan(
      paths.indexOf('kalici-kok/kalici-orta'),
    );
    expect(paths.indexOf('kalici-kok/kalici-orta')).toBeLessThan(paths.indexOf('kalici-kok'));
    expect(paths.indexOf('kalici-kok/kalici-kardes')).toBeLessThan(paths.indexOf('kalici-kok'));
    expect(paths[paths.length - 1]).toBe('kalici-kok');
    // Every node here is a folder, and the agent needs `AT_REMOVEDIR` for each: it refuses to
    // guess, so a caller that got this wrong would be told rather than surprised.
    expect(purging.calls.every((call) => call['directory'] === true)).toBe(true);
  });

  it('deletes nothing when the agent cannot be reached', async () => {
    const purging = withAgent(() => {
      throw new AgentUnavailableError('socket is gone');
    });
    const root = await files.createFolder(orgA, shareA, null, 'ulasilamaz-kok');
    const child = await files.createFolder(orgA, shareA, root.id, 'ulasilamaz-alt');
    await files.trash(orgA, root.id, userA);

    await expect(
      purging.files.purge(orgA, root.id, shareRefA(), 'cid', 'test'),
    ).rejects.toBeInstanceOf(AgentUnavailableError);

    expect((await files.find(orgA, root.id)).id).toBe(root.id);
    expect((await files.find(orgA, child.id)).id).toBe(child.id);
  });

  it('resumes an interrupted delete, and treats an entry already gone as gone', async () => {
    // There is no transaction across a filesystem and a database, so this operation is not atomic
    // and the contract says so. What it promises instead is that the removed stay removed and a
    // second call finishes the job — which only works if `not_found` from the agent counts as
    // success, because that is exactly what a crash between the unlink and the DELETE leaves.
    const root = await files.createFolder(orgA, shareA, null, 'yarim-kok');
    const first = await files.createFolder(orgA, shareA, root.id, 'yarim-bir');
    const second = await files.createFolder(orgA, shareA, root.id, 'yarim-iki');
    await files.trash(orgA, root.id, userA);

    let answered = 0;
    const interrupted = withAgent(() => {
      answered += 1;
      if (answered > 1) throw new AgentUnavailableError('the agent went away mid-delete');
      return { status: 'removed' };
    });
    await expect(
      interrupted.files.purge(orgA, root.id, shareRefA(), 'cid', 'test'),
    ).rejects.toBeInstanceOf(AgentUnavailableError);

    const firstPath = ((interrupted.calls[0] ?? {})['path'] as string[]) ?? [];
    const wentFirst = firstPath.join('/').endsWith('yarim-bir') ? first : second;
    const survivor = wentFirst.id === first.id ? second : first;
    await expect(files.find(orgA, wentFirst.id)).rejects.toBeInstanceOf(EntryNotFoundError);
    expect((await files.find(orgA, survivor.id)).id).toBe(survivor.id);
    expect((await files.find(orgA, root.id)).trashed_at).not.toBeNull();

    // Second pass. The unlinks all happened before the agent went away, so it answers `not_found`
    // for everything left — and the rows still have to go.
    const resumed = withAgent(() => ({ status: 'not_found', reason: 'no such entry' }));
    await resumed.files.purge(orgA, root.id, shareRefA(), 'cid', 'test');
    for (const id of [root.id, first.id, second.id]) {
      await expect(files.find(orgA, id)).rejects.toBeInstanceOf(EntryNotFoundError);
    }
  });

  /**
   * An upload session pointing into the tree, written the way `UploadsController` writes one.
   *
   * As the owner rather than through the controller because what these two tests need is the
   * SHAPE of the row — a `parent_id` into a folder, or a completed session naming a file — and
   * the controller can only produce one of those by driving a whole tus transfer through a live
   * agent.
   */
  async function seedUploadSession(options: {
    parentId: string | null;
    fileId: string | null;
  }): Promise<void> {
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO public.upload_sessions
           (organization_id, share_id, parent_id, created_by, filename, staging_name,
            length_bytes, offset_bytes, file_id, completed_at)
         VALUES ($1, $2, $3, $4, 'yuklenen.bin', $5, 10, 10, $6::uuid,
                 CASE WHEN $6::uuid IS NULL THEN NULL ELSE now() END)`,
        [orgA, shareA, options.parentId, userA, `${randomUUID()}.part`, options.fileId],
      ),
    );
  }

  it('purges a folder that was once an upload target, instead of wedging on its sessions', async () => {
    // The worst shape a bug in this endpoint can take, and it was reachable through the public
    // API alone. `upload_sessions.parent_id` is ON DELETE RESTRICT and nothing ever removed those
    // rows, so the purge unlinked every descendant from disk and then died on the LAST node's
    // DELETE with a foreign-key violation — a 500. Retrying replayed it forever: the agent
    // answered `not_found` (accepted as success) and the same constraint fired again. The folder
    // sat in the trash permanently, its contents already gone.
    const folder = await files.createFolder(orgA, shareA, null, 'yukleme-hedefi');
    await seedUploadSession({ parentId: folder.id, fileId: null });
    await files.trash(orgA, folder.id, userA);

    const purging = withAgent(() => ({ status: 'removed' }));
    await purging.files.purge(orgA, folder.id, shareRefA(), 'cid-fk', 'test');

    await expect(files.find(orgA, folder.id)).rejects.toBeInstanceOf(EntryNotFoundError);
    const left = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.upload_sessions WHERE parent_id = $1`,
        [folder.id],
      ),
    );
    expect(left[0]?.n).toBe('0');
  });

  it('purges a file that arrived through an upload, whose session still names it', async () => {
    // The same wedge by the other reference, and the commoner one: `file_id` is ON DELETE SET
    // NULL, but `upload_sessions_completion_pair` refuses a null `file_id` beside a non-null
    // `completed_at`. So the cascade the schema promises cannot fire, and EVERY file that arrived
    // through tus — which is every file in the product — was unpurgeable after its bytes were
    // already unlinked.
    const file = await files.recordPublishedFile(orgA, shareA, null, 'kalici.bin', 7, null);
    await seedUploadSession({ parentId: null, fileId: file.id });
    await files.trash(orgA, file.id, userA);

    const purging = withAgent(() => ({ status: 'removed' }));
    await purging.files.purge(orgA, file.id, shareRefA(), 'cid-fk2', 'test');

    await expect(files.find(orgA, file.id)).rejects.toBeInstanceOf(EntryNotFoundError);
    expect(purging.calls).toEqual([
      { op: 'remove_entry', share: 'files-a', path: ['kalici.bin'], directory: false },
    ]);
  });

  it("will not permanently delete another tenant's entry", async () => {
    const purging = withAgent(() => ({ status: 'removed' }));
    const mine = await files.createFolder(orgA, shareA, null, 'kalici-gizli');
    await files.trash(orgA, mine.id, userA);

    await expect(
      purging.files.purge(orgB, mine.id, { id: shareB, name: 'files-b' }, 'cid', 'test'),
    ).rejects.toBeInstanceOf(EntryNotFoundError);

    expect(purging.calls).toEqual([]);
    expect((await files.find(orgA, mine.id)).id).toBe(mine.id);
  });
});
