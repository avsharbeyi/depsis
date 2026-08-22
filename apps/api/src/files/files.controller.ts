import {
  BadRequestException,
  Headers,
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
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { AgentDataService } from '../agent/agent-data.service.js';
import { AgentRefusedError } from '../agent/agent.service.js';
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
    private readonly data: AgentDataService,
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

  /**
   * The bytes.
   *
   * Supports RFC 9110 Range, and does not read the file into memory: the agent streams it back
   * over the data socket and this pipes it straight to the response.
   *
   * The size used for the range check is the AGENT's, not the `size_bytes` column. The column is
   * what DEPSIS last recorded and a file changed over SMB is exactly where the two diverge — a
   * range validated against a stale number is a range validated against nothing.
   */
  @Get(':id/content')
  async content(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: false }) response: Response,
    @Param('id') id: string,
    @Headers('range') range?: string,
    @Headers('if-range') ifRange?: string,
  ): Promise<void> {
    const session = requireSession(request);
    const entry = await this.load(session.organizationId, id);
    if (entry.kind !== 'file' || entry.trashed_at !== null) throw new NotFoundException();
    if (!this.data.isAvailable()) {
      throw new ServiceUnavailableException('the system agent is not reachable');
    }

    const share = await this.share(request);
    const components = await this.files
      .componentsOf(session.organizationId, id)
      .catch((error: unknown) => {
        throw translate(error);
      });

    const correlationId = randomUUID();
    // The agent's refusals for a download are a closed set of two, and both are answers the client
    // can act on rather than faults: the file is no longer there (it was deleted or renamed over
    // SMB since the listing the caller is working from), or another reader holds it. Letting them
    // reach the default handler would turn both into a 500, which a client retries.
    const opened = await this.files
      .openDownload(share.name, components, correlationId, `GET /files/${id}/content`)
      .catch((error: unknown) => {
        if (error instanceof AgentRefusedError) {
          throw error.agentReason.includes('reader')
            ? new ConflictException(error.agentReason)
            : new NotFoundException();
        }
        throw error;
      });

    const etag = etagOf(entry, opened.size);
    // If-Range with a tag that no longer matches means the file changed since the client saw it.
    // Answering 206 then would splice a range of the NEW file into a buffer holding the old one,
    // and the result is a file that is corrupt in a way neither side can detect. 200 instead.
    const rangeApplies = ifRange === undefined || ifRange === etag;
    const wanted = rangeApplies ? parseRange(range, opened.size) : null;

    if (wanted === 'unsatisfiable') {
      response.setHeader('Content-Range', `bytes */${opened.size}`);
      response.status(416).end();
      return;
    }

    const start = wanted?.start ?? 0;
    const length = wanted === null ? opened.size : wanted.end - wanted.start + 1;

    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('ETag', etag);
    response.setHeader('Content-Length', String(length));
    response.setHeader('Content-Type', entry.content_type ?? 'application/octet-stream');
    // `attachment` is not a nicety. Serving a tenant-supplied file inline on the API's own origin
    // makes an uploaded HTML file a stored XSS against every other tenant's session.
    response.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
    );
    if (wanted !== null) {
      response.status(206);
      response.setHeader('Content-Range', `bytes ${start}-${wanted.end}/${opened.size}`);
    }

    await this.data.receive(opened.token, start, length, response);
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

/**
 * A STRONG validator, because `If-Range` is only useful with one.
 *
 * Built from the id, the modification time and the size the agent just measured. A weak tag would
 * make every conditional range request fall back to a full download, which on a NAS is the case
 * that matters most.
 */
function etagOf(entry: FileEntryRow, size: number): string {
  return `"${entry.id}-${entry.updated_at.getTime().toString(36)}-${size.toString(36)}"`;
}

/**
 * `bytes=a-b`, `bytes=a-` and `bytes=-n`, and nothing else.
 *
 * A multi-range request is answered as a full body rather than as `multipart/byteranges`: no
 * browser needs it for a download, and a partial implementation of it is a source of
 * misassembled files. Returning `null` means "send the whole thing", which is what RFC 9110
 * permits for a range a server chooses not to honour.
 */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  if (rawStart === '') {
    // A suffix range: the LAST n bytes. `bytes=-0` asks for nothing, which is unsatisfiable
    // rather than an empty success — the difference matters because a client that gets 200 with
    // no body will believe the file is empty.
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'unsatisfiable';
    const start = Math.max(0, size - suffix);
    return size === 0 ? 'unsatisfiable' : { start, end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return 'unsatisfiable';
  // An absent end means "to the end of the file"; an end past it is CLAMPED rather than refused,
  // which is what RFC 9110 §14.1.1 requires.
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isSafeInteger(end) || end < start) return 'unsatisfiable';
  return { start, end };
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
