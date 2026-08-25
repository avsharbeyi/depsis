import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { z } from 'zod';

import { requireSameOrigin } from '../auth/origin.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { ProblemException } from '../common/problem.filter.js';
import {
  BackupSchedulesService,
  type ScheduleInput,
  type ScheduleRow,
} from './backup-schedules.service.js';
import { SystemService } from './system.service.js';

type Schemas = OpenApi.components['schemas'];

const DATASET = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,254}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const USER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

const bodySchema = z
  .object({
    dataset: z.string().regex(DATASET),
    label: z.string().trim().min(1).max(80),
    cadence: z.enum(['hourly', 'daily', 'weekly']),
    atHour: z.number().int().min(0).max(23).nullable().default(null),
    atMinute: z.number().int().min(0).max(59).default(0),
    weekday: z.number().int().min(0).max(6).nullable().default(null),
    keep: z.number().int().min(1).max(10_000),
    replicateTarget: z.string().regex(DATASET).nullable().default(null),
    offsite: z
      .object({
        host: z.string().regex(HOST),
        port: z.number().int().min(1).max(65535).default(22),
        user: z.string().regex(USER),
      })
      .nullable()
      .default(null),
    enabled: z.boolean().default(true),
  })
  // Aynı kurallar veritabanında da CHECK olarak duruyor, ve iki yerde olmaları bilinçli: buradaki
  // 422 kullanıcının okuyabileceği bir cümle, oradaki kısıt ise başka bir yoldan gelen bir yazmanın
  // da geçemeyeceği kapı.
  .refine((v) => v.cadence !== 'hourly' || (v.atHour === null && v.weekday === null), {
    message: 'saatlik bir zamanlamada saat ve gün belirtilmez',
  })
  .refine((v) => v.cadence !== 'daily' || (v.atHour !== null && v.weekday === null), {
    message: 'günlük bir zamanlama bir saat ister',
  })
  .refine((v) => v.cadence !== 'weekly' || (v.atHour !== null && v.weekday !== null), {
    message: 'haftalık bir zamanlama bir gün ve bir saat ister',
  })
  .refine((v) => v.replicateTarget === null || v.offsite === null, {
    message: 'bir zamanlama ya yerel ya off-site çoğaltır, ikisini birden değil',
  });

/**
 * Zamanlanmış yedekler — elle başlatılan bir yedek, alınmayan bir yedektir.
 *
 * Bir NAS'ın verisini kaybetme yolu bozuk bir yedekleme değil, ALINMAMIŞ bir yedek; ve alınmamış
 * olmasının sebebi neredeyse her zaman birinin bir düğmeye basmayı unutması. Görüntü Faz 1'den,
 * çoğaltma Faz 2'den, off-site çoğaltma bu oturumdan beri var — üçünün de ortak eksiği kendiliğinden
 * koşmamalarıydı.
 *
 * SAKLAMA POLİTİKASI AYRI BİR ÖZELLİK DEĞİL, aynı şeyin öteki yarısı. Saatlik görüntü alan ve
 * hiçbirini silmeyen bir zamanlama havuzu doldurur, ve dolu bir havuz yedeği olmayan bir havuzdan
 * kötüdür: yazma da durur. Budama YALNIZ o zamanlamanın kendi ön ekiyle başlayan görüntülere
 * dokunuyor — elle alınmış bir görüntüyü silen bir budama, veri kaybının fark edilmeyen biçimi
 * olurdu.
 *
 * KURUCU YÖNETİCİ, `system/` boyunca olduğu gibi: bir zamanlama, cihazın verisini düzenli olarak
 * başka bir yere gönderen bir politika, ve kimin kurduğu sorusunun kolay cevabı olmalı.
 *
 * §8.1'İN DİZİSİ BURADA YOK, ve bunun gerekçesi yazılmalı: bu uçlar hiçbir şey yok etmiyor. Bir
 * zamanlamanın kurduğu ÇOĞALTMA yok edici, ve onun yazılı onayı ile yeniden kimlik doğrulaması
 * `POST /storage/replication` ile `POST /storage/offsite/replicate` üzerinde bir kez yapılıyor;
 * her gece parola sormak, bir zamanlamanın olmaması demek olurdu.
 */
@Controller('storage/backup-schedules')
@UseGuards(SessionGuard)
export class BackupSchedulesController {
  constructor(
    private readonly system: SystemService,
    private readonly schedules: BackupSchedulesService,
  ) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<Schemas['BackupSchedulePage']> {
    const session = await this.requireSystemAdmin(request);
    const rows = await this.schedules.list(session.organizationId);
    return { items: rows.map(toWire) };
  }

  @Post()
  @HttpCode(201)
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['BackupSchedule']> {
    requireSameOrigin(request);
    const session = await this.requireSystemAdmin(request);
    const input = this.parse(body);

    try {
      const row = await this.schedules.create(session.organizationId, session.userId, input);
      return toWire(row);
    } catch (error) {
      // Aynı veri kümesi için aynı ritimden ikinci bir zamanlama: iki kez aynı anda çalışan ve
      // birbirinin görüntüsünü budayan iki politika demek.
      if (isUniqueViolation(error)) {
        throw new ProblemException(
          'conflict',
          'Bu veri kümesi için bu ritimde bir zamanlama zaten var.',
        );
      }
      throw error;
    }
  }

  @Put(':id')
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Schemas['BackupSchedule']> {
    requireSameOrigin(request);
    const session = await this.requireSystemAdmin(request);
    const input = this.parse(body);

    const row = await this.schedules.update(session.organizationId, id, input);
    if (row === null) throw new ProblemException('not-found', 'Zamanlama bulunamadı.');
    return toWire(row);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() request: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
    requireSameOrigin(request);
    const session = await this.requireSystemAdmin(request);
    const removed = await this.schedules.remove(session.organizationId, id);
    if (!removed) throw new ProblemException('not-found', 'Zamanlama bulunamadı.');
  }

  private parse(body: unknown): ScheduleInput {
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid request');
    }
    return parsed.data;
  }

  private async requireSystemAdmin(
    request: AuthenticatedRequest,
  ): Promise<{ organizationId: string; userId: string }> {
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();
    if (!(await this.system.isSystemAdministrator(session.userId))) throw new ForbiddenException();
    return { organizationId: session.organizationId, userId: session.userId };
  }
}

function toWire(row: ScheduleRow): Schemas['BackupSchedule'] {
  return {
    id: row.id,
    dataset: row.dataset,
    label: row.label,
    cadence: row.cadence,
    atHour: row.at_hour,
    atMinute: row.at_minute,
    weekday: row.weekday,
    keep: row.keep,
    replicateTarget: row.replicate_target,
    offsite:
      row.offsite_host === null || row.offsite_user === null
        ? null
        : { host: row.offsite_host, port: row.offsite_port ?? 22, user: row.offsite_user },
    enabled: row.enabled,
    nextRunAt: row.next_run_at.toISOString(),
    lastRunAt: row.last_run_at?.toISOString() ?? null,
    lastResult: row.last_result,
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { code?: unknown }).code === '23505';
}
