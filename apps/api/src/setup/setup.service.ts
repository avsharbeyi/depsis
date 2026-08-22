import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { PasswordService } from '../auth/password.service.js';
import { DbService } from '../db/db.service.js';

export interface ClaimRequest {
  token: string;
  organizationSlug: string;
  organizationName: string;
  adminUsername: string;
  adminPassword: string;
}

export type ClaimResult =
  | { outcome: 'ok'; organizationId: string; userId: string }
  | { outcome: 'bad-token' }
  | { outcome: 'already-complete' }
  | { outcome: 'invalid'; reason: string };

/**
 * The one-time claim that turns a freshly installed box into somebody's box.
 *
 * The problem ADR-0009 states but does not solve: a NAS plugged into a LAN answers to everyone on
 * that LAN, and a setup wizard that is first-come-first-served hands the machine to whoever notices
 * it first. On an appliance that is not a theoretical concern — it is the normal case, because the
 * owner is usually still walking back to their desk.
 *
 * The claim therefore needs a token, and the token is printed to the journal on boot while setup is
 * outstanding. Reading it needs console or SSH access, which is exactly the authority that should
 * decide who the first administrator is.
 *
 * That is not §6.3 being bent. §6.3 forbids the PASSWORD reaching a log, a QR code or a default
 * config; this is not a password. It is single-use, it authenticates exactly one request, it is
 * regenerated on every boot so a token scraped from an old journal is already dead, and once setup
 * completes it means nothing at all.
 */
@Injectable()
export class SetupService implements OnModuleInit {
  private readonly logger = new Logger(SetupService.name);

  /**
   * Held in memory, never stored.
   *
   * A restart invalidates it, which is the safe direction: an operator who was interrupted reads
   * the new token from the new boot's log, while a token captured from an old log is worthless.
   * Storing it would mean a leaked backup carries a live claim on any box restored from it.
   */
  private tokenHash: Buffer | null = null;

  constructor(
    private readonly db: DbService,
    private readonly passwords: PasswordService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (await this.isComplete()) {
      this.logger.log('setup is complete; setup endpoints are closed');
      return;
    }

    const token = randomBytes(32).toString('base64url');
    this.tokenHash = createHash('sha256').update(token, 'utf8').digest();

    // Deliberately loud and deliberately multi-line. An operator reading `journalctl -u depsis-api`
    // has to be able to find this without knowing it exists.
    this.logger.warn(
      '\n' +
        '═══════════════════════════════════════════════════════════════════\n' +
        '  DEPSIS is not set up yet.\n' +
        '\n' +
        '  Open the web interface and enter this one-time setup token:\n' +
        '\n' +
        `      ${token}\n` +
        '\n' +
        '  It is valid until this process restarts, and once only. Anyone who\n' +
        '  can read it can become the first administrator, so treat it as a\n' +
        '  credential until setup is finished.\n' +
        '═══════════════════════════════════════════════════════════════════',
    );
  }

  /** Whether the setup endpoints should still answer. */
  async isComplete(): Promise<boolean> {
    const rows = await this.db.withoutTenant('setup-status', (q) =>
      q.query<{ done: boolean }>('SELECT public.is_setup_complete() AS done'),
    );
    return rows[0]?.done === true;
  }

  async claim(request: ClaimRequest): Promise<ClaimResult> {
    if (await this.isComplete()) return { outcome: 'already-complete' };
    if (!this.tokenMatches(request.token)) return { outcome: 'bad-token' };

    const invalid = validate(request);
    if (invalid !== null) return { outcome: 'invalid', reason: invalid };

    const hash = await this.passwords.hash(request.adminPassword);

    try {
      const rows = await this.db.withoutTenant('setup-status', (q) =>
        q.query<{ organization_id: string; user_id: string }>(
          `SELECT organization_id::text AS organization_id, user_id::text AS user_id
             FROM public.claim_system_setup($1, $2, $3, $4)`,
          [
            request.organizationSlug,
            request.organizationName,
            request.adminUsername,
            hash,
          ],
        ),
      );

      const row = rows[0];
      if (row === undefined) return { outcome: 'already-complete' };

      // Burned even though the database already refuses a second claim. Two locks on a door that
      // can only be opened once costs nothing, and the in-memory one closes the window between the
      // database committing and the next request arriving.
      this.tokenHash = null;
      this.logger.warn(`setup completed: organization ${row.organization_id}`);

      return { outcome: 'ok', organizationId: row.organization_id, userId: row.user_id };
    } catch (error) {
      // `object_not_in_prerequisite_state` is what `claim_system_setup` raises when it finds the
      // singleton already present — a race lost, not a failure worth a 500.
      if (isAlreadyComplete(error)) return { outcome: 'already-complete' };
      throw error;
    }
  }

  private tokenMatches(supplied: string): boolean {
    if (this.tokenHash === null) return false;
    const candidate = createHash('sha256').update(supplied, 'utf8').digest();
    // Both are 32-byte digests, so the lengths always match and `timingSafeEqual` cannot throw.
    // Hashing first is what guarantees that: comparing the raw strings would leak their length.
    return timingSafeEqual(this.tokenHash, candidate);
  }
}

function isAlreadyComplete(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    // 55000 object_not_in_prerequisite_state, or 23505 if two claims race past the check and
    // collide on the singleton primary key. Both mean the same thing to a caller.
    (error.code === '55000' || error.code === '23505')
  );
}

/**
 * Validation with reasons, unlike the login path.
 *
 * Login refuses everything identically so a caller cannot learn which half they got right. Setup is
 * the opposite: the person on the other end is the machine's owner, typing carefully into a form
 * once, and a bare "invalid" would leave them guessing which of five fields the server disliked.
 */
function validate(request: ClaimRequest): string | null {
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(request.organizationSlug)) {
    return 'organizationSlug must be lowercase letters, digits and hyphens, and cannot start or end with a hyphen';
  }
  if (request.organizationName.trim().length === 0) return 'organizationName is required';
  // The same shape the database enforces (migration 0010): letters, digits, dot, dash and
  // underscore, and no '@'. A username that looks like an address is one a person or a future
  // parser can mistake for one.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(request.adminUsername)) {
    return 'adminUsername may contain letters, digits, dot, dash and underscore only';
  }

  // A length floor and nothing else. A composition rule ("one uppercase, one digit, one symbol")
  // shrinks the search space more often than it grows it, and NIST SP 800-63B dropped the advice
  // for that reason. Length is what buys entropy from a human.
  if (request.adminPassword.length < 12) {
    return 'adminPassword must be at least 12 characters';
  }
  if (request.adminPassword.length > 1024) return 'adminPassword is too long';
  return null;
}
