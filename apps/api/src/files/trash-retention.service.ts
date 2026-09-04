import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { DbService } from '../db/db.service.js';
import { FilesService, type ShareRef } from './files.service.js';

/** The organisation's policy. `retentionDays: null` means keep the bin forever. */
export interface TrashPolicy {
  retentionDays: number | null;
  updatedAt: string | null;
}

/** What a purge would take, or did. */
export interface TrashImpact {
  /** Top-level trashed entries. A trashed folder counts once, whatever it holds. */
  entries: number;
  /** Files inside them, counted recursively — the number that decides how long a purge runs. */
  files: number;
  /**
   * Bytes that would come back.
   *
   * Summed over DESCENDANT FILES, never over the trashed roots. `file_entries_folder_has_no_size`
   * fixes a folder's `size_bytes` at 0, so a bin holding one trashed 10 GB folder previews as
   * "1 entry, 0 bytes" if the roots are summed — a reclaimable-space figure reported without being
   * measured, on the very screen where an operator arms the destruction.
   */
  bytes: number;
  /** The oldest thing in the bin, so a policy can be judged against what it would take today. */
  oldestTrashedAt: string | null;
}

/** One purge run's result, recorded on the job so the history says what happened. */
export interface PurgeResult {
  purged: number;
  failed: number;
  bytes: number;
}

export const TRASH_PURGE_KIND = 'files.trash.purge';

/**
 * The bin's expiry, and the thing that enforces it.
 *
 * §7 asks for a retention period and an administrator purge policy. Neither existed: nothing ever
 * left the bin on its own, so bytes a user deleted counted against their refquota forever and the
 * only way to reclaim them was to find each row and press permanent delete.
 *
 * THE DEFAULT IS "KEEP FOREVER", and that is the whole safety argument. A migration must not start
 * deleting user data at a moment nobody chose. Turning the policy on is a deliberate act, the
 * screen that turns it on shows what the first run would take, and the database refuses a
 * retention below one day — zero would make trashing equal to permanent deletion, which removes
 * the one click standing between a user and irreversible loss.
 *
 * SCHEDULING IS THE QUEUE, NOT A TIMER. A `setInterval` runs only while that process is up and is
 * gone after a restart; `job_queue.run_after` is a durable timer that already exists. The handler
 * schedules its own successor and the API re-seeds one at boot, both through `schedule()`, which
 * is a no-op when a run is already queued. The partial unique index behind it covers `queued` and
 * deliberately not `running` — covering both would make the handler's own successor a
 * unique_violation while the parent row is still running, and the chain would never advance.
 */
@Injectable()
export class TrashRetentionService implements OnModuleInit {
  /** How often the purge runs. Hourly: fine enough for a day-granular policy, cheap when idle. */
  static readonly INTERVAL_MS = 60 * 60_000;

  /**
   * Roots per run.
   *
   * Each is a recursive delete through the agent, one node at a time. A run that took the whole
   * bin would hold the worker — and the appliance's single control connection — for as long as
   * that took. The next run is an hour away, or sooner: a run that hits this limit schedules its
   * successor immediately instead.
   */
  static readonly BATCH = 100;

  private readonly logger = new Logger(TrashRetentionService.name);

  constructor(
    private readonly db: DbService,
    private readonly files: FilesService,
  ) {}

  /**
   * Re-seed the schedule for every organisation that has a policy.
   *
   * The chain is self-sustaining once it starts — each run queues the next — but a chain has one
   * failure mode: if a run dies in a way that skips its own successor, nothing ever schedules
   * again and a policy quietly stops enforcing itself, with no symptom an operator could notice.
   * A boot-time seed is the recovery, and `schedule` is a no-op when a run is already queued, so
   * running it every boot costs one INSERT that does nothing.
   *
   * Failures here are logged, never thrown: a database that is briefly unreachable at startup must
   * not stop the API from serving. The next boot tries again.
   */
  async onModuleInit(): Promise<void> {
    try {
      const organizations = await this.organizationsWithPolicy();
      for (const organizationId of organizations) {
        await this.schedule(organizationId, new Date());
      }
      if (organizations.length > 0) {
        this.logger.log(`trash retention scheduled for ${organizations.length} organisation(s)`);
      }
    } catch (error) {
      this.logger.error(
        `could not seed the trash purge schedule: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async policy(organizationId: string): Promise<TrashPolicy> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ trash_retention_days: number | null; updated_at: Date }>(
        `SELECT trash_retention_days, updated_at FROM public.organization_settings
          WHERE organization_id = $1`,
        [organizationId],
      ),
    );
    const row = rows[0];
    return {
      retentionDays: row?.trash_retention_days ?? null,
      updatedAt: row?.updated_at.toISOString() ?? null,
    };
  }

  async setPolicy(
    organizationId: string,
    retentionDays: number | null,
    actorId: string,
  ): Promise<TrashPolicy> {
    await this.db.withTenant(organizationId, (q) =>
      q.query(
        `INSERT INTO public.organization_settings
           (organization_id, trash_retention_days, updated_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (organization_id) DO UPDATE
           SET trash_retention_days = EXCLUDED.trash_retention_days,
               updated_by = EXCLUDED.updated_by,
               updated_at = now()`,
        [organizationId, retentionDays, actorId],
      ),
    );
    this.logger.warn(
      retentionDays === null
        ? `trash retention switched off by ${actorId}; nothing will be purged`
        : `trash retention set to ${retentionDays} days by ${actorId}`,
    );
    // Immediately, not at the next hour. Somebody who has just been shown what a policy would take
    // expects it to happen; an hour of nothing reads as a setting that did not save.
    await this.schedule(organizationId, new Date());
    return this.policy(organizationId);
  }

  /**
   * What a purge would take right now.
   *
   * `retentionDays` is the policy being CONSIDERED, not necessarily the one stored — the settings
   * screen prices a value before it is saved, which is the only moment the number can change an
   * administrator's mind.
   */
  async impact(organizationId: string, retentionDays: number | null): Promise<TrashImpact> {
    if (retentionDays === null) {
      return { entries: 0, files: 0, bytes: 0, oldestTrashedAt: null };
    }
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ entries: string; files: string; bytes: string; oldest: Date | null }>(
        // Two levels, and the second is what makes the byte figure true. `roots` is the trashed
        // entries whose own PARENT is not trashed — a file inside a trashed folder is going too,
        // but it is not a separate thing the user threw away. `tree` then walks down from each
        // root, and only its FILES carry bytes: a folder's `size_bytes` is fixed at 0 by
        // `file_entries_folder_has_no_size`, so summing the roots would report a 10 GB folder as
        // zero reclaimable bytes on the screen where the destruction is armed.
        `WITH RECURSIVE roots AS (
           SELECT e.id, e.trashed_at
             FROM public.file_entries e
             LEFT JOIN public.file_entries p ON p.id = e.parent_id
            WHERE e.organization_id = $1
              AND e.trashed_at IS NOT NULL
              AND e.trashed_at < now() - make_interval(days => $2::int)
              AND (p.id IS NULL OR p.trashed_at IS NULL)
         ),
         tree AS (
           SELECT e.id, e.kind, e.size_bytes
             FROM public.file_entries e JOIN roots r ON r.id = e.id
           UNION ALL
           SELECT c.id, c.kind, c.size_bytes
             FROM public.file_entries c JOIN tree t ON c.parent_id = t.id
            WHERE c.organization_id = $1
         )
         SELECT (SELECT count(*) FROM roots)::text                                   AS entries,
                (SELECT count(*) FROM tree WHERE kind = 'file')::text                AS files,
                (SELECT coalesce(sum(size_bytes), 0) FROM tree WHERE kind = 'file')::text AS bytes,
                (SELECT min(trashed_at) FROM roots)                                  AS oldest`,
        [organizationId, retentionDays],
      ),
    );
    const row = rows[0];
    return {
      entries: Number(row?.entries ?? '0'),
      files: Number(row?.files ?? '0'),
      bytes: Number(row?.bytes ?? '0'),
      oldestTrashedAt: row?.oldest?.toISOString() ?? null,
    };
  }

  /**
   * Put a run on the queue, unless one is already waiting.
   *
   * `ON CONFLICT DO NOTHING` against `job_queue_one_scheduled_purge`. Two callers reach this — the
   * handler scheduling its successor, and the API re-seeding at boot — and either can recover the
   * chain if the other never runs. Neither may produce a second queued run.
   */
  async schedule(organizationId: string, runAfter: Date): Promise<void> {
    await this.db.withTenant(organizationId, (q) =>
      q.query(
        `INSERT INTO public.job_queue (organization_id, kind, payload, run_after, max_attempts)
         VALUES ($1, $2, '{}'::jsonb, $3, 3)
         ON CONFLICT DO NOTHING`,
        [organizationId, TRASH_PURGE_KIND, runAfter],
      ),
    );
  }

  /**
   * Take everything past its expiry, up to `BATCH` roots.
   *
   * ROOTS ONLY, and `FilesService.purge` walks each subtree itself. Purging a file whose parent
   * folder is also expiring would delete it twice — once on its own and once as part of the
   * folder — and the second attempt is an agent `not_found` that reads as a fault.
   *
   * A root that FAILS does not stop the run. One file the agent cannot remove — a name changed
   * over SMB, a permission the ACL no longer grants — must not park the whole bin forever; the
   * count comes back and lands on the job so the history says how many were left.
   */
  async purgeExpired(
    organizationId: string,
    report: (fraction: number) => Promise<boolean>,
  ): Promise<PurgeResult & { more: boolean }> {
    const { retentionDays } = await this.policy(organizationId);
    if (retentionDays === null) return { purged: 0, failed: 0, bytes: 0, more: false };

    const roots = await this.db.withTenant(organizationId, (q) =>
      q.query<{ id: string; share_id: string; name: string; bytes: string }>(
        `WITH RECURSIVE roots AS (
           SELECT e.id, e.share_id, e.name, e.trashed_at
             FROM public.file_entries e
             LEFT JOIN public.file_entries p ON p.id = e.parent_id
            WHERE e.organization_id = $1
              AND e.trashed_at IS NOT NULL
              AND e.trashed_at < now() - make_interval(days => $2::int)
              AND (p.id IS NULL OR p.trashed_at IS NULL)
            ORDER BY e.trashed_at
            LIMIT $3
         ),
         tree AS (
           SELECT e.id, e.kind, e.size_bytes, r.id AS root_id
             FROM public.file_entries e JOIN roots r ON r.id = e.id
           UNION ALL
           SELECT c.id, c.kind, c.size_bytes, t.root_id
             FROM public.file_entries c JOIN tree t ON c.parent_id = t.id
            WHERE c.organization_id = $1
         )
         SELECT r.id::text AS id, r.share_id::text AS share_id, r.name,
                coalesce((SELECT sum(size_bytes) FROM tree t
                           WHERE t.root_id = r.id AND t.kind = 'file'), 0)::text AS bytes
           FROM roots r
          ORDER BY r.trashed_at`,
        [organizationId, retentionDays, TrashRetentionService.BATCH],
      ),
    );

    let purged = 0;
    let failed = 0;
    let bytes = 0;

    for (const [index, root] of roots.entries()) {
      if (!(await report(index / Math.max(1, roots.length)))) {
        this.logger.warn('lost the lease part-way through a trash purge; stopping');
        break;
      }
      const share = await this.shareOf(organizationId, root.share_id);
      if (share === null) {
        failed += 1;
        continue;
      }
      try {
        await this.files.purge(
          organizationId,
          root.id,
          share,
          randomUUID(),
          `trash retention: ${retentionDays} days`,
        );
        purged += 1;
        bytes += Number(root.bytes);
      } catch (error) {
        // Counted and carried on. Under automation nobody is watching a log line, so the number
        // goes onto the job where the history — and the jobs board — can show it.
        failed += 1;
        this.logger.error(
          `could not purge '${root.name}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // `more` "hemen bir tur daha" demek: işleyici ardılı `new Date()` ile kuruyor ve işçi bekleyen
    // bir işi hiç beklemeden alıyor. O yüzden koşul dolu bir sayfa DEĞİL, İLERLEME olmalı. Ajan
    // kapalıyken her kök `AgentUnavailableError` ile anında düşüyor: dolu bir sayfaya bakan eski
    // koşul, saniyede birkaç tur, tur başına yüz hata satırı üreten sıkı bir döngüye giriyordu.
    // Hiçbir kök silinemediğinde tur yine BAŞARILI sayılıyor ve ardıl bir sonraki aralığa kuruluyor
    // — hata atmak zinciri tamamen kırardı, çünkü işleyici `schedule`ı bu çağrıdan SONRA yapıyor.
    const more = purged > 0 && roots.length >= TrashRetentionService.BATCH;
    return { purged, failed, bytes, more };
  }

  /**
   * Saklama süresi ayarlanmış kiracılar. Açılıştaki yeniden tohumlama bunu kullanıyor.
   *
   * KİRACILAR ÖNCE, sonra her biri KENDİ bağlamında. Eskiden `organization_settings` doğrudan
   * `withoutTenant` ile okunuyordu ve tablo kiracıya ait: RLS bağlamsız sorguya sıfır satır
   * döndürüyor, hata vermiyor, ve çöp budama zinciri gerçek bir cihazda hiç kurulmuyordu.
   * Bkz. `DbService.tenantIds`.
   */
  async organizationsWithPolicy(): Promise<string[]> {
    const found: string[] = [];
    for (const organizationId of await this.db.tenantIds()) {
      const rows = await this.db.withTenant(organizationId, (q) =>
        q.query<{ id: string }>(
          `SELECT 1::text AS id FROM public.organization_settings
            WHERE trash_retention_days IS NOT NULL LIMIT 1`,
        ),
      );
      if (rows.length > 0) found.push(organizationId);
    }
    return found;
  }

  /**
   * The share an entry lives in, as the agent needs it named.
   *
   * `FilesService.purge` takes a `ShareRef` and the only other place that builds one is a private
   * method on an HTTP controller — which the worker must not import (`worker-surface.ts`). This is
   * the public resolver that was missing.
   */
  private async shareOf(organizationId: string, shareId: string): Promise<ShareRef | null> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ id: string; name: string }>(
        `SELECT id::text AS id, name FROM public.shares
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, shareId],
      ),
    );
    const row = rows[0];
    return row === undefined ? null : { id: row.id, name: row.name };
  }

  /** Record what a run did on the job itself, so `job_history` carries it. */
  async recordResult(organizationId: string, jobId: string, result: PurgeResult): Promise<void> {
    // Into the job's own payload, which `finish_job` copies into `job_history` with `(j).*`. No
    // schema change, and the answer to "what did last night's purge take?" survives where an
    // alarm can find it — which is what ADR-0003 asks of a finished job.
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
