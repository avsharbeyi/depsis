import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';

import { AdminGuard, SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { requireUuid } from '../files/files.controller.js';
import { JobsService, type Job, type JobStatus } from './jobs.service.js';

type Schemas = OpenApi.components['schemas'];
type JobResponse = Schemas['Job'];

/** The six the queue can be in. Written here so a typo in a query string is a 422, not an empty page. */
const STATUSES: readonly JobStatus[] = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'dead',
  'cancelled',
];

/** How many rows one page returns when the caller does not say. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

@Controller('jobs')
@UseGuards(SessionGuard)
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  /**
   * GET /jobs — the listing that makes a dead job findable.
   *
   * `GET /jobs/:jobId` answers only to whoever already holds the id, and a job usually dies long
   * after the page that held it was closed. So a `permissions.apply` that exhausted its attempts —
   * a permission applied in the database and never on the filesystem — existed in `job_history`
   * with nothing in the product able to reach it. ADR-0003 says a dead job "does not silently
   * disappear: the row lands in history where an alarm can find it"; this is the first thing that
   * can.
   *
   * ADMINISTRATORS ONLY, unlike the single-job lookup. That one is safe for anybody because
   * holding the id is itself the authorisation — it comes back from the request that created the
   * job. A LISTING has no such property: it would show a member every job in the tenant, which is
   * a running account of what everyone else is doing.
   */
  @Get()
  @UseGuards(AdminGuard)
  async list(
    @Req() request: AuthenticatedRequest,
    @Query('status') status: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<Schemas['JobPage']> {
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();

    // An unknown status is refused rather than ignored. Ignoring it would answer `?status=daed`
    // with every job in the tenant, which reads as "nothing is wrong" to the one person who went
    // looking — the opposite of what this endpoint is for.
    const wanted = (status ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    for (const part of wanted) {
      if (!STATUSES.includes(part as JobStatus)) {
        throw new UnprocessableEntityException(
          `unknown job status '${part}'; expected one of ${STATUSES.join(', ')}`,
        );
      }
    }

    // Clamped rather than refused: a limit is a request for a page size, and answering a big
    // number with a 422 helps nobody. A limit that is not a number at all falls back to the
    // default for the same reason.
    const asked = Number(limit);
    const size =
      Number.isFinite(asked) && asked >= 1 ? Math.min(Math.trunc(asked), MAX_LIMIT) : DEFAULT_LIMIT;

    const jobs = await this.jobs.list(session.organizationId, wanted as JobStatus[], size);
    return { items: jobs.map(toResponse) };
  }

  /**
   * GET /jobs/:jobId — how a long-running operation is going.
   *
   * A job belonging to another tenant is a 404, identical to a job that does not exist. Row level
   * security already makes them the same query result, and they should be the same ANSWER too: a
   * 403 here would confirm that the id names something real, turning this endpoint into an oracle
   * for which job ids exist elsewhere.
   *
   * `requireUuid` ÖNCE. `find_job(p_id uuid)` bir uuid bekliyor, yani `/jobs/abc` PostgreSQL'de
   * 22P02 fırlatıyor; `HttpException` olmadığı için filtre bunu 500 `internal-error` yapıp her
   * istekte günlüğe bir yığın izi yazıyordu. Bozuk bir bağlantı sunucu hatası değil, olmayan bir
   * kaynaktır.
   */
  @Get(':jobId')
  async find(
    @Req() request: AuthenticatedRequest,
    @Param('jobId') jobId: string,
  ): Promise<JobResponse> {
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();
    requireUuid(jobId);

    const job = await this.jobs.find(session.organizationId, jobId);
    if (job === null) throw new NotFoundException();

    return toResponse(job);
  }

  // ── İPTAL UCU HENÜZ BURADA DEĞİL, VE SEBEBİ BİR KARAR ────────────────────────────────────────
  //
  // §5.1 "mümkünse iptal edilir" diyor ve sunucu tarafı hazır: göç 0059 `cancel_job`ı ve
  // `cancelled` durumunu ekliyor, `JobsService.cancel` onu sürüyor, davranışı
  // `jobs.integration.test.ts` ölçüyor — kuyruktaki iş hiç alınmıyor, çalışan iş bir sonraki
  // `report()`ta duruyor.
  //
  // Eksik olan tek şey SÖZLEŞME. `contract.test.ts` bilerek her iki yönde de hata veriyor: belgede
  // yazmayan bir rota, üretilen hiçbir istemcinin çağıramayacağı bir rotadır. `POST
  // /jobs/{jobId}/cancel` ve `Job.status` enum'una `cancelled`,
  // `packages/contracts/openapi/depsis.yaml`a eklenip `generated/api.d.ts` yeniden üretilmeden bu
  // uç eklenirse kapı kırmızı yanar — ve bu dosya o belgeyi yazamaz.
  //
  // Eklendiğinde: `@Post(':jobId/cancel')`, `@HttpCode(204)`, `requireUuid(jobId)`,
  // `this.jobs.cancel(...)` false ise 404. Yönetici kapısı OLMADAN, `GET /jobs/:jobId` ile aynı
  // gerekçeyle: kimliği elde tutmak yetkinin kendisi, ve kopyalamayı yanlış klasöre başlatan
  // kişinin onu durdurabilmesi gerekiyor. `toResponse`'daki `as` de o zaman kalkar.
}

/**
 * One job, as the contract describes it.
 *
 * Shared by the listing and the lookup so the two cannot describe the same row differently — which
 * they would, eventually, if each built the object itself.
 */
function toResponse(job: Job): JobResponse {
  return {
    id: job.id,
    kind: job.kind,
    // `as`, ve bu bir kestirme değil bir borç: `cancelled` sözleşmenin `Job.status` enum'unda
    // henüz yok (packages/contracts/openapi/depsis.yaml, `Job`). Durum veritabanında ve bu
    // serviste gerçek; eksik olan yalnız belgenin listesi ve ondan üretilen tip. Enum'a
    // `cancelled` eklenip `generated/api.d.ts` yeniden üretildiğinde bu dönüşüm kaldırılmalı.
    status: job.status as JobResponse['status'],
    progress: job.progress,
    createdAt: job.createdAt.toISOString(),
    // `error` is present only when there is one. The queue stores a single string, so it is
    // carried as the title; inventing a `type`, `status` and `code` for a failure that happened
    // inside a worker would be dressing a message up as a classified problem it never was.
    ...(job.lastError === null
      ? {}
      : {
          error: {
            type: 'about:blank',
            title: job.lastError,
            status: 500,
            code: 'job_failed',
            correlationId: job.id,
          },
        }),
  };
}
