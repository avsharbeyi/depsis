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

export { loadConfig, type AppConfig } from './config.js';
