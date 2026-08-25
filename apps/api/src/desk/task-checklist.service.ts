import { Injectable } from '@nestjs/common';

import { DbService } from '../db/db.service.js';
import { TasksService } from './tasks.service.js';

/** Bir kontrol listesi maddesi, okunmak için. */
export interface ChecklistRow {
  id: string;
  body: string;
  done_at: Date | null;
  done_by_username: string | null;
  position: number;
}

export class ChecklistItemNotFoundError extends Error {
  constructor() {
    super('checklist item not found');
    this.name = 'ChecklistItemNotFoundError';
  }
}

export class ChecklistRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ChecklistRejectedError';
  }
}

/** Şemadaki `task_checklist_body_sane` ile aynı sayı; burada olması kısıt ihlalini 422 yapıyor. */
const MAX_BODY = 500;

/**
 * Bir işin içindeki maddeler (§7).
 *
 * ALT GÖREVDEN FARKI, ve ikisinin birden var olma sebebi: bir madde atanamıyor, son tarihi yok,
 * bildirim üretmiyor. Bunların herhangi birini isteyen şey zaten bir alt görev, ve ikisinden biri
 * eksik olsaydı insanlar ötekini onun yerine kullanırdı — her adım için ayrı bir iş açmak panoyu
 * okunmaz yapıyor, tek bir gövdeye madde madde yazmak da hiçbirini takip edilebilir yapmıyor.
 *
 * DENETİME EKLEME VE SİLME YAZILIYOR, TİKLEME YAZILMIYOR. Bir tik günde yirmi kez değişebilen bir
 * şey ve her birini yazmak izi okunmaz yapardı; listenin kendisi zaten neyin tiklendiğini
 * söylüyor. Kaybolan şeyin — silinen bir maddenin — izi ise başka hiçbir yerde kalmıyor.
 */
@Injectable()
export class TaskChecklistService {
  constructor(
    private readonly db: DbService,
    private readonly tasks: TasksService,
  ) {}

  /** Bir işin maddeleri, kullanıcının dizdiği sırayla. */
  async list(organizationId: string, taskId: string): Promise<ChecklistRow[]> {
    // Görevin varlığı önce: olmayan bir görev için boş liste, "hiç madde yok" ile "böyle bir görev
    // yok"u aynı cevaba çevirirdi.
    await this.tasks.find(organizationId, taskId);
    return this.db.withTenant(organizationId, (db) =>
      db.query<ChecklistRow>(
        `SELECT i.id::text AS id, i.body, i.done_at, u.username AS done_by_username, i.position
           FROM public.task_checklist_items i
           LEFT JOIN public.users u ON u.id = i.done_by
          WHERE i.organization_id = $1 AND i.task_id = $2
          ORDER BY i.position, i.created_at, i.id
          LIMIT 200`,
        [organizationId, taskId],
      ),
    );
  }

  /**
   * Madde ekle, listenin SONUNA.
   *
   * Sıra numarası mevcut en büyüğün bir fazlası, ve bu tek sorguda hesaplanıyor: istemciden bir
   * `position` almak, iki kişinin aynı anda madde eklemesini iki kişinin aynı sırayı istemesine
   * çevirirdi.
   */
  async add(organizationId: string, taskId: string, actorId: string, body: string): Promise<void> {
    const trimmed = body.trim();
    if (trimmed === '' || trimmed.length > MAX_BODY) {
      throw new ChecklistRejectedError(
        trimmed === '' ? 'madde boş olamaz' : `madde en çok ${MAX_BODY} karakter olabilir`,
      );
    }
    await this.tasks.find(organizationId, taskId);

    await this.db.withTenant(organizationId, (db) =>
      db.query(
        `INSERT INTO public.task_checklist_items (organization_id, task_id, body, position)
         SELECT $1, $2, $3,
                coalesce(max(position), 0) + 1
           FROM public.task_checklist_items
          WHERE organization_id = $1 AND task_id = $2`,
        [organizationId, taskId, trimmed],
      ),
    );

    await this.tasks.note(organizationId, taskId, actorId, {
      field: 'checklist',
      old: null,
      new: trimmed.slice(0, 200),
    });
  }

  /**
   * Bir maddeyi tikle ya da tiki kaldır.
   *
   * `done_by` `done_at` ile birlikte yazılıyor ve birlikte siliniyor — yarısı dolu bir kayıt,
   * "yapıldı ama kim yaptığı bilinmiyor" demek olurdu. (Hesap sonradan kapanırsa `done_by` NULL'a
   * düşüyor ve şema buna izin veriyor; bir hesabın kapatılabilmesi, o hesabın bir madde tiklemiş
   * olmasına bağlı olamaz.)
   */
  async setDone(
    organizationId: string,
    taskId: string,
    itemId: string,
    actorId: string,
    done: boolean,
  ): Promise<void> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ id: string }>(
        `UPDATE public.task_checklist_items
            SET done_at = CASE WHEN $4 THEN now() ELSE NULL END,
                done_by = CASE WHEN $4 THEN $5::uuid ELSE NULL END
          WHERE organization_id = $1 AND task_id = $2 AND id = $3
          RETURNING id::text AS id`,
        [organizationId, taskId, itemId, done, actorId],
      ),
    );
    if (rows.length === 0) throw new ChecklistItemNotFoundError();
  }

  /**
   * Maddeyi sil — GERÇEKTEN sil.
   *
   * Yorumların tersine, ve fark bilinçli: bir yorum bir kişinin söylediği şey ve kaydı korunmalı;
   * bir kontrol listesi maddesi bir hatırlatma, ve yanlış yazılmış bir hatırlatmanın "bu madde
   * silindi" diye listede durması yalnız gürültü. Ne olduğu denetim izinde kalıyor.
   */
  async remove(
    organizationId: string,
    taskId: string,
    itemId: string,
    actorId: string,
  ): Promise<void> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ body: string }>(
        `DELETE FROM public.task_checklist_items
          WHERE organization_id = $1 AND task_id = $2 AND id = $3
          RETURNING body`,
        [organizationId, taskId, itemId],
      ),
    );
    const row = rows[0];
    if (!row) throw new ChecklistItemNotFoundError();

    await this.tasks.note(organizationId, taskId, actorId, {
      field: 'checklist',
      old: row.body.slice(0, 200),
      new: null,
    });
  }

  /**
   * Kaç madde var, kaçı tiklendi — panodaki "3/7" rozeti için.
   *
   * PAYLAŞIM BAŞINA TEK SORGU, iş başına bir tane değil: otuz işlik bir panoda otuz sorgu, hiçbir
   * ekranın açılmasını beklemeye değmeyecek bir sayı için.
   */
  async progress(
    organizationId: string,
    taskIds: readonly string[],
  ): Promise<Map<string, { done: number; total: number }>> {
    if (taskIds.length === 0) return new Map();
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ task_id: string; done: string; total: string }>(
        `SELECT task_id::text AS task_id,
                count(*) FILTER (WHERE done_at IS NOT NULL)::text AS done,
                count(*)::text AS total
           FROM public.task_checklist_items
          WHERE organization_id = $1 AND task_id = ANY($2::uuid[])
          GROUP BY task_id`,
        [organizationId, taskIds],
      ),
    );
    return new Map(
      rows.map((row) => [row.task_id, { done: Number(row.done), total: Number(row.total) }]),
    );
  }
}
