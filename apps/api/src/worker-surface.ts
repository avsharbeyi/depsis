/**
 * The only things `apps/worker` may import from here, and the reason it imports rather than copies.
 *
 * `DbService` is the ADR-0015 chokepoint: one pool, no getter, every query through a tenant context
 * it verifies in the same round trip. A worker with its own copy would be a SECOND path to the
 * database with its own guarantees — which is the exact shape ADR-0015 exists to make impossible,
 * and it would be invisible because both copies would look correct in isolation.
 *
 * The same argument applies to `AgentService`: it serialises calls because the agent accepts one
 * connection at a time, and two independent queues in two processes serialise nothing.
 *
 * So this is a narrow, named surface rather than a wide `exports: "./*"`. What is not listed here
 * the worker cannot reach, and adding to it is a decision someone has to make on purpose. In
 * particular the HTTP layer — controllers, the session guard, the auth flow — is deliberately
 * absent: a background process has no request to authenticate and no caller to answer.
 */

export { AgentModule } from './agent/agent.module.js';
export {
  AgentRefusedError,
  AgentService,
  AgentUnavailableError,
  expectStatus,
  type AgentRequest,
  type AgentResponse,
} from './agent/agent.service.js';

export { DbModule } from './db/db.module.js';
export { DbService, type TenantQuery } from './db/db.service.js';

export { JobsModule } from './jobs/jobs.module.js';
export {
  JobsService,
  type ClaimedJob,
  type FinishOutcome,
  type Job,
  type JobStatus,
} from './jobs/jobs.service.js';

export { PosixIdentityService } from './identity/posix.service.js';

/**
 * `POST /file-operations`'s copy. The endpoint enqueues; the worker runs it.
 *
 * The tree walk is exported rather than reimplemented for the same reason `AclApplyService` is: a
 * second answer to "what is inside this folder" would drift from the first with neither looking
 * wrong on its own. `CopyModule` is providers-only — importing `FilesModule` would drag four
 * controllers and the auth flow into a process with no requests.
 */
export { CopyModule } from './files/copy.module.js';

/**
 * §7's trash retention. The API stores the policy and re-seeds the schedule at boot; the worker
 * runs it. The walk is exported rather than reimplemented for the same reason the copy's is.
 */
export { TrashRetentionModule } from './files/trash-retention.module.js';

/**
 * §5.3's acceptance criterion: a file created over SMB has to reach web search. The API stores the
 * schedule and re-seeds it at boot; the worker runs the walk.
 */
export { IndexerModule } from './files/indexer.module.js';
export {
  RECONCILE_KIND,
  IndexerService,
  type ReconcilePayload,
  type ReconcileResult,
} from './files/indexer.service.js';
export {
  TRASH_PURGE_KIND,
  TrashRetentionService,
  type PurgeResult,
  type TrashImpact,
  type TrashPolicy,
} from './files/trash-retention.service.js';
export {
  COPY_KIND,
  COPY_MAX_ATTEMPTS,
  CopyService,
  CopyDestinationOccupiedError,
  CopyNameExhaustedError,
  CopyOutOfSpaceError,
  CopyTooLargeError,
  type CopyPayload,
  type CopyProgress,
  type CopyReport,
} from './files/copy.service.js';

/**
 * §6.2's POSIX side. `permissions.apply` is enqueued by the API and executed by the worker, and
 * the walk it needs — ADR-0021's inheritance rule over `file_entries` and `folder_grants` — lives
 * here because a copy in the worker would be a second implementation of the permission model.
 */
export { AclApplyModule } from './permissions/apply-acl.module.js';
export { AclApplyService, type ApplyAclPayload } from './permissions/apply-acl.service.js';
export {
  IDENTITY_SYNC_KIND,
  IDENTITY_SYNC_MAX_ATTEMPTS,
  IdentitySyncService,
} from './identity/identity-sync.service.js';
export { PosixIdentityModule } from './identity/posix.module.js';
export {
  APPLY_ACL_KIND,
  // The retry budget the kind needs, exported alongside it: the worker queues its own
  // continuations for a large share and a successor written with the queue's default of five
  // attempts would have a thirty-second life while its predecessor had an hour.
  APPLY_ACL_MAX_ATTEMPTS,
} from './permissions/permissions.service.js';

export { loadConfig, type AppConfig } from './config.js';

/**
 * The environment as an injectable value, and the worker needs it as a MODULE and not only as a
 * function. `DbModule`'s factory injects `APP_CONFIG`, so a process that imports `DbModule` without
 * this one cannot construct `DbService` at all — the worker could not boot, and `loadConfig` being
 * exported here made it look as though it could.
 */
export { ConfigModule, APP_CONFIG } from './config.module.js';
