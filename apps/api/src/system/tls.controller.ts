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

import { AgentService, AgentUnavailableError } from '../agent/agent.service.js';
import { AuditService } from '../audit/audit.service.js';
import { requireSameOrigin } from '../auth/origin.js';
import { ReauthService } from '../auth/reauth.service.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { SystemService } from './system.service.js';

type Schemas = OpenApi.components['schemas'];

/** Ajanın `tls` yanıtı — alan adları ajanın yazdığı gibi. */
interface AgentTls {
  status: string;
  reason?: string | null;
  subject?: string;
  issuer?: string;
  not_before?: string;
  not_after?: string;
  fingerprint?: string;
  names?: string[];
  self_signed?: boolean;
}

const bodySchema = z.object({
  // Sınırlar ajandakilerle AYNI sayılar. İkinci kez yazılmış olmaları bir tekrar değil: buradaki
  // sınır, kabul edilmemesi gereken bir gövdenin ajana hiç gitmemesini sağlıyor.
  certificate: z.string().min(1).max(65536),
  privateKey: z.string().min(1).max(16384),
  password: z.string().min(1).max(1024),
});

/**
 * `/system/tls` — cihazın sunduğu sertifika, ve sahibinin kendi sertifikasını koyabilmesi.
 *
 * NEDEN VAR. Kurulum kendinden imzalı bir sertifika üretiyor; tarayıcı uyarıyor, ve uyarı GERÇEK.
 * Sahibinin kendi alan adı varsa o alan adı için aldığı sertifikayı kutuya koyabilmeli, ve bunun
 * yolu `scp` ile iki dosya kopyalayıp nginx'i yeniden yüklemek olmamalı.
 *
 * OKUMA UCU DA EN AZ YAZMA UCU KADAR ÖNEMLİ. Kendinden imzalı bir sertifikada tarayıcının uyarı
 * ekranında karşılaştırılacak tek şey parmak izidir, ve onu görmenin tek yolu bugüne kadar kurulum
 * çıktısına bakmaktı — yani cihazı kuran kişinin o anki terminali. Bir daha açılmayan bir pencere.
 *
 * ÖZEL ANAHTAR GÖVDEDE. Nest gövdeleri günlüğe yazmıyor, ajanın denetim kaydı yalnız işlem adını
 * taşıyor, ve anahtar kutuda 0400 kök olarak duruyor. Yine de bu, yüzeyin taşıdığı en hassas
 * alandır ve öyle işaretlenmiştir.
 */
@Controller('system/tls')
@UseGuards(SessionGuard)
export class TlsController {
  constructor(
    private readonly system: SystemService,
    private readonly agent: AgentService,
    private readonly reauth: ReauthService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async status(@Req() request: AuthenticatedRequest): Promise<Schemas['TlsStatus']> {
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();
    if (!(await this.system.isSystemAdministrator(session.userId))) throw new ForbiddenException();
    return this.present(
      await this.callAgent({ op: 'tls_status' }, 'reading the certificate', randomUUID()),
    );
  }

  @Post('certificate')
  @HttpCode(200)
  async install(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['TlsStatus']> {
    requireSameOrigin(request);
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();
    if (!(await this.system.isSystemAdministrator(session.userId))) throw new ForbiddenException();

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues[0]?.message ?? 'sertifika, özel anahtar ve parola gerekli',
      );
    }

    await this.reauth.require(
      session.organizationId,
      session.userId,
      parsed.data.password,
      request,
    );

    const correlationId = randomUUID();
    const response = await this.callAgent(
      {
        op: 'install_certificate',
        certificate: parsed.data.certificate,
        private_key: parsed.data.privateKey,
      },
      'installing a certificate',
      correlationId,
    );

    // Parmak izi kayda giriyor, anahtar GİRMİYOR: hangi sertifikanın ne zaman ve kim tarafından
    // kurulduğu, bir gün "tarayıcı neden farklı bir sertifika gösteriyor" diye sorulduğunda
    // cevabın kendisi.
    await this.audit.record(session.organizationId, {
      actorId: session.userId,
      action: 'system.certificate-installed',
      target: { kind: 'system', id: 'tls' },
      summary: `TLS sertifikası değiştirildi. Yeni parmak izi: ${response.fingerprint ?? 'bilinmiyor'}.`,
      correlationId,
    });

    return this.present(response);
  }

  private async callAgent(
    operation: Record<string, unknown>,
    reason: string,
    correlationId: string,
  ): Promise<AgentTls> {
    let response: AgentTls;
    try {
      response = (await this.agent.call(
        operation as never,
        reason,
        correlationId,
      )) as unknown as AgentTls;
    } catch (error) {
      if (error instanceof AgentUnavailableError) {
        throw new ServiceUnavailableException('depolama ajanına ulaşılamıyor');
      }
      throw error;
    }
    if (response.status === 'refused') {
      // Ajanın cümlesi aynen: "özel anahtar bu sertifikaya ait değil", "nginx bu sertifikayı
      // kabul etmedi, eskisi geri kondu". Hepsi operatörün üzerine gidebileceği olgular.
      throw new BadRequestException(response.reason ?? 'sertifika kurulamadı');
    }
    if (response.status !== 'tls') {
      throw new ServiceUnavailableException('sertifika okunamadı: beklenmeyen ajan yanıtı');
    }
    return response;
  }

  private present(response: AgentTls): Schemas['TlsStatus'] {
    return {
      subject: response.subject ?? '',
      issuer: response.issuer ?? '',
      notBefore: response.not_before ?? '',
      notAfter: response.not_after ?? '',
      fingerprint: response.fingerprint ?? '',
      names: response.names ?? [],
      // BİLİNMİYORSA KENDİNDEN İMZALI SAY. Yanlış yönde hata yapmak, tarayıcı uyarısı olmayan bir
      // kutuda gereksiz bir uyarı göstermek; doğru yönde hata yapmak, uyarısı olan bir kutuda
      // "her şey yolunda" demek olurdu.
      selfSigned: response.self_signed ?? true,
    };
  }
}
