import { Logger } from '@nestjs/common';
import { IndexerService, RECONCILE_KIND } from '@depsis/api/worker-surface';

import type { JobHandler } from '../worker.service.js';

export { RECONCILE_KIND };

/**
 * Make `file_entries` agree with the disk.
 *
 * §5.3 and §18.2: "a file created over SMB enters web search within the stated SLA". Nothing did
 * that — `file_entries` only learned about a file DEPSIS itself created — so on the appliance's
 * main use, writing from Windows, the web interface showed an empty folder.
 *
 * ADR-0011 puts Samba's `vfs_full_audit` in front of this as the fast path. This is the layer
 * underneath, and it is built first on purpose: every other layer degrades to it — a missed audit
 * line, a queue overflow, a write that never went through Samba — so a product with only this is
 * late, while a product with only the others is silently wrong.
 *
 * SELF-SCHEDULING, like the trash purge, and for the same reason: `job_queue.run_after` is the only
 * durable timer this product has. A pass that ran out of batch comes straight back; otherwise the
 * next one is at the interval.
 */
export function reconcileHandler(indexer: IndexerService): JobHandler {
  const logger = new Logger('ReconcileHandler');

  return async ({ job, report }) => {
    const organizationId = job.organizationId;
    if (organizationId === null) {
      throw new Error('a files.reconcile job must belong to an organisation');
    }
    const shareId = parseShareId(job.payload);

    const result = await indexer.reconcile(
      organizationId,
      shareId,
      report,
      `files.reconcile job ${job.id}`,
    );
    await indexer.recordResult(organizationId, job.id, {
      discovered: result.discovered,
      updated: result.updated,
      removed: result.removed,
      truncated: result.truncated,
      scanned: result.scanned,
    });

    if (result.discovered > 0 || result.removed > 0 || result.updated > 0) {
      logger.log(
        `share ${shareId}: ${result.discovered} discovered, ${result.updated} updated, ` +
          `${result.removed} removed across ${result.scanned} folders`,
      );
    }
    if (result.truncated > 0) {
      // Said out loud rather than counted silently. A clipped listing means nothing under that
      // folder was removed on the strength of it, so the index is INCOMPLETE there and stays so
      // until the folder shrinks — which an operator can only act on if somebody says it.
      logger.warn(
        `${result.truncated} folder(s) held more entries than one listing can carry; their ` +
          `contents were left untouched`,
      );
    }

    const next = result.more ? new Date() : new Date(Date.now() + IndexerService.INTERVAL_MS);
    await indexer.schedule(organizationId, shareId, next);
    await report(1);
  };
}

function parseShareId(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('a files.reconcile payload must be an object');
  }
  const shareId = (payload as Record<string, unknown>)['shareId'];
  if (typeof shareId !== 'string') {
    throw new Error('a files.reconcile payload needs a shareId');
  }
  return shareId;
}
