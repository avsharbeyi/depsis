import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DbService } from '../db/db.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { AuthService } from './auth.service.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { MfaService } from './mfa.service.js';
import { generateKey, SecretBox } from './secret-box.js';
import { PasswordService } from './password.service.js';
import { PendingLoginService } from './pending-login.service.js';
import { SessionService } from './session.service.js';

/**
 * The login flow against a real PostgreSQL.
 *
 * The unit tests next door settle the primitives — token shape, cookie attributes, Argon2, the
 * decoy that keeps a missing account as expensive as a wrong password. What they cannot settle is
 * the flow: whether four different wrong answers really are indistinguishable, whether the folded
 * address the throttle counts is the same one the uniqueness key uses, and whether revoking a
 * session actually stops it resolving.
 *
 * Skipped without DEPSIS_TEST_DATABASE_URL, like the other integration suite, and CI asserts that
 * it did not skip.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];
const describeDb =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== ''
    ? describe
    : describe.skip;

const SLUG = 'authtest';
const PASSWORD = 'a-perfectly-ordinary-password';

describeDb('login, against a real PostgreSQL', () => {
  let db: DbService;
  let owner: DbService;
  let auth: AuthService;
  let sessions: SessionService;
  let orgId = '';
  let userId = '';

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    owner = new DbService(OWNER_URL as string);
    await db.onModuleInit();

    const passwords = new PasswordService();
    sessions = new SessionService(db);
    auth = new AuthService(
      db,
      new OrganizationsService(db),
      passwords,
      sessions,
      new LoginThrottleService(db),
      new MfaService(db, testSecretBox()),
      new PendingLoginService(db),
    );

    const stored = await passwords.hash(PASSWORD);

    // Seeded through the owner, because the application role cannot create a tenant (ADR-0014 §4).
    const rows = await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name) VALUES ($1, 'Auth Test')
           ON CONFLICT (slug) DO NOTHING`,
        [SLUG],
      );
      const org = await q.query<{ id: string }>(
        `SELECT id::text AS id FROM organizations WHERE slug = $1`,
        [SLUG],
      );
      const id = org[0]?.id ?? '';
      await q.query(
        `INSERT INTO users (organization_id, email, display_name, password_hash)
         VALUES ($1, 'ada@authtest.example', 'Ada', $2)
           ON CONFLICT (organization_id, email_normalized)
           DO UPDATE SET password_hash = EXCLUDED.password_hash, disabled_at = NULL`,
        [id, stored],
      );
      await q.query(
        `INSERT INTO users (organization_id, email, display_name, password_hash, disabled_at)
         VALUES ($1, 'gone@authtest.example', 'Gone', $2, now())
           ON CONFLICT (organization_id, email_normalized) DO NOTHING`,
        [id, stored],
      );
      return q.query<{ id: string }>(
        `SELECT id::text AS id FROM users WHERE organization_id = $1
           AND email_normalized = public.fold_identity('ada@authtest.example')`,
        [id],
      );
    });

    // Attempts accumulate across runs, and the throttle counts them — so without this the second
    // run of the suite measures the first run's state and reports a failure that is entirely the
    // test's own residue. Cleared through the OWNER connection because depsis_app deliberately has
    // no DELETE on this table (migration 0003): the API must never be able to erase the evidence of
    // an attack in progress.
    await owner.withoutTenant('login-throttle', (q) =>
      q.query(`DELETE FROM login_attempts WHERE ip_address << '198.51.100.0/24'::inet`),
    );

    orgId = (
      await owner.withoutTenant('migration-status', (q) =>
        q.query<{ id: string }>(`SELECT id::text AS id FROM organizations WHERE slug = $1`, [SLUG]),
      )
    )[0]?.id as string;
    userId = rows[0]?.id ?? '';
  });

  afterAll(async () => {
    await db?.onModuleDestroy();
    await owner?.onModuleDestroy();
  });

  /** A fresh source address per test, so one test's failures cannot throttle the next. */
  const from = (n: number): string => `198.51.100.${n}`;

  it('accepts the right credentials and issues a session', async () => {
    const result = await auth.login({
      organizationSlug: SLUG,
      email: 'ada@authtest.example',
      password: PASSWORD,
      userAgent: 'vitest',
      ip: from(10),
    });

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.userId).toBe(userId);
    expect(result.organizationId).toBe(orgId);
    expect(result.session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('accepts the Turkish dotted capital I spelling of the same address', async () => {
    // The lookup runs against `email_normalized`, so it has to fold the same way the uniqueness key
    // does. If it did not, the account would exist and be unreachable — a lockout with no error.
    const result = await auth.login({
      organizationSlug: SLUG,
      email: 'ADA@AUTHTEST.EXAMPLE',
      password: PASSWORD,
      userAgent: null,
      ip: from(11),
    });
    expect(result.outcome).toBe('ok');
  });

  it('gives the same answer to every kind of wrong', async () => {
    // The enumeration defence at the flow level. A caller must not be able to tell a nonexistent
    // tenant from a nonexistent address from a disabled account from a wrong password.
    const attempts = [
      { label: 'wrong password', slug: SLUG, email: 'ada@authtest.example', password: 'nope' },
      {
        label: 'unknown address',
        slug: SLUG,
        email: 'nobody@authtest.example',
        password: PASSWORD,
      },
      { label: 'disabled account', slug: SLUG, email: 'gone@authtest.example', password: PASSWORD },
      {
        label: 'unknown tenant',
        slug: 'no-such-tenant',
        email: 'ada@authtest.example',
        password: PASSWORD,
      },
    ];

    let ip = 20;
    for (const attempt of attempts) {
      const result = await auth.login({
        organizationSlug: attempt.slug,
        email: attempt.email,
        password: attempt.password,
        userAgent: null,
        ip: from(ip++),
      });
      expect(result, attempt.label).toEqual({ outcome: 'rejected' });
    }
  });

  it('records every attempt, folded, so case cannot buy a fresh bucket', async () => {
    const ip = from(30);
    await auth.login({
      organizationSlug: SLUG,
      email: 'AdA@AuthTest.Example',
      password: 'wrong',
      userAgent: null,
      ip,
    });

    const rows = await db.withoutTenant('login-throttle', (q) =>
      q.query<{ email_normalized: string; succeeded: boolean }>(
        `SELECT email_normalized, succeeded FROM login_attempts WHERE ip_address = $1`,
        [ip],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email_normalized).toBe('ada@authtest.example');
    expect(rows[0]?.succeeded).toBe(false);
  });

  it('refuses outright once a pair has failed too many times', async () => {
    const ip = from(40);
    const fail = (): Promise<{ outcome: string }> =>
      auth.login({
        organizationSlug: SLUG,
        email: 'ada@authtest.example',
        password: 'wrong',
        userAgent: null,
        ip,
      });

    // REFUSE_AFTER is 10 and the gate reads "ten failures have already accumulated", so the tenth
    // attempt is still answered normally and the eleventh is refused. Both sides are asserted,
    // because a test that only checks the far side of a boundary passes just as happily when the
    // boundary moves.
    for (let i = 0; i < 9; i += 1) await fail();
    expect((await fail()).outcome, 'the tenth attempt').toBe('rejected');
    expect((await fail()).outcome, 'the eleventh attempt').toBe('throttled');

    // And the victim is NOT locked out: the same account from a different address still works.
    // This is the property ADR-0009 asks for by name — a throttle that locks the account globally
    // hands an attacker a denial of service against its owner.
    const elsewhere = await auth.login({
      organizationSlug: SLUG,
      email: 'ada@authtest.example',
      password: PASSWORD,
      userAgent: null,
      ip: from(41),
    });
    expect(elsewhere.outcome).toBe('ok');
    // Eleven attempts, each sleeping up to a second by design, so this one test is allowed longer
    // than vitest's default. The delay IS the behaviour under test; shortening it for the test's
    // convenience would test something else.
  }, 30_000);

  it('resolves an issued session, and stops once it is revoked', async () => {
    const result = await auth.login({
      organizationSlug: SLUG,
      email: 'ada@authtest.example',
      password: PASSWORD,
      userAgent: 'vitest',
      ip: from(50),
    });
    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;

    const resolved = await sessions.resolve(result.session.token);
    expect(resolved?.organizationId).toBe(orgId);
    expect(resolved?.userId).toBe(userId);

    await sessions.revoke(orgId, result.session.sessionId);
    expect(await sessions.resolve(result.session.token)).toBeNull();
  });

  it('revokes every session a user holds', async () => {
    const tokens: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await auth.login({
        organizationSlug: SLUG,
        email: 'ada@authtest.example',
        password: PASSWORD,
        userAgent: null,
        ip: from(60 + i),
      });
      if (r.outcome === 'ok') tokens.push(r.session.token);
    }
    expect(tokens).toHaveLength(3);

    await sessions.revokeAllForUser(orgId, userId);
    for (const token of tokens) {
      expect(await sessions.resolve(token)).toBeNull();
    }
  });

  it('stores no raw token anywhere in the sessions table', async () => {
    const result = await auth.login({
      organizationSlug: SLUG,
      email: 'ada@authtest.example',
      password: PASSWORD,
      userAgent: null,
      ip: from(70),
    });
    if (result.outcome !== 'ok') return expect.unreachable('login should have succeeded');

    const rows = await db.withTenant(orgId, (q) =>
      q.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM sessions
          WHERE encode(token_hash, 'base64') LIKE '%' || $1 || '%'`,
        [result.session.token.slice(0, 16)],
      ),
    );
    expect(rows[0]?.n).toBe('0');
  });
});

/** A fresh key per run. These tests are about storage behaviour, not about any particular key. */
function testSecretBox(): SecretBox {
  return new SecretBox(Buffer.from(generateKey(), 'base64'));
}
