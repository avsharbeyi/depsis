import { Injectable, Logger } from '@nestjs/common';

import { DbService, type TenantQuery } from '../db/db.service.js';
import { NotificationsService } from './notifications.service.js';
import { TaskWatchersService } from './task-watchers.service.js';

export interface TaskRow {
  id: string;
  body: string;
  /** İşin yönergesi — 0038. Panoda görünmez; iş açıldığında gövdenin hemen altında durur. */
  description: string | null;
  /**
   * İşi kim açtı.
   *
   * Bildirim için seçiliyor: durum değişimi işin SAHİPLERİNE gidiyor, ve oluşturan onlardan biri
   * — işi verdiği için sonucunu bekleyen kişi. Silinen hesapta NULL.
   */
  created_by: string | null;
  /**
   * Parçası olduğu iş, ya da null.
   *
   * TEK SEVİYE, ve onu bu alan değil VERİTABANI tutuyor: `tasks_one_level_deep` tetikleyicisi bir
   * alt görevin kendi alt görevini, bir işin kendine ebeveynliğini ve parçası olan bir işin başka
   * bir şeyin parçası olmasını reddediyor. Yalnız serviste tutulan bir kural, ikinci bir yazma
   * yolu açıldığı gün sessizce kaybolurdu.
   */
  parent_id: string | null;
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
  field:
    | 'status'
    | 'priority'
    | 'due_at'
    | 'assignee_id'
    | 'body'
    | 'description'
    | 'file_link'
    | 'comment'
    | 'parent_id'
    | 'checklist'
    | 'tag';
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

/** Bir günlük satırı: aktivite + hangi iş. */
export interface LogRow {
  id: string;
  actor_username: string | null;
  field: TaskChange['field'];
  old_value: string | null;
  new_value: string | null;
  created_at: Date;
  task_id: string;
  task_body: string;
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
  add('description', before.description, after.description);
  add('parent_id', before.parent_id, after.parent_id);
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

/** The task exists and belongs to somebody else. See `TasksService.remove`. */
export class TaskNotYoursError extends Error {
  constructor() {
    super('only the person who created a task, its assignee, or an administrator may delete it');
    this.name = 'TaskNotYoursError';
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

/**
 * Parçası yapılmak istenen üst iş bu kuruluşta yok.
 *
 * Kendi tipi, çünkü tamiri farklı: `AssigneeNotFoundError` "seçicideki isim eskimiş" diyor, bu ise
 * "işaret ettiğin iş yok" diyor. İkisi tek bir hataya çevrildiğinde, silinmiş bir üst iş için
 * "bu kuruluşta böyle bir kullanıcı yok" cevabı dönüyordu.
 */
export class ParentTaskNotFoundError extends Error {
  constructor() {
    super('no such parent task in this organization');
    this.name = 'ParentTaskNotFoundError';
  }
}

/** SQLSTATE 23514 from `tasks_body_present`: an empty body, or one past 2000 characters. */
export class TaskRejectedError extends Error {
  constructor(reason = 'a task needs a body of between 1 and 2000 characters') {
    super(reason);
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
          t.description,
          t.parent_id::text   AS parent_id,
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
    private readonly watchers: TaskWatchersService,
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
    parentId: string | null = null,
  ): Promise<TaskRow> {
    try {
      const rows = await this.db.withTenant(organizationId, async (db) => {
        // Checked inside the SAME transaction as the insert, and checked at all because RLS would
        // not catch it: the row's own `organization_id` is correct, so the policy is satisfied
        // whatever `assignee_id` holds. Without this the appliance happily assigns work to an
        // account in another household — a foreign key to `public.users` says the person exists,
        // not that they are one of us.
        await assertAssignee(db, organizationId, assigneeId);
        // Ebeveyn de aynı işlemde, ve aynı gerekçeyle: yabancı anahtar kontrolleri satır
        // güvenliğini atlıyor, yani başka bir kiracının işinin uuid'si buraya kadar geliyordu.
        await assertParent(db, organizationId, parentId);

        const inserted = await db.query<TaskRow>(
          `WITH inserted AS (
             INSERT INTO public.tasks (organization_id, created_by, body, assignee_id, status,
                                       parent_id)
             -- Atananı olan bir is 'assigned' doguyor, olmayan 'draft'. 0026'nin var olan
             -- satirlar icin yaptigi eslemenin aynisi: yeni satirlarin eskilerden farkli bir
             -- kurala gore dogmasi, panoyu iki kuralin karistigi bir yer yapardi.
             VALUES ($1, $2, $3, $4, CASE WHEN $4::uuid IS NULL THEN 'draft' ELSE 'assigned' END,
                     $5)
             RETURNING *
           )
           SELECT ${SELECT_COLUMNS}
             FROM inserted t
             LEFT JOIN public.users u ON u.id = t.assignee_id`,
          [organizationId, createdBy, body, assigneeId, parentId],
        );
        const created = inserted[0];
        // AYNI İŞLEMDE, ve bu bir düzen tercihi değil: iş oluşup izleyicisi oluşmazsa, o iş
        // bildirimsiz doğar ve bunu kimse fark etmez — eksik olan şey bir bildirimin yokluğu.
        // Ya ikisi birden var, ya ikisi birden yok.
        if (created !== undefined) {
          await TaskWatchersService.attach(db, organizationId, created.id, [createdBy], 'created');
          await TaskWatchersService.attach(
            db,
            organizationId,
            created.id,
            [assigneeId],
            'assigned',
          );
        }
        return inserted;
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
      // `null` yönergeyi siler, yokluk olduğu gibi bırakır — atamayla aynı üçlü.
      description?: string | null | undefined;
      // `string | null` and `undefined` mean different things and both are reachable: null clears
      // the assignment, absent leaves it alone. Collapsing them would make "unassign" impossible
      // to express.
      assigneeId?: string | null | undefined;
      done?: boolean | undefined;
      status?: TaskStatus | undefined;
      priority?: TaskPriority | undefined;
      dueAt?: string | null | undefined;
      position?: number | undefined;
      // `string | null` ve `undefined` yine farklı şeyler: null işi üst seviyeye çıkarıyor,
      // yokluğu bağını olduğu gibi bırakıyor.
      parentId?: string | null | undefined;
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
            //
            // `??` DEĞİL, açık `undefined` kontrolü: aynı istekte gelen `assigneeId: null` atamayı
            // KALDIRMAK demek, "belirtilmedi" demek değil. `??` ikisini birleştirip eski atanana
            // bakıyordu, ve satır `status = 'assigned'` + `assignee_id = NULL` olarak yazılıyordu —
            // panoda kimseye ait olmayan bir "Atandı" rozeti.
            (changes.assigneeId !== undefined ? changes.assigneeId : before.assignee_id) !== null
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
    if (changes.description !== undefined) {
      params.push(changes.description);
      sets.push(`description = $${params.length}`);
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
    if (changes.parentId !== undefined) {
      // Kendine ebeveynlik, iki seviye ve parçası olan bir işin parça olması — üçünü de
      // `tasks_one_level_deep` tetikleyicisi reddediyor, burada değil. Kural veritabanında
      // olduğu için ikinci bir yazma yolu onu atlayamıyor; buradaki iş yalnız hatayı okunabilir
      // bir cevaba çevirmek (`translateDbError`).
      //
      // Tetikleyicinin GÖREMEDİĞİ tek şey ebeveynin BAŞKA bir kiracıya ait olması: `EXISTS`i RLS
      // altında koşuyor, yani yabancı satırı bulamayıp sessizce geçiyor, ve yabancı anahtar
      // kontrolleri satır güvenliğini her zaman atlıyor. Onu `assertParent` kesiyor (aşağıda).
      params.push(changes.parentId);
      sets.push(`parent_id = $${params.length}::uuid`);
    }
    if (sets.length === 0) return this.find(organizationId, id);

    // Geçiş yukarıda BELLEKTE doğrulandı, ve okuma ile yazma ayrı işlemlerde: aynı saniyede iki
    // kişi `in_progress` okuyup biri "Tamamlandı" öteki "İptal" yazarsa, net etki makinenin
    // yasakladığı tek geçiş olan `done → cancelled` oluyor ve denetim izi bunu hiç göstermiyor.
    // Beklenen eski durumu WHERE'e koymak yazmayı okumaya bağlıyor: kaybeden istek sıfır satır
    // güncelliyor, ve aşağıda satırın GERÇEK hâliyle yeniden değerlendiriliyor.
    let guard = '';
    if (wanted !== undefined) {
      // `sets` kurulduktan SONRA push ediliyor, yoksa yukarıdaki $n indeksleri kayardı.
      params.push(before.status);
      guard = ` AND status = $${params.length}`;
    }

    try {
      const rows = await this.db.withTenant(organizationId, async (db) => {
        if (changes.assigneeId !== undefined) {
          await assertAssignee(db, organizationId, changes.assigneeId);
        }
        if (changes.parentId !== undefined) {
          await assertParent(db, organizationId, changes.parentId);
        }

        return db.query<TaskRow>(
          `WITH updated AS (
             UPDATE public.tasks SET ${sets.join(', ')}
              WHERE organization_id = $1 AND id = $2${guard}
              RETURNING *
           )
           SELECT ${SELECT_COLUMNS}
             FROM updated t
             LEFT JOIN public.users u ON u.id = t.assignee_id`,
          params,
        );
      });
      const row = rows[0];
      // Sıfır satır iki şey demek olabiliyor: iş silinmiş, ya da durumu okuduğumuzdan beri
      // değişmiş. İkincisini "bulunamadı" diye cevaplamak, aynı anda çalışan bir meslektaşı
      // silinmiş bir iş gibi göstermek olurdu.
      if (!row) {
        const current = await this.find(organizationId, id);
        if (wanted !== undefined) throw new TaskStatusTransitionRefused(current.status, wanted);
        throw new TaskNotFoundError();
      }
      // `fields` ve `changes` DEĞİL: aynı blokta `changes` adında bir sabit tanımlamak, dışarıdaki
      // parametreyi bloğun TAMAMI için gölgeliyor — yukarıdaki `changes.assigneeId` dahil.
      const fields = diff(before, row);
      // Atanan biri, işin devamını duyması gereken kişi.
      //
      // YUTULUYOR, ve yorumun kendisi bir zamanlar bunu iddia edip yapmıyordu: `watch` kendi
      // işlemini açıyor, ve atama YUKARIDA çoktan COMMIT edildi — buradan çıkan bir hata,
      // gerçekleşmiş bir atamayı çağırana başarısız gösterirdi. `record` ve `announce` zaten
      // kendi hatalarını yutuyor; eksik olan tek yer burasıydı.
      if (row.assignee_id !== null && before.assignee_id !== row.assignee_id) {
        try {
          await this.watchers.watch(organizationId, id, row.assignee_id, 'assigned');
        } catch (error) {
          this.logger.warn(
            `task ${id}: assigned, but the watcher row was not written: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      await this.record(organizationId, id, actorId, fields);
      await this.announce(organizationId, actorId, before, row, fields);
      await this.ensureSweepScheduled(organizationId, before, row);
      return row;
    } catch (error) {
      throw translateDbError(error);
    }
  }

  /**
   * Son tarih hatırlatmalarının zincirini kur — henüz kurulu değilse.
   *
   * Zinciri kuran TEK yer açılıştı (`NotificationsService.onModuleInit`), ve orası "şu anda son
   * tarihli açık işi olan kiracılar" ile kapılıydı. Kurulumdan yeni çıkmış bir cihazda `tasks`
   * boş: hiçbir `tasks.overdue-sweep` satırı yazılmıyor, ve ilk işine son tarih veren sahibi için
   * "Gecikti"/"Yarına kadar" bildirimleri API bir dahaki kez yeniden başlayana kadar — yani
   * haftalarca — hiç düşmüyor. Eksik olan şey bir bildirimin YOKLUĞU, yani hiçbir ekran yanlış
   * görünmüyor.
   *
   * `due_at` yalnız `update` üzerinden yazılıyor, o yüzden kanca burada. Kapalı bir işin yeniden
   * açılması da aynı kancayı hak ediyor: zincir o kiracıda hiç kurulmamış olabilir.
   *
   * Hata YUTULUYOR: kuyruğa yazamamak, gerçekleşmiş bir güncellemeyi çağırana başarısız
   * göstermemeli. `ON CONFLICT DO NOTHING` + `job_queue_one_scheduled_overdue_sweep` zaten
   * bekleyen bir taramanın ikinci kopyasını kesiyor, yani bu çağrı çoğu zaman boşa dönen bir
   * INSERT — `BackupTargetController.prepare` ile aynı kalıp.
   */
  private async ensureSweepScheduled(
    organizationId: string,
    before: TaskRow,
    after: TaskRow,
  ): Promise<void> {
    if (after.due_at === null) return;
    if (after.status === 'done' || after.status === 'cancelled') return;
    const dueChanged = before.due_at?.getTime() !== after.due_at.getTime();
    const reopened = before.status !== after.status;
    if (!dueChanged && !reopened) return;
    try {
      await this.notifications.scheduleSweep(organizationId, new Date());
    } catch (error) {
      this.logger.warn(
        `task ${after.id}: due date set, but the overdue sweep was not scheduled: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
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
   * KİM İLGİLİ: işin İZLEYİCİLERİ. Burada bir zamanlar "atanan + oluşturan" yazıyordu, ve o çoğu
   * zaman doğru cevaptı — ama yalnızca çoğu zaman, ve yanlış olduğunda hiçbir belirti vermiyordu.
   * `task_watchers` o listeyi bir tahmin olmaktan çıkarıp bir satır yaptı; iş oluşturmak, atanmak
   * ve yorum yazmak otomatik abone ediyor, yani eski davranış hâlâ varsayılan — ama artık
   * ilgilenen üçüncü bir kişinin de bir yolu var.
   *
   * Kendi yaptığını yapan kişiye hiçbir şey gitmiyor; o kontrol `NotificationsService.notify`'da,
   * yani hiçbir çağıran onu unutamıyor. İzleyici listesinden aktörü elemek de bu yüzden burada
   * YAPILMIYOR: tek bir yerde olması, iki yerde olmasından güvenli.
   *
   * ATAMA DEĞİŞİMİ İKİ FARKLI CÜMLE, ve ikisi izleyici listesinin DIŞINDA. Yeni atanan "sana bir iş
   * atandı" alıyor — o an henüz izleyici bile olmayabilir. Eski atanan "iş senden alındı" alıyor,
   * ve izlemeyi bıraktıysa bile alıyor: elinden alınan bir işi öğrenmek, bir aboneliğin konusu
   * değil.
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
      for (const userId of await this.watchers.recipients(organizationId, after.id)) {
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

  /**
   * "Bu işin kaç parçası var, kaçı bitti" — pano rozetleri için.
   *
   * PANO BAŞINA TEK SORGU, iş başına bir tane değil: otuz işlik bir panoda otuz sorgu, hiçbir
   * ekranın açılmasını beklemeye değmeyecek iki sayı için. `task_checklist.progress` ile aynı
   * kalıp ve aynı gerekçe.
   */
  async subtaskProgress(
    organizationId: string,
    parentIds: readonly string[],
  ): Promise<Map<string, { done: number; total: number }>> {
    if (parentIds.length === 0) return new Map();
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ parent_id: string; done: string; total: string }>(
        `SELECT parent_id::text AS parent_id,
                -- 'cancelled' de KAPALI sayılıyor: iptal edilmiş bir parça bekleyen iş değil, ve
                -- "3/7" rozetinin sorduğu soru "kaç tanesi hâlâ bekliyor".
                count(*) FILTER (WHERE status IN ('done', 'cancelled'))::text AS done,
                count(*)::text AS total
           FROM public.tasks
          WHERE organization_id = $1 AND parent_id = ANY($2::uuid[])
          GROUP BY parent_id`,
        [organizationId, parentIds],
      ),
    );
    return new Map(
      rows.map((row) => [row.parent_id, { done: Number(row.done), total: Number(row.total) }]),
    );
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

  /**
   * İŞ GÜNLÜĞÜ — bütün panonun izi, tek listede. Sahibin sorusu bire bir: "geçmişte kimler
   * neler yapmış görebilmeliyiz." Görev başına iz zaten vardı (`activity`); bu, aynı tablonun
   * kiracı genişliğinde okunuşu, işin metniyle birlikte — çünkü günlük satırı işten bağımsız
   * okunur ve "hangi iş" cevabı bir tıklamanın arkasında kalmamalı.
   *
   * Silinmiş işlerin izi de SİLİNMİŞ olur: `task_activity.task_id` CASCADE. Bu bilinçli —
   * silme onayı kaskatı zaten söylüyor, ve hayalet satırların günlüğü okunmaz yapması daha kötü.
   */
  async log(organizationId: string): Promise<LogRow[]> {
    return this.db.withTenant(organizationId, (db) =>
      db.query<LogRow>(
        `SELECT a.id::text AS id, u.username AS actor_username, a.field,
                a.old_value, a.new_value, a.created_at,
                t.id::text AS task_id, t.body AS task_body
           FROM public.task_activity a
           JOIN public.tasks t ON t.id = a.task_id
           LEFT JOIN public.users u ON u.id = a.actor_id
          WHERE a.organization_id = $1
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT 300`,
        [organizationId],
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

  /**
   * Delete one task — if it is yours to delete.
   *
   * THE PREDICATE IS IN THE STATEMENT, not in a check before it. This route had no ownership test
   * at all: any member could erase any colleague's task, and `task_activity`'s ON DELETE CASCADE
   * took the audit trail with it — the withheld DELETE grant on that table does not stop a
   * referential cascade. A check-then-delete would have closed the hole and opened a smaller one,
   * so the rule travels with the write.
   *
   * WHO: the person who created it, the person it is assigned to, or an administrator. The board
   * is shared inside an organisation and editing is deliberately open — deletion is the one action
   * with no undo, and "anyone may remove anyone's work" is not a default a household would choose.
   *
   * NOT FOUND AND NOT YOURS ARE DIFFERENT ANSWERS HERE, deliberately, and that is a departure from
   * the file tree's concealment. There, the existence of an entry is itself a secret. Here every
   * member can already SEE every task on the board, so answering 404 would hide nothing and would
   * tell somebody looking at a task on their screen that it does not exist. The second query runs
   * only on the failure path, after the delete has already not happened, so it races with nothing.
   */
  async remove(
    organizationId: string,
    id: string,
    caller: { userId: string; isOrganizationAdmin: boolean },
  ): Promise<void> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ id: string }>(
        `DELETE FROM public.tasks
          WHERE organization_id = $1 AND id = $2
            AND ($4 OR created_by = $3 OR assignee_id = $3)
          RETURNING id::text AS id`,
        [organizationId, id, caller.userId, caller.isOrganizationAdmin],
      ),
    );
    if (rows.length > 0) return;

    const exists = await this.db.withTenant(organizationId, (db) =>
      db.query<{ id: string }>(
        `SELECT id::text AS id FROM public.tasks
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, id],
      ),
    );
    if (exists.length === 0) throw new TaskNotFoundError();
    throw new TaskNotYoursError();
  }
}

/**
 * Refuse an assignee who is not a member of this organisation.
 *
 * Runs on the tenant-scoped connection, so the lookup itself is behind the same policy as the
 * write it guards — an id from another tenant returns no row here for the same reason it would
 * return no row anywhere else, rather than because this function compared two strings.
 *
 * DEVRE DIŞI HESAP DA REDDEDİLİYOR. Kapatılmış bir hesap oturum açamıyor (0003), yani ona atanan
 * bir iş kimseye ulaşmıyor: sahibi işi "atandı" sanıyor, kimse yapmıyor, ve gecikme taraması
 * kimsenin açmayacağı bir gelen kutusuna hatırlatma yazıyor. Var olan atamalar bundan
 * ETKİLENMİYOR — kontrol yalnız `assigneeId` gönderilen isteklerde koşuyor, ve arayüz kısmi PATCH
 * gönderiyor.
 */
async function assertAssignee(
  db: TenantQuery,
  organizationId: string,
  assigneeId: string | null,
): Promise<void> {
  if (assigneeId === null) return;
  const rows = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM public.users
      WHERE organization_id = $1 AND id = $2 AND disabled_at IS NULL`,
    [organizationId, assigneeId],
  );
  if (rows.length === 0) throw new AssigneeNotFoundError();
}

/**
 * Üst işin BU kiracıya ait olduğunu doğrula.
 *
 * `assertAssignee` ile aynı gerekçe, ama eksikliği daha sessizdi: `parent_id` hiç doğrulanmıyordu.
 * Olmayan bir uuid yabancı anahtar ihlaline düşüyor ve `translateDbError` onu "bu kuruluşta böyle
 * bir kullanıcı yok" diye çeviriyordu — atanan kişinin gittiğini sanan bir kullanıcı. Başka bir
 * kiracının işinin uuid'si ise KABUL EDİLİYORDU: yabancı anahtar kontrolleri satır güvenliğini her
 * zaman atlıyor, ve `tasks_one_level_deep` tetikleyicisinin `EXISTS`'i RLS altında o satırı
 * göremediği için sessizce geçiyordu. Sonuç, görünmeyen bir ebeveyne bağlı bir iş — ve o kiracı
 * kendi işini sildiğinde `ON DELETE CASCADE` bunu da siliyordu.
 *
 * Kalıcı çözüm bileşik bir yabancı anahtar (`(organization_id, parent_id)`), ki o zaman kural
 * veritabanında durur; bu kontrol onun yerini tutuyor, oku-sonra-yaz aralığı kadar dar bir
 * pencereyle.
 */
async function assertParent(
  db: TenantQuery,
  organizationId: string,
  parentId: string | null,
): Promise<void> {
  if (parentId === null) return;
  const rows = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM public.tasks WHERE organization_id = $1 AND id = $2`,
    [organizationId, parentId],
  );
  if (rows.length === 0) throw new ParentTaskNotFoundError();
}

/** SQLSTATE, not message text — see the note on the same function in `notes.service.ts`. */
/**
 * `tasks_one_level_deep` tetikleyicisinin üç reddi, insan cümlesine çevrilmiş hâlleriyle.
 *
 * Eşleştirme İNGİLİZCE mesajın üstünden, çünkü göçte yazan cümle o — ve iki dilin birbirini takip
 * etmesi gereken tek yer burası olsun diye, ikisi de tek bir listede duruyor.
 */
const DEPTH_REFUSALS: readonly (readonly [string, string])[] = [
  ['cannot be its own parent', 'Bir iş kendisinin parçası olamaz.'],
  ['subtask cannot have subtasks', 'Bir alt görevin kendi alt görevi olamaz: yalnız tek seviye.'],
  [
    'with subtasks cannot become a subtask',
    'Parçaları olan bir iş başka bir şeyin parçası olamaz.',
  ],
];

function translateDbError(error: unknown): Error {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: string }).code;
    if (code === '23514') {
      // Tetikleyicinin kendi cümlesi geçiyor, `tasks_body_present` gibi bir kısıt adı geçmiyor.
      //
      // Fark kullanıcı açısından gerçek: "bir alt görevin kendi alt görevi olamaz" ne yapılması
      // gerektiğini söylüyor, `violates check constraint "tasks_one_level_deep"` ise yalnız bir iç
      // ad sızdırıyor. Bu üç mesaj BİZİM yazdıklarımız (0029'daki `RAISE EXCEPTION`), o yüzden
      // gösterilebilir olduklarını biliyoruz; kalan her 23514 için genel cevap duruyor.
      const said = (error as { message?: string }).message ?? '';
      for (const [needle, turkish] of DEPTH_REFUSALS) {
        if (said.includes(needle)) return new TaskRejectedError(turkish);
      }
      return new TaskRejectedError();
    }
    // The assignee vanished between the check above and the write. Rare, but it is a stale picker
    // rather than a fault, so it gets the same answer as the check that normally catches it.
    //
    // HANGİ yabancı anahtar olduğu önemli: `tasks` üçünü birden taşıyor (`assignee_id`,
    // `created_by`, `parent_id`) ve üçünü aynı cümleye çevirmek, silinmiş bir ÜST İŞ için
    // "bu kuruluşta böyle bir kullanıcı yok" cevabı üretiyordu — okuyanı yanlış yere bakmaya
    // gönderen bir mesaj. Kısıt adı PostgreSQL'in otomatik verdiği ad, ve hata nesnesinde geliyor.
    if (code === '23503') {
      const constraint = (error as { constraint?: string }).constraint ?? '';
      if (constraint === 'tasks_parent_id_fkey') return new ParentTaskNotFoundError();
      return new AssigneeNotFoundError();
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}
