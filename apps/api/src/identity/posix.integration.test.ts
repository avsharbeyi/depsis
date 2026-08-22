import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DbService } from '../db/db.service.js';
import { PosixIdentityService, PosixIdentityUnknownUserError } from './posix.service.js';

/**
 * DEPSIS accounts as the filesystem sees them, against a real PostgreSQL.
 *
 * A fake settles none of this. The uniqueness that matters is an index, the allocation is a
 * `SECURITY DEFINER` function reading two tables across every tenant, the isolation is row-level
 * security, and the failure this suite exists to catch — two accounts handed the same uid — only
 * appears when two transactions run at once. Every one of those is the database's behaviour.
 *
 * Skipped unless `DEPSIS_TEST_DATABASE_URL` points at a migrated database. A gated test that
 * silently passes when its precondition is missing is worse than no test, so the skip is visible.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];

const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

/** Migration 0015's reserved window. Restated here so a change to either end fails this suite. */
const RANGE_LOW = 300000;
const RANGE_HIGH = 399999;

describeDb('POSIX identity, against a real PostgreSQL', () => {
  let db: DbService;
  let owner: DbService;
  let posix: PosixIdentityService;
  let orgA = '';
  let orgB = '';
  let userA = '';
  let userB = '';

  /** Insert an account the way `claim_appliance` does: no `posix_uid`, because it knows of none. */
  const seedUser = async (organizationId: string, username: string): Promise<string> =>
    owner.withoutTenant('migration-status', async (q) => {
      const rows = await q.query<{ id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1, $2, 'member', 'x')
         RETURNING id::text AS id`,
        [organizationId, username],
      );
      return rows[0]?.id ?? '';
    });

  const uidOf = async (organizationId: string, userId: string): Promise<number | null> =>
    owner.withoutTenant('migration-status', async (q) => {
      const rows = await q.query<{ posix_uid: number | null }>(
        `SELECT posix_uid FROM users WHERE organization_id = $1 AND id = $2`,
        [organizationId, userId],
      );
      return rows[0]?.posix_uid ?? null;
    });

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);
    posix = new PosixIdentityService(db);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name)
         VALUES ('posix-a','Posix A'), ('posix-b','Posix B')
         ON CONFLICT (slug) DO NOTHING`,
      );
      const orgs = await q.query<{ slug: string; id: string }>(
        `SELECT slug, id::text AS id FROM organizations WHERE slug IN ('posix-a','posix-b')`,
      );
      orgA = orgs.find((r) => r.slug === 'posix-a')?.id ?? '';
      orgB = orgs.find((r) => r.slug === 'posix-b')?.id ?? '';
    });

    userA = await seedUser(orgA, 'posix-ayse');
    userB = await seedUser(orgB, 'posix-bora');
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM users WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM organizations WHERE id = ANY($1)`, [[orgA, orgB]]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  it('allocates a uid for an account that has none, and writes it', async () => {
    // The lazy path, and the one every appliance in existence needs: the founding administrator is
    // inserted by `claim_appliance`, which predates migration 0015 and writes no `posix_uid`.
    expect(await uidOf(orgA, userA)).toBeNull();

    const uid = await posix.posixUidFor(orgA, userA);

    expect(uid).toBeGreaterThanOrEqual(RANGE_LOW);
    expect(uid).toBeLessThanOrEqual(RANGE_HIGH);
    // Allocated AND persisted, in one transaction. A method that returned a number without writing
    // it would hand the next caller the same one, and two people would own each other's files.
    expect(await uidOf(orgA, userA)).toBe(uid);
  });

  it('gives the same account the same uid every time', async () => {
    // Not merely a cache question. The uid is stamped onto files on disk by `fchown`, so a second
    // allocation for one account would orphan everything the first one owns.
    const first = await posix.posixUidFor(orgA, userA);
    const second = await posix.posixUidFor(orgA, userA);
    expect(second).toBe(first);
  });

  it('never returns 0, which the agent refuses and the filesystem reads as root', async () => {
    // The whole reason this class exists. The agent rejects `owner_uid: 0` on every operation that
    // takes one, and its comment says why: an API that skipped the mapping must fail loudly rather
    // than quietly produce root-owned files inside a tenant's share. Anything below the reserved
    // range would name a system service, which is the same bug with a bigger number.
    const uid = await posix.posixUidFor(orgA, userA);
    expect(uid).not.toBe(0);
    expect(uid).toBeGreaterThanOrEqual(RANGE_LOW);
  });

  it('gives two accounts allocated AT THE SAME MOMENT two different uids', async () => {
    // The failure this suite exists for, and the one a sequential test cannot see.
    // `allocate_posix_id` is `MAX + 1` over two tables and holds nothing while it reads, so two
    // transactions that call it together both observe the same maximum and both return the same
    // number. `Promise.all` on two accounts with no uid is that race, run for real: the pool gives
    // each call its own connection, so the two transactions genuinely overlap.
    const ids = await Promise.all(['posix-es-1', 'posix-es-2'].map((name) => seedUser(orgA, name)));
    const [firstId, secondId] = ids;
    expect(firstId).toBeDefined();
    expect(secondId).toBeDefined();

    const [first, second] = await Promise.all([
      posix.posixUidFor(orgA, firstId as string),
      posix.posixUidFor(orgA, secondId as string),
    ]);

    expect(first).not.toBe(second);
    // And both were kept, rather than one having quietly overwritten the other.
    expect(await uidOf(orgA, firstId as string)).toBe(first);
    expect(await uidOf(orgA, secondId as string)).toBe(second);
  });

  it("will not allocate a uid to another tenant's user: it is simply not there", async () => {
    // The isolation that makes the uid space safe to share across tenants. `posixUidFor` runs the
    // lookup under the CALLER's tenant context, so tenant A naming tenant B's user id finds no row
    // at all — not a refusal that confirms the account exists, and not an allocation spent on
    // somebody else's account.
    expect(await uidOf(orgB, userB)).toBeNull();

    await expect(posix.posixUidFor(orgA, userB)).rejects.toBeInstanceOf(
      PosixIdentityUnknownUserError,
    );

    // Nothing was written. A failed cross-tenant call that still burned an id would be a slow leak
    // of the reserved range and, worse, evidence to the caller that the id names a real account.
    expect(await uidOf(orgB, userB)).toBeNull();
  });

  it('keeps user uids and team gids in one number space, so neither can name the other', async () => {
    // Migration 0015 allocates both from one counter, and that is what lets `createFolder` use a
    // creator's uid as the owning gid: the number cannot be a team's group by accident. Asserted
    // here rather than assumed, because the day the counters are split, that reuse becomes a folder
    // owned by whichever team happens to hold the matching gid.
    const uid = await posix.posixUidFor(orgA, userA);
    const clash = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ n: string }>(`SELECT count(*)::text AS n FROM teams WHERE posix_gid = $1`, [uid]),
    );
    expect(clash[0]?.n).toBe('0');
  });
});
