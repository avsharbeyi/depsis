import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DbService, type TenantQuery } from '../db/db.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { MfaService } from './mfa.service.js';
import { PasswordService } from './password.service.js';
import {
  generateKey,
  KEY_VERSION_AES_GCM,
  KEY_VERSION_PLAINTEXT,
  SecretBox,
  SecretKeyUnavailableError,
} from './secret-box.js';
import { base32Decode, totp } from './totp.js';

/**
 * What the database actually holds, and what happens to what it already held.
 *
 * secret-box.test.ts settles the cryptography against no database at all. This settles the claims
 * that only a real table can settle: that the bytes in the column are not the secret, that a row
 * written by migration 0004 is upgraded in place the first time it is used, that the schema refuses
 * a row that lies about which form it is in, and that a sealed secret cannot be moved onto another
 * user's row — which is the attack the associated data exists for, and which is only interesting
 * because UPDATE on this table is a thing an attacker might have.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];
const describeDb =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== ''
    ? describe
    : describe.skip;

const SLUG = 'atrest';

describeDb('TOTP secrets at rest', () => {
  let db: DbService;
  let owner: DbService;
  let orgId = '';
  let alice = '';
  let bob = '';
  const key = Buffer.from(generateKey(), 'base64');

  /** Read the raw column, bypassing the service entirely. This is the attacker's view. */
  async function storedRow(userId: string): Promise<{ secret: Buffer; key_version: number }> {
    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ secret: Buffer; key_version: number }>(
        'SELECT secret, key_version FROM user_totp_secrets WHERE user_id = $1',
        [userId],
      ),
    );
    const row = rows[0];
    expect(row, `no stored row for ${userId}`).toBeDefined();
    return row as { secret: Buffer; key_version: number };
  }

  beforeAll(async () => {
    db = new DbService(APP_URL ?? '');
    owner = new DbService(OWNER_URL ?? '');
    const organizations = new OrganizationsService(db);
    const passwords = new PasswordService();

    await owner.withoutTenant('migration-status', async (q) => {
      await removeFixture(q);
      const [org] = await q.query<{ id: string }>(
        `INSERT INTO public.organizations (name, slug) VALUES ($1, $2) RETURNING id::text AS id`,
        ['At Rest', SLUG],
      );
      orgId = org?.id ?? '';
      const hash = await passwords.hash('an-ordinary-password-here');
      for (const name of ['alice', 'bob']) {
        const [user] = await q.query<{ id: string }>(
          `INSERT INTO public.users (organization_id, username, password_hash)
           VALUES ($1, $2, $3) RETURNING id::text AS id`,
          [orgId, name, hash],
        );
        if (name === 'alice') alice = user?.id ?? '';
        else bob = user?.id ?? '';
      }
    });
    expect(orgId, 'the fixture organization must exist').not.toBe('');
    expect(alice, 'alice must exist').not.toBe('');
    expect(bob, 'bob must exist').not.toBe('');
    void organizations;
  });

  afterAll(async () => {
    await owner.withoutTenant('migration-status', (q) => removeFixture(q));
    await db.onModuleDestroy();
    await owner.onModuleDestroy();
  });

  it('does not store the secret it hands to the authenticator', async () => {
    const mfa = new MfaService(db, new SecretBox(key));
    const enrolment = await mfa.beginEnrolment(orgId, alice, 'alice');
    const secret = base32Decode(enrolment.secretBase32);

    const row = await storedRow(alice);
    expect(row.key_version).toBe(KEY_VERSION_AES_GCM);
    // The assertion that matters: someone holding the whole column holds none of the secret.
    expect(row.secret.includes(secret), 'the raw secret must not appear in the stored bytes').toBe(
      false,
    );
    expect(row.secret[0], 'the envelope must declare its version').toBe(KEY_VERSION_AES_GCM);
    // And it is still usable, which is the other half — an unreadable secret is not a safe one.
    expect(
      (await mfa.verifySecondFactor(orgId, alice, totp(secret, Math.floor(Date.now() / 1000))))
        .outcome,
    ).toBe('rejected'); // rejected: enrolment is not confirmed yet
    const codes = await mfa.confirmEnrolment(
      orgId,
      alice,
      totp(secret, Math.floor(Date.now() / 1000)),
    );
    expect(
      codes,
      'confirming with a correct code must work through the sealed secret',
    ).toHaveLength(10);
  });

  it('upgrades a secret written the old way, the first time it is used', async () => {
    // Exactly what migration 0004 left behind: the raw 20 bytes, key_version 0.
    const raw = Buffer.from(base32Decode('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'.slice(0, 32)));
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO user_totp_secrets (user_id, organization_id, secret, key_version, confirmed_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (user_id) DO UPDATE
            SET secret = EXCLUDED.secret, key_version = EXCLUDED.key_version,
                confirmed_at = now(), last_used_step = NULL`,
        [bob, orgId, raw, KEY_VERSION_PLAINTEXT],
      ),
    );
    expect((await storedRow(bob)).key_version).toBe(KEY_VERSION_PLAINTEXT);

    const mfa = new MfaService(db, new SecretBox(key));
    expect(await mfa.plaintextSecretCount(), 'the inventory must see it').toBeGreaterThan(0);

    // A plaintext row still verifies — an upgrade that locked people out would be a worse bug than
    // the one it fixes.
    const now = Math.floor(Date.now() / 1000);
    const result = await mfa.verifySecondFactor(orgId, bob, totp(raw, now));
    expect(result.outcome).toBe('ok');

    const after = await storedRow(bob);
    expect(after.key_version, 'the row must have been sealed in place').toBe(KEY_VERSION_AES_GCM);
    expect(after.secret.includes(raw), 'the raw secret must be gone').toBe(false);

    // And the same authenticator keeps working across the upgrade, which is the whole point of
    // doing it lazily rather than asking everyone to re-enrol.
    const later = await mfa.verifySecondFactor(orgId, bob, totp(raw, now + 30));
    expect(later.outcome).toBe('ok');
  });

  it('refuses a sealed secret moved onto another user', async () => {
    // The threat: UPDATE on this table without the key. Copy Alice's stored secret onto Bob's row
    // and sign in as Bob with Alice's phone. The associated data is what stops it, and this is the
    // only place the whole path can be checked.
    const mfa = new MfaService(db, new SecretBox(key));
    const enrolment = await mfa.beginEnrolment(orgId, alice, 'alice');
    const aliceSecret = base32Decode(enrolment.secretBase32);
    const now = Math.floor(Date.now() / 1000);
    await mfa.confirmEnrolment(orgId, alice, totp(aliceSecret, now));

    const aliceRow = await storedRow(alice);
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `UPDATE user_totp_secrets SET secret = $2, key_version = $3, last_used_step = NULL
          WHERE user_id = $1`,
        [bob, aliceRow.secret, aliceRow.key_version],
      ),
    );

    const stolen = await mfa.verifySecondFactor(orgId, bob, totp(aliceSecret, now + 60));
    expect(stolen.outcome, "Alice's secret must not authenticate Bob").toBe('rejected');
  });

  it('will not enrol anyone when there is no key', async () => {
    // Refused, not degraded. Silently writing a raw secret would give an operator who configured
    // encryption exactly the exposure they think they closed.
    const keyless = new MfaService(db, null);
    await expect(keyless.beginEnrolment(orgId, bob, 'bob')).rejects.toBeInstanceOf(
      SecretKeyUnavailableError,
    );
  });

  it('refuses a row that lies about which form it is in', async () => {
    // The schema's job, not the application's: key_version 1 with something that is not an envelope
    // would surface as a locked-out user at login rather than as an error where the bad write was.
    await expect(
      owner.withoutTenant('migration-status', (q) =>
        q.query(`UPDATE user_totp_secrets SET secret = $2, key_version = 1 WHERE user_id = $1`, [
          alice,
          Buffer.alloc(50, 9),
        ]),
      ),
    ).rejects.toThrow(/user_totp_secret_envelope_tagged/);
  });
});

/**
 * Remove the fixture, users first.
 *
 * `users.organization_id` is ON DELETE RESTRICT, so deleting the organization while its users exist
 * fails — which is what happened: the first run's teardown threw after every assertion had passed,
 * and the second run's setup then tripped over the residue. The secrets, recovery codes and
 * sessions all cascade from `users`, so this order is enough.
 */
async function removeFixture(q: TenantQuery): Promise<void> {
  await q.query(
    `DELETE FROM public.users
      WHERE organization_id IN (SELECT id FROM public.organizations WHERE slug = $1)`,
    [SLUG],
  );
  await q.query('DELETE FROM public.organizations WHERE slug = $1', [SLUG]);
}
