import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service.js';
import { AgentService } from '../agent/agent.service.js';
import { requireSameOrigin } from '../auth/origin.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { ProblemException } from '../common/problem.filter.js';
import { JobsService } from '../jobs/jobs.service.js';
import { BackupsService } from '../system/backups.service.js';
import { CopyService, RESTORE_KIND, type RestorePayload } from './copy.service.js';
import { FilesService, permissionsOf, type Caller } from './files.service.js';
import { requireSession, requireUuid } from './files.controller.js';

type Schemas = OpenApi.components['schemas'];

/**
 * A snapshot's own name — the part after `@`.
 *
 * Deliberately wider than a share name: ZFS allows `:`, `.` and `+` in a snapshot name and every
 * auto-snapshot convention uses them, so a pattern borrowed from the share rules would refuse the
 * snapshots this feature exists to read. What it must not allow is a path separator, a leading
 * dash, or a name that is `.` or `..` — the same three refusals `SafeComponent` makes in the
 * agent, which checks it again on the far side.
 */
const snapshotName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._:+-]*$/u);

const restoreSchema = z.object({
  path: z.array(z.string().min(1).max(255)).min(1).max(32),
  destinationId: z.string().uuid().nullable().default(null),
});

/**
 * Reading the past, and bringing one file back from it.
 *
 * THE OPERATION A NAS IS BOUGHT FOR. DEPSIS has taken snapshots since Phase 1 and could list them
 * from the pool; what it could not do was open one. The only thing a user could be offered was
 * rolling a whole dataset back, which also discards every file written since — so "I deleted a
 * report yesterday" had no answer at all, which is the one question a person asks their backup.
 *
 * PERMISSIONS ARE SHARE-WIDE HERE, and that is a narrowing rather than a shortcut. Grants in this
 * product are per folder, and a snapshot's tree cannot be mapped onto them: the folder somebody
 * wants back is usually the folder that no longer exists, so there is no live row to carry a
 * grant. Rather than invent a rule — walk to the nearest surviving ancestor, fall back to the
 * share — this requires `download` on the share ROOT, which is the permission that would let the
 * caller read every live file anyway. Somebody holding only a sub-folder grant cannot browse
 * history at all. That is a real limitation, it is written in the contract, and it fails closed.
 *
 * READ-ONLY, and it could not be otherwise: a ZFS snapshot is immutable. The restore reads here
 * and writes through the ordinary confined path, as an ordinary file.
 */
@Controller('shares/:shareId/snapshots')
@UseGuards(SessionGuard)
export class SnapshotBrowseController {
  constructor(
    private readonly files: FilesService,
    private readonly copies: CopyService,
    private readonly backups: BackupsService,
    private readonly agent: AgentService,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(
    @Req() request: AuthenticatedRequest,
    @Param('shareId') shareId: string,
  ): Promise<Schemas['ShareSnapshotPage']> {
    const caller = requireSession(request);
    requireUuid(shareId);
    const share = await this.requireReadableShare(caller, shareId);

    const found = await this.backups.inventory(
      [share.dataset],
      `browsing the snapshots of ${share.name}`,
    );
    // `null` means the pool could not be asked. NOT an empty list: an empty list says "there are
    // no snapshots", and on a box whose agent is down for a minute that would tell somebody
    // looking for a deleted file that there is nothing left to look in.
    if (found === null) return { available: false, items: [] };

    return {
      available: true,
      items: found
        .map((row) => ({
          name: row.name,
          createdAt: row.createdAt.toISOString(),
          usedBytes: row.usedBytes,
        }))
        // Newest first: a history is read from the most recent version backwards.
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  }

  @Get(':snapshot/entries')
  async entries(
    @Req() request: AuthenticatedRequest,
    @Param('shareId') shareId: string,
    @Param('snapshot') snapshot: string,
    @Query('path') rawPath: string | undefined,
  ): Promise<Schemas['SnapshotListing']> {
    const caller = requireSession(request);
    requireUuid(shareId);
    const share = await this.requireReadableShare(caller, shareId);
    const name = this.requireSnapshotName(snapshot);
    const path = splitPath(rawPath);

    const response = await this.agent.call(
      { op: 'snapshot_entries', share: share.name, snapshot: name, path },
      `browsing ${share.name}@${name}`,
      randomUUID(),
    );

    if (response.status === 'not_found') {
      throw new ProblemException('not-found', 'Bu anlık görüntüde böyle bir klasör yok.');
    }
    if (response.status === 'refused') {
      // The agent could not cross into the snapshot's mount, or storage is not configured.
      // Reported rather than shown as an empty folder — an empty folder is what somebody acts on
      // by concluding their file is really gone.
      throw new ProblemException(
        'dependency-unavailable',
        `Anlık görüntü okunamadı: ${response.reason}`,
      );
    }
    if (response.status !== 'listing') {
      throw new ProblemException(
        'dependency-unavailable',
        `Ajan bir listeleme yerine '${response.status}' cevabı verdi.`,
      );
    }

    return {
      path,
      truncated: response.truncated,
      items: response.entries.map((entry) => ({
        name: entry.name,
        directory: entry.directory,
        sizeBytes: entry.size,
        modifiedAt: new Date(entry.modified_unix * 1000).toISOString(),
      })),
    };
  }

  @Post(':snapshot/restore')
  @HttpCode(202)
  async restore(
    @Req() request: AuthenticatedRequest,
    @Param('shareId') shareId: string,
    @Param('snapshot') snapshot: string,
    @Body() body: unknown,
  ): Promise<Schemas['RestoreAccepted']> {
    requireSameOrigin(request);
    const caller = requireSession(request);
    requireUuid(shareId);
    const share = await this.requireReadableShare(caller, shareId);
    const name = this.requireSnapshotName(snapshot);

    const parsed = restoreSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProblemException('validation-failed', 'En az bir öğeden oluşan bir path gerekli.');
    }
    const { path, destinationId } = parsed.data;
    if (destinationId !== null) requireUuid(destinationId);
    assertRestorePath(path);

    const wanted = path.at(-1);
    if (wanted === undefined) {
      throw new ProblemException('validation-failed', 'Geri yüklenecek dosyanın adı yok.');
    }

    // `create` on the DESTINATION, separately from `download` on the share. A restore writes, and
    // the folder it writes into is one the caller chose — the same split `POST /file-operations`
    // makes between reading a source and writing a destination.
    const access = await this.files.accessFor(caller, share.id, [destinationId]);
    const destination = permissionsOf(access, destinationId);
    if (destination.size === 0) {
      throw new ProblemException('not-found', 'Hedef klasör bulunamadı.');
    }
    if (!destination.has('create')) {
      throw new ProblemException('forbidden', 'Hedef klasöre yazma yetkiniz yok.');
    }

    // A free name, decided HERE and returned, so the user sees where the file will land before it
    // lands. The agent refuses to publish over a taken name as well; two doors, because the whole
    // reason to restore something is not being sure which copy you want.
    const finalName = await this.copies.freeName(
      caller.organizationId,
      share.id,
      destinationId,
      wanted,
    );

    const payload: RestorePayload = {
      shareId: share.id,
      snapshot: name,
      from: path,
      destinationId,
      name: finalName,
      actorId: caller.userId,
    };
    const jobId = await this.jobs.enqueue(
      caller.organizationId,
      RESTORE_KIND,
      payload as unknown as Record<string, unknown>,
      // Not 1. A restore is safe to retry: the publish is `RENAME_NOREPLACE`, so a second attempt
      // that gets all the way through finds the name taken and fails loudly rather than leaving a
      // second copy. What it would NOT be safe to do is give up on a transient agent failure,
      // which is what `maxAttempts: 1` means for a job somebody is watching.
      { maxAttempts: 5 },
    );
    // Dosyanın ADI denetimde var, İÇERİĞİ yok (§16). Ad, "hangi dosya geri geldi" sorusunun
    // cevabı ve zaten dosya listesinde herkese görünür.
    await this.audit.record(caller.organizationId, {
      actorId: caller.userId,
      action: 'storage.snapshot-restore-requested',
      target: { kind: 'share', id: share.id, label: share.name },
      summary: `'${name}' anlık görüntüsünden '${finalName}' adıyla geri yükleme istendi.`,
    });
    return { jobId, name: finalName };
  }

  /** The share, if this caller may read all of it. See the class comment for why all of it. */
  private async requireReadableShare(
    caller: Caller,
    shareId: string,
  ): Promise<{ id: string; name: string; dataset: string }> {
    const share = await this.files.shareFor(caller.organizationId, shareId).catch((): never => {
      throw new ProblemException('not-found', 'Paylaşım bulunamadı.');
    });

    const access = await this.files.accessFor(caller, share.id, [null]);
    const root = permissionsOf(access, null);
    // Empty is 404 and not 403, for the reason every other route in this module gives: a caller
    // who cannot see the share must not learn from the status code that it exists.
    if (root.size === 0) throw new ProblemException('not-found', 'Paylaşım bulunamadı.');
    if (!root.has('download')) {
      throw new ProblemException(
        'forbidden',
        'Geçmiş sürümlere bakmak için paylaşımın tamamını indirme yetkisi gerekir.',
      );
    }
    return { id: share.id, name: share.name, dataset: share.dataset };
  }

  private requireSnapshotName(raw: string): string {
    const parsed = snapshotName.safeParse(raw);
    if (!parsed.success) {
      throw new ProblemException('validation-failed', 'Anlık görüntü adı kullanılabilir değil.');
    }
    return parsed.data;
  }
}

/**
 * Geri yükleme gövdesindeki yolun bileşenleri.
 *
 * Gezinme yolu (`splitPath`) bunu zaten yapıyordu, gövde yapmıyordu: `path` yalnız "1 ile 255
 * karakter arası bir dizge" diye sınanıp doğrudan işin yüküne giriyordu. Ajan aynı bileşenleri
 * `EntryName` olarak ayrıştırıp reddediyor — ama BU İŞÇİDE, uca 202 döndükten sonra. Sonuç,
 * kullanıcıya "geri yükleme istendi" demek, sonra işi beş kez sessizce öldürmekti.
 *
 * KURALLAR AJANIN `EntryName`İ İLE AYNI, `splitPath`inkiyle değil: baştaki tire artık bir ret
 * sebebi değil (bkz. `assertValidName` yorumu), ve `-eski.txt` geri getirilebilmesi gereken gerçek
 * bir dosya adı. Uzunluk da BAYTLA ölçülüyor, çünkü ajan öyle ölçüyor: 200 harflik Türkçe bir ad
 * 255 baytı aşabiliyor.
 *
 * Son bileşen ayrıca `.depsis` olamaz: o ad canlı ağaçta ara yükleme ve karantina dizinine ait ve
 * geri yükleme onu YENİ bir ad olarak yaratıyor.
 */
function assertRestorePath(path: readonly string[]): void {
  for (const part of path) {
    if (
      part === '.' ||
      part === '..' ||
      part.includes('/') ||
      part.includes('\\') ||
      part.includes('\0') ||
      Buffer.byteLength(part, 'utf8') > 255
    ) {
      throw new ProblemException('validation-failed', 'Yol kullanılabilir değil.');
    }
  }
  if (path.at(-1) === '.depsis') {
    throw new ProblemException('validation-failed', "'.depsis' adıyla geri yükleme yapılamaz.");
  }
}

/**
 * `a/b/c` into components, refusing anything that is not one.
 *
 * The agent checks every component again — it is the side that enforces the boundary — but a path
 * that reaches a URL is checked where it is used as well, and a `..` refused here never becomes an
 * operand at all.
 */
function splitPath(raw: string | undefined): string[] {
  if (raw === undefined || raw === '') return [];
  const parts = raw.split('/').filter((part) => part !== '');
  if (parts.length > 32) {
    throw new ProblemException('validation-failed', 'Yol çok derin.');
  }
  for (const part of parts) {
    if (part === '.' || part === '..' || part.includes('\\') || part.startsWith('-')) {
      throw new ProblemException('validation-failed', 'Yol kullanılabilir değil.');
    }
  }
  return parts;
}
