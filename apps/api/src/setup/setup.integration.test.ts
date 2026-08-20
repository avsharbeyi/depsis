import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../auth/auth.service.js';
import { LoginThrottleService } from '../auth/login-throttle.service.js';
import { MfaService } from '../auth/mfa.service.js';
import { PasswordService } from '../auth/password.service.js';
import { PendingLoginService } from '../auth/pending-login.service.js';
import { SessionService } from '../auth/session.service.js';
import { DbService } from '../db/db.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { SetupService } from './setup.service.js';

/**
 * The one-time claim, against a real PostgreSQL.
 *
 * What has to be true is narrow and unforgiving: it works exactly once, a wrong token gets nothing,
 * two simultaneous claims produce one organization rather than two, and once it is done the door
 * does not reopen. Every one of those is a database property rather than a TypeScript one — the
 * singleton primary key is the arbiter, not the service — so none of it can be settled with a fake.
 *
 * These tests need a database with NO setup row, so they run against their own database rather
 * than the shared one. DEPSIS_TEST_SETUP_DATABASE_URL names it; without it they skip.
 */

const SETUP_URL = process.env['DEPSIS_TEST_SETUP_DATABASE_URL'];
const SETUP_OWNER_URL = process.env['DEPSIS_TEST_SETUP_OWNER_DATABASE_URL'];
const describeDb =
  SETUP_URL !== undefined && SETUP_URL !== '' && SETUP_OWNER_URL !== undefined
    ? describe
    : describe.skip;

describeDb('system setup, against a real PostgreSQL', () => {
  let db: DbService;
  let owner: DbService;
  let setup: SetupService;

  /**
   * The token, read the way an operator reads it: out of the log.
   *
   * The service never stores it — only its SHA-256 — so there is nothing to read back, and adding a
   * getter that exists only for tests would mean testing a path production does not take. Capturing
   * the log line exercises the real one, and it fails loudly if the message ever stops carrying the
   * token, which is itself worth catching.
   */
  let lastToken = '';

  async function freshSetup(): Promise<SetupService> {
    // Wipe whatever a previous run left, so "works exactly once" is measured from a known state.
    await owner.withoutTenant('setup-status', async (q) => {
      await q.query('DELETE FROM system_setup');
      await q.query('DELETE FROM users');
      await q.query('DELETE FROM organizations');
    });

    lastToken = '';
    const spy = vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      const found = /\s([A-Za-z0-9_-]{40,})\s/.exec(String(message));
      if (found?.[1] !== undefined) lastToken = found[1];
    });
    try {
      const service = new SetupService(db, new PasswordService());
      await service.onModuleInit();
      expect(lastToken, 'the boot log must carry a setup token').not.toBe('');
      return service;
    } finally {
      spy.mockRestore();
    }
  }

  const tokenOf = (_service: SetupService): string => lastToken;

  beforeAll(async () => {
    db = new DbService(SETUP_URL as string);
    owner = new DbService(SETUP_OWNER_URL as string);
    await db.onModuleInit();
    setup = await freshSetup();
  });

  afterAll(async () => {
    await db?.onModuleDestroy();
    await owner?.onModuleDestroy();
  });

  const claimBody = (token: string, slug = 'firstorg'): Parameters<SetupService['claim']>[0] => ({
    token,
    organizationSlug: slug,
    organizationName: 'First Organisation',
    adminEmail: 'admin@firstorg.example',
    adminDisplayName: 'Administrator',
    adminPassword: 'a-sufficiently-long-password',
  });

  it('reports that setup is required before anything has claimed it', async () => {
    expect(await setup.isComplete()).toBe(false);
  });

  it('refuses a wrong token, and says nothing about why', async () => {
    const result = await setup.claim(claimBody('not-the-token'));
    expect(result).toEqual({ outcome: 'bad-token' });
    expect(await setup.isComplete()).toBe(false);
  });

  it('refuses a short password before touching the database', async () => {
    const result = await setup.claim({
      ...claimBody(tokenOf(setup)),
      adminPassword: 'short',
    });
    expect(result.outcome).toBe('invalid');
    expect(await setup.isComplete()).toBe(false);
  });

  it('refuses a slug the schema would reject, rather than letting the CHECK do it', async () => {
    // A constraint violation reaching the caller as a 500 is a worse answer than a sentence naming
    // the field, and the person on the other end is the machine's owner filling in a form.
    const result = await setup.claim({
      ...claimBody(tokenOf(setup)),
      organizationSlug: 'Not A Slug',
    });
    expect(result.outcome).toBe('invalid');
  });

  it('claims the system, creating the organization and its administrator', async () => {
    const service = await freshSetup();
    const result = await service.claim(claimBody(tokenOf(service)));

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(await service.isComplete()).toBe(true);

    const rows = await owner.withoutTenant('setup-status', (q) =>
      q.query<{ slug: string; email: string }>(
        `SELECT o.slug, u.email
           FROM system_setup s
           JOIN organizations o ON o.id = s.organization_id
           JOIN users u ON u.id = s.admin_user_id`,
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slug).toBe('firstorg');
    expect(rows[0]?.email).toBe('admin@firstorg.example');
  });

  it('the administrator it created can actually log in', async () => {
    // The claim is worthless if the account it produces cannot be used, and a password hashed into
    // a column nobody can verify against is exactly the kind of thing that passes every other test.
    const service = await freshSetup();
    const claimed = await service.claim(claimBody(tokenOf(service)));
    expect(claimed.outcome).toBe('ok');

    const auth = new AuthService(
      db,
      new OrganizationsService(db),
      new PasswordService(),
      new SessionService(db),
      new LoginThrottleService(db),
      new MfaService(db),
      new PendingLoginService(db),
    );

    const login = await auth.login({
      organizationSlug: 'firstorg',
      email: 'admin@firstorg.example',
      password: 'a-sufficiently-long-password',
      userAgent: null,
      ip: '192.0.2.10',
    });
    expect(login.outcome).toBe('ok');
  });

  it('refuses a second claim, even with a valid token', async () => {
    const service = await freshSetup();
    const token = tokenOf(service);
    expect((await service.claim(claimBody(token))).outcome).toBe('ok');

    const second = await service.claim(claimBody(token, 'secondorg'));
    expect(second.outcome).toBe('already-complete');

    const orgs = await owner.withoutTenant('setup-status', (q) =>
      q.query<{ n: string }>('SELECT count(*)::text AS n FROM organizations'),
    );
    expect(orgs[0]?.n, 'a second organization must not exist').toBe('1');
  });

  it('a second SERVICE cannot claim an already-claimed system', async () => {
    // A restart mints a new token. That must not reopen setup — otherwise restarting the API is a
    // way to take the machine back from whoever owns it.
    const service = await freshSetup();
    expect((await service.claim(claimBody(tokenOf(service)))).outcome).toBe('ok');

    const restarted = new SetupService(db, new PasswordService());
    await restarted.onModuleInit();
    expect(await restarted.isComplete()).toBe(true);
    expect((await restarted.claim(claimBody(tokenOf(restarted), 'thirdorg'))).outcome).toBe(
      'already-complete',
    );
  });

  it('two simultaneous claims produce exactly one organization', async () => {
    // The race the singleton primary key exists to settle. Both requests pass the "is it complete"
    // check, both call the function, and the database decides — not the order the checks happened
    // to run in.
    const service = await freshSetup();
    const token = tokenOf(service);

    const results = await Promise.all([
      service.claim(claimBody(token, 'raceone')),
      service.claim(claimBody(token, 'racetwo')),
    ]);

    const succeeded = results.filter((r) => r.outcome === 'ok');
    expect(succeeded, 'exactly one claim may succeed').toHaveLength(1);

    const orgs = await owner.withoutTenant('setup-status', (q) =>
      q.query<{ n: string }>('SELECT count(*)::text AS n FROM organizations'),
    );
    expect(orgs[0]?.n).toBe('1');
  });

  it('a failed claim leaves nothing behind', async () => {
    const service = await freshSetup();
    // A duplicate slug is impossible on a clean system, so the failure is forced from the other
    // side: claim once, then claim again and confirm the second attempt created no orphan.
    expect((await service.claim(claimBody(tokenOf(service)))).outcome).toBe('ok');
    await service.claim(claimBody(tokenOf(service), 'leftover'));

    const orphans = await owner.withoutTenant('setup-status', (q) =>
      q.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM organizations WHERE slug = 'leftover'`,
      ),
    );
    expect(orphans[0]?.n).toBe('0');
  });

  it('the application still cannot create an organization by itself', async () => {
    // The capability granted by claim_system_setup must not have leaked into a general one:
    // ADR-0014 §4 withholds INSERT on organizations from depsis_app precisely so an API bug cannot
    // mint tenants, and that has to remain true after setup.
    await freshSetup();
    const attempt = await db
      .withoutTenant('setup-status', (q) =>
        q.query(`INSERT INTO organizations (slug, name) VALUES ('sneaky', 'Sneaky')`),
      )
      .then(() => 'inserted')
      .catch((error: unknown) => String(error));

    expect(attempt).toMatch(/permission denied/i);
  });
});
