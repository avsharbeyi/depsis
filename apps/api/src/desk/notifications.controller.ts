import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { z } from 'zod';

import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { NotificationsService } from './notifications.service.js';

type Schemas = OpenApi.components['schemas'];

const readSchema = z.object({ ids: z.array(z.string().uuid()).max(200).optional() });

/**
 * Bildirim merkezi — GET /notifications, POST /notifications/read.
 *
 * Yönetici kapısı YOK ve olmamalı: bir bildirim alıcısına ait, ve herkesin kendi gelen kutusu var.
 * Kişi filtresi her sorguda, çünkü RLS onu tutamıyor — politika `depsis.organization_id`'yi
 * biliyor, oturumdaki kullanıcıyı bilmiyor.
 */
@Controller('notifications')
@UseGuards(SessionGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  async inbox(
    @Req() request: AuthenticatedRequest,
    @Query('unread') unread?: string,
  ): Promise<Schemas['NotificationPage']> {
    const session = requireSession(request);
    const onlyUnread = unread === 'true' || unread === '1';

    const [rows, count] = await Promise.all([
      this.notifications.inbox(session.organizationId, session.userId, onlyUnread),
      // Liste filtrelenmiş ya da yüzde kırpılmış olabilir; zilin sayısı ondan türetilemez.
      this.notifications.unreadCount(session.organizationId, session.userId),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        taskId: row.task_id,
        taskBody: row.task_body,
        title: row.title,
        readAt: row.read_at === null ? null : row.read_at.toISOString(),
        createdAt: row.created_at.toISOString(),
      })),
      unread: count,
    };
  }

  /**
   * Okundu işaretle: verilen id'ler, ya da gövde yoksa hepsi.
   *
   * Bilinmeyen ya da başkasına ait bir id SESSİZCE atlanıyor, ve `marked` gerçekte kaç satırın
   * değiştiğini söylüyor. "Bu senin değil" demek, başkasının gelen kutusu hakkında bilgi vermek
   * olurdu — ve okuyanın yapabileceği hiçbir şey yok.
   */
  @Post('read')
  @HttpCode(200)
  async markRead(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['NotificationsRead']> {
    const session = requireSession(request);
    // Gövdesiz istek de geçerli: `{}` ve gövde yokluğu ikisi de "hepsi" demek, ve ikisini
    // ayırmak istemciye anlamı olmayan bir seçim dayatırdı.
    const parsed = readSchema.safeParse(body ?? {});
    const ids = parsed.success ? parsed.data.ids : undefined;

    const marked =
      ids === undefined
        ? await this.notifications.markAllRead(session.organizationId, session.userId)
        : await this.notifications.markRead(session.organizationId, session.userId, ids);

    return {
      marked,
      unread: await this.notifications.unreadCount(session.organizationId, session.userId),
    };
  }
}

function requireSession(request: AuthenticatedRequest): {
  organizationId: string;
  userId: string;
} {
  const session = request.depsis;
  if (session === undefined) throw new UnauthorizedException();
  return { organizationId: session.organizationId, userId: session.userId };
}
