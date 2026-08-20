import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

import { DbService } from '../db/db.service.js';
import { base32Encode, generateSecret, otpauthUri, PERIOD_SECONDS, verifyTotp } from './totp.js';

export interface Enrolment {
  /** Shown once, as a QR code. The secret is never shown again. */
  otpauthUri: string;
  /** The same secret in text, for an authenticator that cannot scan. */
  secretBase32: string;
}

export type SecondFactorResult =
  { outcome: 'ok'; used: 'totp' | 'recovery-code' } | { outcome: 'rejected' };

/** How many recovery codes are issued at once. */
const RECOVERY_CODE_COUNT = 10;

/**
 * 20 base32 characters is 100 bits.
 *
 * Enough that the SHA-256 hashes are not brute-forceable offline, which is what makes SHA-256 the
 * right choice rather than Argon2 — see the reasoning on the column in migration 0004. Short enough
 * that a person can copy it off a printed sheet without giving up.
 */
const RECOVERY_CODE_CHARS = 20;

@Injectable()
export class MfaService {
  constructor(private readonly db: DbService) {}

  /**
   * Begin enrolment: generate a secret, store it UNCONFIRMED, and return what the user scans.
   *
   * Unconfirmed on purpose. A secret that gated logins the moment it was written would lock out a
   * user who scanned the code and then lost the phone before proving they could produce one — and
   * that user would have no way back in, because the recovery codes are issued at confirmation.
   */
  async beginEnrolment(
    organizationId: string,
    userId: string,
    accountName: string,
  ): Promise<Enrolment> {
    const secret = generateSecret();

    await this.db.withTenant(organizationId, (q) =>
      q.query(
        `INSERT INTO user_totp_secrets (user_id, organization_id, secret)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE
            SET secret = EXCLUDED.secret,
                -- A restarted enrolment clears the old confirmation and the replay counter with it.
                -- Keeping either would mean the new secret inherits the old one's used steps.
                confirmed_at = NULL,
                last_used_step = NULL,
                created_at = now()`,
        [userId, organizationId, secret],
      ),
    );

    return {
      otpauthUri: otpauthUri({ secret, accountName, issuer: 'DEPSIS' }),
      secretBase32: base32Encode(secret),
    };
  }

  /**
   * Finish enrolment by proving a code, and issue the recovery codes.
   *
   * The codes are returned here and nowhere else — only their hashes are stored, so this is the one
   * moment they exist in readable form. ADR-0009 requires exactly that.
   *
   * The confirmation code is BURNED, like any other. That has a consequence worth stating because
   * it will otherwise be reported as a bug: a user who confirms enrolment and then signs in again
   * within the same thirty-second window will find the code their authenticator is showing does not
   * work, and has to wait for the next one. That is correct — the code was used, and replaying a
   * used code is exactly what the burn exists to stop — but the enrolment screen should say so,
   * because "the app is showing me a code and it says invalid" is otherwise inexplicable.
   */
  async confirmEnrolment(
    organizationId: string,
    userId: string,
    code: string,
  ): Promise<string[] | null> {
    const secret = await this.secretOf(organizationId, userId, { requireConfirmed: false });
    if (secret === null) return null;

    const now = Math.floor(Date.now() / 1000);
    const step = verifyTotp(secret, code, now);
    if (step === null) return null;

    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());

    await this.db.withTenant(organizationId, async (q) => {
      await q.query(
        `UPDATE user_totp_secrets
            SET confirmed_at = now(), last_used_step = $2
          WHERE user_id = $1`,
        [userId, absoluteStep(now, step)],
      );
      // Replaced, not appended. Re-enrolling has to invalidate the sheet the user printed last
      // time, or a stolen old sheet keeps working against a secret its owner has already replaced.
      await q.query(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [userId]);
      for (const plain of codes) {
        await q.query(
          `INSERT INTO user_recovery_codes (organization_id, user_id, code_hash)
           VALUES ($1, $2, $3)`,
          [organizationId, userId, hashRecoveryCode(plain)],
        );
      }
    });

    return codes;
  }

  /**
   * Replace the recovery codes with a fresh set.
   *
   * The old ones stop working, which is the point and also the risk: a user who regenerates and
   * then loses the new sheet has locked themselves out of their own recovery path. That is why the
   * endpoint asks for the password (§0.5) rather than doing it on a click.
   */
  async regenerateRecoveryCodes(organizationId: string, userId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
    await this.db.withTenant(organizationId, async (q) => {
      await q.query(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [userId]);
      for (const plain of codes) {
        await q.query(
          `INSERT INTO user_recovery_codes (organization_id, user_id, code_hash)
           VALUES ($1, $2, $3)`,
          [organizationId, userId, hashRecoveryCode(plain)],
        );
      }
    });
    return codes;
  }

  /** Whether this user must present a second factor. */
  async isEnrolled(organizationId: string, userId: string): Promise<boolean> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM user_totp_secrets
          WHERE user_id = $1 AND confirmed_at IS NOT NULL`,
        [userId],
      ),
    );
    return rows[0]?.n !== '0';
  }

  /**
   * Verify a second factor, whichever kind it is.
   *
   * A TOTP code and a recovery code are told apart by shape rather than by asking the caller which
   * they are sending: a caller who declares "this is a recovery code" could otherwise steer the
   * check toward whichever branch it found weaker.
   */
  async verifySecondFactor(
    organizationId: string,
    userId: string,
    submitted: string,
  ): Promise<SecondFactorResult> {
    const cleaned = submitted.trim().replace(/[\s-]/g, '').toUpperCase();

    if (/^\d{6}$/.test(cleaned)) {
      return (await this.verifyTotpCode(organizationId, userId, cleaned))
        ? { outcome: 'ok', used: 'totp' }
        : { outcome: 'rejected' };
    }
    if (/^[A-Z2-7]{20}$/.test(cleaned)) {
      return (await this.consumeRecoveryCode(organizationId, userId, cleaned))
        ? { outcome: 'ok', used: 'recovery-code' }
        : { outcome: 'rejected' };
    }
    return { outcome: 'rejected' };
  }

  /**
   * Verify a TOTP code and burn the step it used.
   *
   * The burn is the point. Without it a code stays valid for its whole ninety-second window, so a
   * code read over a shoulder — or relayed by a phishing proxy while the user is still looking at
   * it — works a second time. The comparison is `>=` because the accepted window reaches backwards
   * as well: replaying a step OLDER than the last one used has to fail too.
   */
  private async verifyTotpCode(
    organizationId: string,
    userId: string,
    code: string,
  ): Promise<boolean> {
    const row = await this.secretRow(organizationId, userId, { requireConfirmed: true });
    if (row === null) return false;

    const now = Math.floor(Date.now() / 1000);
    const step = verifyTotp(row.secret, code, now);
    if (step === null) return false;

    const used = absoluteStep(now, step);
    if (row.lastUsedStep !== null && used <= row.lastUsedStep) return false;

    // Conditional on the counter not having moved, so two requests racing with the same code cannot
    // both succeed. The second one updates zero rows and is refused.
    const updated = await this.db.withTenant(organizationId, (q) =>
      q.query<{ user_id: string }>(
        `UPDATE user_totp_secrets
            SET last_used_step = $2
          WHERE user_id = $1
            AND (last_used_step IS NULL OR last_used_step < $2)
          RETURNING user_id::text AS user_id`,
        [userId, used],
      ),
    );
    return updated.length === 1;
  }

  /**
   * Spend a recovery code.
   *
   * The UPDATE is what decides, not a preceding SELECT: marking it used and checking it was unused
   * in one statement means two concurrent submissions of the same code cannot both win.
   */
  private async consumeRecoveryCode(
    organizationId: string,
    userId: string,
    code: string,
  ): Promise<boolean> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ id: string }>(
        `UPDATE user_recovery_codes
            SET used_at = now()
          WHERE user_id = $1
            AND code_hash = $2
            AND used_at IS NULL
          RETURNING id::text AS id`,
        [userId, hashRecoveryCode(code)],
      ),
    );
    return rows.length === 1;
  }

  /** How many unused recovery codes remain, for the warning the UI should show. */
  async remainingRecoveryCodes(organizationId: string, userId: string): Promise<number> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM user_recovery_codes
          WHERE user_id = $1 AND used_at IS NULL`,
        [userId],
      ),
    );
    return Number(rows[0]?.n ?? '0');
  }

  private async secretOf(
    organizationId: string,
    userId: string,
    options: { requireConfirmed: boolean },
  ): Promise<Buffer | null> {
    const row = await this.secretRow(organizationId, userId, options);
    return row?.secret ?? null;
  }

  private async secretRow(
    organizationId: string,
    userId: string,
    options: { requireConfirmed: boolean },
  ): Promise<{ secret: Buffer; lastUsedStep: number | null } | null> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ secret: Buffer; last_used_step: string | null }>(
        `SELECT secret, last_used_step::text AS last_used_step
           FROM user_totp_secrets
          WHERE user_id = $1
            ${options.requireConfirmed ? 'AND confirmed_at IS NOT NULL' : ''}`,
        [userId],
      ),
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      secret: row.secret,
      lastUsedStep: row.last_used_step === null ? null : Number(row.last_used_step),
    };
  }
}

/** The absolute TOTP counter a relative step offset refers to. */
function absoluteStep(unixSeconds: number, offset: number): number {
  return Math.floor(unixSeconds / PERIOD_SECONDS) + offset;
}

/**
 * A recovery code: 20 characters from the base32 alphabet.
 *
 * Rejection sampling rather than modulo. `randomBytes(n)[i] % 32` is biased — 256 is not a multiple
 * of 32 only in the sense that it IS, so this particular case happens to be uniform, but writing it
 * that way invites the next person to change the alphabet length and introduce a bias silently.
 * Masking to five bits and drawing again is uniform for any alphabet size and costs nothing.
 */
function generateRecoveryCode(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let out = '';
  while (out.length < RECOVERY_CODE_CHARS) {
    for (const byte of randomBytes(RECOVERY_CODE_CHARS)) {
      const index = byte & 31;
      const char = alphabet[index];
      if (char !== undefined) out += char;
      if (out.length === RECOVERY_CODE_CHARS) break;
    }
  }
  return out;
}

/**
 * Codes are stored and compared in a canonical form, so the grouping a user types back — or the
 * hyphens a UI inserts for readability — cannot make a valid code fail.
 */
function hashRecoveryCode(code: string): Buffer {
  const canonical = code.trim().replace(/[\s-]/g, '').toUpperCase();
  return createHash('sha256').update(canonical, 'utf8').digest();
}

/** Formatted for printing: four groups of five. */
export function formatRecoveryCode(code: string): string {
  return (code.match(/.{1,5}/g) ?? [code]).join('-');
}
