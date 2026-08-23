import { Logger } from '@nestjs/common';
import { IDENTITY_SYNC_KIND, type IdentitySyncService } from '@depsis/api/worker-surface';

import type { JobHandler } from '../worker.service.js';

export { IDENTITY_SYNC_KIND };

/**
 * Make the machine's Unix accounts and groups match the tenant's principals.
 *
 * THE LAST LINK, and it runs here rather than in the request for the reason every other privileged
 * effect does: it talks to the agent, which serialises one connection for the whole appliance, and
 * a user creation should not wait on it. More importantly it must SURVIVE the agent being down —
 * an account that never got created is a person who cannot reach the NAS, and the queue is what
 * retries.
 *
 * IDEMPOTENT, which the at-least-once queue requires (§17): the service reads the whole desired
 * state when it runs and the agent replaces group membership wholesale, so a second delivery writes
 * the same thing and a delivery that arrives after a newer change applies the newer answer.
 *
 * The payload is EMPTY on purpose. Naming individual users would make the job a delta, and a delta
 * cannot express a removal — a member who left a team has to actually leave the Unix group, or
 * their ACL access outlives the grant that justified it.
 */
export function identitySyncHandler(identity: IdentitySyncService): JobHandler {
  const logger = new Logger('IdentitySyncHandler');

  return async ({ job, report }) => {
    // From the QUEUE ROW and never the payload: every tenant-scoped statement in the service runs
    // under `withTenant`, and taking the tenant from a jsonb field a caller supplied would make the
    // one field that decides isolation the one field nobody checks.
    const organizationId = job.organizationId;
    if (organizationId === null) {
      throw new Error('an identity.sync job must belong to an organisation');
    }

    // Before the work. If the lease is gone another worker is already driving the agent through the
    // same `useradd` calls, and two processes doing that is wasted work at best.
    if (!(await report(0.1))) return;

    logger.log(`syncing POSIX identity for organisation ${organizationId} (job ${job.id})`);
    await identity.sync(organizationId, `identity.sync job ${job.id}`);
    await report(1);
  };
}
