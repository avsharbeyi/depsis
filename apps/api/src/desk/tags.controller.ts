import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { z } from 'zod';

import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import {
  TAG_COLORS,
  TagExistsError,
  TagNotFoundError,
  TagRejectedError,
  TaskTagsService,
} from './task-tags.service.js';

type Schemas = OpenApi.components['schemas'];

const colorSchema = z.enum(TAG_COLORS);
const createSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: colorSchema.optional(),
});
const updateSchema = z
  .object({ name: z.string().trim().min(1).max(40).optional(), color: colorSchema.optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to change' });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Etiket sözlüğü — `/tags`, `/tasks/{id}` DEĞİL.
 *
 * Kendi denetleyicisi çünkü bir etiket KİRACIYA ait, bir işe değil: adı ve rengi bütün panoda tek
 * bir yerde tanımlı, ve bir iş yalnız ona bağlanıyor. `/tasks/{id}/tags/{tagId}` — bağ — bunun
 * tersine `TasksController`'da, çünkü orada değişen şey işin kendisi.
 *
 * `AdminGuard` SINIFTA DEĞİL, iki uçta: liste ve oluşturma herkese açık, yeniden adlandırma ve
 * silme yalnız yöneticiye. İkisi de kiracı çapında — bir adı değiştirmek onu kullanan her işin
 * anlamını değiştiriyor, silmek her işten kaldırıyor — ve bir üyenin yanlışlıkla yaptığı bir şeyin
 * otuz işi etkilemesi, geri alınması en zor hata sınıfı.
 */
@Controller('tags')
@UseGuards(SessionGuard)
export class TagsController {
  constructor(private readonly tags: TaskTagsService) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<Schemas['TagPage']> {
    const { organizationId } = requireCaller(request);
    return { items: await this.tags.list(organizationId) };
  }

  @Post()
  @HttpCode(201)
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['Tag']> {
    const { organizationId } = requireCaller(request);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw new UnprocessableEntityException('geçersiz etiket');
    try {
      return await this.tags.ensure(organizationId, parsed.data.name, parsed.data.color ?? 'iris');
    } catch (error) {
      throw translate(error);
    }
  }

  @Patch(':tagId')
  async rename(
    @Req() request: AuthenticatedRequest,
    @Param('tagId') tagId: string,
    @Body() body: unknown,
  ): Promise<Schemas['Tag']> {
    const caller = requireCaller(request);
    requireAdmin(caller);
    requireUuid(tagId);
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) throw new UnprocessableEntityException('geçersiz etiket');
    try {
      return await this.tags.rename(
        caller.organizationId,
        tagId,
        parsed.data.name,
        parsed.data.color,
      );
    } catch (error) {
      throw translate(error);
    }
  }

  @Delete(':tagId')
  async remove(
    @Req() request: AuthenticatedRequest,
    @Param('tagId') tagId: string,
  ): Promise<{ removedFrom: number }> {
    const caller = requireCaller(request);
    requireAdmin(caller);
    requireUuid(tagId);
    try {
      // Kaç işten kalktığı CEVAPTA. Arayüz onu silmeden önce soruyor, ama cevap yine de taşıyor:
      // onay ekranından geçmeyen bir istemci de ne olduğunu bilmeli.
      return { removedFrom: await this.tags.remove(caller.organizationId, tagId) };
    } catch (error) {
      throw translate(error);
    }
  }
}

interface Caller {
  organizationId: string;
  userId: string;
  isAdmin: boolean;
}

function requireCaller(request: AuthenticatedRequest): Caller {
  const session = request.depsis;
  if (session === undefined) throw new UnauthorizedException();
  return {
    organizationId: session.organizationId,
    userId: session.userId,
    isAdmin: session.role === 'admin',
  };
}

/**
 * 403, 404 DEĞİL — ve fark bu dosyada bilinçli.
 *
 * Etiket sözlüğünün tamamı zaten `GET /tags` ile herkese açık, yani bir etiketin VARLIĞI gizli
 * değil. Gizlenecek bir şey olmadığında "böyle bir etiket yok" demek, okuyanı kendi ekranıyla
 * çelişkiye düşürürdü. Dosya bağlarındaki 404'ün sebebi başkaydı: orada gizlenen şey dosyanın
 * varlığıydı.
 */
function requireAdmin(caller: Caller): void {
  if (!caller.isAdmin) {
    throw new ForbiddenException('etiketleri yalnız yöneticiler değiştirebilir');
  }
}

function requireUuid(id: string): void {
  if (!UUID.test(id)) throw new NotFoundException();
}

function translate(error: unknown): Error {
  if (error instanceof TagNotFoundError) return new NotFoundException();
  if (error instanceof TagExistsError) return new ConflictException(error.message);
  if (error instanceof TagRejectedError) return new UnprocessableEntityException(error.message);
  return error instanceof Error ? error : new Error(String(error));
}
