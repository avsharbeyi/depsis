import { Logger } from '@nestjs/common';
// The service as a VALUE, not only a type: `INTERVAL_MS` lives on it, and a second spelling of
// the interval here is a second number to get wrong.
import { TRASH_PURGE_KIND, TrashRetentionService } from '@depsis/api/worker-surface';

import type { JobHandler } from '../worker.service.js';

export { TRASH_PURGE_KIND };

/**
 * The bin's expiry, enforced.
 *
 * A SELF-SCHEDULING JOB, which is how this product gets a durable timer without owning one. A
 * `setInterval` runs only while its process is up and is gone after a restart; `job_queue.run_after`
 * survives both. Each run schedules the next before it returns, and the API re-seeds one at boot,
 * so either path can recover the chain and neither can produce two.
 *
 * THE SUCCESSOR IS QUEUED BEFORE THE JOB REPORTS ITSELF DONE. A crash between the two leaves a
 * duplicate run, which is harmless — the purge is idempotent, a row already gone is simply not in
 * the next batch. The other order leaves a policy that silently stops enforcing itself, which
 * nothing would ever report.
 *
 * WHAT IT DID IS RECORDED ON THE JOB. `finish_job` copies the row into `job_history` with `(j).*`,
 * so a summary written into the payload lands where an alarm can find it (ADR-0003). Under
 * automation nobody reads a log line at three in the morning.
 */
export function trashPurgeHandler(retention: TrashRetentionService): JobHandler {
  const logger = new Logger('TrashPurgeHandler');

  return async ({ job, report }) => {
    const organizationId = job.organizationId;
    if (organizationId === null) {
      throw new Error('a files.trash.purge job must belong to an organisation');
    }

    const result = await retention.purgeExpired(organizationId, report);
    await retention.recordResult(organizationId, job.id, {
      purged: result.purged,
      failed: result.failed,
      bytes: result.bytes,
    });

    if (result.purged > 0 || result.failed > 0) {
      logger.log(
        `purged ${result.purged} expired entries (${result.bytes} bytes), ${result.failed} failed`,
      );
    }

    // Immediately when the batch was full — there is more waiting and an hour of delay would let a
    // large bin drain over days. Otherwise at the next interval.
    const next = result.more
      ? new Date()
      : new Date(Date.now() + TrashRetentionService.INTERVAL_MS);
    await retention.schedule(organizationId, next);
    await report(1);
  };
}
