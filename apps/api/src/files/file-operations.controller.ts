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
import { requireSession, requireUuid } from './files.controller.js';

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

    // ONE ANSWER FOR EVERY WAY A SOURCE CAN BE UNUSABLE, and it is not cosmetic.
    // `FilesService.find` is scoped by organisation and nothing narrower, so it runs before any
    // grant is consulted — and three different bodies used to come back from it: Nest's bare
    // "Not Found" for an id in no share at all, one sentence for an id in another share, another
    // for an id the caller has no grant on. An organisation member holding a uuid from a log line
    // could tell those apart and learn that an entry exists, which is the existence oracle §14 and
    // ADR-0013 §2.2 both refuse.
    const missing = (): never => {
      throw new ProblemException('not-found', 'Kaynak bulunamadı.');
    };

    // The share comes from the FIRST SOURCE and every other id is checked against it. A copy
    // spanning two shares is two datasets and a different operation; letting the ids disagree
    // would make the destination's share the tiebreak, which is the one the caller did not name.
    const sources = await Promise.all(
      sourceIds.map((id) => this.files.find(caller.organizationId, id).catch(missing)),
    );
    const shareId = sources[0]?.share_id ?? missing();
    for (const source of sources) {
      if (source.share_id !== shareId || source.trashed_at !== null) missing();
    }

    if (destinationId !== null) {
      const destination = await this.files
        .find(caller.organizationId, destinationId)
        .catch(missing);
      if (
        destination.share_id !== shareId ||
        destination.kind !== 'folder' ||
        destination.trashed_at !== null
      ) {
        // The same single answer: a destination in another share, one that is a file, and one that
        // does not exist are one outcome here for the same reason.
        missing();
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

    // Counted HERE, not in the worker. The limit is a refusal and a refusal is deterministic: a
    // job that throws it retries on every attempt, burns its budget, and reports `dead` to
    // somebody who was told the copy had started. One extra walk on the click buys a 422 the user
    // can act on.
    const { entries, bytes } = await this.copies.size(caller.organizationId, shareId, sourceIds);
    if (entries > CopyService.MAX_ENTRIES) {
      throw new ProblemException(
        'validation-failed',
        `Bu seçim ${entries} girdi içeriyor; en fazla ${CopyService.MAX_ENTRIES} kopyalanabilir.`,
      );
    }

    // A courtesy, not a guarantee — another upload can take the space between this answer and the
    // copy, which is why the agent classifies a full pool into its own response as well. What it
    // converts is the common case: a copy is one of two operations in the product that can multiply
    // stored bytes without a single upload, and being told the two numbers on the click beats
    // watching a job fail an hour later with half a tree copied.
    const share = await this.files.shareFor(caller.organizationId, shareId);
    const available = await this.copies.availableBytes(
      share.dataset,
      `space check before copying ${bytes} bytes`,
    );
    if (available !== null && bytes > available) {
      throw new ProblemException(
        'insufficient-storage',
        `Bu kopyalama ${formatBytes(bytes)} yer istiyor; havuzda ${formatBytes(available)} boş.`,
      );
    }

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

/** Bytes, as a person reads them. Base 10, matching what a disk's label claims. */
function formatBytes(value: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
  let n = value;
  let unit = 0;
  while (n >= 1000 && unit < units.length - 1) {
    n /= 1000;
    unit += 1;
  }
  return `${n < 10 && unit > 0 ? n.toFixed(1) : Math.round(n)} ${units[unit] ?? 'B'}`;
}
