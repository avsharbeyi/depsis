import {
  BadRequestException,
  Headers,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
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
  UseInterceptors,
} from '@nestjs/common';
import { sortPermissions, type Permission } from '@depsis/authz';
import type { OpenApi } from '@depsis/contracts';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { AgentDataService } from '../agent/agent-data.service.js';
import { AgentRefusedError, AgentUnavailableError } from '../agent/agent.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { ThumbnailsService, ThumbnailUnreadableError } from './thumbnails.service.js';
import { TrashRetentionService } from './trash-retention.service.js';
import { ProblemException } from '../common/problem.filter.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import {
  PosixIdentityUnavailableError,
  PosixIdentityUnknownUserError,
} from '../identity/posix.service.js';
import {
  ArchiveTooLargeError,
  assertWritable,
  CrossShareMoveError,
  DirectoryNotEmptyError,
  EntryMissingOnDiskError,
  EntryNotFoundError,
  FilesService,
  FolderNotOnDiskError,
  InvalidNameError,
  MoveIntoDescendantError,
  NameTakenByTrashedEntryError,
  NameTakenError,
  NameTakenOnDiskError,
  StagedBytesGoneError,
  NotTrashedError,
  permissionsOf,
  ShareReadOnlyError,
  SubtreeForbiddenError,
  TrashedParentError,
  type Caller,
  type FileEntryPage,
  type FileEntryRow,
  type ShareRow,
  type SortDirection,
  type SortOrder,
} from './files.service.js';

type Schemas = OpenApi.components['schemas'];

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const createFolderSchema = z.object({
  parentId: z.string().uuid().nullish(),
  name: z.string().min(1).max(255),
  // Which share a TOP-LEVEL folder goes in. Ignored when `parentId` is given, because the parent
  // already decides it and two answers would be one too many. Absent means the tenant's default,
  // which is what every client did before there was more than one share.
  shareId: z.string().uuid().nullish(),
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
 *
 * Every route also asks §6.2's question, and each asks it for the permission its own operation
 * needs: reading a folder is `list`, fetching bytes is `download`, moving is `move` at the source
 * AND `create` at the destination. Until this round the answer was "any member of the tenant, and
 * RLS decides the rest", which meant a NAS on which a folder could not be opened to one team and
 * closed to another — the most basic job of a multi-user appliance, missing.
 *
 * 404 AND 403 ARE BOTH USED, AND THE LINE BETWEEN THEM IS `list`. A caller who cannot `list` an
 * entry does not see it in any listing, so telling them 403 on a direct request would hand back
 * exactly the fact the listing withheld — that a row with this id exists. They get 404. A caller
 * who CAN see the entry and is missing the permission for this particular operation gets 403,
 * because they already know it exists and 404 would be a lie they could disprove by listing its
 * folder. `requirePermission` is the one place that decision is made.
 */
@Controller('files')
@UseGuards(SessionGuard)
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly data: AgentDataService,
    private readonly retention: TrashRetentionService,
    private readonly thumbs: ThumbnailsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * A folder's contents, or the trash.
   *
   * The trash is a filter on this route rather than a route of its own, and the contract says why:
   * `trashed_at` is a column, so the bin has no id and no place in the tree to navigate to. When
   * it is asked for, `parentId` is ignored rather than combined — a trashed folder's children keep
   * pointing at it, so "the trash under folder X" would list rows whose own parent is not in the
   * trash at all, which is not a set any user asked about.
   *
   * ROWS THE CALLER CANNOT `list` ARE NOT IN THE ANSWER. Not greyed out and not returned with an
   * empty permission array: absent. A file name is information on its own — `Q3 layoffs.xlsx` in a
   * folder somebody cannot open still says what it says — so hiding the row is the only version of
   * this that means anything.
   *
   * The named `parentId` itself is refused with 404 when the caller cannot `list` it, which is the
   * same answer the checks below it already give for a parent in the bin or in a share the request
   * explicitly named something else. A caller whose only grant is on a deep subfolder therefore
   * reaches it by its id and not by walking down from a root they cannot read, and the
   * intermediate folders never appear.
   *
   * PAYLAŞIMI PARENT SATIRI BELİRLER, istek değil. `shareId` gelmediğinde istekten çözülen şey
   * kiracının VARSAYILAN paylaşımıdır (`shareFor(org, undefined)`), yani ikinci bir paylaşımdaki
   * her klasör "başka paylaşımda" görünüp 404 alıyordu — web klasöre inerken `shareId`
   * göndermediği için o paylaşımın hiçbir klasörü açılamıyordu. Diğer bütün per-entry rotalar gibi
   * burası da satırın kendi `share_id`sini kullanıyor (`shareOfEntry`); istek AÇIKÇA başka bir
   * paylaşım adlandırdıysa çelişki 404'tür — `createFolder`daki "ikisi uyuşmalı" ilkesiyle aynı.
   *
   * The ROOT listing takes no such check: there is no id in the request to conceal, and filtering
   * its rows already reduces it to what the caller may see — for somebody with one deep grant,
   * nothing.
   */
  @Get()
  async list(
    @Req() request: AuthenticatedRequest,
    @Query('parentId') parentId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('trashed') trashed?: string,
    @Query('shareId') shareId?: string,
    @Query('sort') sort?: string,
    @Query('direction') direction?: string,
  ): Promise<Schemas['FileEntryPage']> {
    const caller = requireSession(request);
    const after = cleanCursor(cursor);
    // İstek paylaşımı: `shareId` biçim ve kiracı doğrulamasını burada geçiyor. Çöp dalı ve kök
    // listelemesi bunu kullanıyor; `parentId` verildiğinde aşağıda satırın paylaşımıyla değişiyor.
    let share = await this.share(request, shareId);
    const order = cleanSort(sort);
    const way = cleanDirection(direction);

    if (isTrue(trashed)) {
      // The policy comes with the page: without it every row would show no expiry, which is what
      // an interface says when nothing is scheduled — and that would be the same screen whether
      // the bin empties on Tuesday or never.
      const { retentionDays } = await this.retention.policy(caller.organizationId);
      return this.visible(
        caller,
        share.id,
        await this.files.listTrash(caller.organizationId, share.id, after, clampLimit(limit)),
        retentionDays,
      );
    }

    // A trashed parent, or one in a share the request explicitly named something else, must read
    // as absent rather than empty: an empty page would tell the caller the folder exists.
    if (parentId !== undefined) {
      requireUuid(parentId);
      const parent = await this.load(caller.organizationId, parentId);
      if (parent.trashed_at !== null) throw new NotFoundException();
      const parentShare = await this.shareOfEntry(caller.organizationId, parent);
      if (shareId !== undefined && parentShare.id !== share.id) throw new NotFoundException();
      share = parentShare;
      await this.permit(caller, share.id, parentId, 'list');
    }

    return this.visible(
      caller,
      share.id,
      await this.files.list(
        caller.organizationId,
        share.id,
        parentId ?? null,
        after,
        clampLimit(limit),
        order,
        way,
      ),
    );
  }

  /**
   * Create a folder.
   *
   * 503 when the agent is unreachable, and it is not optional. Creating a folder is now a
   * filesystem operation before it is a database one (`FilesService.createFolder`), so with no
   * agent there is nothing this endpoint can do except write the row alone — which is the exact
   * state the change was made to end. Checked up front so the caller is refused before anything is
   * read or written, rather than discovering it mid-way.
   *
   * `agentAvailable()` answers a narrower question than it looks like: whether the SOCKET is
   * configured, not whether the appliance has storage. An agent running without
   * `DEPSIS_SHARES_ROOT` is reachable and refuses every path operation, and that case is NOT
   * covered by the sentence above — it is answered 409, like a name collision. The "KNOWN GAP"
   * note above `NameTakenByTrashedEntryError` in `files.service.ts` says why separating it needs a
   * protocol change rather than a mapping change: `refused` is not one condition, and telling its
   * causes apart would mean matching on the agent's prose.
   *
   * THIS OPERATION ANSWERS STATUS CODES THE CONTRACT DOES NOT LIST, in the same way `PATCH
   * /files/{id}` does and says so. `depsis.yaml` gives 201/403/409/422 for `POST /files/folders`;
   * this also answers 503 (agent unreachable, storage not set up, or no POSIX identity available)
   * and 401 (`PosixIdentityUnknownUserError` — the session names an account deleted since
   * sign-in). Writing it down rather than leaving the deviation silent: the yaml is out of scope
   * for the change that introduced these, and adding 401/503 to this operation is the next turn's
   * job.
   */
  // §8's `Idempotency-Key`, on the route the contract declares it on. Without a key the request
  // behaves exactly as before; with one, a client that lost the response and retried gets the
  // first answer back instead of a second folder.
  @UseInterceptors(IdempotencyInterceptor)
  @Post('folders')
  async createFolder(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['FileEntry']> {
    const caller = requireSession(request);
    const parsed = createFolderSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('parentId must be a uuid and name a string');

    // `create` belongs to the DESTINATION, so it is asked of the parent and not of the new folder,
    // which does not exist yet and could not carry a grant if it did.
    const parentId = parsed.data.parentId ?? null;
    // THE ONE ROUTE THAT TAKES ITS SHARE FROM THE REQUEST, because there is no entry to ask: the
    // folder does not exist yet. A parent, when given, decides it — and the two must agree, or a
    // caller could name share A and a parent in share B.
    const share =
      parentId === null
        ? await this.share(request, parsed.data.shareId ?? undefined)
        : await this.shareOfEntry(
            caller.organizationId,
            await this.load(caller.organizationId, parentId),
          );
    await this.permit(caller, share.id, parentId, 'create');
    requireWritableShare(share);

    if (!this.files.agentAvailable()) {
      throw new ServiceUnavailableException(
        'the system agent is not reachable; a folder cannot be created without its directory',
      );
    }

    try {
      const row = await this.files.createFolder(
        caller.organizationId,
        share,
        parentId,
        parsed.data.name,
        caller.userId,
        randomUUID(),
        'POST /files/folders',
      );
      return toEntry(row, await this.files.effectiveAt(caller, share.id, row.id));
    } catch (error) {
      throw translate(error);
    }
  }

  @Get(':id')
  async detail(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
  ): Promise<Schemas['FileEntryDetail']> {
    const caller = requireSession(request);
    requireUuid(id);
    const row = await this.load(caller.organizationId, id);
    const share = await this.shareOfEntry(caller.organizationId, row);
    const effective = await this.permit(caller, share.id, id, 'list');
    // The validator `PATCH` will compare against. Without it, `If-Match` would be a header a
    // client could satisfy only by guessing how the server builds one — which is another way of
    // saying it could not be used.
    response.setHeader('ETag', metadataEtag(row));
    return { ...toEntry(row, effective), createdAt: row.created_at.toISOString() };
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
   * A rename with no `parentId` reaches the agent too, for files and folders alike:
   * `FilesService.rename` routes it through `move` with the parent it already has. It used to
   * change the row alone, which made `{name}` and `{parentId, name}` two spellings of one request
   * that produced two different truths — and the database-only one left the bytes under the old
   * name, where a later permanent delete abandoned them on disk with no row to reach them by. The
   * folder exception that survived that fix is gone with `CreateDirectory`: a folder has a real
   * directory now, so renaming the row alone would leave the directory — and everything inside
   * it — under the old name.
   *
   * 503 is not in the contract for this operation and is answered anyway. A move needs the agent,
   * the agent can be absent on a box whose storage is not set up, and the alternatives are a 500
   * — which says the server is broken when it is merely not ready — or a database-only move, which
   * is the divergence above. The document should gain it; see the notes with this change.
   *
   * A MOVE IS CHECKED AT BOTH ENDS, which §6.2 states outright and `canMove` in `packages/authz`
   * exists so that no call site can express half of. `move` on the entry is permission to take it
   * out of where it is; `create` in the destination is permission to put it there. Checking only
   * the source would let anyone who may tidy their own folder drop a file into a folder they have
   * never been given; checking only the destination would let them empty somebody else's.
   */
  /**
   * Refuse a `PATCH` whose client is looking at a stale copy.
   *
   * `*` means "the resource must exist", which `load` has already established by the time this
   * returns — so it passes. A list of tags matches if ANY of them does, per RFC 9110; clients that
   * hold several versions of a resource are rare, and honouring the list costs one `some`.
   *
   * Weak tags (`W/"..."`) never match here and that is the specification's rule rather than a
   * simplification: `If-Match` requires strong comparison, because a weak validator says two
   * representations are equivalent — not that they are the same one, which is what a conditional
   * write has to know.
   */
  private async requireIfMatch(
    organizationId: string,
    id: string,
    header: string | undefined,
  ): Promise<void> {
    if (header === undefined || header.trim() === '') return;
    const want = header.trim();

    const row = await this.load(organizationId, id);
    if (want === '*') return;

    const current = metadataEtag(row);
    const offered = want.split(',').map((tag) => tag.trim());
    if (offered.some((tag) => tag === current)) return;

    throw new ProblemException(
      'precondition-failed',
      'Bu dosya siz görüntüledikten sonra değişti. Yenileyip tekrar deneyin.',
    );
  }

  @Patch(':id')
  async update(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch?: string,
  ): Promise<Schemas['FileEntry']> {
    const caller = requireSession(request);
    requireUuid(id);
    const parsed = updateFileSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('give a name, a parentId (uuid or null), or both');
    }

    // AFTER the body is understood and BEFORE anything is decided. RFC 9110 §13.1.1 puts the
    // precondition ahead of the method's own semantics, and the practical reason is the one this
    // route exists for: two people renaming the same file from two tabs. Without this, the second
    // rename silently wins and the first person's change is gone with no error anywhere.
    //
    // The check is deliberately NOT inside the transaction that does the rename. It is a
    // best-effort guard against a stale client, not a lock — the row could still change between
    // here and the write. What makes that acceptable is that the database's own constraints
    // (`file_entries_name_unique`) are what actually keep the tree consistent; `If-Match` is what
    // turns "somebody else got there first" from a silent overwrite into a 412 the client can show.
    await this.requireIfMatch(caller.organizationId, id, ifMatch);

    const name = parsed.data.name;

    if (parsed.data.parentId !== undefined) {
      // From the entry being MOVED. A move within a share is the only kind there is —
      // `accessForMove` refuses a destination in another one — so the source's share is the
      // right root for both ends of the check.
      const share = await this.shareOfEntry(
        caller.organizationId,
        await this.load(caller.organizationId, id),
      );
      const destinationId = parsed.data.parentId;
      const move = await this.files.accessForMove(caller, share.id, id, destinationId);
      // Invisible at either end is 404 at both, and the destination is the interesting half: a
      // caller who may move their file but cannot see the folder they aimed it at must not learn
      // from a 403 that the folder is there.
      if (!move.source.has('list')) throw new NotFoundException();
      if (destinationId !== null && !move.destination.has('list')) throw new NotFoundException();
      if (!move.allowed) {
        throw new ForbiddenException(
          "a move needs 'move' where the entry is and 'create' where it is going",
        );
      }
      // A move that also renames is still a rename, and `modify` is what a rename costs. Without
      // this, `{parentId, name}` would be a way to rename an entry that `{name}` alone refuses.
      if (name !== undefined && !move.source.has('modify')) {
        throw new ForbiddenException("renaming needs 'modify'");
      }
      // Taşımanın iki ucu da aynı paylaşımda (`accessForMove` başkasını reddediyor), yani tek bir
      // denetim iki ucu birden kapatıyor.
      requireWritableShare(share);
      // Checked before anything is read or written. A move that discovers the agent is gone
      // halfway through would already have answered the caller's question with a side effect.
      if (!this.files.agentAvailable()) {
        throw new ServiceUnavailableException(
          'the system agent is not reachable; an entry cannot be moved without moving its bytes',
        );
      }
      try {
        const row = await this.files.move(
          caller.organizationId,
          id,
          share,
          { parentId: destinationId, ...(name === undefined ? {} : { name }) },
          caller.userId,
          randomUUID(),
          `PATCH /files/${id}`,
        );
        // Resolved AGAIN, at the new location: the entry has new ancestors, so the set it inherits
        // is a different question from the one asked a moment ago. Returning the pre-move answer
        // would tell the client it can still do things the destination does not allow.
        return toEntry(row, await this.files.effectiveAt(caller, share.id, row.id));
      } catch (error) {
        throw translate(error);
      }
    }

    // The schema's `minProperties: 1` refinement already guarantees this, but zod expresses that
    // as a runtime check and not in the inferred type, so `name` is still `string | undefined`
    // here. Narrowed rather than asserted, because `no-non-null-assertion` is on and — more to the
    // point — an assertion here would become a lie the day the refinement is edited.
    if (name === undefined) throw new BadRequestException('name is required');

    // The share is resolved for a name-only rename too, because a rename IS a move: same parent,
    // new name, one `renameat2` in the agent. This route used to be the one that skipped the
    // agent — the divergence that let a permanently deleted file leave its bytes behind. No
    // `agentAvailable` pre-check to match the branch above: the agent is the FIRST thing a rename
    // touches, so an unreachable one fails before anything has changed and `translate` turns it
    // into the same 503 by a shorter road.
    const share = await this.shareOfEntry(
      caller.organizationId,
      await this.load(caller.organizationId, id),
    );
    const effective = await this.permit(caller, share.id, id, 'modify');
    requireWritableShare(share);
    try {
      return toEntry(
        await this.files.rename(
          caller.organizationId,
          id,
          name,
          share,
          caller.userId,
          randomUUID(),
          `PATCH /files/${id}`,
        ),
        // A rename does not move the entry, so its ancestors — and therefore its permissions — are
        // the ones just resolved.
        effective,
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
   *
   * The permission is `create`, and it is asked of the FOLDER THE ENTRY GOES BACK INTO rather than
   * of the entry. Restoring puts a name back into a directory, which is the same act `POST
   * /files/folders` and a completed upload perform, and asking it of the entry instead would let
   * somebody with rights over one deleted file re-populate a folder that has since been closed to
   * them. `list` on the entry itself is still required, so a bin row the caller cannot see is 404.
   */
  @Post(':id/restore')
  @HttpCode(200)
  async restore(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<Schemas['FileEntry']> {
    const caller = requireSession(request);
    requireUuid(id);
    const entry = await this.load(caller.organizationId, id);
    const share = await this.shareOfEntry(caller.organizationId, entry);

    // Both nodes in one walk: the entry, to decide whether it is visible at all, and its parent,
    // which is where the restore actually lands.
    const access = await this.files.accessFor(caller, share.id, [id, entry.parent_id]);
    const effective = permissionsOf(access, id);
    if (!effective.has('list')) throw new NotFoundException();
    if (!permissionsOf(access, entry.parent_id).has('create')) {
      throw new ForbiddenException("restoring needs 'create' in the folder it goes back into");
    }
    // Geri yükleme de bir yazma: ad klasörde yeniden görünür oluyor ve dosya ağ sürücüsünde
    // yeniden listeleniyor.
    requireWritableShare(share);

    try {
      return toEntry(await this.files.restore(caller.organizationId, id), effective);
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
    const caller = requireSession(request);
    requireUuid(id);
    const share = await this.shareOfEntry(
      caller.organizationId,
      await this.load(caller.organizationId, id),
    );
    const effective = await this.permit(caller, share.id, id, 'delete');
    // Çöpe atmak da yazma sayılıyor: satır listeden kalkıyor, ve salt okunur bir paylaşımda aynı
    // dosya ağ sürücüsünden silinemiyor — iki istemcinin aynı cevabı vermesi gerekiyor.
    requireWritableShare(share);
    // AND on everything under it. Trashing a folder sets one flag on one row, but `list` filters on
    // `trashed_at IS NULL`, so every descendant vanishes from every listing for everybody —
    // including descendants somebody narrowed this caller out of with a grant of their own. One
    // node's `delete` is not authority over a subtree, and the permanent delete below acts on the
    // same set of rows with no undo.
    await this.files.assertSubtreeAccess(caller, share.id, id, 'delete').catch((error: unknown) => {
      throw translate(error);
    });
    try {
      // Trashing changes a flag, not a parent, so the set resolved above is still the entry's.
      return toEntry(await this.files.trash(caller.organizationId, id, caller.userId), effective);
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
    const caller = requireSession(request);
    requireUuid(id);
    const doomed = await this.load(caller.organizationId, id);
    const share = await this.shareOfEntry(caller.organizationId, doomed);
    // The same permission the reversible delete asks for. A separate, stronger one would be a
    // fourth §6.2 permission the contract does not have — and the trash is already the gate
    // between a user and permanent loss, which is the protection this operation needs.
    await this.permit(caller, share.id, id, 'delete');
    requireWritableShare(share);
    // And on every descendant that carries a grant of its own, BEFORE the first `RemoveEntry`.
    // `FilesService.purge` walks the subtree and unlinks the bytes node by node; a check on the
    // named entry alone would let a caller who was deliberately narrowed out of one subfolder
    // destroy it by trashing its parent and emptying the bin. That is the exact grant ADR-0021
    // offers in place of a deny, and it is the one operation with no undo.
    await this.files.assertSubtreeAccess(caller, share.id, id, 'delete').catch((error: unknown) => {
      throw translate(error);
    });
    // Before the walk, so that an absent agent costs no rows. The alternative — discovering it on
    // the first `RemoveEntry` — is the same answer to the caller with part of a tree deleted.
    if (!this.files.agentAvailable()) {
      throw new ServiceUnavailableException(
        'the system agent is not reachable; nothing can be deleted from disk',
      );
    }

    const correlationId = randomUUID();
    try {
      await this.files.purge(
        caller.organizationId,
        id,
        share,
        correlationId,
        `DELETE /files/${id}/permanent`,
      );
    } catch (error) {
      throw translate(error);
    }

    // Geri dönüşü olmayan tek dosya işlemi, ve kaydı İŞTEN SONRA: yarıda kesilen bir silme
    // "silindi" satırı bırakmamalı. Adı denetimde var, içeriği yok (§16).
    await this.audit.record(caller.organizationId, {
      actorId: caller.userId,
      action: 'files.permanently-deleted',
      target: { kind: 'entry', id, label: doomed.name },
      summary: `'${doomed.name}' çöp kutusundan KALICI olarak silindi.`,
      correlationId,
    });
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
   *
   * ── `?inline=1`: YALNIZ PDF, VE YALNIZ UZANTIDAN ────────────────────────────────────────────
   *
   * Bu uç her zaman `Content-Disposition: attachment` gönderiyor, ve gerekçesi sağlam: kiracının
   * yüklediği bir HTML dosyasını API'nin kendi kökeninde satır içi sunmak, her oturuma karşı
   * depolanmış XSS demek. Ama o kural PDF önizlemesini de kapatıyordu — sahibi bir sözleşmeye
   * bakmak için onu diske indirmek zorunda kalıyordu (§5.1 PDF önizlemesini istiyor).
   *
   * Kapı UZANTIYLA açılıyor, `content_type` ile değil: ajan o sütunu her zaman doldurmuyor, yani
   * türe bakan bir kontrol aynı dosyayı bazen açar bazen açmazdı. Adı `.pdf` ile bitmeyen hiçbir
   * şeyde bayrak YOK SAYILIYOR (ret değil: istemci en kötü ihtimalle indirmeye düşer).
   *
   * Güvenliği tutan şey, türün DOSYADAN OKUNMAMASI: `.pdf` uzantılı bir HTML dosyası da
   * `application/pdf` olarak, `nosniff` ile gidiyor — tarayıcı onu PDF görüntüleyicisine verir ve
   * belge olarak asla çalıştırmaz. `nosniff` burada ayrıca yazılıyor çünkü nginx başlıklarına
   * güvenmek, API'ye doğrudan ulaşılan bir kurulumda kuralı sessizce kaldırmak olurdu.
   */
  @Get(':id/content')
  async content(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: false }) response: Response,
    @Param('id') id: string,
    @Headers('range') range?: string,
    @Headers('if-range') ifRange?: string,
    @Query('inline') inline?: string,
  ): Promise<void> {
    const caller = requireSession(request);
    requireUuid(id);
    const entry = await this.load(caller.organizationId, id);
    if (entry.kind !== 'file' || entry.trashed_at !== null) throw new NotFoundException();

    const share = await this.shareOfEntry(caller.organizationId, entry);
    // Before the agent is consulted, so that an unauthorised caller cannot use the 503 to learn
    // whether the appliance's storage is up.
    await this.permit(caller, share.id, id, 'download');

    if (!this.data.isAvailable()) {
      throw new ServiceUnavailableException('the system agent is not reachable');
    }

    const components = await this.files
      .componentsOf(caller.organizationId, id)
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

    // Satır içi açılabilecek tek tür, ve türü DOSYA DEĞİL AD söylüyor — yukarıdaki nota bak.
    const asPdf = servesInline(entry.name, inline);

    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('ETag', etag);
    response.setHeader('Content-Length', String(length));
    response.setHeader(
      'Content-Type',
      asPdf ? 'application/pdf' : (entry.content_type ?? 'application/octet-stream'),
    );
    // `attachment` is not a nicety. Serving a tenant-supplied file inline on the API's own origin
    // makes an uploaded HTML file a stored XSS against every other tenant's session.
    response.setHeader(
      'Content-Disposition',
      `${asPdf ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
    );
    if (asPdf) response.setHeader('X-Content-Type-Options', 'nosniff');
    if (wanted !== null) {
      response.status(206);
      response.setHeader('Content-Range', `bytes ${start}-${wanted.end}/${opened.size}`);
    }

    await this.data.receive(opened.token, start, length, response);
  }

  /**
   * Bir klasörün tamamı, tek bir `.tar.gz` olarak.
   *
   * ── NEDEN VAR ────────────────────────────────────────────────────────────────────────────
   *
   * İndirme düğmesi klasörlerde ÇİZİLMİYORDU, ve karışık bir seçimde klasörler sessizce
   * atlanıyordu: iki klasör ve bir dosya seçip indirmeye basan biri tek dosya alıyor, eksiğin
   * farkına ancak diskte sayarsa varıyordu. Sessiz eksik, açık bir rettten kötü.
   *
   * ── ARALIK YOK, ETAG YOK ─────────────────────────────────────────────────────────────────
   *
   * `Accept-Ranges: none`, ve bu bir eksik değil bir ifade: arşiv her istekte YENİDEN üretiliyor,
   * yani iki isteğin baytları birebir aynı olmak zorunda değil (gzip zaman damgası taşıyor). Bir
   * aralık isteği ikinci bir arşivin ortasından okurdu. Aynı sebeple ETag de yok — kararlı bir
   * kimlik iddia etmek, olmayan bir kararlılığı söylemek olurdu.
   *
   * ── ALT AĞACIN TAMAMINA `download` ───────────────────────────────────────────────────────
   *
   * ADR-0021'e göre bir alt klasör üstündekinden DAHA AZINI verebiliyor, ve `tar` kök yetkiyle
   * koşuyor: yalnız klasörün kendisine bakan bir denetim, çağıranın içerideki bir klasörde
   * indirme hakkı olmasa bile onu arşivin içine koyardı. Silme yolundaki `assertSubtreeAccess`
   * tam bu yüzden var ve burada da aynı işi görüyor. Arşivin bir kısmını atlamak seçenek değil:
   * eksiğini söylemeyen bir arşiv, eksik olduğunu bilmeyen bir kullanıcı demek.
   */
  @Get(':id/archive')
  async archive(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: false }) response: Response,
    @Param('id') id: string,
  ): Promise<void> {
    const caller = requireSession(request);
    requireUuid(id);
    const entry = await this.load(caller.organizationId, id);
    if (entry.kind !== 'folder' || entry.trashed_at !== null) throw new NotFoundException();

    const share = await this.shareOfEntry(caller.organizationId, entry);
    await this.permit(caller, share.id, id, 'download');
    await this.files
      .assertSubtreeAccess(caller, share.id, id, 'download')
      .catch((error: unknown) => {
        throw translate(error);
      });

    if (!this.data.isAvailable()) {
      throw new ServiceUnavailableException('the system agent is not reachable');
    }

    const components = await this.files
      .componentsOf(caller.organizationId, id)
      .catch((error: unknown) => {
        throw translate(error);
      });

    // Ne kadar yer gerekeceği. `find` bu sütunu üretmiyor — tek satır okuyan her yol için alt ağaç
    // toplamak boşa iş — o yüzden burada ayrıca soruluyor.
    const estimate = await this.files.subtreeBytes(caller.organizationId, id);

    const correlationId = randomUUID();
    const opened = await this.files
      .openArchive(share, components, estimate, correlationId, `GET /files/${id}/archive`)
      .catch((error: unknown) => {
        if (error instanceof AgentRefusedError) {
          throw error.agentReason.includes('reader')
            ? new ConflictException(error.agentReason)
            : new NotFoundException();
        }
        throw translate(error);
      });

    response.setHeader('Accept-Ranges', 'none');
    response.setHeader('Content-Length', String(opened.size));
    response.setHeader('Content-Type', 'application/gzip');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(`${entry.name}.tar.gz`)}`,
    );

    await this.data.receive(opened.token, 0, opened.size, response);
  }

  /**
   * Gömülü küçük resim.
   *
   * `download` İZNİ İSTİYOR, `read` değil. Bir küçük resim içeriğin küçültülmüş bir kopyası: adını
   * görebilen ama baytlarını alamayan birine onu göstermek, izni tam olarak atlatmak olurdu.
   *
   * KÜÇÜK RESMİ OLMAYAN DOSYA İÇİN 204, 404 DEĞİL — ve fark hem anlamsal hem pratik.
   *
   * Anlamsal olan: 404 "böyle bir şey yok" demek, ve girdinin kendisi VAR — çağıran onu görüyor ve
   * indirebiliyor. Olmayan tek şey gömülü bir küçük resim, ki ekran görüntülerinin ve EXIF'siz
   * resimlerin çoğunda olmaması normal. 404'ü ikisi için birden kullanmak, "görme yetkin yok" ile
   * "bu fotoğrafta küçük resim yok"u tek cevaba çevirirdi.
   *
   * Pratik olan: 4xx tarayıcı konsoluna bir hata satırı yazıyor. Yüz fotoğrafın seksen tanesinde
   * küçük resim yoksa, bir klasörü açmak seksen kırmızı satır demek — ve bir geliştirici konsolunu
   * okunmaz yapan gürültü, gerçek hataların görülmemesinin yolu. 204 sessiz.
   *
   * 404 yalnız gerçekten yokluk için: girdi yok, ya da çağıran onu göremiyor.
   *
   * `inline` DEĞİL, ve bu indirme ucundaki kararla aynı: `attachment`. Ama burada ek bir sebep
   * var — dönen baytlar `exif-thumbnail.ts`'in SOI kontrolünden geçmiş, yani gerçekten bir JPEG.
   * Yine de kendi kaynağımızda satır içi sunmuyoruz, çünkü "gerçekten bir JPEG" ile "zararsız"
   * aynı şey değil.
   */
  @Get(':id/thumbnail')
  async thumbnail(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: false }) response: Response,
    @Param('id') id: string,
  ): Promise<void> {
    const caller = requireSession(request);
    requireUuid(id);
    const entry = await this.load(caller.organizationId, id);
    if (entry.kind !== 'file' || entry.trashed_at !== null) throw new NotFoundException();

    const share = await this.shareOfEntry(caller.organizationId, entry);
    await this.permit(caller, share.id, id, 'download');

    if (!this.data.isAvailable()) {
      throw new ServiceUnavailableException('the system agent is not reachable');
    }

    const components = await this.files
      .componentsOf(caller.organizationId, id)
      .catch((error: unknown) => {
        throw translate(error);
      });

    const found = await this.thumbs
      .of(
        id,
        Number(entry.size_bytes),
        entry.updated_at,
        share.name,
        components,
        randomUUID(),
        `GET /files/${id}/thumbnail`,
      )
      .catch((error: unknown) => {
        // Ajanın reddi indirmedekiyle aynı kapalı küme, ve aynı cevaplara çevriliyor: dosya
        // gitmiş, ya da başkası okuyor.
        if (error instanceof AgentRefusedError) {
          throw error.agentReason.includes('reader')
            ? new ConflictException(error.agentReason)
            : new NotFoundException();
        }
        // Okunamadı: 503, 204 DEĞİL. 204 "bu fotoğrafta küçük resim yok" demek, ve bir aksaklığı
        // öyle çevirmek istemciye asla düzelmeyecek bir olgu bildirmek olurdu.
        if (error instanceof ThumbnailUnreadableError) {
          throw new ServiceUnavailableException('küçük resim okunamadı');
        }
        throw error;
      });
    if (found === null) {
      response.status(204).end();
      return;
    }

    response.setHeader('Content-Type', 'image/jpeg');
    response.setHeader('Content-Length', String(found.bytes.length));
    // Yönlendirme BAŞLIKTA, ve piksellere dokunulmadığı için burada: gömülü küçük resim ana
    // görüntüyle aynı yönde saklanıyor, ve istemci bunu bir CSS dönüşümüne çeviriyor.
    response.setHeader('X-Depsis-Orientation', String(found.orientation));
    response.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}.jpg`,
    );
    // Değişmez: anahtar girdi kimliği ARTI satırın boyutu ve son değişme anı, yani dosya değişip
    // satır güncellenince anahtar da değişiyor. Bir saat, bir ızgarayı defalarca çizen bir oturum
    // için yeterli.
    response.setHeader('Cache-Control', 'private, max-age=3600');
    response.end(found.bytes);
  }

  private async load(organizationId: string, id: string): Promise<FileEntryRow> {
    try {
      return await this.files.find(organizationId, id);
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * Resolve §6.2 at one node and refuse unless `permission` is in the answer.
   *
   * Returns the whole effective set rather than nothing, because the handler that just checked one
   * permission is usually the handler that has to report all of them on the row it is about to
   * return — and resolving twice would mean a response whose `permissions` came from a different
   * moment than the check that let the request through.
   */
  private async permit(
    caller: Caller,
    shareId: string,
    node: string | null,
    permission: Permission,
  ): Promise<ReadonlySet<Permission>> {
    const effective = await this.files.effectiveAt(caller, shareId, node);
    requirePermission(effective, permission, node !== null);
    return effective;
  }

  /** A page with the invisible rows removed and every survivor carrying its own permissions. */
  private async visible(
    caller: Caller,
    shareId: string,
    source: FileEntryPage,
    retentionDays: number | null = null,
  ): Promise<Schemas['FileEntryPage']> {
    return toPage(
      source,
      await this.files.effectiveForRows(caller, shareId, source.items),
      retentionDays,
    );
  }

  /**
   * The share an ENTRY lives in.
   *
   * Per-entry routes used to resolve the tenant's DEFAULT share and then check the entry against
   * it. With one share those are the same thing; with two, the permission walk is rooted at the
   * wrong tree. It fails closed — `accessFor` bounds the ancestor walk to the share, so an entry
   * from another one yields no chain and the caller is refused — but the effect is that every
   * entry outside the first share became unreachable the moment `POST /shares` could create a
   * second one.
   *
   * The row already carries `share_id`, so this is the authoritative answer and not a guess.
   */
  private async shareOfEntry(
    organizationId: string,
    row: { share_id: string },
    // Tam SATIR, daraltilmis bir alt kume degil: arsiv yolunun havuzda yer var mi diye sorabilmek
    // icin `dataset` de gerekiyor, ve donus tipini daraltmak o alani cagirandan gizliyordu.
  ): Promise<ShareRow> {
    try {
      return await this.files.shareFor(organizationId, row.share_id);
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * The share this request is about.
   *
   * `shareId` names one; without it the caller gets the tenant's default, which is what every
   * client did before shares could be created and what keeps those clients working. A share id
   * that is not this tenant's is a 404, identical to one that does not exist.
   */
  // Tam SATIR, daraltılmış bir alt küme değil: `read_only` bayrağı da buradan okunuyor, ve dönüş
  // tipini daraltmak onu `createFolder`ın kök dalından gizliyordu.
  private async share(request: AuthenticatedRequest, shareId?: string): Promise<ShareRow> {
    const session = requireSession(request);
    if (shareId !== undefined) requireUuid(shareId);
    try {
      return await this.files.shareFor(session.organizationId, shareId);
    } catch (error) {
      throw translate(error);
    }
  }
}

/**
 * The one place 404 and 403 are told apart.
 *
 * `list` is what makes an entry exist for a caller: a listing hides the rows they cannot list, so
 * a direct request for one of them has to give the same answer the listing gave — nothing. A 403
 * there would confirm the id, the folder it is in, and that somebody is keeping something from
 * them, which is the whole of what hiding the row was for.
 *
 * Once they CAN list it, concealment is over and 403 is the honest answer: they can see the entry
 * in its folder, so a 404 would be a lie they could disprove in one request, and "you may not
 * download this" is something a person can act on where "it is not there" is not.
 *
 * `concealable` is false for the share root, which is named by no id and hidden from nobody.
 */
export function requirePermission(
  effective: ReadonlySet<Permission>,
  permission: Permission,
  concealable: boolean,
): void {
  if (concealable && !effective.has('list')) throw new NotFoundException();
  if (!effective.has(permission)) {
    throw new ForbiddenException(`this needs '${permission}', which you do not have here`);
  }
}

/**
 * Salt okunur bir paylaşıma yazan her uç bunu çağırıyor.
 *
 * İZİNDEN SONRA sorulur, ondan önce değil: paylaşımın yazılabilir olup olmadığı, onu hiç
 * göremeyen birine söylenecek bir şey değil — önce 404/403 çıksın, salt okunurluk ancak kapıdan
 * geçenlere anlatılsın. `translate` üzerinden geçiyor ki cümle her rotada aynı olsun.
 */
export function requireWritableShare(share: { name: string; read_only: boolean }): void {
  try {
    assertWritable(share);
  } catch (error) {
    throw translate(error);
  }
}

/**
 * `?inline=1` bu dosyada gerçekten satır içi sunulmayı hak ediyor mu.
 *
 * TEK ÖLÇÜT UZANTI, ve bu bilinçli: `content_type` sütununu ajan her zaman doldurmuyor, ona bakan
 * bir kontrol aynı PDF'i bazen açar bazen açmazdı. Adı `.pdf` ile bitmeyen her şey `false` —
 * yani kiracının yüklediği bir HTML dosyası hiçbir zaman API'nin kökeninde belge olarak açılmaz.
 */
export function servesInline(name: string, inline: string | undefined): boolean {
  return inline === '1' && name.toLowerCase().endsWith('.pdf');
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
 * A service page as the contract's `FileEntryPage`, WITH THE ROWS THE CALLER MAY NOT LIST REMOVED.
 *
 * `nextCursor` is omitted rather than sent as null when there is no next page. `exactOptionalPropertyTypes`
 * forbids assigning `undefined` to an optional property, and the schema does not make the field
 * nullable — so a client that checks `'nextCursor' in page` gets the right answer.
 *
 * `nextCursor` and `hasMore` come from the UNFILTERED page and are deliberately left alone. They
 * describe the query's progress through the folder, not the caller's view of it: recomputing the
 * cursor from the surviving rows would make a page whose every row was hidden end the listing
 * early and silently drop everything after it. The visible consequence is that a page can come
 * back short, or empty, with `hasMore` true — the client keeps following the cursor, which is what
 * cursor pagination is for.
 *
 * What that costs is one opaque id: the cursor names a row the caller may not see. It carries no
 * name, kind or size, and fetching it answers 404 like any other invisible entry, so what leaks is
 * "some row exists in this folder" — which the folder's own presence already implies. Removing
 * even that would mean resolving permissions inside the SQL, and then ADR-0021's rule would live
 * in two places written in two languages.
 *
 * ── SAYAÇLAR SATIR DÜŞTÜĞÜ ANDA HİÇ YAZILMIYOR ──────────────────────────────────────────────
 *
 * `total`/`folders`/`files` servisin COUNT'undan geliyor ve o sorgu izne BAKMIYOR: bir üyeden
 * daraltılmış alt klasör listeden çıkarılıyor ama sayaçta durmaya devam ediyordu. Ekranın altında
 * "6 klasör · 42 dosya" yazarken listede beş satır olması, kullanıcıya kendisinden saklanan bir
 * klasörün VARLIĞINI söylüyor (ADR-0021'in kapattığı şeyin ta kendisi) ve gördüğü listeyle de
 * çelişiyor.
 *
 * Gizlenen satırı sayaçtan ÇIKARMAK doğru olmazdı: sayaç klasörün tamamını anlatıyor, gizlenenler
 * ise yalnız BU sayfayı — çok sayfalı bir klasörde çıkarılmış sayı da yanlış olurdu. Bu yüzden
 * bir satır bile düştüyse üç alan da hiç gönderilmiyor; sözleşmede üçü de isteğe bağlı ve ekran
 * alan yokken dürüst "N+" gösterimine düşüyor (Tiles.tsx, Files.tsx alt bilgisi).
 */
export function toPage(
  source: FileEntryPage,
  permissions: ReadonlyMap<string, ReadonlySet<Permission>>,
  /**
   * The organisation's retention, when one is set and the page is the bin.
   *
   * Passed in rather than read here, because `toPage` is called for every ordinary listing too and
   * a settings lookup per page would be a query nobody asked for.
   */
  retentionDays: number | null = null,
): Schemas['FileEntryPage'] {
  const items: Schemas['FileEntry'][] = [];
  let hidden = 0;
  for (const row of source.items) {
    const effective = permissions.get(row.id) ?? new Set<Permission>();
    if (!effective.has('list')) {
      hidden += 1;
      continue;
    }
    items.push(toEntry(row, effective, expiryOf(row, retentionDays)));
  }
  // Süzülmemiş bir sayacın süzülmüş bir listenin altında durması sızıntı; yukarıdaki nota bak.
  const counted = hidden === 0;
  return {
    items,
    ...(source.nextCursor === null ? {} : { nextCursor: source.nextCursor }),
    // `total` yalnız klasör listelemesinde dolu. Arama ve çöp sayfa sayfa gezilen şeyler değil,
    // ve orada bir toplam sorusunun karşılığı yok — alan yazılmıyor, sıfır yazılmıyor.
    ...(source.total === undefined || !counted ? {} : { total: source.total }),
    // Aynı gerekçe, ve aynı yerden geliyorlar: `total`la tek sorgudan. Biri varsa üçü de var.
    ...(source.folders === undefined || !counted ? {} : { folders: source.folders }),
    ...(source.files === undefined || !counted ? {} : { files: source.files }),
    hasMore: source.hasMore,
  };
}

/**
 * When a trashed row will actually be purged, or nothing.
 *
 * Nothing in three cases, and each is a promise this product would otherwise break:
 *
 *   * The row is not in the bin.
 *   * No retention is set. Showing a date and then having nothing happen on it is worse than
 *     showing none.
 *   * The row's own PARENT is also trashed. Such a row dies on its root's date, not its own, so
 *     its own would be a countdown the purge does not honour — `TrashRetentionService` takes roots
 *     only and lets `purge` walk each subtree.
 *
 * The third case is decided from `parent_trashed`, which the trash query reports; an ordinary
 * listing never sets it and never reaches here with a trashed row anyway.
 */
function expiryOf(row: FileEntryRow, retentionDays: number | null): Date | null {
  if (row.trashed_at === null || retentionDays === null) return null;
  if (row.parent_trashed === true) return null;
  return new Date(row.trashed_at.getTime() + retentionDays * 86_400_000);
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

/**
 * The sort the caller asked for, or the contract's default.
 *
 * An unknown value falls back to `name` rather than being refused. The contract gives `sort` a
 * default and an enum, so a value outside it is a client bug — and answering a listing with a 400
 * because a saved bookmark carries `sort=date` would break a file manager over a preference.
 * `cleanCursor` refuses instead, and the difference is real: a bad cursor means the caller is
 * asking for a page that does not exist, while a bad sort means they are asking for the same rows
 * in an order nobody defined.
 */
function cleanSort(raw: string | undefined): SortOrder {
  return raw === 'type' || raw === 'modified' || raw === 'size' ? raw : 'name';
}

/**
 * İstenen yön, ya da anahtarın kendi varsayılanı.
 *
 * `undefined` DÖNÜYOR, `'asc'` değil: yön verilmediğinde karar servise ait ve orada anahtara göre
 * veriliyor (ada göre artan, tarihe göre azalan). Burada bir varsayılan uydurmak, `sort=modified`
 * diyen eski bir yer imini en eski dosyayla açardı.
 *
 * Tanınmayan değer 400 DEĞİL, yok sayılıyor — `cleanSort`un gerekçesiyle aynı: bir yer imindeki
 * yazım hatası, dosya gezginini bir tercih yüzünden kırmamalı.
 */
function cleanDirection(raw: string | undefined): SortDirection | undefined {
  return raw === 'asc' || raw === 'desc' ? raw : undefined;
}

function clampLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

export function toEntry(
  row: FileEntryRow,
  effective: ReadonlySet<Permission>,
  /**
   * When this row will be purged, for a trashed one under a policy.
   *
   * Absent means "not scheduled to go", and the two ways to be absent are the policy being off and
   * the row not being a top-level trashed entry — a file inside a trashed folder dies on its
   * ROOT's date, so showing its own would be a countdown the purge does not honour.
   */
  expiresAt: Date | null = null,
): Schemas['FileEntry'] {
  return {
    // Canonically ordered rather than in whatever order the grants happened to be visited in. Two
    // requests that agree on the answer have to agree on the array as well: clients diff these,
    // and a set that reshuffles itself between two identical requests looks like a change.
    permissions: [...sortPermissions(effective)],
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    kind: row.kind,
    // `bigint` comes back from node-postgres as a string, deliberately: JavaScript's number cannot
    // hold every int64 and a silent coercion would round the size of a large file. Parsed here,
    // where the contract asks for a number, and files above 2^53 bytes are not a case this
    // appliance has.
    size: Number(row.size_bytes),
    // KLASÖRÜN İÇİNDE KAÇ ÖĞE VAR. Yalnız listelemede geliyor; dosyada ve başka sorgularda alan
    // hiç yazılmıyor — "sıfır" ile "sorulmadı" farklı iki şey, ve ekran ikincisinde bir sayı
    // göstermemeli.
    ...(row.child_count === undefined || row.child_count === null
      ? {}
      : { childCount: Number(row.child_count) }),
    // Klasörün altındaki toplam boyut. `size` bir klasörde her zaman 0 ve öyle kalıyor: satırın
    // kendi boyutu ile içindekilerin toplamı farklı iki şey, ve ikisini tek alana sıkıştırmak
    // "bu klasör 0 bayt" diyen bir cevap üretirdi.
    ...(row.subtree_bytes === undefined || row.subtree_bytes === null
      ? {}
      : { subtreeBytes: Number(row.subtree_bytes) }),
    modifiedAt: row.updated_at.toISOString(),
    ...(row.content_type === null ? {} : { mimeType: row.content_type }),
    ...(row.trashed_at === null ? {} : { trashedAt: row.trashed_at.toISOString() }),
    ...(expiresAt === null ? {} : { expiresAt: expiresAt.toISOString() }),
  };
}

/**
 * The session as the grant walk needs it.
 *
 * The role is read here and nowhere else, and it is carried as a plain boolean rather than as the
 * role string so that no call site can invent a second meaning for `admin`. ADR-0021 §5 gives the
 * organisation administrator everything; that is §6.1's hierarchy and not a shortcut, and there is
 * no other exception for anyone.
 */
export function requireSession(request: AuthenticatedRequest): Caller {
  const session = request.depsis;
  if (session === undefined) throw new UnauthorizedException();
  return {
    organizationId: session.organizationId,
    userId: session.userId,
    isOrganizationAdmin: session.role === 'admin',
  };
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
    return new ProblemException('name-taken', `${error.message}; rename one of them and try again`);
  }
  // 409, and the sentence is the point: the name is free everywhere the user can see and taken
  // where they cannot. Somebody made it over SMB, DEPSIS wrote no row, and neither renaming the
  // invisible thing nor picking another name is obvious without being told which of the two is
  // happening. The agent's own words go to the journal, as everywhere else in this function.
  if (error instanceof NameTakenOnDiskError) {
    // `name-taken` kodu, çıplak bir 409 değil: yükleme ekranı bu iki durumu ayırt edip
    // kullanıcıya "değiştir mi, ikisini de tut mu" diye sorabiliyor. Ayırt edici işaret bir metin
    // olsaydı, cümlenin her düzeltilişi istemciyi sessizce bozardı.
    return new ProblemException('name-taken', logged(error.message, error.agentReason));
  }
  // Also 409, and it must be checked BEFORE nothing — it is a sibling of the case above, not a
  // subtype, so order does not matter here; what matters is that the two have different sentences.
  // The name is held on disk by something the user binned themselves, so the remedy is the bin and
  // not a hunt for an SMB client. Trashing writes a flag and leaves the directory, while the
  // unique index excludes trashed rows, which is how the listing can show the name as free.
  if (error instanceof NameTakenByTrashedEntryError) {
    return new ProblemException('name-taken', logged(error.message, error.agentReason));
  }
  // 507, ve iki sayıyı da taşıyan cümlenin kendisi cevabın değeri: "arşiv için 40 GB gerekiyor,
  // havuzda 12 GB boş" bir kullanıcının ne yapacağını bilebileceği bir cümle. Ret arşiv
  // ÜRETİLMEDEN önce geliyor; yer bittikten sonra gelen bir hata, havuzu zaten doldurmuş olurdu.
  if (error instanceof ArchiveTooLargeError) {
    return new ProblemException('insufficient-storage', error.message);
  }
  // 403, ve YENİ BİR PROBLEM KODU AÇILMIYOR: `forbidden` zaten 403 ve sözleşme değişmiyor. Cümle
  // eksik bir yetkiden değil, paylaşımın kendisinin yazmaya kapalı olmasından söz ediyor — çünkü
  // kullanıcının yapacağı şey bir yetki istemek değil, paylaşımı yazılabilir açtırmak.
  if (error instanceof ShareReadOnlyError) {
    return new ProblemException(
      'forbidden',
      `'${error.shareName}' salt okunur bir paylaşım; içine yazılamaz.`,
    );
  }
  if (error instanceof TrashedParentError) return new ConflictException(error.message);
  // 403 and not 404: the caller can see the entry they named — they hold `delete` on it, which is
  // what got them this far — so concealment is already over. The message counts the folders and
  // does not name them, because naming them would be the leak the narrowing existed to prevent.
  if (error instanceof SubtreeForbiddenError) return new ForbiddenException(error.message);
  if (error instanceof InvalidNameError) return new BadRequestException(error.message);
  // The session names an account that is not there any more — deleted between sign-in and this
  // request. 401 rather than 500: there is nothing wrong with the server and nothing the caller
  // can do except sign in again.
  if (error instanceof PosixIdentityUnknownUserError) return new UnauthorizedException();
  // No filesystem identity could be allocated. 503 rather than 500 for the same reason an absent
  // agent is: the appliance is not broken, it cannot complete this class of request right now, and
  // the condition (an exhausted id range) is one an administrator resolves rather than a retry.
  if (error instanceof PosixIdentityUnavailableError) {
    return new ServiceUnavailableException(error.message);
  }
  // Four ways a move or a permanent delete can be refused, all of them 409 and all of them
  // carrying their own sentence. A bare 409 on this group would be indistinguishable to a user
  // from the name collision above, and the four have four different remedies.
  if (error instanceof CrossShareMoveError) return new ConflictException(error.message);
  if (error instanceof MoveIntoDescendantError) return new ConflictException(error.message);
  if (error instanceof NotTrashedError) return new ConflictException(error.message);
  if (error instanceof FolderNotOnDiskError) {
    return new ConflictException(logged(error.message, error.agentReason));
  }
  // 410, ve 409 DEĞİL: bir çakışma çözülebilir, bu çözülemez. Gönderilen baytlar ara alanda yok,
  // yani bu yükleme oturumu için yapılabilecek hiçbir şey kalmadı — ekranın söyleyeceği tek şey
  // "yeniden yükleyin". 409 verilseydi istemci onu çözülebilir bir çakışma sanıp aynı satırı
  // listede tutmaya devam ederdi, ki sahada tam olarak bu oluyordu.
  if (error instanceof StagedBytesGoneError) {
    return new ProblemException('staged-bytes-gone', logged(error.message, error.agentReason));
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

/**
 * The validator for a file's METADATA, which is a different thing from its content.
 *
 * `etagOf` below builds the tag for `GET /files/{id}/content` and includes the size the agent
 * measured; this one is about the row — a rename changes it, a byte written over SMB does not.
 * Two resources, two validators, and conflating them would make a rename look like a content
 * change to every cache in the path.
 *
 * STRONG, for the reason `If-Match` needs it to be: a weak tag asserts equivalence, and a
 * conditional write has to know it is looking at the same representation rather than an equivalent
 * one.
 */
export function metadataEtag(entry: FileEntryRow): string {
  return `"m-${entry.id}-${entry.updated_at.getTime().toString(36)}"`;
}
