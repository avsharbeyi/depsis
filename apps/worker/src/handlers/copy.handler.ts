import { Logger } from '@nestjs/common';
import {
  COPY_KIND,
  COPY_MAX_ATTEMPTS,
  type CopyPayload,
  type CopyService,
  type JobsService,
} from '@depsis/api/worker-surface';

import type { JobHandler } from '../worker.service.js';

export { COPY_KIND };

/**
 * `POST /file-operations` — the copy, done a chunk at a time.
 *
 * The walk itself is `CopyService`, in the API package, and it is not duplicated here for the same
 * reason `applyAclHandler` does not duplicate `AclApplyService`: the tree lives in `file_entries`
 * and the rules for reading it must have one implementation, or the API's answer to "what is in
 * this folder" and the worker's will drift apart with neither looking wrong on its own.
 *
 * IDEMPOTENT, which the at-least-once queue requires (§17). A redelivered chunk re-attempts files
 * it already copied; the agent refuses to overwrite, and the service treats that refusal as "done"
 * after checking a row exists — which is also how it recovers a file that reached the filesystem
 * and not the database because a worker died between the two.
 */
export function copyHandler(copies: CopyService, jobs: JobsService): JobHandler {
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

    // Before the work. A lost lease means another worker already has this chunk, and two workers
    // copying the same tree would race on `keep_both` names and produce duplicates.
    if (!(await report(0.05))) return;

    const result = await copies.copy(organizationId, payload, `files.copy job ${job.id}`);
    const done = (payload.doneIds?.length ?? 0) + result.copied + result.skipped;

    logger.log(
      `copied ${result.copied} and skipped ${result.skipped} of ${result.total} for job ${job.id}`,
    );

    if (result.next === null) {
      await report(1);
      return;
    }

    // The successor is queued BEFORE this job reports itself finished, exactly as
    // `applyAclHandler` does: a crash between the two would otherwise leave a tree half-copied
    // with nothing left to continue it. The cost of the other order is a duplicate chunk, which
    // the service is built to absorb; the cost of this one is a copy that silently stops.
    await jobs.enqueue(
      organizationId,
      COPY_KIND,
      result.next as unknown as Record<string, unknown>,
      {
        maxAttempts: COPY_MAX_ATTEMPTS,
      },
    );
    // Progress across the whole operation rather than within the chunk, because the whole
    // operation is what the person is watching.
    await report(Math.min(0.99, result.total === 0 ? 1 : done / result.total));
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
  const doneIds = raw['doneIds'];

  if (typeof shareId !== 'string' || typeof actorId !== 'string') {
    throw new Error('a files.copy payload needs a shareId and an actorId');
  }
  if (!Array.isArray(sourceIds) || !sourceIds.every((id) => typeof id === 'string')) {
    throw new Error('a files.copy payload needs sourceIds');
  }
  if (destinationId !== null && typeof destinationId !== 'string') {
    throw new Error('destinationId must be a uuid or null');
  }

  return {
    shareId,
    sourceIds,
    destinationId,
    actorId,
    ...(Array.isArray(doneIds) && doneIds.every((id) => typeof id === 'string') ? { doneIds } : {}),
  };
}
