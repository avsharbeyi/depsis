import { Injectable, Logger } from '@nestjs/common';

import { DbService } from '../db/db.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { PasswordService } from './password.service.js';
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
  | { outcome: 'rejected' }
  | { outcome: 'throttled' };

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
      return { outcome: 'rejected' };
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
