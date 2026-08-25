import { Injectable, Logger } from '@nestjs/common';

import { DbService, type TenantQuery } from '../db/db.service.js';

/** Bir izleyicinin listede göründüğü hâli. */
export interface WatcherRow {
  user_id: string;
  username: string | null;
  source: WatcherSource;
  created_at: Date;
}

export type WatcherSource = 'manual' | 'created' | 'assigned' | 'commented';

/**
 * Bir işi kim izliyor (§7).
 *
 * BU BİR TAHMİNİN YERİNİ ALIYOR. Önceki sürümde bildirim "atanan + oluşturan" diyordu, ve bu çoğu
 * zaman doğru cevaptı — ama yalnızca çoğu zaman. Yanlış olduğu yer, ilgilenen ÜÇÜNCÜ kişi: işi
 * verenle yapan arasında durmayan ama sonucunu bekleyen biri. Tahminin en kötü tarafı, yanlış
 * olduğunda hiçbir belirti vermemesiydi — eksik olan şey bir bildirimin yokluğu.
 *
 * OTOMATİK ABONELİK, ve kasıtlı olarak dar. Bir işi oluşturmak, atanmak ve yorum yazmak abone
 * ediyor; **anılmak etmiyor**. Bir kez anılmanın sizi o işin bütün gelecek gürültüsüne kaydetmesi,
 * insanların bildirimleri kapatma sebebi — ve bir mention zaten kendi bildirimini üretiyor.
 *
 * BAŞKASINI İZLEYİCİ YAPMAK YOK. `watch`/`unwatch` yalnız çağıranın kendisi için çalışıyor. Başkası
 * adına abone olabilmek, bir kişiye istemediği bildirimleri göndermenin yolu olurdu, ve o kişinin
 * bunu geri almaktan başka yapabileceği bir şey olmazdı.
 */
@Injectable()
export class TaskWatchersService {
  private readonly logger = new Logger(TaskWatchersService.name);

  constructor(private readonly db: DbService) {}

  /** Bir işin izleyicileri, kullanıcı adlarıyla. */
  async list(organizationId: string, taskId: string): Promise<WatcherRow[]> {
    return this.db.withTenant(organizationId, (db) =>
      db.query<WatcherRow>(
        `SELECT w.user_id::text AS user_id, u.username, w.source, w.created_at
           FROM public.task_watchers w
           LEFT JOIN public.users u ON u.id = w.user_id
          WHERE w.organization_id = $1 AND w.task_id = $2
          ORDER BY w.created_at, w.user_id`,
        [organizationId, taskId],
      ),
    );
  }

  /** Çağıran bu işi izliyor mu. */
  async watching(organizationId: string, taskId: string, userId: string): Promise<boolean> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ one: number }>(
        `SELECT 1 AS one FROM public.task_watchers
          WHERE organization_id = $1 AND task_id = $2 AND user_id = $3`,
        [organizationId, taskId, userId],
      ),
    );
    return rows.length > 0;
  }

  /**
   * Çağıranı izleyici yap. Zaten izliyorsa hiçbir şey olmuyor.
   *
   * `source` DEĞİŞMİYOR bir daha: `ON CONFLICT DO NOTHING`, `DO UPDATE` değil. Kendi eliyle abone
   * olan biri sonradan atandığında kaydı 'manual' kalıyor, ki doğrusu bu — 'assigned'a düşürmek,
   * o kişinin kendi seçimini bir yan etkiyle silmek olurdu.
   */
  async watch(
    organizationId: string,
    taskId: string,
    userId: string,
    source: WatcherSource = 'manual',
  ): Promise<void> {
    await this.db.withTenant(organizationId, (db) =>
      db.query(
        `INSERT INTO public.task_watchers (organization_id, task_id, user_id, source)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [organizationId, taskId, userId, source],
      ),
    );
  }

  /**
   * Çağıranı izleyicilikten çıkar.
   *
   * Nasıl abone olduğuna BAKMIYOR: atandığı için otomatik eklenmiş biri de çıkabiliyor. "Bu işi
   * bırakamazsın, çünkü sana atandı" demek, bildirimi bir cezaya çevirirdi — ve o kişi işi
   * bıraktığında değil, bildirimleri okumayı bıraktığında kaybediliyor.
   */
  async unwatch(organizationId: string, taskId: string, userId: string): Promise<boolean> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ id: string }>(
        `DELETE FROM public.task_watchers
          WHERE organization_id = $1 AND task_id = $2 AND user_id = $3
          RETURNING id::text AS id`,
        [organizationId, taskId, userId],
      ),
    );
    return rows.length > 0;
  }

  /**
   * Bir bildirimin gideceği kişiler.
   *
   * Yazma yolundan çağrılıyor ve HİÇBİR ZAMAN fırlatmıyor: alıcı listesini okuyamamak, bildirdiği
   * şeyin olmamasına yol açmamalı. Okunamadığında boş liste dönüyor, yani bildirim düşmüyor ama
   * değişiklik duruyor — ve log satırı hangisinin olduğunu söylüyor.
   */
  async recipients(organizationId: string, taskId: string): Promise<string[]> {
    try {
      const rows = await this.db.withTenant(organizationId, (db) =>
        db.query<{ user_id: string }>(
          `SELECT user_id::text AS user_id FROM public.task_watchers
            WHERE organization_id = $1 AND task_id = $2`,
          [organizationId, taskId],
        ),
      );
      return rows.map((row) => row.user_id);
    } catch (error) {
      this.logger.warn(
        `task ${taskId}: could not read watchers: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  /**
   * Otomatik abonelik, ÇAĞIRANIN İŞLEMİNİN İÇİNDEN.
   *
   * `TasksService.create` zaten bir `withTenant` bloğunun içinde çalışıyor, ve satırı oradan yazmak
   * ile sonra yazmak arasındaki fark gerçek: iş oluşup izleyicisi oluşmazsa, o iş bildirimsiz doğar
   * ve bunu kimse fark etmez. Aynı işlemde olduğunda ikisi birlikte var ya da birlikte yok.
   */
  static async attach(
    db: TenantQuery,
    organizationId: string,
    taskId: string,
    userIds: readonly (string | null)[],
    source: WatcherSource,
  ): Promise<void> {
    const wanted = [...new Set(userIds.filter((id): id is string => id !== null))];
    if (wanted.length === 0) return;
    await db.query(
      `INSERT INTO public.task_watchers (organization_id, task_id, user_id, source)
       SELECT $1, $2, w.user_id::uuid, $4
         FROM unnest($3::text[]) AS w(user_id)
       ON CONFLICT DO NOTHING`,
      [organizationId, taskId, wanted, source],
    );
  }
}
