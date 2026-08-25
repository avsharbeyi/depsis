import { Logger } from '@nestjs/common';
import { RESTORE_KIND, type CopyService, type RestorePayload } from '@depsis/api/worker-surface';

import type { JobHandler } from '../worker.service.js';

export { RESTORE_KIND };

/**
 * `POST /shares/{id}/snapshots/{snapshot}/restore` — one file, brought back.
 *
 * A JOB rather than a request, for the same reason the copy is one: the agent's control socket is
 * served one connection at a time, so the bytes move in slices and a large file takes longer than
 * any HTTP request should hold. The user gets a job id and the interface follows it.
 *
 * The walk is `CopyService.restore`, in the API package, and it is not duplicated here — the same
 * rule `copyHandler` states: `file_entries` has one implementation or the API's answer and the
 * worker's drift apart with neither looking wrong alone.
 *
 * SAFE TO RUN TWICE, which the at-least-once queue requires (§17), and the guarantee comes from
 * the agent rather than from a marker column. The publish is `RENAME_NOREPLACE`, so a redelivery
 * that reaches the end finds the name taken and fails loudly instead of writing a second row for
 * one file. It cannot be idempotent the way the copy is — `copied_from_entry_id` needs a source
 * row, and a restored file's source is inside a snapshot, where there is no row and usually never
 * was one, because being deleted is the usual reason to restore something.
 */
export function restoreSnapshotHandler(copies: CopyService): JobHandler {
  const logger = new Logger('RestoreSnapshotHandler');

  return async ({ job }) => {
    // From the QUEUE ROW, never from the payload: the one field that decides isolation must not be
    // the one field nobody checks.
    const organizationId = job.organizationId;
    if (organizationId === null) {
      throw new Error('a files.restore-snapshot job must belong to an organisation');
    }
    const payload = parse(job.payload);

    const { bytes } = await copies.restore(
      organizationId,
      payload,
      `files.restore-snapshot job ${job.id}`,
    );

    logger.log(
      `restored ${payload.from.join('/')} from ${payload.snapshot} as ${payload.name} ` +
        `(${bytes} bytes) for job ${job.id}`,
    );
  };
}

function parse(payload: unknown): RestorePayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('a files.restore-snapshot payload must be an object');
  }
  const raw = payload as Record<string, unknown>;
  const shareId = raw['shareId'];
  const snapshot = raw['snapshot'];
  const from = raw['from'];
  const name = raw['name'];
  const actorId = raw['actorId'];
  const destinationId = raw['destinationId'] ?? null;

  if (
    typeof shareId !== 'string' ||
    typeof snapshot !== 'string' ||
    typeof name !== 'string' ||
    typeof actorId !== 'string'
  ) {
    throw new Error('a files.restore-snapshot payload needs a shareId, snapshot, name and actorId');
  }
  // Re-checked here and not only at enqueue: a payload is jsonb, and a row edited by hand or
  // written by a future version is the one input this process cannot see being validated.
  if (!Array.isArray(from) || from.length === 0 || from.some((part) => typeof part !== 'string')) {
    throw new Error('a files.restore-snapshot payload needs a non-empty from path');
  }
  if (destinationId !== null && typeof destinationId !== 'string') {
    throw new Error('a files.restore-snapshot destinationId must be a string or null');
  }

  return {
    shareId,
    snapshot,
    from: from as string[],
    destinationId,
    name,
    actorId,
  };
}
