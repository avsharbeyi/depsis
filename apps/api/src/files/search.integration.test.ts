import { HttpException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentService } from '../agent/agent.service.js';
import type { AuthenticatedRequest } from '../auth/session.guard.js';
import { DbService } from '../db/db.service.js';
import { PosixIdentityService } from '../identity/posix.service.js';
import { FilesService } from './files.service.js';
import { SearchController } from './search.controller.js';

/**
 * `GET /search`, at the controller rather than at the service.
 *
 * `FilesService.search` is already covered by `files.integration.test.ts` — normalisation, ranking,
 * the keyset cursor. None of that is what this file is about. The controller adds four decisions on
 * top of the query, and until now nothing measured any of them: an empty `q` is refused rather than
 * answered with the whole share, an over-long `q` is refused rather than truncated, a `limit` is
 * clamped rather than refused, and a `scope` the caller cannot see is "no such folder" rather than
 * an empty page.
 *
 * Against a real database rather than a stubbed service, because two of those four are decisions
 * ABOUT the query: proving that `limit=0` falls back to a page of 50 means counting rows that came
 * back, and a stub would return whatever it was told to.
 *
 * Skipped unless `DEPSIS_TEST_DATABASE_URL` and `DEPSIS_TEST_OWNER_DATABASE_URL` point at a
 * migrated database. The skip is visible: a gated test that silently passes is not a test.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];

const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

/**
 * Nothing here touches bytes, but the fixtures do reach the agent.
 *
 * Creating a folder is a filesystem operation now — the agent is asked first and the row is written
 * only if it agrees — and every search below needs folders to search. So `create_directory` is
 * answered and everything else still rejects, which keeps "no test here moves bytes" true.
 */
const fixtureAgent = {
  isAvailable: () => true,
  call: (request: Record<string, unknown>) =>
    request['op'] === 'create_directory'
      ? Promise.resolve({ status: 'directory_created' })
      : Promise.reject(new Error('no test here should move bytes')),
} as unknown as AgentService;

/** The controller's default page, and its ceiling. Restated so a drift in either one fails here. */
const DEFAULT_LIMIT = 50;

/** One more than the default, so "50 back" distinguishes the default from "everything". */
const SEEDED = DEFAULT_LIMIT + 1;

describeDb('GET /search, at the controller', () => {
  let db: DbService;
  let owner: DbService;
  let files: FilesService;
  let search: SearchController;

  let orgA = '';
  let orgB = '';
  let userA = '';
  let userB = '';
  let shareA = '';
  let folderB = '';

  /**
   * A folder, made the way the product makes one: the agent first, the row second.
   *
   * `createFolder` needs a share the agent can name and an acting user whose uid stamps the
   * directory. Neither is what this file is about, so both live here.
   */
  const mkdir = (
    organizationId: string,
    shareId: string,
    shareName: string,
    name: string,
  ): Promise<{ id: string }> =>
    files.createFolder(
      organizationId,
      { id: shareId, name: shareName },
      null,
      name,
      organizationId === orgA ? userA : userB,
      'cid-fixture',
      'fixture',
    );

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name)
         VALUES ('search-a','Search A'), ('search-b','Search B')
         ON CONFLICT (slug) DO NOTHING`,
      );
      const orgs = await q.query<{ slug: string; id: string }>(
        `SELECT slug, id::text AS id FROM organizations WHERE slug IN ('search-a','search-b')`,
      );
      orgA = orgs.find((r) => r.slug === 'search-a')?.id ?? '';
      orgB = orgs.find((r) => r.slug === 'search-b')?.id ?? '';

      const seeded = await q.query<{ username: string; id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1, 'search-ayse', 'member', 'x'),
                ($2, 'search-bora', 'member', 'x')
         RETURNING username, id::text AS id`,
        [orgA, orgB],
      );
      userA = seeded.find((r) => r.username === 'search-ayse')?.id ?? '';
      userB = seeded.find((r) => r.username === 'search-bora')?.id ?? '';
    });

    files = new FilesService(db, fixtureAgent, new PosixIdentityService(db));
    search = new SearchController(files);

    shareA = (await files.shareOf(orgA)).id;
    const shareB = (await files.shareOf(orgB)).id;

    // 51 matching names, so a page of 50 is visibly a page rather than the whole set.
    for (let i = 0; i < SEEDED; i += 1) {
      await mkdir(orgA, shareA, 'search-a', `kayit-${String(i).padStart(2, '0')}`);
    }
    // Something that must NOT match, so a query that returned everything would fail rather than
    // pass by accident.
    await mkdir(orgA, shareA, 'search-a', 'baskabirsey');

    folderB = (await mkdir(orgB, shareB, 'search-b', 'onlarin-klasoru')).id;
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
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

  function signedIn(): AuthenticatedRequest {
    return {
      depsis: { organizationId: orgA, userId: userA, role: 'member' },
    } as unknown as AuthenticatedRequest;
  }

  async function statusOf(call: Promise<unknown>): Promise<number> {
    try {
      await call;
    } catch (error) {
      if (error instanceof HttpException) return error.getStatus();
      throw error;
    }
    throw new Error('the call was expected to be refused and was not');
  }

  it('answers 422 for an absent, empty or whitespace-only q', async () => {
    // Three spellings of the same mistake, and the third is the one a bare `.length === 0` misses:
    // `depsis_norm` does not trim, so a query of spaces would reach the database and match nothing
    // while looking to the caller like a search that ran.
    expect(await statusOf(search.search(signedIn()))).toBe(422);
    expect(await statusOf(search.search(signedIn(), ''))).toBe(422);
    expect(await statusOf(search.search(signedIn(), '   '))).toBe(422);
  });

  it('answers 422 for a q past the 256-character cap rather than truncating it', async () => {
    // Refusal is the contract's answer and also the honest one: a silently shortened query returns
    // hits that do not contain what was typed, with nothing saying so.
    expect(await statusOf(search.search(signedIn(), 'k'.repeat(257)))).toBe(422);
    // And the boundary itself is accepted, so the cap is a cap rather than an off-by-one.
    await expect(search.search(signedIn(), 'k'.repeat(256))).resolves.toBeDefined();
  });

  it('trims the query before running it, so a padded search still finds its rows', async () => {
    const page = await search.search(signedIn(), '  kayit-00  ');
    expect(page.items.map((i) => i.name)).toContain('kayit-00');
  });

  it('defaults to a page of 50 and says there is more', async () => {
    const page = await search.search(signedIn(), 'kayit');
    expect(page.items).toHaveLength(DEFAULT_LIMIT);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBeDefined();
  });

  it('honours a limit between 1 and the cap', async () => {
    const one = await search.search(signedIn(), 'kayit', undefined, undefined, '1');
    expect(one.items).toHaveLength(1);
    expect(one.hasMore).toBe(true);

    const all = await search.search(signedIn(), 'kayit', undefined, undefined, String(SEEDED));
    expect(all.items).toHaveLength(SEEDED);
    expect(all.hasMore).toBe(false);
    // The excluded name proves the query filtered rather than listed the share.
    expect(all.items.map((i) => i.name)).not.toContain('baskabirsey');
  });

  it('clamps an oversized limit instead of refusing it', async () => {
    // A client asking for a bigger page than the server will build gets the biggest one it will
    // build. Refusing would turn a tuning difference into a broken screen — and this assertion is
    // what says so: the call resolves.
    const page = await search.search(signedIn(), 'kayit', undefined, undefined, '100000');
    expect(page.items).toHaveLength(SEEDED);
    expect(page.hasMore).toBe(false);
  });

  it('falls back to the default for a limit that is not a positive number', async () => {
    for (const raw of ['0', '-5', 'abc', '', '2.9']) {
      const page = await search.search(signedIn(), 'kayit', undefined, undefined, raw);
      // '2.9' is `parseInt`'s 2, not a fallback — the one value in this list that is a real number
      // to the parser. It is here to pin that a fractional limit is floored rather than refused.
      const expected = raw === '2.9' ? 2 : DEFAULT_LIMIT;
      expect(page.items, `limit=${JSON.stringify(raw)}`).toHaveLength(expected);
    }
  });

  it('walks the whole result set with the cursor it hands back', async () => {
    const first = await search.search(signedIn(), 'kayit', undefined, undefined, '30');
    expect(first.hasMore).toBe(true);
    const second = await search.search(signedIn(), 'kayit', undefined, first.nextCursor, '30');
    expect(second.hasMore).toBe(false);

    const seen = new Set([...first.items, ...second.items].map((i) => i.id));
    // No repeats and no gaps: a keyset page that overlaps or skips is the failure mode this
    // pagination shape exists to avoid, and it is invisible in a single page.
    expect(seen.size).toBe(SEEDED);
  });

  it('refuses a cursor this server did not issue', async () => {
    // 400, not 404: the contract says a client never constructs a cursor, only echoes one, so a
    // malformed one is a broken client rather than a missing resource.
    //
    // The document does not publish 400 for this operation — `/search` lists 200 and 422 only, and
    // `components/parameters/Cursor` says nothing about a refusal. That is a contract gap rather
    // than a decision, and it is shared with `/files`, whose `cleanCursor` this route calls; the
    // code is pinned here as it behaves, and the gap is reported rather than papered over by an
    // assertion that accepts either code.
    expect(await statusOf(search.search(signedIn(), 'kayit', undefined, 'not-a-uuid'))).toBe(400);
  });

  it('treats an empty cursor as no cursor, because that is what an unset query parameter is', async () => {
    const page = await search.search(signedIn(), 'kayit', undefined, '');
    expect(page.items).toHaveLength(DEFAULT_LIMIT);
  });

  it('answers 404 for a scope that is not a uuid, before it looks at anything else', async () => {
    expect(await statusOf(search.search(signedIn(), 'kayit', 'not-a-uuid'))).toBe(404);
  });

  it("answers 404 for another tenant's folder rather than an empty page", async () => {
    // An empty page would confirm the id names a folder somewhere, which is the existence oracle
    // row-level security exists to close.
    expect(await statusOf(search.search(signedIn(), 'kayit', folderB))).toBe(404);
  });

  it('answers 404 for a scope in the trash', async () => {
    const folder = await mkdir(orgA, shareA, 'search-a', 'cope-giden');
    await files.trash(orgA, folder.id, userA);
    expect(await statusOf(search.search(signedIn(), 'kayit', folder.id))).toBe(404);
  });
});
