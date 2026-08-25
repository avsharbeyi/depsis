import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DbService } from '../db/db.service.js';
import { NotificationsService } from './notifications.service.js';
import {
  TagExistsError,
  TagNotFoundError,
  TagRejectedError,
  TaskTagsService,
} from './task-tags.service.js';
import { TaskWatchersService } from './task-watchers.service.js';
import { TasksService } from './tasks.service.js';

/**
 * Etiketler, gerçek bir PostgreSQL'e karşı.
 *
 * Bir sahtenin cevaplayamayacağı iki şey:
 *
 *   * **Benzersizlik `fold_identity` üzerinden**, yani "Acil", "acil" ve "ACIL" tek bir etiket —
 *     ve Türkçe i ailesi de katlanıyor, çünkü `fold_identity` `İIı` üçlüsünü `i`ye çeviriyor.
 *     Bu kural bir üretilmiş sütunda ve bir UNIQUE kısıtta duruyor; yalnız gerçek bir veritabanı
 *     onu uygulayabilir.
 *   * **`ensure` yarışa dayanıklı.** `ON CONFLICT DO NOTHING` + SELECT, iki ayrı sorguyla "önce bak
 *     sonra yaz" yapmaktan farklı olarak bir pencere bırakmıyor — ve o pencerenin olmadığı ancak
 *     aynı adı iki kez isteyerek görülebiliyor.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];

const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

describeDb('task tags, against a real PostgreSQL', () => {
  let db: DbService;
  let owner: DbService;
  let tags: TaskTagsService;
  let tasks: TasksService;

  let orgA = '';
  let orgB = '';
  let jale = '';
  let kerem = '';

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);
    tasks = new TasksService(db, new NotificationsService(db), new TaskWatchersService(db));
    tags = new TaskTagsService(db, tasks);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name) VALUES ('tag-a','Tag A'), ('tag-b','Tag B')
         ON CONFLICT (slug) DO NOTHING`,
      );
      const orgs = await q.query<{ slug: string; id: string }>(
        `SELECT slug, id::text AS id FROM organizations WHERE slug IN ('tag-a','tag-b')`,
      );
      orgA = orgs.find((r) => r.slug === 'tag-a')?.id ?? '';
      orgB = orgs.find((r) => r.slug === 'tag-b')?.id ?? '';
      const seeded = await q.query<{ username: string; id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1, 'tag-jale', 'admin', 'x'), ($2, 'tag-kerem', 'admin', 'x')
         RETURNING username, id::text AS id`,
        [orgA, orgB],
      );
      jale = seeded.find((r) => r.username === 'tag-jale')?.id ?? '';
      kerem = seeded.find((r) => r.username === 'tag-kerem')?.id ?? '';
    });
  });

  const clean = async (): Promise<void> => {
    for (const org of [orgA, orgB]) {
      await owner.withTenant(org, async (q) => {
        await q.query(`DELETE FROM task_tag_links WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM task_tags WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM notifications WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM task_watchers WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM task_activity WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM tasks WHERE organization_id = $1`, [org]);
      });
    }
  };

  beforeEach(clean);

  afterAll(async () => {
    if (owner !== undefined) {
      await clean();
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM users WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM organizations WHERE id = ANY($1)`, [[orgA, orgB]]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  it('treats a name that differs only in case as the same tag', async () => {
    const first = await tags.ensure(orgA, 'Acil', 'rose');
    const again = await tags.ensure(orgA, 'ACIL', 'mint');

    // AYNI satır, ve rengi DEĞİŞMEDİ: `ensure`'ün niyeti "bu adda bir etiket olsun", ve zaten
    // varsa istenen şey olmuş demektir. Rengi değiştirmek, ikinci çağıranın birincinin seçimini
    // sessizce ezmesi olurdu.
    expect(again.id).toBe(first.id);
    expect(again.color).toBe('rose');
    expect(await tags.list(orgA)).toHaveLength(1);
  });

  it('folds the Turkish i family, as usernames do', async () => {
    const dotted = await tags.ensure(orgA, 'İzleme', 'cyan');
    // `fold_identity` İ, I ve ı üçlüsünü i'ye çeviriyor: "İzleme" ile "izleme" tek etiket. Aksan
    // katlanmıyor — "Çağrı" ile "Cagri" ayrı, çünkü arama için doğru olan kimlik için yanlış.
    const plain = await tags.ensure(orgA, 'izleme', 'amber');
    expect(plain.id).toBe(dotted.id);

    const accented = await tags.ensure(orgA, 'Çağrı', 'iris');
    const bare = await tags.ensure(orgA, 'Cagri', 'iris');
    expect(bare.id).not.toBe(accented.id);
  });

  it('keeps two tenants’ dictionaries apart even for the same name', async () => {
    const mine = await tags.ensure(orgA, 'acil', 'rose');
    const theirs = await tags.ensure(orgB, 'acil', 'rose');

    expect(theirs.id).not.toBe(mine.id);
    expect((await tags.list(orgA)).map((t) => t.id)).toEqual([mine.id]);
    expect((await tags.list(orgB)).map((t) => t.id)).toEqual([theirs.id]);
  });

  it('returns the same row when the same name is asked for twice at once', async () => {
    // `ON CONFLICT DO NOTHING` + SELECT tek sorguda: iki ayrı sorguyla "önce bak sonra yaz"
    // yapılsaydı ikisinin arasında bir pencere olurdu, ve biri kısıt ihlaliyle patlardı.
    const [a, b] = await Promise.all([
      tags.ensure(orgA, 'paralel', 'mint'),
      tags.ensure(orgA, 'Paralel', 'mint'),
    ]);
    expect(a?.id).toBe(b?.id);
    expect(await tags.list(orgA)).toHaveLength(1);
  });

  it('counts how many jobs use a tag', async () => {
    const tag = await tags.ensure(orgA, 'depolama', 'cyan');
    const one = await tasks.create(orgA, jale, 'Disk tak', null);
    const two = await tasks.create(orgA, jale, 'Havuz kur', null);
    await tags.attach(orgA, one.id, tag.id, jale);
    await tags.attach(orgA, two.id, tag.id, jale);

    expect((await tags.list(orgA))[0]?.uses).toBe(2);
  });

  it('attaches once, however often it is asked', async () => {
    const tag = await tags.ensure(orgA, 'tekrar', 'iris');
    const task = await tasks.create(orgA, jale, 'İş', null);
    await tags.attach(orgA, task.id, tag.id, jale);
    await tags.attach(orgA, task.id, tag.id, jale);

    expect((await tags.forTasks(orgA, [task.id])).get(task.id)).toHaveLength(1);
    // Ve denetime bir kez düşüyor: ikinci takma hiçbir şey değiştirmedi.
    expect((await tasks.activity(orgA, task.id)).filter((r) => r.field === 'tag')).toHaveLength(1);
  });

  it('records attaching and detaching in the audit trail', async () => {
    const tag = await tags.ensure(orgA, 'acil', 'rose');
    const task = await tasks.create(orgA, jale, 'İş', null);
    await tags.attach(orgA, task.id, tag.id, jale);
    await tags.detach(orgA, task.id, tag.id, jale);

    const trail = (await tasks.activity(orgA, task.id)).filter((r) => r.field === 'tag');
    expect(trail).toHaveLength(2);
    // Bir işin "acil" olması ve sonra olmaması, o işi bekleyen herkes için bir bilgi.
    expect(trail.find((r) => r.old_value === null)?.new_value).toBe('acil');
    expect(trail.find((r) => r.new_value === null)?.old_value).toBe('acil');
  });

  it('says a tag is missing rather than silently doing nothing', async () => {
    const task = await tasks.create(orgA, jale, 'İş', null);
    const strangers = await tags.ensure(orgB, 'yabancı', 'iris');

    // Başka kiracının etiketi: RLS onu görmüyor, ve cevap "böyle bir etiket yok". Sessizce
    // başarılı saymak, arayüzde hiç görünmeyen bir çip bırakırdı.
    await expect(tags.attach(orgA, task.id, strangers.id, jale)).rejects.toBeInstanceOf(
      TagNotFoundError,
    );
  });

  it('takes the tag off every job when the tag is deleted, and says how many', async () => {
    const tag = await tags.ensure(orgA, 'gidecek', 'slate');
    const one = await tasks.create(orgA, jale, 'Bir', null);
    const two = await tasks.create(orgA, jale, 'İki', null);
    await tags.attach(orgA, one.id, tag.id, jale);
    await tags.attach(orgA, two.id, tag.id, jale);

    expect(await tags.remove(orgA, tag.id)).toBe(2);
    // Bağlar da gitti: adı olmayan bir etikete işaret eden bir bağ, panoda boş bir çip olurdu.
    expect((await tags.forTasks(orgA, [one.id, two.id])).size).toBe(0);
  });

  it('refuses a rename onto a name another tag already holds', async () => {
    const first = await tags.ensure(orgA, 'birinci', 'iris');
    await tags.ensure(orgA, 'ikinci', 'mint');

    // `ensure`'ün tersine sessizce BİRLEŞTİRMİYOR: iki etiketin tek etikete dönüşmesi, onları
    // kullanan bütün işlerin anlamını değiştirir, ve bunu isteyen kişi bilmeli.
    await expect(tags.rename(orgA, first.id, 'İkinci', undefined)).rejects.toBeInstanceOf(
      TagExistsError,
    );
  });

  it('renames and recolours, keeping the links', async () => {
    const tag = await tags.ensure(orgA, 'eski', 'iris');
    const task = await tasks.create(orgA, jale, 'İş', null);
    await tags.attach(orgA, task.id, tag.id, jale);

    const renamed = await tags.rename(orgA, tag.id, 'yeni', 'amber');
    expect(renamed.name).toBe('yeni');
    expect(renamed.color).toBe('amber');
    expect(renamed.uses).toBe(1);
    // Bağ aynı satıra bakıyor, yani işin çipi de yeni adı gösteriyor.
    expect((await tags.forTasks(orgA, [task.id])).get(task.id)?.[0]?.name).toBe('yeni');
  });

  it('refuses a name that is empty or beyond the schema’s limit', async () => {
    await expect(tags.ensure(orgA, '   ', 'iris')).rejects.toBeInstanceOf(TagRejectedError);
    await expect(tags.ensure(orgA, 'x'.repeat(41), 'iris')).rejects.toBeInstanceOf(
      TagRejectedError,
    );
  });

  it('cannot rename or delete another tenant’s tag', async () => {
    const theirs = await tags.ensure(orgB, 'onlarınki', 'iris');
    await expect(tags.rename(orgA, theirs.id, 'benimki', undefined)).rejects.toBeInstanceOf(
      TagNotFoundError,
    );
    await expect(tags.remove(orgA, theirs.id)).rejects.toBeInstanceOf(TagNotFoundError);
    // Ve gerçekten duruyor.
    expect(await tags.list(orgB)).toHaveLength(1);
    expect(kerem).not.toBe('');
  });

  it('takes the links with the task when the task is deleted', async () => {
    const tag = await tags.ensure(orgA, 'kalıcı', 'mint');
    const task = await tasks.create(orgA, jale, 'Silinecek', null);
    await tags.attach(orgA, task.id, tag.id, jale);

    await tasks.remove(orgA, task.id);

    // Bağ gitti ama ETİKET kaldı: sözlük kiracıya ait, tek bir işin ömrüne bağlı değil.
    expect(await tags.list(orgA)).toHaveLength(1);
    expect((await tags.list(orgA))[0]?.uses).toBe(0);
  });
});
