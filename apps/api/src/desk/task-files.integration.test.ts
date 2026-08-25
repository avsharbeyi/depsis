import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DbService } from '../db/db.service.js';
import { NotificationsService } from './notifications.service.js';
import { FilesService, type Caller } from '../files/files.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import { PosixIdentityService } from '../identity/posix.service.js';
import {
  LinkedFileNotVisibleError,
  TaskFileLinkExistsError,
  TaskFilesService,
} from './task-files.service.js';
import { TasksService } from './tasks.service.js';

/**
 * §7'nin tek cümlesi, gerçek bir PostgreSQL'e karşı:
 *
 * > "Görev klasöre veya dosyaya bağlanabilir; **görev erişimi gizli dosya erişimi vermemelidir.**"
 *
 * BU SÜİT O CÜMLE İÇİN VAR, ve sahte bir veritabanıyla yazılamaz: kuralın uygulayıcısı
 * `folder_grants` üzerinden koşan izin yürüyüşü, ve onu taklit eden bir test yalnız kendi
 * taklidini ölçer.
 *
 * Tehlike şu: görev panosu paylaşımlı — organizasyondaki HERKES bütün panoyu okuyor (0012'nin
 * kararı) — dosyalar ise değil. İkisi bir araya geldiğinde, bir bağ listesi `folder_grants`'ın
 * tuttuğu duvarın etrafından dolaşan bir yol açabilir.
 *
 * `DEPSIS_TEST_DATABASE_URL` ve `DEPSIS_TEST_OWNER_DATABASE_URL` yoksa atlanıyor.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];
const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

describeDb('görev–dosya bağı, §7 kuralıyla', () => {
  let db: DbService;
  let owner: DbService;
  let files: FilesService;
  let links: TaskFilesService;
  let tasks: TasksService;

  let org = '';
  let shareId = '';
  /** Klasörü gören. */
  let ayse = '';
  /** Aynı organizasyonda, o klasörü GÖRMEYEN. */
  let veli = '';
  let gizliKlasor = '';
  let gizliDosya = '';
  let acikDosya = '';
  let taskId = '';

  function caller(userId: string, admin = false): Caller {
    return { organizationId: org, userId, isOrganizationAdmin: admin };
  }

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);
    tasks = new TasksService(db, new NotificationsService(db));
    files = new FilesService(
      db,
      { isAvailable: () => false } as never,
      new PosixIdentityService(db),
      new JobsService(db),
    );
    links = new TaskFilesService(db, files);

    await owner.withoutTenant('migration-status', async (q) => {
      const orgs = await q.query<{ id: string }>(
        `INSERT INTO organizations (slug, name) VALUES ('tfl','Task File Links')
         ON CONFLICT (slug) DO UPDATE SET name = excluded.name
         RETURNING id::text AS id`,
      );
      org = orgs[0]?.id ?? '';

      const people = await q.query<{ username: string; id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1,'tfl-ayse','member','x'), ($1,'tfl-veli','member','x')
         RETURNING username, id::text AS id`,
        [org],
      );
      ayse = people.find((r) => r.username === 'tfl-ayse')?.id ?? '';
      veli = people.find((r) => r.username === 'tfl-veli')?.id ?? '';

      const shares = await q.query<{ id: string }>(
        `INSERT INTO shares (organization_id, name, dataset) VALUES ($1,'tfl-share','tank/tfl')
         RETURNING id::text AS id`,
        [org],
      );
      shareId = shares[0]?.id ?? '';

      // İki klasör: birine yalnız ayşe'nin izni var, diğerinin izni paylaşım kökünde ve herkeste.
      const folders = await q.query<{ name: string; id: string }>(
        `INSERT INTO file_entries (organization_id, share_id, parent_id, kind, name, path)
         VALUES ($1,$2,NULL,'folder','gizli','/gizli'),
                ($1,$2,NULL,'folder','acik','/acik')
         RETURNING name, id::text AS id`,
        [org, shareId],
      );
      gizliKlasor = folders.find((r) => r.name === 'gizli')?.id ?? '';
      const acikKlasor = folders.find((r) => r.name === 'acik')?.id ?? '';

      const entries = await q.query<{ name: string; id: string }>(
        `INSERT INTO file_entries
           (organization_id, share_id, parent_id, kind, name, path, size_bytes)
         VALUES ($1,$2,$3,'file','sir.txt','/gizli/sir.txt',10),
                ($1,$2,$4,'file','herkes.txt','/acik/herkes.txt',10)
         RETURNING name, id::text AS id`,
        [org, shareId, gizliKlasor, acikKlasor],
      );
      gizliDosya = entries.find((r) => r.name === 'sir.txt')?.id ?? '';
      acikDosya = entries.find((r) => r.name === 'herkes.txt')?.id ?? '';

      await q.query(
        `INSERT INTO folder_grants
           (organization_id, share_id, entry_id, user_id, permissions)
         VALUES ($1,$2,$3,$4,ARRAY['list','read']::public.folder_permission[]),
                ($1,$2,$5,$4,ARRAY['list','read']::public.folder_permission[]),
                ($1,$2,$5,$6,ARRAY['list','read']::public.folder_permission[])`,
        [org, shareId, gizliKlasor, ayse, acikKlasor, veli],
      );
    });

    const task = await tasks.create(org, ayse, 'iki dosyalı iş', null);
    taskId = task.id;
    await links.link(caller(ayse), taskId, gizliDosya);
    await links.link(caller(ayse), taskId, acikDosya);
  });

  afterAll(async () => {
    if (!runnable) return;
    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(`DELETE FROM task_file_links WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM task_activity WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM tasks WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM folder_grants WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM file_entries WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM shares WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM users WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM organizations WHERE id = $1`, [org]);
    });
    await db.onModuleDestroy();
    await owner.onModuleDestroy();
  });

  it('bağlayan iki dosyayı da görüyor', async () => {
    const page = await links.list(caller(ayse), taskId);
    expect(page.items.map((i) => i.name).sort()).toEqual(['herkes.txt', 'sir.txt']);
    expect(page.hidden).toBe(0);
  });

  it('GÖREMEYEN kişiye gizli dosyanın adı, yolu ve paylaşımı HİÇ gitmiyor', async () => {
    // Kuralın kendisi. Aynı görevi okuyan iki kişi iki farklı liste görüyor, ve göremeyenin
    // yanıtında dosya hakkında tek bir alan yok — filtrelenmiş bir satır değil, olmayan bir satır.
    const page = await links.list(caller(veli), taskId);

    expect(page.items.map((i) => i.name)).toEqual(['herkes.txt']);
    const serialised = JSON.stringify(page);
    expect(serialised).not.toContain('sir.txt');
    expect(serialised).not.toContain('/gizli');
    expect(serialised).not.toContain(gizliDosya);
  });

  it('görülemeyenlerin SAYISI bildiriliyor', async () => {
    // Sıfır göstermek "burada başka bir şey yok" demek olurdu ve bu yanlış. Sayı, "buraya bakman
    // gereken bir şey var ama sana değil" cümlesinin en az bilgi sızdıran hâli.
    expect((await links.list(caller(veli), taskId)).hidden).toBe(1);
  });

  it('göremediği bir dosyayı bağlayamıyor, ve cevap "yok"', async () => {
    // 404 sınıfı bir hata, 403 değil: 403 dosyanın VAR OLDUĞUNU söyler, ve bir görev üzerinden
    // dosya varlığı sızdırmak tam olarak §7'nin yasakladığı şey.
    const baska = await tasks.create(org, veli, 'velinin işi', null);
    await expect(links.link(caller(veli), baska.id, gizliDosya)).rejects.toBeInstanceOf(
      LinkedFileNotVisibleError,
    );
  });

  it('var olmayan bir dosya ile görülemeyen bir dosya aynı cevabı veriyor', async () => {
    // İkisi ayrışırsa fark, dosyanın varlığını söyler.
    const baska = await tasks.create(org, veli, 'ikinci', null);
    const yok = links.link(caller(veli), baska.id, '00000000-0000-4000-8000-000000000000');
    const gizli = links.link(caller(veli), baska.id, gizliDosya);
    const [a, b] = await Promise.all([
      yok.catch((e: Error) => e.constructor.name),
      gizli.catch((e: Error) => e.constructor.name),
    ]);
    expect(a).toBe(b);
  });

  it('aynı dosya bir göreve iki kez bağlanamıyor', async () => {
    await expect(links.link(caller(ayse), taskId, acikDosya)).rejects.toBeInstanceOf(
      TaskFileLinkExistsError,
    );
  });

  it('görünür sayılar pano için toplu çözülüyor ve kişiye göre değişiyor', async () => {
    const forAyse = await links.visibleCounts(caller(ayse), [taskId]);
    const forVeli = await links.visibleCounts(caller(veli), [taskId]);
    expect(forAyse.get(taskId)).toBe(2);
    expect(forVeli.get(taskId)).toBe(1);
  });

  it('çöpe atılmış bir dosya görünmüyor ve bağlanamıyor', async () => {
    // Çöp bir SÜTUN, klasör değil — yani çöpteki bir satırın `folder_grants`'ı hâlâ duruyor ve
    // izin yürüyüşü ona `read` verebilir. Kullanıcı onu dosya yöneticisinde göremezken bir görevde
    // görebilseydi, "sildiğim şey hâlâ orada" demenin en kafa karıştırıcı yolu olurdu.
    await owner.withoutTenant('migration-status', (q) =>
      // `trashed_by` ile birlikte: `file_entries_trash_pair` ikisinin birlikte dolu ya da
      // birlikte boş olmasını istiyor — çöpe atan biri olmadan çöpe atılmış bir satır,
      // "kim sildi" sorusunun cevabı olmayan bir satırdır.
      q.query(`UPDATE file_entries SET trashed_at = now(), trashed_by = $2 WHERE id = $1`, [
        acikDosya,
        ayse,
      ]),
    );
    try {
      const page = await links.list(caller(ayse), taskId);
      expect(page.items.map((i) => i.name)).toEqual(['sir.txt']);
      expect(page.hidden).toBe(1);

      const baska = await tasks.create(org, ayse, 'çöpten bağlama', null);
      await expect(links.link(caller(ayse), baska.id, acikDosya)).rejects.toBeInstanceOf(
        LinkedFileNotVisibleError,
      );
    } finally {
      await owner.withoutTenant('migration-status', (q) =>
        q.query(`UPDATE file_entries SET trashed_at = NULL, trashed_by = NULL WHERE id = $1`, [
          acikDosya,
        ]),
      );
    }
  });

  it('bağı kaldırmak dosyayı GÖREBİLMEYİ gerektirmiyor', async () => {
    // Bilinçli asimetri: bağlamak yeni bilgi üretiyor ve izin istiyor; kaldırmak bir şeyi geri
    // alıyor. Kaldırmayı da izne bağlasaydık, göremediği bir dosyanın bağı listesinde duran biri
    // onu asla temizleyemezdi.
    const page = await links.list(caller(ayse), taskId);
    const gizliLink = page.items.find((i) => i.name === 'sir.txt');
    expect(gizliLink).toBeDefined();

    expect(await links.unlink(org, taskId, gizliLink?.id ?? '')).toBe(true);
    expect((await links.list(caller(veli), taskId)).hidden).toBe(0);

    // Geri koy, sonraki testler için.
    await links.link(caller(ayse), taskId, gizliDosya);
  });

  it('başka bir görevin id’siyle bağ silinemiyor', async () => {
    const baska = await tasks.create(org, ayse, 'yanlış görev', null);
    const page = await links.list(caller(ayse), taskId);
    const link = page.items[0];
    expect(link).toBeDefined();
    expect(await links.unlink(org, baska.id, link?.id ?? '')).toBe(false);
  });
});
