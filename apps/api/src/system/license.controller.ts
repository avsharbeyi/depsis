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
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service.js';
import { requireSameOrigin } from '../auth/origin.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { LicenseService } from './license.service.js';
import { SystemService } from './system.service.js';

type Schemas = OpenApi.components['schemas'];

const bodySchema = z.object({
  // Bir Ed25519 imzası base64url'de 86 hane; başlık ve içerikle birlikte birkaç yüz karakter.
  // Üst sınır cömert ama sınırsız değil.
  key: z.string().min(1).max(4096),
});

/**
 * `/system/license` — cihazın lisansı.
 *
 * OKUMASI YÖNETİCİYLE SINIRLI DEĞİL, ve bu bilinçli: lisansın kime ve ne zamana kadar verildiği,
 * cihazı kullanan herkesin görebilmesi gereken bir olgu — "bu cihaz ne zaman desteksiz kalacak"
 * sorusunun cevabı bir sır değil. KURMAK ise kurucu yöneticinin işi.
 *
 * PAROLA SORULMUYOR. Lisans kurmak yıkıcı değil, geri alınabilir, ve yanlış bir anahtar zaten imza
 * doğrulamasında düşüyor. §8.1'in töreni geri alınamayan işlemler için.
 */
@Controller('system/license')
@UseGuards(SessionGuard)
export class LicenseController {
  constructor(
    private readonly license: LicenseService,
    private readonly system: SystemService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async status(@Req() request: AuthenticatedRequest): Promise<Schemas['LicenseStatus']> {
    if (request.depsis === undefined) throw new UnauthorizedException();
    return this.present(await this.license.current());
  }

  @Post()
  @HttpCode(200)
  async install(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['LicenseStatus']> {
    requireSameOrigin(request);
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();
    if (!(await this.system.isSystemAdministrator(session.userId))) throw new ForbiddenException();

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('lisans anahtarı gerekli');

    const result = this.license.check(parsed.data.key);
    if (!result.ok) {
      // Doğrulamanın kendi cümlesi: "imza tutmuyor" ile "biçim tanınmadı" ayrı sorunlar, ve
      // ikisini "geçersiz lisans" diye birleştirmek, yanlış dosyayı yapıştıran birine hiçbir şey
      // söylemez.
      throw new BadRequestException(result.reason);
    }

    await this.license.install(parsed.data.key, result.payload);

    await this.audit.record(session.organizationId, {
      actorId: session.userId,
      action: 'system.license-installed',
      target: { kind: 'system', id: result.payload.id },
      summary: `Lisans kuruldu: ${result.payload.to} (${result.payload.id}).`,
      correlationId: randomUUID(),
    });

    return this.present(await this.license.current());
  }

  /**
   * DÖRT DURUM VE DÖRDÜ AYRI: lisans yok, lisans var ve geçerli, lisans var ama süresi dolmuş,
   * lisans var ama doğrulanamıyor. Sonuncusunu "yok" ile birleştirmek, kurcalanmış bir satırı
   * hiç kurulmamış bir lisanstan ayırt edilemez yapardı.
   */
  private present(
    current: Awaited<ReturnType<LicenseService['current']>>,
  ): Schemas['LicenseStatus'] {
    const configured = this.license.configured();
    if (current === null) {
      return {
        state: configured ? 'absent' : 'unconfigured',
        licensedTo: null,
        licenseId: null,
        plan: null,
        issuedAt: null,
        expiresAt: null,
        installedAt: null,
        deviceId: this.license.deviceId(),
        detail: configured
          ? null
          : 'bu cihazda lisans açık anahtarı kurulu değil; lisans doğrulanamaz',
      };
    }
    if ('invalid' in current) {
      return {
        state: 'invalid',
        licensedTo: null,
        licenseId: null,
        plan: null,
        issuedAt: null,
        expiresAt: null,
        installedAt: null,
        deviceId: this.license.deviceId(),
        detail: current.invalid,
      };
    }
    const { payload } = current;
    const expired = payload.until !== null && Date.parse(payload.until) < Date.now();
    return {
      state: expired ? 'expired' : 'valid',
      licensedTo: payload.to,
      licenseId: payload.id,
      plan: payload.plan,
      issuedAt: payload.issued,
      expiresAt: payload.until,
      installedAt: current.installedAt,
      deviceId: this.license.deviceId(),
      detail: null,
    };
  }
}
