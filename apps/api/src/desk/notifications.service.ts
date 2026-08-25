import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { DbService } from '../db/db.service.js';

/** İş türü, hem üreten hem tüketen tarafta. */
export const OVERDUE_SWEEP_KIND = 'tasks.overdue-sweep';

/** Taramalar arası. Bir hatırlatmanın on beş dakika gecikmesi kimseyi etkilemiyor; her dakika
 *  koşan bir tarama ise boş bir panoda saatte altmış sorgu. */
export const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

export type NotificationKind =
  | 'task.assigned'
  | 'task.unassigned'
  | 'task.status'
  | 'task.due'
  | 'task.overdue'
  | 'task.comment'
  | 'task.mention';

export interface NotificationRow {
  id: string;
  kind: NotificationKind;
  task_id: string | null;
  task_body: string | null;
  title: string;
  read_at: Date | null;
  created_at: Date;
}

/**
 * Bildirim merkezi (§7).
 *
 * İKİ KURAL, ve ikisi de bir bildirim sisteminin işe yaramaz hâle gelme biçimleri hakkında.
 *
 * **Kimse kendi yaptığı şey için bildirim almıyor.** Bir işi kendine atayan, "sana iş atandı"
 * mesajını istemiyor; durumunu kendi değiştiren, değiştirdiğini zaten biliyor. Bu kontrol
 * atlandığında sistem çalışmaya devam ediyor ve zil sürekli yanıyor — kullanıcı da onu okumayı
 * bırakıyor, ki bu bildirim merkezinin ölümü.
 *
 * **Aynı şey iki kez düşmüyor.** Gecikme taraması dakikada bir koşuyor; kısıt olmadan gecikmiş bir
 * iş bir haftada bin satır üretir. Şemadaki kısmi benzersiz indeks bunu ENGELLİYOR — burada
 * `ON CONFLICT DO NOTHING` ile karşılanıyor, yani tekrar bir hata değil sessiz bir "zaten var".
 *
 * Yazma HİÇBİR ZAMAN çağıranın işlemini bozmuyor: bir bildirimin yazılamaması, bildirdiği şeyin
 * olmamasına yol açmamalı. `task_activity` ile aynı gerekçe, ve orada olduğu gibi log'a düşüyor.
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly db: DbService) {}

  /**
   * Her kiracı için gecikme taramasını yeniden tohumla.
   *
   * Zincir bir kez başladıktan sonra kendini sürdürüyor, ama bir zincirin tek bir hata biçimi var:
   * ardılını kuyruğa almadan ölen bir koşu zinciri koparıyor, ve o andan sonra hiçbir hatırlatma
   * düşmüyor. Bunun görünür bir belirtisi YOK — eksik olan şey bir bildirimin yokluğu, ve kimse
   * gelmeyen bir bildirimi fark etmiyor. Açılıştaki tohum bunun kurtarması, ve `scheduleSweep`
   * zaten bekleyen bir tarama varken hiçbir şey yapmıyor: her açılışta boşa dönen bir INSERT.
   *
   * Hatalar log'a düşüyor, fırlatılmıyor: açılışta kısa süre ulaşılamayan bir veritabanı, API'nin
   * hizmet vermesini durdurmamalı. Bir sonraki açılış yeniden deniyor.
   */
  async onModuleInit(): Promise<void> {
    try {
      const organizations = await this.organizationsWithTasks();
      for (const organizationId of organizations) {
        await this.scheduleSweep(organizationId, new Date());
      }
      if (organizations.length > 0) {
        this.logger.log(`overdue sweep scheduled for ${organizations.length} organisation(s)`);
      }
    } catch (error) {
      this.logger.error(
        `could not seed the overdue sweep schedule: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Taranmaya değer her kiracı: son tarihi olan ve hâlâ açık bir işi olanlar.
   *
   * Kiracı bağlamı DIŞINDA, çünkü açılışta oturum yok ve bu sorgunun tam işi kiracıları saymak.
   */
  private async organizationsWithTasks(): Promise<string[]> {
    const rows = await this.db.withoutTenant('migration-status', (q) =>
      q.query<{ id: string }>(
        `SELECT DISTINCT organization_id::text AS id FROM public.tasks
          WHERE due_at IS NOT NULL AND status <> 'done' AND status <> 'cancelled'`,
      ),
    );
    return rows.map((row) => row.id);
  }

  /**
   * Birine bir şey bildir.
   *
   * `actorId` — bunu YAPAN kişi. Alıcıyla aynıysa hiçbir şey yazılmıyor, ve bu kontrol burada
   * olduğu için hiçbir çağıran onu unutamıyor.
   */
  async notify(input: {
    organizationId: string;
    userId: string;
    actorId: string | null;
    kind: NotificationKind;
    taskId: string | null;
    title: string;
  }): Promise<void> {
    if (input.userId === input.actorId) return;
    await this.notifyMany([input]);
  }

  /**
   * Birden çok kişiye, tek sorguda.
   *
   * Gecikme taraması yüzlerce satır üretebiliyor, ve satır başına bir INSERT bir dakikalık
   * zamanlayıcıyı dolduracak kadar yavaş olurdu.
   */
  async notifyMany(
    items: readonly {
      organizationId: string;
      userId: string;
      actorId: string | null;
      kind: NotificationKind;
      taskId: string | null;
      title: string;
    }[],
  ): Promise<void> {
    const wanted = items.filter((item) => item.userId !== item.actorId);
    if (wanted.length === 0) return;

    // Hepsi aynı kiracıdan: `withTenant` tek bir organizasyon bağlamı kuruyor, ve karışık bir
    // liste onların yarısını yanlış bağlamda yazmaya çalışırdı — RLS reddederdi, ama bunu
    // çağıranın hatası olarak burada yakalamak, bir politika ihlali olarak yakalamaktan iyi.
    const organizationId = wanted[0]?.organizationId ?? '';
    if (wanted.some((item) => item.organizationId !== organizationId)) {
      throw new Error('notifyMany takes one organisation at a time');
    }

    try {
      await this.db.withTenant(organizationId, (db) =>
        db.query(
          `INSERT INTO public.notifications (organization_id, user_id, kind, task_id, title)
           SELECT $1, n.user_id::uuid, n.kind, n.task_id::uuid, n.title
             FROM unnest($2::text[], $3::text[], $4::text[], $5::text[])
               AS n(user_id, kind, task_id, title)
           -- Kısmi benzersiz indeks tekrarı kesiyor; burada bu bir HATA değil, beklenen durum.
           ON CONFLICT DO NOTHING`,
          [
            organizationId,
            wanted.map((i) => i.userId),
            wanted.map((i) => i.kind),
            wanted.map((i) => i.taskId),
            wanted.map((i) => i.title),
          ],
        ),
      );
    } catch (error) {
      // Yutuluyor. Bir bildirimin yazılamaması, bildirdiği şeyin olmamasına yol açmamalı.
      this.logger.warn(
        `could not write ${wanted.length} notification(s): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Gecikmiş ve yaklaşan işleri bul, sahiplerine bildir.
   *
   * Bir tarama, ve bir zamanlayıcı DEĞİL: `setInterval` yalnız o süreç ayaktayken çalışıyor ve
   * yeniden başlatmada kayboluyor — bir hatırlatma sisteminin sessizce durmasının yolu. Zamanlayıcı
   * kuyruğun kendisi (`run_after`), ve her tarama bir sonrakini kuyruğa alıyor.
   *
   * "YAKLAŞAN" YİRMİ DÖRT SAAT, ve tek bir kez düşüyor. Bir hatırlatma her saat tekrar ederse
   * hatırlatma olmaktan çıkıp gürültü olur; kısmi benzersiz indeks bunu şemada tutuyor, burada
   * `ON CONFLICT DO NOTHING` ile karşılanıyor.
   *
   * `actorId: null` — bunu yapan bir insan yok. Kendine-bildirme kontrolü de bu yüzden hiçbir şeyi
   * elemiyor, ki doğrusu bu: bir işin gecikmesi, atananın kendi yaptığı bir şey değil.
   */
  async sweepOverdue(organizationId: string): Promise<{ overdue: number; due: number }> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ id: string; body: string; assignee_id: string | null; late: boolean }>(
        `SELECT id::text AS id, body, assignee_id::text AS assignee_id,
                (due_at < now()) AS late
           FROM public.tasks
          WHERE organization_id = $1
            AND due_at IS NOT NULL
            AND status <> 'done' AND status <> 'cancelled'
            AND due_at < now() + interval '24 hours'
            AND assignee_id IS NOT NULL
          -- tasks_due kismi indeksi tam bu sorgu icin: son tarihi olmayan ve kapanmis isler
          -- indekste hic yer kaplamiyor, ve bir yapilacaklar listesinde satirlarin cogu zamanla o
          -- iki kumeye giriyor.
          LIMIT 500`,
        [organizationId],
      ),
    );
    if (rows.length === 0) return { overdue: 0, due: 0 };

    await this.notifyMany(
      rows.map((row) => ({
        organizationId,
        userId: row.assignee_id as string,
        actorId: null,
        kind: row.late ? ('task.overdue' as const) : ('task.due' as const),
        taskId: row.id,
        title: row.late
          ? `Gecikti: ${row.body.trim().slice(0, 79)}`
          : `Yarına kadar: ${row.body.trim().slice(0, 79)}`,
      })),
    );

    return {
      overdue: rows.filter((r) => r.late).length,
      due: rows.filter((r) => !r.late).length,
    };
  }

  /**
   * Bir sonraki taramayı kuyruğa al — zaten bekleyen yoksa.
   *
   * Kısmi benzersiz indeks (`job_queue_one_scheduled_overdue_sweep`) ikinci bir sıradaki taramayı
   * reddediyor, ve o indeks yalnız `queued`'ı kapsıyor: `running`'i de kapsasaydı işleyicinin
   * kendi ardılını kuyruğa alması çakışır ve zincir hiç ilerlemezdi.
   */
  async scheduleSweep(organizationId: string, runAfter: Date): Promise<void> {
    await this.db.withTenant(organizationId, (db) =>
      db.query(
        `INSERT INTO public.job_queue (organization_id, kind, payload, run_after, max_attempts)
         VALUES ($1, $2, '{}'::jsonb, $3, 3)
         ON CONFLICT DO NOTHING`,
        [organizationId, OVERDUE_SWEEP_KIND, runAfter],
      ),
    );
  }

  /** Birinin gelen kutusu, en yeni önce. */
  async inbox(
    organizationId: string,
    userId: string,
    unreadOnly: boolean,
  ): Promise<NotificationRow[]> {
    return this.db.withTenant(organizationId, (db) =>
      db.query<NotificationRow>(
        `SELECT n.id::text AS id, n.kind, n.task_id::text AS task_id, t.body AS task_body,
                n.title, n.read_at, n.created_at
           FROM public.notifications n
           LEFT JOIN public.tasks t ON t.id = n.task_id
          WHERE n.organization_id = $1 AND n.user_id = $2
            AND ($3::boolean = false OR n.read_at IS NULL)
          ORDER BY n.created_at DESC, n.id DESC
          LIMIT 100`,
        [organizationId, userId, unreadOnly],
      ),
    );
  }

  /** Zilin sayısı. */
  async unreadCount(organizationId: string, userId: string): Promise<number> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM public.notifications
          WHERE organization_id = $1 AND user_id = $2 AND read_at IS NULL`,
        [organizationId, userId],
      ),
    );
    return Number(rows[0]?.n ?? '0');
  }

  /**
   * Okundu işaretle.
   *
   * `user_id` WHERE'de, ve bu bir yetki kontrolü: RLS kiracıyı tutuyor ama kişiyi tutmuyor —
   * politika oturumdaki kullanıcıyı bilmiyor. Onsuz bir kiracının herhangi bir üyesi bir
   * başkasının bildirimini okunmuş yapabilirdi.
   *
   * `read_at IS NULL` da WHERE'de: zaten okunmuş bir bildirimi yeniden işaretlemek, "ne zaman
   * okudum" cevabını bugüne kaydırırdı.
   */
  async markRead(organizationId: string, userId: string, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ id: string }>(
        `UPDATE public.notifications SET read_at = now()
          WHERE organization_id = $1 AND user_id = $2 AND read_at IS NULL
            AND id = ANY($3::uuid[])
          RETURNING id::text AS id`,
        [organizationId, userId, ids],
      ),
    );
    return rows.length;
  }

  /** Hepsini okundu işaretle. */
  async markAllRead(organizationId: string, userId: string): Promise<number> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ id: string }>(
        `UPDATE public.notifications SET read_at = now()
          WHERE organization_id = $1 AND user_id = $2 AND read_at IS NULL
          RETURNING id::text AS id`,
        [organizationId, userId],
      ),
    );
    return rows.length;
  }
}
