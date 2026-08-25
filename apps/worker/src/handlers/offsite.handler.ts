import { Logger } from '@nestjs/common';
import { AgentRefusedError, expectStatus, type AgentService } from '@depsis/api/worker-surface';

import type { JobHandler } from '../worker.service.js';

export const OFFSITE_KIND = 'storage.replicate-offsite';

/** The payload `POST /storage/offsite/replicate` enqueues. */
interface OffsitePayload {
  source?: unknown;
  snapshot?: unknown;
  base?: unknown;
  host?: unknown;
  port?: unknown;
  user?: unknown;
  target?: unknown;
}

/**
 * `zfs send` into a `zfs recv` on ANOTHER machine, over SSH.
 *
 * THE THIRD DESTRUCTIVE KIND, and the only one whose destruction happens somewhere else. The far
 * end runs `zfs recv -F`, so this is enqueued with `maxAttempts: 1` for the reason the local
 * replication is — a retry after an ambiguous failure destroys the target again without knowing
 * what state it reached — and one reason more: over a network, "ambiguous failure" is the ordinary
 * case rather than the rare one. A dropped link is precisely the error that leaves "how much
 * arrived" unanswered.
 *
 * NO PROGRESS BETWEEN 0 AND 1, and the honesty matters more than the bar. `zfs send` reports
 * progress only to its own stderr with `-v`, which the agent does not parse and this handler does
 * not see. A bar moving on a timer would be a picture of nothing — and over a slow uplink, where
 * this job may run for hours, a fake bar is the difference between somebody waiting and somebody
 * pulling the plug.
 *
 * THE AGENT'S REFUSALS REACH THE JOB VERBATIM, and three of them are the whole safety argument: no
 * identity, a host key that was never confirmed, and a host key that has CHANGED since it was.
 * The third is the one that must never be swallowed — it is either a reinstalled server or
 * somebody standing in the middle, and a generic "replication failed" would hide the difference.
 */
export function offsiteHandler(agent: AgentService): JobHandler {
  const logger = new Logger('OffsiteHandler');

  return async ({ job, report }) => {
    const organizationId = job.organizationId;
    if (organizationId === null) {
      throw new Error('a storage.replicate-offsite job must belong to an organisation');
    }

    const payload = (job.payload ?? {}) as OffsitePayload;
    const source = typeof payload.source === 'string' ? payload.source : null;
    const snapshot = typeof payload.snapshot === 'string' ? payload.snapshot : null;
    const host = typeof payload.host === 'string' ? payload.host : null;
    const user = typeof payload.user === 'string' ? payload.user : null;
    const target = typeof payload.target === 'string' ? payload.target : null;
    const base = typeof payload.base === 'string' ? payload.base : null;
    const port = typeof payload.port === 'number' ? payload.port : 22;

    if (source === null || snapshot === null || host === null || user === null || target === null) {
      // A malformed payload is this product's own bug, not the operator's, and it must not be
      // retried into the agent.
      throw new Error(
        'a storage.replicate-offsite job needs source, snapshot, host, user and target',
      );
    }

    if (!(await report(0.05))) return;

    const response = await agent.call(
      { op: 'replicate_offsite', source, snapshot, base, host, port, user, target },
      `replicating ${source}@${snapshot} onto ${user}@${host}:${target} for job ${job.id}`,
      job.id,
    );

    let done;
    try {
      done = expectStatus(response, 'replicated');
    } catch (error) {
      if (error instanceof AgentRefusedError) {
        // Verbatim. The agent is the only side that knows which fence was hit — and if the fence
        // was a changed host key, the operator is the only side that can decide whether that is a
        // reinstall or an interception.
        logger.warn(`off-site replication refused: ${error.agentReason}`);
      }
      throw error;
    }

    logger.log(
      `${source}@${snapshot} → ${user}@${host}:${target}` +
        `${done.base === null || done.base === undefined ? ' (full)' : ` (from ${done.base})`}`,
    );
    await report(1);
  };
}
