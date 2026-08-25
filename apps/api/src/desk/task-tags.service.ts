import { Injectable } from '@nestjs/common';

import { DbService } from '../db/db.service.js';
import { TasksService } from './tasks.service.js';

/** Paletteki renkler. Şemadaki `task_tags_color_known` ile aynı küme. */
export const TAG_COLORS = ['iris', 'mint', 'cyan', 'amber', 'rose', 'slate'] as const;
export type TagColor = (typeof TAG_COLORS)[number];

/** Bir etiket, kaç işte kullanıldığıyla. */
export interface TagRow {
  id: string;
  name: string;
  color: TagColor;
  uses: number;
}

/** Bir işin üstündeki etiket. Sayaç yok: satırda görünen şey ad ve renk. */
export interface TagOnTask {
  id: string;
  name: string;
  color: TagColor;
}

export class TagNotFoundError extends Error {
  constructor() {
    super('no such tag');
    this.name = 'TagNotFoundError';
  }
}

export class TagExistsError extends Error {
  constructor(name: string) {
    super(`"${name}" adında bir etiket zaten var`);
    this.name = 'TagExistsError';
  }
}

export class TagRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'TagRejectedError';
  }
}

const MAX_NAME = 40;

/**
 * Etiketler (§7).
 *
 * KİRACININ SÖZLÜĞÜ, işin bir alanı değil. Etiketi `tasks` üzerinde bir metin dizisi olarak tutmak
 * daha az tablo olurdu ve bir sözlüğün çözdüğü şeyi çözmezdi: "acil", "Acil" ve "acıl" üç ayrı
 * etiket olur ve kimse hangisini yazdığını hatırlamaz. Benzersizlik `fold_identity` üzerinden —
 * kullanıcı adlarındaki aynı fonksiyon, yani Türkçe i ailesi de katlanıyor.
 *
 * KİM NE YAPABİLİR, ve bu bir denge:
 *
 *   * **Herkes etiket oluşturabiliyor ve takabiliyor.** Oluşturmayı yöneticiye kilitlemek,
 *     etiketlemeyi bir talep sürecine çevirir ve kimse kullanmaz.
 *   * **Yalnız yönetici yeniden adlandırabiliyor ve silebiliyor.** İkisi de KİRACI ÇAPINDA:
 *     bir adı değiştirmek onu kullanan her işin anlamını değiştiriyor, silmek ise her işten
 *     kaldırıyor. Bir üyenin yanlışlıkla yaptığı bir şeyin başka otuz işi etkilemesi, geri
 *     alınması en zor hata sınıfı.
 */
@Injectable()
export class TaskTagsService {
  constructor(
    private readonly db: DbService,
    private readonly tasks: TasksService,
  ) {}

  /** Kiracının bütün etiketleri, kullanım sayılarıyla, ada göre. */
  async list(organizationId: string): Promise<TagRow[]> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ id: string; name: string; color: TagColor; uses: string }>(
        `SELECT t.id::text AS id, t.name, t.color,
                count(l.id)::text AS uses
           FROM public.task_tags t
           LEFT JOIN public.task_tag_links l
             ON l.organization_id = t.organization_id AND l.tag_id = t.id
          WHERE t.organization_id = $1
          GROUP BY t.id, t.name, t.color
          -- Katlanmış ada göre: "Acil" ile "acil" arasındaki sıra farkı, listeye bakan kişi için
          -- hiçbir şey ifade etmiyor.
          ORDER BY t.name_folded
          LIMIT 200`,
        [organizationId],
      ),
    );
    return rows.map((row) => ({ ...row, uses: Number(row.uses) }));
  }

  /**
   * Etiket oluştur.
   *
   * VAR OLANI DÖNDÜRÜYOR, hata vermiyor — ve bu `rename`'in tersi. Sebep, çağıranın niyeti: burada
   * niyet "bu adda bir etiket olsun", ve zaten varsa istenen şey olmuş demektir. Arayüzde bu, aynı
   * kutudan hem seçmeye hem oluşturmaya izin veren tek bir alan olmasını sağlıyor.
   */
  async ensure(organizationId: string, name: string, color: TagColor): Promise<TagOnTask> {
    const trimmed = name.trim();
    if (trimmed === '' || trimmed.length > MAX_NAME) {
      throw new TagRejectedError(
        trimmed === ''
          ? 'etiket adı boş olamaz'
          : `etiket adı en çok ${MAX_NAME} karakter olabilir`,
      );
    }

    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ id: string; name: string; color: TagColor }>(
        `WITH tried AS (
           INSERT INTO public.task_tags (organization_id, name, color)
           VALUES ($1, $2, $3)
           -- Yarışı da kesiyor: iki kişi ayni anda ayni adi olusturursa biri satiri yaziyor,
           -- oteki asagidaki SELECT'ten ayni satiri okuyor. DO NOTHING artı SELECT, iki ayri
           -- sorguyla "once bak sonra yaz" yapmaktan farkli olarak bir pencere birakmiyor.
           ON CONFLICT (organization_id, name_folded) DO NOTHING
           RETURNING id, name, color
         )
         SELECT id::text AS id, name, color FROM tried
         UNION ALL
         SELECT id::text AS id, name, color FROM public.task_tags
          WHERE organization_id = $1 AND name_folded = public.fold_identity($2)
            AND NOT EXISTS (SELECT 1 FROM tried)`,
        [organizationId, trimmed, color],
      ),
    );
    const row = rows[0];
    if (!row) throw new Error('the tag row was not returned');
    return row;
  }

  /**
   * Adını ya da rengini değiştir — YÖNETİCİ.
   *
   * Yetki kontrolü çağırana ait (`AdminGuard` değil, çünkü aynı denetleyicideki komşu uçlar
   * üyelere açık); buradaki iş, adın çakışmasını bir 409'a çevirmek. `ensure`'ün tersine sessizce
   * birleştirmiyor: "bunu şu ad yap" diyen biri, o adın başka bir etikete ait olduğunu bilmeli —
   * yoksa iki etiket sessizce tek etikete dönüşür ve otuz işin anlamı değişir.
   */
  async rename(
    organizationId: string,
    tagId: string,
    name: string | undefined,
    color: TagColor | undefined,
  ): Promise<TagRow> {
    const trimmed = name?.trim();
    if (trimmed !== undefined && (trimmed === '' || trimmed.length > MAX_NAME)) {
      throw new TagRejectedError(
        trimmed === ''
          ? 'etiket adı boş olamaz'
          : `etiket adı en çok ${MAX_NAME} karakter olabilir`,
      );
    }

    try {
      const rows = await this.db.withTenant(organizationId, (db) =>
        db.query<{ id: string }>(
          `UPDATE public.task_tags
              SET name  = COALESCE($3, name),
                  color = COALESCE($4, color)
            WHERE organization_id = $1 AND id = $2
            RETURNING id::text AS id`,
          [organizationId, tagId, trimmed ?? null, color ?? null],
        ),
      );
      if (rows.length === 0) throw new TagNotFoundError();
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        if ((error as { code?: string }).code === '23505') {
          throw new TagExistsError(trimmed ?? '');
        }
      }
      throw error;
    }

    const found = (await this.list(organizationId)).find((tag) => tag.id === tagId);
    if (found === undefined) throw new TagNotFoundError();
    return found;
  }

  /**
   * Etiketi sil — YÖNETİCİ.
   *
   * Bağları da gidiyor (`ON DELETE CASCADE`), yani bu işlem kiracı çapında. Kaç işten kalkacağını
   * çağırana DÖNDÜRÜYOR, ve arayüz onu silmeden önce soruyor: sessiz bir kaskat, veri kaybının en
   * sık biçimi — ve burada kaybedilen şey otuz işin sınıflandırması.
   */
  async remove(organizationId: string, tagId: string): Promise<number> {
    return this.db.withTenant(organizationId, async (db) => {
      const uses = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.task_tag_links
          WHERE organization_id = $1 AND tag_id = $2`,
        [organizationId, tagId],
      );
      const gone = await db.query<{ id: string }>(
        `DELETE FROM public.task_tags WHERE organization_id = $1 AND id = $2
          RETURNING id::text AS id`,
        [organizationId, tagId],
      );
      if (gone.length === 0) throw new TagNotFoundError();
      return Number(uses[0]?.n ?? '0');
    });
  }

  /** Bir işe etiket tak. Zaten takılıysa hiçbir şey olmuyor. */
  async attach(
    organizationId: string,
    taskId: string,
    tagId: string,
    actorId: string,
  ): Promise<void> {
    await this.tasks.find(organizationId, taskId);
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ name: string }>(
        `WITH added AS (
           INSERT INTO public.task_tag_links (organization_id, task_id, tag_id, tagged_by)
           SELECT $1, $2, t.id, $4
             FROM public.task_tags t
            WHERE t.organization_id = $1 AND t.id = $3
           ON CONFLICT DO NOTHING
           RETURNING tag_id
         )
         SELECT t.name FROM public.task_tags t
           JOIN added a ON a.tag_id = t.id`,
        [organizationId, taskId, tagId, actorId],
      ),
    );
    // Boş dönmesinin İKİ sebebi var ve ayırt etmek gerekiyor: etiket yok (404), ya da zaten takılı
    // (sessizce başarı). Etiketin varlığını ayrıca soruyor, çünkü olmayan bir etiketi takmayı
    // sessizce başarılı saymak, arayüzde görünmeyen bir çip bırakırdı.
    if (rows.length === 0) {
      if (!(await this.exists(organizationId, tagId))) throw new TagNotFoundError();
      return;
    }
    await this.tasks.note(organizationId, taskId, actorId, {
      field: 'tag',
      old: null,
      new: rows[0]?.name ?? null,
    });
  }

  /** Etiketi işten kaldır. Takılı değilse hiçbir şey olmuyor. */
  async detach(
    organizationId: string,
    taskId: string,
    tagId: string,
    actorId: string,
  ): Promise<void> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ name: string }>(
        `WITH removed AS (
           DELETE FROM public.task_tag_links
            WHERE organization_id = $1 AND task_id = $2 AND tag_id = $3
            RETURNING tag_id
         )
         SELECT t.name FROM public.task_tags t
           JOIN removed r ON r.tag_id = t.id`,
        [organizationId, taskId, tagId],
      ),
    );
    if (rows.length === 0) return;
    await this.tasks.note(organizationId, taskId, actorId, {
      field: 'tag',
      old: rows[0]?.name ?? null,
      new: null,
    });
  }

  /**
   * Pano için: iş başına etiketler.
   *
   * PANO BAŞINA TEK SORGU, iş başına bir tane değil — `subtaskProgress` ve `checklist.progress`
   * ile aynı kalıp, ve aynı sebeple: elli işlik bir pano, satır başına bir sorguyla elli sorgu.
   */
  async forTasks(
    organizationId: string,
    taskIds: readonly string[],
  ): Promise<Map<string, TagOnTask[]>> {
    if (taskIds.length === 0) return new Map();
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ task_id: string; id: string; name: string; color: TagColor }>(
        `SELECT l.task_id::text AS task_id, t.id::text AS id, t.name, t.color
           FROM public.task_tag_links l
           JOIN public.task_tags t ON t.id = l.tag_id
          WHERE l.organization_id = $1 AND l.task_id = ANY($2::uuid[])
          ORDER BY t.name_folded`,
        [organizationId, taskIds],
      ),
    );
    const out = new Map<string, TagOnTask[]>();
    for (const row of rows) {
      const list = out.get(row.task_id) ?? [];
      list.push({ id: row.id, name: row.name, color: row.color });
      out.set(row.task_id, list);
    }
    return out;
  }

  private async exists(organizationId: string, tagId: string): Promise<boolean> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ one: number }>(
        `SELECT 1 AS one FROM public.task_tags WHERE organization_id = $1 AND id = $2`,
        [organizationId, tagId],
      ),
    );
    return rows.length > 0;
  }
}
