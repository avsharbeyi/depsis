import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { z } from 'zod';

import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { DbService } from '../db/db.service.js';
import {
  EntryNotFoundError,
  FilesService,
  InvalidNameError,
  NameTakenError,
  type FileEntryRow,
} from './files.service.js';

type Schemas = OpenApi.components['schemas'];

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const createFolderSchema = z.object({
  parentId: z.string().uuid().nullish(),
  name: z.string().min(1).max(255),
});
const renameSchema = z.object({ name: z.string().min(1).max(255) });

/**
 * The file tree.
 *
 * Every route is behind `SessionGuard`, so the tenant comes from the session and never from the
 * request (ADR-0015 §6). No route accepts an organisation id, a share name or a path — a caller
 * names an entry by its `id` and nothing else, because ADR-0005 forbids a path from ever being an
 * authorisation input.
 */
@Controller('files')
@UseGuards(SessionGuard)
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly db: DbService,
  ) {}

  @Get()
  async list(
    @Req() request: AuthenticatedRequest,
    @Query('parentId') parentId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<Schemas['FileEntryPage']> {
    const session = requireSession(request);
    const share = await this.share(request);

    // A parent from another share, or a trashed one, must read as absent rather than empty: an
    // empty page would tell the caller the folder exists.
    if (parentId !== undefined) {
      const parent = await this.load(session.organizationId, parentId);
      if (parent.share_id !== share.id || parent.trashed_at !== null) throw new NotFoundException();
    }

    const page = await this.files.list(
      session.organizationId,
      share.id,
      parentId ?? null,
      cursor ?? null,
      clampLimit(limit),
    );

    return {
      items: page.items.map(toEntry),
      ...(page.nextCursor === null ? {} : { nextCursor: page.nextCursor }),
      hasMore: page.hasMore,
    };
  }

  @Post('folders')
  async createFolder(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['FileEntry']> {
    const session = requireSession(request);
    const share = await this.share(request);
    const parsed = createFolderSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('parentId must be a uuid and name a string');

    try {
      const row = await this.files.createFolder(
        session.organizationId,
        share.id,
        parsed.data.parentId ?? null,
        parsed.data.name,
      );
      return toEntry(row);
    } catch (error) {
      throw translate(error);
    }
  }

  @Get(':id')
  async detail(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<Schemas['FileEntryDetail']> {
    const session = requireSession(request);
    const row = await this.load(session.organizationId, id);
    return { ...toEntry(row), createdAt: row.created_at.toISOString() };
  }

  @Patch(':id')
  async rename(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Schemas['FileEntry']> {
    const session = requireSession(request);
    const parsed = renameSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('name is required');

    try {
      return toEntry(await this.files.rename(session.organizationId, id, parsed.data.name));
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * Move to the trash.
   *
   * Returns the entry rather than a job reference. The contract described a 202 with a `JobRef`
   * because deleting a large subtree looked like long work; trashing turned out to be one flag on
   * one row, so there is no job to reference and inventing one would mean a queue entry that
   * completes before the client can poll it. The spec now says 200 for this operation.
   */
  @Delete(':id')
  async trash(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<Schemas['FileEntry']> {
    const session = requireSession(request);
    try {
      return toEntry(await this.files.trash(session.organizationId, id, session.userId));
    } catch (error) {
      throw translate(error);
    }
  }

  private async load(organizationId: string, id: string): Promise<FileEntryRow> {
    try {
      return await this.files.find(organizationId, id);
    } catch (error) {
      throw translate(error);
    }
  }

  /** The tenant's share. One for now; see `FilesService.defaultShare`. */
  private async share(request: AuthenticatedRequest): Promise<{ id: string; name: string }> {
    const session = requireSession(request);
    const rows = await this.db.withTenant(session.organizationId, (db) =>
      db.query<{ slug: string }>(`SELECT slug FROM public.organizations WHERE id = $1`, [
        session.organizationId,
      ]),
    );
    const slug = rows[0]?.slug;
    if (slug === undefined) throw new NotFoundException();
    return this.files.defaultShare(session.organizationId, slug);
  }
}

function clampLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

export function toEntry(row: FileEntryRow): Schemas['FileEntry'] {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    kind: row.kind,
    // `bigint` comes back from node-postgres as a string, deliberately: JavaScript's number cannot
    // hold every int64 and a silent coercion would round the size of a large file. Parsed here,
    // where the contract asks for a number, and files above 2^53 bytes are not a case this
    // appliance has.
    size: Number(row.size_bytes),
    modifiedAt: row.updated_at.toISOString(),
    ...(row.content_type === null ? {} : { mimeType: row.content_type }),
  };
}

export function requireSession(request: AuthenticatedRequest): {
  organizationId: string;
  userId: string;
} {
  const session = request.depsis;
  if (session === undefined) throw new UnauthorizedException();
  return { organizationId: session.organizationId, userId: session.userId };
}

/**
 * Map a service error onto its HTTP answer.
 *
 * `EntryNotFoundError` covers both "no such row" and "another tenant's row" on purpose — RLS makes
 * them indistinguishable to the query, and telling them apart at this layer would reintroduce the
 * existence oracle the row-level policy exists to close.
 */
export function translate(error: unknown): Error {
  if (error instanceof EntryNotFoundError) return new NotFoundException();
  if (error instanceof NameTakenError) return new ConflictException(error.message);
  if (error instanceof InvalidNameError) return new BadRequestException(error.message);
  return error instanceof Error ? error : new Error(String(error));
}
