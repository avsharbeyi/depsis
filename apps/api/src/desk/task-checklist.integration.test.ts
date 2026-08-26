import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DbService } from '../db/db.service.js';
import { NotificationsService } from './notifications.service.js';
import {
  ChecklistItemNotFoundError,
  ChecklistRejectedError,
  TaskChecklistService,
} from './task-checklist.service.js';
import { TaskWatchersService } from './task-watchers.service.js';
import { TaskRejectedError, TasksService } from './tasks.service.js';

/**
 * Alt görevler ve kontrol listeleri, gerçek bir PostgreSQL'e karşı.
 *
 * Bu dosyanın taşıdığı asıl yük TEK SEVİYE KURALI. O kural bir CHECK ile ifade edilemiyor — başka
 * bir satıra bakması gerekiyor — ve bu yüzden bir TETİKLEYİCİDE duruyor. Yalnız serviste tutulsaydı
 * ikinci bir yazma yolu açıldığı gün sessizce kaybolurdu; tetikleyicide durduğu için de ancak
 * gerçek bir veritabanına karşı ölçülebiliyor. Bir sahte, bu testlerin sorduğu soruyu hiç göremez.
 *
 * İkinci yük, KASKAT: bir üst işi silmek parçalarını da siliyor. Bu doğru davranış ama sessiz bir
 * veri kaybı biçimi, ve doğru olduğunu ancak silinen satırları sayarak söyleyebiliriz.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];

const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

/**
 * Teardown ve kural-dışı çağrılar için: bu satırlar başkasının işini BİLEREK siliyor.
 * Kuralın kendisi `tasks.integration.test.ts` içinde ayrıca ölçülüyor.
 */
const AS_ADMIN = { userId: '00000000-0000-4000-8000-000000000000', isOrganizationAdmin: true };

describeDb('subtasks and checklists, against a real PostgreSQL', () => {
  let db: DbService;
  let owner: DbService;
  let checks: TaskChecklistService;
  let tasks: TasksService;

  let org = '';
  let hakan = '';
  let irem = '';

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);
    const notifications = new NotificationsService(db);
    tasks = new TasksService(db, notifications, new TaskWatchersService(db));
    checks = new TaskChecklistService(db, tasks);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name) VALUES ('sub-a','Sub A')
         ON CONFLICT (slug) DO NOTHING`,
      );
      const rows = await q.query<{ id: string }>(
        `SELECT id::text AS id FROM organizations WHERE slug = 'sub-a'`,
      );
      org = rows[0]?.id ?? '';
      const seeded = await q.query<{ username: string; id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1, 'sub-hakan', 'admin', 'x'), ($1, 'sub-irem', 'member', 'x')
         RETURNING username, id::text AS id`,
        [org],
      );
      hakan = seeded.find((r) => r.username === 'sub-hakan')?.id ?? '';
      irem = seeded.find((r) => r.username === 'sub-irem')?.id ?? '';
    });
  });

  const clean = async (): Promise<void> => {
    await owner.withTenant(org, async (q) => {
      await q.query(`DELETE FROM notifications WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM task_checklist_items WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM task_watchers WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM task_activity WHERE organization_id = $1`, [org]);
      // Parçalar önce: `ON DELETE CASCADE` zaten hallederdi ama sıra açıkça yazılınca, testin
      // temizliği kaskata bağımlı olmuyor.
      await q.query(`DELETE FROM tasks WHERE organization_id = $1 AND parent_id IS NOT NULL`, [
        org,
      ]);
      await q.query(`DELETE FROM tasks WHERE organization_id = $1`, [org]);
    });
  };

  beforeEach(clean);

  afterAll(async () => {
    if (owner !== undefined) {
      await clean();
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM users WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM organizations WHERE id = $1`, [org]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  /* ─── alt görevler ────────────────────────────────────────────────────────── */

  it('creates a subtask that is a full job of its own', async () => {
    const parent = await tasks.create(org, hakan, 'Sunucuyu taşı', null);
    const child = await tasks.create(org, hakan, 'Kabloları etiketle', irem, parent.id);

    expect(child.parent_id).toBe(parent.id);
    // Bir alt görev TAM bir iş: atanabiliyor, kendi durumu var. Ayrı bir tablo olsaydı bunların
    // hepsinin ikinci bir kopyası gerekirdi, ve o kopyalar zamanla ayrışırdı.
    expect(child.assignee_id).toBe(irem);
    expect(child.status).toBe('assigned');
  });

  it('refuses a second level, and the refusal comes from the database', async () => {
    const parent = await tasks.create(org, hakan, 'Üst iş', null);
    const child = await tasks.create(org, hakan, 'Parça', null, parent.id);

    // Tetikleyici reddediyor, servis değil. Kural veritabanında durduğu için ikinci bir yazma
    // yolu onu atlayamıyor.
    await expect(tasks.create(org, hakan, 'Torun', null, child.id)).rejects.toBeInstanceOf(
      TaskRejectedError,
    );
  });

  it('says WHY it refused, in a sentence a person can act on', async () => {
    const parent = await tasks.create(org, hakan, 'Üst', null);
    const child = await tasks.create(org, hakan, 'Parça', null, parent.id);

    // `violates check constraint "..."` bir iç ad sızdırır ve okuyana ne yapacağını söylemez.
    await expect(tasks.create(org, hakan, 'Torun', null, child.id)).rejects.toThrow(/tek seviye/);
  });

  it('refuses a task that already has parts from becoming a part itself', async () => {
    const parent = await tasks.create(org, hakan, 'Parçaları olan', null);
    await tasks.create(org, hakan, 'Parça', null, parent.id);
    const other = await tasks.create(org, hakan, 'Başka iş', null);

    await expect(
      tasks.update(org, parent.id, { parentId: other.id }, hakan),
    ).rejects.toBeInstanceOf(TaskRejectedError);
  });

  it('refuses a task that is its own parent', async () => {
    const task = await tasks.create(org, hakan, 'Kendi kendine', null);
    await expect(tasks.update(org, task.id, { parentId: task.id }, hakan)).rejects.toBeInstanceOf(
      TaskRejectedError,
    );
  });

  it('lets a part be detached back to the top level', async () => {
    const parent = await tasks.create(org, hakan, 'Üst', null);
    const child = await tasks.create(org, hakan, 'Parça', null, parent.id);

    const freed = await tasks.update(org, child.id, { parentId: null }, hakan);
    expect(freed.parent_id).toBeNull();
    // Ve bu bir denetim olayı: bir işin nereye ait olduğu değişti.
    const audit = await tasks.activity(org, child.id);
    expect(audit.some((row) => row.field === 'parent_id')).toBe(true);
  });

  it('deletes the parts with the parent, and nothing else', async () => {
    const parent = await tasks.create(org, hakan, 'Silinecek üst', null);
    await tasks.create(org, hakan, 'Parça 1', null, parent.id);
    await tasks.create(org, hakan, 'Parça 2', null, parent.id);
    const bystander = await tasks.create(org, hakan, 'İlgisiz iş', null);

    await tasks.remove(org, parent.id, AS_ADMIN);

    const left = await tasks.list(org);
    expect(left.map((t) => t.id)).toEqual([bystander.id]);
  });

  it('counts the parts, and counts a cancelled one as closed', async () => {
    const parent = await tasks.create(org, hakan, 'Sayılacak', null);
    const a = await tasks.create(org, hakan, 'a', null, parent.id);
    const b = await tasks.create(org, hakan, 'b', null, parent.id);
    await tasks.create(org, hakan, 'c', null, parent.id);
    await tasks.update(org, a.id, { status: 'done' }, hakan);
    await tasks.update(org, b.id, { status: 'cancelled' }, hakan);

    // İptal edilmiş bir parça bekleyen iş değil, ve rozetin sorduğu soru "kaç tanesi hâlâ
    // bekliyor".
    expect(await tasks.subtaskProgress(org, [parent.id])).toEqual(
      new Map([[parent.id, { done: 2, total: 3 }]]),
    );
  });

  /* ─── kontrol listesi ─────────────────────────────────────────────────────── */

  it('keeps checklist items in the order they were added', async () => {
    const task = await tasks.create(org, hakan, 'Liste', null);
    await checks.add(org, task.id, hakan, 'birinci');
    await checks.add(org, task.id, hakan, 'ikinci');
    await checks.add(org, task.id, hakan, 'üçüncü');

    expect((await checks.list(org, task.id)).map((i) => i.body)).toEqual([
      'birinci',
      'ikinci',
      'üçüncü',
    ]);
  });

  it('records who ticked an item, and forgets when it is unticked', async () => {
    const task = await tasks.create(org, hakan, 'Tikleme', null);
    await checks.add(org, task.id, hakan, 'madde');
    const [item] = await checks.list(org, task.id);

    await checks.setDone(org, task.id, item?.id ?? '', irem, true);
    const [ticked] = await checks.list(org, task.id);
    expect(ticked?.done_at).not.toBeNull();
    expect(ticked?.done_by_username).toBe('sub-irem');

    await checks.setDone(org, task.id, item?.id ?? '', irem, false);
    const [unticked] = await checks.list(org, task.id);
    // İkisi BİRLİKTE siliniyor: "yapıldı ama kim yaptığı bilinmiyor" diye bir hâl olmamalı.
    expect(unticked?.done_at).toBeNull();
    expect(unticked?.done_by_username).toBeNull();
  });

  it('records adding and deleting an item, but not ticking it', async () => {
    const task = await tasks.create(org, hakan, 'Denetim', null);
    await checks.add(org, task.id, hakan, 'madde');
    const [item] = await checks.list(org, task.id);
    await checks.setDone(org, task.id, item?.id ?? '', hakan, true);

    // Bir tik günde yirmi kez değişebilen bir şey; her birini yazmak izi okunmaz yapardı.
    const afterTick = (await tasks.activity(org, task.id)).filter((r) => r.field === 'checklist');
    expect(afterTick).toHaveLength(1);
    expect(afterTick[0]?.new_value).toBe('madde');

    await checks.remove(org, task.id, item?.id ?? '', hakan);
    const afterDelete = (await tasks.activity(org, task.id)).filter((r) => r.field === 'checklist');
    // Kaybolan şeyin izi başka hiçbir yerde kalmıyor, o yüzden silme yazılıyor.
    expect(afterDelete).toHaveLength(2);
    expect(afterDelete.find((r) => r.new_value === null)?.old_value).toBe('madde');
  });

  it('refuses an item that is empty or beyond the schema’s limit', async () => {
    const task = await tasks.create(org, hakan, 'Sınır', null);
    await expect(checks.add(org, task.id, hakan, '   ')).rejects.toBeInstanceOf(
      ChecklistRejectedError,
    );
    await expect(checks.add(org, task.id, hakan, 'x'.repeat(501))).rejects.toBeInstanceOf(
      ChecklistRejectedError,
    );
  });

  it('will not tick or delete an item through another task’s address', async () => {
    const mine = await tasks.create(org, hakan, 'Doğru iş', null);
    const other = await tasks.create(org, hakan, 'Başka iş', null);
    await checks.add(org, mine.id, hakan, 'madde');
    const [item] = await checks.list(org, mine.id);

    await expect(checks.setDone(org, other.id, item?.id ?? '', hakan, true)).rejects.toBeInstanceOf(
      ChecklistItemNotFoundError,
    );
    await expect(checks.remove(org, other.id, item?.id ?? '', hakan)).rejects.toBeInstanceOf(
      ChecklistItemNotFoundError,
    );
  });

  it('takes the checklist with the task it belongs to', async () => {
    const task = await tasks.create(org, hakan, 'Silinecek', null);
    await checks.add(org, task.id, hakan, 'madde');
    await tasks.remove(org, task.id, AS_ADMIN);

    const left = await owner.withTenant(org, (q) =>
      q.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM task_checklist_items WHERE organization_id = $1`,
        [org],
      ),
    );
    expect(left[0]?.n).toBe('0');
  });

  it('counts progress for a whole board in one query', async () => {
    const one = await tasks.create(org, hakan, 'Bir', null);
    const two = await tasks.create(org, hakan, 'İki', null);
    await checks.add(org, one.id, hakan, 'a');
    await checks.add(org, one.id, hakan, 'b');
    await checks.add(org, two.id, hakan, 'c');
    const [first] = await checks.list(org, one.id);
    await checks.setDone(org, one.id, first?.id ?? '', hakan, true);

    const progress = await checks.progress(org, [one.id, two.id]);
    expect(progress.get(one.id)).toEqual({ done: 1, total: 2 });
    expect(progress.get(two.id)).toEqual({ done: 0, total: 1 });
  });

  it('lets an account be closed after that account ticked an item', async () => {
    // `done_by` `ON DELETE SET NULL`. Bunu bir kısıtla "done_at ile birlikte var ya da yok"a
    // bağlamak, bir hesabın kapatılmasını o hesabın bir madde tiklemiş olmasına bağlardı —
    // 0028'de yorumlarda tam olarak bu hata bulunmuştu, ve 0029 onu tekrarlamıyor.
    const [temp] = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1, 'sub-gecici', 'member', 'x') RETURNING id::text AS id`,
        [org],
      ),
    );
    const who = temp?.id ?? '';
    const task = await tasks.create(org, hakan, 'Tikleyip gidecek', null);
    await checks.add(org, task.id, hakan, 'madde');
    const [item] = await checks.list(org, task.id);
    await checks.setDone(org, task.id, item?.id ?? '', who, true);

    await expect(
      owner.withoutTenant('migration-status', (q) =>
        q.query(`DELETE FROM users WHERE id = $1`, [who]),
      ),
    ).resolves.toBeDefined();

    const [after] = await checks.list(org, task.id);
    // Tik DURUYOR, yalnız kim tiklediği anonimleşti.
    expect(after?.done_at).not.toBeNull();
    expect(after?.done_by_username).toBeNull();
  });
});
