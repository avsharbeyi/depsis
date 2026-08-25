import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DbService } from '../db/db.service.js';
import { NotificationsService, OVERDUE_SWEEP_KIND } from './notifications.service.js';
import { TasksService } from './tasks.service.js';

/**
 * Bildirim merkezi, gerçek bir PostgreSQL'e karşı.
 *
 * Bir sahtenin cevaplayamadığı üç şey var, ve üçü de bu dosyanın var olma sebebi:
 *
 *   * **Kişi filtresi bir yetki kontrolü.** RLS kiracıyı tutuyor ama kullanıcıyı tutmuyor —
 *     politika `depsis.organization_id`'yi biliyor, oturumdaki kişiyi bilmiyor. Yani "başkasının
 *     bildirimini okuyamazsın" cümlesini tutan tek şey her sorgudaki `user_id`, ve onu tutan tek
 *     şey de bu testler. Bir sahte veritabanı bu farkı hiç göremez.
 *   * **Tekrar engeli şemada.** Kısmi benzersiz indeks olmadan gecikme taraması aynı işi her on
 *     beş dakikada bir yeniden bildirirdi. `ON CONFLICT DO NOTHING`'in gerçekten bir şeye
 *     çarptığını ancak indeksin kendisi gösterebilir.
 *   * **Zincir.** `job_queue_one_scheduled_overdue_sweep` ikinci bir sıradaki taramayı reddediyor,
 *     ve o indeks yalnız `queued`'ı kapsıyor — kapsamı bir satır geniş olsaydı işleyicinin kendi
 *     ardılını kuyruğa alması çakışır ve hatırlatmalar sessizce dururdu.
 *
 * `DEPSIS_TEST_DATABASE_URL` ve `DEPSIS_TEST_OWNER_DATABASE_URL` göç edilmiş bir veritabanını
 * göstermiyorsa atlanıyor.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];

const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

describeDb('the notification centre, against a real PostgreSQL', () => {
  let db: DbService;
  let owner: DbService;
  let notifications: NotificationsService;
  let tasks: TasksService;

  let orgA = '';
  let orgB = '';
  let ayla = '';
  let bora = '';
  let ceren = '';

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);
    notifications = new NotificationsService(db);
    tasks = new TasksService(db, notifications);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name)
         VALUES ('notif-a','Notif A'), ('notif-b','Notif B')
         ON CONFLICT (slug) DO NOTHING`,
      );
      const orgs = await q.query<{ slug: string; id: string }>(
        `SELECT slug, id::text AS id FROM organizations WHERE slug IN ('notif-a','notif-b')`,
      );
      orgA = orgs.find((r) => r.slug === 'notif-a')?.id ?? '';
      orgB = orgs.find((r) => r.slug === 'notif-b')?.id ?? '';

      const seeded = await q.query<{ username: string; id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1, 'notif-ayla', 'admin', 'x'),
                ($1, 'notif-bora', 'member', 'x'),
                ($2, 'notif-ceren', 'admin', 'x')
         RETURNING username, id::text AS id`,
        [orgA, orgB],
      );
      ayla = seeded.find((r) => r.username === 'notif-ayla')?.id ?? '';
      bora = seeded.find((r) => r.username === 'notif-bora')?.id ?? '';
      ceren = seeded.find((r) => r.username === 'notif-ceren')?.id ?? '';
    });
  });

  /**
   * Her testten önce boş bir sayfa — ve KİRACI BAĞLAMINDA.
   *
   * `withoutTenant` burada işe yaramıyor, ve yaramadığını sessizce yapıyor: `notifications` üzerinde
   * `FORCE ROW LEVEL SECURITY` var, `depsis_owner`'ın `BYPASSRLS` yetkisi yok, ve bağlam kurulmamışsa
   * `current_organization_id()` NULL dönüyor — yani politika hiçbir satırı görmüyor ve DELETE sıfır
   * satır silip başarıyla dönüyor. Bu, testlerin arasında sızıntı olarak ortaya çıktı: `task_id`
   * taşıyan satırlar `tasks` silinince kaskatla gidiyordu (referans bütünlüğü RLS'e tabi değil),
   * `task_id` NULL olanlar ise duruyordu, ve bir sonraki testin sayımını bir fazla yapıyordu.
   */
  beforeEach(async () => {
    for (const organizationId of [orgA, orgB]) {
      await owner.withTenant(organizationId, async (q) => {
        await q.query(`DELETE FROM notifications WHERE organization_id = $1`, [organizationId]);
        await q.query(`DELETE FROM job_queue WHERE organization_id = $1`, [organizationId]);
        await q.query(`DELETE FROM task_activity WHERE organization_id = $1`, [organizationId]);
        await q.query(`DELETE FROM tasks WHERE organization_id = $1`, [organizationId]);
      });
    }
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM notifications WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM job_queue WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM task_activity WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM tasks WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM users WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM organizations WHERE id = ANY($1)`, [[orgA, orgB]]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  it('does not tell someone what they just did themselves', async () => {
    await notifications.notify({
      organizationId: orgA,
      userId: ayla,
      actorId: ayla,
      kind: 'task.status',
      taskId: null,
      title: 'Kendi yaptığın şey',
    });
    // Bu kontrol atlandığında sistem çalışmaya DEVAM ediyor ve zil sürekli yanıyor — kullanıcı da
    // okumayı bırakıyor, ki bir bildirim merkezinin ölümü tam olarak bu.
    expect(await notifications.unreadCount(orgA, ayla)).toBe(0);
  });

  it('gives two people two different sentences about one assignment', async () => {
    const task = await tasks.create(orgA, ayla, 'Diskleri değiştir', bora);
    await tasks.update(orgA, task.id, { assigneeId: null }, ayla);

    const boras = await notifications.inbox(orgA, bora, false);
    expect(boras.map((n) => n.kind)).toEqual(['task.unassigned', 'task.assigned']);
    // İki satırın METNİ de farklı, tek bir olay için. Tek satır olsaydı ikisinden biri yanlış
    // cümleyi okurdu.
    expect(boras[0]?.title).toContain('artık sende değil');
    expect(boras[1]?.title).toContain('Sana bir iş atandı');
  });

  it('reaches the assignee and the person who asked for the job, once each', async () => {
    const task = await tasks.create(orgA, ayla, 'Yedeği doğrula', bora);
    await tasks.update(orgA, task.id, { status: 'in_review' }, ayla);

    // Ayla işi kendi oluşturdu ama durumu da kendi değiştirdi: kendine-bildirme kuralı onu eliyor.
    expect(await notifications.unreadCount(orgA, ayla)).toBe(0);
    const boras = await notifications.inbox(orgA, bora, true);
    expect(boras.filter((n) => n.kind === 'task.status')).toHaveLength(1);
    expect(boras.find((n) => n.kind === 'task.status')?.title).toContain('İncelemeye girdi');
  });

  it('will not let one tenant read or clear another tenant’s inbox', async () => {
    await notifications.notify({
      organizationId: orgA,
      userId: bora,
      actorId: ayla,
      kind: 'task.status',
      taskId: null,
      title: 'A kiracısına ait',
    });

    // Ceren B kiracısında. Kendi bağlamında A'nın satırını göremiyor (RLS), ve A'nın bağlamında
    // sorulsa bile kişi filtresi onu eliyor — iki ayrı kapı, ve teste ikisi de giriyor.
    expect(await notifications.inbox(orgB, ceren, false)).toHaveLength(0);
    expect(await notifications.markAllRead(orgB, ceren)).toBe(0);
    expect(await notifications.unreadCount(orgA, bora)).toBe(1);
  });

  it('marks one row without touching a neighbour, and never re-stamps a read one', async () => {
    await notifications.notifyMany([
      {
        organizationId: orgA,
        userId: bora,
        actorId: ayla,
        kind: 'task.assigned',
        taskId: null,
        title: 'Birinci',
      },
      {
        organizationId: orgA,
        userId: bora,
        actorId: ayla,
        kind: 'task.status',
        taskId: null,
        title: 'İkinci',
      },
    ]);

    const [first] = await notifications.inbox(orgA, bora, true);
    expect(await notifications.markRead(orgA, bora, [first?.id ?? ''])).toBe(1);
    expect(await notifications.unreadCount(orgA, bora)).toBe(1);
    // İkinci kez sıfır: "ne zaman okudum" cevabı bugüne kaymıyor.
    expect(await notifications.markRead(orgA, bora, [first?.id ?? ''])).toBe(0);
  });

  it('says nothing twice about the same overdue job, however often the sweep runs', async () => {
    const task = await tasks.create(orgA, ayla, 'Süresi geçmiş iş', bora);
    await owner.withoutTenant('migration-status', (q) =>
      q.query(`UPDATE tasks SET due_at = now() - interval '3 days' WHERE id = $1`, [task.id]),
    );

    expect(await notifications.sweepOverdue(orgA)).toEqual({ overdue: 1, due: 0 });
    // İkinci tur AYNI işi buluyor — gecikmiş bir iş gecikmiş kalıyor — ve hiçbir yeni satır
    // yazmıyor. Kısmi benzersiz indeks olmasa bu bir haftada bin satır olurdu.
    expect(await notifications.sweepOverdue(orgA)).toEqual({ overdue: 1, due: 0 });
    // Isi olustururken dusen `task.assigned` disinda tek satir. Toplam sayimi kullanmak, ikinci
    // turun bir sey yazmadigini degil, yalnizca toplamin degismedigini gosterirdi.
    const late = await notifications.inbox(orgA, bora, true);
    expect(late.filter((n) => n.kind === 'task.overdue')).toHaveLength(1);
  });

  it('separates a job that is late from one that is merely close', async () => {
    const late = await tasks.create(orgA, ayla, 'Geçmiş', bora);
    const soon = await tasks.create(orgA, ayla, 'Yaklaşan', bora);
    const far = await tasks.create(orgA, ayla, 'Uzak', bora);
    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(`UPDATE tasks SET due_at = now() - interval '1 day' WHERE id = $1`, [late.id]);
      await q.query(`UPDATE tasks SET due_at = now() + interval '2 hours' WHERE id = $1`, [
        soon.id,
      ]);
      // Ufkun ötesinde: yirmi dört saatlik pencere olmasaydı, gelecek ayın işi bugün bildirilirdi.
      await q.query(`UPDATE tasks SET due_at = now() + interval '9 days' WHERE id = $1`, [far.id]);
    });

    expect(await notifications.sweepOverdue(orgA)).toEqual({ overdue: 1, due: 1 });
    // Yalniz taramanin urettikleri: her is olusturulurken bir de `task.assigned` dusuyor, ve o
    // bu testin sordugu sey degil.
    const kinds = (await notifications.inbox(orgA, bora, true))
      .map((n) => n.kind)
      .filter((kind) => kind === 'task.due' || kind === 'task.overdue')
      .sort();
    expect(kinds).toEqual(['task.due', 'task.overdue']);
  });

  it('leaves a closed job alone even when its date has passed', async () => {
    const task = await tasks.create(orgA, ayla, 'Bitmiş iş', bora);
    await tasks.update(orgA, task.id, { status: 'done' }, bora);
    await owner.withoutTenant('migration-status', (q) =>
      q.query(`UPDATE tasks SET due_at = now() - interval '5 days' WHERE id = $1`, [task.id]),
    );

    expect(await notifications.sweepOverdue(orgA)).toEqual({ overdue: 0, due: 0 });
  });

  it('keeps exactly one sweep queued, so the chain neither dies nor doubles', async () => {
    await notifications.scheduleSweep(orgA, new Date());
    await notifications.scheduleSweep(orgA, new Date(Date.now() + 60_000));

    const queued = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM job_queue
          WHERE organization_id = $1 AND kind = $2 AND status = 'queued'`,
        [orgA, OVERDUE_SWEEP_KIND],
      ),
    );
    expect(queued[0]?.n).toBe('1');
  });

  it('lets the running sweep queue its own successor', async () => {
    await notifications.scheduleSweep(orgA, new Date());
    // İşleyicinin yaptığı şey: kendi satırı `running`'e geçtikten sonra bir sonrakini yazıyor.
    // Kısmi indeks `running`'i de kapsasaydı bu INSERT sessizce düşer ve zincir orada biterdi —
    // ve hiçbir şey hata vermeden hatırlatmalar bir daha hiç gelmezdi.
    await owner.withoutTenant('migration-status', (q) =>
      // `lease_until` ile birlikte: 0007'nin `job_running_has_lease` kısıtı kirasız bir `running`
      // satırını reddediyor, çünkü öyle bir satır hiçbir worker'ın geri alamayacağı bir iş olurdu.
      q.query(
        `UPDATE job_queue SET status = 'running', lease_until = now() + interval '5 minutes'
          WHERE organization_id = $1 AND kind = $2`,
        [orgA, OVERDUE_SWEEP_KIND],
      ),
    );
    await notifications.scheduleSweep(orgA, new Date(Date.now() + 900_000));

    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ status: string }>(
        `SELECT status FROM job_queue WHERE organization_id = $1 AND kind = $2 ORDER BY status`,
        [orgA, OVERDUE_SWEEP_KIND],
      ),
    );
    expect(rows.map((r) => r.status)).toEqual(['queued', 'running']);
  });

  it('refuses a batch that mixes tenants rather than writing half of it', async () => {
    await expect(
      notifications.notifyMany([
        {
          organizationId: orgA,
          userId: bora,
          actorId: null,
          kind: 'task.due',
          taskId: null,
          title: 'A',
        },
        {
          organizationId: orgB,
          userId: ceren,
          actorId: null,
          kind: 'task.due',
          taskId: null,
          title: 'B',
        },
      ]),
    ).rejects.toThrow(/one organisation/);
  });
});
