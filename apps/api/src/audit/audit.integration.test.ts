import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DbService } from '../db/db.service.js';
import { AuditService } from './audit.service.js';

/**
 * Denetim kaydı, gerçek bir PostgreSQL'e karşı.
 *
 * Buradaki dört şeyin hiçbiri bir taklitle ölçülemez, çünkü dördü de veritabanının kendisinin
 * verdiği sözler: append-only'yi GRANT'lar tutuyor, kiracı sınırını RLS tutuyor, aktörün
 * anonimleşmesini bir ON DELETE kuralı tutuyor, ve "kayıt yazılamıyorsa işlem de olmaz"ı
 * transaction'ın kendisi tutuyor. Taklit edilen bir DbService yalnız kodun bu sözleri UMDUĞUNU
 * ölçerdi, tutulduğunu değil.
 *
 * `DEPSIS_TEST_DATABASE_URL` ve `DEPSIS_TEST_OWNER_DATABASE_URL` yoksa atlanır.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];

const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

describeDb('the audit trail, against a real PostgreSQL', () => {
  let db: DbService;
  let owner: DbService;
  let audit: AuditService;
  let orgA = '';
  let orgB = '';
  let vedat = '';

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);
    audit = new AuditService(db);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name)
         VALUES ('audit-a','Audit A'), ('audit-b','Audit B')
         ON CONFLICT (slug) DO NOTHING`,
      );
      const orgs = await q.query<{ slug: string; id: string }>(
        `SELECT slug, id::text AS id FROM organizations WHERE slug IN ('audit-a','audit-b')`,
      );
      orgA = orgs.find((r) => r.slug === 'audit-a')?.id ?? '';
      orgB = orgs.find((r) => r.slug === 'audit-b')?.id ?? '';

      const seeded = await q.query<{ id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1, 'audit-vedat', 'admin', 'x')
         RETURNING id::text AS id`,
        [orgA],
      );
      vedat = seeded[0]?.id ?? '';
    });
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM audit_events WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM users WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM organizations WHERE id = ANY($1)`, [[orgA, orgB]]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  it('writes a row whose actor name comes from the account, not the caller', async () => {
    await audit.record(orgA, {
      actorId: vedat,
      // Yanlış bir yedek ad bilerek veriliyor: satıra düşen ad HESAPTAN gelmeli. Çağıranın
      // elindeki ad bayat olabilir; alt sorgu yazma anının gerçeğini okur.
      actorUsername: 'bayat-ad',
      action: 'auth.login',
      summary: 'Oturum açıldı.',
      ip: '192.0.2.7',
    });

    const rows = await audit.list(orgA, { limit: 10 });
    const row = rows.find((r) => r.action === 'auth.login');
    expect(row).toBeDefined();
    expect(row?.actor_username).toBe('audit-vedat');
    expect(row?.ip).toBe('192.0.2.7');
  });

  it('CANNOT update or delete a row as the application role — append-only is a grant, not a habit', async () => {
    // Sınıfta silen bir metot yok, ama bu test daha güçlü bir şeyi ölçüyor: yarın biri yazsa da
    // çalışmayacağını. GRANT listesi SELECT ve INSERT; UPDATE ve DELETE 42501 ile reddedilir.
    await expect(
      db.withTenant(orgA, (q) =>
        q.query(
          `UPDATE public.audit_events SET summary = 'düzeltildi' WHERE organization_id = $1`,
          [orgA],
        ),
      ),
    ).rejects.toThrow(/permission denied/);

    await expect(
      db.withTenant(orgA, (q) =>
        q.query(`DELETE FROM public.audit_events WHERE organization_id = $1`, [orgA]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("seals one tenant's trail from the other", async () => {
    await audit.record(orgB, {
      actorId: null,
      actorUsername: 'sistem',
      action: 'setup.claimed',
      summary: 'B kiracısının satırı.',
    });

    const seenFromA = await audit.list(orgA, { limit: 100 });
    expect(seenFromA.map((r) => r.summary)).not.toContain('B kiracısının satırı.');

    // Ve yazma yönünde: A'nın bağlamından B'ye satır EKLENEMEZ. RLS'in WITH CHECK'i, uygulama
    // katmanındaki bir karışıklığın kiracı sınırını geçmesini engelleyen şeydir.
    await expect(
      db.withTenant(orgA, (q) =>
        q.query(
          `INSERT INTO public.audit_events (organization_id, actor_username, action, summary)
           VALUES ($1, 'sistem', 'auth.login', 'yanlış kiracıya yazma')`,
          [orgB],
        ),
      ),
    ).rejects.toThrow();
  });

  it('keeps the row, named, after the actor account is deleted', async () => {
    // Kaydın var olma nedeni: en çok, hesabın kapatıldığı gün okunur. `ON DELETE SET NULL`
    // kimliği anonimleştirir; metin kopyası adı tutar.
    const doomed = await owner.withoutTenant('migration-status', async (q) => {
      const rows = await q.query<{ id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1, 'audit-gecici', 'member', 'x')
         RETURNING id::text AS id`,
        [orgA],
      );
      return rows[0]?.id ?? '';
    });

    await audit.record(orgA, {
      actorId: doomed,
      action: 'mfa.enabled',
      summary: 'Silinecek hesabın satırı.',
    });

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(`DELETE FROM users WHERE id = $1`, [doomed]);
    });

    const rows = await audit.list(orgA, { limit: 100 });
    const row = rows.find((r) => r.summary === 'Silinecek hesabın satırı.');
    expect(row).toBeDefined();
    expect(row?.actor_id).toBeNull();
    expect(row?.actor_username).toBe('audit-gecici');
  });

  it('pages by id and filters by action prefix', async () => {
    for (const n of [1, 2, 3]) {
      await audit.record(orgA, {
        actorId: vedat,
        action: 'user.created',
        summary: `Sayfalama satırı ${n}.`,
      });
    }

    const first = await audit.list(orgA, { action: 'user', limit: 2 });
    expect(first).toHaveLength(2);
    expect(first.every((r) => r.action.startsWith('user'))).toBe(true);

    const second = await audit.list(orgA, {
      action: 'user',
      before: first[1]?.id,
      limit: 2,
    });
    // İmleç "daha eski" demek: ikinci sayfada ilk sayfanın hiçbir satırı yok.
    const firstIds = new Set(first.map((r) => r.id));
    expect(second.some((r) => firstIds.has(r.id))).toBe(false);
    expect(second.map((r) => r.summary)).toContain('Sayfalama satırı 1.');

    // Önek TAM bileşen eşler: `user`, `user.created`ı kapsar ama `users` diye bir sınıfı değil.
    const none = await audit.list(orgA, { action: 'use', limit: 10 });
    expect(none).toHaveLength(0);
  });

  it('joins the transaction it is handed: a rolled-back operation leaves no record', async () => {
    // "Kayıt, işlemin parçası" iki yönlü bir söz. Kaydedilemeyen işlem olmaz — ve OLAMAYAN işlem
    // kayıt bırakmaz. Yarıda ölen bir izin değişikliğinin denetimde "değişti" diye durması,
    // kaydın kendisinin yalan söylemesi olurdu.
    await expect(
      db.withTenant(orgA, async (q) => {
        await audit.record(
          orgA,
          { actorId: vedat, action: 'permissions.changed', summary: 'Geri alınacak satır.' },
          q,
        );
        throw new Error('operasyonun kendisi düştü');
      }),
    ).rejects.toThrow('operasyonun kendisi düştü');

    const rows = await audit.list(orgA, { limit: 100 });
    expect(rows.map((r) => r.summary)).not.toContain('Geri alınacak satır.');
  });
});
