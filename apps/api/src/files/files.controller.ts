import {
  BadRequestException,
  Headers,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
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
import { AgentRefusedError, AgentUnavailableError } from '../agent/agent.service.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import {
  CrossShareMoveError,
  DirectoryNotEmptyError,
  EntryMissingOnDiskError,
  EntryNotFoundError,
  FilesService,
  FolderNotOnDiskError,
  InvalidNameError,
  MoveIntoDescendantError,
  NameTakenError,
  NotTrashedError,
  TrashedParentError,
  type FileEntryRow,
} from './files.service.js';

type Schemas = OpenApi.components['schemas'];

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * What a tenant member can do with an entry, until §6.2's grant walk exists.
 *
 * `permissions` became required on `FileEntry` when 0015 landed the teams-and-grants schema, but
 * the half that computes it — the per-page ancestor walk over `folder_grants` — is a later round.
 * Until then this is not a placeholder: it is the true answer. Every endpoint under `/files` today
 * admits any authenticated member of the tenant and narrows by RLS alone, so every row in a
 * caller's listing really does carry exactly these seven.
 *
 * The four that are missing — `share`, `manage`, `versions`, `audit` — are missing because this
 * server has no endpoint behind them. Claiming them would be worse than understating: the
 * contract's own reason for putting permissions on the row is so the UI does not draw a button the
 * server will refuse, and a `versions` here draws precisely that button.
 *
 * When the grant walk lands it replaces this constant, and the shape callers read does not change.
 */
const MEMBER_PERMISSIONS: readonly Schemas['FolderPermission'][] = [
  'list',
  'read',
  'download',
  'create',
  'modify',
  'move',
  'delete',
];

const createFolderSchema = z.object({
  parentId: z.string().uuid().nullish(),
  name: z.string().min(1).max(255),
});

/**
 * `UpdateFileRequest`: a rename, a move, or both, with `minProperties: 1`.
 *
 * `parentId` is `.nullable().optional()` rather than `.nullish()` because the two absent-looking
 * values mean opposite things here. Missing means "leave the parent alone"; an explicit `null`
 * means "move to the share root". Collapsing them would make every rename silently a move.
 */
const updateFileSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    parentId: z.string().uuid().nullable().optional(),
  })
  .refine((body) => body.name !== undefined || body.parentId !== undefined, {
    message: 'give a name, a parentId, or both',
  });

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
    private readonly data: AgentDataService,
  ) {}

  /**
   * A folder's contents, or the trash.
   *
   * The trash is a filter on this route rather than a route of its own, and the contract says why:
   * `trashed_at` is a column, so the bin has no id and no place in the tree to navigate to. When
   * it is asked for, `parentId` is ignored rather than combined — a trashed folder's children keep
   * pointing at it, so "the trash under folder X" would list rows whose own parent is not in the
   * trash at all, which is not a set any user asked about.
   */
  @Get()
  async list(
    @Req() request: AuthenticatedRequest,
    @Query('parentId') parentId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('trashed') trashed?: string,
  ): Promise<Schemas['FileEntryPage']> {
    const session = requireSession(request);
    const after = cleanCursor(cursor);
    const share = await this.share(request);

    if (isTrue(trashed)) {
      return toPage(
        await this.files.listTrash(session.organizationId, share.id, after, clampLimit(limit)),
      );
    }

    // A parent from another share, or a trashed one, must read as absent rather than empty: an
    // empty page would tell the caller the folder exists.
    if (parentId !== undefined) {
      requireUuid(parentId);
      const parent = await this.load(session.organizationId, parentId);
      if (parent.share_id !== share.id || parent.trashed_at !== null) throw new NotFoundException();
    }

    return toPage(
      await this.files.list(
        session.organizationId,
        share.id,
        parentId ?? null,
        after,
        clampLimit(limit),
      ),
    );
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
    requireUuid(id);
    const row = await this.load(session.organizationId, id);
    return { ...toEntry(row), createdAt: row.created_at.toISOString() };
  }

  /**
   * Rename, move, or both.
   *
   * A move is two stores: the row's `parent_id` (plus the derived `path` of the whole subtree) and
   * the bytes' location inside the share. The second one belongs to the agent, and the order is
   * fixed — `FilesService.move` asks the agent first and writes the row only after the rename has
   * happened. Reversed, a refused rename would leave the row pointing at a place the file is not,
   * and every download of that file would 404 while SMB still showed it in the old folder.
   *
   * A rename with no `parentId` reaches the agent too, whenever the entry is a FILE:
   * `FilesService.rename` routes it through `move` with the parent it already has. It used to
   * change the row alone, which made `{name}` and `{parentId, name}` two spellings of one request
   * that produced two different truths — and the database-only one left the bytes under the old
   * name, where a later permanent delete abandoned them on disk with no row to reach them by. A
   * FOLDER still renames in the database alone, because it has no directory there to rename
   * (`createFolder` explains why); that branch is unblocked by the same missing operation as the
   * move-into-a-folder case, namely that the agent cannot create a directory.
   *
   * 503 is not in the contract for this operation and is answered anyway. A move needs the agent,
   * the agent can be absent on a box whose storage is not set up, and the alternatives are a 500
   * — which says the server is broken when it is merely not ready — or a database-only move, which
   * is the divergence above. The document should gain it; see the notes with this change.
   */
  @Patch(':id')
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Schemas['FileEntry']> {
    const session = requireSession(request);
    requireUuid(id);
    const parsed = updateFileSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('give a name, a parentId (uuid or null), or both');
    }

    const name = parsed.data.name;

    if (parsed.data.parentId !== undefined) {
      const share = await this.share(request);
      // Checked before anything is read or written. A move that discovers the agent is gone
      // halfway through would already have answered the caller's question with a side effect.
      if (!this.files.agentAvailable()) {
        throw new ServiceUnavailableException(
          'the system agent is not reachable; an entry cannot be moved without moving its bytes',
        );
      }
      try {
        return toEntry(
          await this.files.move(
            session.organizationId,
            id,
            share,
            { parentId: parsed.data.parentId, ...(name === undefined ? {} : { name }) },
            randomUUID(),
            `PATCH /files/${id}`,
          ),
        );
      } catch (error) {
        throw translate(error);
      }
    }

    // The schema's `minProperties: 1` refinement already guarantees this, but zod expresses that
    // as a runtime check and not in the inferred type, so `name` is still `string | undefined`
    // here. Narrowed rather than asserted, because `no-non-null-assertion` is on and — more to the
    // point — an assertion here would become a lie the day the refinement is edited.
    if (name === undefined) throw new BadRequestException('name is required');

    // The share is resolved for a name-only rename too, because a file's rename IS a move: same
    // parent, new name, one `renameat2` in the agent. `FilesService.rename` decides which kind it
    // is and routes accordingly, and this route used to be the one that skipped the agent — the
    // divergence that let a permanently deleted file leave its bytes behind. No `agentAvailable`
    // pre-check to match the branch above: the agent is the FIRST thing a file rename touches, so
    // an unreachable one fails before anything has changed, while a folder rename never needs it
    // and must not start answering 503 because a daemon is down.
    const share = await this.share(request);
    try {
      return toEntry(
        await this.files.rename(
          session.organizationId,
          id,
          name,
          share,
          randomUUID(),
          `PATCH /files/${id}`,
        ),
      );
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * Take an entry back out of the trash.
   *
   * 200 rather than 201: nothing is created, an existing row's `trashed_at` is cleared and the id
   * the caller already holds keeps working. Nest defaults `@Post` to 201, hence the explicit code.
   */
  @Post(':id/restore')
  @HttpCode(200)
  async restore(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<Schemas['FileEntry']> {
    const session = requireSession(request);
    requireUuid(id);
    try {
      return toEntry(await this.files.restore(session.organizationId, id));
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
    requireUuid(id);
    try {
      return toEntry(await this.files.trash(session.organizationId, id, session.userId));
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * Delete the bytes. There is no undo behind this one.
   *
   * 204 and no body: the entry the caller named does not exist any more, so returning a
   * representation of it would be describing something that is gone.
   *
   * Only from the trash. The trash is the click between a user and permanent data loss, and an
   * endpoint that skipped it on request would make it optional — which is the same as not having
   * one. An entry that is not in the bin gets 409 and not 404: it EXISTS, it is simply not in the
   * state this operation works on, and "move it to the trash first" is something the caller can
   * act on.
   *
   * Not atomic for a folder, and the contract says so. Each node is removed from the disk and then
   * from the database, leaves first; an interruption leaves the removed ones removed and the rest
   * in the trash, and calling again continues where it stopped.
   */
  @Delete(':id/permanent')
  @HttpCode(204)
  async purge(@Req() request: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
    const session = requireSession(request);
    requireUuid(id);
    const share = await this.share(request);
    // Before the walk, so that an absent agent costs no rows. The alternative — discovering it on
    // the first `RemoveEntry` — is the same answer to the caller with part of a tree deleted.
    if (!this.files.agentAvailable()) {
      throw new ServiceUnavailableException(
        'the system agent is not reachable; nothing can be deleted from disk',
      );
    }

    try {
      await this.files.purge(
        session.organizationId,
        id,
        share,
        randomUUID(),
        `DELETE /files/${id}/permanent`,
      );
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
    requireUuid(id);
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
    try {
      return await this.files.shareOf(session.organizationId);
    } catch (error) {
      throw translate(error);
    }
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

/**
 * A service page as the contract's `FileEntryPage`.
 *
 * `nextCursor` is omitted rather than sent as null when there is no next page. `exactOptionalPropertyTypes`
 * forbids assigning `undefined` to an optional property, and the schema does not make the field
 * nullable — so a client that checks `'nextCursor' in page` gets the right answer.
 */
export function toPage(source: {
  items: FileEntryRow[];
  nextCursor: string | null;
  hasMore: boolean;
}): Schemas['FileEntryPage'] {
  return {
    items: source.items.map(toEntry),
    ...(source.nextCursor === null ? {} : { nextCursor: source.nextCursor }),
    hasMore: source.hasMore,
  };
}

/**
 * An id that is not a UUID is "no such entry", not a fault.
 *
 * Every id in this controller reaches PostgreSQL as a `uuid`, so a mistyped one comes back as
 * SQLSTATE 22P02 and — with nothing mapping it — surfaces as a 500. That is an error page for a bad
 * link, and it also distinguishes a malformed id from a well-formed one naming another tenant's
 * row, which is precisely the distinction RLS exists to erase.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuid(id: string): void {
  if (!UUID.test(id)) throw new NotFoundException();
}

/**
 * A cursor, checked before it reaches a `::uuid` cast.
 *
 * 400 and not 404, unlike an id: the contract says a client never constructs a cursor, only echoes
 * one the server gave it, so a malformed one is a broken client rather than a missing resource and
 * saying so is what makes it findable.
 */
export function cleanCursor(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null;
  if (!UUID.test(raw)) throw new BadRequestException('cursor is not one this server issued');
  return raw;
}

/**
 * A query-string boolean.
 *
 * Only the two spellings a URL actually carries a `true` as. Anything else — including `1`, `yes`
 * and an empty `?trashed` — is false, because guessing at a caller's intent here decides whether
 * they are shown their files or their bin.
 */
export function isTrue(raw: string | undefined): boolean {
  return raw === 'true' || raw === 'TRUE';
}

function clampLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

export function toEntry(row: FileEntryRow): Schemas['FileEntry'] {
  return {
    // Copied, not shared: the constant is this module's, and handing callers a reference to it
    // makes one mutation anywhere rewrite every future response.
    permissions: [...MEMBER_PERMISSIONS],
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
  if (error instanceof NameTakenError) {
    // The message is the whole value of this answer. A bare 409 tells a user their restore failed;
    // this one tells them the name is taken and that renaming the other file is the way out.
    return new ConflictException(`${error.message}; rename one of them and try again`);
  }
  if (error instanceof TrashedParentError) return new ConflictException(error.message);
  if (error instanceof InvalidNameError) return new BadRequestException(error.message);
  // Four ways a move or a permanent delete can be refused, all of them 409 and all of them
  // carrying their own sentence. A bare 409 on this group would be indistinguishable to a user
  // from the name collision above, and the four have four different remedies.
  if (error instanceof CrossShareMoveError) return new ConflictException(error.message);
  if (error instanceof MoveIntoDescendantError) return new ConflictException(error.message);
  if (error instanceof NotTrashedError) return new ConflictException(error.message);
  if (error instanceof FolderNotOnDiskError) {
    return new ConflictException(logged(error.message, error.agentReason));
  }
  if (error instanceof EntryMissingOnDiskError) {
    return new ConflictException(logged(error.message, error.agentReason));
  }
  if (error instanceof DirectoryNotEmptyError) {
    return new ConflictException(logged(error.message, error.agentReason));
  }
  // The agent was reached and said no. 409 rather than 500: every refusal it can answer these
  // operations with is a state the caller can do something about, and a 500 is what a client
  // retries blindly. What the caller does NOT get is the agent's sentence: for these operations it
  // can be `SeamError::Io("rmdir x: Directory not empty (os error 39)")` or a paragraph about
  // openat2 and kernel versions, which is journal material and not an instruction to a user.
  if (error instanceof AgentRefusedError) {
    return new ConflictException(
      logged('the storage agent refused this operation', error.agentReason),
    );
  }
  // The agent was not reached. Nothing was necessarily done, and the box is not broken — its
  // storage side is not answering, which is the condition 503 names.
  if (error instanceof AgentUnavailableError) return new ServiceUnavailableException(error.message);
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Keep the agent's prose out of the response and in the journal, and return the public sentence.
 *
 * Written as one function so the two halves cannot drift apart — a branch that returned a fixed
 * message and forgot to log would make a refusal undiagnosable, which is worse than the disclosure
 * this exists to prevent.
 */
function logged(publicMessage: string, agentReason: string): string {
  translateLogger.warn(`${publicMessage}: ${agentReason}`);
  return publicMessage;
}

/**
 * A standalone logger because `translate` is a free function.
 *
 * It is called from the controller's catch blocks and from `SearchController`, so making it a
 * method would mean either an instance per controller or threading one through every call site.
 */
const translateLogger = new Logger('FilesController');
