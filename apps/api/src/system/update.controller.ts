import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { z } from 'zod';

import { AgentService, AgentUnavailableError, type AgentRequest } from '../agent/agent.service.js';
import { AuditService } from '../audit/audit.service.js';
import { requireSameOrigin } from '../auth/origin.js';
import { ReauthService } from '../auth/reauth.service.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { SystemService } from './system.service.js';

type Schemas = OpenApi.components['schemas'];

const applySchema = z.object({ password: z.string().min(1).max(1024) });

/** Ajanın `update` yanıtı — alan adları ajanın yazdığı gibi, dönüştürme aşağıda tek yerde. */
interface AgentUpdate {
  status: string;
  reason?: string;
  installed?: string | null;
  available?: { commit: string; subject?: string | null; committed_at?: string | null } | null;
  phase?: string;
  in_progress?: boolean;
  up_to_date?: boolean;
  checked_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  error?: string | null;
  log_tail?: string[];
}

/**
 * `/system/update` — cihazın kendini güncellemesi.
 *
 * Cihaz sahibinin ilkesinden doğdu, disk temizleme gibi: depoda düzelen bir şey sahadaki kutuya
 * ancak ISO yeniden üretilip yeniden kurularak ya da kutuda bir kabuk açılarak gidiyordu. Bir
 * güvenlik düzeltmesinin kullanıcıya ulaşamaması, düzeltmenin kendisinden büyük bir kusurdur.
 *
 * BU KATMAN İNDİRME YAPMAZ. Ajan da yapmaz — birimi `IPAddressDeny=any` taşır. İndiren ve kuran
 * taraf ayrı bir systemd birimidir; buradan ajana giden şey yalnızca "o birimi başlat"tır.
 *
 * KURULACAK SÜRÜMÜ BU İSTEK SEÇMEZ. Uygulama isteğinin gövdesinde parola dışında hiçbir alan yok:
 * kurulacak şey son DENETİMİN bulduğu sürümdür. Ekranda gördüğü sürümü onaylayan yönetici tam onu
 * kurmuş olur — havuz sihirbazının WWN yeniden doğrulamasıyla aynı kalıp.
 */
@Controller('system/update')
@UseGuards(SessionGuard)
export class UpdateController {
  constructor(
    private readonly system: SystemService,
    private readonly agent: AgentService,
    private readonly reauth: ReauthService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async status(@Req() request: AuthenticatedRequest): Promise<Schemas['UpdateStatus']> {
    const session = await this.requireAdministrator(request, false);
    return this.present(
      await this.callAgent({ op: 'update_status' }, 'reading update status', randomUUID()),
      session.correlationId,
    );
  }

  @Post('check')
  @HttpCode(200)
  async check(@Req() request: AuthenticatedRequest): Promise<Schemas['UpdateStatus']> {
    const session = await this.requireAdministrator(request, true);
    const correlationId = randomUUID();
    const response = await this.callAgent(
      { op: 'check_update' },
      'checking for a new version',
      correlationId,
    );
    // Denetim ağa çıkıyor, yani kutunun dışına bir bağlantı. Bunu denetim kaydına yazmak, "bu
    // cihaz kendiliğinden dışarıya bağlanıyor mu" sorusunun cevabını bırakır: hayır, ve her
    // bağlantının kim tarafından başlatıldığı burada durur.
    await this.audit.record(session.organizationId, {
      actorId: session.userId,
      action: 'system.update-checked',
      target: { kind: 'system', id: 'update' },
      summary: 'Yeni sürüm var mı diye bakıldı.',
      correlationId,
    });
    return this.present(response, correlationId);
  }

  @Post('apply')
  @HttpCode(200)
  async apply(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['UpdateStatus']> {
    const session = await this.requireAdministrator(request, true);
    const parsed = applySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('parola gerekli');

    await this.reauth.require(
      session.organizationId,
      session.userId,
      parsed.data.password,
      request,
    );

    const correlationId = randomUUID();
    const response = await this.callAgent(
      { op: 'apply_update' },
      'applying the update',
      correlationId,
    );

    await this.audit.record(session.organizationId, {
      actorId: session.userId,
      action: 'system.update-applied',
      target: { kind: 'system', id: response.available?.commit ?? 'update' },
      summary:
        response.available?.commit === undefined || response.available === null
          ? 'Güncelleme başlatıldı.'
          : `Güncelleme başlatıldı: ${response.available.commit}.`,
      correlationId,
    });

    return this.present(response, correlationId);
  }

  /**
   * `system/` boyunca aynı kapı: kurucu yönetici.
   *
   * `sameOrigin` yalnız yazan uçlar için — okuma isteğinde CSRF diye bir şey yok, ve durumu
   * arayüzün her iki saniyede bir yoklaması gerekiyor.
   */
  private async requireAdministrator(
    request: AuthenticatedRequest,
    write: boolean,
  ): Promise<{ organizationId: string; userId: string; correlationId: string }> {
    if (write) requireSameOrigin(request);
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();
    if (!(await this.system.isSystemAdministrator(session.userId))) throw new ForbiddenException();
    return {
      organizationId: session.organizationId,
      userId: session.userId,
      correlationId: randomUUID(),
    };
  }

  private async callAgent(
    operation: AgentRequest,
    reason: string,
    correlationId: string,
  ): Promise<AgentUpdate> {
    let response: AgentUpdate;
    try {
      response = await this.agent.call(operation, reason, correlationId);
    } catch (error) {
      if (error instanceof AgentUnavailableError) {
        throw new ServiceUnavailableException('depolama ajanına ulaşılamıyor');
      }
      throw error;
    }
    // Ajanın reddi bir HATA değil bir CEVAPTIR, ve cümlesi operatörün üzerine gidebileceği bir
    // olgudur: "bir güncelleme zaten sürüyor", "önce denetim çalıştırın".
    if (response.status === 'refused') {
      throw new BadRequestException(response.reason ?? 'güncelleme işlemi reddedildi');
    }
    if (response.status !== 'update') {
      throw new ServiceUnavailableException('güncelleme durumu okunamadı: beklenmeyen ajan yanıtı');
    }
    return response;
  }

  /**
   * Ajanın snake_case yanıtından API'nin camelCase şeması.
   *
   * Varsayılanlar EKSİK ALAN İÇİN DEĞİL, ESKİ AJAN İÇİN: şema sürümü el sıkışmada denetleniyor, ama
   * bir alan bir gün isteğe bağlı hâle gelirse arayüzün "bilinmiyor" ile "hayır"ı karıştırmaması
   * gerekiyor. `inProgress` bu yüzden `true`ya düşüyor — bilinmezlikte doğru davranış, ikinci bir
   * güncellemeye izin vermemek.
   */
  private present(response: AgentUpdate, _correlationId: string): Schemas['UpdateStatus'] {
    const available = response.available ?? null;
    return {
      installed: response.installed ?? null,
      available:
        available === null
          ? null
          : {
              commit: available.commit,
              subject: available.subject ?? null,
              committedAt: available.committed_at ?? null,
            },
      phase: response.phase ?? 'idle',
      inProgress: response.in_progress ?? true,
      upToDate: response.up_to_date ?? false,
      checkedAt: response.checked_at ?? null,
      startedAt: response.started_at ?? null,
      finishedAt: response.finished_at ?? null,
      error: response.error ?? null,
      logTail: response.log_tail ?? [],
    };
  }
}
