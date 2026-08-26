import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service.js';
import { AgentService } from '../agent/agent.service.js';
import { requireSameOrigin } from '../auth/origin.js';
import { ReauthService } from '../auth/reauth.service.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { JobsService } from '../jobs/jobs.service.js';
import { SystemService } from './system.service.js';

type Schemas = OpenApi.components['schemas'];

/**
 * The job kind, declared HERE and re-exported by the handler through `worker-surface`.
 *
 * One declaration rather than the same string written on both sides: a queue whose producer and
 * consumer can disagree about a kind is a job that is enqueued and never picked up, which looks
 * exactly like a worker that is down.
 */
export const CREATE_POOL_KIND = 'storage.pool.create';

/**
 * The request, validated here rather than trusted from the generated types.
 *
 * `name` must start with a letter, which is stricter than ZFS and deliberately so: `zpool` reads a
 * leading `-` as an option (P0-E measured that every tool in this product parses its own argv), and
 * a name that is all digits is a pool somebody will later confuse with a number.
 */
const bodySchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,62}$/, 'a pool name must start with a letter'),
  topology: z.enum(['single', 'mirror', 'raidz1', 'raidz2']),
  disks: z
    .array(z.object({ byId: z.string().min(1).max(255), wwn: z.string().min(1).max(255) }))
    .min(1)
    .max(24),
  prepareShareRoot: z.boolean().default(false),
  confirm: z.string(),
  password: z.string().min(1).max(1024),
});

/**
 * Pool creation — the one route in this API that destroys data.
 *
 * §8.1's sequence is: analysis, plan, the serial/WWN list of the affected disks, written
 * confirmation, re-authentication, job. `GET /system/disks` is the analysis; the client builds the
 * plan and shows the list; this route takes the confirmation and the password and enqueues the job.
 *
 * WHAT THIS ROUTE DOES NOT CHECK, and why that is right: it does not verify that the disks are
 * blank, that they exist, or that none of them is the system disk. The agent does, against an
 * inventory it reads for itself at the moment of creation — and a check here would be a check
 * against a list this process was handed, which proves only that the client copied its own screen
 * correctly. Duplicating it would also invite the belief that the agent's copy is the redundant
 * one.
 */
@Controller('storage/pools')
@UseGuards(SessionGuard)
export class PoolsController {
  constructor(
    private readonly system: SystemService,
    private readonly jobs: JobsService,
    private readonly reauth: ReauthService,
    private readonly agent: AgentService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @HttpCode(202)
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['JobAccepted']> {
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();

    // The same gate as the inventory, and for a heavier reason. Not `AdminGuard`: `system/` uses
    // the founding administrator throughout, and the two concepts still want reconciling as one
    // decision (see `SystemService.isSystemAdministrator`) — making this route the exception would
    // settle that question by accident, in the direction of a wider gate on the riskier operation.
    if (!(await this.system.isSystemAdministrator(session.userId))) throw new ForbiddenException();

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid request');
    }
    const plan = parsed.data;

    // Before the password, so somebody who mistyped the confirmation is not asked to hand over
    // their password to find that out.
    if (plan.confirm !== plan.name) {
      throw new BadRequestException(
        `type the pool name '${plan.name}' to confirm; this operation erases the disks named`,
      );
    }

    // §0.5, through the SHARED check: throttled and recorded exactly as a login is. This route
    // used to verify the password itself, which meant a stolen session cookie could be used to
    // guess it here at full speed and leave nothing in `login_attempts`.
    await this.reauth.require(session.organizationId, session.userId, plan.password, request);

    // A pool this box already has. Checked here because the answer is a 409 the operator can act
    // on, and because the alternative is a job that fails with `zpool`'s own words two seconds
    // later on a screen that is no longer open. The agent refuses it too — this is the courteous
    // half, not the enforcing one.
    if (await this.exists(plan.name)) {
      throw new ConflictException(`a pool called '${plan.name}' already exists on this machine`);
    }

    // The PASSWORD IS NOT IN THE PAYLOAD. It proved the person at the keyboard and its job is
    // finished; a job row is jsonb in a table that survives the request, gets read by
    // `GET /jobs`, and ends up in `job_history`.
    const jobId = await this.jobs.enqueue(
      session.organizationId,
      CREATE_POOL_KIND,
      {
        name: plan.name,
        topology: plan.topology,
        disks: plan.disks,
        prepareShareRoot: plan.prepareShareRoot,
        requestedBy: session.userId,
      },
      // ONE attempt. Every other job kind in this product is safe to retry; this one runs `zpool
      // create` against real disks, and a retry after an ambiguous failure is the request nobody
      // wants made twice on their behalf. A pool that did not get created is a thing the operator
      // asks for again, having looked.
      { maxAttempts: 1 },
    );

    // Kuyruğa KONULDUĞU an, bittiği an değil — ve bu doğru an: diskleri silen kararı veren kişi
    // burada, işin kendisi ise sahipsiz bir arka plan sürecinde. İş düşerse de karar verilmişti.
    await this.audit.record(session.organizationId, {
      actorId: session.userId,
      action: 'storage.pool-create-requested',
      target: { kind: 'pool', id: plan.name, label: plan.name },
      summary: `'${plan.name}' havuzunun ${plan.disks.length} diskle (${plan.topology}) kurulması istendi; anılan diskler SİLİNECEK.`,
    });

    return { jobId };
  }

  /**
   * Bu havuz taranıyor mu, en son ne bulmuş.
   *
   * ZFS her bloğun sağlama toplamını tutuyor ve bozulmuş bir bloğu OKUNDUĞUNDA fark ediyor. Sessiz
   * bit çürümesinin problemi tam da bu: bir yedek arşivi yıllarca okunmuyor, yani bozulma yıllarca
   * fark edilmiyor, ve fark edildiği gün — dosyanın gerçekten gerektiği gün — kopyası da bozulmuş
   * olabiliyor.
   *
   * DEPSIS TARAMA ZAMANLAMIYOR, ve gerekçesi yazılmalı: Debian'ın `zfsutils-linux` paketi zaten
   * aylık bir tarama koyuyor, yani sıradan bir cihazda taramalar KOŞUYOR. Eksik olan şey zamanlama
   * değil GÖRÜNÜRLÜK — koşup koşmadığını, ne bulduğunu ve devam edip etmediğini hiçbir ekran
   * söylemiyordu. Bulduğu hataları kimsenin görmediği bir tarama, hiç koşmamış bir taramadan
   * yalnızca daha pahalı.
   */
  @Get(':pool/scrub')
  async scrubStatus(
    @Req() request: AuthenticatedRequest,
    @Param('pool') pool: string,
  ): Promise<Schemas['ScrubStatus']> {
    await this.requireSystemAdmin(request);
    const name = this.requirePoolName(pool);
    const response = await this.agent.call(
      { op: 'scrub_status', pool: name },
      `reading the scrub status of ${name}`,
      randomUUID(),
    );
    return toScrub(response, name);
  }

  /**
   * Şimdi tara.
   *
   * YIKICI DEĞİL, o yüzden önünde §8.1'in dizisi yok: tarama okuyor ve onarabildiğini onarıyor.
   * Maliyeti saatlerce disk bant genişliği — bu yüzden birinin bastığı bir düğme, DEPSIS'in kendi
   * inisiyatifiyle başlattığı bir şey değil.
   *
   * 202, ve durum başlatıldıktan SONRA okunuyor: `zpool scrub` hemen dönüyor ve hiçbir şey
   * söylemiyor, yani "başlatıldı" demek isteğin yankısı olurdu.
   */
  @Post(':pool/scrub')
  @HttpCode(202)
  async startScrub(
    @Req() request: AuthenticatedRequest,
    @Param('pool') pool: string,
  ): Promise<Schemas['ScrubStatus']> {
    requireSameOrigin(request);
    await this.requireSystemAdmin(request);
    const name = this.requirePoolName(pool);
    const response = await this.agent.call(
      { op: 'start_scrub', pool: name },
      `starting a scrub of ${name}`,
      randomUUID(),
    );
    return toScrub(response, name);
  }

  /** Havuz adı bir argv elemanı oluyor; havuz yaratmadaki kuralın aynısı. */
  private requirePoolName(raw: string): string {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,62}$/u.test(raw)) {
      throw new BadRequestException('a pool name must start with a letter');
    }
    return raw;
  }

  private async requireSystemAdmin(request: AuthenticatedRequest): Promise<void> {
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();
    if (!(await this.system.isSystemAdministrator(session.userId))) throw new ForbiddenException();
  }

  /**
   * Does this box already have a pool by that name?
   *
   * A refusal from the agent counts as "no such pool" — that is what `pool_status` answers for a
   * name it cannot find — and an agent that cannot be reached counts as "we do not know", which
   * lets the job run and be refused by the agent with a better sentence than this one could give.
   */
  private async exists(name: string): Promise<boolean> {
    try {
      return await this.system.poolExists(name);
    } catch {
      return false;
    }
  }
}

/**
 * Ajanın cevabını sözleşmenin şekline çevir.
 *
 * Bir modül fonksiyonu, metot değil: hiçbir alanına dokunmuyor, ve sınıfın içinde olsaydı
 * dokunabileceğini düşündürürdü.
 */
function toScrub(
  response: Awaited<ReturnType<AgentService['call']>>,
  pool: string,
): Schemas['ScrubStatus'] {
  if (response.status === 'refused' || response.status === 'failed') {
    throw new ServiceUnavailableException(`${pool}: ${response.reason}`);
  }
  if (response.status !== 'scrub') {
    throw new ServiceUnavailableException(
      `ajan bir tarama durumu yerine '${response.status}' cevabı verdi`,
    );
  }
  return {
    scan: response.scan,
    errors: response.errors,
    inProgress: response.in_progress,
    hasErrors: response.has_errors,
  };
}
