import { Injectable, Logger } from '@nestjs/common';

import { DbService, type TenantQuery } from '../db/db.service.js';
import { NotificationsService } from './notifications.service.js';

export interface TaskRow {
  id: string;
  body: string;
  /**
   * İşi kim açtı.
   *
   * Bildirim için seçiliyor: durum değişimi işin SAHİPLERİNE gidiyor, ve oluşturan onlardan biri
   * — işi verdiği için sonucunu bekleyen kişi. Silinen hesapta NULL.
   */
  created_by: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_at: Date | null;
  assignee_id: string | null;
  assignee_username: string | null;
  done_at: Date | null;
  position: number;
  created_at: Date;
  updated_at: Date;
}

export type TaskStatus = 'draft' | 'assigned' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * §7'nin durum makinesi — ve yasakladığı şeyin ne kadar DAR olduğu.
 *
 * İlk hâli diyagramı harfi harfine uyguluyordu: `Taslak → Atandı → DevamEdiyor → İncelemede →
 * Tamamlandı`. Var olan testler onu üç ayrı yerden kırdı, ve üçü de aynı şeyi söylüyordu: bu pano
 * yalnız yöneticinin izlediği atanmış iş değil, aynı zamanda "birinin şunu yapması lazım" listesi.
 * Kimseye atanmamış bir maddeyi yapıp kutusunu işaretlemek onun ANA kullanımı, ve araya `assigned`
 * ile `in_progress` sokmak olmamış iki geçişi denetim izine yazmak olurdu.
 *
 * O yüzden makine diyagramı DAYATMIYOR ve dayattığını iddia etmiyor. Diyagram BEKLENEN yolu
 * anlatıyor; buradaki kısıt yalnız KAYDI YALANCI YAPAN iki geçişi kesiyor:
 *
 *   * `done → cancelled` — hem yapıldı hem yapılmadı. `done_at` dolu bir iptal, "ne zaman
 *     bitirdik" sorusuna cevabı olan ama anlamı olmayan bir satır bırakır.
 *   * `cancelled → in_progress | in_review | done` — bırakılmış bir iş önce geri alınmalı. Onsuz
 *     "iptal edildi" bir durum değil, atlanabilen bir adım olurdu.
 *
 * İki şeyi yasaklayan ve bunu söyleyen bir makine, uygulamadığı bir diyagramı uyguladığını iddia
 * eden bir makineden iyidir. Sunucuda olmasının sebebi değişmedi: `PATCH` her istemciye açık, ve
 * yalnız arayüzde yaşayan bir kısıt kısıt değildir.
 *
 * Bir durumdan KENDİSİNE geçiş serbest: arayüz her düzenlemede bütün satırı geri gönderiyor ve
 * değişmeyen bir alanın reddedilmesi, alakasız bir düzenlemeyi imkânsız yapardı.
 */
const OPEN: readonly TaskStatus[] = ['draft', 'assigned', 'in_progress', 'in_review'];

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: [...OPEN, 'done', 'cancelled'],
  assigned: [...OPEN, 'done', 'cancelled'],
  in_progress: [...OPEN, 'done', 'cancelled'],
  in_review: [...OPEN, 'done', 'cancelled'],
  // Bitmiş bir iş yeniden açılabilir — "tamamlandı" bir hata olabilir — ama iptal edilemez.
  done: OPEN,
  // Bırakılmış bir iş önce geri alınıyor; oradan istenen yere gidiyor.
  cancelled: ['draft', 'assigned'],
};

/** Bir alanın eski hâli, denetim izine yazmak için. */
export interface TaskChange {
  field: 'status' | 'priority' | 'due_at' | 'assignee_id' | 'body' | 'file_link';
  old: string | null;
  new: string | null;
}

/** Bildirim metninde geçen durum adları. Sunucuda, çünkü metin o an üretiliyor. */
const STATUS_TEXT: Record<TaskStatus, string> = {
  draft: 'Taslağa alındı',
  assigned: 'Atandı',
  in_progress: 'Başlandı',
  in_review: 'İncelemeye girdi',
  done: 'Tamamlandı',
  cancelled: 'İptal edildi',
};

/**
 * Bir işin gövdesinin bildirime sığan hâli.
 *
 * Kesme YERİNDE yapılıyor, sonuna üç nokta konuyor — ve şemadaki 300 karakterlik sınır bunun
 * altında kalmasını garanti ediyor. Sınırı aşan bir başlık, bildirimi hiç yazılmayan bir satıra
 * çevirirdi.
 */
function short(body: string): string {
  const trimmed = body.trim();
  return trimmed.length <= 80 ? trimmed : `${trimmed.slice(0, 79)}…`;
}

/** Bir denetim satırı, okunmak için. */
export interface ActivityRow {
  id: string;
  actor_username: string | null;
  field: TaskChange['field'];
  old_value: string | null;
  new_value: string | null;
  created_at: Date;
}

/**
 * §7'nin diyagramının izin vermediği bir geçiş.
 *
 * Kendi hata tipi, çünkü çağıran bunu 422 yapıyor ve mesaj İKİ durumu da adlandırmak zorunda:
 * "geçersiz durum" diyen bir hata, hangi geçişin reddedildiğini söylemiyor ve arayüzü tahmine
 * bırakıyor.
 */
/**
 * `done` ve `status` aynı istekte.
 *
 * Kendi tipi ve `TaskRejectedError`'ın yeniden kullanılmaması bilinçli: o hata "gövde 1-2000
 * karakter olmalı" diyor, ve göndermediği bir alanı düzeltmesi söylenen bir istemci, hatanın
 * kendisinden daha çok zaman kaybettirir.
 */
export class TaskBothStatusFieldsError extends Error {
  constructor() {
    super("send either 'done' or 'status', not both");
    this.name = 'TaskBothStatusFieldsError';
  }
}

export class TaskStatusTransitionRefused extends Error {
  constructor(
    readonly from: TaskStatus,
    readonly to: TaskStatus,
  ) {
    super(`a task cannot go from '${from}' to '${to}'`);
    this.name = 'TaskStatusTransitionRefused';
  }
}

/**
 * İki satır arasındaki fark, denetim izi için.
 *
 * `updated_at` ve `position` DIŞARIDA. İlki her yazmada değişiyor ve hiçbir şey anlatmıyor;
 * ikincisi bir sürükle-bırak, ve panoyu yeniden sıralayan biri denetim izini yüz satırla
 * doldurmamalı — izin okunabilir kalması, içinde ne olduğu kadar önemli.
 */
function diff(before: TaskRow, after: TaskRow): TaskChange[] {
  const changes: TaskChange[] = [];
  const add = (field: TaskChange['field'], a: string | null, b: string | null): void => {
    if (a !== b) changes.push({ field, old: a, new: b });
  };
  add('status', before.status, after.status);
  add('priority', before.priority, after.priority);
  add('due_at', iso(before.due_at), iso(after.due_at));
  add('assignee_id', before.assignee_id, after.assignee_id);
  add('body', before.body, after.body);
  return changes;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** No such job, or it belongs to another tenant — deliberately one answer, as RLS makes it. */
export class TaskNotFoundError extends Error {
  constructor() {
    super('no such task');
    this.name = 'TaskNotFoundError';
  }
}

/**
 * The person the job was to be assigned to is not in this organisation.
 *
 * Its own error rather than a generic "not found" because the two are different repairs: one
 * means the job is gone, the other means the name in the picker is stale.
 */
export class AssigneeNotFoundError extends Error {
  constructor() {
    super('no such user in this organization');
    this.name = 'AssigneeNotFoundError';
  }
}

/** SQLSTATE 23514 from `tasks_body_present`: an empty body, or one past 2000 characters. */
export class TaskRejectedError extends Error {
  constructor() {
    super('a task needs a body of between 1 and 2000 characters');
    this.name = 'TaskRejectedError';
  }
}

/**
 * The board's shape, assembled the same way everywhere it is returned.
 *
 * `assignee_username` comes from a LEFT JOIN rather than a second round trip: an unassigned job is
 * a real state, so the join has to survive a NULL, and an inner join would silently drop exactly
 * the rows the board most needs to show.
 */
const SELECT_COLUMNS = `t.id::text          AS id,
          t.body,
          t.created_by::text  AS created_by,
          t.status,
          t.priority,
          t.due_at,
          t.assignee_id::text AS assignee_id,
          u.username          AS assignee_username,
          t.done_at,
          t.position,
          t.created_at,
          t.updated_at`;

/**
 * The shared job board.
 *
 * Unlike notes there is no per-user predicate here, and that is the decision rather than an
 * omission: migration 0012 groups jobs BY PERSON, and a job assigned to somebody who cannot see it
 * has not been assigned. Everyone in the organisation reads and edits the whole board; RLS is what
 * keeps that "everyone" inside one tenant.
 */
@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly db: DbService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * The whole board, completed jobs included.
   *
   * Ordered by assignee, then by the manual position, then by age — the same tuple as the
   * `tasks_board` index, so the sort is read off the index rather than performed. Unassigned jobs
   * sort last because PostgreSQL puts NULLs last in an ascending order, which is also where the
   * "somebody should do this" column belongs on screen.
   */
  async list(organizationId: string): Promise<TaskRow[]> {
    return this.db.withTenant(organizationId, (db) =>
      db.query<TaskRow>(
        `SELECT ${SELECT_COLUMNS}
           FROM public.tasks t
           LEFT JOIN public.users u ON u.id = t.assignee_id
          WHERE t.organization_id = $1
          ORDER BY t.assignee_id, t.position, t.created_at`,
        [organizationId],
      ),
    );
  }

  async create(
    organizationId: string,
    createdBy: string,
    body: string,
    assigneeId: string | null,
  ): Promise<TaskRow> {
    try {
      const rows = await this.db.withTenant(organizationId, async (db) => {
        // Checked inside the SAME transaction as the insert, and checked at all because RLS would
        // not catch it: the row's own `organization_id` is correct, so the policy is satisfied
        // whatever `assignee_id` holds. Without this the appliance happily assigns work to an
        // account in another household — a foreign key to `public.users` says the person exists,
        // not that they are one of us.
        await assertAssignee(db, organizationId, assigneeId);

        return db.query<TaskRow>(
          `WITH inserted AS (
             INSERT INTO public.tasks (organization_id, created_by, body, assignee_id, status)
             -- Atananı olan bir is 'assigned' doguyor, olmayan 'draft'. 0026'nin var olan
             -- satirlar icin yaptigi eslemenin aynisi: yeni satirlarin eskilerden farkli bir
             -- kurala gore dogmasi, panoyu iki kuralin karistigi bir yer yapardi.
             VALUES ($1, $2, $3, $4, CASE WHEN $4::uuid IS NULL THEN 'draft' ELSE 'assigned' END)
             RETURNING *
           )
           SELECT ${SELECT_COLUMNS}
             FROM inserted t
             LEFT JOIN public.users u ON u.id = t.assignee_id`,
          [organizationId, createdBy, body, assigneeId],
        );
      });
      const row = rows[0];
      if (!row) throw new Error('the task row was not returned');
      // Doğarken atanmış bir iş de bir atama, ve bunu atlamak en sık düşen bildirimi eksik
      // bırakırdı: panoya bir iş çoğu zaman zaten birine verilmek için ekleniyor. Birine iş verip
      // haber vermemek, bildirim merkezinin cevaplaması gereken İLK soruyu cevapsız bırakmak.
      if (row.assignee_id !== null) {
        await this.notifications.notify({
          organizationId,
          userId: row.assignee_id,
          actorId: createdBy,
          kind: 'task.assigned',
          taskId: row.id,
          title: `Sana bir iş atandı: ${short(row.body)}`,
        });
      }
      return row;
    } catch (error) {
      throw translateDbError(error);
    }
  }

  async update(
    organizationId: string,
    id: string,
    changes: {
      body?: string | undefined;
      // `string | null` and `undefined` mean different things and both are reachable: null clears
      // the assignment, absent leaves it alone. Collapsing them would make "unassign" impossible
      // to express.
      assigneeId?: string | null | undefined;
      done?: boolean | undefined;
      status?: TaskStatus | undefined;
      priority?: TaskPriority | undefined;
      dueAt?: string | null | undefined;
      position?: number | undefined;
    },
    actorId: string | null = null,
  ): Promise<TaskRow> {
    // ÖNCE oku. Bir durum geçişini doğrulamak eski durumu bilmeyi gerektiriyor, ve denetim izi
    // "hangi eski değerle" istiyor (§7) — ikisi de aynı satırı okumakla çözülüyor, bir kez.
    const before = await this.find(organizationId, id);

    // `done` ile `status` aynı istekte gelemez. İkisini de kabul etmek "hangisi kazanır" sorusunu
    // doğurur: cevabı olan ama kimsenin bilmediği bir soru, ve iki istemci sürümünün aynı satır
    // hakkında farklı şey sanmasının en sessiz yolu.
    if (changes.done !== undefined && changes.status !== undefined) {
      throw new TaskBothStatusFieldsError();
    }
    const wanted: TaskStatus | undefined =
      changes.status ??
      (changes.done === undefined
        ? undefined
        : changes.done
          ? 'done'
          : // Geri alırken hangi duruma dönüleceği atanana bakıyor: atanmış bir işin kutusunun
            // işareti kaldırıldığında "taslak" demek, atamayı görünmez biçimde yok saymak olurdu.
            (changes.assigneeId ?? before.assignee_id) !== null
            ? 'assigned'
            : 'draft');

    if (wanted !== undefined && wanted !== before.status) {
      if (!TRANSITIONS[before.status].includes(wanted)) {
        throw new TaskStatusTransitionRefused(before.status, wanted);
      }
    }

    const sets: string[] = [];
    const params: unknown[] = [organizationId, id];

    if (changes.body !== undefined) {
      params.push(changes.body);
      sets.push(`body = $${params.length}`);
    }
    if (changes.assigneeId !== undefined) {
      params.push(changes.assigneeId);
      sets.push(`assignee_id = $${params.length}::uuid`);
    }
    if (wanted !== undefined) {
      params.push(wanted);
      sets.push(`status = $${params.length}`);
      // `done_at` durumu TAKİP EDİYOR, ayrı bir alan olarak değil — şemadaki
      // `tasks_done_at_matches_status` kısıtı ikisinin ayrışmasını zaten reddediyor, ve burada
      // elle tutmak o kısıtı bir hata mesajına çevirmek olurdu.
      //
      // `COALESCE`, `now()` değil: zaten işaretli bir kutuyu işaretlemek tamamlanma zamanını
      // OYNATMAMALI. Arayüz her düzenlemede bütün satırı geri gönderiyor, ve sessizce geçmişi
      // yeniden yazan idempotent bir yazma, "dün ne bitirdik" sorusunu bugüne cevaplatır.
      sets.push(wanted === 'done' ? `done_at = COALESCE(done_at, now())` : `done_at = NULL`);
    }
    if (changes.priority !== undefined) {
      params.push(changes.priority);
      sets.push(`priority = $${params.length}`);
    }
    if (changes.dueAt !== undefined) {
      params.push(changes.dueAt);
      sets.push(`due_at = $${params.length}::timestamptz`);
    }
    if (changes.position !== undefined) {
      params.push(changes.position);
      sets.push(`position = $${params.length}`);
    }
    if (sets.length === 0) return this.find(organizationId, id);

    try {
      const rows = await this.db.withTenant(organizationId, async (db) => {
        if (changes.assigneeId !== undefined) {
          await assertAssignee(db, organizationId, changes.assigneeId);
        }

        return db.query<TaskRow>(
          `WITH updated AS (
             UPDATE public.tasks SET ${sets.join(', ')}
              WHERE organization_id = $1 AND id = $2
              RETURNING *
           )
           SELECT ${SELECT_COLUMNS}
             FROM updated t
             LEFT JOIN public.users u ON u.id = t.assignee_id`,
          params,
        );
      });
      const row = rows[0];
      if (!row) throw new TaskNotFoundError();
      // `fields` ve `changes` DEĞİL: aynı blokta `changes` adında bir sabit tanımlamak, dışarıdaki
      // parametreyi bloğun TAMAMI için gölgeliyor — yukarıdaki `changes.assigneeId` dahil.
      const fields = diff(before, row);
      await this.record(organizationId, id, actorId, fields);
      await this.announce(organizationId, actorId, before, row, fields);
      return row;
    } catch (error) {
      throw translateDbError(error);
    }
  }

  /**
   * Denetim satırlarını yaz.
   *
   * Yazmadan SONRA ve ayrı bir işlemde. Aynı işleme koymak, denetim yazısının başarısızlığının
   * asıl değişikliği geri almasını sağlardı — ve bir denetim izinin en kötü davranışı, izlediği
   * şeyi engellemektir. Ters yön de kötü ama daha az: kaydedilmemiş bir değişiklik, yapılmamış
   * bir değişiklikten iyidir ve `logger` onu söylüyor.
   */
  private async record(
    organizationId: string,
    taskId: string,
    actorId: string | null,
    changes: readonly TaskChange[],
  ): Promise<void> {
    if (changes.length === 0) return;
    try {
      await this.db.withTenant(organizationId, (db) =>
        db.query(
          `INSERT INTO public.task_activity
             (organization_id, task_id, actor_id, field, old_value, new_value)
           SELECT $1, $2, $3::uuid, f.field, f.old, f.new
             FROM unnest($4::text[], $5::text[], $6::text[]) AS f(field, old, new)`,
          [
            organizationId,
            taskId,
            actorId,
            changes.map((c) => c.field),
            changes.map((c) => c.old),
            changes.map((c) => c.new),
          ],
        ),
      );
    } catch (error) {
      this.logger.warn(
        `task ${taskId}: could not record activity: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Değişiklikleri ilgili kişilere bildir (§7).
   *
   * KİM İLGİLİ: işin atananı ve onu oluşturan. İzleyici kavramı henüz yok — §7 istiyor ve kendi
   * tablosunu istiyor — o yüzden burada uydurulmuyor.
   *
   * Kendi yaptığını yapan kişiye hiçbir şey gitmiyor; o kontrol `NotificationsService.notify`'da,
   * yani hiçbir çağıran onu unutamıyor.
   *
   * ATAMA DEĞİŞİMİ İKİ FARKLI CÜMLE. Yeni atanan "sana bir iş atandı" alıyor; eski atanan "iş
   * senden alındı" alıyor. Aynı olay, iki alıcı, iki anlam — ve bu, bildirimin alıcı başına bir
   * satır olmasının sebebi.
   */
  private async announce(
    organizationId: string,
    actorId: string | null,
    before: TaskRow,
    after: TaskRow,
    changes: readonly TaskChange[],
  ): Promise<void> {
    const summary = short(after.body);
    const items: Parameters<NotificationsService['notifyMany']>[0][number][] = [];

    if (changes.some((c) => c.field === 'assignee_id')) {
      if (after.assignee_id !== null) {
        items.push({
          organizationId,
          userId: after.assignee_id,
          actorId,
          kind: 'task.assigned',
          taskId: after.id,
          title: `Sana bir iş atandı: ${summary}`,
        });
      }
      if (before.assignee_id !== null) {
        items.push({
          organizationId,
          userId: before.assignee_id,
          actorId,
          kind: 'task.unassigned',
          taskId: after.id,
          title: `Bu iş artık sende değil: ${summary}`,
        });
      }
    }

    if (changes.some((c) => c.field === 'status')) {
      // Durum değişimi işin SAHİPLERİNE gidiyor: atananı ve oluşturanı. Oluşturan, işi verdiği
      // için sonucunu bekleyen kişi — ve "incelemede" onun bakması gereken an.
      for (const userId of new Set(
        [after.assignee_id, before.created_by].filter((id): id is string => id !== null),
      )) {
        items.push({
          organizationId,
          userId,
          actorId,
          kind: 'task.status',
          taskId: after.id,
          title: `${STATUS_TEXT[after.status]}: ${summary}`,
        });
      }
    }

    await this.notifications.notifyMany(items);
  }

  /**
   * Tek bir denetim satırı yaz.
   *
   * `update`'in kendi farkının dışında kalan değişiklikler için — bir dosya bağı görevin hiçbir
   * sütununu değiştirmiyor, ama §7'nin istediği "kim, neyi, ne zaman" listesinde yeri var.
   */
  async note(
    organizationId: string,
    taskId: string,
    actorId: string | null,
    change: TaskChange,
  ): Promise<void> {
    await this.record(organizationId, taskId, actorId, [change]);
  }

  /** Bir görevin denetim izi, en yeni önce. */
  async activity(organizationId: string, taskId: string): Promise<ActivityRow[]> {
    // Görevin varlığı önce doğrulanıyor: olmayan bir görev için boş bir liste, "hiç aktivite yok"
    // ile "böyle bir görev yok"u aynı cevaba çevirirdi.
    await this.find(organizationId, taskId);
    return this.db.withTenant(organizationId, (db) =>
      db.query<ActivityRow>(
        `SELECT a.id::text AS id, u.username AS actor_username, a.field,
                a.old_value, a.new_value, a.created_at
           FROM public.task_activity a
           LEFT JOIN public.users u ON u.id = a.actor_id
          WHERE a.organization_id = $1 AND a.task_id = $2
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT 200`,
        [organizationId, taskId],
      ),
    );
  }

  async find(organizationId: string, id: string): Promise<TaskRow> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<TaskRow>(
        `SELECT ${SELECT_COLUMNS}
           FROM public.tasks t
           LEFT JOIN public.users u ON u.id = t.assignee_id
          WHERE t.organization_id = $1 AND t.id = $2`,
        [organizationId, id],
      ),
    );
    const row = rows[0];
    if (!row) throw new TaskNotFoundError();
    return row;
  }

  async remove(organizationId: string, id: string): Promise<void> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ id: string }>(
        `DELETE FROM public.tasks
          WHERE organization_id = $1 AND id = $2
          RETURNING id::text AS id`,
        [organizationId, id],
      ),
    );
    if (rows.length === 0) throw new TaskNotFoundError();
  }
}

/**
 * Refuse an assignee who is not a member of this organisation.
 *
 * Runs on the tenant-scoped connection, so the lookup itself is behind the same policy as the
 * write it guards — an id from another tenant returns no row here for the same reason it would
 * return no row anywhere else, rather than because this function compared two strings.
 */
async function assertAssignee(
  db: TenantQuery,
  organizationId: string,
  assigneeId: string | null,
): Promise<void> {
  if (assigneeId === null) return;
  const rows = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM public.users WHERE organization_id = $1 AND id = $2`,
    [organizationId, assigneeId],
  );
  if (rows.length === 0) throw new AssigneeNotFoundError();
}

/** SQLSTATE, not message text — see the note on the same function in `notes.service.ts`. */
function translateDbError(error: unknown): Error {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: string }).code;
    if (code === '23514') return new TaskRejectedError();
    // The assignee vanished between the check above and the write. Rare, but it is a stale picker
    // rather than a fault, so it gets the same answer as the check that normally catches it.
    if (code === '23503') return new AssigneeNotFoundError();
  }
  return error instanceof Error ? error : new Error(String(error));
}
