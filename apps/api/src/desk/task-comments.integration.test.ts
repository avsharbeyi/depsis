import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DbService } from '../db/db.service.js';
import { NotificationsService } from './notifications.service.js';
import {
  CommentNotFoundError,
  CommentNotYoursError,
  CommentRejectedError,
  TaskCommentsService,
} from './task-comments.service.js';
import { TaskWatchersService } from './task-watchers.service.js';
import { TasksService } from './tasks.service.js';

/**
 * Yorumlar, mention'lar ve izleyiciler — gerçek bir PostgreSQL'e karşı.
 *
 * Bir sahtenin cevaplayamayacağı şeyler, ve bu dosyanın var olma sebebi:
 *
 *   * **Mention çözümü bir kiracı sınırı.** Başka bir kiracıdaki `@ad` hiçbir şey üretmiyor, ve
 *     üretmediği dışarıdan da görünmüyor. Bunu tutan tek şey sorgudaki `organization_id`, ve o
 *     sorgu ancak gerçek bir veritabanında yanlış olabilir.
 *   * **İzleyici listesi bir tahminin yerini aldı.** Önceki sürüm "atanan + oluşturan" diyordu;
 *     testlerin görmesi gereken şey, ÜÇÜNCÜ bir kişinin artık bir yolu olduğu — ve o kişinin
 *     bildirimi gerçekten aldığı.
 *   * **Yumuşak silme gerçekten yumuşak.** Gövde tabloda kalıyor ve API onu bir daha döndürmüyor.
 *     Bir sahtede bu ikisi aynı şey görünürdü.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];

const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

describeDb('task comments and watchers, against a real PostgreSQL', () => {
  let db: DbService;
  let owner: DbService;
  let notifications: NotificationsService;
  let watchers: TaskWatchersService;
  let comments: TaskCommentsService;
  let tasks: TasksService;

  let orgA = '';
  let orgB = '';
  let derya = '';
  let engin = '';
  let filiz = '';
  let gonca = '';

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);
    notifications = new NotificationsService(db);
    watchers = new TaskWatchersService(db);
    tasks = new TasksService(db, notifications, watchers);
    comments = new TaskCommentsService(db, tasks, watchers, notifications);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name)
         VALUES ('cmt-a','Comment A'), ('cmt-b','Comment B')
         ON CONFLICT (slug) DO NOTHING`,
      );
      const orgs = await q.query<{ slug: string; id: string }>(
        `SELECT slug, id::text AS id FROM organizations WHERE slug IN ('cmt-a','cmt-b')`,
      );
      orgA = orgs.find((r) => r.slug === 'cmt-a')?.id ?? '';
      orgB = orgs.find((r) => r.slug === 'cmt-b')?.id ?? '';

      const seeded = await q.query<{ username: string; id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1, 'cmt-derya', 'admin', 'x'),
                ($1, 'cmt-engin', 'member', 'x'),
                ($1, 'cmt-filiz', 'member', 'x'),
                ($2, 'cmt-gonca', 'admin', 'x')
         RETURNING username, id::text AS id`,
        [orgA, orgB],
      );
      derya = seeded.find((r) => r.username === 'cmt-derya')?.id ?? '';
      engin = seeded.find((r) => r.username === 'cmt-engin')?.id ?? '';
      filiz = seeded.find((r) => r.username === 'cmt-filiz')?.id ?? '';
      gonca = seeded.find((r) => r.username === 'cmt-gonca')?.id ?? '';
    });
  });

  /**
   * Temizlik KİRACI BAĞLAMINDA — `withoutTenant` burada işe yaramıyor ve yaramadığını sessizce
   * yapıyor: FORCE RLS altında, bağlam kurulmamışsa politika hiçbir satırı görmüyor ve DELETE
   * sıfır satır silip başarıyla dönüyor.
   */
  beforeEach(async () => {
    for (const organizationId of [orgA, orgB]) {
      await owner.withTenant(organizationId, async (q) => {
        await q.query(`DELETE FROM notifications WHERE organization_id = $1`, [organizationId]);
        await q.query(`DELETE FROM task_comments WHERE organization_id = $1`, [organizationId]);
        await q.query(`DELETE FROM task_watchers WHERE organization_id = $1`, [organizationId]);
        await q.query(`DELETE FROM task_activity WHERE organization_id = $1`, [organizationId]);
        await q.query(`DELETE FROM tasks WHERE organization_id = $1`, [organizationId]);
      });
    }
  });

  afterAll(async () => {
    if (owner !== undefined) {
      // Son testin satırları hâlâ duruyor — `beforeEach` her testten ÖNCE temizliyor, sonra değil.
      // `organizations` üzerindeki `ON DELETE RESTRICT` bunu bir hataya çeviriyor, ki doğrusu da
      // bu: bir kiracıyı işleriyle birlikte sessizce silmek, veri kaybının en sessiz biçimi.
      for (const organizationId of [orgA, orgB]) {
        await owner.withTenant(organizationId, async (q) => {
          await q.query(`DELETE FROM notifications WHERE organization_id = $1`, [organizationId]);
          await q.query(`DELETE FROM task_comments WHERE organization_id = $1`, [organizationId]);
          await q.query(`DELETE FROM task_watchers WHERE organization_id = $1`, [organizationId]);
          await q.query(`DELETE FROM task_activity WHERE organization_id = $1`, [organizationId]);
          await q.query(`DELETE FROM tasks WHERE organization_id = $1`, [organizationId]);
        });
      }
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM users WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM organizations WHERE id = ANY($1)`, [[orgA, orgB]]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  /* ─── izleyiciler ─────────────────────────────────────────────────────────── */

  it('subscribes the creator and the assignee when the job is created', async () => {
    const task = await tasks.create(orgA, derya, 'Yedek diskini tak', engin);
    const rows = await watchers.list(orgA, task.id);

    expect(rows.map((r) => r.user_id).sort()).toEqual([derya, engin].sort());
    // Kaynak taşınıyor: bugün ikisi de aynı davranıyor, ama ayrım kaybolmuyor.
    expect(rows.find((r) => r.user_id === derya)?.source).toBe('created');
    expect(rows.find((r) => r.user_id === engin)?.source).toBe('assigned');
  });

  it('subscribes a new assignee without unsubscribing the old one', async () => {
    const task = await tasks.create(orgA, derya, 'El değiştiren iş', engin);
    await tasks.update(orgA, task.id, { assigneeId: filiz }, derya);

    // Eski atanan LİSTEDE KALIYOR. Bir işten alınmak, o işin sonucunu merak etmeyi bitirmiyor —
    // ve isterse kendi çıkabiliyor.
    expect((await watchers.list(orgA, task.id)).map((r) => r.user_id).sort()).toEqual(
      [derya, engin, filiz].sort(),
    );
  });

  it('lets a third person subscribe, and that person hears about a status change', async () => {
    const task = await tasks.create(orgA, derya, 'İzlenen iş', engin);
    // Filiz ne atanan ne oluşturan: eski "atanan + oluşturan" tahmininin göremediği kişi.
    await watchers.watch(orgA, task.id, filiz, 'manual');

    await tasks.update(orgA, task.id, { status: 'in_review' }, engin);

    const heard = await notifications.inbox(orgA, filiz, true);
    expect(heard.filter((n) => n.kind === 'task.status')).toHaveLength(1);
  });

  it('lets an assignee stop watching, and then hears nothing further', async () => {
    const task = await tasks.create(orgA, derya, 'Bırakılan iş', engin);
    expect(await watchers.unwatch(orgA, task.id, engin)).toBe(true);

    await tasks.update(orgA, task.id, { status: 'in_progress' }, derya);

    // Atanan olmasına RAĞMEN durum bildirimi almıyor. "Bu işi bırakamazsın, çünkü sana atandı"
    // demek, bildirimi bir cezaya çevirirdi.
    expect(
      (await notifications.inbox(orgA, engin, true)).filter((n) => n.kind === 'task.status'),
    ).toHaveLength(0);
  });

  it('does not let one tenant see or join another tenant’s watcher list', async () => {
    const task = await tasks.create(orgA, derya, 'A kiracısının işi', engin);
    expect(await watchers.list(orgB, task.id)).toHaveLength(0);
    expect(await watchers.watching(orgB, task.id, gonca)).toBe(false);
  });

  /* ─── yorumlar ────────────────────────────────────────────────────────────── */

  it('subscribes whoever joins the conversation', async () => {
    const task = await tasks.create(orgA, derya, 'Tartışılan iş', engin);
    await comments.add(orgA, task.id, filiz, 'Bunu ben de takip ediyorum.');

    const rows = await watchers.list(orgA, task.id);
    expect(rows.find((r) => r.user_id === filiz)?.source).toBe('commented');
  });

  it('tells the watchers about a new comment, but not the person who wrote it', async () => {
    const task = await tasks.create(orgA, derya, 'Yorumlanan iş', engin);
    await comments.add(orgA, task.id, engin, 'Başladım.');

    expect(
      (await notifications.inbox(orgA, derya, true)).filter((n) => n.kind === 'task.comment'),
    ).toHaveLength(1);
    // Yazan kendi yorumunu duymuyor.
    expect(
      (await notifications.inbox(orgA, engin, true)).filter((n) => n.kind === 'task.comment'),
    ).toHaveLength(0);
  });

  it('carries the job’s text in the title, not the comment’s', async () => {
    const task = await tasks.create(orgA, derya, 'Anlaşılır bir iş adı', engin);
    await comments.add(orgA, task.id, engin, 'Bu cümle bildirimde GEÇMEMELİ.');

    const [heard] = (await notifications.inbox(orgA, derya, true)).filter(
      (n) => n.kind === 'task.comment',
    );
    // Kısmi benzersiz indeks yüzünden ilk başlık, beşinci yorumdan sonra da ekranda duran başlık.
    // Bir yorumun metni olsaydı o an yanıltıcı olurdu; işin adı kaç yorum gelirse gelsin doğru.
    expect(heard?.title).toContain('Anlaşılır bir iş adı');
    expect(heard?.title).not.toContain('GEÇMEMELİ');
  });

  it('mentions a colleague and reaches exactly that person', async () => {
    const task = await tasks.create(orgA, derya, 'Anma testi', engin);
    await comments.add(orgA, task.id, engin, 'Sanırım @cmt-filiz bunu biliyor.');

    const mentions = (await notifications.inbox(orgA, filiz, true)).filter(
      (n) => n.kind === 'task.mention',
    );
    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.title).toContain('cmt-engin seni andı');
  });

  it('sends one notification, not two, to someone who is both watching and mentioned', async () => {
    const task = await tasks.create(orgA, derya, 'Hem izleyen hem anılan', engin);
    await comments.add(orgA, task.id, engin, 'Bak buraya @cmt-derya.');

    const heard = await notifications.inbox(orgA, derya, true);
    expect(heard.filter((n) => n.kind === 'task.mention')).toHaveLength(1);
    // İki satırdan biri her zaman daha az bilgi taşıyan olurdu, ve ikisi de aynı yere götürüyor.
    expect(heard.filter((n) => n.kind === 'task.comment')).toHaveLength(0);
  });

  it('does not subscribe someone merely for being mentioned', async () => {
    const task = await tasks.create(orgA, derya, 'Anmak abone etmez', engin);
    await comments.add(orgA, task.id, engin, 'Bilgin olsun @cmt-filiz.');

    // Bir kez anılmanın kişiyi işin bütün gelecek gürültüsüne kaydetmesi, insanların bildirimleri
    // okumayı bırakma sebebi.
    expect(await watchers.watching(orgA, task.id, filiz)).toBe(false);
  });

  it('matches a mention case-insensitively, as sign-in does', async () => {
    const task = await tasks.create(orgA, derya, 'Büyük harfle anma', engin);
    await comments.add(orgA, task.id, engin, 'Merhaba @CMT-FILIZ');

    expect(
      (await notifications.inbox(orgA, filiz, true)).filter((n) => n.kind === 'task.mention'),
    ).toHaveLength(1);
  });

  it('does not swallow the full stop at the end of a sentence', async () => {
    const task = await tasks.create(orgA, derya, 'Cümle sonu anması', engin);
    // `@cmt-filiz.` — sözleşmenin kullanıcı adı deseni sondaki noktaya izin veriyor, yani metin
    // gerçekten belirsiz. Kararı kullanıcı listesi veriyor, ve `cmt-filiz.` diye biri yok.
    await comments.add(orgA, task.id, engin, 'Bunu sorayım @cmt-filiz.');

    expect(
      (await notifications.inbox(orgA, filiz, true)).filter((n) => n.kind === 'task.mention'),
    ).toHaveLength(1);
  });

  it('does not treat an e-mail address as a mention', async () => {
    const task = await tasks.create(orgA, derya, 'E-posta testi', engin);
    await comments.add(orgA, task.id, engin, 'Adres: bir.sey@cmt-filiz burada bir anma değil.');

    // `@` bir kelimenin ortasındaysa mention değil. Aksi hâlde her e-posta adresi taranırdı.
    expect(
      (await notifications.inbox(orgA, filiz, true)).filter((n) => n.kind === 'task.mention'),
    ).toHaveLength(0);
  });

  it('resolves a mention only inside the caller’s tenant', async () => {
    const task = await tasks.create(orgA, derya, 'Kiracı sınırı', engin);
    // `cmt-gonca` B kiracısında. Cevap, adı hiç geçmemiş gibi — bir yorum kutusu bir kullanıcı adı
    // yoklama aracı olmamalı.
    await comments.add(orgA, task.id, engin, 'Selam @cmt-gonca');

    expect(await notifications.unreadCount(orgB, gonca)).toBe(0);
  });

  it('refuses a body that is empty or beyond the schema’s limit', async () => {
    const task = await tasks.create(orgA, derya, 'Sınır testi', engin);
    await expect(comments.add(orgA, task.id, engin, '   ')).rejects.toBeInstanceOf(
      CommentRejectedError,
    );
    // Şemadaki kısıtla aynı sayı, ve bu yüzden 500 değil 422 dönüyor.
    await expect(comments.add(orgA, task.id, engin, 'x'.repeat(4001))).rejects.toBeInstanceOf(
      CommentRejectedError,
    );
  });

  it('lets the author edit and marks that it happened', async () => {
    const task = await tasks.create(orgA, derya, 'Düzenleme testi', engin);
    const written = await comments.add(orgA, task.id, engin, 'İlk hâli');
    expect(written.edited_at).toBeNull();

    const edited = await comments.edit(orgA, task.id, written.id, engin, 'İkinci hâli');
    expect(edited.body).toBe('İkinci hâli');
    // Sonradan değişmiş bir cümleyi hiç değişmemiş gibi göstermek, alıntılanamaz bir kayıt üretir.
    expect(edited.edited_at).not.toBeNull();
  });

  it('refuses an edit by anyone else, the administrator included', async () => {
    const task = await tasks.create(orgA, derya, 'Başkasının cümlesi', engin);
    const written = await comments.add(orgA, task.id, engin, 'Bunu ben yazdım');

    // Derya bu kiracının YÖNETİCİSİ, ve yine de düzenleyemiyor: bir tartışma kaydının tek işi
    // alıntılanabilir olmak.
    await expect(
      comments.edit(orgA, task.id, written.id, derya, 'Hayır yazmadın'),
    ).rejects.toBeInstanceOf(CommentNotYoursError);
  });

  it('deletes softly: the row stays, the body never comes back, the audit records it', async () => {
    const task = await tasks.create(orgA, derya, 'Silme testi', engin);
    const written = await comments.add(orgA, task.id, engin, 'Silinecek gizli cümle');

    await comments.remove(orgA, task.id, written.id, engin, false);

    const [listed] = await comments.list(orgA, task.id);
    expect(listed?.deleted_at).not.toBeNull();
    // Satır var, gövde yok: "bu yorum silindi" okunabilir bir kayıt, sessizce kaybolmak değil.
    expect(listed?.body).toBe('');

    const audit = await tasks.activity(orgA, task.id);
    const trace = audit.find((row) => row.field === 'comment');
    // Kaybolan şeyin izi başka hiçbir yerde kalmıyor, o yüzden denetimde duruyor.
    expect(trace?.old_value).toContain('Silinecek gizli cümle');
    expect(trace?.new_value).toBeNull();
  });

  it('lets an administrator delete somebody else’s comment', async () => {
    const task = await tasks.create(orgA, derya, 'Yönetici silmesi', engin);
    const written = await comments.add(orgA, task.id, engin, 'Uygunsuz bir şey');

    await comments.remove(orgA, task.id, written.id, derya, true);
    expect((await comments.list(orgA, task.id))[0]?.deleted_at).not.toBeNull();
  });

  it('refuses a deletion by a member who did not write it', async () => {
    const task = await tasks.create(orgA, derya, 'Başkasının silmesi', engin);
    const written = await comments.add(orgA, task.id, engin, 'Benim yorumum');

    await expect(comments.remove(orgA, task.id, written.id, filiz, false)).rejects.toBeInstanceOf(
      CommentNotYoursError,
    );
  });

  it('will not edit a comment back into existence after it was deleted', async () => {
    const task = await tasks.create(orgA, derya, 'Geri getirme yok', engin);
    const written = await comments.add(orgA, task.id, engin, 'Gitmiş olacak');
    await comments.remove(orgA, task.id, written.id, engin, false);

    await expect(
      comments.edit(orgA, task.id, written.id, engin, 'Geri geldim'),
    ).rejects.toBeInstanceOf(CommentNotFoundError);
  });

  it('keeps the first deletion’s record when the same comment is deleted twice', async () => {
    const task = await tasks.create(orgA, derya, 'İkinci silme', engin);
    const written = await comments.add(orgA, task.id, engin, 'Bir kez silinecek');
    await comments.remove(orgA, task.id, written.id, engin, false);

    // İkinci silme sessizce bitiyor: `deleted_by`'ı ikinci silene kaydırmak ilk kaydı bozardı.
    await comments.remove(orgA, task.id, written.id, derya, true);

    const rows = await owner.withTenant(orgA, (q) =>
      q.query<{ deleted_by: string }>(
        `SELECT deleted_by::text AS deleted_by FROM task_comments WHERE id = $1`,
        [written.id],
      ),
    );
    expect(rows[0]?.deleted_by).toBe(engin);
  });

  it('shows the NEWEST comments when a thread runs past the page cap', async () => {
    const task = await tasks.create(orgA, derya, 'Uzun tartışma', engin);
    // Kapaktan bir fazla. İlk hâl `ORDER BY created_at ASC LIMIT 500` idi, yani beş yüzüncü
    // yorumdan sonrası hiç görünmüyordu — bir tartışma tam da canlandığı anda sessizce donuyordu.
    await owner.withTenant(orgA, (q) =>
      q.query(
        `INSERT INTO task_comments (organization_id, task_id, author_id, body, created_at)
         SELECT $1, $2, $3, 'yorum ' || i, now() - make_interval(secs => 501 - i)
           FROM generate_series(1, 501) AS i`,
        [orgA, task.id, engin],
      ),
    );

    const listed = await comments.list(orgA, task.id);
    expect(listed).toHaveLength(500);
    expect(listed[listed.length - 1]?.body).toBe('yorum 501');
    // Ve yine ESKİ ÖNCE diziliyor: kapak yeni uçtan alıyor, ekran yukarıdan aşağı okunuyor.
    expect(listed[0]?.body).toBe('yorum 2');
  });

  it('refuses to edit or delete a comment through another task’s address', async () => {
    const mine = await tasks.create(orgA, derya, 'Doğru iş', engin);
    const other = await tasks.create(orgA, derya, 'Başka iş', engin);
    const written = await comments.add(orgA, mine.id, engin, 'Doğru işin yorumu');

    // Adres bir ilişki İDDİA EDİYOR, ve sunucu onu doğruluyor. Yetki açığı değildi — çağıran yine
    // yazan olmak zorundaydı — ama o adrese güvenen bir istemci yanlış işi düzenleyebilirdi.
    await expect(
      comments.edit(orgA, other.id, written.id, engin, 'Yanlış adresten'),
    ).rejects.toBeInstanceOf(CommentNotFoundError);
    await expect(comments.remove(orgA, other.id, written.id, engin, false)).rejects.toBeInstanceOf(
      CommentNotFoundError,
    );
  });

  it('mentions somebody whose username is the longest the schema allows', async () => {
    // 64 karakter: `0010_usernames.sql`'in CHECK'i tam bu. Mention deseni bir karakter kısaydı, ve
    // bu kişi hiç anılamıyordu — yazan için görünmez bir başarısızlık.
    const long = `u${'x'.repeat(63)}`;
    const [seeded] = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1, $2, 'member', 'x') RETURNING id::text AS id`,
        [orgA, long],
      ),
    );
    const task = await tasks.create(orgA, derya, 'En uzun ad', engin);
    await comments.add(orgA, task.id, engin, `Selam @${long}`);

    expect(
      (await notifications.inbox(orgA, seeded?.id ?? '', true)).filter(
        (n) => n.kind === 'task.mention',
      ),
    ).toHaveLength(1);

    await owner.withoutTenant('migration-status', (q) =>
      q.query(`DELETE FROM users WHERE id = $1`, [seeded?.id ?? '']),
    );
  });

  it('lets an account be closed after that account deleted a comment', async () => {
    // `deleted_by` `ON DELETE SET NULL`, ve bir zamanlar buna eşlik eden CHECK ("ikisi birlikte var
    // ya da birlikte yok") tam bu silmeyi bir kısıt hatasına çeviriyordu. Bir hesabın
    // kapatılabilmesi, o hesabın bir yorum silmiş olmasına bağlı olamaz.
    const [temp] = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1, 'cmt-gecici', 'member', 'x') RETURNING id::text AS id`,
        [orgA],
      ),
    );
    const who = temp?.id ?? '';
    const task = await tasks.create(orgA, derya, 'Hesabı kapanacak silici', engin);
    const written = await comments.add(orgA, task.id, engin, 'Silinecek');
    await comments.remove(orgA, task.id, written.id, who, true);

    await expect(
      owner.withoutTenant('migration-status', (q) =>
        q.query(`DELETE FROM users WHERE id = $1`, [who]),
      ),
    ).resolves.toBeDefined();

    // Silme kaydı DURUYOR, yalnız kim sildiği anonimleşti: "silindi" bilgisi kaybolmuyor.
    const [after] = await comments.list(orgA, task.id);
    expect(after?.deleted_at).not.toBeNull();
  });

  it('does not leak a comment across tenants, and says the job is missing instead', async () => {
    const task = await tasks.create(orgA, derya, 'Kiracı sızıntısı yok', engin);
    await comments.add(orgA, task.id, engin, 'A kiracısının yorumu');

    // B kiracısından bakınca ortada bir görev bile yok — yorumların boş olması değil, görevin
    // bulunamaması doğru cevap.
    await expect(comments.list(orgB, task.id)).rejects.toThrow();
  });
});
