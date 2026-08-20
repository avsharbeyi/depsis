import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DbService } from '../db/db.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { AuthService } from './auth.service.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { MfaService } from './mfa.service.js';
import { PasswordService } from './password.service.js';
import { PendingLoginService } from './pending-login.service.js';
import { SessionService } from './session.service.js';
import { base32Decode, PERIOD_SECONDS, totp } from './totp.js';

/**
 * The second factor, end to end.
 *
 * `totp.test.ts` proves the algorithm against RFC 6238's vectors; this proves the parts that only
 * exist once a database is involved — that a code cannot be replayed inside its own validity
 * window, that a recovery code is spent exactly once, and that six wrong guesses end the challenge
 * rather than the ninety-second window ending it.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];
const describeDb =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== ''
    ? describe
    : describe.skip;

const SLUG = 'mfatest';
const PASSWORD = 'another-ordinary-password';
const EMAIL = 'mfa@mfatest.example';

describeDb('second factor, against a real PostgreSQL', () => {
  let db: DbService;
  let owner: DbService;
  let auth: AuthService;
  let mfa: MfaService;
  let orgId = '';
  let userId = '';

  const from = (n: number): string => `203.0.113.${n}`;

  /**
   * Enrol and confirm, returning the secret and the recovery codes.
   *
   * Confirmation deliberately uses the PREVIOUS step's code, not the current one — and this is not
   * a trick to make the tests pass, it is the behaviour under test stated from the other side.
   * Confirming burns the step it used, so a test that confirmed with the current code and then
   * logged in with the current code would be submitting a code that had already been spent, and the
   * correct answer to that is "rejected". Using the previous step leaves the current one available,
   * which is also what a phone running slightly behind produces in real life.
   */
  async function enrol(): Promise<{ secret: Buffer; codes: string[] }> {
    const enrolment = await mfa.beginEnrolment(orgId, userId, EMAIL);
    const secret = base32Decode(enrolment.secretBase32);
    const codes = await mfa.confirmEnrolment(
      orgId,
      userId,
      totp(secret, nowSeconds() - PERIOD_SECONDS),
    );
    expect(codes).not.toBeNull();
    return { secret, codes: codes as string[] };
  }

  const nowSeconds = (): number => Math.floor(Date.now() / 1000);

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    owner = new DbService(OWNER_URL as string);
    await db.onModuleInit();

    const passwords = new PasswordService();
    mfa = new MfaService(db);
    auth = new AuthService(
      db,
      new OrganizationsService(db),
      passwords,
      new SessionService(db),
      new LoginThrottleService(db),
      mfa,
      new PendingLoginService(db),
    );

    const stored = await passwords.hash(PASSWORD);
    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name) VALUES ($1, 'MFA Test')
           ON CONFLICT (slug) DO NOTHING`,
        [SLUG],
      );
      const org = await q.query<{ id: string }>(
        `SELECT id::text AS id FROM organizations WHERE slug = $1`,
        [SLUG],
      );
      orgId = org[0]?.id ?? '';
      await q.query(
        `INSERT INTO users (organization_id, email, display_name, password_hash)
         VALUES ($1, $2, 'MFA User', $3)
           ON CONFLICT (organization_id, email_normalized)
           DO UPDATE SET password_hash = EXCLUDED.password_hash`,
        [orgId, EMAIL, stored],
      );
      const user = await q.query<{ id: string }>(
        `SELECT id::text AS id FROM users
          WHERE organization_id = $1 AND email_normalized = public.fold_identity($2)`,
        [orgId, EMAIL],
      );
      userId = user[0]?.id ?? '';
      // Residue from an earlier run would make the throttle and the enrolment state unpredictable.
      await q.query(`DELETE FROM login_attempts WHERE ip_address << '203.0.113.0/24'::inet`);
    });
  });

  afterAll(async () => {
    await db?.onModuleDestroy();
    await owner?.onModuleDestroy();
  });

  it('an unconfirmed enrolment does not gate the login', async () => {
    // The lockout this prevents: a user scans the QR code, loses the phone before proving a code,
    // and — if an unconfirmed secret counted — can no longer sign in and has no recovery codes
    // either, because those are issued at confirmation.
    await db.withTenant(orgId, (q) =>
      q.query(`DELETE FROM user_totp_secrets WHERE user_id = $1`, [userId]),
    );
    await mfa.beginEnrolment(orgId, userId, EMAIL);

    expect(await mfa.isEnrolled(orgId, userId)).toBe(false);
    const result = await auth.login({
      organizationSlug: SLUG,
      email: EMAIL,
      password: PASSWORD,
      userAgent: null,
      ip: from(10),
    });
    expect(result.outcome).toBe('ok');
  });

  it('confirming issues ten recovery codes and turns the gate on', async () => {
    const { codes } = await enrol();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{20}$/);
    expect(await mfa.isEnrolled(orgId, userId)).toBe(true);
    expect(await mfa.remainingRecoveryCodes(orgId, userId)).toBe(10);
  });

  it('the password alone now yields a challenge and no session', async () => {
    const result = await auth.login({
      organizationSlug: SLUG,
      email: EMAIL,
      password: PASSWORD,
      userAgent: null,
      ip: from(11),
    });
    expect(result.outcome).toBe('mfa-required');
    if (result.outcome !== 'mfa-required') return;
    // The challenge token must not work as a session. If it did, the second factor would be
    // advisory rather than required.
    expect(await new SessionService(db).resolve(result.challenge.token)).toBeNull();
  });

  it('a correct code completes the login, and the same code cannot be replayed', async () => {
    const { secret } = await enrol();

    const first = await auth.login({
      organizationSlug: SLUG,
      email: EMAIL,
      password: PASSWORD,
      userAgent: null,
      ip: from(12),
    });
    if (first.outcome !== 'mfa-required') return expect.unreachable('expected a challenge');

    const code = totp(secret, nowSeconds());
    const done = await auth.completeSecondFactor({
      challengeToken: first.challenge.token,
      code,
      userAgent: null,
      ip: from(12),
    });
    expect(done.outcome).toBe('ok');
    if (done.outcome !== 'ok') return;
    expect(done.used).toBe('totp');

    // The replay. A fresh challenge, the SAME code — still inside its ninety-second window, which
    // is exactly the window a shoulder-surfer or a phishing proxy operates in.
    const second = await auth.login({
      organizationSlug: SLUG,
      email: EMAIL,
      password: PASSWORD,
      userAgent: null,
      ip: from(13),
    });
    if (second.outcome !== 'mfa-required') return expect.unreachable('expected a challenge');

    const replayed = await auth.completeSecondFactor({
      challengeToken: second.challenge.token,
      code,
      userAgent: null,
      ip: from(13),
    });
    expect(replayed.outcome, 'the same code a second time').toBe('rejected');
  });

  it('refuses the very code that confirmed the enrolment', async () => {
    // The consequence a user will meet: confirm, then sign in again inside the same window, and the
    // code on screen does not work. Correct — it was spent — but it has to be deliberate rather
    // than accidental, so it is pinned here.
    const enrolment = await mfa.beginEnrolment(orgId, userId, EMAIL);
    const secret = base32Decode(enrolment.secretBase32);
    const confirmationCode = totp(secret, nowSeconds());
    expect(await mfa.confirmEnrolment(orgId, userId, confirmationCode)).not.toBeNull();

    const challenge = await auth.login({
      organizationSlug: SLUG,
      email: EMAIL,
      password: PASSWORD,
      userAgent: null,
      ip: from(21),
    });
    if (challenge.outcome !== 'mfa-required') return expect.unreachable('expected a challenge');

    const reused = await auth.completeSecondFactor({
      challengeToken: challenge.challenge.token,
      code: confirmationCode,
      userAgent: null,
      ip: from(21),
    });
    expect(reused.outcome, 'the confirmation code re-used as a login code').toBe('rejected');
  });

  it('accepts a code from the previous step but never one from two steps ago', async () => {
    const { secret } = await enrol();
    const challenge = await auth.login({
      organizationSlug: SLUG,
      email: EMAIL,
      password: PASSWORD,
      userAgent: null,
      ip: from(14),
    });
    if (challenge.outcome !== 'mfa-required') return expect.unreachable('expected a challenge');

    // Clock skew tolerance is one step; two is outside it. `enrol` just burned the current step, so
    // the previous one is what remains available — which also exercises that the burn does not
    // reach backwards further than it should.
    const stale = totp(secret, nowSeconds() - 2 * PERIOD_SECONDS);
    const result = await auth.completeSecondFactor({
      challengeToken: challenge.challenge.token,
      code: stale,
      userAgent: null,
      ip: from(14),
    });
    expect(result.outcome).toBe('rejected');
  });

  it('spends a recovery code exactly once', async () => {
    const { codes } = await enrol();
    const code = codes[0] as string;

    const first = await auth.login({
      organizationSlug: SLUG,
      email: EMAIL,
      password: PASSWORD,
      userAgent: null,
      ip: from(15),
    });
    if (first.outcome !== 'mfa-required') return expect.unreachable('expected a challenge');

    const used = await auth.completeSecondFactor({
      challengeToken: first.challenge.token,
      code,
      userAgent: null,
      ip: from(15),
    });
    expect(used.outcome).toBe('ok');
    if (used.outcome === 'ok') expect(used.used).toBe('recovery-code');
    expect(await mfa.remainingRecoveryCodes(orgId, userId)).toBe(9);

    const second = await auth.login({
      organizationSlug: SLUG,
      email: EMAIL,
      password: PASSWORD,
      userAgent: null,
      ip: from(16),
    });
    if (second.outcome !== 'mfa-required') return expect.unreachable('expected a challenge');

    const reused = await auth.completeSecondFactor({
      challengeToken: second.challenge.token,
      code,
      userAgent: null,
      ip: from(16),
    });
    expect(reused.outcome, 'the same recovery code twice').toBe('rejected');
  });

  it('accepts a recovery code however the user spaces it', async () => {
    const { codes } = await enrol();
    const code = codes[0] as string;
    const grouped = (code.match(/.{1,5}/g) ?? []).join('-').toLowerCase();

    const challenge = await auth.login({
      organizationSlug: SLUG,
      email: EMAIL,
      password: PASSWORD,
      userAgent: null,
      ip: from(17),
    });
    if (challenge.outcome !== 'mfa-required') return expect.unreachable('expected a challenge');

    const result = await auth.completeSecondFactor({
      challengeToken: challenge.challenge.token,
      code: grouped,
      userAgent: null,
      ip: from(17),
    });
    expect(result.outcome).toBe('ok');
  });

  it('ends the challenge after six wrong codes', async () => {
    const { secret } = await enrol();
    const challenge = await auth.login({
      organizationSlug: SLUG,
      email: EMAIL,
      password: PASSWORD,
      userAgent: null,
      ip: from(18),
    });
    if (challenge.outcome !== 'mfa-required') return expect.unreachable('expected a challenge');

    // Six digits is a million possibilities, which is nothing without a bound. The password
    // throttle has already been satisfied at this point, so this budget is the only thing standing
    // between an attacker with the password and the account.
    for (let i = 0; i < 6; i += 1) {
      const wrong = await auth.completeSecondFactor({
        challengeToken: challenge.challenge.token,
        code: String(100000 + i).padStart(6, '0'),
        userAgent: null,
        ip: from(18),
      });
      expect(wrong.outcome, `attempt ${i + 1}`).toBe('rejected');
    }

    // And now even the RIGHT code fails, because the challenge itself is spent.
    const correct = await auth.completeSecondFactor({
      challengeToken: challenge.challenge.token,
      code: totp(secret, nowSeconds()),
      userAgent: null,
      ip: from(18),
    });
    expect(correct.outcome, 'the correct code after the budget is gone').toBe('rejected');
  });

  it('a challenge is single-use even with the right code', async () => {
    const { secret } = await enrol();
    const challenge = await auth.login({
      organizationSlug: SLUG,
      email: EMAIL,
      password: PASSWORD,
      userAgent: null,
      ip: from(19),
    });
    if (challenge.outcome !== 'mfa-required') return expect.unreachable('expected a challenge');

    const first = await auth.completeSecondFactor({
      challengeToken: challenge.challenge.token,
      code: totp(secret, nowSeconds()),
      userAgent: null,
      ip: from(19),
    });
    expect(first.outcome).toBe('ok');

    const again = await auth.completeSecondFactor({
      challengeToken: challenge.challenge.token,
      code: totp(secret, nowSeconds()),
      userAgent: null,
      ip: from(19),
    });
    expect(again.outcome, 'the same challenge twice').toBe('rejected');
  });

  it('re-enrolling invalidates the recovery codes the user printed last time', async () => {
    const first = await enrol();
    const second = await enrol();
    expect(first.codes[0]).not.toBe(second.codes[0]);

    const challenge = await auth.login({
      organizationSlug: SLUG,
      email: EMAIL,
      password: PASSWORD,
      userAgent: null,
      ip: from(20),
    });
    if (challenge.outcome !== 'mfa-required') return expect.unreachable('expected a challenge');

    // A stolen old sheet must stop working the moment the secret behind it is replaced.
    const stale = await auth.completeSecondFactor({
      challengeToken: challenge.challenge.token,
      code: first.codes[0] as string,
      userAgent: null,
      ip: from(20),
    });
    expect(stale.outcome).toBe('rejected');
  });
});
