import { Injectable, Logger } from '@nestjs/common';

import { DbService } from '../db/db.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { MfaService } from './mfa.service.js';
import { PasswordService } from './password.service.js';
import { PendingLoginService, type PendingChallenge } from './pending-login.service.js';
import { SessionService, type IssuedSession } from './session.service.js';

export interface LoginRequest {
  username: string;
  /**
   * Which organisation, when the box holds more than one.
   *
   * OPTIONAL, and omitted by the interface. `system_setup` is a singleton, so a claimed appliance
   * has exactly one organisation and the server resolves it — asking a person to name it was a
   * question with one possible answer and a real failure mode (migration 0010).
   *
   * The field survives rather than being deleted because the assumption it covers is one this
   * codebase should degrade from gracefully, not crash into: with two organisations present,
   * `resolve_sole_organization` returns nothing and every sign-in would fail with no way to say
   * which tenant was meant. That is not hypothetical — it is exactly what the integration suites
   * look like, because they seed several tenants into one database.
   */
  organizationSlug?: string | undefined;
  password: string;
  userAgent: string | null;
  ip: string;
}

export type LoginResult =
  | { outcome: 'ok'; session: IssuedSession; userId: string; organizationId: string }
  // The password was right and a second factor is enrolled. Nothing is authenticated yet: the
  // challenge token is not a session and cannot be used as one.
  | { outcome: 'mfa-required'; challenge: PendingChallenge }
  | { outcome: 'rejected' }
  | { outcome: 'throttled' };

export interface SecondFactorRequest {
  challengeToken: string;
  code: string;
  userAgent: string | null;
  ip: string;
}

export type SecondFactorLoginResult =
  | {
      outcome: 'ok';
      session: IssuedSession;
      userId: string;
      organizationId: string;
      /** Which factor was accepted, so the caller can warn when a recovery code was spent. */
      used: 'totp' | 'recovery-code';
    }
  | { outcome: 'rejected' };

interface UserRow {
  id: string;
  password_hash: string | null;
}

/**
 * The login flow, and the reason it is written as one method.
 *
 * Every branch below has to reach the same observable outcome for a caller who guessed wrong,
 * whatever they guessed wrong ABOUT. A tenant that does not exist, an address that does not exist,
 * an address that exists with no password set, and a wrong password must be indistinguishable:
 * same response, same status, and — because Argon2 costs about twenty milliseconds — comparable
 * time. Splitting this across helpers that each return early is how those paths quietly diverge.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly db: DbService,
    private readonly organizations: OrganizationsService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly throttle: LoginThrottleService,
    private readonly mfa: MfaService,
    private readonly pending: PendingLoginService,
  ) {}

  async login(request: LoginRequest): Promise<LoginResult> {
    // Folded the same way the database folds it, so that varying case or Unicode spelling cannot
    // buy a fresh throttling bucket for the same account. `fold_identity` is the authority; asking
    // it rather than reimplementing it in TypeScript is what keeps the two from drifting.
    const usernameFolded = await this.fold(request.username);

    if (!(await this.throttle.gate(usernameFolded, request.ip))) {
      return { outcome: 'throttled' };
    }

    // The box's own organisation unless the caller named one. See `resolveSoleId`.
    const organizationId =
      request.organizationSlug === undefined || request.organizationSlug === ''
        ? await this.organizations.resolveSoleId()
        : await this.organizations.resolveIdBySlug(request.organizationSlug);

    // An unknown tenant still pays for a password verification. Returning here without one would
    // make tenant enumeration a matter of timing the response.
    const user =
      organizationId === null ? null : await this.findUser(organizationId, usernameFolded);

    const ok = await this.passwords.verify(user?.password_hash ?? null, request.password);

    if (!ok || user === null || organizationId === null) {
      await this.throttle.record(usernameFolded, request.ip, false);
      // Which of the three failed, in the journal only. The CLIENT is told one thing for all of
      // them and that stays true: any difference visible to a caller is an oracle for which
      // accounts exist. The OPERATOR is told, because §16 asks that what happened on this box be
      // explicable afterwards and "someone could not sign in" is the least useful line a journal
      // can carry — written after a real failure that took three rounds of instrumentation to
      // place.
      this.logger.warn(
        `login rejected: organization ${organizationId === null ? 'not resolvable' : 'ok'}, ` +
          `account ${user === null ? 'not found' : 'ok'}, ` +
          `password ${user === null ? 'not checked' : ok ? 'ok' : 'wrong'}`,
      );
      return { outcome: 'rejected' };
    }

    // The password was right. Whether that is enough depends on what the user enrolled.
    if (await this.mfa.isEnrolled(organizationId, user.id)) {
      const challenge = await this.pending.create(organizationId, user.id);
      // Recorded as a success: the PASSWORD was correct, and the throttle exists to bound password
      // guessing. Counting it as a failure would let a correct password be used to throttle its own
      // owner, and the second factor has its own, tighter attempt budget.
      await this.throttle.record(usernameFolded, request.ip, true);
      return { outcome: 'mfa-required', challenge };
    }

    const session = await this.sessions.issue(organizationId, user.id, {
      userAgent: request.userAgent,
      ip: request.ip,
    });

    await this.throttle.record(usernameFolded, request.ip, true);
    this.logger.log(`session issued for user ${user.id}`);

    return { outcome: 'ok', session, userId: user.id, organizationId };
  }

  /**
   * The second step: a challenge token plus a code, in exchange for a session.
   *
   * The attempt is counted BEFORE the code is checked. Counting afterwards would let an attacker
   * abandon the connection on a wrong guess and retry without spending anything from the budget.
   */
  async completeSecondFactor(request: SecondFactorRequest): Promise<SecondFactorLoginResult> {
    const challenge = await this.pending.resolve(request.challengeToken);
    if (challenge === null) return { outcome: 'rejected' };

    await this.pending.countAttempt(challenge.organizationId, challenge.pendingId);

    const verified = await this.mfa.verifySecondFactor(
      challenge.organizationId,
      challenge.userId,
      request.code,
    );
    if (verified.outcome !== 'ok') return { outcome: 'rejected' };

    // Consuming is what makes the challenge single-use, and it is checked: if another request
    // consumed it first, this one does not get a session out of the same challenge.
    if (!(await this.pending.consume(challenge.organizationId, challenge.pendingId))) {
      return { outcome: 'rejected' };
    }

    const session = await this.sessions.issue(challenge.organizationId, challenge.userId, {
      userAgent: request.userAgent,
      ip: request.ip,
    });

    this.logger.log(`session issued for user ${challenge.userId} via ${verified.used}`);
    return {
      outcome: 'ok',
      session,
      userId: challenge.userId,
      organizationId: challenge.organizationId,
      used: verified.used,
    };
  }

  /**
   * Ask the database to fold the address.
   *
   * A TypeScript reimplementation would have to reproduce ICU's handling of the Turkish dotted
   * capital I and NFKC normalisation exactly, and the moment it did not, the throttling key and the
   * uniqueness key would disagree — which is the same class of bug migration 0001 was written to
   * close.
   */
  private async fold(email: string): Promise<string> {
    const rows = await this.db.withoutTenant('login-throttle', (q) =>
      q.query<{ folded: string }>('SELECT public.fold_identity($1) AS folded', [email]),
    );
    return rows[0]?.folded ?? email.toLowerCase();
  }

  private async findUser(organizationId: string, usernameFolded: string): Promise<UserRow | null> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<UserRow>(
        `SELECT id::text AS id, password_hash
           FROM users
          WHERE username_folded = $1
            AND disabled_at IS NULL`,
        [usernameFolded],
      ),
    );
    return rows[0] ?? null;
  }
}
