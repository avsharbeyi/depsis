import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { z } from 'zod';

import { AgentService, AgentUnavailableError } from '../agent/agent.service.js';
import { AuditService } from '../audit/audit.service.js';
import { requireSameOrigin } from '../auth/origin.js';
import { ReauthService } from '../auth/reauth.service.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { SystemService } from './system.service.js';

type Schemas = OpenApi.components['schemas'];

const bodySchema = z.object({
  byId: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, 'by-id adı bir yol ya da bayrak olamaz'),
  wwn: z.string().min(1).max(64),
  // §8.1'in yazılı onayı. Havuz sihirbazı havuzun ADINI yazdırıyor; bir diskin by-id adını
  // yazdırmak (ata-WDC_WDS120G2G0A-00JH30_180873800093) insanlık dışı olurdu — sözcük sabit.
  confirm: z.literal('SİL'),
  password: z.string().min(1).max(1024),
});

/**
 * POST /system/disks/wipe — bir diski, havuz sihirbazının kabul edeceği hâle getirmek.
 *
 * Cihaz sahibinin ilkesinden doğdu: "üstünde bir şey olan disk seçilemez" doğru ret, ama tek
 * temizleme yolu kabuk olduğu sürece o ret sahibi terminale yollar. Tören havuz kurmanınkiyle
 * aynı (§8.1): ne silineceği ekranda, yazılı onay, parolayla yeniden kimlik — ve asıl reddeden
 * taraf ajan: sistem diski ve bağlı disk hiçbir onayla geçmez, WWN silme ANINDA yeniden
 * doğrulanır, yani sihirbaz açıkken yuvası değiştirilen disk silinmez.
 */
@Controller('system/disks')
@UseGuards(SessionGuard)
export class DiskWipeController {
  constructor(
    private readonly system: SystemService,
    private readonly agent: AgentService,
    private readonly reauth: ReauthService,
    private readonly audit: AuditService,
  ) {}

  @Post('wipe')
  @HttpCode(200)
  async wipe(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['DiskWipeResult']> {
    requireSameOrigin(request);
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();
    // Havuz kurmayla aynı kapı, aynı gerekçeyle: system/ boyunca kurucu yönetici.
    if (!(await this.system.isSystemAdministrator(session.userId))) throw new ForbiddenException();

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues[0]?.message ?? "onay sözcüğü 'SİL' ve parola gerekli",
      );
    }

    await this.reauth.require(
      session.organizationId,
      session.userId,
      parsed.data.password,
      request,
    );

    const correlationId = randomUUID();
    const response = await this.callAgent(parsed.data.byId, parsed.data.wwn, correlationId);

    if (response.status === 'refused') {
      // Ajanın cümlesi aynen: "sistem diski", "bağlı", "WWN uyuşmuyor" — hepsi operatörün
      // üzerine gidebileceği gerçekler.
      throw new BadRequestException(response.reason);
    }
    if (response.status !== 'disk_wiped') {
      throw new ServiceUnavailableException('disk silinemedi: beklenmeyen ajan yanıtı');
    }

    await this.audit.record(session.organizationId, {
      actorId: session.userId,
      action: 'storage.disk-wiped',
      target: { kind: 'disk', id: parsed.data.byId },
      summary: `'${parsed.data.byId}' diski SIFIRLANDI; üzerindeki her şey geri dönüşsüz silindi.`,
      correlationId,
    });

    return { detail: response.detail ?? null };
  }

  private async callAgent(
    byId: string,
    wwn: string,
    correlationId: string,
  ): Promise<{ status: string; reason?: string; detail?: string } & Record<string, unknown>> {
    try {
      return await this.agent.call(
        { op: 'wipe_disk', disk: { by_id: byId, wwn } },
        `wiping disk ${byId}`,
        correlationId,
      );
    } catch (error) {
      if (error instanceof AgentUnavailableError) {
        throw new ServiceUnavailableException('depolama ajanına ulaşılamıyor');
      }
      throw error;
    }
  }
}
