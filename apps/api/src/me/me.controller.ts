import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { z } from 'zod';

import { requireSameOrigin } from '../auth/origin.js';
import { MfaService } from '../auth/mfa.service.js';
import { PasswordService } from '../auth/password.service.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { SessionService } from '../auth/session.service.js';
import { DbService } from '../db/db.service.js';

type Schemas = OpenApi.components['schemas'];

const confirmSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
const passwordSchema = z.object({ password: z.string().min(1).max(1024) });

/**
 * A length floor and nothing else.
 *
 * A composition rule ("one digit, one symbol") measurably pushes people towards `Passw0rd!` and
 * buys less than four more characters would.
 */
const MIN_PASSWORD = 12;
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(MIN_PASSWORD).max(1024),
});

interface UserRow {
  id: string;
  username: string;
  email: string | null;
  password_hash: string | null;
  slug: string;
}

/**
 * The account the session belongs to, and its second factor.
 *
 * Every route here is behind `SessionGuard`, so the tenant and the user come from the session and
 * never from the request (ADR-0015 §6). Nothing takes a user id: an endpoint that accepted one
 * would be an endpoint someone eventually calls with a different one.
 */
@Controller('me')
@UseGuards(SessionGuard)
export class MeController {
  constructor(
    private readonly db: DbService,
    private readonly mfa: MfaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Change one's own password.
   *
   * The current password is required even though the caller already holds a session, and that is
   * not ceremony: a session is what an attacker has when they borrow an unlocked laptop, and
   * without this step it is all they need to lock the owner out of their own account permanently.
   *
   * Every OTHER session is revoked afterwards. A password change is the thing a person does when
   * they believe someone else has their credentials, and leaving that someone signed in makes the
   * change worthless. The current session survives, because signing the user out of the tab they
   * just used teaches them to avoid the feature.
   */
  @Post('password')
  @HttpCode(200)
  async changePassword(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ status: 'ok'; otherSessionsRevoked: number }> {
    requireSameOrigin(request);
    const session = requireSession(request);
    const parsed = changePasswordSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        `currentPassword and a newPassword of at least ${MIN_PASSWORD} characters are required`,
      );
    }

    const user = await this.load(session.organizationId, session.userId);
    if (!(await this.passwords.verify(user.password_hash, parsed.data.currentPassword))) {
      throw new UnauthorizedException('the current password is wrong');
    }

    const hash = await this.passwords.hash(parsed.data.newPassword);
    await this.db.withTenant(session.organizationId, (db) =>
      db.query(
        `UPDATE public.users SET password_hash = $3 WHERE organization_id = $1 AND id = $2`,
        [session.organizationId, session.userId, hash],
      ),
    );

    const revoked = await this.sessions.revokeAllForUser(session.organizationId, session.userId);
    // `revokeAllForUser` takes this one too, so it is reissued rather than left dead — the caller
    // asked to change a password, not to be signed out.
    await this.db.withTenant(session.organizationId, (db) =>
      db.query(`UPDATE sessions SET revoked_at = NULL WHERE id = $1`, [session.sessionId]),
    );
    return { status: 'ok', otherSessionsRevoked: Math.max(0, revoked - 1) };
  }

  @Get()
  async me(@Req() request: AuthenticatedRequest): Promise<Schemas['CurrentUser']> {
    const session = requireSession(request);
    const user = await this.load(session.organizationId, session.userId);

    return {
      id: user.id,
      username: user.username,
      // From the SESSION, which read it in the same statement that resolved the cookie — not from
      // the row loaded here, which is a second read and therefore a second moment.
      role: request.depsis?.role ?? 'member',
      organizationSlug: user.slug,
      mfaEnrolled: await this.mfa.isEnrolled(session.organizationId, session.userId),
      recoveryCodesRemaining: await this.mfa.remainingRecoveryCodes(
        session.organizationId,
        session.userId,
      ),
    };
  }

  @Post('mfa/enrolment')
  @HttpCode(200)
  async beginEnrolment(@Req() request: AuthenticatedRequest): Promise<Schemas['MfaEnrolment']> {
    requireSameOrigin(request);
    const session = requireSession(request);

    // Refused rather than silently replaced. Overwriting a confirmed secret would let a session
    // that has already been taken over swap the second factor for one the attacker holds, without
    // the owner's password and without any visible event.
    if (await this.mfa.isEnrolled(session.organizationId, session.userId)) {
      throw new ConflictException('a second factor is already enrolled; remove it first');
    }

    const user = await this.load(session.organizationId, session.userId);
    // The label an authenticator app shows. The address is optional now, so the username is
    // what names the account — and it is the thing the person actually signs in with.
    return this.mfa.beginEnrolment(session.organizationId, session.userId, user.username);
  }

  @Post('mfa/enrolment/confirm')
  @HttpCode(200)
  async confirmEnrolment(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['RecoveryCodes']> {
    requireSameOrigin(request);
    const session = requireSession(request);
    const parsed = confirmSchema.safeParse(body);
    if (!parsed.success) throw new UnauthorizedException();

    const codes = await this.mfa.confirmEnrolment(
      session.organizationId,
      session.userId,
      parsed.data.code,
    );
    if (codes === null) throw new UnauthorizedException();
    return { codes };
  }

  @Delete('mfa')
  @HttpCode(204)
  async removeMfa(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<void> {
    requireSameOrigin(request);
    const session = await this.reauthenticate(request, body);

    await this.db.withTenant(session.organizationId, async (q) => {
      await q.query('DELETE FROM user_totp_secrets WHERE user_id = $1', [session.userId]);
      // The codes go with the secret. Leaving them would mean a printed sheet still opened an
      // account whose second factor had supposedly been removed.
      await q.query('DELETE FROM user_recovery_codes WHERE user_id = $1', [session.userId]);
    });

    // Every OTHER session is ended. Removing a second factor is exactly what someone who has stolen
    // a session would do first, so the owner's other devices should not silently keep working —
    // and §16 requires that a security event can end sessions.
    await this.sessions.revokeAllForUser(session.organizationId, session.userId);
  }

  @Post('mfa/recovery-codes')
  @HttpCode(200)
  async regenerateCodes(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['RecoveryCodes']> {
    requireSameOrigin(request);
    const session = await this.reauthenticate(request, body);

    if (!(await this.mfa.isEnrolled(session.organizationId, session.userId))) {
      throw new ConflictException('no second factor is enrolled');
    }
    const codes = await this.mfa.regenerateRecoveryCodes(session.organizationId, session.userId);
    return { codes };
  }

  /**
   * §0.5: an operation carrying security risk is not performed on the strength of a cookie alone.
   *
   * The session says who this is; the password says they are still at the keyboard. Both of the
   * operations that use this can lock the real owner out, so both ask.
   */
  private async reauthenticate(
    request: AuthenticatedRequest,
    body: unknown,
  ): Promise<{ organizationId: string; userId: string }> {
    const session = requireSession(request);
    const parsed = passwordSchema.safeParse(body);
    if (!parsed.success) throw new UnauthorizedException();

    const user = await this.load(session.organizationId, session.userId);
    if (!(await this.passwords.verify(user.password_hash, parsed.data.password))) {
      throw new UnauthorizedException();
    }
    return session;
  }

  private async load(organizationId: string, userId: string): Promise<UserRow> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<UserRow>(
        `SELECT u.id::text AS id, u.username, u.email, u.password_hash, o.slug
           FROM users u
           JOIN organizations o ON o.id = u.organization_id
          WHERE u.id = $1`,
        [userId],
      ),
    );
    const row = rows[0];
    // The guard resolved this session a moment ago, so a missing row means the account was deleted
    // in between. That is a dead session, not a server error.
    if (row === undefined) throw new UnauthorizedException();
    return row;
  }
}

function requireSession(request: AuthenticatedRequest): {
  organizationId: string;
  userId: string;
  sessionId: string;
} {
  const session = request.depsis;
  if (session === undefined) throw new UnauthorizedException();
  return {
    organizationId: session.organizationId,
    userId: session.userId,
    sessionId: session.sessionId,
  };
}
