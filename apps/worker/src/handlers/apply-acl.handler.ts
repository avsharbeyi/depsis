import { Logger } from '@nestjs/common';
import {
  APPLY_ACL_KIND,
  APPLY_ACL_MAX_ATTEMPTS,
  type AclApplyService,
  type JobsService,
} from '@depsis/api/worker-surface';

import type { JobHandler } from '../worker.service.js';

export { APPLY_ACL_KIND };

/**
 * Write §6.2's grants onto the filesystem, one `ApplyFolderAcl` per folder.
 *
 * THE JOB THIS REGISTERS EXISTED WITH NO CONSUMER. `PermissionsService.enqueueApply` has been
 * inserting `permissions.apply` rows since the grant endpoints were served, and `WorkerService`
 * only ever claims kinds that are registered here — so every one of them sat in `job_queue`
 * forever, `applyingJobId` named a job that would never run, and an interface obeying the contract
 * would show "izinler uygulanıyor" for good. Meanwhile the kernel knew nothing: a folder closed on
 * the web stayed open over SMB, which is the pair of realities ADR-0004 and §6.2 forbid by name.
 *
 * The walk itself is `AclApplyService`, in the API package. It is not duplicated here on purpose —
 * see `worker-surface.ts`: a second implementation of ADR-0021's inheritance rule would let the
 * ENFORCED answer and the APPLIED answer drift apart with neither side looking wrong on its own.
 *
 * IDEMPOTENT, which the at-least-once queue requires (§17): the service reads the grants as they
 * stand when it runs and writes an absolute ACL per folder, so a second delivery writes the same
 * thing and a delivery that arrives after a newer grant applies the newer answer.
 */
export function applyAclHandler(acl: AclApplyService, jobs: JobsService): JobHandler {
  const logger = new Logger('ApplyAclHandler');

  return async ({ job, report }) => {
    // The organisation comes from the QUEUE ROW and not from the payload. Every tenant-scoped
    // statement in the service runs under `withTenant`, and taking the tenant from a jsonb field a
    // caller supplied would make the one field that decides isolation the one field nobody checks.
    const organizationId = job.organizationId;
    if (organizationId === null) {
      throw new Error('a permissions.apply job must belong to an organisation');
    }
    const payload = parse(job.payload);

    // Before the work. If the lease is gone another worker is already rewriting these ACLs, and
    // two processes driving the agent through the same folders is wasted work at best.
    if (!(await report(0.1))) return;

    logger.log(
      `applying folder ACLs under ${payload.entryId ?? 'the share root'} of share ` +
        `${payload.shareId} for job ${job.id}`,
    );
    const { next } = await acl.apply(organizationId, payload, `permissions.apply job ${job.id}`);

    // A LARGE SHARE IS APPLIED ACROSS SEVERAL JOBS, and the successor is queued here rather than
    // looped inside the service. Two reasons, and the second is the one that matters:
    //
    //   * Each folder is one round trip to a daemon that serves the whole appliance one connection
    //     at a time. A single job walking a hundred thousand of them would hold the agent for
    //     hours and starve every upload behind it. Between chunks the worker returns to
    //     `claim_job`, so other work interleaves.
    //   * A chunk that fails is retried as a chunk. The cursor only advances past folders that
    //     were actually written, so a crash mid-share resumes where it stopped instead of starting
    //     over or, worse, skipping the remainder.
    //
    // Queued BEFORE `report(1)` so that a worker which dies between the two leaves the successor
    // on the queue: this job would then be retried in full, which is safe — every apply is
    // idempotent — while the reverse order could lose the remainder entirely.
    if (next !== null) {
      await jobs.enqueue(
        organizationId,
        APPLY_ACL_KIND,
        { shareId: payload.shareId, entryId: payload.entryId, after: next },
        { maxAttempts: APPLY_ACL_MAX_ATTEMPTS },
      );
      logger.log(`share ${payload.shareId} has more folders; queued a continuation after ${next}`);
    }

    await report(1);
  };
}

/**
 * The payload is validated rather than trusted: it reached the queue as jsonb, and the queue does
 * not interpret payloads — a row could have been written by a fixture or by an older build that
 * spelled a field differently.
 */
function parse(payload: unknown): {
  shareId: string;
  entryId: string | null;
  after: string | null;
} {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('permissions.apply payload is not an object');
  }
  const { shareId, entryId } = payload as Record<string, unknown>;
  if (typeof shareId !== 'string' || shareId === '') {
    throw new Error('permissions.apply payload is missing a shareId');
  }
  // `null` is not an omission here, it is the share root — the same convention
  // `folder_grants.entry_id` uses. `undefined` is read as the root too, because a payload written
  // by `JSON.stringify` drops an explicit undefined and the two must not mean different things.
  if (entryId !== undefined && entryId !== null && typeof entryId !== 'string') {
    throw new Error('permissions.apply payload has an entryId that is not an id');
  }
  // The resume cursor a previous chunk left. Absent and null both mean "start at the beginning",
  // for the reason `entryId` gives: `JSON.stringify` drops an explicit undefined, so the two
  // spellings reach the queue as one thing and must not mean different things coming back.
  const after = (payload as Record<string, unknown>)['after'];
  if (after !== undefined && after !== null && typeof after !== 'string') {
    throw new Error('permissions.apply payload has an `after` cursor that is not an id');
  }
  return { shareId, entryId: entryId ?? null, after: after ?? null };
}
