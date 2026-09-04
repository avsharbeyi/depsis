import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

import { ProblemException } from '../common/problem.filter.js';
import { DbService } from '../db/db.service.js';
import {
  KEY_VERSION_AES_GCM,
  KEY_VERSION_PLAINTEXT,
  SecretDecryptionError,
  type SecretBox,
} from './secret-box.js';
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
export class MfaService implements OnModuleInit {
  private readonly logger = new Logger(MfaService.name);

  /**
   * `secrets` is null when no key is configured.
   *
   * There is deliberately NO fallback to storing a raw secret in that case. An operator who
   * configured encryption and got plaintext anyway — because a path was wrong, or a credential did
   * not mount — would have exactly the protection they think they removed the need for. Enrolment
   * refuses instead, loudly, while existing rows keep working to the extent they can: a plaintext
   * row still verifies, and a sealed one cannot, which leaves recovery codes as the way in. That is
   * a large part of why recovery codes are hashed rather than sealed.
   */
  constructor(
    private readonly db: DbService,
    private readonly secrets: SecretBox | null = null,
  ) {}

  /**
   * Say, once, how much of the estate is still in the clear.
   *
   * A lazy upgrade that nobody can observe is indistinguishable from one that is not happening, and
   * "we encrypt TOTP secrets" is the kind of claim that stops being true quietly. Non-fatal: an
   * unreadable count is not a reason to refuse to serve.
   */
  async onModuleInit(): Promise<void> {
    try {
      const remaining = await this.plaintextSecretCount();
      if (remaining === 0) return;
      if (this.secrets === null) {
        this.logger.warn(
          `${remaining} TOTP secret(s) are stored in the clear and no key is configured to seal ` +
            'them. Set DEPSIS_SECRET_KEY_FILE (ADR-0016).',
        );
      } else {
        this.logger.log(
          `${remaining} TOTP secret(s) are still stored in the clear; each is sealed the next ` +
            'time its owner signs in.',
        );
      }
    } catch (error) {
      this.logger.warn(
        `could not count unsealed TOTP secrets: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * How many secrets are still stored the way migration 0004 stored them.
   *
   * Counts rows without reading a single secret.
   */
  async plaintextSecretCount(): Promise<number> {
    // Through the definer function, NOT a direct count. Counting the table here runs with no
    // tenant context — the question is about the whole estate and is asked before any tenant is
    // known — and row level security then hides every row, so the answer was always 0. Migration
    // 0006 carries the reasoning; a test asserting the count could SEE a row is what caught it.
    const rows = await this.db.withoutTenant('mfa-key-inventory', (q) =>
      q.query<{ n: string }>('SELECT public.unsealed_totp_secret_count()::text AS n'),
    );
    return Number(rows[0]?.n ?? '0');
  }

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
    if (this.secrets === null) {
      // Refused rather than degraded. See the note on the constructor.
      //
      // VE EKRANDA OKUNABİLİR OLARAK. Buradan düz bir `Error` fırlatmak `ProblemFilter`'ın 500
      // dalına düşüyordu, ve bir 500 asla `detail` taşımaz (taşımamalı da): sahibi "İki adımlı
      // doğrulamayı aç"a basıp yalnız "Kayıt başlatılamadı." görüyor, gerçek sebebi ancak
      // `journalctl` söylüyordu — terminalsiz ürün kuralının ihlali. 503 `dependency-unavailable`,
      // durumu olduğu gibi anlatıyor: kutunun bir parçası eksik, istek yanlış değil.
      throw new ProblemException(
        'dependency-unavailable',
        'Bu cihazın gizli anahtarı okunamıyor, bu yüzden iki adımlı doğrulama şu anda ' +
          'kurulamıyor. Kurtarma sonrasında /etc/depsis/secret.key eksik ya da okunamaz durumda ' +
          'olabilir; cihazı yeniden başlatmak sorunu çözmezse yedekteki anahtar dosyası geri ' +
          'yüklenmelidir.',
      );
    }
    const secret = generateSecret();
    const sealed = this.secrets.seal(secret, { userId, organizationId });

    await this.db.withTenant(organizationId, (q) =>
      q.query(
        `INSERT INTO user_totp_secrets (user_id, organization_id, secret, key_version)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE
            SET secret = EXCLUDED.secret,
                key_version = EXCLUDED.key_version,
                -- A restarted enrolment clears the old confirmation and the replay counter with it.
                -- Keeping either would mean the new secret inherits the old one's used steps.
                confirmed_at = NULL,
                last_used_step = NULL,
                created_at = now()`,
        [userId, organizationId, sealed, KEY_VERSION_AES_GCM],
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
      q.query<{ secret: Buffer; last_used_step: string | null; key_version: number }>(
        `SELECT secret, last_used_step::text AS last_used_step, key_version
           FROM user_totp_secrets
          WHERE user_id = $1
            ${options.requireConfirmed ? 'AND confirmed_at IS NOT NULL' : ''}`,
        [userId],
      ),
    );
    const row = rows[0];
    if (row === undefined) return null;

    const secret = await this.unseal(organizationId, userId, row.secret, row.key_version);
    if (secret === null) return null;

    return {
      secret,
      lastUsedStep: row.last_used_step === null ? null : Number(row.last_used_step),
    };
  }

  /**
   * Turn a stored value into the secret, upgrading it in place if it is still plaintext.
   *
   * Returning null rather than throwing on a failed decrypt is deliberate. Every caller treats null
   * as "this user has no usable TOTP secret", which makes a lost or rotated key look to the user
   * exactly like a wrong code — and leaves the recovery-code path, which needs no key, working.
   * Throwing would turn a key problem into a 500 on a login attempt, which tells an attacker
   * something and tells the user nothing.
   */
  private async unseal(
    organizationId: string,
    userId: string,
    stored: Buffer,
    keyVersion: number,
  ): Promise<Buffer | null> {
    if (keyVersion === KEY_VERSION_PLAINTEXT) {
      if (this.secrets === null) return stored;
      // A lazy upgrade: the row is read, used, and re-sealed. Doing it here rather than in a bulk
      // job means the conversion happens under the same tenant context that is already established
      // and needs no second code path. `plaintextSecretCount()` is what makes the remaining tail
      // visible, since a migration nobody can observe is one nobody can finish.
      const sealed = this.secrets.seal(stored, { userId, organizationId });
      const updated = await this.db.withTenant(organizationId, (q) =>
        q.query<{ user_id: string }>(
          // Conditional on the row still being plaintext, so two concurrent logins cannot both
          // re-seal and the second cannot overwrite the first's envelope with its own.
          `UPDATE user_totp_secrets
              SET secret = $2, key_version = $3
            WHERE user_id = $1 AND key_version = $4
            RETURNING user_id::text AS user_id`,
          [userId, sealed, KEY_VERSION_AES_GCM, KEY_VERSION_PLAINTEXT],
        ),
      );
      if (updated.length === 1) {
        this.logger.log(`sealed the TOTP secret for user ${userId} on first use`);
      }
      return stored;
    }

    if (this.secrets === null) {
      // Sealed, and nothing to open it with. Loud, because every enrolled user is now relying on
      // recovery codes and the operator is the only one who can fix it.
      this.logger.error(
        `user ${userId} has a sealed TOTP secret but no key is configured; ` +
          'DEPSIS_SECRET_KEY_FILE is missing or unreadable. Recovery codes still work.',
      );
      return null;
    }

    try {
      return this.secrets.open(stored, { userId, organizationId });
    } catch (error) {
      if (error instanceof SecretDecryptionError) {
        this.logger.error(
          `could not open the TOTP secret for user ${userId}: ${error.message}. ` +
            'The key may have been replaced, or the row may have been tampered with.',
        );
        return null;
      }
      throw error;
    }
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
