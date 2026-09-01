import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { AgentService } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import { FilesService } from './files.service.js';

/** What one `files.reconcile` job was asked to do. */
export interface ReconcilePayload {
  shareId: string;
}

/** What a pass found. */
export interface ReconcileResult {
  /** Rows written for things on disk that DEPSIS did not know about. */
  discovered: number;
  /** Rows whose size or modification time on disk had moved. */
  updated: number;
  /** Rows for things no longer on disk. */
  removed: number;
  /** Directories whose listing the agent had to clip; their contents were left alone. */
  truncated: number;
  /** Directories visited. */
  scanned: number;
}

interface Row {
  id: string;
  name: string;
  kind: 'file' | 'folder';
  size_bytes: string;
  updated_at: Date;
  trashed: boolean;
}

export const RECONCILE_KIND = 'files.reconcile';

/** Draining what Samba's audit stream reported. ADR-0011 Layer 1's consumer. */
export const INDEX_DRAIN_KIND = 'files.index-drain';

/**
 * Where a path resolved to.
 *
 * Three outcomes, and the middle one is why this is not `string | null`: the share ROOT is a real
 * destination whose id is null, while a path DEPSIS does not know is not a destination at all.
 * Collapsing them would make an event for a deleted folder reconcile the share root instead.
 */
type Resolved = { at: 'root' } | { at: 'folder'; id: string } | { at: 'nowhere' };

/** One directory somebody changed, as the audit reader recorded it. */
export interface QueuedPath {
  shareId: string;
  path: string;
  actor: string | null;
}

/**
 * What is on disk, into `file_entries`.
 *
 * THE HOLE THIS CLOSES IS THE PRODUCT'S LARGEST. `file_entries` only ever learned about a file
 * DEPSIS itself created, so anything written over SMB — which is what a NAS is FOR — was invisible
 * to the web interface, to search, and to the permission walk. §5.3 and §18.2 make it an acceptance
 * criterion: "a file created over SMB enters web search within the stated SLA".
 *
 * WHY A SCAN, AND WHY IT IS NOT THE WHOLE ANSWER. ADR-0011 chose four layers, with Samba's
 * `vfs_full_audit` as the primary event source and a periodic reconciliation underneath. This is
 * the reconciliation. It is built first on purpose: every other layer degrades to it — a missed
 * audit line, a `FAN_Q_OVERFLOW`, a write that never went through Samba at all — so a product with
 * only this one is late, while a product with only the others is silently wrong. The layer that
 * makes it FAST is a separate change; this is the layer that makes it TRUE.
 *
 * WHAT IT WILL NOT DO IS DELETE BYTES. A row whose file is gone from disk is removed from the
 * DATABASE and nothing is unlinked — the file is already gone, that is why the row is being
 * removed. Nothing in this class calls a destructive agent operation, and that is the whole reason
 * it is safe to run unattended on a schedule.
 */
@Injectable()
export class IndexerService implements OnModuleInit {
  /**
   * Directories per pass.
   *
   * Each is one agent round trip on the appliance's single control connection, so a pass over a
   * hundred thousand folders would hold it for as long as that takes. A pass that stops here
   * schedules its successor immediately rather than waiting for the interval.
   */
  static readonly BATCH = 500;

  /** How often a share is reconciled when nothing asked for it. */
  static readonly INTERVAL_MS = 15 * 60_000;

  /**
   * Directories per drain pass.
   *
   * Higher than the walk's batch because each is one listing rather than a subtree, and this is
   * the path a person is waiting on: a file saved from Word should appear in the web interface in
   * seconds, not at the next quarter hour.
   */
  static readonly DRAIN_BATCH = 200;

  /**
   * How often the queue is looked at when it was empty last time.
   *
   * Five seconds. That is the actual latency of §5.3's acceptance criterion in the common case,
   * and an empty queue costs exactly one indexed query — this is not a poll over the filesystem.
   */
  static readonly DRAIN_INTERVAL_MS = 5_000;

  private readonly logger = new Logger(IndexerService.name);

  constructor(
    private readonly db: DbService,
    private readonly agent: AgentService,
    private readonly files: FilesService,
  ) {}

  /**
   * Seed a pass for every share on the box.
   *
   * The chain sustains itself once started, but it has one failure mode: a pass that dies in a way
   * that skips its own successor stops the share being indexed, with no symptom beyond files
   * quietly not appearing. A boot-time seed is the recovery. `schedule` is a no-op when a pass is
   * already queued — migration 0024 is the index that makes its `ON CONFLICT` mean something — so
   * running this every boot costs one INSERT per share that usually does nothing.
   *
   * A NEW SHARE gets its first pass here too, at the next restart, and immediately when
   * `POST /shares` creates one.
   *
   * Failures are logged, never thrown: a database briefly unreachable at startup must not stop the
   * API from serving.
   */
  async onModuleInit(): Promise<void> {
    try {
      const organizations = await this.organizations();
      for (const organizationId of organizations) {
        for (const shareId of await this.shares(organizationId)) {
          await this.schedule(organizationId, shareId, new Date());
        }
        // The fast path's own chain, seeded the same way and for the same reason: a drain that
        // died without queueing its successor would leave the audit stream piling up in a table
        // nobody reads, and the only symptom would be files appearing fifteen minutes late.
        await this.scheduleDrain(organizationId, new Date());
      }
    } catch (error) {
      this.logger.error(
        `could not seed the reconciliation schedule: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Every organisation on the box. Untenanted because the question is about the box. */
  private async organizations(): Promise<string[]> {
    const rows = await this.db.withoutTenant('migration-status', (q) =>
      q.query<{ id: string }>(`SELECT id::text AS id FROM public.organizations`),
    );
    return rows.map((row) => row.id);
  }

  /**
   * Walk a share, breadth-first, and make the database agree with the disk.
   *
   * Returns `more: true` when the batch ran out before the tree did, so the caller can come
   * straight back rather than waiting for the interval.
   */
  async reconcile(
    organizationId: string,
    shareId: string,
    report: (fraction: number) => Promise<boolean>,
    reason: string,
  ): Promise<ReconcileResult & { more: boolean }> {
    const share = await this.files.shareFor(organizationId, shareId);
    const result: ReconcileResult = {
      discovered: 0,
      updated: 0,
      removed: 0,
      truncated: 0,
      scanned: 0,
    };

    // ── YÜRÜYÜŞ KALDIĞI YERDEN DEVAM EDİYOR ─────────────────────────────────────────────
    //
    // Kuyruk eskiden yalnız PAYLAŞIM KÖKÜYLE kuruluyordu, yani her tur baştan başlıyordu. 500
    // klasörden büyük bir ağaçta bunun iki sonucu oldu ve ikisi de sahada ölçüldü: yürüyüş hiç
    // bitmiyor (on beş dakikada bir koşması beklenen iş saniyede bir turla 600 kez koştu), ve
    // ilk 500'ün ötesindeki klasörlerin İÇİ hiç listelenmiyor — satırları var ama içlerindeki
    // dosyalar hiç görünmüyor.
    //
    // İmleç bir sıra numarası değil, klasör başına bir ZAMAN DAMGASI: ağaç yürüyüş sırasında
    // değiştiğinde sıra numarası anlamını kaybeder, damga kaybetmez. Yeni keşfedilen klasör
    // `NULL` ile geldiği için sıranın başına geçiyor, yani en yeni değişiklik en önce okunuyor.
    //
    // KÖK HER TURDA OKUNUYOR ve bu bilerek: tek bir listeleme, ve paylaşımın en üst seviyesi
    // kullanıcının en sık baktığı yer. Kökün satırı olmadığı için damgası da yok.
    const started = new Date();
    const queue: Array<{ id: string | null; components: string[] }> = [
      { id: null, components: [] },
      ...(await this.stalestFolders(organizationId, shareId, IndexerService.BATCH)),
    ];
    const seen = new Set<string>(queue.map((f) => f.id).filter((id): id is string => id !== null));
    /** Bu turda gerçekten listelenen klasörler; damgaları sonunda tek yazmayla vuruluyor. */
    const scannedIds: string[] = [];

    while (queue.length > 0 && result.scanned < IndexerService.BATCH) {
      const folder = queue.shift();
      if (folder === undefined) break;

      if (!(await report(result.scanned / IndexerService.BATCH))) {
        this.logger.warn(`lost the lease part-way through ${reason}; stopping`);
        await this.markScanned(organizationId, scannedIds);
        return { ...result, more: true };
      }

      const listing = await this.listing(share.name, folder.components, reason);
      result.scanned += 1;
      if (listing !== 'gone' && listing.truncated) result.truncated += 1;

      if (listing === 'gone') {
        // The folder is in the database and not on disk. Its row goes — along with everything
        // under it, because a subtree whose root is absent is absent.
        if (folder.id !== null) {
          result.removed += await this.forget(organizationId, folder.id);
        }
        continue;
      }
      if (folder.id !== null) scannedIds.push(folder.id);
      await this.compare(organizationId, shareId, folder, listing, result, queue, seen);
    }

    await this.markScanned(organizationId, scannedIds);
    await report(1);

    // "Devam" artık kuyruğun boş olup olmamasına değil, DİSKTE bu turda okunmamış bir klasör
    // kalıp kalmadığına bakıyor. Kuyruğa bakan eski hâl, kuyruk her turda yeniden dolduğu için
    // hep "devam" diyordu.
    return { ...result, more: await this.hasUnscanned(organizationId, shareId, started) };
  }

  /**
   * En bayat klasörler: en son okunmasının üstünden en çok geçmiş olanlar, hiç okunmamışlar önce.
   *
   * Yolun bileşenleri satırdaki `path` alanından çıkıyor (`/a/b` → `['a','b']`), çünkü ajana
   * giden şey birleştirilmiş bir yol değil, bileşen dizisi.
   */
  private async stalestFolders(
    organizationId: string,
    shareId: string,
    limit: number,
  ): Promise<Array<{ id: string; components: string[] }>> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ id: string; path: string }>(
        `SELECT id::text AS id, path
           FROM public.file_entries
          WHERE share_id = $1::uuid AND kind = 'folder' AND trashed_at IS NULL
          ORDER BY scanned_at ASC NULLS FIRST, path ASC
          LIMIT $2`,
        [shareId, limit],
      ),
    );
    return rows.map((row) => ({
      id: row.id,
      components: row.path.split('/').filter((part) => part !== ''),
    }));
  }

  /** Okunan klasörlerin damgası, tek yazmada. */
  private async markScanned(organizationId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.withTenant(organizationId, (q) =>
      q.query(`UPDATE public.file_entries SET scanned_at = now() WHERE id = ANY($1::uuid[])`, [
        ids,
      ]),
    );
  }

  /** Bu turda okunmamış bir klasör kaldı mı — yürüyüşün "devam" cevabı. */
  private async hasUnscanned(
    organizationId: string,
    shareId: string,
    started: Date,
  ): Promise<boolean> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ left: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM public.file_entries
            WHERE share_id = $1::uuid AND kind = 'folder' AND trashed_at IS NULL
              AND (scanned_at IS NULL OR scanned_at < $2)
         ) AS "left"`,
        [shareId, started],
      ),
    );
    return rows[0]?.left === true;
  }

  /**
   * One directory: make the rows under it agree with what the listing reported.
   *
   * ONE COPY, used by both the full walk and the audit-driven fast path. Two copies of this
   * comparison would be two answers to "did this file change", and the fast path — which runs
   * hundreds of times more often — would be the one nobody noticed drifting.
   *
   * `queue` is where folders to descend into go, or `null` when the caller does not descend.
   * `reconcileOne` passes `null`: one audit event must not become an unbounded walk.
   */
  private async compare(
    organizationId: string,
    shareId: string,
    folder: { id: string | null; components: string[] },
    listing: {
      entries: Array<{ name: string; directory: boolean; size: number; modified_unix: number }>;
      truncated: boolean;
    },
    result: ReconcileResult,
    queue: Array<{ id: string | null; components: string[] }> | null,
    /**
     * Bu turda kuyruğa girmiş klasör kimlikleri.
     *
     * Kuyruk artık iki kaynaktan doluyor — en bayat klasörler ve yürüyüş sırasında keşfedilenler
     * — ve ikisi kesişebiliyor. Aynı klasörü iki kez listelemek yanlış bir sonuç üretmiyor ama
     * turun bütçesinden yiyor, ve bütçe tam olarak kaç klasörün okunacağı demek.
     */
    seen: Set<string> | null = null,
  ): Promise<void> {
    const known = await this.rowsUnder(organizationId, shareId, folder.id);
    const onDisk = new Map(listing.entries.map((entry) => [entry.name, entry]));
    const descend = (id: string | null, name: string): void => {
      // Kimliği olmayan bir klasör kuyruğa girmiyor: kimlik hem damganın hem de tekrar
      // görülmenin anahtarı, ve onsuz aynı klasör her turda yeniden okunurdu.
      if (id === null) return;
      if (seen !== null && seen.has(id)) return;
      seen?.add(id);
      queue?.push({ id, components: [...folder.components, name] });
    };

    for (const row of known) {
      const found = onDisk.get(row.name);

      // A TRASHED row is not part of the comparison, and taking it out of `onDisk` is the whole
      // point of visiting it. Its bytes are still exactly where they were — the trash is a column,
      // not a folder — so leaving the name in `onDisk` would make the walk decide DEPSIS did not
      // know about the file and write a SECOND row for something the user has already deleted. The
      // bin would refill itself on every pass.
      //
      // Nothing else happens to it: it is not removed when the file is gone (the purge owns that),
      // not refreshed, and not descended into, because everything under it is in the bin as well.
      if (row.trashed) {
        if (found !== undefined) onDisk.delete(row.name);
        continue;
      }

      if (found === undefined) {
        // A clipped listing tells us nothing about the names it did not report, so NOTHING is
        // removed on the strength of it. Reconciling half a directory and deleting the rest of the
        // rows is the one mistake this pass must never make.
        if (!listing.truncated) result.removed += await this.forget(organizationId, row.id);
        continue;
      }
      onDisk.delete(row.name);

      if (found.directory !== (row.kind === 'folder')) {
        // A name that is a file in the database and a directory on disk, or the reverse. The row
        // describes something that no longer exists; the disk is the authority.
        result.removed += await this.forget(organizationId, row.id);
        const made = await this.remember(organizationId, shareId, folder, found);
        if (made !== null) {
          result.discovered += 1;
          if (found.directory) descend(made, found.name);
        }
        continue;
      }

      if (await this.refresh(organizationId, row, found)) result.updated += 1;
      if (found.directory) descend(row.id, found.name);
    }

    // Whatever is left on disk is what DEPSIS did not know about — the SMB writes.
    for (const entry of onDisk.values()) {
      const made = await this.remember(organizationId, shareId, folder, entry);
      if (made === null) continue;
      result.discovered += 1;
      if (entry.directory) descend(made, entry.name);
    }
  }

  /**
   * Reconcile ONE directory, without walking the tree below it.
   *
   * The fast path. A Samba audit line says which directory a client changed, so re-reading the
   * whole share to find one new file is work nobody asked for — a copy of ten thousand files into
   * one folder would otherwise trigger ten thousand full walks.
   *
   * A folder DISCOVERED here is not descended into. The audit stream will report its contents as
   * they are written, and the fifteen-minute walk catches anything it missed. Descending would
   * make one event an unbounded amount of work, which is the property the queue exists to avoid.
   */
  async reconcileOne(
    organizationId: string,
    shareId: string,
    components: readonly string[],
    reason: string,
  ): Promise<ReconcileResult> {
    const share = await this.files.shareFor(organizationId, shareId);
    const result: ReconcileResult = {
      discovered: 0,
      updated: 0,
      removed: 0,
      truncated: 0,
      scanned: 1,
    };

    const folder = await this.folderAt(organizationId, shareId, components);
    if (folder.at === 'nowhere') {
      // The directory the event named is not in the database at all. Nothing to compare against;
      // the walk will find it, or its parent's own event will.
      return result;
    }
    const folderId = folder.at === 'folder' ? folder.id : null;

    const listing = await this.listing(share.name, components, reason);
    if (listing === 'gone') {
      if (folderId !== null) result.removed += await this.forget(organizationId, folderId);
      return result;
    }
    if (listing.truncated) result.truncated += 1;

    await this.compare(
      organizationId,
      shareId,
      { id: folderId, components: [...components] },
      listing,
      result,
      // No queue: a folder found here is not descended into.
      null,
    );
    return result;
  }

  /**
   * Where a share-relative path resolves to.
   *
   * Walked one component at a time rather than matched on `path`, because `path` is a denormalised
   * convenience and the parent chain is the authority — a rename that had not propagated would
   * make the two disagree, and the walk must follow the one the rest of the product uses.
   */
  private async folderAt(
    organizationId: string,
    shareId: string,
    components: readonly string[],
  ): Promise<Resolved> {
    let parentId: string | null = null;
    for (const part of components) {
      const rows = await this.db.withTenant(organizationId, (q) =>
        q.query<{ id: string }>(
          `SELECT id::text AS id FROM public.file_entries
            WHERE organization_id = $1 AND share_id = $2
              AND parent_id IS NOT DISTINCT FROM $3
              AND kind = 'folder' AND name = $4 AND trashed_at IS NULL`,
          [organizationId, shareId, parentId, part],
        ),
      );
      const found = rows[0];
      if (found === undefined) return { at: 'nowhere' };
      parentId = found.id;
    }
    return parentId === null ? { at: 'root' } : { at: 'folder', id: parentId };
  }

  /** Everything the audit reader has reported and nobody has looked at yet. */
  async queued(organizationId: string, limit: number): Promise<QueuedPath[]> {
    return this.db.withTenant(organizationId, (q) =>
      q.query<QueuedPath>(
        // Oldest first. A directory somebody is writing to continuously would otherwise hold the
        // front of the queue forever and starve everything behind it.
        `SELECT share_id::text AS "shareId", path, actor
           FROM public.index_queue
          WHERE organization_id = $1
          ORDER BY seen_at
          LIMIT $2`,
        [organizationId, limit],
      ),
    );
  }

  /**
   * Take one entry off the queue.
   *
   * Deleted AFTER the directory has been reconciled, never before. The other order loses the event
   * when the pass dies part-way, and the fifteen-minute walk would be the only thing that ever
   * noticed — which is exactly the latency this layer exists to remove.
   *
   * `seen_at` is compared, so an event that arrived WHILE the reconciliation was running is not
   * thrown away: the row stays, with the newer timestamp, and is picked up next time.
   */
  async dequeue(
    organizationId: string,
    shareId: string,
    path: string,
    notNewerThan: Date,
  ): Promise<void> {
    await this.db.withTenant(organizationId, (q) =>
      q.query(
        `DELETE FROM public.index_queue
          WHERE organization_id = $1 AND share_id = $2 AND path = $3 AND seen_at <= $4`,
        [organizationId, shareId, path, notNewerThan],
      ),
    );
  }

  /** Record that a directory changed. Called by the audit reader, once per distinct directory. */
  async enqueuePath(
    organizationId: string,
    shareId: string,
    path: string,
    actor: string | null,
    client: string | null,
  ): Promise<void> {
    await this.db.withTenant(organizationId, (q) =>
      q.query(
        // One row per directory, whatever the event count. A copy of ten thousand files into one
        // folder is one row whose `seen_at` moves, not ten thousand rows.
        `INSERT INTO public.index_queue (organization_id, share_id, path, actor, client)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (organization_id, share_id, path) DO UPDATE
           SET seen_at = now(), actor = EXCLUDED.actor, client = EXCLUDED.client`,
        [organizationId, shareId, path, actor, client],
      ),
    );
  }

  /** One directory, or `gone` when it is not there any more. */
  private async listing(
    shareName: string,
    components: readonly string[],
    reason: string,
  ): Promise<
    | 'gone'
    | {
        entries: Array<{ name: string; directory: boolean; size: number; modified_unix: number }>;
        truncated: boolean;
      }
  > {
    const response = await this.agent.call(
      { op: 'list_directory', share: shareName, path: [...components] },
      reason,
    );
    if (response.status === 'not_found') return 'gone';
    if (response.status !== 'listing') {
      throw new Error(`the agent answered '${response.status}' to a listing of ${shareName}`);
    }
    return {
      entries: response.entries.map((entry) => ({
        name: entry.name,
        directory: entry.directory,
        size: entry.size,
        modified_unix: entry.modified_unix,
      })),
      truncated: response.truncated,
    };
  }

  /**
   * Every row DEPSIS believes is directly under `parentId`, TRASHED ONES INCLUDED.
   *
   * Including them is not an oversight, and leaving them out was a real bug the tests caught. A
   * trashed entry's bytes are still on disk, so a walk that could not see the row would decide the
   * file was unknown and write a second row for something the user had already deleted — every
   * pass, forever. `trashed` is carried on the row so the caller can answer the two questions
   * separately: such a row accounts for its name on disk, and is otherwise left alone.
   */
  private async rowsUnder(
    organizationId: string,
    shareId: string,
    parentId: string | null,
  ): Promise<Row[]> {
    return this.db.withTenant(organizationId, (q) =>
      q.query<Row>(
        `SELECT id::text AS id, name, kind, size_bytes::text AS size_bytes, updated_at,
                (trashed_at IS NOT NULL) AS trashed
           FROM public.file_entries
          WHERE organization_id = $1 AND share_id = $2
            AND parent_id IS NOT DISTINCT FROM $3`,
        [organizationId, shareId, parentId],
      ),
    );
  }

  /** Write a row for something the disk has and the database did not. Returns its id. */
  private async remember(
    organizationId: string,
    shareId: string,
    folder: { id: string | null; components: string[] },
    entry: { name: string; directory: boolean; size: number; modified_unix: number },
  ): Promise<string | null> {
    const path = `/${[...folder.components, entry.name].join('/')}`;
    try {
      const rows = await this.db.withTenant(organizationId, (q) =>
        q.query<{ id: string }>(
          // `updated_at` comes from the FILESYSTEM, not from `now()`. A file that arrived over SMB
          // last week must not appear at the top of a "recently modified" list because DEPSIS
          // happened to notice it this afternoon.
          `INSERT INTO public.file_entries
             (organization_id, share_id, parent_id, kind, name, path, size_bytes, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8))
           RETURNING id::text AS id`,
          [
            organizationId,
            shareId,
            folder.id,
            entry.directory ? 'folder' : 'file',
            entry.name,
            path,
            entry.directory ? 0 : entry.size,
            entry.modified_unix,
          ],
        ),
      );
      return rows[0]?.id ?? null;
    } catch (error) {
      // A name the database refuses — a trashed row already holding it, a fold collision with a
      // name that differs only by case. Skipped and counted in the log rather than failing the
      // pass: one awkward name must not stop a share from being indexed.
      this.logger.warn(
        `could not index '${path}': ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /** Bring a row's size and modification time up to what the disk says. True when it moved. */
  private async refresh(
    organizationId: string,
    row: Row,
    entry: { size: number; modified_unix: number; directory: boolean },
  ): Promise<boolean> {
    if (entry.directory) return false;
    const sameSize = Number(row.size_bytes) === entry.size;
    // Second precision, because that is what the filesystem reports here. Comparing at
    // millisecond precision would make every pass see a difference and rewrite every row.
    const sameTime = Math.floor(row.updated_at.getTime() / 1000) === entry.modified_unix;
    if (sameSize && sameTime) return false;

    await this.db.withTenant(organizationId, (q) =>
      q.query(
        `UPDATE public.file_entries SET size_bytes = $2, updated_at = to_timestamp($3)
          WHERE id = $1`,
        [row.id, entry.size, entry.modified_unix],
      ),
    );
    return true;
  }

  /**
   * Drop a row and everything under it. Returns how many rows went.
   *
   * NOTHING IS UNLINKED. The file is already gone from disk — that is why the row is being
   * removed — so this touches the database only. It is what makes a scheduled, unattended pass
   * safe: there is no path from here to a destructive agent call.
   */
  private async forget(organizationId: string, id: string): Promise<number> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ n: string }>(
        `WITH RECURSIVE tree AS (
           SELECT id FROM public.file_entries WHERE organization_id = $1 AND id = $2
           UNION ALL
           SELECT c.id FROM public.file_entries c JOIN tree t ON c.parent_id = t.id
            WHERE c.organization_id = $1
         ),
         gone AS (
           DELETE FROM public.file_entries
            WHERE organization_id = $1 AND id IN (SELECT id FROM tree)
            RETURNING 1
         )
         SELECT count(*)::text AS n FROM gone`,
        [organizationId, id],
      ),
    );
    return Number(rows[0]?.n ?? '0');
  }

  /** Put a pass on the queue, unless one is already waiting for this share. */
  async schedule(organizationId: string, shareId: string, runAfter: Date): Promise<void> {
    await this.db.withTenant(organizationId, (q) =>
      q.query(
        `INSERT INTO public.job_queue (organization_id, kind, payload, run_after, max_attempts)
         VALUES ($1, $2, jsonb_build_object('shareId', $3::text), $4, 3)
         ON CONFLICT DO NOTHING`,
        [organizationId, RECONCILE_KIND, shareId, runAfter],
      ),
    );
  }

  /** Put a drain pass on the queue, unless one is already waiting. */
  async scheduleDrain(organizationId: string, runAfter: Date): Promise<void> {
    await this.db.withTenant(organizationId, (q) =>
      q.query(
        `INSERT INTO public.job_queue (organization_id, kind, payload, run_after, max_attempts)
         VALUES ($1, $2, '{}'::jsonb, $3, 3)
         ON CONFLICT DO NOTHING`,
        [organizationId, INDEX_DRAIN_KIND, runAfter],
      ),
    );
  }

  /**
   * A share by the name Samba knows it as.
   *
   * The audit stream names the SHARE, not its id — that is the only identifier smbd has. Folded
   * through `fold_identity` because `shares_name_unique` is, and because SMB clients treat
   * `Belgeler` and `belgeler` as one name.
   */
  async shareByName(organizationId: string, name: string): Promise<string | null> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ id: string }>(
        `SELECT id::text AS id FROM public.shares
          WHERE organization_id = $1 AND public.fold_identity(name) = public.fold_identity($2)`,
        [organizationId, name],
      ),
    );
    return rows[0]?.id ?? null;
  }

  /** Every share on the box, so the boot-time seed can cover them. */
  async shares(organizationId: string): Promise<string[]> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ id: string }>(`SELECT id::text AS id FROM public.shares`),
    );
    return rows.map((row) => row.id);
  }

  /** Record what a pass found, on the job, so `job_history` carries it. */
  async recordResult(
    organizationId: string,
    jobId: string,
    result: ReconcileResult,
  ): Promise<void> {
    await this.db.withTenant(organizationId, (q) =>
      q.query(
        `UPDATE public.job_queue
            SET payload = payload || jsonb_build_object('result', $3::jsonb)
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, jobId, JSON.stringify(result)],
      ),
    );
  }
}
