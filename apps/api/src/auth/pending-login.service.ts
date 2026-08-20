import { Injectable } from '@nestjs/common';

import { DbService } from '../db/db.service.js';
import { generateToken, hashToken } from './token.js';

export interface PendingChallenge {
  /** Goes to the client in a short-lived cookie. Not a session — nothing is authenticated yet. */
  token: string;
  expiresAt: Date;
}

export interface ResolvedPending {
  pendingId: string;
  organizationId: string;
  userId: string;
  attempts: number;
}

/**
 * The state between "the password was right" and "the second factor was right".
 *
 * It is deliberately NOT a session with a flag on it. A session that exists before the second
 * factor has been proved is a session an attacker who has the password already holds, and every
 * later piece of code would have to remember to check the flag. Making it a different thing, in a
 * different table, with a different cookie, means forgetting is not possible.
 */
@Injectable()
export class PendingLoginService {
  /**
   * Five minutes. Long enough to open an authenticator app and read a code, short enough that a
   * challenge left behind on a shared machine is worthless by the time anyone finds it.
   */
  private static readonly LIFETIME_MS = 5 * 60_000;

  /** Matches the bound inside `resolve_pending_login`; six digits deserve few tries. */
  static readonly MAX_ATTEMPTS = 6;

  constructor(private readonly db: DbService) {}

  async create(organizationId: string, userId: string): Promise<PendingChallenge> {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + PendingLoginService.LIFETIME_MS);

    await this.db.withTenant(organizationId, async (q) => {
      // Any earlier challenge for this user is consumed first. Leaving them live would mean a user
      // who starts three logins has three chances at the attempt budget instead of one.
      await q.query(
        `UPDATE pending_logins SET consumed_at = now()
          WHERE user_id = $1 AND consumed_at IS NULL`,
        [userId],
      );
      await q.query(
        `INSERT INTO pending_logins (organization_id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [organizationId, userId, hashToken(token), expiresAt],
      );
    });

    return { token, expiresAt };
  }

  /**
   * Resolve a challenge token, without a tenant context — the same shape as a session lookup, and
   * for the same reason. Expired, consumed, out of attempts, and never-existed are one answer.
   */
  async resolve(token: string): Promise<ResolvedPending | null> {
    const rows = await this.db.withoutTenant('resolve-pending-login', (q) =>
      q.query<{
        pending_id: string;
        organization_id: string;
        user_id: string;
        attempts: number;
      }>(
        `SELECT pending_id::text AS pending_id,
                organization_id::text AS organization_id,
                user_id::text AS user_id,
                attempts
           FROM public.resolve_pending_login($1)`,
        [hashToken(token)],
      ),
    );

    const row = rows[0];
    if (row === undefined) return null;
    return {
      pendingId: row.pending_id,
      organizationId: row.organization_id,
      userId: row.user_id,
      attempts: row.attempts,
    };
  }

  /**
   * Count a wrong answer.
   *
   * Called BEFORE the answer is checked rather than after, so a request that dies mid-verification
   * still costs an attempt. Counting afterwards would let an attacker cancel the connection on a
   * wrong guess and try again for free.
   */
  async countAttempt(organizationId: string, pendingId: string): Promise<void> {
    await this.db.withTenant(organizationId, (q) =>
      q.query(`UPDATE pending_logins SET attempts = attempts + 1 WHERE id = $1`, [pendingId]),
    );
  }

  /**
   * Spend the challenge.
   *
   * The UPDATE decides: it only matches a challenge that has not been consumed, so two requests
   * racing with the same correct code cannot both produce a session.
   */
  async consume(organizationId: string, pendingId: string): Promise<boolean> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ id: string }>(
        `UPDATE pending_logins SET consumed_at = now()
          WHERE id = $1 AND consumed_at IS NULL
          RETURNING id::text AS id`,
        [pendingId],
      ),
    );
    return rows.length === 1;
  }
}
