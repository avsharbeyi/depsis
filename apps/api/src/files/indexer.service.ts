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

    /** Folders still to visit: the share root, then whatever is found under it. */
    const queue: Array<{ id: string | null; components: string[] }> = [
      { id: null, components: [] },
    ];

    while (queue.length > 0 && result.scanned < IndexerService.BATCH) {
      const folder = queue.shift();
      if (folder === undefined) break;

      if (!(await report(result.scanned / IndexerService.BATCH))) {
        this.logger.warn(`lost the lease part-way through ${reason}; stopping`);
        return { ...result, more: true };
      }

      const listing = await this.listing(share.name, folder.components, reason);
      result.scanned += 1;

      if (listing === 'gone') {
        // The folder is in the database and not on disk. Its row goes — along with everything
        // under it, because a subtree whose root is absent is absent.
        if (folder.id !== null) {
          result.removed += await this.forget(organizationId, folder.id);
        }
        continue;
      }
      if (listing.truncated) {
        // A clipped listing tells us nothing about the names it did not report, so NOTHING under
        // this folder is removed on the strength of it. Reconciling half a directory and deleting
        // the rest of the rows is the one mistake this pass must never make.
        result.truncated += 1;
      }

      const known = await this.rowsUnder(organizationId, shareId, folder.id);
      const onDisk = new Map(listing.entries.map((entry) => [entry.name, entry]));

      for (const row of known) {
        const found = onDisk.get(row.name);

        // A TRASHED row is not part of the comparison, and taking it out of `onDisk` is the whole
        // point of visiting it. Its bytes are still exactly where they were — the trash is a
        // column, not a folder — so leaving the name in `onDisk` would make the walk decide DEPSIS
        // did not know about the file and write a SECOND row for something the user has already
        // deleted. The bin would refill itself on every pass.
        //
        // Nothing else happens to it: it is not removed when the file is gone (the purge owns
        // that), not refreshed, and not descended into, because everything under it is in the bin
        // as well.
        if (row.trashed) {
          if (found !== undefined) onDisk.delete(row.name);
          continue;
        }

        if (found === undefined) {
          if (!listing.truncated) result.removed += await this.forget(organizationId, row.id);
          continue;
        }
        onDisk.delete(row.name);

        if (found.directory !== (row.kind === 'folder')) {
          // A name that is a file in the database and a directory on disk, or the reverse. The
          // row describes something that no longer exists; the disk is the authority.
          result.removed += await this.forget(organizationId, row.id);
          const made = await this.remember(organizationId, shareId, folder, found);
          if (made !== null) {
            result.discovered += 1;
            if (found.directory)
              queue.push({ id: made, components: [...folder.components, found.name] });
          }
          continue;
        }

        if (await this.refresh(organizationId, row, found)) result.updated += 1;
        if (found.directory) {
          queue.push({ id: row.id, components: [...folder.components, found.name] });
        }
      }

      // Whatever is left on disk is what DEPSIS did not know about — the SMB writes.
      for (const entry of onDisk.values()) {
        const made = await this.remember(organizationId, shareId, folder, entry);
        if (made === null) continue;
        result.discovered += 1;
        if (entry.directory)
          queue.push({ id: made, components: [...folder.components, entry.name] });
      }
    }

    await report(1);
    return { ...result, more: queue.length > 0 };
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
