import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PasswordResetService } from '../auth/password-reset.service.js';
import { DbService } from '../db/db.service.js';

/**
 * The reset ticket, against a real PostgreSQL.
 *
 * Three of the properties this design rests on are properties of the DATABASE and nothing else:
 * that two redemptions racing cannot both win, that a user can never hold two open tickets, and
 * that `resolve_password_reset` answers nothing for an expired, spent, exhausted or
 * disabled-account token without saying which. A fake would report whatever the test wrote.
 *
 * Skipped unless `DEPSIS_TEST_DATABASE_URL` and `DEPSIS_TEST_OWNER_DATABASE_URL` point at a
 * migrated database.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];
const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

describeDb('a password reset ticket', () => {
  let db: DbService;
  let owner: DbService;
  let resets: PasswordResetService;
  let org = '';
  let other = '';
  let admin = '';
  let ayse = '';

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name) VALUES ('reset-a','Reset A'), ('reset-b','Reset B')
         ON CONFLICT (slug) DO NOTHING`,
      );
      const orgs = await q.query<{ slug: string; id: string }>(
        `SELECT slug, id::text AS id FROM organizations WHERE slug IN ('reset-a','reset-b')`,
      );
      org = orgs.find((r) => r.slug === 'reset-a')?.id ?? '';
      other = orgs.find((r) => r.slug === 'reset-b')?.id ?? '';

      await q.query(`DELETE FROM password_resets WHERE organization_id = ANY($1)`, [[org, other]]);
      await q.query(`DELETE FROM users WHERE organization_id = ANY($1)`, [[org, other]]);
      const people = await q.query<{ username: string; id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1, 'reset-admin', 'admin', 'x'), ($1, 'reset-ayse', 'member', 'x')
         RETURNING username, id::text AS id`,
        [org],
      );
      admin = people.find((r) => r.username === 'reset-admin')?.id ?? '';
      ayse = people.find((r) => r.username === 'reset-ayse')?.id ?? '';
    });

    resets = new PasswordResetService(db);
  });

  beforeEach(async () => {
    await owner.withoutTenant('migration-status', (q) =>
      q.query(`DELETE FROM password_resets WHERE organization_id = ANY($1)`, [[org, other]]),
    );
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM password_resets WHERE organization_id = ANY($1)`, [
          [org, other],
        ]);
        await q.query(`DELETE FROM users WHERE organization_id = ANY($1)`, [[org, other]]);
        await q.query(`DELETE FROM organizations WHERE id = ANY($1)`, [[org, other]]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  it('resolves the token it just issued, and nothing else', async () => {
    const issued = await resets.open(org, ayse, admin);

    const resolved = await resets.resolve(issued.token);
    expect(resolved?.userId).toBe(ayse);
    expect(resolved?.organizationId).toBe(org);
    expect(resolved?.attempts).toBe(0);

    // A token that was never issued is indistinguishable from a dead one: both are null.
    expect(await resets.resolve('not-a-token-anybody-issued')).toBeNull();
  });

  it('is spent exactly once', async () => {
    // The property the whole design rests on. If both redemptions could win, the administrator
    // could take the ticket AND the user could still use it, and the theft would stay silent —
    // which is the failure this shape exists to convert into a noisy one.
    const issued = await resets.open(org, ayse, admin);
    const resolved = await resets.resolve(issued.token);
    expect(resolved).not.toBeNull();

    const [first, second] = await Promise.all([
      resets.consume(org, resolved?.resetId ?? ''),
      resets.consume(org, resolved?.resetId ?? ''),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);

    // And it is dead afterwards, so the loser's retry finds nothing rather than a second chance.
    expect(await resets.resolve(issued.token)).toBeNull();
  });

  it('leaves the row behind after it is spent, because the audit needs it', async () => {
    const issued = await resets.open(org, ayse, admin);
    const resolved = await resets.resolve(issued.token);
    await resets.consume(org, resolved?.resetId ?? '');

    const rows = await db.withTenant(org, (q) =>
      q.query<{ user_id: string; created_by: string; consumed: boolean }>(
        `SELECT user_id::text AS user_id, created_by::text AS created_by,
                (consumed_at IS NOT NULL) AS consumed
           FROM public.password_resets WHERE user_id = $1`,
        [ayse],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.created_by).toBe(admin);
    expect(rows[0]?.consumed).toBe(true);
  });

  it('closes the previous ticket when a second is opened', async () => {
    // Two live tickets would mean somebody holding the older one still gets in after the
    // administrator issued a new one — the opposite of what issuing a new one is for. The partial
    // unique index would also refuse the insert.
    const first = await resets.open(org, ayse, admin);
    const second = await resets.open(org, ayse, admin);

    expect(await resets.resolve(first.token)).toBeNull();
    expect((await resets.resolve(second.token))?.userId).toBe(ayse);
  });

  it('stops answering once the attempt budget is gone', async () => {
    // The budget is on the TICKET. A holder who cannot produce the authenticator code is guessing,
    // and burning the ticket is right — locking the account instead would let anybody with a
    // stolen slip deny the real user their own sign-in.
    const issued = await resets.open(org, ayse, admin);
    const resolved = await resets.resolve(issued.token);
    for (let i = 0; i < PasswordResetService.MAX_ATTEMPTS; i += 1) {
      await resets.recordAttempt(org, resolved?.resetId ?? '');
    }
    expect(await resets.resolve(issued.token)).toBeNull();
  });

  it('stops answering once it has expired', async () => {
    const issued = await resets.open(org, ayse, admin);
    await owner.withoutTenant('migration-status', (q) =>
      // `created_at` moves with it: `password_resets_expires_after` refuses a row that expired
      // before it was made, and that constraint is doing its job here rather than getting in the
      // way — an expiry in the past with a creation in the present is not a state that can occur.
      q.query(
        `UPDATE password_resets
            SET created_at = now() - interval '2 hours',
                expires_at = now() - interval '1 minute'
          WHERE user_id = $1`,
        [ayse],
      ),
    );
    expect(await resets.resolve(issued.token)).toBeNull();
  });

  it('refuses a disabled account, so disabling is not undone by a forgotten password', async () => {
    const issued = await resets.open(org, ayse, admin);
    await owner.withoutTenant('migration-status', (q) =>
      q.query(`UPDATE users SET disabled_at = now() WHERE id = $1`, [ayse]),
    );
    expect(await resets.resolve(issued.token)).toBeNull();

    await owner.withoutTenant('migration-status', (q) =>
      q.query(`UPDATE users SET disabled_at = NULL WHERE id = $1`, [ayse]),
    );
  });

  it('is invisible from another tenant', async () => {
    // RLS, not a WHERE clause. The resolver is SECURITY DEFINER and returns the organisation the
    // ticket belongs to; reading the ROW still needs that organisation's context.
    await resets.open(org, ayse, admin);
    const rows = await db.withTenant(other, (q) => q.query(`SELECT 1 FROM public.password_resets`));
    expect(rows).toHaveLength(0);
  });

  it('never lets the raw token reach the database', async () => {
    // SHA-256 of the token is what is stored, so the response from `open` is the only place the
    // value exists. A row that held the token itself would make a database backup a set of live
    // reset links.
    const issued = await resets.open(org, ayse, admin);
    const rows = await db.withTenant(org, (q) =>
      q.query<{ hash: Buffer }>(`SELECT token_hash AS hash FROM public.password_resets`),
    );
    expect(rows[0]?.hash.length).toBe(32);
    expect(rows[0]?.hash.toString('utf8')).not.toContain(issued.token);
  });
});
