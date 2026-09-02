import { randomUUID } from 'node:crypto';

import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Permission } from '@depsis/authz';
import type { Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AgentDataService } from '../agent/agent-data.service.js';
import {
  AgentRefusedError,
  AgentUnavailableError,
  type AgentService,
} from '../agent/agent.service.js';
import type { AuthenticatedRequest } from '../auth/session.guard.js';
import { AuditService } from '../audit/audit.service.js';
import { DbService } from '../db/db.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import { PosixIdentityService } from '../identity/posix.service.js';
import { ThumbnailsService } from './thumbnails.service.js';
import { FilesController } from './files.controller.js';
import { TrashRetentionService } from './trash-retention.service.js';
import {
  EntryMissingOnDiskError,
  EntryNotFoundError,
  FilesService,
  FolderNotOnDiskError,
  InvalidNameError,
  MoveIntoDescendantError,
  NameTakenByTrashedEntryError,
  NameTakenError,
  NameTakenOnDiskError,
  NotTrashedError,
  TrashedParentError,
  type Caller,
  type FileEntryRow,
  type ShareRef,
} from './files.service.js';
import { SearchController } from './search.controller.js';
import type { CopyService } from './copy.service.js';
import { UploadsController } from './uploads.controller.js';

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

/**
 * The agent the FIXTURE service talks to.
 *
 * There used to be one here that refused everything, on the grounds that a metadata test reaching
 * the agent was a bug. That stopped being possible when folder creation became a filesystem
 * operation: almost every test below needs a folder to exist before it can assert anything, and
 * making one now asks the agent first and writes the row only if it agrees.
 *
 * So this answers exactly the two operations a FIXTURE needs — make a directory, rename one — and
 * rejects everything else, which keeps the original guarantee for every other operation. Nothing
 * that asserts about which call was made, or in what order, uses this: those build their own
 * service with `withAgent`, and this one deliberately records nothing so it cannot be asserted on
 * by accident.
 */
const fixtureAgent = {
  isAvailable: () => true,
  call: (request: Record<string, unknown>) => {
    switch (request['op']) {
      case 'create_directory':
        return Promise.resolve({ status: 'directory_created' });
      case 'move_entry':
        return Promise.resolve({ status: 'moved' });
      default:
        return Promise.reject(
          new Error(`no fixture answers '${String(request['op'])}'; build one with withAgent`),
        );
    }
  },
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
  return {
    files: new FilesService(db, agent, new PosixIdentityService(db), new JobsService(db)),
    calls,
  };
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

    files = new FilesService(db, fixtureAgent, new PosixIdentityService(db), new JobsService(db));
    shareA = (await files.defaultShare(orgA, 'files-a')).id;
    shareB = (await files.defaultShare(orgB, 'files-b')).id;
  });

  /** The two shares, as the agent's callers name them. Assigned in `beforeAll`, so read lazily. */
  const shareRefA = (): ShareRef => ({ id: shareA, name: 'files-a' });
  const shareRefB = (): ShareRef => ({ id: shareB, name: 'files-b' });

  /**
   * A folder, made the way the product makes one: the agent first, the row second.
   *
   * A helper rather than 80 call sites, because `createFolder` now needs a share the agent can
   * name, an acting user whose uid stamps the directory, a correlation id and a reason — and none
   * of that is what the tests below are about. Everything that IS about it says so explicitly.
   */
  const mkdir = (
    organizationId: string,
    shareId: string,
    parentId: string | null,
    name: string,
  ): Promise<FileEntryRow> =>
    files.createFolder(
      organizationId,
      shareId === shareA ? shareRefA() : shareRefB(),
      parentId,
      name,
      organizationId === orgA ? userA : userB,
      'cid-fixture',
      'fixture',
    );

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
        // Before the shares: `folder_grants.share_id` is ON DELETE RESTRICT, and `shareOf` writes
        // a root grant now, so a share always has one on it by the time a test has used it.
        await q.query(`DELETE FROM folder_grants WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM shares WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM users WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        // And the teams before the organisation, for the same reason: `everyone_team()` creates
        // one the first time a share is opened implicitly.
        await q.query(`DELETE FROM team_members WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM teams WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM organizations WHERE id = ANY($1)`, [[orgA, orgB]]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  it('creates a folder and lists it', async () => {
    const folder = await mkdir(orgA, shareA, null, 'Belgeler');
    expect(folder.kind).toBe('folder');

    const page = await files.list(orgA, shareA, null, null, 50);
    expect(page.items.map((i) => i.name)).toContain('Belgeler');
    expect(page.hasMore).toBe(false);
  });

  // ─── folder creation reaches the disk ───────────────────────────────────────
  //
  // The hole these close: `createFolder` used to write a row and nothing else, so a folder existed
  // in Postgres and did not exist on the filesystem. A move through it could only fail, an upload
  // into it had no destination directory, and SMB — the entire reason a NAS exists — showed no
  // folders at all. Every test here is about the ORDER, and about the row NOT existing when the
  // filesystem half did not happen.

  it('asks the agent for a real directory BEFORE it writes the row', async () => {
    const making = withAgent(() => ({ status: 'directory_created' }));
    const parent = await mkdir(orgA, shareA, null, 'disk-ust');

    const folder = await making.files.createFolder(
      orgA,
      shareRefA(),
      parent.id,
      'disk-alt',
      userA,
      'cid-mkdir',
      'test',
    );

    expect(folder.name).toBe('disk-alt');
    expect(making.calls).toHaveLength(1);
    // The path is the parent's components then the name — never the `path` string spliced up, and
    // never just the name, which is the bug that put every upload at the share root.
    expect(making.calls[0]).toMatchObject({
      op: 'create_directory',
      share: 'files-a',
      path: ['disk-ust', 'disk-alt'],
    });
    // The owner is the CREATOR, not the service account. The agent refuses 0 for exactly this.
    const call = making.calls[0] as { owner_uid: number; owner_gid: number };
    expect(call.owner_uid).toBeGreaterThanOrEqual(300000);
    expect(call.owner_uid).toBeLessThanOrEqual(399999);
    // The gid is the same number: one counter allocates uids and team gids, so a creator's own id
    // is a private group nothing else can be holding.
    expect(call.owner_gid).toBe(call.owner_uid);
  });

  it('names the BIN when a trashed folder still holds the name on disk', async () => {
    // The regression, and it is a regression rather than a gap. Trashing writes `trashed_at` and
    // touches nothing on disk, while both unique indexes in 0008 and `requireNameFree` filter on
    // `trashed_at IS NULL` — so the database frees the name the moment something is binned and the
    // directory keeps it. Create, bin, create again: the database says yes and `mkdirat` says
    // EEXIST. The old `createFolder` wrote a row and never called the agent, so the flow worked
    // precisely because the folder was not on disk at all.
    //
    // What must not come back is the SENTENCE. `NameTakenOnDiskError` says the name was "most
    // likely made over SMB, and DEPSIS has no record of it", which is false twice over here: the
    // record exists and the user made it. Sending someone to hunt a phantom SMB client for a
    // folder they deleted a moment ago is the worst available answer, so the assertion below is on
    // the words as much as on the type.
    let created = 0;
    const binned = withAgent((request) => {
      if (request['op'] !== 'create_directory') return { status: 'moved' };
      created += 1;
      // The second `mkdirat` for the same name is the one the kernel refuses; the fake has to say
      // so, because a fixture that always answers `directory_created` cannot see this bug at all.
      return created === 1
        ? { status: 'directory_created' }
        : { status: 'conflict', reason: 'files-a/cop-belgeler: something is already there' };
    });

    const folder = await binned.files.createFolder(
      orgA,
      shareRefA(),
      null,
      'cop-belgeler',
      userA,
      'cid-bin',
      'test',
    );
    await binned.files.trash(orgA, folder.id, userA);

    const failure = await binned.files
      .createFolder(orgA, shareRefA(), null, 'cop-belgeler', userA, 'cid-bin-2', 'test')
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(NameTakenByTrashedEntryError);
    const named = failure as NameTakenByTrashedEntryError;
    expect(named.trashedEntryId).toBe(folder.id);
    expect(named.message).toMatch(/bin/i);
    expect(named.message).not.toMatch(/SMB/i);
    expect(named.message).not.toMatch(/no record/i);

    // And the honest case must survive: with nothing in the bin holding the name, the SMB sentence
    // is the right one and must still be what comes out.
    const smb = withAgent(() => ({
      status: 'conflict',
      reason: 'files-a/elle-yapilmis: something is already there',
    }));
    await expect(
      smb.files.createFolder(orgA, shareRefA(), null, 'elle-yapilmis', userA, 'cid-smb', 'test'),
    ).rejects.toBeInstanceOf(NameTakenOnDiskError);
  });

  it('names the BIN when a rename collides with a trashed sibling on disk', async () => {
    // The same root cause through the other door. `rename` is delegated to `move`, so renaming
    // onto a binned sibling's name passes `requireNameFree` (which excludes trashed rows) and is
    // then refused by `renameat2(RENAME_NOREPLACE)` — arriving as `NameTakenError`, whose advice is
    // "rename one of them", about a folder the listing does not show.
    const renaming = withAgent((request) => {
      if (request['op'] === 'create_directory') return { status: 'directory_created' };
      return { status: 'conflict', reason: 'files-a/arsiv: something is already there' };
    });

    const doomed = await renaming.files.createFolder(
      orgA,
      shareRefA(),
      null,
      'arsiv',
      userA,
      'cid-r1',
      'test',
    );
    await renaming.files.trash(orgA, doomed.id, userA);
    const other = await renaming.files.createFolder(
      orgA,
      shareRefA(),
      null,
      'gecici',
      userA,
      'cid-r2',
      'test',
    );

    const failure = await renaming.files
      .move(orgA, other.id, shareRefA(), { parentId: null, name: 'arsiv' }, userA, 'cid-r3', 'test')
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(NameTakenByTrashedEntryError);
    expect((failure as NameTakenByTrashedEntryError).trashedEntryId).toBe(doomed.id);
  });

  it('writes NO row when the agent refuses to create the directory', async () => {
    // The order, stated as a consequence. A row written first and a refusal second is a folder that
    // appears in every listing, accepts uploads that then fail, and cannot be seen over SMB.
    const refusing = withAgent(() => ({ status: 'refused', reason: 'the dataset is read-only' }));

    await expect(
      refusing.files.createFolder(orgA, shareRefA(), null, 'ret-klasor', userA, 'cid', 'test'),
    ).rejects.toBeInstanceOf(AgentRefusedError);

    const page = await files.list(orgA, shareA, null, null, 500);
    expect(page.items.map((i) => i.name)).not.toContain('ret-klasor');
  });

  it('writes NO row when the agent cannot be reached at all', async () => {
    // Distinct from a refusal and it has to stay distinct: nothing was necessarily done, the box is
    // not broken, and the caller's remedy is to try later. What must not differ is the row.
    const unreachable = withAgent(() => {
      throw new AgentUnavailableError('the socket is not there');
    });

    await expect(
      unreachable.files.createFolder(
        orgA,
        shareRefA(),
        null,
        'ulasilamaz-klasor',
        userA,
        'cid',
        'test',
      ),
    ).rejects.toBeInstanceOf(AgentUnavailableError);

    const page = await files.list(orgA, shareA, null, null, 500);
    expect(page.items.map((i) => i.name)).not.toContain('ulasilamaz-klasor');
  });

  it('says the name is taken ON DISK when the directory already exists there', async () => {
    // EEXIST, and the sentence matters more than the status. The database has no row with this
    // name — the caller can see that in their own listing — so a bare "already exists" reads as a
    // lie. The likeliest cause is somebody creating the folder over SMB, where DEPSIS is not
    // consulted and writes nothing, and that is a fact the person clicking the button can act on.
    const taken = withAgent(() => ({
      status: 'conflict',
      reason: 'files-a/smbden: something is already there',
    }));

    const failure = await taken.files
      .createFolder(orgA, shareRefA(), null, 'smbden', userA, 'cid', 'test')
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(NameTakenOnDiskError);
    expect((failure as NameTakenOnDiskError).message).toContain('on disk');
    // Still no row, so the name stays available the moment the disk half is sorted out.
    const page = await files.list(orgA, shareA, null, null, 500);
    expect(page.items.map((i) => i.name)).not.toContain('smbden');
  });

  it('creates the missing parent of an OLDER folder rather than refusing outright', async () => {
    // What happens to folders that predate `CreateDirectory`: they are rows with no directory, and
    // they are neither backfilled by a migration — nothing in this product can reach the filesystem
    // from the database — nor declared unusable. The directory appears the first time something
    // needs it, which here is a subfolder being created under one.
    //
    // The agent below refuses the first `create_directory` with `not_found` (its parent is not
    // there), accepts every path of length 1 (the parent being materialised), and accepts the
    // retry.
    const seen: string[][] = [];
    const materialising = withAgent((request) => {
      const path = request['path'] as string[];
      seen.push(path);
      const first = seen.length === 1;
      return first
        ? { status: 'not_found', reason: 'files-a/eski: the parent folder does not exist' }
        : { status: 'directory_created' };
    });
    const older = await mkdir(orgA, shareA, null, 'eski-klasor');

    const child = await materialising.files.createFolder(
      orgA,
      shareRefA(),
      older.id,
      'yeni-alt',
      userA,
      'cid',
      'test',
    );

    expect(child.name).toBe('yeni-alt');
    // First the child (refused), then the parent alone, then the child again.
    expect(seen).toEqual([
      ['eski-klasor', 'yeni-alt'],
      ['eski-klasor'],
      ['eski-klasor', 'yeni-alt'],
    ]);
  });

  it('refuses a name a sibling already holds without asking the agent for anything', async () => {
    // The database folds case and the Turkish i; `mkdirat` compares bytes. So the collision has to
    // be caught here, before a directory is made that would then have to be taken off again.
    const making = withAgent(() => ({ status: 'directory_created' }));
    await mkdir(orgA, shareA, null, 'Onceden');

    await expect(
      making.files.createFolder(orgA, shareRefA(), null, 'ONCEDEN', userA, 'cid', 'test'),
    ).rejects.toBeInstanceOf(NameTakenError);

    expect(making.calls).toEqual([]);
  });

  it('removes the directory again when the row cannot be written', async () => {
    // The compensating half, and the mirror of the one in `move`. The sibling pre-check cannot
    // close every way an INSERT can fail — two requests for one name can both pass it, and a
    // constraint can refuse for reasons the check never looked at — so without this the loser
    // leaves a directory nothing in the database names: invisible to every listing, unreachable by
    // every id, and holding a name the user cannot take again through DEPSIS.
    //
    // Driven here by a share id that does not exist, so the agent succeeds and the foreign key
    // then refuses. Any INSERT failure takes the same path; this is simply the one a test can
    // produce without a second connection racing the first.
    const orphaning = withAgent((request) =>
      request['op'] === 'remove_entry' ? { status: 'removed' } : { status: 'directory_created' },
    );
    const ghostShare = { id: randomUUID(), name: 'files-a' };

    await expect(
      orphaning.files.createFolder(orgA, ghostShare, null, 'oksuz', userA, 'cid', 'test'),
    ).rejects.toBeTruthy();

    expect(orphaning.calls).toEqual([
      {
        op: 'create_directory',
        share: 'files-a',
        path: ['oksuz'],
        owner_uid: expect.any(Number) as unknown as number,
        owner_gid: expect.any(Number) as unknown as number,
      },
      // The undo. Without it the directory stays, and the next attempt at this name gets an EEXIST
      // it cannot explain.
      { op: 'remove_entry', share: 'files-a', path: ['oksuz'], directory: true },
    ]);
  });

  it('refuses a second entry with the same name, case-folded', async () => {
    // Two shares on one box are served over SMB, where clients are case-insensitive: 'Rapor' and
    // 'rapor' side by side are two files a Windows user cannot tell apart or address separately.
    await mkdir(orgA, shareA, null, 'Rapor');
    await expect(mkdir(orgA, shareA, null, 'rapor')).rejects.toBeInstanceOf(NameTakenError);
    await expect(mkdir(orgA, shareA, null, 'RAPOR')).rejects.toBeInstanceOf(NameTakenError);
  });

  it('allows names that differ only by accent, because uniqueness is not search', async () => {
    // The two normalisations are deliberately different columns. If uniqueness used the SEARCH
    // normaliser — which strips accents so a search for 'cagri' finds 'Çağrı' — then creating
    // 'Çağrı.txt' beside an existing 'Cagri.txt' would be refused, and the user would be told two
    // plainly different names are the same name.
    await mkdir(orgA, shareA, null, 'Cagri');
    const accented = await mkdir(orgA, shareA, null, 'Çağrı');
    expect(accented.name).toBe('Çağrı');
  });

  it('constrains the share root as well as a folder, which one index cannot do', async () => {
    // `UNIQUE (organization_id, parent_id, name_fold)` alone leaves the root unconstrained:
    // parent_id is NULL there and NULL is distinct from NULL, so every top level would accept
    // unlimited duplicates. The schema splits the index on the null for exactly this.
    const parent = await mkdir(orgA, shareA, null, 'Ust');
    await mkdir(orgA, shareA, parent.id, 'ayni');
    await expect(mkdir(orgA, shareA, parent.id, 'AYNI')).rejects.toBeInstanceOf(NameTakenError);

    await mkdir(orgA, shareA, null, 'kokte');
    await expect(mkdir(orgA, shareA, null, 'KOKTE')).rejects.toBeInstanceOf(NameTakenError);
  });

  it('frees the name when an entry is trashed, and can refuse a restore that would collide', async () => {
    const first = await mkdir(orgA, shareA, null, 'yeniden');
    await files.trash(orgA, first.id, userA);

    // The unique indexes are partial on `trashed_at IS NULL` precisely so this works: a user who
    // deleted `rapor.pdf` must be able to upload a new one without emptying the trash first.
    const second = await mkdir(orgA, shareA, null, 'yeniden');
    expect(second.id).not.toBe(first.id);

    // And the consequence, which is correct rather than unfortunate: restoring the old one now
    // collides, and saying so beats silently restoring it under a suffixed name.
    await expect(files.restore(orgA, first.id)).rejects.toBeInstanceOf(NameTakenError);
  });

  it('hides a trashed entry from listings but keeps its id', async () => {
    const folder = await mkdir(orgA, shareA, null, 'gidecek');
    await files.trash(orgA, folder.id, userA);

    const page = await files.list(orgA, shareA, null, null, 100);
    expect(page.items.map((i) => i.name)).not.toContain('gidecek');

    // The row survives, because a trashed file's id is still referenced by whatever linked to it.
    const still = await files.find(orgA, folder.id);
    expect(still.trashed_at).not.toBeNull();
  });

  it('renames and keeps the derived path in step', async () => {
    const folder = await mkdir(orgA, shareA, null, 'eski');
    const renamed = await files.rename(orgA, folder.id, 'yeni', shareRefA(), userA, 'cid', 'test');
    expect(renamed.name).toBe('yeni');
    expect(renamed.path.endsWith('/yeni')).toBe(true);
  });

  it('rebuilds the path of everything under a renamed folder', async () => {
    // `move` did this and `rename` did not, so the same user-visible change left the cache in two
    // different states depending on which spelling the client used. Nothing authorises on `path`
    // (ADR-0005), which is the only reason it was survivable rather than a bug with a victim.
    const folder = await mkdir(orgA, shareA, null, 'ad-kok');
    const child = await mkdir(orgA, shareA, folder.id, 'ad-alt');
    const grandchild = await mkdir(orgA, shareA, child.id, 'ad-torun');

    await files.rename(orgA, folder.id, 'ad-yeni', shareRefA(), userA, 'cid', 'test');

    expect((await files.find(orgA, child.id)).path).toBe('/ad-yeni/ad-alt');
    expect((await files.find(orgA, grandchild.id)).path).toBe('/ad-yeni/ad-alt/ad-torun');
  });

  it('refuses a name the agent would refuse, before a row exists', async () => {
    // A row the database accepts and openat2 rejects is a file that exists in one store and not
    // the other — the "two realities" this project forbids.
    for (const bad of ['..', 'a/b', '-rf', '.depsis', '']) {
      await expect(mkdir(orgA, shareA, null, bad)).rejects.toBeInstanceOf(InvalidNameError);
    }
  });

  it("does not let one tenant see or address another tenant's tree", async () => {
    const mine = await mkdir(orgA, shareA, null, 'gizli');

    // Same id, other tenant. RLS makes the row invisible to the query, so the service cannot tell
    // "no such row" from "not yours" — and neither can the caller, which is the point: any
    // distinguishable answer here is an existence oracle.
    await expect(files.find(orgB, mine.id)).rejects.toBeInstanceOf(EntryNotFoundError);

    const theirPage = await files.list(orgB, shareB, null, null, 100);
    expect(theirPage.items.map((i) => i.name)).not.toContain('gizli');
  });

  it('pages with a cursor rather than an offset', async () => {
    const parent = await mkdir(orgA, shareA, null, 'sayfali');
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      await mkdir(orgA, shareA, parent.id, name);
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
    await mkdir(orgA, shareA, null, 'Çağrı Işık Raporu');
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
    const kept = await mkdir(orgB, shareB, null, 'cop-kalan');
    const thrown = await mkdir(orgB, shareB, null, 'cop-atilan');
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
      made.push((await mkdir(orgB, shareB, null, name)).id);
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
    const mine = await mkdir(orgA, shareA, null, 'cop-gizli');
    await files.trash(orgA, mine.id, userA);

    const theirs = await files.listTrash(orgB, shareB, null, 200);
    expect(theirs.items.map((i) => i.id)).not.toContain(mine.id);
    // And the other direction: the id is not addressable either, so a client cannot restore its
    // way into another tenant's tree with an id it guessed or was leaked.
    await expect(files.restore(orgB, mine.id)).rejects.toBeInstanceOf(EntryNotFoundError);
  });

  // ─── restore ────────────────────────────────────────────────────────────────

  it('restores an entry and puts it back in its folder', async () => {
    const folder = await mkdir(orgA, shareA, null, 'geri-alinacak');
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
    const folder = await mkdir(orgA, shareA, null, 'hic-silinmedi');
    const again = await files.restore(orgA, folder.id);
    expect(again.id).toBe(folder.id);
    expect(again.trashed_at).toBeNull();
  });

  it('refuses to restore a child while its parent is still in the trash', async () => {
    // The trash is a column, so trashing the parent leaves the child's own `trashed_at` alone and
    // trashing the child leaves the parent's alone. Restoring the child by itself would clear a
    // flag on a row whose parent is still filtered out of every listing: the entry would appear in
    // no folder and in no bin, reachable only by an id nothing on screen would ever show.
    const parent = await mkdir(orgA, shareA, null, 'ust-cop');
    const child = await mkdir(orgA, shareA, parent.id, 'alt-cop');
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
    const scope = await mkdir(orgA, shareA, null, 'ara-normal');
    await mkdir(orgA, shareA, scope.id, 'İstanbul Notları');

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
    const scope = await mkdir(orgA, shareA, null, 'ara-siralama');
    await mkdir(orgA, shareA, scope.id, 'yillik-rapor-ozeti');
    await mkdir(orgA, shareA, scope.id, 'rapor 2026');

    const hits = await files.search(orgA, shareA, scope.id, 'rapor', null, 50);
    expect(hits.items[0]?.name).toBe('rapor 2026');
    expect(hits.items.map((i) => i.name)).toContain('yillik-rapor-ozeti');
  });

  it('never returns something that is in the trash', async () => {
    const scope = await mkdir(orgA, shareA, null, 'ara-cop');
    const gone = await mkdir(orgA, shareA, scope.id, 'silinen-belge');
    const here = await mkdir(orgA, shareA, scope.id, 'duran-belge');
    await files.trash(orgA, gone.id, userA);

    const hits = await files.search(orgA, shareA, scope.id, 'belge', null, 50);
    expect(hits.items.map((i) => i.id)).toEqual([here.id]);
  });

  it('searches only inside the scope it was given, to any depth', async () => {
    const scope = await mkdir(orgA, shareA, null, 'ara-kapsam');
    const deep = await mkdir(orgA, shareA, scope.id, 'ara');
    const deeper = await mkdir(orgA, shareA, deep.id, 'daha');
    const target = await mkdir(orgA, shareA, deeper.id, 'kapsamli-hedef');
    // A namesake three folders away and outside the scope. If the scope were a path prefix rather
    // than a walk of `parent_id`, a stale `path` on any ancestor would let this one through.
    const outside = await mkdir(orgA, shareA, null, 'kapsamli-hedef');

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
    const scope = await mkdir(orgA, shareA, null, 'ara-joker');
    await mkdir(orgA, shareA, scope.id, 'a%b');
    await mkdir(orgA, shareA, scope.id, 'axb');

    const hits = await files.search(orgA, shareA, scope.id, 'a%b', null, 50);
    expect(hits.items.map((i) => i.name)).toEqual(['a%b']);
  });

  it('matches a one- or two-character query as a prefix, where the trigram index cannot help', async () => {
    // Below three characters there is no trigram to look up, so 0008 ships a `text_pattern_ops`
    // B-tree for the prefix form instead. The branch is a performance decision with a visible
    // consequence, and this is that consequence: a two-letter query anchors at the start.
    const scope = await mkdir(orgA, shareA, null, 'ara-kisa');
    await mkdir(orgA, shareA, scope.id, 'zq-bastan');
    await mkdir(orgA, shareA, scope.id, 'ortada-zq-var');

    const hits = await files.search(orgA, shareA, scope.id, 'zq', null, 50);
    expect(hits.items.map((i) => i.name)).toEqual(['zq-bastan']);
  });

  it('pages search results with a cursor and repeats nothing', async () => {
    const scope = await mkdir(orgA, shareA, null, 'ara-sayfa');
    const names = ['sayfali-a', 'sayfali-b', 'sayfali-c', 'sayfali-d', 'sayfali-e'];
    for (const name of names) await mkdir(orgA, shareA, scope.id, name);

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
    await mkdir(orgA, shareA, null, 'kiracıya-özel-dosya');
    const theirs = await files.search(orgB, shareB, null, 'kiracıya-özel-dosya', null, 50);
    expect(theirs.items).toHaveLength(0);
  });
  // ─── move ───────────────────────────────────────────────────────────────────
  //
  // The filesystem first and the database second, always. Every test below is about that order:
  // what the agent was asked, and what the rows look like when it says no.

  it('moves an entry, and rebuilds the path of everything under it', async () => {
    const moving = withAgent(() => ({ status: 'moved' }));
    const source = await mkdir(orgA, shareA, null, 'tas-kaynak');
    const middle = await mkdir(orgA, shareA, source.id, 'tas-orta');
    const leaf = await mkdir(orgA, shareA, middle.id, 'tas-yaprak');
    const destination = await mkdir(orgA, shareA, null, 'tas-hedef');

    const moved = await moving.files.move(
      orgA,
      source.id,
      shareRefA(),
      { parentId: destination.id },
      userA,
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
    const source = await mkdir(orgA, shareA, null, 'tas-iki-isim');
    const destination = await mkdir(orgA, shareA, null, 'tas-iki-hedef');

    const moved = await moving.files.move(
      orgA,
      source.id,
      shareRefA(),
      { parentId: destination.id, name: 'yeni-isim' },
      userA,
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
    const outer = await mkdir(orgA, shareA, null, 'dongu-ust');
    const inner = await mkdir(orgA, shareA, outer.id, 'dongu-orta');
    const deepest = await mkdir(orgA, shareA, inner.id, 'dongu-alt');

    for (const target of [outer.id, inner.id, deepest.id]) {
      await expect(
        moving.files.move(orgA, outer.id, shareRefA(), { parentId: target }, userA, 'cid', 'test'),
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
    const source = await mkdir(orgA, shareA, null, 'ret-kaynak');
    const child = await mkdir(orgA, shareA, source.id, 'ret-alt');
    const destination = await mkdir(orgA, shareA, null, 'ret-hedef');

    await expect(
      moving.files.move(
        orgA,
        source.id,
        shareRefA(),
        { parentId: destination.id },
        userA,
        'cid',
        'test',
      ),
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
        userA,
        'cid',
        'test',
      ),
    ).rejects.toBeInstanceOf(EntryMissingOnDiskError);

    expect((await files.find(orgA, source.id)).name).toBe('kayip-kaynak.txt');
  });

  it('refuses a name the destination already has, before anything privileged happens', async () => {
    const moving = withAgent(() => ({ status: 'moved' }));
    const destination = await mkdir(orgA, shareA, null, 'cakisma-hedef');
    await mkdir(orgA, shareA, destination.id, 'ayni-ad');
    const source = await mkdir(orgA, shareA, null, 'ayni-ad');

    await expect(
      moving.files.move(
        orgA,
        source.id,
        shareRefA(),
        { parentId: destination.id },
        userA,
        'cid',
        'test',
      ),
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
    const entry = await mkdir(orgA, shareA, null, 'ayni-yer');
    const same = await moving.files.move(
      orgA,
      entry.id,
      shareRefA(),
      { parentId: null },
      userA,
      'c',
      't',
    );
    expect(same.id).toBe(entry.id);
    expect(moving.calls).toEqual([]);
  });

  it("will not move another tenant's entry", async () => {
    const moving = withAgent(() => ({ status: 'moved' }));
    const mine = await mkdir(orgA, shareA, null, 'tas-gizli');
    await expect(
      moving.files.move(
        orgB,
        mine.id,
        { id: shareB, name: 'files-b' },
        { parentId: null },
        userB,
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

    const renamed = await renaming.files.rename(
      orgA,
      file.id,
      'b.txt',
      shareRefA(),
      userA,
      'cid',
      'test',
    );

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
      renaming.files.rename(orgA, file.id, 'degisti.txt', shareRefA(), userA, 'cid', 'test'),
    ).rejects.toBeInstanceOf(AgentRefusedError);

    const after = await files.find(orgA, file.id);
    expect(after.name).toBe('sabit.txt');
    expect(after.path).toBe('/sabit.txt');
  });

  it('renames a FOLDER through the agent too, now that a folder has a directory', async () => {
    // The exception that used to live here, and why it is gone. A folder had no directory on disk,
    // so a folder rename skipped the agent and changed the row alone. `CreateDirectory` ended that:
    // a folder made today HAS a directory, and renaming only the row would leave it — and its whole
    // subtree — sitting under the old name, visible over SMB and unreachable through DEPSIS.
    const renaming = withAgent(() => ({ status: 'moved' }));
    const folder = await mkdir(orgA, shareA, null, 'klasor-eski');

    const renamed = await renaming.files.rename(
      orgA,
      folder.id,
      'klasor-yeni',
      shareRefA(),
      userA,
      'cid',
      'test',
    );

    expect(renamed.name).toBe('klasor-yeni');
    expect(renaming.calls).toEqual([
      { op: 'move_entry', share: 'files-a', from: ['klasor-eski'], to: ['klasor-yeni'] },
    ]);
  });

  it('says the folder is not on disk, rather than accusing the database of being wrong', async () => {
    // A folder created before `CreateDirectory` existed is a row with no directory behind it, so
    // `open_dir` inside the agent fails with ENOENT the moment either end of a move runs through
    // one. The move tries to materialise it first; this agent refuses that too, which is the case
    // where the answer really has to be reported. It must not be "the filesystem does not have
    // this entry where the database says it is" — that sends whoever reads it hunting a corrupted
    // database that is in fact correct.
    const moving = withAgent(() => ({ status: 'not_found', reason: 'hedef: no such entry' }));
    const destination = await mkdir(orgA, shareA, null, 'disk-yok-hedef');
    const file = await files.recordPublishedFile(orgA, shareA, null, 'tasinan.txt', 4, null);

    await expect(
      moving.files.move(
        orgA,
        file.id,
        shareRefA(),
        { parentId: destination.id },
        userA,
        'cid',
        'test',
      ),
    ).rejects.toBeInstanceOf(FolderNotOnDiskError);

    // The row did not move. The agent is asked first precisely so that a failure here costs
    // nothing but the answer.
    expect((await files.find(orgA, file.id)).parent_id).toBeNull();
  });

  it('says the same about a folder moved at the share root, where no path names a folder', async () => {
    // The case the component counts alone would miss: `from` and `to` are both one component, so
    // nothing in the paths betrays a folder — the ENTRY is the folder, and it is the thing with no
    // directory. The materialisation attempt covers it by pushing `from` itself onto the chain
    // list; here the agent refuses that too, so the error stands.
    const moving = withAgent(() => ({ status: 'not_found', reason: 'kok: no such entry' }));
    const folder = await mkdir(orgA, shareA, null, 'kok-klasor');

    await expect(
      moving.files.move(
        orgA,
        folder.id,
        shareRefA(),
        { parentId: null, name: 'kok-klasor-yeni' },
        userA,
        'cid',
        'test',
      ),
    ).rejects.toBeInstanceOf(FolderNotOnDiskError);

    expect((await files.find(orgA, folder.id)).name).toBe('kok-klasor');
  });

  // ─── publishing ─────────────────────────────────────────────────────────────

  it("hands the agent the uploader's own uid, not the service account's", async () => {
    // Until now every published file was owned by the process that served the request. The agent's
    // refusal of uid 0 was written for exactly this and could not catch it, because the API's own
    // uid is not 0: the file landed, looked fine, and belonged to a service account inside a
    // tenant's share — where the tenant cannot chmod it, cannot delete it over SMB, and cannot be
    // billed for it against their own quota.
    const publishing = withAgent(() => ({ status: 'publish', bytes: 7 }));
    const uid = await new PosixIdentityService(db).posixUidFor(orgA, userA);

    const bytes = await publishing.files.publish(
      'files-a',
      'staging-name',
      ['rapor.pdf'],
      7,
      uid,
      uid,
      'cid',
      'test',
    );

    expect(bytes).toBe(7);
    expect(publishing.calls).toEqual([
      {
        op: 'publish_transfer',
        share: 'files-a',
        staging_name: 'staging-name',
        destination: ['rapor.pdf'],
        expected_bytes: 7,
        owner_uid: uid,
        owner_gid: uid,
      },
    ]);
    // Not 0, which the agent refuses, and inside the range migration 0015 reserved.
    expect(uid).toBeGreaterThanOrEqual(300000);
    expect(uid).toBeLessThanOrEqual(399999);
  });

  it('creates the destination directory of an older folder and publishes on the retry', async () => {
    // Uploading into a folder that predates `CreateDirectory`. The bytes are staged, the row is
    // fine, and the only thing missing is the directory the file is meant to land in — refusing
    // there would make every pre-existing folder permanently unusable as an upload target.
    const script: Record<string, unknown>[] = [];
    const publishing = withAgent((request) => {
      script.push(request);
      if (request['op'] === 'create_directory') return { status: 'directory_created' };
      return script.filter((c) => c['op'] === 'publish_transfer').length === 1
        ? { status: 'not_found', reason: 'files-a/eski: no such directory' }
        : { status: 'publish', bytes: 3 };
    });

    const bytes = await publishing.files.publish(
      'files-a',
      'staging-2',
      ['eski', 'not.txt'],
      3,
      300001,
      300001,
      'cid',
      'test',
    );

    expect(bytes).toBe(3);
    expect(script.map((c) => c['op'])).toEqual([
      'publish_transfer',
      'create_directory',
      'publish_transfer',
    ]);
    expect(script[1]).toMatchObject({ path: ['eski'] });
  });

  // ─── permanent deletion ─────────────────────────────────────────────────────

  it('refuses to permanently delete something that is not in the trash', async () => {
    const purging = withAgent(() => ({ status: 'removed' }));
    const entry = await mkdir(orgA, shareA, null, 'copte-degil');

    await expect(
      purging.files.purge(orgA, entry.id, shareRefA(), 'cid', 'test'),
    ).rejects.toBeInstanceOf(NotTrashedError);

    expect(purging.calls).toEqual([]);
    expect((await files.find(orgA, entry.id)).id).toBe(entry.id);
  });

  it('deletes a folder from the leaves up and leaves no row behind', async () => {
    const purging = withAgent(() => ({ status: 'removed' }));
    const root = await mkdir(orgA, shareA, null, 'kalici-kok');
    const middle = await mkdir(orgA, shareA, root.id, 'kalici-orta');
    const deep = await mkdir(orgA, shareA, middle.id, 'kalici-derin');
    const sibling = await mkdir(orgA, shareA, root.id, 'kalici-kardes');
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
    const root = await mkdir(orgA, shareA, null, 'ulasilamaz-kok');
    const child = await mkdir(orgA, shareA, root.id, 'ulasilamaz-alt');
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
    const root = await mkdir(orgA, shareA, null, 'yarim-kok');
    const first = await mkdir(orgA, shareA, root.id, 'yarim-bir');
    const second = await mkdir(orgA, shareA, root.id, 'yarim-iki');
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
    const folder = await mkdir(orgA, shareA, null, 'yukleme-hedefi');
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
    const mine = await mkdir(orgA, shareA, null, 'kalici-gizli');
    await files.trash(orgA, mine.id, userA);

    await expect(
      purging.files.purge(orgB, mine.id, { id: shareB, name: 'files-b' }, 'cid', 'test'),
    ).rejects.toBeInstanceOf(EntryNotFoundError);

    expect(purging.calls).toEqual([]);
    expect((await files.find(orgA, mine.id)).id).toBe(mine.id);
  });
});

/**
 * §6.2, enforced — against a real PostgreSQL and through the real handlers.
 *
 * The controllers are constructed directly rather than driven over HTTP, which is deliberate:
 * what has to be proved here is that EVERY endpoint asks the question, and the way that breaks is
 * a handler somebody forgot to change. A test of `FilesService.effectiveAt` alone would pass
 * against a controller that never called it — which is exactly the state this round found the
 * code in, with a hard-coded seven-permission constant in every response.
 *
 * Everything runs in its own organisation, and `beforeEach` empties its grants. Two of the facts
 * below are about a share with NO grant rows at all — the compatibility fallback in
 * `files.service.ts` — and a row left behind by an earlier test would silently make them assert
 * the opposite of what they say.
 */
describeDb('§6.2 permissions, enforced by the file endpoints', () => {
  let pdb: DbService;
  let powner: DbService;
  let pfiles: FilesService;
  let controller: FilesController;
  let search: SearchController;
  let uploads: UploadsController;
  let agentCalls: Record<string, unknown>[] = [];

  let org = '';
  let share = '';
  let admin = '';
  let alice = '';
  let bob = '';
  let team = '';
  let sequence = 0;

  /** The three operations these tests provoke, recorded so a refusal can be shown to precede them. */
  const permissionsAgent = {
    isAvailable: () => true,
    call: (request: Record<string, unknown>) => {
      agentCalls.push(request);
      switch (request['op']) {
        case 'create_directory':
          return Promise.resolve({ status: 'directory_created' });
        case 'move_entry':
          return Promise.resolve({ status: 'moved' });
        case 'remove_entry':
          return Promise.resolve({ status: 'removed' });
        default:
          return Promise.reject(new Error(`no fixture answers '${String(request['op'])}'`));
      }
    },
  } as unknown as AgentService;

  const callerFor = (userId: string, isOrganizationAdmin = false): Caller => ({
    organizationId: org,
    userId,
    isOrganizationAdmin,
  });

  beforeAll(async () => {
    pdb = new DbService(APP_URL as string);
    await pdb.onModuleInit();
    powner = new DbService(OWNER_URL as string);

    await powner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name) VALUES ('files-p','Files P')
         ON CONFLICT (slug) DO NOTHING`,
      );
      org =
        (
          await q.query<{ id: string }>(
            `SELECT id::text AS id FROM organizations WHERE slug = 'files-p'`,
          )
        )[0]?.id ?? '';

      await q.query(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1,'pyonetici','admin','x'), ($1,'pali','member','x'), ($1,'pbora','member','x')
         ON CONFLICT DO NOTHING`,
        [org],
      );
      const found = await q.query<{ id: string; username: string }>(
        `SELECT id::text AS id, username FROM users WHERE organization_id = $1`,
        [org],
      );
      admin = found.find((u) => u.username === 'pyonetici')?.id ?? '';
      alice = found.find((u) => u.username === 'pali')?.id ?? '';
      bob = found.find((u) => u.username === 'pbora')?.id ?? '';

      team =
        (
          await q.query<{ id: string }>(
            `INSERT INTO teams (organization_id, name) VALUES ($1, 'Muhasebe')
             RETURNING id::text AS id`,
            [org],
          )
        )[0]?.id ?? '';
      await q.query(
        `INSERT INTO team_members (organization_id, team_id, user_id) VALUES ($1, $2, $3)`,
        [org, team, alice],
      );
    });

    pfiles = new FilesService(
      pdb,
      permissionsAgent,
      new PosixIdentityService(pdb),
      new JobsService(pdb),
    );
    share = (await pfiles.defaultShare(org, 'files-p')).id;
    // A real retention service over the same pool: the trash listing reads the policy to work out
    // each row's expiry, and stubbing it would make that read untested in the one suite that lists
    // the bin.
    controller = new FilesController(
      pfiles,
      stubData,
      new TrashRetentionService(pdb, pfiles),
      new ThumbnailsService(pfiles, stubData),
      new AuditService(pdb),
    );
    search = new SearchController(pfiles);
    uploads = new UploadsController(
      pdb,
      pfiles,
      permissionsAgent,
      stubUploadData,
      new PosixIdentityService(pdb),
      // Yalnız `freeName`/`entryNamed` için: bu süit çakışma çözümünü ölçmüyor, ama kurucu
      // imzası eksiksiz olmalı.
      {} as unknown as CopyService,
    );
  });

  beforeEach(async () => {
    agentCalls = [];
    await powner.withoutTenant('migration-status', (q) =>
      q.query(`DELETE FROM folder_grants WHERE organization_id = $1`, [org]),
    );
  });

  afterAll(async () => {
    if (powner !== undefined) {
      await powner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM audit_events WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM upload_sessions WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM folder_grants WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM team_members WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM teams WHERE organization_id = $1`, [org]);
        await q.query(
          `DELETE FROM file_entries WHERE organization_id = $1 AND parent_id IS NOT NULL`,
          [org],
        );
        await q.query(`DELETE FROM file_entries WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM shares WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM users WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM organizations WHERE id = $1`, [org]);
      });
      await powner.onModuleDestroy();
    }
    await pdb?.onModuleDestroy();
  });

  const shareRef = (): ShareRef => ({ id: share, name: 'files-p' });

  /** A session, as `SessionGuard` would have left it on the request. */
  const as = (userId: string, role: 'admin' | 'member' = 'member'): AuthenticatedRequest =>
    ({
      depsis: {
        sessionId: randomUUID(),
        organizationId: org,
        userId,
        role,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    }) as unknown as AuthenticatedRequest;

  const folder = (parentId: string | null, name?: string): Promise<FileEntryRow> =>
    pfiles.createFolder(
      org,
      shareRef(),
      parentId,
      name ?? `k${(sequence += 1)}`,
      admin,
      'cid-perm',
      'fixture',
    );

  /**
   * One grant row, written through the tenant connection so that RLS has to admit it too.
   *
   * `entryId` null is the share root, exactly as the column means it. Delete-then-insert because
   * the uniqueness that stops a second row for the same principal is a pair of partial expression
   * indexes, which `ON CONFLICT` cannot infer from a column list.
   */
  const grantTo = async (
    principal: { user?: string; team?: string },
    entryId: string | null,
    permissions: readonly string[],
  ): Promise<void> => {
    await pdb.withTenant(org, async (q) => {
      await q.query(
        `DELETE FROM public.folder_grants
          WHERE organization_id = $1 AND share_id = $2
            AND COALESCE(entry_id, share_id) = COALESCE($3::uuid, $2::uuid)
            AND user_id IS NOT DISTINCT FROM $4::uuid
            AND team_id IS NOT DISTINCT FROM $5::uuid`,
        [org, share, entryId, principal.user ?? null, principal.team ?? null],
      );
      await q.query(
        `INSERT INTO public.folder_grants
           (organization_id, share_id, entry_id, user_id, team_id, permissions)
         VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid, $6::text[]::public.folder_permission[])`,
        [org, share, entryId, principal.user ?? null, principal.team ?? null, permissions],
      );
    });
  };

  const names = async (request: AuthenticatedRequest, parentId?: string): Promise<string[]> =>
    (await controller.list(request, parentId, undefined, '100', undefined)).items.map(
      (item) => item.name,
    );

  const sorted = (permissions: ReadonlySet<Permission>): string[] => [...permissions].sort();

  // ─── no grant, no access ────────────────────────────────────────────────────
  //
  // There used to be two tests here, and they asserted the opposite: `LEGACY_OPEN_SHARE` handed
  // every member of the tenant seven permissions while a share had no grant rows at all. That
  // exception is gone — every share now carries a root grant from the moment it exists, written
  // by `SharesService.create`, by `FilesService.defaultShare`, or by migration 0016 for the rows
  // that predate all of it — so what is left is ADR-0021 with no exception in it. These are the
  // replacements, and they measure the rule in the direction that matters: what a member who was
  // never named actually gets.

  it('reaches a SECOND share, which was unreachable over HTTP until the id could be named', async () => {
    // THE BUG THIS CLOSES. Every file route resolved its share through `shareOf`, which is
    // `ORDER BY created_at LIMIT 1` — the first share, always. So `POST /shares` could open one,
    // Samba could publish it, and nothing in the web app could ever list it: there was no way to
    // say which share a request was about. A share you can create and cannot open is worse than no
    // share administration at all, because the product tells you it worked.
    const second = await pdb.withTenant(org, (q) =>
      q.query<{ id: string }>(
        `INSERT INTO public.shares (organization_id, name, dataset)
         VALUES ($1, 'ikinci', 'tank/depsis/ikinci') RETURNING id::text AS id`,
        [org],
      ),
    );
    const secondId = second[0]?.id ?? '';
    // Every share carries a root grant; this one is the administrator's, as `POST /shares` writes.
    await pdb.withTenant(org, (q) =>
      q.query(
        `INSERT INTO public.folder_grants
           (organization_id, share_id, entry_id, user_id, permissions)
         VALUES ($1,$2,NULL,$3,'{list,read,create,modify,move,delete}')`,
        [org, secondId, alice],
      ),
    );

    const inSecond = await pdb.withTenant(org, (q) =>
      q.query<{ id: string }>(
        `INSERT INTO public.file_entries (organization_id, share_id, parent_id, kind, name, path)
         VALUES ($1,$2,NULL,'folder','ikincideki','/ikincideki') RETURNING id::text AS id`,
        [org, secondId],
      ),
    );
    const folderId = inSecond[0]?.id ?? '';

    // The default share does not contain it, and naming no share still means the default — which
    // is what keeps every client written before this parameter existed working unchanged.
    expect(await names(as(alice))).not.toContain('ikincideki');

    // Named, it is there.
    const page = await controller.list(as(alice), undefined, undefined, '100', undefined, secondId);
    expect(page.items.map((item) => item.name)).toContain('ikincideki');

    // And a per-entry route reaches it WITHOUT being told the share: the row carries `share_id`,
    // so `detail` resolves it from the entry. Before this it resolved the default share, the
    // ancestor walk found no chain rooted there, and the answer was 404 — every entry outside the
    // first share unreachable, however wide its grants.
    expect((await controller.detail(as(alice), stubResponse(), folderId)).name).toBe('ikincideki');

    await pdb.withTenant(org, async (q) => {
      await q.query(`DELETE FROM public.file_entries WHERE id = $1`, [folderId]);
      await q.query(`DELETE FROM public.folder_grants WHERE share_id = $1`, [secondId]);
      await q.query(`DELETE FROM public.shares WHERE id = $1`, [secondId]);
    });
  });

  it('refuses a share id belonging to somebody else with the same answer as one that is made up', async () => {
    // A 403 here, or a distinguishable error, would turn the parameter into an oracle for which
    // share ids exist on the appliance.
    const madeUp = '00000000-0000-4000-8000-000000000000';
    await expect(
      controller.list(as(alice), undefined, undefined, '100', undefined, madeUp),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('shows a member nothing in a share whose grants do not name them', async () => {
    const made = await folder(null, 'adi-gecmeyen');

    // Alice is named at the root; Bob is not named anywhere. Under the old fallback this share
    // was open to both of them until somebody wrote the first grant, and writing it took access
    // away from Bob without anyone intending to. Now Bob simply never had it.
    await grantTo({ user: alice }, null, ['list', 'read']);

    expect(await names(as(alice))).toContain('adi-gecmeyen');
    expect(await names(as(bob))).toEqual([]);
    // 404 and not 403: a node a caller cannot `list` must not be confirmed to exist. That is the
    // same rule every other endpoint here applies, and it is why the listing above is empty
    // rather than full of rows with no permissions on them.
    await expect(controller.detail(as(bob), stubResponse(), made.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('queues an ACL re-apply when a folder moves, because its inherited grants changed', async () => {
    const genis = await folder(null, 'tasima-genis');
    const dar = await folder(null, 'tasima-dar');
    const tasinan = await folder(genis.id, 'tasinan');

    await pdb.withTenant(org, (q) =>
      q.query(`DELETE FROM public.job_queue WHERE organization_id = $1 AND kind = $2`, [
        org,
        'permissions.apply',
      ]),
    );

    await pfiles.move(org, tasinan.id, shareRef(), { parentId: dar.id }, admin, 'cid-move', 'test');

    // ADR-0021 resolves from the ancestor chain, and a move REPLACES the chain — so this folder
    // answers differently on the very next request. On disk nothing happened: `renameat2` keeps a
    // directory's access and default ACLs, and POSIX default-ACL inheritance only runs at create
    // time, so the subtree arrives still carrying what the old parent's grants produced. Without
    // this job the divergence is permanent and reachable over SMB.
    const queued = await pdb.withTenant(org, (q) =>
      q.query<{ payload: { shareId: string; entryId: string | null }; max_attempts: number }>(
        `SELECT payload, max_attempts FROM public.job_queue
          WHERE organization_id = $1 AND kind = 'permissions.apply'`,
        [org],
      ),
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload.shareId).toBe(share);
    // The MOVED node, not the share root: the walk writes its whole subtree and resolves it
    // against the full chain above it, which is exactly the scope that changed.
    expect(queued[0]?.payload.entryId).toBe(tasinan.id);
    expect(queued[0]?.max_attempts).toBeGreaterThan(5);
  });

  it('queues nothing when a FILE moves, because a file carries no ACL of ours', async () => {
    const hedef = await folder(null, 'dosya-hedefi');
    const dosya = await pdb.withTenant(org, (q) =>
      q.query<{ id: string }>(
        `INSERT INTO public.file_entries (organization_id, share_id, parent_id, kind, name, path)
         VALUES ($1,$2,NULL,'file','tasinacak.txt','/tasinacak.txt') RETURNING id::text AS id`,
        [org, share],
      ),
    );
    const dosyaId = dosya[0]?.id ?? '';

    await pdb.withTenant(org, (q) =>
      q.query(`DELETE FROM public.job_queue WHERE organization_id = $1 AND kind = $2`, [
        org,
        'permissions.apply',
      ]),
    );

    await pfiles.move(
      org,
      dosyaId,
      shareRef(),
      { parentId: hedef.id },
      admin,
      'cid-move-2',
      'test',
    );

    // Permissions are set on FOLDERS and a file inherits the one it sits in — `NotAFolderError`
    // says so at the endpoint. There is no per-file ACL for DEPSIS to rewrite, so queuing a job
    // here would be work that provably changes nothing.
    const queued = await pdb.withTenant(org, (q) =>
      q.query<{ id: string }>(
        `SELECT id::text AS id FROM public.job_queue
          WHERE organization_id = $1 AND kind = 'permissions.apply'`,
        [org],
      ),
    );
    expect(queued).toHaveLength(0);
  });

  it('leaves an organisation administrator reaching everything without a grant of their own', async () => {
    const made = await folder(null, 'yonetici-gorur');
    await grantTo({ user: alice }, null, ['list', 'read']);

    // §6.1's hierarchy, not a row. Worth pinning beside the test above because the two together
    // are what make the removal safe to ship: taking the fallback away could have locked an
    // appliance's own administrator out of a share nobody had granted them, and it does not.
    const page = await controller.list(as(admin, 'admin'), undefined, undefined, '100', undefined);
    expect(page.items.map((item) => item.name)).toContain('yonetici-gorur');
    expect(
      (await controller.detail(as(admin, 'admin'), stubResponse(), made.id)).permissions,
    ).toContain('manage');
  });

  // ─── the inheritance rule ───────────────────────────────────────────────────

  it('lets the nearest grant narrow an ancestor, for that principal only', async () => {
    const top = await folder(null, 'genis');
    const sub = await folder(top.id, 'dar');

    await grantTo({ user: alice }, null, ['list', 'read', 'download', 'modify', 'delete']);
    await grantTo({ user: alice }, sub.id, ['list', 'read']);

    expect(sorted(await pfiles.effectiveAt(callerFor(alice), share, top.id))).toEqual([
      'delete',
      'download',
      'list',
      'modify',
      'read',
    ]);
    expect(sorted(await pfiles.effectiveAt(callerFor(alice), share, sub.id))).toEqual([
      'list',
      'read',
    ]);

    // And the narrowing is real at the endpoint, not merely in the reported set.
    await expect(
      controller.update(as(alice), stubResponse(), sub.id, { name: 'yeni' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('unions across principals, so a narrow personal grant cannot clip a wide team one', async () => {
    const top = await folder(null, 'ekip-genis');
    const sub = await folder(top.id, 'kisi-dar');

    await grantTo({ team }, null, ['list', 'read', 'download', 'modify']);
    await grantTo({ user: alice }, sub.id, ['list']);

    // Alice's own nearest grant at `sub` is the narrow one; her team's nearest is still the root.
    // ADR-0021 unions them, because being put in a second team must never take anything away.
    expect(sorted(await pfiles.effectiveAt(callerFor(alice), share, sub.id))).toEqual([
      'download',
      'list',
      'modify',
      'read',
    ]);
    // Bora is in no team and has no grant anywhere.
    expect(sorted(await pfiles.effectiveAt(callerFor(bob), share, sub.id))).toEqual([]);
  });

  // ─── hiding, and 404 versus 403 ─────────────────────────────────────────────

  it('hides the rows a caller cannot list, names and all', async () => {
    const open = await folder(null, 'acik-klasor');
    const closed = await folder(null, 'gizli-maas-bilgileri');
    await grantTo({ user: alice }, open.id, ['list', 'read']);

    const listed = await names(as(alice));
    expect(listed).toContain('acik-klasor');
    expect(listed).not.toContain('gizli-maas-bilgileri');
    // The id is not a way round it either: a name is information on its own.
    await expect(controller.detail(as(alice), stubResponse(), closed.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('answers 404 for an entry the listing hid, and 403 for one it showed', async () => {
    const readable = await pfiles.recordPublishedFile(org, share, null, 'gorunur.bin', 4, null);
    const hidden = await pfiles.recordPublishedFile(org, share, null, 'gorunmez.bin', 4, null);
    await grantTo({ user: alice }, readable.id, ['list', 'read']);

    // Visible, but `download` was not granted: 403 is the honest answer, and a 404 would be one
    // the caller could disprove by listing the folder.
    await expect(
      controller.content(as(alice), stubResponse(), readable.id, undefined, undefined),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Not visible at all: 403 here would hand back exactly the fact the listing withheld.
    await expect(
      controller.content(as(alice), stubResponse(), hidden.id, undefined, undefined),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to list inside a folder the caller cannot see', async () => {
    const parent = await folder(null, 'kapali-ust');
    await folder(parent.id, 'icerik');
    await grantTo({ user: bob }, null, ['list']);
    // Narrowed AT the parent, so the root grant no longer reaches it for him.
    await grantTo({ user: bob }, parent.id, ['read']);

    await expect(
      controller.list(as(bob), parent.id, undefined, '50', undefined),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ─── one permission per endpoint ────────────────────────────────────────────

  it('needs create in the parent to make a folder there', async () => {
    const parent = await folder(null, 'olustur-hedef');
    await grantTo({ user: alice }, parent.id, ['list', 'read']);
    await grantTo({ user: bob }, parent.id, ['list', 'read', 'create']);

    await expect(
      controller.createFolder(as(alice), { parentId: parent.id, name: 'olmaz' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const made = await controller.createFolder(as(bob), { parentId: parent.id, name: 'olur' });
    expect(made.name).toBe('olur');
    // The new folder inherits its parent's grant, and the response says so rather than guessing.
    expect(made.permissions).toEqual(['list', 'read', 'create']);
  });

  it('needs modify to rename and delete to trash', async () => {
    const entry = await folder(null, 'yeniden-adlandir');
    await grantTo({ user: alice }, entry.id, ['list', 'read']);

    await expect(
      controller.update(as(alice), stubResponse(), entry.id, { name: 'olmaz' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.trash(as(alice), entry.id)).rejects.toBeInstanceOf(ForbiddenException);

    await grantTo({ user: alice }, entry.id, ['list', 'read', 'modify', 'delete']);
    expect(
      (await controller.update(as(alice), stubResponse(), entry.id, { name: 'olur' })).name,
    ).toBe('olur');
    expect((await controller.trash(as(alice), entry.id)).id).toBe(entry.id);
  });

  it('checks BOTH ends of a move', async () => {
    const from = await folder(null, 'kaynak');
    const to = await folder(null, 'hedef');
    const moving = await folder(from.id, 'tasinan');

    // `move` where it is, nothing where it is going.
    await grantTo({ user: alice }, null, ['list']);
    await grantTo({ user: alice }, moving.id, ['list', 'move']);
    await grantTo({ user: alice }, to.id, ['list', 'read']);
    await expect(
      controller.update(as(alice), stubResponse(), moving.id, { parentId: to.id }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // `create` where it is going, no `move` where it is.
    await grantTo({ user: alice }, moving.id, ['list', 'read']);
    await grantTo({ user: alice }, to.id, ['list', 'create']);
    await expect(
      controller.update(as(alice), stubResponse(), moving.id, { parentId: to.id }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Neither refusal reached the agent, so neither of them moved anything.
    expect(agentCalls.filter((call) => call['op'] === 'move_entry')).toEqual([]);

    await grantTo({ user: alice }, moving.id, ['list', 'move']);
    const moved = await controller.update(as(alice), stubResponse(), moving.id, {
      parentId: to.id,
    });
    expect(moved.parentId).toBe(to.id);
    expect(agentCalls.filter((call) => call['op'] === 'move_entry')).toHaveLength(1);
  });

  it('answers 404, not 403, when the destination of a move is invisible', async () => {
    const to = await folder(null, 'gizli-hedef');
    const moving = await folder(null, 'tasinacak');
    await grantTo({ user: alice }, moving.id, ['list', 'move']);

    // A 403 here would say "that folder exists and you may not put things in it", which is more
    // than the listing was willing to say about it.
    await expect(
      controller.update(as(alice), stubResponse(), moving.id, { parentId: to.id }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('needs download for the bytes even when the row is readable', async () => {
    const file = await pfiles.recordPublishedFile(org, share, null, 'indirilebilir.bin', 9, null);
    await grantTo({ user: alice }, file.id, ['list', 'read', 'download']);
    // The permission passes and the request then fails on the ABSENT data socket, which is what
    // shows the check is not what stopped it.
    await expect(
      controller.content(as(alice), stubResponse(), file.id, undefined, undefined),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('needs create in the parent to restore, and delete to purge', async () => {
    const parent = await folder(null, 'geri-al-ust');
    const entry = await folder(parent.id, 'geri-alinan');
    await pfiles.trash(org, entry.id, admin);

    await grantTo({ user: alice }, parent.id, ['list', 'read']);
    await grantTo({ user: alice }, entry.id, ['list', 'read', 'delete']);
    await expect(controller.restore(as(alice), entry.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    await grantTo({ user: alice }, parent.id, ['list', 'read', 'create']);
    expect((await controller.restore(as(alice), entry.id)).id).toBe(entry.id);

    await pfiles.trash(org, entry.id, admin);
    await grantTo({ user: alice }, entry.id, ['list', 'read']);
    await expect(controller.purge(as(alice), entry.id)).rejects.toBeInstanceOf(ForbiddenException);
    // Refused before the agent was asked, so nothing left the disk.
    expect(agentCalls.filter((call) => call['op'] === 'remove_entry')).toEqual([]);

    await grantTo({ user: alice }, entry.id, ['list', 'read', 'delete']);
    await controller.purge(as(alice), entry.id);
    expect(agentCalls.filter((call) => call['op'] === 'remove_entry')).toHaveLength(1);
  });

  // ─── an operation on a subtree is not an operation on one node ──────────────
  //
  // ADR-0021 has no deny, so the ONLY way to say "less here" is a narrower grant on a descendant.
  // Trash and permanent delete both act on a whole subtree, and both used to be authorized by one
  // resolution on the entry the caller named — which is exactly the grant the model was extended
  // to make writable, ignored.

  it('refuses a permanent delete that reaches a folder narrowed out from under the caller', async () => {
    const top = await folder(null, 'silinecek-ust');
    const secret = await folder(top.id, 'daraltilmis');
    await grantTo({ user: alice }, top.id, ['list', 'read', 'delete']);
    // Alice's nearest grant AT `secret` is this one, so her `delete` from `top` does not reach it.
    await grantTo({ user: alice }, secret.id, ['list', 'read']);

    // Named directly, the refusal already worked.
    await pfiles.trash(org, secret.id, admin);
    await expect(controller.purge(as(alice), secret.id)).rejects.toBeInstanceOf(ForbiddenException);
    await pfiles.restore(org, secret.id);

    // Through the parent it did not: `delete` resolved at `top`, the walk picked up `secret`, and
    // the bytes went. Irreversibly.
    await pfiles.trash(org, top.id, admin);
    await expect(controller.purge(as(alice), top.id)).rejects.toBeInstanceOf(ForbiddenException);
    expect(agentCalls.filter((call) => call['op'] === 'remove_entry')).toEqual([]);

    // The message counts what it refused and does not name it — a refusal that listed the hidden
    // folders would hand back what the narrowing was for.
    await expect(controller.purge(as(alice), top.id)).rejects.toThrow(/1 folder/);

    // Widen the descendant and the same call goes through, so it is the grant that is refusing and
    // not the shape of the tree.
    await grantTo({ user: alice }, secret.id, ['list', 'read', 'delete']);
    await controller.purge(as(alice), top.id);
    expect(agentCalls.filter((call) => call['op'] === 'remove_entry')).toHaveLength(2);
  });

  it('refuses trashing a folder whose descendant the caller may not delete', async () => {
    const top = await folder(null, 'cope-gidecek');
    const secret = await folder(top.id, 'cope-gitmeyecek');
    await grantTo({ user: alice }, top.id, ['list', 'read', 'delete']);
    await grantTo({ user: alice }, secret.id, ['list', 'read']);

    // Reversible, but not harmless: trashing sets one flag and `list` filters on it, so every
    // descendant disappears from every listing for EVERYBODY — including the one Alice was
    // deliberately narrowed out of.
    await expect(controller.trash(as(alice), top.id)).rejects.toBeInstanceOf(ForbiddenException);
    expect((await pfiles.find(org, top.id)).trashed_at).toBeNull();

    await grantTo({ user: alice }, secret.id, ['list', 'read', 'delete']);
    expect((await controller.trash(as(alice), top.id)).id).toBe(top.id);
  });

  // Klasör indirme aynı sınıftan: `tar` kök yetkiyle koşuyor ve alt ağacın tamamını okuyor, yani
  // yalnız klasörün kendisine bakan bir denetim, çağıranın indirme hakkı OLMAYAN bir alt klasörü
  // arşivin içine koyardı. Sızıntı silme kadar geri döndürülemez: baytlar karşı tarafa gitti.

  it('refuses archiving a folder whose descendant the caller may not download', async () => {
    const top = await folder(null, 'arsivlenecek');
    const secret = await folder(top.id, 'arsive-girmeyecek');
    await grantTo({ user: alice }, top.id, ['list', 'read', 'download']);
    await grantTo({ user: alice }, secret.id, ['list', 'read']);

    const response = {} as unknown as Response;
    await expect(controller.archive(as(alice), response, top.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    // Alt ağaç açıldığında aynı çağrı yetkiden DEĞİL, veri yuvasının kapalı olmasından düşüyor —
    // yani reddi yapan şey ağacın şekli değil, hibenin kendisiydi.
    await grantTo({ user: alice }, secret.id, ['list', 'read', 'download']);
    await expect(controller.archive(as(alice), response, top.id)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('lets an untouched subtree through, so the check costs nothing where nothing was narrowed', async () => {
    const top = await folder(null, 'duz-agac');
    await folder(top.id, 'alt-bir');
    await folder(top.id, 'alt-iki');
    await grantTo({ user: alice }, null, ['list', 'read', 'delete']);

    // No descendant carries a grant of its own, so every one of them resolves to exactly what
    // `top` resolves to and there is nothing to refuse.
    expect((await controller.trash(as(alice), top.id)).id).toBe(top.id);
  });

  it('refuses a user id where an entry id belongs, which is how the clash flow broke', async () => {
    // ── YEDİNCİ ARGÜMAN ───────────────────────────────────────────────────────────────────
    //
    // `recordPublishedFile`ın son parametresi `copiedFromEntryId` ve `file_entries(id)`e yabancı
    // anahtar. Ad çakışmasını çözen uç bir süre oraya `session.userId` geçiriyordu: her çakışma
    // çözümü 23503 ile düşüyordu — üstelik dosya ajan tarafından paylaşıma YAYIMLANDIKTAN sonra.
    // Kullanıcı hata görüyordu, yeni dosya diskteydi, "değiştir" seçildiyse eskisi çöpteydi, ve
    // DEPSIS'in dizininde ikisi de yoktu.
    //
    // Ölçülen şey KISITIN KENDİSİ. Yanlış argümanı geçen çağrı yolunun düzeltildiğini tip sistemi
    // söyleyemez — iki alan da `string` — ama veritabanı söyleyebilir, ve söylediğini burada
    // yazıya döküyoruz: bir kullanıcı kimliği bu alana giremez.
    await expect(
      pfiles.recordPublishedFile(org, share, null, 'yanlis-kaynak.txt', 4, null, admin),
    ).rejects.toThrow();

    // Ve kontrol: aynı çağrı `null` ile geçiyor. Çakışmayı çözen bir yükleme bir kopya değil,
    // kullanıcının gönderdiği yeni bir dosya — alanın söylemesi gereken şey bu.
    const entry = await pfiles.recordPublishedFile(
      org,
      share,
      null,
      'dogru-kaynak.txt',
      4,
      null,
      null,
    );
    expect(entry.name).toBe('dogru-kaynak.txt');
  });

  it('needs create in the destination folder to begin an upload', async () => {
    const parent = await folder(null, 'yukleme-hedefi-p');
    await grantTo({ user: alice }, parent.id, ['list', 'read']);

    const metadata = `filename ${b64('rapor.pdf')},parentId ${b64(parent.id)}`;
    await expect(uploads.create(as(alice), stubResponse(), '10', metadata)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    await grantTo({ user: alice }, parent.id, ['list', 'read', 'create']);
    await expect(
      uploads.create(as(alice), stubResponse(), '10', metadata),
    ).resolves.toBeUndefined();
  });

  it("will not let one member drive another member's upload session", async () => {
    const parent = await folder(null, 'benim-yuklemem');
    await grantTo({ user: alice }, parent.id, ['list', 'read', 'create']);
    // Bora has no `create` here at all, which is the point: the §6.2 check happens once, at POST,
    // so whoever sends the chunks has to be the account that check was made for.
    await grantTo({ user: bob }, parent.id, ['list', 'read']);

    const recorded = recordingResponse();
    await uploads.create(
      as(alice),
      recorded.response,
      '10',
      `filename ${b64('gizli.bin')},parentId ${b64(parent.id)}`,
    );
    const location = recorded.headers.get('Location') ?? '';
    const uploadId = location.slice(location.lastIndexOf('/') + 1);
    expect(uploadId).not.toBe('');

    // 404 and not 403 on both routes: an upload id is not something one member should be able to
    // confirm about another. Completing it would have published into a folder Bora cannot write
    // to, stamped with HIS posix uid.
    await expect(uploads.status(as(bob), stubResponse(), uploadId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      uploads.sendChunk(as(bob), stubResponse(), uploadId, '0', '10'),
    ).rejects.toBeInstanceOf(NotFoundException);

    // The owner still reaches her own session.
    await expect(uploads.status(as(alice), stubResponse(), uploadId)).resolves.toBeUndefined();
  });

  it('answers 404 for a malformed parentId in tus metadata, not 500', async () => {
    // `Upload-Metadata` is caller-supplied text and reaches an `id = $2` against a `uuid` column.
    // Unvalidated it came back as SQLSTATE 22P02 that nothing maps — a 500 for a bad link, and one
    // that also tells a caller their id was malformed rather than someone else's.
    await expect(
      uploads.create(
        as(alice),
        stubResponse(),
        '10',
        `filename ${b64('x.bin')},parentId ${b64('x')}`,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('hides the rows a caller cannot list from SEARCH as well as from the tree', async () => {
    const open = await folder(null, 'arama-acik');
    await folder(null, 'arama-gizli');
    await grantTo({ user: alice }, open.id, ['list', 'read']);

    const hits = await search.search(as(alice), 'arama', undefined, undefined, '50');
    expect(hits.items.map((item) => item.name)).toEqual(['arama-acik']);
  });

  // ─── the one exception ──────────────────────────────────────────────────────

  it('lets the organisation administrator past every one of these', async () => {
    const closed = await folder(null, 'yoneticiye-acik');
    const file = await pfiles.recordPublishedFile(org, share, closed.id, 'ic.bin', 3, null);
    // A grant that names only Alice, on the root — so the walk itself grants the administrator
    // nothing at all.
    await grantTo({ user: alice }, null, ['list']);

    expect(await names(as(admin, 'admin'))).toContain('yoneticiye-acik');
    const detail = await controller.detail(as(admin, 'admin'), stubResponse(), file.id);
    // Every one of §6.2's eleven, which is what ADR-0021 §5 means by "reaches everything".
    expect(detail.permissions).toHaveLength(11);
    expect(detail.permissions).toContain('manage');
    expect((await controller.trash(as(admin, 'admin'), file.id)).id).toBe(file.id);
  });

  it('keeps the administrator whole even where a narrow grant names them personally', async () => {
    const sub = await folder(null, 'dar-yonetici');
    // The trap a root-level synthetic grant would fall into: nearest-ancestor per principal would
    // let this row win over it and cancel §6.1's hierarchy.
    await grantTo({ user: admin }, sub.id, ['list']);
    expect((await pfiles.effectiveAt(callerFor(admin, true), share, sub.id)).size).toBe(11);
  });
});

/** The data socket, absent. Every test above that reaches it is asserting that it got that far. */
const stubData = { isAvailable: () => false } as unknown as AgentDataService;

/** `UploadsController` refuses every request when the data socket is down, before it checks
 * anything else — so the upload test needs one that claims to be there and is never used. */
const stubUploadData = { isAvailable: () => true } as unknown as AgentDataService;

/** An Express response that keeps its headers, for the one test that needs the `Location` back. */
const recordingResponse = (): { response: Response; headers: Map<string, string> } => {
  const headers = new Map<string, string>();
  return {
    headers,
    response: {
      setHeader: (name: string, value: string) => headers.set(name, value),
      status: () => undefined,
      end: () => undefined,
    } as unknown as Response,
  };
};

/** An Express response that swallows headers; nothing here asserts on them. */
const stubResponse = (): Response =>
  ({
    setHeader: () => undefined,
    status: () => undefined,
    end: () => undefined,
  }) as unknown as Response;

const b64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64');
