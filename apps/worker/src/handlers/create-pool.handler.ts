import { Logger } from '@nestjs/common';
import {
  AgentUnavailableError,
  CREATE_POOL_KIND,
  expectStatus,
  type AgentService,
} from '@depsis/api/worker-surface';

import type { JobHandler } from '../worker.service.js';

/** What a `storage.pool.create` job carries. The password is deliberately not among the fields. */
export interface CreatePoolPayload {
  name: string;
  topology: 'single' | 'mirror' | 'raidz1' | 'raidz2';
  disks: { byId: string; wwn: string }[];
  /** Also create `<pool>/depsis` and mount it where shares are served from. */
  prepareShareRoot: boolean;
  requestedBy: string;
}

// Re-exported rather than declared. The route that enqueues these owns the string, and two
// declarations of one job kind is a queue whose producer and consumer can silently disagree.
export { CREATE_POOL_KIND };

/**
 * Create a ZFS pool through the privileged agent. THE ONE DESTRUCTIVE HANDLER.
 *
 * `maxAttempts: 1` MEANS THIS RUNS ONCE, and it did not always. Bu yorum bir zamanlar tersini
 * söylüyordu — "kirası dolan RUNNING bir işi `claim_job` `max_attempts`e bakmadan geri alır" — ve
 * o cümle 0018'den beri yanlış. `claim_job` artık İLK İŞ olarak, kirası dolmuş ve bütçesi tükenmiş
 * (`attempt >= max_attempts`) satırları `job_history`'ye `dead` olarak taşıyor; ikinci kapı olarak
 * da seçim yükleminde `attempt < max_attempts` var. `maxAttempts: 1` ile ilk claim `attempt`i 1
 * yapıyor, yani bu işleyici bir iş için İKİNCİ KEZ hiç çağrılmıyor.
 *
 * BUNUN BEDELİ, ve burada kapatılamıyor: `zpool create` başarılıyken ölen bir işçinin işi
 * "işçi durdu" diyen bir `dead` satırına dönüşüyor. Diskler silinmiş, havuz kurulmuş, ve sihirbaz
 * kurulamadığını söylüyor. Sahibin oradan çıkış yolu Depolama ekranında havuzu görmek; işleyicinin
 * yapabileceği bir şey yok, çünkü o satır bir daha hiç alınmıyor. Kuyruğu iki denemeye açmak bunu
 * ÇÖZMEZ, kötüleştirir: TEMİZ bildirilmiş bir başarısızlıktan sonra ikinci deneme `zpool create`i
 * tekrar eder ve aşağıdaki varlık kontrolü yalnız havuz gerçekten kurulduysa koruyor.
 *
 * The existence check below is therefore the thing that stops a second `zpool create`, not a
 * courtesy. Bulduğu havuz HER ZAMAN bu işten önce vardı: tek deneme olduğu için "önceki deneme
 * kurdu ve cevabı kayboldu" hâli buraya değil, aşağıdaki `AgentUnavailableError` dalına düşüyor —
 * o dal aynı denemenin içinde, cevabı kaybolan çağrının hemen ardından soruyor. Rotanın 409
 * kontrolü bunu yakalamalıydı ve yakalayamadı, büyük olasılıkla o an ajan ulaşılamaz olduğu ve
 * `exists()` hatayı yuttuğu için. Burada başarı bildirmek, sahibe hiç dokunulmamış disklerinin
 * kullanıldığını söylemek olurdu.
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

    if (await exists(agent, payload.name, job.id)) {
      // Not ours. See the note on this handler: this kind is enqueued with `maxAttempts: 1`, so
      // there is no earlier attempt of THIS job that could have created it — a pool that is
      // already there existed before the job ran, and calling that a success would tell the
      // operator their disks had been used.
      //
      // If this kind is ever given a second attempt, the "a previous attempt created it and lost
      // the answer" case comes back and has to be told apart from this one again.
      throw new Error(
        `a pool called '${payload.name}' already exists on this machine and was not created by ` +
          `this job; nothing was done to the disks named`,
      );
    }

    logger.log(
      `creating ${payload.topology} pool '${payload.name}' from ` +
        `${payload.disks.map((disk) => disk.byId).join(', ')} for job ${job.id}`,
    );

    let response;
    try {
      response = await agent.call(
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
    } catch (error) {
      // THE ANSWER WAS LOST, WHICH IS NOT THE SAME AS THE WORK NOT HAPPENING. The agent call has a
      // sixty-second budget covering the queue wait as well as the exchange, and `zpool create`
      // against a slow controller can outrun it. Reporting a failure without looking would tell
      // the operator nothing happened to disks that are already gone.
      if (!(error instanceof AgentUnavailableError)) throw error;
      if (await exists(agent, payload.name, job.id)) {
        logger.warn(
          `the agent did not answer in time for job ${job.id}, but '${payload.name}' now exists: ` +
            `the pool was created and the answer was lost`,
        );
        await report(1);
        return;
      }
      throw error;
    }

    // Throws AgentRefusedError on a refusal, which the worker records with the agent's own reason.
    // Those reasons are the ones an operator most needs verbatim here — "that disk is not the one
    // that was confirmed" is not a sentence to paraphrase.
    const created = expectStatus(response, 'pool_created');
    logger.log(`'${payload.name}' created: ${created.detail.trim() || 'no output'}`);

    // The second half, and the reason it is in the same job: without it the operator finishes the
    // wizard, has a pool, and still cannot create a share. Two separate actions for one intent is
    // how the second one gets forgotten.
    //
    // AFTER the pool and never instead of it. A failure here leaves a perfectly good pool behind
    // and is reported as its own sentence — the disks are not at risk either way, and telling the
    // operator the pool failed when it did not would send them to look at the wrong thing.
    if (payload.prepareShareRoot) {
      const prepared = await agent.call(
        { op: 'prepare_share_root', pool: payload.name },
        `prepare the share tree on '${payload.name}' for job ${job.id}`,
        job.id,
      );
      // A refusal here is ordinary and specific — a dataset already mounted there, or a directory
      // with files in it — so it reaches the operator with the agent's own words.
      const root = expectStatus(prepared, 'share_root_prepared');
      logger.log(`share tree prepared at ${root.dataset}`);
    }

    await report(1);
  };
}

/**
 * Does a pool by this name exist right now?
 *
 * A refused `pool_status` is "no such pool", which is what ZFS says about a name it does not know.
 * A transport failure PROPAGATES rather than reading as absent: this predicate is used to decide
 * whether a `zpool create` may run and whether a lost answer meant success, and "we could not ask"
 * must not answer either question.
 */
async function exists(agent: AgentService, name: string, jobId: string): Promise<boolean> {
  const response = await agent.call(
    { op: 'pool_status', pool: name },
    `does the pool '${name}' already exist, for job ${jobId}`,
    jobId,
  );
  return response.status === 'pool_status';
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
    // Absent reads as FALSE. An older row, or one written by a fixture, must not acquire a step
    // that mounts a filesystem because a field it never had defaulted the other way.
    prepareShareRoot: (payload as Record<string, unknown>)['prepareShareRoot'] === true,
    requestedBy: typeof requestedBy === 'string' ? requestedBy : 'unknown',
  };
}
