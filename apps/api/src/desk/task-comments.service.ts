import { Injectable, Logger } from '@nestjs/common';

import { DbService } from '../db/db.service.js';
import { NotificationsService } from './notifications.service.js';
import { TaskWatchersService } from './task-watchers.service.js';
import { TasksService } from './tasks.service.js';

/** Bir yorumun okunmak üzere döndüğü hâli. */
export interface CommentRow {
  id: string;
  author_id: string | null;
  author_username: string | null;
  body: string;
  edited_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
}

export class CommentNotFoundError extends Error {
  constructor() {
    super('comment not found');
    this.name = 'CommentNotFoundError';
  }
}

export class CommentNotYoursError extends Error {
  constructor() {
    super('a comment may be edited only by the person who wrote it');
    this.name = 'CommentNotYoursError';
  }
}

/**
 * Şemadaki `task_comments_body_sane` ile AYNI sayı, ve burada olmasının sebebi cevabın kalitesi:
 * kısıt ihlali 500'e dönüşürdü, bu 422'ye. İkisi birden var çünkü ikisi farklı şeyleri koruyor —
 * biri kullanıcıya cevap veriyor, öteki tabloya ne girdiğini garanti ediyor.
 */
const MAX_BODY = 4000;

/**
 * Bir mention: `@` ve ardından bir kullanıcı adı.
 *
 * Desen, sözleşmenin `CreateUserRequest.username` deseniyle aynı sınırlar içinde: alfanümerik
 * başlıyor, sonrasında `.`, `-` ve `_` serbest, ve TOPLAM 64 KARAKTER — 1 + 63, tam olarak
 * `0010_usernames.sql`'in `CHECK`'i kadar. İlk hâl bir karakter kısaydı, ve en uzun kullanıcı
 * adını taşıyan kişi hiç anılamıyordu: yazan için görünmez bir başarısızlık, çünkü yorumu
 * kusursuz görünüyor ve karşı taraf hiçbir şey duymuyor. Daha GENİŞ bir desen de yanlış
 * olurdu — kullanıcı adı olamayacak şeyleri arayıp her seferinde boş dönen bir sorgu.
 *
 * ÖNÜNDEKİ KARAKTER de önemli: `foo@bar` bir mention değil, bir e-posta adresinin ortası. Bu yüzden
 * `@` ya satır başında ya da bir boşluk/noktalama sonrasında olmak zorunda — aksi hâlde her
 * e-posta adresi, var olmayan bir kullanıcıya yapılmış bir çağrı gibi taranırdı.
 */
const MENTION = /(^|[^\w.@-])@([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})/gu;

/**
 * Görev yorumları ve mention'lar (§7).
 *
 * MENTION SUNUCUDA ÇÖZÜLÜYOR, istemcide değil. İstemcinin gönderdiği bir "şu kişileri bilgilendir"
 * listesi, herhangi birine herhangi bir bildirim göndermenin yolu olurdu — gövdede adı geçmeyen
 * birine de. Sunucu yalnız GÖVDEDE gerçekten yazan adları çözüyor, ve yalnız kendi kiracısında.
 *
 * ÇÖZÜM KİRACIYLA SINIRLI, ve bu bir yan etki değil bir kural: başka bir kiracıdaki `@ayse` hiçbir
 * şey üretmiyor, ve üretmediği de dışarıdan görünmüyor — cevap, adı hiç geçmemiş gibi. Bir mention
 * bir kullanıcı adı yoklama aracı olmamalı.
 *
 * ANILMAK ABONE ETMİYOR. Bir kez anılmanın sizi o işin bütün gelecek gürültüsüne kaydetmesi,
 * insanların bildirimleri okumayı bırakma sebebi. Yorum YAZMAK abone ediyor: konuşmaya girmek,
 * devamını duymak istemek demek.
 */
@Injectable()
export class TaskCommentsService {
  private readonly logger = new Logger(TaskCommentsService.name);

  constructor(
    private readonly db: DbService,
    private readonly tasks: TasksService,
    private readonly watchers: TaskWatchersService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Bir işin yorumları, ESKİ ÖNCE.
   *
   * Bir tartışma yukarıdan aşağı okunuyor; bildirim listesi en yeni önce çünkü orada okunacak olan
   * son olay, burada okunacak olan konuşmanın kendisi.
   *
   * Silinmiş yorumun GÖVDESİ dönmüyor ama SATIRI dönüyor. Bir konuşmadan sessizce kaybolan bir
   * replika, okuyanı kendi hafızasından şüphe ettirir; "bu yorum silindi" ise okunabilir bir kayıt.
   */
  async list(organizationId: string, taskId: string): Promise<CommentRow[]> {
    // Görevin varlığı önce doğrulanıyor: olmayan bir görev için boş liste, "hiç yorum yok" ile
    // "böyle bir görev yok"u aynı cevaba çevirirdi. `activity` ile aynı gerekçe.
    await this.tasks.find(organizationId, taskId);
    return this.db.withTenant(organizationId, (db) =>
      db.query<CommentRow>(
        // KAPAK EN YENİ UÇTAN alıyor, sonra ekrana eski önce diziliyor.
        //
        // Buradaki ilk hâl `ORDER BY created_at ASC LIMIT 500` idi, yani beş yüzüncü yorumdan
        // sonra gelen HİÇBİR ŞEY görünmüyordu — bir tartışma tam da canlandığı anda sessizce
        // donuyor, ve ekranda hiçbir belirti olmuyor. Bir kapak, gösterdiği şeyin ucunu değil
        // BAŞINI kesmeli.
        `SELECT * FROM (
           SELECT c.id::text AS id, c.author_id::text AS author_id, u.username AS author_username,
                  -- Gövde SORGUDA maskeleniyor, sunucu kodunda değil: bir gün ikinci bir okuma
                  -- yolu yazılırsa, maskeyi uygulamayı unutması mümkün olmasın.
                  CASE WHEN c.deleted_at IS NULL THEN c.body ELSE '' END AS body,
                  c.edited_at, c.deleted_at, c.created_at
             FROM public.task_comments c
             LEFT JOIN public.users u ON u.id = c.author_id
            WHERE c.organization_id = $1 AND c.task_id = $2
            ORDER BY c.created_at DESC, c.id DESC
            LIMIT 500
         ) recent
         -- Bir tartışma yukarıdan aşağı okunuyor; bildirim listesi en yeni önce çünkü orada
         -- okunacak olan son olay.
         ORDER BY created_at, id`,
        [organizationId, taskId],
      ),
    );
  }

  /**
   * Yorum ekle: satırı yaz, yazanı abone et, izleyicilere ve anılanlara haber ver.
   *
   * Sıralama önemli. Satır ve abonelik AYNI işlemde — yorumu yazan kişinin cevabı duymaması, en
   * belirtisiz arıza. Bildirim işlemin DIŞINDA: bir bildirimin yazılamaması, bildirdiği şeyin
   * olmamasına yol açmamalı.
   */
  async add(
    organizationId: string,
    taskId: string,
    authorId: string,
    body: string,
  ): Promise<CommentRow> {
    const trimmed = body.trim();
    if (trimmed === '' || trimmed.length > MAX_BODY) {
      throw new CommentRejectedError(
        trimmed === '' ? 'yorum boş olamaz' : `yorum en çok ${MAX_BODY} karakter olabilir`,
      );
    }
    await this.tasks.find(organizationId, taskId);

    const rows = await this.db.withTenant(organizationId, async (db) => {
      const written = await db.query<CommentRow>(
        `WITH inserted AS (
           INSERT INTO public.task_comments (organization_id, task_id, author_id, body)
           VALUES ($1, $2, $3, $4)
           RETURNING *
         )
         SELECT c.id::text AS id, c.author_id::text AS author_id, u.username AS author_username,
                c.body, c.edited_at, c.deleted_at, c.created_at
           FROM inserted c
           LEFT JOIN public.users u ON u.id = c.author_id`,
        [organizationId, taskId, authorId, trimmed],
      );
      // Konuşmaya giren, devamını duymak istiyor.
      await TaskWatchersService.attach(db, organizationId, taskId, [authorId], 'commented');
      return written;
    });

    const row = rows[0];
    if (!row) throw new Error('the comment row was not returned');

    // YUTULUYOR, ve bu kuralın kendisi: yorum zaten YAZILDI (yukarıdaki `withTenant` COMMIT etti),
    // ve buradan çıkan bir hata çağırana "yorum gönderilemedi" dedirtirdi — ekranda görünmeyen ama
    // veritabanında duran bir yorum, ve kullanıcı onu bir daha yazıyor. `notifyMany` kendi
    // yazma hatasını zaten yutuyordu; buradaki delik, `announce`'un İÇİNDEKİ okumalardı.
    try {
      await this.announce(organizationId, taskId, authorId, trimmed);
    } catch (error) {
      this.logger.warn(
        `comment ${row.id}: written, but could not be announced: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return row;
  }

  /**
   * Kendi yorumunu düzenle.
   *
   * YALNIZ YAZAN, yönetici bile değil. Bir yöneticinin başkasının ağzından cümle değiştirebilmesi,
   * yorum listesini alıntılanamaz yapardı — ve bir tartışma kaydının tek işi alıntılanabilir olmak.
   * Yöneticinin yapabileceği şey silmek, ve silinen bir yorum silindiğini söylüyor.
   *
   * Düzenleme yeni bildirim ÜRETMİYOR, mention eklense bile. Bir düzenlemeyle birine bildirim
   * göndermek, yazılmış bir cümleyi sonradan bir çağrıya çevirmek olurdu; anmak isteyen yeni bir
   * yorum yazıyor, ki zaten görünen davranış da bu.
   */
  async edit(
    organizationId: string,
    taskId: string,
    commentId: string,
    editorId: string,
    body: string,
  ): Promise<CommentRow> {
    const trimmed = body.trim();
    if (trimmed === '' || trimmed.length > MAX_BODY) {
      throw new CommentRejectedError(
        trimmed === '' ? 'yorum boş olamaz' : `yorum en çok ${MAX_BODY} karakter olabilir`,
      );
    }

    const existing = await this.find(organizationId, taskId, commentId);
    if (existing.author_id !== editorId) throw new CommentNotYoursError();
    // Silinmiş bir yorumu düzenlemek onu geri getirirdi, ve geri getirme ayrı bir karar. Bugün
    // öyle bir yol yok, ve olmadığını burada söylemek onu kazayla açmaktan iyi.
    if (existing.deleted_at !== null) throw new CommentNotFoundError();

    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<CommentRow>(
        `WITH updated AS (
           UPDATE public.task_comments SET body = $4, edited_at = now()
            WHERE organization_id = $1 AND task_id = $2 AND id = $3 AND deleted_at IS NULL
            RETURNING *
         )
         SELECT c.id::text AS id, c.author_id::text AS author_id, u.username AS author_username,
                c.body, c.edited_at, c.deleted_at, c.created_at
           FROM updated c
           LEFT JOIN public.users u ON u.id = c.author_id`,
        [organizationId, taskId, commentId, trimmed],
      ),
    );
    const row = rows[0];
    if (!row) throw new CommentNotFoundError();
    return row;
  }

  /**
   * Yorumu sil — yumuşak, ve denetime yazarak.
   *
   * Yazan ya da yönetici silebiliyor. Gövde tabloda kalıyor ve API onu bir daha döndürmüyor: bir
   * yorumun silinmiş olması, en çok bakılacak an geldiğinde ne yazdığını da bilmeyi gerektirir.
   *
   * `task_activity`'ye YAZILIYOR, eklenme yazılmıyor. Yorumun kendisi eklendiğinin kaydı zaten;
   * kaybolan şeyin izi ise başka hiçbir yerde kalmıyor.
   */
  async remove(
    organizationId: string,
    taskId: string,
    commentId: string,
    actorId: string,
    isAdmin: boolean,
  ): Promise<void> {
    const existing = await this.find(organizationId, taskId, commentId);
    if (!isAdmin && existing.author_id !== actorId) throw new CommentNotYoursError();
    // Zaten silinmişse sessizce bitiyor: ikinci silme, `deleted_by`'ı ikinci silene kaydırıp ilk
    // kaydı bozardı.
    if (existing.deleted_at !== null) return;

    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ task_id: string; body: string }>(
        `UPDATE public.task_comments SET deleted_at = now(), deleted_by = $4
          WHERE organization_id = $1 AND task_id = $2 AND id = $3 AND deleted_at IS NULL
          RETURNING task_id::text AS task_id, body`,
        [organizationId, taskId, commentId, actorId],
      ),
    );
    const row = rows[0];
    if (!row) return;

    await this.tasks.note(organizationId, row.task_id, actorId, {
      field: 'comment',
      old: row.body.slice(0, 200),
      new: null,
    });
  }

  /**
   * Tek bir yorum, silinmiş olsa bile — yetki kontrolleri buna bakıyor.
   *
   * `task_id` DE ARANIYOR. İlk hâl yalnız `(organization_id, id)` ile bakıyordu, yani
   * `PATCH /tasks/<herhangi-bir-iş>/comments/<id>` yoldaki işi tamamen yok sayıyordu: adres bir
   * ilişki iddia ediyor, sunucu onu doğrulamıyordu. Yetki açığı değil — çağıran yine yazan ya da
   * yönetici olmak zorunda — ama sözleşmenin söylediği şeyin doğru olmaması, ve o adrese güvenen
   * bir istemcinin yanlış işi düzenlemesi.
   */
  private async find(
    organizationId: string,
    taskId: string,
    commentId: string,
  ): Promise<CommentRow> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<CommentRow>(
        `SELECT id::text AS id, author_id::text AS author_id, NULL::text AS author_username,
                body, edited_at, deleted_at, created_at
           FROM public.task_comments
          WHERE organization_id = $1 AND task_id = $2 AND id = $3`,
        [organizationId, taskId, commentId],
      ),
    );
    const row = rows[0];
    if (!row) throw new CommentNotFoundError();
    return row;
  }

  /**
   * Yeni yorumu duyur: izleyicilere bir "yeni yorum", anılanlara bir "seni andı".
   *
   * BAŞLIK YORUMUN METNİNİ TAŞIMIYOR, İŞİN metnini taşıyor. Sebep 0027'nin kısmi benzersiz
   * indeksi: aynı iş için okunmamış ikinci bir `task.comment` yazılmıyor, ve yazılsaydı gecikmiş
   * bir tartışma zili doldururdu. Yani ilk bildirimin başlığı, beş yorum sonra da ekranda duran
   * başlık — ve o başlık bir yorumun metni olsaydı yanıltıcı olurdu. "Şu işte yeni yorum var"
   * ise kaç yorum gelirse gelsin doğru kalıyor.
   *
   * Bildirim bir İŞARETÇİ, içeriğin bir kopyası değil. Okuyan işe gidiyor ve hepsini orada
   * görüyor.
   *
   * ANILAN KİŞİ İKİ BİLDİRİM ALMIYOR. Hem izleyip hem anılan biri yalnız "seni andı" alıyor: iki
   * satırdan biri her zaman daha az bilgi taşıyan olurdu, ve ikisi de aynı yere götürüyor.
   */
  private async announce(
    organizationId: string,
    taskId: string,
    authorId: string,
    body: string,
  ): Promise<void> {
    const [task, mentioned, watching] = await Promise.all([
      this.tasks.find(organizationId, taskId),
      this.resolveMentions(organizationId, body),
      this.watchers.recipients(organizationId, taskId),
    ]);
    const summary = task.body.trim().slice(0, 60);
    const author = await this.usernameOf(organizationId, authorId);

    type Item = Parameters<NotificationsService['notifyMany']>[0][number];
    const items: Item[] = mentioned.map((userId) => ({
      organizationId,
      userId,
      actorId: authorId,
      kind: 'task.mention',
      taskId,
      title: `${author} seni andı: ${summary}`,
    }));

    const alsoMentioned = new Set(mentioned);
    for (const userId of watching) {
      if (alsoMentioned.has(userId)) continue;
      items.push({
        organizationId,
        userId,
        actorId: authorId,
        kind: 'task.comment',
        taskId,
        title: `Yeni yorum: ${summary}`,
      });
    }

    await this.notifications.notifyMany(items);
  }

  /**
   * Gövdedeki `@ad`'leri bu kiracının kullanıcılarına çöz.
   *
   * NOKTALAMA BELİRSİZ, ve veritabanı karar veriyor. "Bak buraya @ayse." cümlesinde `@ayse.` mi
   * yoksa `@ayse` mi kastedildiği metinden anlaşılmıyor — sözleşmenin kullanıcı adı deseni
   * (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`) sondaki noktaya izin veriyor, yani ikisi de geçerli bir
   * ad olabilir. O yüzden her iki aday da soruluyor ve GERÇEKTEN VAR OLANLARIN EN UZUNU seçiliyor.
   *
   * Bu bir incelik değil bir hata düzeltmesi: sondaki noktayı ada dahil eden ilk sürüm, cümle
   * sonundaki her anmayı sessizce düşürüyordu — yazan için görünmez bir başarısızlık, çünkü
   * gönderdiği yorum kusursuz görünüyor ve karşı taraf hiçbir şey duymuyor.
   *
   * TEK SORGU, aday başına bir tane değil: on mention'lı bir yorum on sorgu etmemeli.
   *
   * Bulunamayan ad SESSİZCE düşüyor. "Böyle bir kullanıcı yok" demek, bir yorum kutusunu kullanıcı
   * adı yoklama aracına çevirirdi — ve yazan kişi zaten kimi kastettiğini biliyor.
   *
   * Karşılaştırma katlanarak (`lower`), çünkü giriş de öyle çalışıyor: bir kişiyi `@Ayse` diye
   * anıp bildirimin gitmemesi, yazan için yine sessiz bir başarısızlık.
   */
  private async resolveMentions(organizationId: string, body: string): Promise<string[]> {
    const tokens = [...new Set([...body.matchAll(MENTION)].map((m) => (m[2] ?? '').toLowerCase()))]
      .filter((token) => token !== '')
      .map((token) => candidates(token));
    const asked = [...new Set(tokens.flat())];
    if (asked.length === 0) return [];

    try {
      const rows = await this.db.withTenant(organizationId, (db) =>
        db.query<{ id: string; folded: string }>(
          `SELECT id::text AS id, lower(username) AS folded FROM public.users
            WHERE organization_id = $1 AND lower(username) = ANY($2::text[])`,
          [organizationId, asked],
        ),
      );
      const found = new Map(rows.map((row) => [row.folded, row.id]));
      // Uzundan kısaya: `@ayse.` gerçekten bir kullanıcıysa o kastedilmiştir, değilse noktanın
      // cümlenin parçası olduğu anlaşılıyor.
      const hit = tokens
        .map((variants) => variants.map((name) => found.get(name)).find((id) => id !== undefined))
        .filter((id): id is string => id !== undefined);
      return [...new Set(hit)];
    } catch (error) {
      this.logger.warn(
        `could not resolve mentions: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  /** Bildirim cümlesinde geçen ad. Okunamazsa "Biri" — cümle yine kurulabiliyor. */
  private async usernameOf(organizationId: string, userId: string): Promise<string> {
    try {
      const rows = await this.db.withTenant(organizationId, (db) =>
        db.query<{ username: string }>(
          `SELECT username FROM public.users WHERE organization_id = $1 AND id = $2`,
          [organizationId, userId],
        ),
      );
      return rows[0]?.username ?? 'Biri';
    } catch {
      return 'Biri';
    }
  }
}

/** Gövde reddedildi. 422'ye çevriliyor. */
export class CommentRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CommentRejectedError';
  }
}

/**
 * Bir mention belirtecinin olası okumaları, UZUNDAN KISAYA.
 *
 * `ayse...` → `['ayse...', 'ayse..', 'ayse.', 'ayse']`. Sondaki noktalama bir adın parçası da
 * olabilir cümlenin parçası da; hangisi olduğunu metin söylemiyor, kullanıcı listesi söylüyor.
 */
function candidates(token: string): string[] {
  const all = [token];
  let rest = token;
  while (rest.length > 1 && /[._-]$/u.test(rest)) {
    rest = rest.slice(0, -1);
    all.push(rest);
  }
  return all;
}
