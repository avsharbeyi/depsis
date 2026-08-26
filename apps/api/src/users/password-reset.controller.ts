import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';

import { MfaService } from '../auth/mfa.service.js';
import { AuditService } from '../audit/audit.service.js';
import { requireSameOrigin } from '../auth/origin.js';
import { PasswordResetService } from '../auth/password-reset.service.js';
import { PasswordService } from '../auth/password.service.js';
import { SessionService } from '../auth/session.service.js';
import { ProblemException } from '../common/problem.filter.js';
import { UsersService } from './users.service.js';

/** Mirrors `users.controller.ts`. A length floor and nothing else — §13 asks for strength, not theatre. */
const MIN_PASSWORD = 12;

/**
 * Redeeming a ticket.
 *
 * `code` is optional in the SHAPE and required by the RULE when the account is enrolled. It has to
 * be optional here because the caller has no way to know whether the account carries a second
 * factor — and refusing a request that omits it would answer that question for anybody holding a
 * stolen ticket.
 */
const redeemSchema = z.object({
  token: z.string().min(1).max(512),
  password: z.string().min(MIN_PASSWORD).max(1024),
  code: z.string().min(1).max(64).optional(),
});

/**
 * The user's half of a password reset.
 *
 * WHY IT IS NOT IN `AuthController`. Setting a password means calling
 * `UsersService.setPasswordHash`, which is the single place that reseals the SMB credential in the
 * same transaction — and `UsersModule` already imports `AuthModule`, so putting this route the
 * other way round would make the two modules import each other. A controller's path does not have
 * to match its module, so it lives here and serves `/auth/password-reset`, next to the flow it
 * belongs to from the client's side.
 */
@Controller('auth')
export class PasswordResetController {
  private readonly logger = new Logger(PasswordResetController.name);

  constructor(
    private readonly resets: PasswordResetService,
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Redeem a reset ticket and choose a new password.
   *
   * UNAUTHENTICATED, which is the entire point: the person using this cannot sign in. What
   * authorises it is the token the administrator issued and handed over.
   *
   * THE SECOND FACTOR IS STILL REQUIRED. For an enrolled account, a reset without a code would be
   * a way to walk straight past MFA holding a stolen slip of paper — the one thing a second factor
   * exists to prevent. So an enrolled account produces an authenticator code or a recovery code
   * here, exactly as it would at sign-in. An account with no second factor needs only the token,
   * because there is no second factor to skip.
   *
   * EVERY SESSION OF THAT USER DIES. A password change is what somebody does when they believe
   * their credentials are held by another person; leaving that person signed in makes the change
   * meaningless. Nothing is kept alive here — the caller has no session to keep.
   *
   * ONE ANSWER FOR EVERY FAILURE. An unknown token, an expired one, a spent one, one belonging to
   * a disabled account, and a wrong second factor are all 401 with the same body. Telling them
   * apart would make this an oracle for which tickets exist.
   */
  @Post('password-reset')
  @HttpCode(200)
  async redeem(@Req() request: Request, @Body() body: unknown): Promise<{ status: 'ok' }> {
    requireSameOrigin(request);
    const parsed = redeemSchema.safeParse(body);
    if (!parsed.success) {
      // 422 rather than 401, and it is not a leak: this is about the SHAPE of the request and is
      // decided before the token is looked at, so it says nothing about whether the token exists.
      throw new ProblemException(
        'validation-failed',
        `Yeni parola en az ${MIN_PASSWORD} karakter olmalı.`,
      );
    }

    const reset = await this.resets.resolve(parsed.data.token);
    if (reset === null) throw new UnauthorizedException();

    if (await this.mfa.isEnrolled(reset.organizationId, reset.userId)) {
      const code = parsed.data.code ?? '';
      const verdict =
        code === ''
          ? ({ outcome: 'rejected' } as const)
          : await this.mfa.verifySecondFactor(reset.organizationId, reset.userId, code);
      if (verdict.outcome !== 'ok') {
        // Counted against the TICKET, not the account. A token whose holder cannot produce the
        // code is a token being guessed at, and burning the ticket is right; locking the account
        // would let anybody with a stolen slip deny the real user their own sign-in.
        await this.resets.recordAttempt(reset.organizationId, reset.resetId);
        throw new UnauthorizedException();
      }
    }

    // BEFORE the password is written. `consume` is a conditional UPDATE, so two redemptions racing
    // cannot both win — and the loser must not be the one that set the password.
    if (!(await this.resets.consume(reset.organizationId, reset.resetId))) {
      throw new UnauthorizedException();
    }

    const hash = await this.passwords.hash(parsed.data.password);
    // The plaintext goes with it, and this is the only moment it exists. Without it the web
    // password would change and the SMB password would silently not — the two-realities failure
    // the identity design exists to prevent.
    await this.users.setPasswordHash(
      reset.organizationId,
      reset.userId,
      hash,
      parsed.data.password,
    );
    await this.sessions.revokeAllForUser(reset.organizationId, reset.userId);
    // Aktör hesabın KENDİSİ: bileti kullanan, hesabın yeni sahibi olduğunu kanıtlamış kişidir
    // (bilet + varsa ikinci adım). Bileti kimin açtığı zaten ayrı bir satır.
    await this.audit.record(reset.organizationId, {
      actorId: reset.userId,
      action: 'auth.password-reset-redeemed',
      summary: 'Parola sıfırlama bileti kullanıldı; parola değişti, tüm oturumlar kapatıldı.',
      ip: request.ip ?? null,
    });

    this.logger.warn(`password reset redeemed for user ${reset.userId}`);
    return { status: 'ok' };
  }
}
