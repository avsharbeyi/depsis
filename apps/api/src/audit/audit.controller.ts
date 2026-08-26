import {
  Controller,
  Get,
  Query,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';

import { AdminGuard, SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { AuditService, type AuditRow } from './audit.service.js';

type Schemas = OpenApi.components['schemas'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ACTION = /^[a-z][a-z-]*(\.[a-z][a-z-]*)*$/u;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Denetim kaydını okumak.
 *
 * YALNIZ YÖNETİCİ, ve 403 döner, 404 değil — ucun varlığı sır değil, kimin çağırabileceği sır
 * (`/users` ile aynı karar). Sıradan üyeye açmamak bir yetki meselesinden fazlası: satırlar başka
 * üyelerin adlarını, IP'lerini ve hangi klasörün iznine dokunduklarını taşıyor, yani bu uç
 * kiracının İÇİNDEKİ mahremiyetin de sınırı.
 *
 * YAZAN UÇ YOK. Denetim satırı ancak denetlediği işlemin içinde doğar (`AuditService.record`),
 * ve `depsis_app` rolünün UPDATE/DELETE yetkisi hiç yok — okuyan bu denetleyicinin silen bir
 * kardeşi olamaz, migration 0036 buna izin vermez.
 */
@Controller('audit')
@UseGuards(SessionGuard, AdminGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  async list(
    @Req() request: AuthenticatedRequest,
    @Query('before') before?: string,
    @Query('action') action?: string,
    @Query('limit') limit?: string,
  ): Promise<Schemas['AuditPage']> {
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException('oturum yok');

    if (before !== undefined && before !== '' && !UUID.test(before)) {
      throw new UnprocessableEntityException('before bir olay kimliği (uuid) olmalı');
    }
    if (action !== undefined && action !== '' && !ACTION.test(action)) {
      throw new UnprocessableEntityException('action noktalı küçük harfli bir ad olmalı');
    }

    let size = DEFAULT_LIMIT;
    if (limit !== undefined && limit !== '') {
      size = Number(limit);
      if (!Number.isInteger(size) || size < 1 || size > MAX_LIMIT) {
        throw new UnprocessableEntityException(
          `limit 1 ile ${MAX_LIMIT} arasında bir tam sayı olmalı`,
        );
      }
    }

    const rows = await this.audit.list(session.organizationId, {
      before: before === '' ? undefined : before,
      action: action === '' ? undefined : action,
      limit: size,
    });

    return {
      items: rows.map(toEvent),
      // Bir sonraki sayfanın imleci; tam sayfa dönmediyse daha eskisi yok demektir. Tam sayfa
      // döndüyse ve devamı da tam o anda bitiyorsa, bir sonraki istek boş bir sayfayla söyler —
      // bunu burada bilmeye çalışmak bir satırlık fazladan sorgu ederdi.
      nextBefore: rows.length === size ? (rows[rows.length - 1]?.id ?? null) : null,
    };
  }
}

function toEvent(row: AuditRow): Schemas['AuditEvent'] {
  return {
    id: row.id,
    actorId: row.actor_id,
    actorUsername: row.actor_username,
    action: row.action,
    targetKind: row.target_kind,
    targetId: row.target_id,
    targetLabel: row.target_label,
    summary: row.summary,
    correlationId: row.correlation_id,
    ip: row.ip,
    createdAt: row.created_at.toISOString(),
  };
}
