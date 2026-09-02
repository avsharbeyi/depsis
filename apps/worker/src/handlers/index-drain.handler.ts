import { Logger } from '@nestjs/common';
import { INDEX_DRAIN_KIND, IndexerService } from '@depsis/api/worker-surface';

import type { JobHandler } from '../worker.service.js';

export { INDEX_DRAIN_KIND };

/**
 * Take what Samba said and act on it — ADR-0011 Layer 1's consumer.
 *
 * The fifteen-minute walk (`files.reconcile`) is the layer that makes the index TRUE. This is the
 * layer that makes it FAST: the audit reader records which directory a client changed, and this
 * re-reads exactly that directory.
 *
 * ONE DIRECTORY PER ENTRY, and the entry is deleted only AFTER it has been reconciled. The other
 * order loses the event when a pass dies part-way, and the walk would be the only thing that ever
 * noticed — which is precisely the latency this layer exists to remove.
 *
 * A FAILING DIRECTORY DOES NOT BLOCK THE QUEUE. One path the agent refuses — a share that went
 * away, a name that is no longer a directory — is logged, left on the queue, and skipped; the rest
 * of the batch runs. Its row keeps its place and the next pass tries again, and if it never
 * succeeds the walk still covers it.
 */
export function indexDrainHandler(indexer: IndexerService): JobHandler {
  const logger = new Logger('IndexDrainHandler');

  return async ({ job, report }) => {
    const organizationId = job.organizationId;
    if (organizationId === null) {
      throw new Error('a files.index-drain job must belong to an organisation');
    }

    // ARDIL ÖNCE — `reconcile.handler`daki gerekçenin aynısı. Hızlı yolun zinciri koptuğunda
    // belirtisi daha da sinsi: kuyruk dolmaya devam ediyor, kimse okumuyor, ve dosyalar yalnız
    // on beş dakikalık yürüyüşle geliyor. O yürüyüşün zinciri de koptuysa hiç gelmiyorlar.
    await indexer.scheduleDrain(
      organizationId,
      new Date(Date.now() + IndexerService.DRAIN_INTERVAL_MS),
    );

    const batch = await indexer.queued(organizationId, IndexerService.DRAIN_BATCH);
    let discovered = 0;
    let removed = 0;
    let failed = 0;

    for (const [index, entry] of batch.entries()) {
      if (!(await report(index / Math.max(1, batch.length)))) {
        logger.warn('lost the lease part-way through an index drain; stopping');
        break;
      }
      // BEFORE the work. An event that arrives while this directory is being read must not be
      // thrown away by the delete below, and the only way to tell is the timestamp it had when
      // this pass picked it up.
      const startedAt = new Date();

      try {
        const result = await indexer.reconcileOne(
          organizationId,
          entry.shareId,
          entry.path === '' ? [] : entry.path.split('/'),
          `smb audit: ${entry.actor ?? 'unknown'} changed ${entry.path || '/'}`,
        );
        discovered += result.discovered;
        removed += result.removed;
        await indexer.dequeue(organizationId, entry.shareId, entry.path, startedAt);
      } catch (error) {
        failed += 1;
        logger.warn(
          `could not index '${entry.path}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (discovered > 0 || removed > 0) {
      logger.log(`smb audit: ${discovered} discovered, ${removed} removed in ${batch.length} dirs`);
    }

    // Straight back when the batch was full — there is more waiting, and this is the fast path.
    // Otherwise at the poll interval, which is short because an empty queue costs one query.
    // Kuyrukta iş kaldıysa sıradaki tur hemen; yukarıdaki ardıl bekleme süresine bakıyor.
    if (batch.length >= IndexerService.DRAIN_BATCH) {
      await indexer.hurryUpDrain(organizationId);
    }
    await report(1);

    if (failed > 0) {
      // Not thrown: the batch mostly worked, and failing the job would retry the whole thing
      // including the parts that succeeded. The count is the signal.
      logger.warn(`${failed} of ${batch.length} directories could not be indexed this pass`);
    }
  };
}
