import { Body, Controller, Get, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { z } from 'zod';

import { requireSameOrigin } from '../auth/origin.js';
import { AuditService } from '../audit/audit.service.js';
import { AdminGuard, SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { ProblemException } from '../common/problem.filter.js';
import { requireSession } from './files.controller.js';
import { TrashRetentionService } from './trash-retention.service.js';

type Schemas = OpenApi.components['schemas'];

const policySchema = z.object({
  /** `null` switches the policy off. Below one day the database refuses; so does this, sooner. */
  retentionDays: z.number().int().min(1).max(3650).nullable(),
});

/**
 * The bin's expiry policy — §7's "saklama süresi ve yönetici temizleme politikası".
 *
 * ADMINISTRATORS ONLY, and 403 rather than 404: the endpoint's existence is not a secret, only who
 * may call it. That is the same line `GET /users` draws.
 *
 * THE PREVIEW IS PART OF THE SAFETY ARGUMENT, not a convenience. Switching this on starts deleting
 * user data permanently, on a schedule, with nobody watching. `GET` therefore prices the stored
 * policy AND whatever value the caller is considering, so the screen that arms the destruction can
 * say how many entries and how many bytes the first run would take. A policy set without that
 * number is a policy set blind.
 */
@Controller('system/trash-policy')
@UseGuards(SessionGuard, AdminGuard)
export class TrashPolicyController {
  constructor(
    private readonly retention: TrashRetentionService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The policy, and what it would cost.
   *
   * `days` prices a value the caller has typed but not saved. Absent, it prices the stored one —
   * so the screen shows what the NEXT scheduled run will take, which is the other question an
   * administrator has.
   */
  @Get()
  async read(
    @Req() request: AuthenticatedRequest,
    @Query('days') days?: string,
  ): Promise<Schemas['TrashPolicy']> {
    const caller = requireSession(request);
    const policy = await this.retention.policy(caller.organizationId);

    const considering = days === undefined ? policy.retentionDays : Number.parseInt(days, 10);
    if (days !== undefined && (!Number.isSafeInteger(considering) || (considering ?? 0) < 1)) {
      throw new ProblemException('bad-request', 'days bir tam sayı olmalı ve en az 1.');
    }

    const impact = await this.retention.impact(caller.organizationId, considering ?? null);
    return {
      retentionDays: policy.retentionDays,
      updatedAt: policy.updatedAt,
      impact: {
        entries: impact.entries,
        files: impact.files,
        bytes: impact.bytes,
        oldestTrashedAt: impact.oldestTrashedAt,
      },
    };
  }

  @Put()
  async write(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['TrashPolicy']> {
    requireSameOrigin(request);
    const caller = requireSession(request);
    const parsed = policySchema.safeParse(body);
    if (!parsed.success) {
      // The floor is stated rather than left to a generic message. Zero is the value somebody
      // reaches for when they mean "empty it now", and it would mean "trashing is permanent
      // deletion" — the one click between a user and irreversible loss, removed.
      throw new ProblemException(
        'validation-failed',
        'retentionDays ya null olmalı ya da 1 ile 3650 arasında bir tam sayı.',
      );
    }

    const policy = await this.retention.setPolicy(
      caller.organizationId,
      parsed.data.retentionDays,
      caller.userId,
    );
    const impact = await this.retention.impact(caller.organizationId, policy.retentionDays);
    // Saklama süresini KISALTMAK, süpürücünün bir sonraki turunda dosya silmektir — politika
    // değişikliği görünümünde bir toplu silme. Etki sayıları o yüzden özetin içinde.
    await this.audit.record(caller.organizationId, {
      actorId: caller.userId,
      action: 'storage.trash-policy-changed',
      summary:
        policy.retentionDays === null
          ? 'Çöp kutusu saklama süresi kaldırıldı; hiçbir şey kendiliğinden silinmeyecek.'
          : `Çöp kutusu saklama süresi ${policy.retentionDays} gün yapıldı; bu sürenin üstündeki ${impact.files} dosya süpürülecek.`,
    });
    return {
      retentionDays: policy.retentionDays,
      updatedAt: policy.updatedAt,
      impact: {
        entries: impact.entries,
        files: impact.files,
        bytes: impact.bytes,
        oldestTrashedAt: impact.oldestTrashedAt,
      },
    };
  }
}
