import { Body, Controller, HttpCode, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { z } from 'zod';

import { requireSameOrigin } from '../auth/origin.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { ProblemException } from '../common/problem.filter.js';
import { JobsService } from '../jobs/jobs.service.js';
import { COPY_KIND, COPY_MAX_ATTEMPTS, CopyService, type CopyPayload } from './copy.service.js';
import { FilesService, permissionsOf, type Caller } from './files.service.js';
import { requireSession, requireUuid, translate } from './files.controller.js';

type Schemas = OpenApi.components['schemas'];

const requestSchema = z.object({
  operation: z.enum(['move', 'copy', 'restore']),
  sourceIds: z.array(z.string().uuid()).min(1).max(10_000),
  destinationId: z.string().uuid().nullable(),
  conflictPolicy: z.enum(['replace', 'keep_both', 'version', 'skip']).default('keep_both'),
});

/**
 * `POST /file-operations` — the bulk operations that are jobs rather than requests.
 *
 * WHY IT IS A JOB. Copying a folder is an unbounded amount of work behind one click, and §17's
 * acceptance criterion is explicit: a thousand-file bulk operation must not lock the interface and
 * its status must update in real time. So this answers 202 with a `JobRef` and the work happens in
 * the worker; the jobs board and the event stream are how it is watched.
 *
 * ONLY `copy` IS SERVED. `move` is `PATCH /files/{id}` — one `renameat2`, immediate, and routing it
 * through a queue would make the common case slower and less certain for no gain. Cross-share move
 * genuinely belongs here (ADR-0008: a rename across datasets is EXDEV and must become copy+delete)
 * and is refused for now rather than approximated, because a half-implemented move that copies and
 * then fails to delete leaves two files where the user asked for one. `restore` is
 * `POST /files/{id}/restore`.
 *
 * ONLY `keep_both` IS SERVED, and the refusals are the interesting part. `replace` would destroy a
 * file the user did not name — the rule `RENAME_NOREPLACE` enforces all the way down to the
 * syscall, and honouring it would mean giving the agent an overwrite it deliberately does not
 * have. `version` needs a version store that does not exist. `skip` is defensible and simply not
 * built; refusing it is better than quietly doing `keep_both` under its name.
 */
@Controller('file-operations')
@UseGuards(SessionGuard)
export class FileOperationsController {
  constructor(
    private readonly files: FilesService,
    private readonly copies: CopyService,
    private readonly jobs: JobsService,
  ) {}

  @UseInterceptors(IdempotencyInterceptor)
  @Post()
  @HttpCode(202)
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['JobRef']> {
    requireSameOrigin(request);
    const caller = requireSession(request);
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProblemException(
        'validation-failed',
        'operation, en az bir sourceIds ve bir destinationId gerekli.',
      );
    }
    const { operation, sourceIds, destinationId, conflictPolicy } = parsed.data;

    if (operation !== 'copy') {
      throw new ProblemException(
        'validation-failed',
        operation === 'move'
          ? 'Taşıma için PATCH /files/{id} kullanın. Paylaşımlar arası taşıma henüz yok.'
          : 'Geri alma için POST /files/{id}/restore kullanın.',
      );
    }
    if (conflictPolicy !== 'keep_both') {
      throw new ProblemException(
        'validation-failed',
        `conflictPolicy şu an yalnız keep_both. '${conflictPolicy}' henüz uygulanmadı.`,
      );
    }

    for (const id of sourceIds) requireUuid(id);
    if (destinationId !== null) requireUuid(destinationId);

    // The share comes from the FIRST SOURCE and every other id is checked against it. A copy
    // spanning two shares is two datasets and a different operation; letting the ids disagree
    // would make the destination's share the tiebreak, which is the one the caller did not name.
    const first = await this.files
      .find(caller.organizationId, sourceIds[0] ?? '')
      .catch((error: unknown) => {
        throw translate(error);
      });
    const shareId = first.share_id;

    const sources = await Promise.all(
      sourceIds.map((id) =>
        this.files.find(caller.organizationId, id).catch((error: unknown) => {
          throw translate(error);
        }),
      ),
    );
    for (const source of sources) {
      // Absent rather than refused, which is what every other per-entry route does for an id in
      // another share: the caller must not learn that it exists.
      if (source.share_id !== shareId || source.trashed_at !== null) {
        throw new ProblemException('not-found', 'Kaynaklardan biri bu paylaşımda değil.');
      }
    }

    if (destinationId !== null) {
      const destination = await this.files
        .find(caller.organizationId, destinationId)
        .catch((error: unknown) => {
          throw translate(error);
        });
      if (
        destination.share_id !== shareId ||
        destination.kind !== 'folder' ||
        destination.trashed_at !== null
      ) {
        throw new ProblemException('not-found', 'Hedef klasör bu paylaşımda değil.');
      }
      // Copying a folder into itself or into its own descendant is an infinite tree. The database
      // would not stop it — each step is a legal create — so it is stopped here.
      for (const source of sources) {
        if (source.kind !== 'folder') continue;
        if (destinationId === source.id || destination.path.startsWith(`${source.path}/`)) {
          throw new ProblemException(
            'conflict',
            'Bir klasör kendi içine kopyalanamaz; sonu gelmeyen bir ağaç olurdu.',
          );
        }
      }
    }

    // §6.2 on BOTH ends, and the reason it is both: the source's bytes are being read and the
    // destination is being written into. ONE `accessFor` for the whole set, because the ancestor
    // walk is shared — a call per id would be the N+1 the contract names and refuses.
    await this.requirePermissions(caller, shareId, sourceIds, destinationId);

    const payload: CopyPayload = {
      shareId,
      sourceIds,
      destinationId,
      actorId: caller.userId,
    };
    const jobId = await this.jobs.enqueue(
      caller.organizationId,
      COPY_KIND,
      payload as unknown as Record<string, unknown>,
      { maxAttempts: COPY_MAX_ATTEMPTS },
    );
    return { jobId };
  }

  /**
   * `download` on every source, `create` on the destination.
   *
   * `download` rather than `read`, and the distinction is the point: `read` is metadata — a name,
   * a size, a date — while a copy takes the CONTENTS. A grant that lets somebody see that a file
   * exists must not let them make themselves a copy of it in a folder they control.
   */
  private async requirePermissions(
    caller: Caller,
    shareId: string,
    sourceIds: readonly string[],
    destinationId: string | null,
  ): Promise<void> {
    const access = await this.files.accessFor(caller, shareId, [...sourceIds, destinationId]);

    for (const id of sourceIds) {
      const allowed = permissionsOf(access, id);
      // Empty means the node has no chain the caller can see: 404, not 403, so an id in a folder
      // they cannot list does not confirm that it exists.
      if (allowed.size === 0) throw new ProblemException('not-found', 'Kaynak bulunamadı.');
      if (!allowed.has('download')) {
        throw new ProblemException('forbidden', 'Kopyalamak için kaynağı indirme yetkisi gerekir.');
      }
    }

    const destination = permissionsOf(access, destinationId);
    if (destination.size === 0) {
      throw new ProblemException('not-found', 'Hedef klasör bulunamadı.');
    }
    if (!destination.has('create')) {
      throw new ProblemException('forbidden', 'Hedef klasöre yazma yetkiniz yok.');
    }
  }
}

/** Re-exported so the job's kind has one spelling. */
export { COPY_KIND };
