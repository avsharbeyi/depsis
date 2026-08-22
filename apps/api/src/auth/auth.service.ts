import { Injectable, Logger } from '@nestjs/common';

import { DbService } from '../db/db.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { MfaService } from './mfa.service.js';
import { PasswordService } from './password.service.js';
import { PendingLoginService, type PendingChallenge } from './pending-login.service.js';
import { SessionService, type IssuedSession } from './session.service.js';

export interface LoginRequest {
  organizationSlug: string;
  email: string;
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
    const emailNormalized = await this.fold(request.email);

    if (!(await this.throttle.gate(emailNormalized, request.ip))) {
      return { outcome: 'throttled' };
    }

    const organizationId = await this.organizations.resolveIdBySlug(request.organizationSlug);

    // An unknown tenant still pays for a password verification. Returning here without one would
    // make tenant enumeration a matter of timing the response.
    const user =
      organizationId === null ? null : await this.findUser(organizationId, emailNormalized);

    const ok = await this.passwords.verify(user?.password_hash ?? null, request.password);

    if (!ok || user === null || organizationId === null) {
      await this.throttle.record(emailNormalized, request.ip, false);
      // The CLIENT is told one thing — `rejected` — for all three causes, and that stays true: any
      // difference visible to a caller is an oracle for which organisations and addresses exist.
      //
      // The OPERATOR is told which one. §16 asks that what happened on this box be explicable
      // afterwards, and "someone could not sign in" without saying whether the tenant, the account
      // or the password was wrong is the least useful line a journal can carry. This was written
      // after a real sign-in failure that took three rounds of guessing to place — the answer was
      // in the server and the server had not written it down.
      this.logger.warn(
        `login rejected: organization ${organizationId === null ? 'not found' : 'ok'}, ` +
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
      await this.throttle.record(emailNormalized, request.ip, true);
      return { outcome: 'mfa-required', challenge };
    }

    const session = await this.sessions.issue(organizationId, user.id, {
      userAgent: request.userAgent,
      ip: request.ip,
    });

    await this.throttle.record(emailNormalized, request.ip, true);
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

  private async findUser(organizationId: string, emailNormalized: string): Promise<UserRow | null> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<UserRow>(
        `SELECT id::text AS id, password_hash
           FROM users
          WHERE email_normalized = $1
            AND disabled_at IS NULL`,
        [emailNormalized],
      ),
    );
    return rows[0] ?? null;
  }
}
