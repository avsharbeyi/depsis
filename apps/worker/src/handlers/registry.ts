import type { AclApplyService, AgentService } from '@depsis/api/worker-surface';

import type { WorkerService } from '../worker.service.js';
import { applyAclHandler, APPLY_ACL_KIND } from './apply-acl.handler.js';
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
  services: { agent: AgentService; acl: AclApplyService },
): void {
  worker.register(SNAPSHOT_KIND, snapshotHandler(services.agent));
  worker.register(APPLY_ACL_KIND, applyAclHandler(services.acl));
}
