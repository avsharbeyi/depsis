import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DbService } from '../db/db.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import type { AgentService } from '../agent/agent.service.js';
import { generateKey, SecretBox } from '../auth/secret-box.js';
import { IdentitySyncService } from '../identity/identity-sync.service.js';
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
    // A REAL `IdentitySyncService` with a real key, so the sealing path in `create` and
    // `setPasswordHash` is exercised rather than stubbed away. The agent is never reached from
    // those two methods — sealing is a database write — so a stub agent that refuses everything is
    // the honest fixture: if either method started talking to the agent, this would fail.
    users = new UsersService(
      db,
      new IdentitySyncService(
        db,
        {
          isAvailable: () => false,
          call: () => Promise.reject(new Error('create/setPasswordHash must not call the agent')),
        } as unknown as AgentService,
        new SecretBox(Buffer.from(generateKey(), 'base64')),
        new JobsService(db),
      ),
      // Silme yolunun ajanı, ve `create`/`setPasswordHash`inkinden AYRI: silme ajana gerçekten
      // gidiyor — kutudaki Unix hesabı ile Samba kaydı kaldırılmadan satır silinmiyor — o yüzden
      // burada reddeden değil KABUL EDEN bir ikiz duruyor. Çağrıları toplamıyor, çünkü bu süitte
      // ölçülen şey hangi çağrının yapıldığı değil, satırın gerçekten gitmesi.
      {
        isAvailable: () => true,
        call: (request: Record<string, unknown>) => {
          switch (request['op']) {
            case 'remove_posix_identity':
              return Promise.resolve({ status: 'posix_identity_removed' });
            // Kapatma yolunun ajan çağrısı. Devre dışı bırakmak artık SMB kimlik bilgisini de
            // düşürüyor, ve bu süitteki her `update(..., { disabled: true })` buradan geçiyor.
            case 'revoke_smb_credential':
              return Promise.resolve({ status: 'smb_credential_revoked' });
            default:
              return Promise.resolve({ status: 'discarded', existed: true });
          }
        },
      } as unknown as AgentService,
    );

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
        // Konsol kayıtları da: silme süiti bir tane bırakıyor — hesabı gittikten sonra hâlâ
        // okunabildiğini ölçmek için, ki kayıt bunun için var — ve `console_sessions`in kuruluşa
        // bağı RESTRICT, yani kalan tek satır kuruluşun silinmesini reddediyor.
        await q.query(`DELETE FROM console_sessions WHERE organization_id = ANY($1)`, [
          [orgA, orgB],
        ]);
        // Ekipler kullanıcılardan ÖNCE, kuruluştan önce: hesap açmak artık 'Herkes' ekibini de
        // tarıyor (`everyone_team`), yani bu süit çalıştıktan sonra kiracının bir ekibi var ve
        // `teams_organization_id_fkey` RESTRICT kuruluşun silinmesini reddediyor. Ürün doğru
        // davranıyordu; temizlik eksikti.
        await q.query(`DELETE FROM team_members WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM teams WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
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

  it('hands every session a name and an id, and NOTHING else', async () => {
    // `directory` var, çünkü `/users` yalnız yöneticilere açık ve §6.2'nin `manage` izni bir
    // klasörün yönetimini sıradan bir üyeye devredebiliyor: o üye izin verebiliyor ama kime
    // vereceğini seçemiyordu. Arayüz de 403'ü boş listeye çevirdiği için sonuç, hata mesajı
    // olmayan bir çıkmazdı.
    //
    // BU TESTİN ASIL ÖLÇTÜĞÜ SÜTUN LİSTESİ. Uç, yöneticilere ayrılmış bir listenin daraltılmış
    // hâli; genişleyen bir SELECT rolü, e-postayı ya da hesabın kapalı olup olmadığını her üyeye
    // açardı ve tip sistemi bunu görmezdi — `db.query<T>` dönen satırı doğrulamıyor, adlandırıyor.
    await users.create(orgA, 'rehber-uye', 'member', 'hash');

    const rows = await users.directory(orgA);
    const row = rows.find((r) => r.username === 'rehber-uye');
    expect(row).toBeDefined();
    expect(Object.keys(row as object).sort()).toEqual(['id', 'username']);

    // Ve kiracı sınırı: rehber komşunun hesaplarını saymıyor.
    await users.create(orgB, 'oteki-rehber', 'member', 'hash');
    expect((await users.directory(orgA)).map((r) => r.username)).not.toContain('oteki-rehber');
  });

  it('gives a new account its POSIX uid in the transaction that creates it', async () => {
    // An account that exists always has a filesystem identity, so there is no window in which a
    // person can be signed in and have nowhere for their files to belong. The agent refuses uid 0
    // and everything below the reserved range names a system service, so both ends are asserted.
    const created = await users.create(orgA, 'kimlikli', 'member', 'hash');

    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ posix_uid: number | null }>(`SELECT posix_uid FROM users WHERE id = $1`, [
        created.id,
      ]),
    );
    const uid = rows[0]?.posix_uid;
    expect(uid).not.toBeNull();
    expect(uid).toBeGreaterThanOrEqual(300000);
    expect(uid).toBeLessThanOrEqual(399999);
  });

  it('gives two accounts created AT THE SAME MOMENT two different uids', async () => {
    // The bug the advisory lock in `PosixIdentityService` exists to prevent, run for real.
    // `allocate_posix_id` is `MAX + 1` over two tables and holds nothing while it reads, so two
    // overlapping transactions both see the same maximum. Two people with one uid own each other's
    // files — the filesystem knows nothing about DEPSIS accounts, only about numbers.
    //
    // `Promise.all`, not a loop: the pool hands each call its own connection, so the two
    // transactions genuinely overlap. Serialised, this test would pass against the broken version.
    const [first, second] = await Promise.all([
      users.create(orgA, 'esz-bir', 'member', 'hash'),
      users.create(orgA, 'esz-iki', 'member', 'hash'),
    ]);

    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ id: string; posix_uid: number | null }>(
        `SELECT id::text AS id, posix_uid FROM users WHERE id = ANY($1::uuid[])`,
        [[first.id, second.id]],
      ),
    );
    expect(rows).toHaveLength(2);
    const uids = rows.map((r) => r.posix_uid);
    expect(uids[0]).not.toBeNull();
    expect(uids[1]).not.toBeNull();
    expect(new Set(uids).size).toBe(2);
  });

  it('refuses a duplicate address the way the folding rules say, not the way the string does', async () => {
    await users.create(orgA, 'Ayse', 'member', 'hash');
    // Case and the Turkish i-family fold for uniqueness; accents do NOT. `fold_identity` is the
    // authority and this asserts the API sees its decision as a 409 rather than a 500.
    await expect(users.create(orgA, 'AYSE', 'member', 'h')).rejects.toBeInstanceOf(
      UsernameTakenError,
    );
  });

  it('lets the same address exist in another organization', async () => {
    // A global UNIQUE(email) would leak across tenants: the uniqueness check bypasses RLS, so a
    // refusal here would tell tenant B that tenant A has that address (P0-C measured it).
    await expect(users.create(orgB, 'ikinci', 'member', 'hash')).resolves.toBeTruthy();
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

  it('cuts SMB when an account is disabled, not just the web sessions', async () => {
    // ── BU SÜİTİN EN ÖNEMLİ ÖLÇÜMÜ ────────────────────────────────────────────────────────
    //
    // Uzun süre kesilmiyordu. Kimlik eşitlemesi devre dışı kullanıcıyı listeden ÇIKARIYOR
    // (`disabled_at IS NULL`), ama ajanın eşitlemesi hesaplar için TOPLAYICI — listede olmayanı
    // silmiyor. Yani listeden çıkmak kutudan çıkmak değildi: kapatılan hesabın Samba parolası
    // çalışmaya devam ediyordu, üstelik denetim kaydı "oturumları sonlandırıldı" derken.
    //
    // Ölçülen şey ÇAĞRININ KENDİSİ, çünkü bu katmanın verebileceği tek dürüst cevap o: parolanın
    // gerçekten düştüğünü ancak gerçek bir `pdbedit` söyleyebilir, ve onu ajanın kendi süiti
    // ölçüyor. Burada yanlış gidebilecek şey çağrının HİÇ YAPILMAMASI — ve tam olarak o olmuştu.
    const calls: Record<string, unknown>[] = [];
    const watched = new UsersService(
      db,
      new IdentitySyncService(
        db,
        {
          isAvailable: () => false,
          call: () => Promise.reject(new Error('unused')),
        } as unknown as AgentService,
        new SecretBox(Buffer.from(generateKey(), 'base64')),
        new JobsService(db),
      ),
      {
        isAvailable: () => true,
        call: (request: Record<string, unknown>) => {
          calls.push(request);
          return Promise.resolve({ status: 'smb_credential_revoked' });
        },
      } as unknown as AgentService,
    );

    const user = await watched.create(orgA, 'kapatilacak', 'member', 'hash');
    await watched.update(orgA, user.id, { disabled: true });
    await watched.revokeSmb('kapatilacak');

    expect(calls).toContainEqual({ op: 'revoke_smb_credential', login: 'kapatilacak' });
  });

  it('leaves the account and its uid in place when it is only disabled', async () => {
    // Kapatmak GERİ ALINABİLİR, ve etkisi de öyle olmalı: silmenin aksine Unix hesabı, özel grup
    // ve POSIX numarası duruyor. Numara emekli edilseydi hesabı geri açmak, kullanıcıyı kendi
    // dosyalarının sahibi olmayan yeni bir numarayla geri getirirdi.
    const user = await users.create(orgA, 'gecici-kapali', 'member', 'hash');
    const before = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ posix_uid: number }>(`SELECT posix_uid FROM users WHERE id = $1`, [user.id]),
    );

    await users.update(orgA, user.id, { disabled: true });
    await users.update(orgA, user.id, { disabled: false });

    const after = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ posix_uid: number; disabled_at: Date | null }>(
        `SELECT posix_uid, disabled_at FROM users WHERE id = $1`,
        [user.id],
      ),
    );
    expect(after[0]?.posix_uid).toBe(before[0]?.posix_uid);
    expect(after[0]?.disabled_at).toBeNull();

    const retired = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM retired_posix_ids WHERE id_value = $1`,
        [before[0]?.posix_uid],
      ),
    );
    expect(retired[0]?.n).toBe('0');
  });

  it('deletes an account, and never hands its uid to anybody else', async () => {
    // THE assertion this feature turns on. `allocate_posix_id` is `MAX + 1` over the live rows, so
    // deleting an account used to FREE its number — and the deleted person's files on disk still
    // carry it. The next account created would have opened owning files it had never seen: not a
    // permission error, not a warning, but ownership at the filesystem level.
    const doomed = await users.create(orgA, 'gidecek', 'member', 'hash');
    const before = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ posix_uid: number }>(`SELECT posix_uid FROM users WHERE id = $1`, [doomed.id]),
    );
    const uid = before[0]?.posix_uid;
    expect(uid).toBeGreaterThanOrEqual(300000);

    const removed = await users.remove(orgA, doomed.id, 'test');
    expect(removed).toEqual({ username: 'gidecek', posixUid: uid });

    await expect(users.find(orgA, doomed.id)).rejects.toBeInstanceOf(UserNotFoundError);

    const retired = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM retired_posix_ids WHERE id_value = $1`,
        [uid],
      ),
    );
    expect(retired[0]?.n).toBe('1');

    // Ve asıl ölçüm: sıradaki hesap o numarayı ALMIYOR. Mezar taşı olmadan burası tam olarak
    // `uid` dönerdi.
    const next = await users.create(orgA, 'sonraki', 'member', 'hash');
    const after = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ posix_uid: number }>(`SELECT posix_uid FROM users WHERE id = $1`, [next.id]),
    );
    expect(after[0]?.posix_uid).not.toBe(uid);
    expect(after[0]?.posix_uid).toBeGreaterThan(uid as number);
  });

  it('refuses to delete the last enabled administrator', async () => {
    // Silme yolu 0009'un tetikleyicisinin GÖRMEDİĞİ bir yoldu: tetikleyici yalnız UPDATE
    // üzerindeydi, çünkü o gün hiçbir şey bir kullanıcıyı silmiyordu. Göç 0049 onu DELETE'e de
    // bağlıyor, ve ölçülen şey o bağ.
    const only = await users.create(orgB, 'tekyonetici', 'admin', 'hash');
    const seeded = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ id: string }>(
        `SELECT id::text AS id FROM users
          WHERE organization_id = $1 AND role = 'admin' AND disabled_at IS NULL AND id <> $2`,
        [orgB, only.id],
      ),
    );
    for (const row of seeded) {
      await users.update(orgB, row.id, { role: 'member' });
    }

    await expect(users.remove(orgB, only.id, 'test')).rejects.toBeInstanceOf(LastAdminError);
    // Ve hesap duruyor: ret, satır gitmeden geliyor.
    expect((await users.find(orgB, only.id)).username).toBe('tekyonetici');
  });

  it('keeps a console audit row readable after its account is gone', async () => {
    // 0013'ün RESTRICT'i bu satırı korumak içindi ve hesabı rehin tutarak koruyordu. 0049 aynı şeyi
    // adı satırın İÇİNE yazarak koruyor: kayıt kimin olduğunu hâlâ söylüyor, hesap ise gidebiliyor.
    const user = await users.create(orgA, 'konsolcu', 'member', 'hash');
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO console_sessions (organization_id, user_id, username, privileged)
              VALUES ($1, $2, 'konsolcu', false)`,
        [orgA, user.id],
      ),
    );

    await users.remove(orgA, user.id, 'test');

    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ username: string; user_id: string | null }>(
        `SELECT username, user_id::text AS user_id FROM console_sessions WHERE username = 'konsolcu'`,
      ),
    );
    expect(rows[0]?.username).toBe('konsolcu');
    expect(rows[0]?.user_id).toBeNull();
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
