import { Injectable } from '@nestjs/common';

import { DbService } from '../db/db.service.js';
import { generateToken, hashToken } from './token.js';

/** A reset an administrator just opened. The token exists only in this object and on the wire. */
export interface IssuedReset {
  token: string;
  expiresAt: Date;
}

/** A token that named a live reset. */
export interface ResolvedReset {
  resetId: string;
  organizationId: string;
  userId: string;
  attempts: number;
}

/**
 * The recovery path for a forgotten password, built so the administrator does not learn the
 * password.
 *
 * WHY IT IS A TOKEN AND NOT AN ADMINISTRATOR-CHOSEN PASSWORD. The contract refuses the second
 * shape by name, and the refusal is right: "a password the administrator sets is a password the
 * administrator knows — it makes every account impersonable in a way indistinguishable in the
 * audit." So the administrator opens a reset and hands the user a one-time value; the user chooses
 * the password.
 *
 * That does NOT make impersonation impossible — the administrator of a NAS is root-equivalent and
 * could redeem the token themselves. What it changes is that the theft is LOUD. The token is
 * single-use, so an administrator who redeems it makes the user's own attempt fail, and the user
 * finds out. Silent impersonation becomes a noisy one, which is the distinguishability the
 * contract asked for.
 *
 * The row survives its use. `consumed_at` is set and nothing is deleted, because "who opened a
 * reset, for whom, and when" is the question an audit exists to answer and a deleted row cannot.
 */
@Injectable()
export class PasswordResetService {
  /**
   * Thirty minutes.
   *
   * Longer than the five a pending login gets, because this one is carried across a room rather
   * than typed from a phone that is already in the user's hand. Short enough that a slip of paper
   * found the next morning is worthless.
   */
  private static readonly LIFETIME_MS = 30 * 60_000;

  /** Matches the bound inside `resolve_password_reset`. */
  static readonly MAX_ATTEMPTS = 6;

  constructor(private readonly db: DbService) {}

  /**
   * Open a reset for `userId`, closing any that was already open.
   *
   * Closing the previous one is not tidiness. `password_resets_one_open_per_user` would refuse the
   * insert otherwise — and more importantly, two live tokens would mean somebody holding the older
   * one still gets in after the administrator issued a new one, which is the opposite of what
   * issuing a new one is for.
   */
  async open(organizationId: string, userId: string, createdBy: string): Promise<IssuedReset> {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + PasswordResetService.LIFETIME_MS);

    await this.db.withTenant(organizationId, async (q) => {
      await q.query(
        `UPDATE public.password_resets SET consumed_at = now()
          WHERE user_id = $1 AND consumed_at IS NULL`,
        [userId],
      );
      await q.query(
        `INSERT INTO public.password_resets
           (organization_id, user_id, created_by, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [organizationId, userId, createdBy, hashToken(token), expiresAt],
      );
    });

    return { token, expiresAt };
  }

  /**
   * Turn a token into a user, or nothing.
   *
   * Untenanted, and ADR-0015 §5e argues the addition: the person holding this token cannot sign in
   * — that is the situation it exists for — so there is no tenant context, and the token is the
   * only thing that names one. Identical in shape to `resolve-session` and `resolve-pending-login`.
   */
  async resolve(token: string): Promise<ResolvedReset | null> {
    const rows = await this.db.withoutTenant('resolve-password-reset', (q) =>
      q.query<{
        reset_id: string;
        organization_id: string;
        user_id: string;
        attempts: number;
      }>(
        `SELECT reset_id::text AS reset_id, organization_id::text AS organization_id,
                user_id::text AS user_id, attempts
           FROM public.resolve_password_reset($1)`,
        [hashToken(token)],
      ),
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      resetId: row.reset_id,
      organizationId: row.organization_id,
      userId: row.user_id,
      attempts: row.attempts,
    };
  }

  /**
   * Record a failed second-factor attempt against the reset.
   *
   * The budget is on the RESET rather than on the account, and that matters: a token whose holder
   * cannot produce the authenticator code is a token being guessed at, and burning the reset is
   * the right answer. Locking the account instead would let anybody with a stolen token deny the
   * real user their own sign-in.
   */
  async recordAttempt(organizationId: string, resetId: string): Promise<void> {
    await this.db.withTenant(organizationId, (q) =>
      q.query(`UPDATE public.password_resets SET attempts = attempts + 1 WHERE id = $1`, [resetId]),
    );
  }

  /** Spend it. Returns false when somebody else spent it first. */
  async consume(organizationId: string, resetId: string): Promise<boolean> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ id: string }>(
        // `consumed_at IS NULL` in the WHERE, not merely in the read that preceded it: two
        // redemptions racing must not both succeed, and the row is the only place that can be
        // decided. The loser gets `false` and answers as if the token were unknown.
        `UPDATE public.password_resets SET consumed_at = now()
          WHERE id = $1 AND consumed_at IS NULL
          RETURNING id::text AS id`,
        [resetId],
      ),
    );
    return rows.length > 0;
  }
}
