import type {
  AclApplyService,
  AgentService,
  BackupRunService,
  BackupSchedulesService,
  CopyService,
  IdentitySyncService,
  IndexerService,
  JobsService,
  NotificationsService,
  TrashRetentionService,
} from '@depsis/api/worker-surface';

import type { WorkerService } from '../worker.service.js';
import { applyAclHandler, APPLY_ACL_KIND } from './apply-acl.handler.js';
import {
  backupPurgeHandler,
  backupRunHandler,
  backupRunNowHandler,
  BACKUP_PURGE_KIND,
  BACKUP_RUN_KIND,
  BACKUP_RUN_NOW_KIND,
} from './backup-run.handler.js';
import { backupTickHandler, BACKUP_TICK_KIND } from './backup-tick.handler.js';
import { copyHandler, COPY_KIND } from './copy.handler.js';
import { createPoolHandler, CREATE_POOL_KIND } from './create-pool.handler.js';
import { indexDrainHandler, INDEX_DRAIN_KIND } from './index-drain.handler.js';
import { reconcileHandler, RECONCILE_KIND } from './reconcile.handler.js';
import { trashPurgeHandler, TRASH_PURGE_KIND } from './trash-purge.handler.js';
import { identitySyncHandler, IDENTITY_SYNC_KIND } from './identity-sync.handler.js';
import { snapshotHandler, SNAPSHOT_KIND } from './snapshot.handler.js';
import { overdueSweepHandler, OVERDUE_SWEEP_KIND } from './overdue-sweep.handler.js';
import { offsiteHandler, OFFSITE_KIND } from './offsite.handler.js';
import { replicateHandler, REPLICATE_KIND } from './replicate.handler.js';
import { restoreSnapshotHandler, RESTORE_KIND } from './restore-snapshot.handler.js';

/**
 * Every job kind this worker consumes, in one place a test can read.
 *
 * It lived inline in `bootstrap` and that is how a kind went missing: `WorkerService.claim` only
 * ever asks for the kinds that were registered, so a `permissions.apply` row the API had been
 * enqueuing for weeks sat in `job_queue` with nothing to claim it — and the only visible symptom
 * was an interface saying "izinler uygulanıyor" for good. A registry that cannot be imported
 * without starting a process is a registry nothing asserts about.
 */
export function registerHandlers(
  worker: WorkerService,
  services: {
    agent: AgentService;
    acl: AclApplyService;
    jobs: JobsService;
    identity: IdentitySyncService;
    copies: CopyService;
    retention: TrashRetentionService;
    indexer: IndexerService;
    notifications: NotificationsService;
    schedules: BackupSchedulesService;
    backupRuns: BackupRunService;
  },
): void {
  worker.register(SNAPSHOT_KIND, snapshotHandler(services.agent));
  // `jobs` as well as `acl`: a share too large for one chunk queues its own continuation, so the
  // handler needs the queue it was claimed from.
  worker.register(APPLY_ACL_KIND, applyAclHandler(services.acl, services.jobs));
  worker.register(IDENTITY_SYNC_KIND, identitySyncHandler(services.identity));
  // No `jobs` here, unlike the ACL walk: a copy runs the whole tree in ONE job and reports
  // between nodes, so there is no successor to enqueue. The chained version made the id the user
  // was handed report `succeeded` while most of the work had not happened.
  worker.register(COPY_KIND, copyHandler(services.copies));
  // Self-scheduling: each run queues the next through `run_after`, which is the only durable
  // timer this product has. A `setInterval` would be gone after a restart.
  worker.register(TRASH_PURGE_KIND, trashPurgeHandler(services.retention));
  // The layer that makes the index TRUE. The fast path in front of it (ADR-0011's Samba
  // audit stream) is a separate change; this is what every layer degrades to.
  // The one destructive kind. Enqueued with `maxAttempts: 1` by the route that creates it —
  // every other handler here is safe to run twice, and this one runs `zpool create` against
  // real disks.
  worker.register(CREATE_POOL_KIND, createPoolHandler(services.agent));
  // The OTHER destructive kind, and enqueued with `maxAttempts: 1` for the same reason:
  // `zfs recv -F` destroys the target, and a retry after an ambiguous failure destroys it
  // again without knowing what state it reached.
  worker.register(REPLICATE_KIND, replicateHandler(services.agent, services.schedules));
  // The THIRD destructive kind, and the only one whose destruction happens on another machine.
  // `maxAttempts: 1` for the same reason as the two above, plus one: over a network an
  // ambiguous failure is the ordinary case, not the rare one.
  worker.register(OFFSITE_KIND, offsiteHandler(services.agent, services.schedules));
  // One file out of a snapshot. Registered beside the copy because it IS one — same service,
  // same sliced staging — and because a kind registered nowhere is a queue row nothing claims,
  // which is how `permissions.apply` once sat unclaimed for weeks behind a spinner.
  worker.register(RESTORE_KIND, restoreSnapshotHandler(services.copies));
  worker.register(RECONCILE_KIND, reconcileHandler(services.indexer));
  // ADR-0011 Layer 1's consumer: what Samba said, acted on within seconds. The walk above
  // stays — it is what this degrades to when an event is missed.
  worker.register(INDEX_DRAIN_KIND, indexDrainHandler(services.indexer));
  // §7's reminders. Self-scheduling like the trash purge, and for the same reason: the queue's
  // `run_after` is the only timer that survives a restart. Its failure is also the quietest one
  // in this list — what goes missing is a notification nobody was told to expect.
  worker.register(OVERDUE_SWEEP_KIND, overdueSweepHandler(services.notifications));
  // Zamanlanmış yedekler. Kendi kendini zamanlayan altıncı zincir, ve sessiz kalması en pahalı
  // olan: eksik olan şey bir yedeğin yokluğu, ve o ancak ihtiyaç duyulduğu gün aranıyor.
  worker.register(BACKUP_TICK_KIND, backupTickHandler(services.schedules));
  // Yedek diski turu: sahibinin tarif ettigi alti saatlik dongu. Zincir kendi ardilini kuyruga
  // aliyor; elle baslatilan tur AYRI bir tur, cunku zincirin tekilligini koruyan indeks aksi
  // halde dugmeyi de engellerdi.
  worker.register(BACKUP_RUN_KIND, backupRunHandler(services.backupRuns));
  worker.register(BACKUP_RUN_NOW_KIND, backupRunNowHandler(services.backupRuns));
  // Temizlik AYRI bir zincir: turun icine konsaydi, kilitli bir diskte duran tur temizligi de
  // durdururdu — ve o, saklama suresi dolan dosyalarin sonsuza kadar durmasi demekti.
  worker.register(BACKUP_PURGE_KIND, backupPurgeHandler(services.backupRuns));
}
