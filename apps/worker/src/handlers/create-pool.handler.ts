import { Logger } from '@nestjs/common';
import { CREATE_POOL_KIND, expectStatus, type AgentService } from '@depsis/api/worker-surface';

import type { JobHandler } from '../worker.service.js';

/** What a `storage.pool.create` job carries. The password is deliberately not among the fields. */
export interface CreatePoolPayload {
  name: string;
  topology: 'single' | 'mirror' | 'raidz1' | 'raidz2';
  disks: { byId: string; wwn: string }[];
  requestedBy: string;
}

// Re-exported rather than declared. The route that enqueues these owns the string, and two
// declarations of one job kind is a queue whose producer and consumer can silently disagree.
export { CREATE_POOL_KIND };

/**
 * Create a ZFS pool through the privileged agent. THE ONE DESTRUCTIVE HANDLER.
 *
 * Every other job kind in this product is safe to run twice — that is why the queue's at-least-once
 * delivery is acceptable for them. This one is not, and it does not rely on being made so: the
 * route enqueues it with `maxAttempts: 1`, so a failure is reported rather than retried. A pool
 * that did not get created is something an operator asks for again, having looked at the box.
 *
 * The existence check below is therefore not a retry mechanism. It is for the one sequence the
 * single attempt does not cover: the agent created the pool and the answer never came back — a
 * killed worker, a closed socket — leaving a job that is about to be marked failed for a pool that
 * exists. Reporting that as a failure would send an operator to investigate a machine that is
 * fine, and the obvious next thing they would try is running it again.
 *
 * WHAT THIS HANDLER DOES NOT CHECK. Not whether the disks are blank, not whether they exist, not
 * whether one of them holds the running system. All three live in the agent, checked against an
 * inventory it reads for itself immediately before creating the pool — see `Request::CreatePool`.
 * A check here would be a check against a payload written minutes ago by a process that read a
 * screen, which is precisely the thing that cannot be trusted about a disk.
 */
export function createPoolHandler(agent: AgentService): JobHandler {
  const logger = new Logger('CreatePoolHandler');

  return async ({ job, report }) => {
    const payload = parse(job.payload);

    // Before the work, not after: if the lease is already gone another worker holds this job, and
    // `zpool create` is not a command to issue twice concurrently.
    if (!(await report(0.1))) return;

    const existing = await agent.call(
      { op: 'pool_status', pool: payload.name },
      `does the pool '${payload.name}' already exist, for job ${job.id}`,
      job.id,
    );
    if (existing.status === 'pool_status') {
      logger.log(`'${payload.name}' already exists; nothing to do for job ${job.id}`);
      await report(1);
      return;
    }

    logger.log(
      `creating ${payload.topology} pool '${payload.name}' from ` +
        `${payload.disks.map((disk) => disk.byId).join(', ')} for job ${job.id}`,
    );

    const response = await agent.call(
      {
        op: 'create_pool',
        pool: payload.name,
        topology: payload.topology,
        disks: payload.disks.map((disk) => ({ by_id: disk.byId, wwn: disk.wwn })),
      },
      // Reaches the agent's audit trail. §16 wants a privileged action explicable afterwards, and
      // for the one operation that erases disks the account that asked belongs in that sentence.
      `pool creation requested by ${payload.requestedBy}, job ${job.id}`,
      job.id,
    );

    // Throws AgentRefusedError on a refusal, which the worker records with the agent's own reason.
    // Those reasons are the ones an operator most needs verbatim here — "that disk is not the one
    // that was confirmed" is not a sentence to paraphrase.
    const created = expectStatus(response, 'pool_created');
    logger.log(`'${payload.name}' created: ${created.detail.trim() || 'no output'}`);
    await report(1);
  };
}

const TOPOLOGIES = ['single', 'mirror', 'raidz1', 'raidz2'] as const;

/**
 * The payload is validated rather than trusted.
 *
 * It reached the queue as jsonb and the queue does not interpret payloads — a row could have been
 * written by a fixture, by a migration, or by an older build that spelled a field differently. On
 * the one job kind that erases disks, "the field was missing so it read as undefined" must be a
 * thrown error and not a command line.
 */
function parse(payload: unknown): CreatePoolPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('create-pool payload is not an object');
  }
  const { name, topology, disks, requestedBy } = payload as Record<string, unknown>;

  if (typeof name !== 'string' || name === '') {
    throw new Error('create-pool payload has no pool name');
  }
  if (
    typeof topology !== 'string' ||
    !TOPOLOGIES.includes(topology as (typeof TOPOLOGIES)[number])
  ) {
    throw new Error(`create-pool payload has an unknown topology: ${String(topology)}`);
  }
  if (!Array.isArray(disks) || disks.length === 0) {
    throw new Error('create-pool payload names no disks');
  }

  const parsed = disks.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`create-pool payload disk ${index} is not an object`);
    }
    const { byId, wwn } = entry as Record<string, unknown>;
    if (typeof byId !== 'string' || byId === '') {
      throw new Error(`create-pool payload disk ${index} has no stable id`);
    }
    // A disk with no WWN cannot be checked against the box, and the check is the only thing that
    // survives somebody swapping a disk between the confirmation and this job running. Refusing
    // is the only safe reading of an absent one.
    if (typeof wwn !== 'string' || wwn === '') {
      throw new Error(`create-pool payload disk ${index} (${byId}) has no WWN to verify against`);
    }
    return { byId, wwn };
  });

  return {
    name,
    topology: topology as CreatePoolPayload['topology'],
    disks: parsed,
    requestedBy: typeof requestedBy === 'string' ? requestedBy : 'unknown',
  };
}
