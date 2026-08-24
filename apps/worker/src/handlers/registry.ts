import type {
  AclApplyService,
  AgentService,
  CopyService,
  IdentitySyncService,
  JobsService,
  TrashRetentionService,
} from '@depsis/api/worker-surface';

import type { WorkerService } from '../worker.service.js';
import { applyAclHandler, APPLY_ACL_KIND } from './apply-acl.handler.js';
import { copyHandler, COPY_KIND } from './copy.handler.js';
import { trashPurgeHandler, TRASH_PURGE_KIND } from './trash-purge.handler.js';
import { identitySyncHandler, IDENTITY_SYNC_KIND } from './identity-sync.handler.js';
import { snapshotHandler, SNAPSHOT_KIND } from './snapshot.handler.js';

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
}
