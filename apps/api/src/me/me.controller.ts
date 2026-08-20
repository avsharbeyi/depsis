import {
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

import { MfaService } from '../auth/mfa.service.js';
import { PasswordService } from '../auth/password.service.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { SessionService } from '../auth/session.service.js';
import { DbService } from '../db/db.service.js';

type Schemas = OpenApi.components['schemas'];

const confirmSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
const passwordSchema = z.object({ password: z.string().min(1).max(1024) });

interface UserRow {
  id: string;
  email: string;
  display_name: string;
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

  @Get()
  async me(@Req() request: AuthenticatedRequest): Promise<Schemas['CurrentUser']> {
    const session = requireSession(request);
    const user = await this.load(session.organizationId, session.userId);

    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
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
    const session = requireSession(request);

    // Refused rather than silently replaced. Overwriting a confirmed secret would let a session
    // that has already been taken over swap the second factor for one the attacker holds, without
    // the owner's password and without any visible event.
    if (await this.mfa.isEnrolled(session.organizationId, session.userId)) {
      throw new ConflictException('a second factor is already enrolled; remove it first');
    }

    const user = await this.load(session.organizationId, session.userId);
    return this.mfa.beginEnrolment(session.organizationId, session.userId, user.email);
  }

  @Post('mfa/enrolment/confirm')
  @HttpCode(200)
  async confirmEnrolment(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['RecoveryCodes']> {
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
        `SELECT u.id::text AS id, u.email, u.display_name, u.password_hash, o.slug
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

function requireSession(request: AuthenticatedRequest): { organizationId: string; userId: string } {
  const session = request.depsis;
  // The guard sets this on every route in this controller. If it is missing the guard was removed,
  // and failing closed is the only safe reading of that.
  if (session === undefined) throw new UnauthorizedException();
  return { organizationId: session.organizationId, userId: session.userId };
}
