import {
  Controller,
  Get,
  NotFoundException,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';

import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import {
  cleanCursor,
  requirePermission,
  requireSession,
  requireUuid,
  toPage,
  translate,
} from './files.controller.js';
import { FilesService } from './files.service.js';

type Schemas = OpenApi.components['schemas'];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** The contract's `q`, and the reason a longer one is refused rather than truncated. */
const MAX_QUERY_LENGTH = 256;

/**
 * Name search.
 *
 * A separate controller from `FilesController` because `/search` is a separate path, and Nest
 * binds a controller to one prefix. Everything else it shares: `SessionGuard`, so the tenant comes
 * from the session; `FilesService`, so the query runs inside `withTenant` and row-level security
 * decides what is visible; and `FilesController`'s own mappers, so a hit is serialised by exactly
 * the same code as a listing row — a search result that reported `size` differently from the
 * listing it came from would be a bug nobody would look for.
 */
@Controller('search')
@UseGuards(SessionGuard)
export class SearchController {
  constructor(private readonly files: FilesService) {}

  /**
   * Search the caller's share by name.
   *
   * Trashed entries never appear. The bin is where a user puts something to stop seeing it, and a
   * search box that hands it back is the one place that decision is most likely to be undone by
   * accident — the user finds the file, opens it, and edits a copy the system considers deleted.
   *
   * An empty query is 422 rather than "everything". The contract says `minLength: 1`, and matching
   * every name in the share would be an expensive way to answer a question nobody asked; the
   * check runs after trimming, because a query of three spaces is empty in every sense that
   * matters and `depsis_norm` does not trim.
   *
   * §6.2 applies here exactly as it does to a listing, and search is the place where forgetting it
   * would hurt most: a name search reaches the whole share at once, so a result set that ignored
   * grants would be a way to read the name of every file on the appliance in one request. The rows
   * go through the same `toPage` the tree uses, so the hiding is the same code and cannot drift.
   */
  @Get()
  async search(
    @Req() request: AuthenticatedRequest,
    @Query('q') q?: string,
    @Query('scope') scope?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<Schemas['FileEntryPage']> {
    const caller = requireSession(request);
    const after = cleanCursor(cursor);
    const query = (q ?? '').trim();
    if (query.length === 0) throw new UnprocessableEntityException('q must not be empty');
    if (query.length > MAX_QUERY_LENGTH) {
      // Refused, not truncated. A silently shortened query returns hits that do not contain what
      // the user typed, and there is no way for them to tell that is what happened.
      throw new UnprocessableEntityException(`q may not exceed ${MAX_QUERY_LENGTH} characters`);
    }

    const share = await this.files.shareOf(caller.organizationId).catch((error: unknown) => {
      throw translate(error);
    });

    // A scope from another share, or one in the trash, reads as absent rather than as an empty
    // result set — the same rule the listing route follows, and for the same reason: an empty page
    // for a folder that exists somewhere else confirms that it exists. A scope the caller cannot
    // `list` joins that set: 404, from the same helper the tree uses.
    if (scope !== undefined) {
      requireUuid(scope);
      const folder = await this.files.find(caller.organizationId, scope).catch((error: unknown) => {
        throw translate(error);
      });
      if (folder.share_id !== share.id || folder.trashed_at !== null || folder.kind !== 'folder') {
        throw new NotFoundException();
      }
      requirePermission(await this.files.effectiveAt(caller, share.id, scope), 'list', true);
    }

    const hits = await this.files.search(
      caller.organizationId,
      share.id,
      scope ?? null,
      query,
      after,
      clampLimit(limit),
    );

    return toPage(hits, await this.files.effectiveForRows(caller, share.id, hits.items));
  }
}

/**
 * The contract caps `limit` at 200 and defaults it to 50.
 *
 * Clamped rather than rejected: a client asking for more than the page size the server is willing
 * to build gets the largest page it will build, and `hasMore` tells it there is more. Rejecting
 * would turn a tuning difference into a broken screen.
 */
function clampLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}
