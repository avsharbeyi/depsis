import { Logger } from '@nestjs/common';
import { expectStatus, type AgentService } from '@depsis/api/worker-surface';

import type { JobHandler } from '../worker.service.js';

/** What a `storage.snapshot` job carries. */
export interface SnapshotPayload {
  dataset: string;
  name: string;
}

export const SNAPSHOT_KIND = 'storage.snapshot';

/**
 * Take a ZFS snapshot through the privileged agent.
 *
 * The first real job kind, and it is a deliberate choice: snapshotting is genuinely long-running,
 * genuinely needs root, and is genuinely IDEMPOTENT-ADJACENT — `zfs snapshot` on a name that
 * already exists fails rather than making a second one, so the at-least-once delivery the queue
 * provides cannot produce two snapshots from one job. That property is why this one is safe to run
 * first; a handler without it needs its own argument (§17).
 *
 * The payload is validated here rather than trusted. It reached the queue as jsonb and the queue
 * does not interpret payloads — a job row could have been written by a migration, by a fixture, or
 * by an older version of the code that spelled a field differently.
 *
 * ŞU ANDA HİÇBİR ÜRÜN YOLU BU TÜRÜ KUYRUĞA ALMIYOR, ve bunu bilmeden okumak yanıltıcı. Anlık
 * görüntüler SENKRON alınıyor: `backup-schedules.service.ts`, `backup-run.service.ts` ve
 * `backups.service.ts` doğrudan `create_snapshot` çağırıyor, çünkü işlem saniyeler sürüyor ve
 * sonucunu isteyen ekran cevabı hemen bekliyor. Kayıtlı kalmasının sebebi, kuyruğa bir
 * `storage.snapshot` satırı düşürecek bir yol eklendiği gün onu alacak bir işleyicinin var
 * olması — kaydı olmayan bir tür, kimsenin almadığı ve hiçbir belirti vermeyen bir satırdır
 * (`permissions.apply` haftalarca öyle durmuştu).
 */
export function snapshotHandler(agent: AgentService): JobHandler {
  const logger = new Logger('SnapshotHandler');

  return async ({ job, report }) => {
    const payload = parse(job.payload);

    // Before the work, not after: if the lease is already gone another worker is doing this and
    // the agent should not be asked twice.
    if (!(await report(0.1))) return;

    logger.log(`snapshotting ${payload.dataset}@${payload.name} for job ${job.id}`);
    const response = await agent.call(
      { op: 'create_snapshot', dataset: payload.dataset, name: payload.name },
      // Reaches the agent's audit trail. §16 wants a privileged action to be explicable afterwards,
      // and "job <id>" is what ties it back to whoever asked for it.
      `snapshot for job ${job.id}`,
      job.id,
    );

    // Throws AgentRefusedError on a refusal, which the worker turns into a failed attempt with the
    // agent's own reason. A refusal is an ORDINARY answer on that wire, so a handler that only
    // looked for its own variant would treat it as a missing field.
    const created = expectStatus(response, 'snapshot');
    logger.log(`created ${created.full_name}`);
    await report(1);
  };
}

function parse(payload: unknown): SnapshotPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('snapshot payload is not an object');
  }
  const { dataset, name } = payload as Record<string, unknown>;
  if (typeof dataset !== 'string' || dataset === '') {
    throw new Error('snapshot payload is missing a dataset');
  }
  if (typeof name !== 'string' || name === '') {
    throw new Error('snapshot payload is missing a name');
  }
  // Nothing further: the agent owns what a valid dataset name and snapshot component are, and
  // re-implementing those rules here would be a second, weaker definition of the same thing —
  // which is the drift ADR-0006 puts the schema on the Rust side to prevent.
  return { dataset, name };
}
