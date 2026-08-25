import { Logger } from '@nestjs/common';
import { AgentRefusedError, expectStatus, type AgentService } from '@depsis/api/worker-surface';

import type { JobHandler } from '../worker.service.js';

export const REPLICATE_KIND = 'storage.replicate';

/** The payload `POST /storage/replication` enqueues. */
interface ReplicatePayload {
  source?: unknown;
  snapshot?: unknown;
  target?: unknown;
  base?: unknown;
}

/**
 * `zfs send | zfs recv` onto a second dataset on this appliance.
 *
 * THE ONE OTHER DESTRUCTIVE KIND, beside `storage.pool.create`. `zfs recv -F` destroys whatever is
 * at the target, so this is enqueued with `maxAttempts: 1` by the route that creates it — every
 * other kind in the registry is safe to run twice, and a retry here after an ambiguous failure
 * means destroying the target again without knowing what state it reached.
 *
 * NO PROGRESS BETWEEN 0 AND 1, and the honesty matters more than the bar. `zfs send` reports
 * progress only to its own stderr with `-v`, which the agent does not parse and this handler does
 * not see; a bar that moved on a timer would be a picture of nothing. What the reader gets instead
 * is a job that says "running" for as long as the transfer takes and then says exactly what `zfs
 * recv` printed.
 *
 * THE AGENT'S REFUSALS REACH THE JOB VERBATIM. Four of them are the fence in front of the
 * destructive part — same dataset, nested, the share root, inside the share tree — and one is the
 * drifted target that needs a full send. All five are things the operator can act on, and burying
 * them in a generic failure would leave a job that says only that it did not work.
 */
export function replicateHandler(agent: AgentService): JobHandler {
  const logger = new Logger('ReplicateHandler');

  return async ({ job, report }) => {
    const organizationId = job.organizationId;
    if (organizationId === null) {
      throw new Error('a storage.replicate job must belong to an organisation');
    }

    const payload = (job.payload ?? {}) as ReplicatePayload;
    const source = typeof payload.source === 'string' ? payload.source : null;
    const snapshot = typeof payload.snapshot === 'string' ? payload.snapshot : null;
    const target = typeof payload.target === 'string' ? payload.target : null;
    const base = typeof payload.base === 'string' ? payload.base : null;
    if (source === null || snapshot === null || target === null) {
      // A malformed payload is this product's own bug, not the operator's, and it must not be
      // retried into the agent.
      throw new Error('a storage.replicate job needs source, snapshot and target');
    }

    if (!(await report(0.05))) return;

    const response = await agent.call(
      { op: 'replicate_dataset', source, snapshot, target, base },
      `replicating ${source}@${snapshot} onto ${target} for job ${job.id}`,
      job.id,
    );

    let done;
    try {
      done = expectStatus(response, 'replicated');
    } catch (error) {
      if (error instanceof AgentRefusedError) {
        // Verbatim. The agent is the only side that knows which fence was hit, and the operator is
        // the only side that can do anything about it.
        logger.warn(`replication refused: ${error.agentReason}`);
      }
      throw error;
    }

    logger.log(
      `${source}@${snapshot} → ${target}` +
        `${done.base === null || done.base === undefined ? ' (full)' : ` (from ${done.base})`}`,
    );
    await report(1);
  };
}
