import { Logger } from '@nestjs/common';
import { COPY_KIND, type CopyPayload, type CopyService } from '@depsis/api/worker-surface';

import type { JobHandler } from '../worker.service.js';

export { COPY_KIND };

/**
 * `POST /file-operations` — the copy.
 *
 * The walk itself is `CopyService`, in the API package, and it is not duplicated here for the same
 * reason `applyAclHandler` does not duplicate `AclApplyService`: the tree lives in `file_entries`
 * and the rules for reading it must have one implementation, or the API's answer to "what is in
 * this folder" and the worker's will drift apart with neither looking wrong on its own.
 *
 * ONE JOB FOR THE WHOLE OPERATION, and that is a correction. The first version queued a successor
 * per chunk, which meant the job id the user was handed — the FIRST one — went `succeeded` as soon
 * as its twenty-five entries were done, while the rest of the tree was still being copied by jobs
 * nobody could see. A copy that died in its ninth chunk was invisible to the person who asked for
 * it. The service loops instead and calls `report` between nodes, which is what extends the lease.
 *
 * IDEMPOTENT, which the at-least-once queue requires (§17): every row the copy writes carries
 * `copied_from_entry_id`, so a redelivery asks "is there already a copy of this source here" and
 * gets an exact answer. Asking by name cannot work — `keep_both` derives the name from what the
 * destination holds, which the first attempt is exactly what changed.
 */
export function copyHandler(copies: CopyService): JobHandler {
  const logger = new Logger('CopyHandler');

  return async ({ job, report }) => {
    // From the QUEUE ROW, never from the payload. Every tenant-scoped statement runs under
    // `withTenant`, and taking the tenant from a jsonb field a caller supplied would make the one
    // field that decides isolation the one field nobody checks.
    const organizationId = job.organizationId;
    if (organizationId === null) {
      throw new Error('a files.copy job must belong to an organisation');
    }
    const payload = parse(job.payload);

    const result = await copies.copy(organizationId, payload, report, `files.copy job ${job.id}`);

    logger.log(
      `copied ${result.copied}, skipped ${result.skipped}, refused ${result.refused} of ` +
        `${result.total} for job ${job.id}`,
    );
  };
}

function parse(payload: unknown): CopyPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('a files.copy payload must be an object');
  }
  const raw = payload as Record<string, unknown>;
  const shareId = raw['shareId'];
  const sourceIds = raw['sourceIds'];
  const actorId = raw['actorId'];
  const destinationId = raw['destinationId'] ?? null;

  if (typeof shareId !== 'string' || typeof actorId !== 'string') {
    throw new Error('a files.copy payload needs a shareId and an actorId');
  }
  if (!Array.isArray(sourceIds) || !sourceIds.every((id) => typeof id === 'string')) {
    throw new Error('a files.copy payload needs sourceIds');
  }
  if (destinationId !== null && typeof destinationId !== 'string') {
    throw new Error('destinationId must be a uuid or null');
  }

  return { shareId, sourceIds, destinationId, actorId };
}
