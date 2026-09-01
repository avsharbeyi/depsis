import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../auth/auth.service.js';
import { LoginThrottleService } from '../auth/login-throttle.service.js';
import { MfaService } from '../auth/mfa.service.js';
import { generateKey, SecretBox } from '../auth/secret-box.js';
import { PasswordService } from '../auth/password.service.js';
import { PendingLoginService } from '../auth/pending-login.service.js';
import { SessionService } from '../auth/session.service.js';
import { AuditService } from '../audit/audit.service.js';
import { DbService } from '../db/db.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import type { IdentitySyncService } from '../identity/identity-sync.service.js';
import { SetupService } from './setup.service.js';

/**
 * The one-time claim, against a real PostgreSQL.
 *
 * What has to be true is narrow and unforgiving: it works exactly once, two simultaneous claims
 * produce one organization rather than two, and once it is done the door does not reopen. There
 * is no token any more — the claim is deliberately open until the first one lands — so the
 * database singleton is the ONLY lock, and every one of these is a database property rather than
 * a TypeScript one; none of it can be settled with a fake.
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

/**
 * Bir kimlik servisi yerine hiçbir şey yapmayan biri.
 *
 * Bu süit sahiplenmeyi ölçüyor, SMB kimliğini değil — ve gerçek servis bir `SecretBox` ile bir
 * ajan istiyor, ikisi de bu testin sorusuyla ilgisiz. `claim` çağrısı hatayı zaten yutuyor, ama
 * yutulan bir hata log'a düşen bir hata: sessiz bir sahte, gürültüsüz bir süit demek.
 */
function noIdentity(): IdentitySyncService {
  return {
    rememberPassword: () => Promise.resolve(),
    enqueue: () => Promise.resolve(),
  } as unknown as IdentitySyncService;
}

/** Aynısı, ama `enqueue` çağrılarını sayan. */
function countingIdentity(): { identity: IdentitySyncService; enqueued: string[] } {
  const enqueued: string[] = [];
  return {
    identity: {
      rememberPassword: () => Promise.resolve(),
      enqueue: (_organizationId: string, why: string) => {
        enqueued.push(why);
        return Promise.resolve();
      },
    } as unknown as IdentitySyncService,
    enqueued,
  };
}

describeDb('system setup, against a real PostgreSQL', () => {
  let db: DbService;
  let owner: DbService;
  let setup: SetupService;

  async function freshSetup(identity: IdentitySyncService = noIdentity()): Promise<SetupService> {
    // Wipe whatever a previous run left, so "works exactly once" is measured from a known state.
    await owner.withoutTenant('setup-status', async (q) => {
      await q.query('DELETE FROM system_setup');
      // Denetim satırları kuruluşu RESTRICT ile tutuyor — bilerek: kaydın işi, kuruluş
      // silinirken sessizce yok olmamak. Testin sıfırlaması bu yüzden önce onları kaldırıyor.
      await q.query('DELETE FROM audit_events');
      await q.query('DELETE FROM users');
      await q.query('DELETE FROM organizations');
    });

    // The boot log must not leak anything a browser would not also learn: the tokened design
    // printed a credential here, and this pin is what keeps one from quietly coming back.
    const printed: string[] = [];
    const spy = vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      printed.push(String(message));
    });
    try {
      const service = new SetupService(db, new PasswordService(), identity);
      await service.onModuleInit();
      expect(
        printed.some((line) => /[A-Za-z0-9_-]{40,}/.test(line)),
        'the boot log must not carry a secret-shaped string',
      ).toBe(false);
      return service;
    } finally {
      spy.mockRestore();
    }
  }

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

  const claimBody = (slug = 'firstorg'): Parameters<SetupService['claim']>[0] => ({
    organizationSlug: slug,
    organizationName: 'First Organisation',
    adminUsername: 'admin',
    adminPassword: 'a-sufficiently-long-password',
  });

  it('reports that setup is required before anything has claimed it', async () => {
    expect(await setup.isComplete()).toBe(false);
  });

  it('refuses a short password before touching the database', async () => {
    const result = await setup.claim({
      ...claimBody(),
      adminPassword: 'short',
    });
    expect(result.outcome).toBe('invalid');
    expect(await setup.isComplete()).toBe(false);
  });

  it('refuses a slug the schema would reject, rather than letting the CHECK do it', async () => {
    // A constraint violation reaching the caller as a 500 is a worse answer than a sentence naming
    // the field, and the person on the other end is the machine's owner filling in a form.
    const result = await setup.claim({
      ...claimBody(),
      organizationSlug: 'Not A Slug',
    });
    expect(result.outcome).toBe('invalid');
  });

  /**
   * KURUCU YÖNETİCİ İÇİN EŞİTLEME KUYRUĞA GİRİYOR.
   *
   * Sahada eksik olan tam olarak buydu: NT özeti veritabanına yazılıyordu ama onu Samba'ya
   * taşıyacak iş hiç kuyruğa girmiyordu. Kutuda tek bir Samba hesabı olmuyordu — `pdbedit -L`
   * bomboş — ve Windows ağ sürücüsü bağlarken "belirtilen ağ parolası geçersiz (86)" diyordu.
   * Parola doğruydu; karşılığı olan hesap yoktu.
   *
   * Kullanıcı oluşturma ve parola değiştirme yolları bunu zaten yapıyordu; her cihazın İLK ve
   * çoğu zaman TEK hesabı atlanmıştı.
   */
  it('kurucu yönetici için kimlik eşitlemesini kuyruğa alır', async () => {
    const { identity, enqueued } = countingIdentity();
    const service = await freshSetup(identity);

    const result = await service.claim(claimBody());

    expect(result.outcome).toBe('ok');
    expect(enqueued).toHaveLength(1);
  });

  it('claims the system, creating the organization and its administrator', async () => {
    const service = await freshSetup();
    const result = await service.claim(claimBody());

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(await service.isComplete()).toBe(true);

    const rows = await owner.withoutTenant('setup-status', (q) =>
      q.query<{ slug: string; username: string }>(
        `SELECT o.slug, u.username
           FROM system_setup s
           JOIN organizations o ON o.id = s.organization_id
           JOIN users u ON u.id = s.admin_user_id`,
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slug).toBe('firstorg');
    expect(rows[0]?.username).toBe('admin');
  });

  it('the administrator it created can actually log in', async () => {
    // The claim is worthless if the account it produces cannot be used, and a password hashed into
    // a column nobody can verify against is exactly the kind of thing that passes every other test.
    const service = await freshSetup();
    const claimed = await service.claim(claimBody());
    expect(claimed.outcome).toBe('ok');

    const auth = new AuthService(
      db,
      new OrganizationsService(db),
      new PasswordService(),
      new SessionService(db),
      new LoginThrottleService(db),
      new MfaService(db, testSecretBox()),
      new PendingLoginService(db),
      new AuditService(db),
    );

    const login = await auth.login({
      username: 'admin',
      organizationSlug: 'firstorg',
      password: 'a-sufficiently-long-password',
      userAgent: null,
      ip: '192.0.2.10',
    });
    expect(login.outcome).toBe('ok');
  });

  it('refuses a second claim', async () => {
    const service = await freshSetup();
    expect((await service.claim(claimBody())).outcome).toBe('ok');

    const second = await service.claim(claimBody('secondorg'));
    expect(second.outcome).toBe('already-complete');

    const orgs = await owner.withoutTenant('setup-status', (q) =>
      q.query<{ n: string }>('SELECT count(*)::text AS n FROM organizations'),
    );
    expect(orgs[0]?.n, 'a second organization must not exist').toBe('1');
  });

  it('a second SERVICE cannot claim an already-claimed system', async () => {
    // A restart must not reopen setup — otherwise restarting the API is a way to take the
    // machine back from whoever owns it.
    const service = await freshSetup();
    expect((await service.claim(claimBody())).outcome).toBe('ok');

    const restarted = new SetupService(db, new PasswordService(), noIdentity());
    await restarted.onModuleInit();
    expect(await restarted.isComplete()).toBe(true);
    expect((await restarted.claim(claimBody('thirdorg'))).outcome).toBe('already-complete');
  });

  it('two simultaneous claims produce exactly one organization', async () => {
    // The race the singleton primary key exists to settle. Both requests pass the "is it complete"
    // check, both call the function, and the database decides — not the order the checks happened
    // to run in.
    const service = await freshSetup();

    const results = await Promise.all([
      service.claim(claimBody('raceone')),
      service.claim(claimBody('racetwo')),
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
    expect((await service.claim(claimBody())).outcome).toBe('ok');
    await service.claim(claimBody('leftover'));

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

/** A fresh key per run. These tests are about storage behaviour, not about any particular key. */
function testSecretBox(): SecretBox {
  return new SecretBox(Buffer.from(generateKey(), 'base64'));
}
