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
  Put,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { z } from 'zod';

import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import type { Caller } from '../files/files.service.js';
import {
  LinkedFileNotVisibleError,
  TaskFileLinkExistsError,
  TaskFilesService,
} from './task-files.service.js';
import {
  CommentNotFoundError,
  CommentNotYoursError,
  CommentRejectedError,
  TaskCommentsService,
  type CommentRow,
} from './task-comments.service.js';
import { TaskWatchersService } from './task-watchers.service.js';
import {
  AssigneeNotFoundError,
  TaskBothStatusFieldsError,
  TaskNotFoundError,
  TaskRejectedError,
  TaskStatusTransitionRefused,
  TasksService,
  type TaskRow,
} from './tasks.service.js';

type Schemas = OpenApi.components['schemas'];

const MAX_BODY = 2000;

// Trimmed for the same reason a note's title is: `tasks_body_present` tests `btrim(body) <> ''`,
// so a body of spaces would clear a bare length check here and be refused by the database.
const bodySchema = z.string().trim().min(1).max(MAX_BODY);
const assigneeSchema = z.string().uuid().nullable();
// `position` is a float so that dragging a job between two others is one UPDATE instead of
// renumbering the column. A non-finite value would be stored by `double precision` without
// complaint and would then sort unpredictably, so it is refused here — the database has no CHECK
// for it and this is the only place it can be caught.
const positionSchema = z.number().refine((v) => Number.isFinite(v), { message: 'not a number' });

const createSchema = z.object({
  body: bodySchema,
  assigneeId: assigneeSchema.optional(),
});

const statusSchema = z.enum(['draft', 'assigned', 'in_progress', 'in_review', 'done', 'cancelled']);
const prioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
// `datetime()` ve düz string DEĞİL: ayrıştırılamayan bir tarih PostgreSQL'e gidip orada patlardı,
// ve 500 ile 422 arasındaki fark istemcinin ne yapacağını bilip bilmemesi.
const dueSchema = z.string().datetime({ offset: true }).nullable();

const linkSchema = z.object({ fileEntryId: z.string().uuid() });

// Şemadaki `task_comments_body_sane` ile aynı sayı. Burada da olması, kısıt ihlalinin 500'e
// dönüşmesini engelliyor — aynı sınırın iki yerde durması, iki farklı şeyi koruduğu için tekrar
// değil.
const commentSchema = z.object({ body: z.string().trim().min(1).max(4000) });

const updateSchema = z
  .object({
    body: bodySchema.optional(),
    assigneeId: assigneeSchema.optional(),
    done: z.boolean().optional(),
    status: statusSchema.optional(),
    priority: prioritySchema.optional(),
    dueAt: dueSchema.optional(),
    position: positionSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to change' });

/**
 * The shared job board.
 *
 * `SessionGuard` only, and no ownership predicate anywhere below: the board belongs to the
 * organisation rather than to the person who typed the job in. That is the opposite of
 * `NotesController` next door, and the difference is the whole reason the two live in one module —
 * putting them side by side makes the asymmetry a decision somebody reads rather than an accident
 * somebody inherits.
 */
@Controller('tasks')
@UseGuards(SessionGuard)
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly links: TaskFilesService,
    private readonly thread: TaskCommentsService,
    private readonly watching: TaskWatchersService,
  ) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<Schemas['TaskPage']> {
    const caller = requireCaller(request);
    const rows = await this.tasks.list(caller.organizationId);
    // TEK ÇAĞRIDA, görev başına değil: elli görevlik bir pano, görev başına bir çözümle elli
    // yetki yürüyüşü demek olurdu. Sayı çağıranın GÖREBİLDİKLERİ — toplamı göstermek,
    // göremediği dosyaların varlığını söylerdi.
    const counts = await this.links.visibleCounts(
      caller,
      rows.map((row) => row.id),
    );
    return { items: rows.map((row) => toTask(row, counts.get(row.id) ?? 0)) };
  }

  @Post()
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['Task']> {
    const session = requireSession(request);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException(
        `a task needs a body of 1 to ${MAX_BODY} characters, and assigneeId must be a uuid or null`,
      );
    }

    try {
      const row = await this.tasks.create(
        session.organizationId,
        session.userId,
        parsed.data.body,
        parsed.data.assigneeId ?? null,
      );
      return toTask(row);
    } catch (error) {
      throw translate(error);
    }
  }

  @Patch(':id')
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Schemas['Task']> {
    const session = requireSession(request);
    requireUuid(id);
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      // 422, the same code POST /tasks answers for the same class of refusal and the only error
      // code besides 404 that the contract publishes for this operation. See the longer note on the
      // matching branch in `notes.controller.ts`: a 2001-character body must not get one status
      // from the create route and another from the update route.
      throw new UnprocessableEntityException(
        `one of body, assigneeId, done, status, priority, dueAt or position is required; ` +
          `body must be 1 to ${MAX_BODY} characters and dueAt an ISO 8601 timestamp`,
      );
    }

    try {
      const row = await this.tasks.update(session.organizationId, id, parsed.data, session.userId);
      return toTask(row);
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * GET /tasks/{id}/files — bu görevin bağlı olduğu, ÇAĞIRANIN GÖREBİLDİĞİ dosyalar.
   *
   * Görevin varlığı önce doğrulanıyor. Olmayan bir görev için boş bir liste, "bağ yok" ile "böyle
   * bir görev yok"u aynı cevaba çevirirdi — ve ikincisi 404.
   */
  @Get(':id/files')
  async files(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<Schemas['TaskFileLinkPage']> {
    const caller = requireCaller(request);
    requireUuid(id);
    try {
      await this.tasks.find(caller.organizationId, id);
      return await this.links.list(caller, id);
    } catch (error) {
      throw translate(error);
    }
  }

  @Post(':id/files')
  @HttpCode(201)
  async linkFile(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Schemas['TaskFileLink']> {
    const caller = requireCaller(request);
    requireUuid(id);
    const parsed = linkSchema.safeParse(body);
    if (!parsed.success) throw new UnprocessableEntityException('fileEntryId must be a uuid');

    try {
      await this.tasks.find(caller.organizationId, id);
      const link = await this.links.link(caller, id, parsed.data.fileEntryId);
      // Denetim izine "hangi dosya" olarak YOLU yazıyor, kimliği değil. Bir uuid, altı ay sonra
      // izi okuyan kişiye hiçbir şey söylemiyor — ve dosya o zamana kadar silinmişse, kimlik artık
      // hiçbir şeye çözülmüyor.
      await this.tasks.note(caller.organizationId, id, caller.userId, {
        field: 'file_link',
        old: null,
        new: link.path,
      });
      return link;
    } catch (error) {
      throw translate(error);
    }
  }

  @Delete(':id/files/:linkId')
  @HttpCode(204)
  async unlinkFile(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('linkId') linkId: string,
  ): Promise<void> {
    const caller = requireCaller(request);
    requireUuid(id);
    requireUuid(linkId);
    try {
      await this.tasks.find(caller.organizationId, id);
      const removed = await this.links.unlink(caller.organizationId, id, linkId);
      if (!removed) throw new NotFoundException();
      await this.tasks.note(caller.organizationId, id, caller.userId, {
        field: 'file_link',
        old: linkId,
        new: null,
      });
    } catch (error) {
      throw translate(error);
    }
  }

  @Get(':id/activity')
  async activity(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<Schemas['TaskActivityPage']> {
    const caller = requireCaller(request);
    requireUuid(id);
    try {
      const rows = await this.tasks.activity(caller.organizationId, id);
      return {
        items: rows.map((row) => ({
          id: row.id,
          actorUsername: row.actor_username,
          field: row.field,
          // SİLİNEN YORUMUN GÖVDESİ YÖNETİCİDEN BAŞKASINA DÖNMÜYOR.
          //
          // Denetim satırı gövdeyi TUTUYOR — §7 istiyor, ve bir yorumun silinmiş olması en çok
          // bakılacak an geldiğinde ne yazdığını da bilmeyi gerektirir. Ama onu bu akıştan HER
          // ÜYEYE geri vermek, silmeyi tamamen görüntüden ibaret yapardı: cümle yorum listesinden
          // kalkıyor, bir sekme ötede aynen duruyor. Kayıt yönetici için var, akran için değil.
          oldValue: row.field === 'comment' && !caller.isOrganizationAdmin ? null : row.old_value,
          newValue: row.new_value,
          at: row.created_at.toISOString(),
        })),
      };
    } catch (error) {
      throw translate(error);
    }
  }

  /* ─── yorumlar ────────────────────────────────────────────────────────────── */

  @Get(':id/comments')
  async comments(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<Schemas['TaskCommentPage']> {
    const session = requireSession(request);
    requireUuid(id);
    try {
      const rows = await this.thread.list(session.organizationId, id);
      return { items: rows.map(toComment) };
    } catch (error) {
      throw translate(error);
    }
  }

  @Post(':id/comments')
  @HttpCode(201)
  async addComment(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Schemas['TaskComment']> {
    const session = requireSession(request);
    requireUuid(id);
    const parsed = commentSchema.safeParse(body);
    if (!parsed.success) throw new UnprocessableEntityException('geçersiz yorum');
    try {
      return toComment(
        await this.thread.add(session.organizationId, id, session.userId, parsed.data.body),
      );
    } catch (error) {
      throw translate(error);
    }
  }

  @Patch(':id/comments/:commentId')
  async editComment(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Body() body: unknown,
  ): Promise<Schemas['TaskComment']> {
    const session = requireSession(request);
    requireUuid(id);
    requireUuid(commentId);
    const parsed = commentSchema.safeParse(body);
    if (!parsed.success) throw new UnprocessableEntityException('geçersiz yorum');
    try {
      return toComment(
        await this.thread.edit(
          session.organizationId,
          id,
          commentId,
          session.userId,
          parsed.data.body,
        ),
      );
    } catch (error) {
      throw translate(error);
    }
  }

  @Delete(':id/comments/:commentId')
  @HttpCode(204)
  async removeComment(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('commentId') commentId: string,
  ): Promise<void> {
    const caller = requireCaller(request);
    requireUuid(id);
    requireUuid(commentId);
    try {
      await this.thread.remove(
        caller.organizationId,
        id,
        commentId,
        caller.userId,
        caller.isOrganizationAdmin,
      );
    } catch (error) {
      throw translate(error);
    }
  }

  /* ─── izleyiciler ─────────────────────────────────────────────────────────── */

  @Get(':id/watchers')
  async watchers(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<Schemas['TaskWatcherPage']> {
    const session = requireSession(request);
    requireUuid(id);
    try {
      // Görevin varlığı önce: olmayan bir görev için boş liste, "kimse izlemiyor" ile "böyle bir
      // görev yok"u aynı cevaba çevirirdi.
      await this.tasks.find(session.organizationId, id);
      const rows = await this.watching.list(session.organizationId, id);
      return {
        items: rows.map((row) => ({
          userId: row.user_id,
          username: row.username,
          source: row.source,
          since: row.created_at.toISOString(),
        })),
        // Çağıranın kendi durumu, listeden türetilmek yerine ayrı bir alan: arayüzün sorduğu soru
        // "ben izliyor muyum", ve onu her istemcinin listede kendini araması gerekmiyor.
        watching: rows.some((row) => row.user_id === session.userId),
      };
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * Bu işi izlemeye başla — YALNIZ ÇAĞIRAN İÇİN.
   *
   * Gövde yok ve bir `userId` parametresi de yok, bilerek: başkası adına abone olabilmek, bir
   * kişiye istemediği bildirimleri göndermenin yolu olurdu ve o kişinin geri almaktan başka
   * yapabileceği bir şey olmazdı.
   */
  @Put(':id/watch')
  @HttpCode(204)
  async watch(@Req() request: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
    const session = requireSession(request);
    requireUuid(id);
    try {
      await this.tasks.find(session.organizationId, id);
      await this.watching.watch(session.organizationId, id, session.userId, 'manual');
    } catch (error) {
      throw translate(error);
    }
  }

  @Delete(':id/watch')
  @HttpCode(204)
  async unwatch(@Req() request: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
    const session = requireSession(request);
    requireUuid(id);
    try {
      await this.tasks.find(session.organizationId, id);
      await this.watching.unwatch(session.organizationId, id, session.userId);
    } catch (error) {
      throw translate(error);
    }
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() request: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
    const session = requireSession(request);
    requireUuid(id);
    try {
      await this.tasks.remove(session.organizationId, id);
    } catch (error) {
      throw translate(error);
    }
  }
}

function toTask(row: TaskRow, linkedFileCount = 0): Schemas['Task'] {
  return {
    id: row.id,
    linkedFileCount,
    body: row.body,
    status: row.status,
    priority: row.priority,
    // `dueAt` sözleşmede isteğe bağlı ve `exactOptionalPropertyTypes` "yok" ile "var ama
    // undefined"ı ayırıyor, o yüzden yayılıyor. `null` GÖNDERİLİYOR çünkü "son tarih yok" bir
    // durum, "sunucu söylemedi" değil.
    dueAt: row.due_at === null ? null : row.due_at.toISOString(),
    assigneeId: row.assignee_id,
    // Always present, and `null` when nobody holds the job. Omitting the key for an unassigned job
    // would make the client distinguish "unassigned" from "the server did not say", which is one
    // more state than the board has.
    assigneeUsername: row.assignee_username,
    doneAt: row.done_at === null ? null : row.done_at.toISOString(),
    position: row.position,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * `Caller`, izin çözümü için.
 *
 * `requireSession`'dan ayrı, çünkü dosya izinleri rolü de istiyor: bir organizasyon yöneticisi
 * `folder_grants` yürüyüşünde farklı cevap alıyor, ve o farkı burada düşürmek bir yöneticinin
 * kendi göremediği dosyaları göremediğini sanması demek olurdu.
 */
function requireCaller(request: AuthenticatedRequest): Caller {
  const session = request.depsis;
  if (session === undefined) throw new UnauthorizedException();
  return {
    organizationId: session.organizationId,
    userId: session.userId,
    isOrganizationAdmin: session.role === 'admin',
  };
}

function requireSession(request: AuthenticatedRequest): {
  organizationId: string;
  userId: string;
} {
  const session = request.depsis;
  if (session === undefined) throw new UnauthorizedException();
  return { organizationId: session.organizationId, userId: session.userId };
}

/** A malformed id is "no such task"; see the note on the same guard in `notes.controller.ts`. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireUuid(id: string): void {
  if (!UUID.test(id)) throw new NotFoundException();
}

function translate(error: unknown): Error {
  if (error instanceof TaskNotFoundError) return new NotFoundException();
  // 404 as well, and it is the assignee that is missing rather than the job. The contract publishes
  // 404 on both write routes for exactly this: naming somebody outside the organisation must read
  // as "no such person here", never as a confirmation that the id belongs to an account elsewhere.
  if (error instanceof AssigneeNotFoundError) return new NotFoundException(error.message);
  if (error instanceof TaskRejectedError) return new UnprocessableEntityException(error.message);
  // 422 ve 409 DEĞİL. 409 "kaynağın şu anki hâliyle çatışıyor" der ve yeniden denemeyi çağrıştırır;
  // reddedilen bir geçiş yeniden denemekle geçmez, isteğin kendisi yanlış.
  if (error instanceof TaskStatusTransitionRefused) {
    return new UnprocessableEntityException(error.message);
  }
  if (error instanceof TaskBothStatusFieldsError) {
    return new UnprocessableEntityException(error.message);
  }
  // Dosya görülemiyor: 404, 403 DEĞİL. 403 dosyanın VAR OLDUĞUNU söyler, ve §7'nin kuralı tam da
  // görevin dosya hakkında bilgi sızdırmaması.
  if (error instanceof LinkedFileNotVisibleError) return new NotFoundException();
  if (error instanceof TaskFileLinkExistsError) return new ConflictException(error.message);
  if (error instanceof CommentNotFoundError) return new NotFoundException();
  // 403, ve 404 DEĞİL. Yorumun VAR OLDUĞU zaten görünüyor — listede duruyor, yazanın adıyla — o
  // yüzden gizlenecek bir şey yok, ve "böyle bir yorum yok" demek okuyanı kendi ekranıyla çelişkiye
  // düşürürdü. Dosya bağındaki 404'ün sebebi başkaydı: orada gizlenen şey dosyanın varlığıydı.
  if (error instanceof CommentNotYoursError) return new ForbiddenException(error.message);
  if (error instanceof CommentRejectedError) return new UnprocessableEntityException(error.message);
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Silinmiş bir yorumun gövdesi ASLA dışarı çıkmıyor.
 *
 * Servis sorgusu zaten maskeliyor; burada ikinci kez yapılmıyor, ama `deleted` bayrağı buradan
 * geçiyor ve arayüzün "bu yorum silindi" diyebilmesinin tek kaynağı o. Boş bir gövde ile silinmiş
 * bir yorumu ayırt etmenin başka yolu yok — ve şema boş gövdeyi zaten reddediyor, yani boş gelen
 * her gövde silinmiş bir yorumun gövdesi.
 */
function toComment(row: CommentRow): Schemas['TaskComment'] {
  return {
    id: row.id,
    authorUsername: row.author_username,
    body: row.body,
    deleted: row.deleted_at !== null,
    editedAt: row.edited_at === null ? null : row.edited_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}
