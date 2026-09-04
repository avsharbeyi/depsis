import { Injectable } from '@nestjs/common';

import { FilesService, type Caller } from '../files/files.service.js';
import { DbService } from '../db/db.service.js';

/**
 * Görev ↔ dosya bağları, ve §7'nin tek cümlelik kuralı:
 *
 * > "Görev klasöre veya dosyaya bağlanabilir; **görev erişimi gizli dosya erişimi vermemelidir.**
 * > Eklenen dosya için ayrıca ACL kontrolü gerekir."
 *
 * BU SERVİSİN TAMAMI O CÜMLE. Bağ tablosu bir izin değil, bir işaret: satırın varlığı hiç kimseye
 * hiçbir şeye erişim vermiyor, ve her okumada dosyanın KENDİ izinleri yeniden çözülüyor.
 *
 * Görev panosunun kendisi paylaşımlı — organizasyondaki herkes bütün panoyu okuyup düzenliyor
 * (0012'nin kararı). Dosyalar öyle değil: `folder_grants` kime hangi klasörün açık olduğunu
 * söylüyor. Bu ikisi bir araya geldiğinde ortaya çıkan tehlike şu: bir görevin herkese açık olması,
 * ona bağlanmış bir dosyanın da herkese açık olduğu anlamına GELMEZ — ve bir bağ listesi bunu
 * karıştırırsa, `folder_grants`'ın tuttuğu duvarın etrafından dolaşan bir yol açılmış olur.
 */
@Injectable()
export class TaskFilesService {
  constructor(
    private readonly db: DbService,
    private readonly files: FilesService,
  ) {}

  /**
   * Bir görevin bağları — YALNIZ çağıranın görebildikleri.
   *
   * Görülemeyenler listeden çıkmıyor, listeye HİÇ GİRMİYOR: adı, yolu, paylaşımı ve hatta kimin
   * bağladığı bu yanıtta geçmiyor. Sayıları `hidden`'da, ve o sayının neden bildirildiği
   * sözleşmede yazıyor — sıfır göstermek yanlış, tamamen gizlemek de eksik bir görev gösterirdi.
   *
   * İZİN ÇÖZÜMÜ PAYLAŞIM BAŞINA TOPLU. Satır başına bir çözüm, on bağlı dosyası olan bir görevi on
   * ayrı yetki yürüyüşü yapardı; `effectiveForRows` zaten bir paylaşımdaki bir satır kümesi için
   * yazılmış.
   */
  async list(caller: Caller, taskId: string): Promise<{ items: LinkView[]; hidden: number }> {
    const rows = await this.db.withTenant(caller.organizationId, (db) =>
      db.query<LinkRow>(
        `SELECT l.id::text            AS id,
                l.file_entry_id::text AS file_entry_id,
                l.created_at,
                u.username            AS linked_by,
                f.name, f.kind, f.path, f.share_id::text AS share_id, f.trashed_at
           FROM public.task_file_links l
           JOIN public.file_entries f ON f.id = l.file_entry_id
           LEFT JOIN public.users u   ON u.id = l.linked_by
          WHERE l.organization_id = $1 AND l.task_id = $2
          ORDER BY l.created_at, l.id`,
        [caller.organizationId, taskId],
      ),
    );
    if (rows.length === 0) return { items: [], hidden: 0 };

    const visible = await this.visibleIds(caller, rows);

    const items = rows
      .filter((row) => visible.has(row.file_entry_id))
      .map((row): LinkView => ({
        id: row.id,
        fileEntryId: row.file_entry_id,
        name: row.name,
        kind: row.kind,
        path: row.path,
        shareId: row.share_id,
        linkedBy: row.linked_by,
        linkedAt: row.created_at.toISOString(),
      }));

    // ÇÖPTEKİLER "GÖREMEDİĞİNİZ" SAYISINA GİRMİYOR. `visibleIds` çöpe atılmış bir satırı atlıyor ve
    // bu doğru — çöp bir görünürlük değil bir yaşam döngüsü durumu — ama farkı burada ham satır
    // sayısından çıkarmak, kullanıcının kendi çöpe attığı dosyayı ona "başkasının gizli dosyası"
    // gibi gösteriyordu: arayüzdeki cümle "Göremediğiniz 1 bağlı dosya daha var." Sayı yalnız
    // İZİN yüzünden düşenleri anlatıyor.
    const live = rows.filter((row) => row.trashed_at === null).length;
    return { items, hidden: live - items.length };
  }

  /**
   * Bir dosyayı göreve bağla.
   *
   * BAĞLAYANIN O DOSYADA EN AZ `read` İZNİ OLMAK ZORUNDA, ve bu yalnız bir nezaket kontrolü değil:
   * göremediği bir dosyayı bağlayabilen biri, onu görebilen birine "şu yolda şu ad var" demenin
   * dolaylı yolunu bulmuş olurdu — bağ listesi o kişide görünürdü.
   *
   * `list` izni YETMİYOR. Bir klasörü listeleyebilmek adları görmek demek; bir dosyayı bir işe
   * kanıt olarak iliştirmek, onun İÇERİĞİ hakkında bir iddia. §7 "tamamlama kanıtı olarak
   * dosya/sürüm bağlantısı" diyor, ve okunamayan bir şey kanıt olamaz.
   */
  async link(caller: Caller, taskId: string, fileEntryId: string): Promise<LinkView> {
    // `find` var olmayan bir satır için KENDİ hatasını atıyor, ve onu geçirmek kuralın delindiği
    // yer olurdu: "böyle bir dosya yok" ile "onu göremiyorsun" iki farklı hata tipi demek, iki
    // farklı HTTP cevabı demek — ve `EntryNotFoundError` bu denetleyicinin `translate`'inde ele
    // alınmadığı için 500'e düşüyordu, yani ayrım GÖRÜNÜR bile oluyordu.
    //
    // Bunu kendi testim yakaladı, ve tam da bunun için yazılmıştı.
    const row = await this.files.find(caller.organizationId, fileEntryId).catch(() => {
      throw new LinkedFileNotVisibleError();
    });

    // Çöpteki bir dosya bağlanamıyor. Bağ, çöpün boşaltılmasıyla sessizce yok olurdu — ve
    // arasındaki sürede görevde "kanıt var" diye görünürdü.
    if (row.trashed_at !== null) throw new LinkedFileNotVisibleError();

    const effective = await this.files.effectiveAt(caller, row.share_id, row.id);
    if (!effective.has('read')) throw new LinkedFileNotVisibleError();

    try {
      const inserted = await this.db.withTenant(caller.organizationId, (db) =>
        db.query<{ id: string; created_at: Date }>(
          `INSERT INTO public.task_file_links
             (organization_id, task_id, file_entry_id, linked_by)
           VALUES ($1, $2, $3, $4)
           RETURNING id::text AS id, created_at`,
          [caller.organizationId, taskId, fileEntryId, caller.userId],
        ),
      );
      const link = inserted[0];
      if (link === undefined) throw new Error('the link was not returned');
      return {
        id: link.id,
        fileEntryId,
        name: row.name,
        kind: row.kind,
        path: row.path,
        shareId: row.share_id,
        linkedBy: null,
        linkedAt: link.created_at.toISOString(),
      };
    } catch (error) {
      if (isUniqueViolation(error)) throw new TaskFileLinkExistsError();
      throw error;
    }
  }

  /**
   * Bağı kaldır. Dosyaya dokunmuyor.
   *
   * DOSYAYI GÖREBİLMEK GEREKMİYOR, ve bu bilinçli bir asimetri. Bağlamak izin istiyor çünkü yeni
   * bilgi üretiyor; kaldırmak hiçbir şey üretmiyor ve bir şeyi geri alıyor. Kaldırmayı da izne
   * bağlasaydık, göremediği bir dosyanın bağı listesinde duran biri onu asla temizleyemezdi — ve
   * o satır, `hidden` sayacında sonsuza kadar bir eksiklik olarak görünürdü.
   *
   * Bağın hangi göreve ait olduğu WHERE'de: bir görevin id'siyle başka bir görevin bağını silmek,
   * yetki açığı değil ama satırların kime ait olduğu konusunda yalan söyleyen bir API.
   */
  async unlink(organizationId: string, taskId: string, linkId: string): Promise<boolean> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ id: string }>(
        `DELETE FROM public.task_file_links
          WHERE organization_id = $1 AND task_id = $2 AND id = $3
          RETURNING id::text AS id`,
        [organizationId, taskId, linkId],
      ),
    );
    return rows.length > 0;
  }

  /**
   * Bir görev kümesi için görünür bağ SAYILARI.
   *
   * Pano her açılışta bütün görevleri listeliyor ve her birinde "kaç dosya" göstermek istiyor. Bunu
   * görev başına bir çağrıyla yapmak, elli görevlik bir panoda elli yetki yürüyüşü demek.
   */
  async visibleCounts(
    caller: Caller,
    taskIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>(taskIds.map((id) => [id, 0]));
    if (taskIds.length === 0) return counts;

    const rows = await this.db.withTenant(caller.organizationId, (db) =>
      db.query<LinkRow & { task_id: string }>(
        `SELECT l.task_id::text        AS task_id,
                l.id::text             AS id,
                l.file_entry_id::text  AS file_entry_id,
                l.created_at,
                NULL::text             AS linked_by,
                f.name, f.kind, f.path, f.share_id::text AS share_id, f.trashed_at
           FROM public.task_file_links l
           JOIN public.file_entries f ON f.id = l.file_entry_id
          WHERE l.organization_id = $1 AND l.task_id = ANY($2::uuid[])`,
        [caller.organizationId, taskIds],
      ),
    );
    if (rows.length === 0) return counts;

    const visible = await this.visibleIds(caller, rows);
    for (const row of rows) {
      if (!visible.has(row.file_entry_id)) continue;
      counts.set(row.task_id, (counts.get(row.task_id) ?? 0) + 1);
    }
    return counts;
  }

  /**
   * Bu satırların hangi dosyalarını çağıran görebiliyor?
   *
   * Paylaşım başına gruplayıp `effectiveForRows`'a veriyor — o fonksiyon bir paylaşımdaki bir satır
   * kümesi için yazılmış ve yetki zincirini bir kez yürüyor.
   *
   * ÇÖPTEKİ SATIRLAR GÖRÜNMEZ SAYILIYOR. Çöp bir sütun, klasör değil (0008), yani çöpe atılmış bir
   * dosyanın `folder_grants`'ı hâlâ duruyor ve `effectiveForRows` ona `read` verebilir. Ama
   * kullanıcı onu dosya yöneticisinde göremiyor, ve bir görevde görebiliyor olması "sildiğim şey
   * hâlâ orada" demenin en kafa karıştırıcı yolu olurdu.
   */
  private async visibleIds(caller: Caller, rows: readonly LinkRow[]): Promise<ReadonlySet<string>> {
    const byShare = new Map<string, LinkRow[]>();
    for (const row of rows) {
      if (row.trashed_at !== null) continue;
      const list = byShare.get(row.share_id);
      if (list === undefined) byShare.set(row.share_id, [row]);
      else list.push(row);
    }

    const visible = new Set<string>();
    for (const [shareId, shareRows] of byShare) {
      const effective = await this.files.effectiveForRows(
        caller,
        shareId,
        shareRows.map((row) => ({ id: row.file_entry_id })),
      );
      for (const row of shareRows) {
        if (effective.get(row.file_entry_id)?.has('read') === true) {
          visible.add(row.file_entry_id);
        }
      }
    }
    return visible;
  }
}

interface LinkRow {
  id: string;
  file_entry_id: string;
  created_at: Date;
  linked_by: string | null;
  name: string;
  kind: 'file' | 'folder';
  path: string;
  share_id: string;
  trashed_at: Date | null;
}

export interface LinkView {
  id: string;
  fileEntryId: string;
  name: string;
  kind: 'file' | 'folder';
  path: string;
  shareId: string;
  linkedBy: string | null;
  linkedAt: string;
}

/**
 * Çağıran bu dosyayı göremiyor — ya da o dosya yok.
 *
 * TEK BİR HATA, ve ayrı olmamaları kuralın kendisi: "göremiyorsun" ile "yok" farklı cevaplar
 * verirse, ikisinin farkı dosyanın varlığını söyler. Denetleyici bunu 404 yapıyor.
 */
export class LinkedFileNotVisibleError extends Error {
  constructor() {
    super('no such file');
    this.name = 'LinkedFileNotVisibleError';
  }
}

export class TaskFileLinkExistsError extends Error {
  constructor() {
    super('that file is already linked to this task');
    this.name = 'TaskFileLinkExistsError';
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
  );
}
