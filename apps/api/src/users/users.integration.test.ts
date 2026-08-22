import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DbService } from '../db/db.service.js';
import {
  UsernameTakenError,
  LastAdminError,
  UserNotFoundError,
  UsersService,
} from './users.service.js';

/**
 * Accounts and the organisation-level role, against a real PostgreSQL.
 *
 * The reason this suite matters more than its size suggests: §20 forbids starting Phase 2 until the
 * ACCESS-CONTROL acceptance tests pass, and until migration 0009 an appliance had exactly one
 * account and no way to make another — so "an unauthorised user is refused" could not be written,
 * let alone run. This is the half of that gate that lives in the database.
 *
 * The last-administrator rule in particular cannot be settled by a fake. It is a trigger, it is
 * about a row other than the one being written, and the concurrency it exists for is two writers
 * in two transactions.
 *
 * Skipped unless `DEPSIS_TEST_DATABASE_URL` points at a migrated database.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];

const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

describeDb('accounts and roles, against a real PostgreSQL', () => {
  let db: DbService;
  let owner: DbService;
  let users: UsersService;
  let orgA = '';
  let orgB = '';
  let adminA = '';

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);
    users = new UsersService(db);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name)
         VALUES ('users-a','Users A'), ('users-b','Users B')
         ON CONFLICT (slug) DO NOTHING`,
      );
      const orgs = await q.query<{ slug: string; id: string }>(
        `SELECT slug, id::text AS id FROM organizations WHERE slug IN ('users-a','users-b')`,
      );
      orgA = orgs.find((r) => r.slug === 'users-a')?.id ?? '';
      orgB = orgs.find((r) => r.slug === 'users-b')?.id ?? '';

      // The founding administrator, seeded the way `claim_system_setup` would.
      const seeded = await q.query<{ id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1, 'kurucu', 'admin', 'x')
         RETURNING id::text AS id`,
        [orgA],
      );
      adminA = seeded[0]?.id ?? '';
    });
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM sessions WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM users WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM organizations WHERE id = ANY($1)`, [[orgA, orgB]]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  it('creates a second account, which the box could not do before', async () => {
    const created = await users.create(orgA, 'ikinci', 'member', 'hash');
    expect(created.role).toBe('member');
    expect(created.disabled_at).toBeNull();

    const all = await users.list(orgA);
    expect(all.map((u) => u.username)).toContain('ikinci');
  });

  it('refuses a duplicate address the way the folding rules say, not the way the string does', async () => {
    await users.create(orgA, 'Ayse', 'member', 'hash');
    // Case and the Turkish i-family fold for uniqueness; accents do NOT. `fold_identity` is the
    // authority and this asserts the API sees its decision as a 409 rather than a 500.
    await expect(
      users.create(orgA, 'AYSE', 'member', 'h'),
    ).rejects.toBeInstanceOf(UsernameTakenError);
  });

  it('lets the same address exist in another organization', async () => {
    // A global UNIQUE(email) would leak across tenants: the uniqueness check bypasses RLS, so a
    // refusal here would tell tenant B that tenant A has that address (P0-C measured it).
    await expect(
      users.create(orgB, 'ikinci', 'member', 'hash'),
    ).resolves.toBeTruthy();
  });

  it("does not let one tenant read or change another tenant's account", async () => {
    const theirs = await users.create(orgB, 'onlarin', 'member', 'hash');
    await expect(users.find(orgA, theirs.id)).rejects.toBeInstanceOf(UserNotFoundError);
    await expect(users.update(orgA, theirs.id, { role: 'admin' })).rejects.toBeInstanceOf(
      UserNotFoundError,
    );

    // And it really is unchanged, read back through its own tenant.
    expect((await users.find(orgB, theirs.id)).role).toBe('member');
  });

  it('promotes and demotes, and refuses to remove the last administrator', async () => {
    // The founding admin is alone at this point in orgA.
    await expect(users.update(orgA, adminA, { role: 'member' })).rejects.toBeInstanceOf(
      LastAdminError,
    );
    await expect(users.update(orgA, adminA, { disabled: true })).rejects.toBeInstanceOf(
      LastAdminError,
    );

    // With a second administrator the same change is allowed — the rule is about the count, not
    // about the founder.
    const second = await users.create(orgA, 'yonetici2', 'admin', 'h');
    const demoted = await users.update(orgA, adminA, { role: 'member' });
    expect(demoted.role).toBe('member');

    // And now the second one is alone and cannot go either.
    await expect(users.update(orgA, second.id, { role: 'member' })).rejects.toBeInstanceOf(
      LastAdminError,
    );

    // Put it back, so the rest of the suite starts from a sane organisation.
    await users.update(orgA, adminA, { role: 'admin' });
  });

  it('counts only ENABLED administrators towards the rule', async () => {
    // A disabled administrator cannot sign in, so treating them as one of the remaining admins
    // would let an organisation reach zero usable administrators while the count said one.
    const spare = await users.create(orgA, 'yedek', 'admin', 'h');
    await users.update(orgA, spare.id, { disabled: true });

    const another = await users.list(orgA);
    const enabledAdmins = another.filter((u) => u.role === 'admin' && u.disabled_at === null);
    expect(enabledAdmins.length).toBeGreaterThanOrEqual(1);

    // With `spare` disabled, demoting every enabled administrator down to one must still refuse.
    const enabled = enabledAdmins.map((u) => u.id);
    for (const id of enabled.slice(0, -1)) {
      await users.update(orgA, id, { role: 'member' });
    }
    const last = enabled[enabled.length - 1] as string;
    await expect(users.update(orgA, last, { role: 'member' })).rejects.toBeInstanceOf(
      LastAdminError,
    );
  });

  it('disables and re-enables an account', async () => {
    const user = await users.create(orgA, 'kapanacak', 'member', 'h');
    const off = await users.update(orgA, user.id, { disabled: true });
    expect(off.disabled_at).not.toBeNull();

    const on = await users.update(orgA, user.id, { disabled: false });
    expect(on.disabled_at).toBeNull();
  });

  it("stops a disabled account's existing sessions immediately", async () => {
    // The hole this closes is a live cookie outliving the decision to disable an account. It is
    // shut inside `resolve_session` — which joins `users` and checks `disabled_at` — rather than by
    // the API remembering to revoke, so it holds for a session issued a second before the change.
    const user = await users.create(orgA, 'oturumlu', 'member', 'h');
    const digest = Buffer.from('0'.repeat(64), 'hex');
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO sessions (organization_id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + interval '1 hour')`,
        [orgA, user.id, digest],
      ),
    );

    const before = await db.withoutTenant('resolve-session', (q) =>
      q.query(`SELECT 1 FROM public.resolve_session($1)`, [digest]),
    );
    expect(before).toHaveLength(1);

    await users.update(orgA, user.id, { disabled: true });

    const after = await db.withoutTenant('resolve-session', (q) =>
      q.query(`SELECT 1 FROM public.resolve_session($1)`, [digest]),
    );
    expect(after).toHaveLength(0);
  });

  it('hands the role back with the session, and the value tracks the account', async () => {
    // Two queries would be two moments: an administrator demoted between them would still be
    // treated as one for the request already in flight.
    //
    // Self-contained on purpose. An earlier version asserted on the founding admin and failed
    // because the test above had legitimately demoted them — a test that depends on the order it
    // runs in is a test that will fail for a reason nobody is looking for.
    const user = await users.create(orgA, 'rollu', 'member', 'h');
    const digest = Buffer.from('2'.repeat(64), 'hex');
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO sessions (organization_id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + interval '1 hour')`,
        [orgA, user.id, digest],
      ),
    );

    const asMember = await db.withoutTenant('resolve-session', (q) =>
      q.query<{ role: string }>(`SELECT role FROM public.resolve_session($1)`, [digest]),
    );
    expect(asMember[0]?.role).toBe('member');

    // Promoted, and the SAME session now resolves as an administrator. That is what makes the role
    // a property of the account rather than of the cookie: a demotion takes effect on the next
    // request instead of at the next sign-in.
    await users.update(orgA, user.id, { role: 'admin' });
    const asAdmin = await db.withoutTenant('resolve-session', (q) =>
      q.query<{ role: string }>(`SELECT role FROM public.resolve_session($1)`, [digest]),
    );
    expect(asAdmin[0]?.role).toBe('admin');
  });
});
