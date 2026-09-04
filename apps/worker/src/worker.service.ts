import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { ClaimedJob, JobsService } from '@depsis/api/worker-surface';

/**
 * What a handler is given, and what it may do while running.
 *
 * `report` is not decoration. A job that runs longer than its lease and never calls it will have
 * its lease expire and be reclaimed by another worker WHILE STILL RUNNING here — the queue is
 * at-least-once, so that is survivable, but it means the same work happens twice for no reason.
 * `report` returning false is the signal that it already happened: this worker no longer owns the
 * job and should stop.
 */
export interface JobContext {
  job: ClaimedJob;
  /** Extend the lease and optionally record progress. False means the job was taken away. */
  report: (progress?: number) => Promise<boolean>;
  /** Flipped when the process is shutting down. A long handler should check it and give up. */
  readonly stopping: () => boolean;
}

export type JobHandler = (context: JobContext) => Promise<void>;

export interface WorkerOptions {
  /** How long a claim lasts before another worker may take it. */
  leaseSeconds?: number;
  /** How often the loop asks for work when the last request found none. */
  idleMs?: number;
  /** How often a running job's lease is extended, as a fraction of the lease. */
  heartbeatFraction?: number;
}

/**
 * The process that consumes the queue.
 *
 * Deliberately NOT part of the API. A background loop inside the HTTP process competes with request
 * handling for the same event loop and the same connection pool, and a job that pins the CPU turns
 * into request latency with no obvious cause. Separating them also means the two can be restarted,
 * scaled and hardened independently — the worker's systemd unit needs nothing the API's does.
 *
 * ADR-0003 asks for LISTEN/NOTIFY with polling as a fallback. This polls only, and that is a
 * decision rather than an omission: LISTEN needs a dedicated long-lived connection, and ADR-0015's
 * chokepoint deliberately refuses to hand out a client — `DbService` has no getter, and adding one
 * to save a second of latency would open the exact hole the chokepoint exists to close. Waking
 * sooner is worth less than that. If it becomes worth it, the honest form is a separate, explicitly
 * justified connection, not a widening of the pool's interface.
 */
@Injectable()
export class WorkerService implements OnApplicationShutdown {
  private readonly logger = new Logger(WorkerService.name);
  private readonly handlers = new Map<string, JobHandler>();

  private running = false;
  private stopRequested = false;
  private loop: Promise<void> = Promise.resolve();

  private readonly leaseSeconds: number;
  private readonly idleMs: number;
  private readonly heartbeatMs: number;

  /** Counts, for the tests and for a log line that says the loop is alive. */
  private processed = 0;

  constructor(
    private readonly jobs: JobsService,
    options: WorkerOptions = {},
  ) {
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.idleMs = options.idleMs ?? 1_000;
    // Well inside the lease, so one missed beat is not a lost job. At a third, two consecutive
    // failures still leave time for a third attempt before the lease runs out.
    this.heartbeatMs = Math.max(
      100,
      Math.floor(this.leaseSeconds * 1000 * (options.heartbeatFraction ?? 1 / 3)),
    );
  }

  register(kind: string, handler: JobHandler): void {
    if (this.handlers.has(kind)) {
      // A silently replaced handler is a job running code nobody expects.
      throw new Error(`a handler for '${kind}' is already registered`);
    }
    this.handlers.set(kind, handler);
  }

  get kinds(): string[] {
    return [...this.handlers.keys()];
  }

  get processedCount(): number {
    return this.processed;
  }

  start(): void {
    if (this.running) return;
    if (this.handlers.size === 0) {
      // A worker that claims nothing looks identical to a healthy idle one.
      this.logger.warn('no handlers are registered; this worker will do nothing');
    }
    this.running = true;
    this.stopRequested = false;
    this.logger.log(
      `worker ${this.jobs.workerId} started for: ${this.kinds.join(', ') || '(none)'}`,
    );
    this.loop = this.run();
  }

  /**
   * Stop claiming, and wait for the job in hand.
   *
   * Abandoning it would work — the lease expires and somebody picks it up — but it wastes whatever
   * was already done and delays the result by a whole lease. Finishing is worth the wait, and the
   * handler is told to stop via `stopping()` so a long one can bail out early and be retried.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopRequested = true;
    await this.loop;
    this.running = false;
    this.logger.log(`worker ${this.jobs.workerId} stopped after ${this.processed} job(s)`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  private async run(): Promise<void> {
    while (!this.stopRequested) {
      let claimed: ClaimedJob | null;
      try {
        claimed = await this.jobs.claim(this.kinds, this.leaseSeconds);
      } catch (error) {
        // A database hiccup must not kill the loop: the worker is a long-lived process and the
        // supervisor restarting it is a blunter instrument than waiting a second.
        this.logger.error(`could not claim a job: ${describe(error)}`);
        await sleep(this.idleMs);
        continue;
      }

      if (claimed === null) {
        await sleep(this.idleMs);
        continue;
      }

      // `execute` kendi hatalarını yutuyor — TEK BİR TANESİ hariç: sonucu yazan `finish` çağrısı
      // catch bloğunun İÇİNDE, yani oradan gelen bir veritabanı hatasının gidecek yeri yok. Sahada
      // görüleni buydu: ardılını çoktan kuyruğa almış bir zincir işi düşünce `finish_job`ın
      // yeniden deneme yolu 23505 veriyor, reddetme buraya kadar çıkıyor, ve `this.loop` hiçbir
      // yerde beklenmediği için süreç yakalanmamış bir reddetmeyle ölüyordu.
      //
      // Bu try/catch bir yara bandı değil, döngünün sözleşmesi: TEK BİR SATIR kuyruğun tamamını
      // durduramamalı. İşin kendisi kaybolmuyor — kirası dolunca yeniden alınabilir hâle geliyor.
      const job = claimed;
      try {
        await this.execute(job);
      } catch (error) {
        this.logger.error(`job ${job.id} (${job.kind}) could not be completed: ${describe(error)}`);
      }
    }
  }

  private async execute(job: ClaimedJob): Promise<void> {
    const handler = this.handlers.get(job.kind);
    if (handler === undefined) {
      // Only reachable if the registry changed after the claim. Failing it is better than holding
      // a lease on work this process cannot do.
      await this.jobs.finish(job.id, 'failed', `no handler for '${job.kind}'`);
      return;
    }

    let held = true;
    const beat = setInterval(() => {
      void this.jobs
        .heartbeat(job.id, this.leaseSeconds)
        .then((ok) => {
          if (!ok) {
            held = false;
            this.logger.warn(`lost the lease on job ${job.id}; another worker has it`);
          }
        })
        .catch((error: unknown) => {
          // Not fatal on its own: the next beat may succeed, and the lease has not expired yet.
          this.logger.warn(`heartbeat for ${job.id} failed: ${describe(error)}`);
        });
    }, this.heartbeatMs);

    try {
      await handler({
        job,
        report: async (progress) => {
          const ok = await this.jobs.heartbeat(job.id, this.leaseSeconds, progress);
          if (!ok) held = false;
          return ok;
        },
        stopping: () => this.stopRequested,
      });
      if (held) await this.jobs.finish(job.id, 'succeeded');
    } catch (error) {
      // The message is the handler's, and §16 applies to it: this string is written to durable
      // storage, so a handler must not put a secret in the error it throws.
      //
      // AYRICA KENDİ TRY'INDA. Bu çağrı zaten bir catch bloğunun içinde, yani buradan fırlayan bir
      // hatanın yakalanacağı yer yok — ve `finish_job` gerçekten fırlatabiliyor: ardılını çoktan
      // kuyruğa almış bir zincir işinin yeniden denenmesi kısmi tekil indekse çarpıyor. Sonucu
      // yazamamak işi KAYBETTİRMİYOR (kira dolunca satır yeniden alınabilir), ama buradan
      // fırlatmak işçinin tamamını düşürürdü.
      let ending = ' — and the lease was already lost';
      if (held) {
        try {
          const outcome = await this.jobs.finish(job.id, 'failed', describe(error));
          ending = outcome === null ? ' — and the lease was already lost' : ` → ${outcome}`;
        } catch (finishError) {
          ending = ` — and the outcome could not be recorded: ${describe(finishError)}`;
        }
      }
      this.logger.warn(
        `job ${job.id} (${job.kind}) failed on attempt ${job.attempt}/${job.maxAttempts}: ` +
          `${describe(error)}${ending}`,
      );
    } finally {
      clearInterval(beat);
      this.processed += 1;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
