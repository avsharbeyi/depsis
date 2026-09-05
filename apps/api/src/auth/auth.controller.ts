import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { headerString, isSecure, requireSameOrigin } from './origin.js';

/**
 * Response bodies typed against the generated view of `openapi/depsis.yaml`.
 *
 * This is what makes ADR-0001's "contract is the single source" enforceable rather than aspirational
 * — renaming a field in the YAML now breaks the build here, instead of silently producing a client
 * that asks for something the server does not send. The route-level check in `contract.test.ts`
 * catches a path that exists in one place and not the other; these catch the shape.
 */
type Schemas = OpenApi.components['schemas'];

import { AuditService } from '../audit/audit.service.js';
import { ProblemException } from '../common/problem.filter.js';
import { AuthService } from './auth.service.js';
import {
  PENDING_COOKIE,
  readCookie,
  serializeClearedPendingCookie,
  serializeClearedSessionCookie,
  serializePendingCookie,
  serializeSessionCookie,
} from './cookie.js';
import { SessionGuard, type AuthenticatedRequest } from './session.guard.js';
import { SessionService } from './session.service.js';

/**
 * ADR-0001 makes runtime validation mandatory at every boundary. The bounds are not decoration:
 * an unbounded password field is an unbounded Argon2 input, and Argon2's cost is a function of the
 * input it is handed.
 */
const loginSchema = z.object({
  // A username, not an address. A NAS on a home network sends no mail and verifies nothing,
  // so an address here was a second thing to type and a second thing to typo. The tenant is
  // gone too: `system_setup` is a singleton, so the box has exactly one organisation and
  // asking which one was a question with a single possible answer.
  username: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  // Optional, and the interface never sends it. Only a box holding more than one organisation
  // needs it, which a claimed appliance never does.
  organizationSlug: z.string().trim().min(1).max(63).optional(),
  password: z.string().min(1).max(1024),
});

/** A TOTP code is six digits and a recovery code is twenty characters; 64 is generous for both. */
const secondFactorSchema = z.object({
  code: z.string().min(1).max(64),
});

type LoginResponse = Schemas['LoginResult'];

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponse> {
    requireSameOrigin(request);

    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      // A malformed body gets the same refusal as bad credentials. Reporting which field was wrong
      // would tell a caller that the fields it DID get right were accepted.
      throw new UnauthorizedException();
    }

    const result = await this.auth.login({
      username: parsed.data.username,
      organizationSlug: parsed.data.organizationSlug,
      password: parsed.data.password,
      userAgent: headerString(request, 'user-agent'),
      ip: clientIp(request),
    });

    if (result.outcome === 'throttled') {
      // 429, not 401 and not 403. The caller genuinely should retry later, and a client that cannot
      // tell "wrong password" from "slow down" will hammer a throttle it is already failing.
      //
      // VE SÜREYİ SÖYLÜYOR. Çıplak `HttpException` gövdesinde de başlığında da bir sayı taşımıyor
      // (`ProblemFilter` `Retry-After`'ı yalnız `ProblemException.retryAfter`'dan yazıyor), ve giriş
      // ekranı bu yüzden sabit bir "bir dakika bekleyin" cümlesi gösteriyordu. Gerçek bekleme
      // pencere 15 dakika olduğu için çok daha uzun: reddedilen deneme kaydedilmediğinden sayaç
      // kendiliğinden azalmaz, onuncu hatanın yaşlanmasını beklemek gerekir. Bir dakika sonra
      // dönüp yine 429 alan sahibi cihazın bozulduğunu sanıyordu.
      const minutes = Math.ceil(result.retryAfterSeconds / 60);
      throw new ProblemException(
        'rate-limited',
        `Bu adresten çok fazla başarısız giriş denemesi yapıldı. ${minutes} dakika sonra ` +
          'yeniden deneyin.',
        undefined,
        result.retryAfterSeconds,
      );
    }
    if (result.outcome === 'rejected') {
      throw new UnauthorizedException();
    }

    if (result.outcome === 'mfa-required') {
      // A challenge cookie, NOT a session cookie. Nothing is authenticated yet, and giving this
      // state the session's name is how it would eventually be treated as one.
      response.setHeader(
        'Set-Cookie',
        serializePendingCookie(result.challenge.token, {
          secure: isSecure(request),
          expires: result.challenge.expiresAt,
        }),
      );
      return { status: 'mfa_required' };
    }

    response.setHeader(
      'Set-Cookie',
      serializeSessionCookie(result.session.token, {
        secure: isSecure(request),
        expires: result.session.expiresAt,
      }),
    );

    // The body carries nothing beyond the outcome. The session is the cookie; echoing a user id or
    // an organization id here would put tenant identifiers in a response body that a cross-site
    // page could not read but a proxy log could.
    return { status: 'ok' };
  }

  /**
   * The second step. Consumes the challenge cookie and, on success, replaces it with a session.
   *
   * Notice what this does NOT take: a user id, an organization, or any hint of which account is
   * being authenticated. All of that comes from the challenge token, which the server issued —
   * ADR-0015 §6 applied to a request that is halfway through authenticating.
   */
  // The path comes from packages/contracts/openapi/depsis.yaml, not from what reads best here.
  // ADR-0001 makes the contract the single source and generates the web client from it, so an
  // endpoint the spec does not describe is an endpoint the client cannot call. `/auth/login/mfa`
  // was the first spelling and it lost to the one already written down.
  @Post('mfa/verify')
  @HttpCode(200)
  async secondFactor(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Schemas['MfaVerifyResult']> {
    requireSameOrigin(request);

    const token = readCookie(request.headers.cookie, PENDING_COOKIE);
    const parsed = secondFactorSchema.safeParse(body);

    if (token === null || !parsed.success) {
      throw new UnauthorizedException();
    }

    const result = await this.auth.completeSecondFactor({
      challengeToken: token,
      code: parsed.data.code,
      userAgent: headerString(request, 'user-agent'),
      ip: clientIp(request),
    });

    if (result.outcome !== 'ok') {
      // The challenge cookie is deliberately LEFT in place on a wrong code: the challenge has a
      // bounded attempt count of its own, and clearing the cookie would turn every typo into a
      // restart of the whole login rather than a retry.
      throw new UnauthorizedException();
    }

    response.setHeader('Set-Cookie', [
      serializeClearedPendingCookie(isSecure(request)),
      serializeSessionCookie(result.session.token, {
        secure: isSecure(request),
        expires: result.session.expiresAt,
      }),
    ]);

    // The one thing worth telling the client: a recovery code was spent, so the UI can say how many
    // are left and push the user to re-enrol. Saying it here rather than making them go looking is
    // the difference between noticing and running out.
    return { status: 'ok', usedRecoveryCode: result.used === 'recovery-code' };
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ status: 'ok' }> {
    requireSameOrigin(request);

    const session = request.depsis;
    if (session !== undefined) {
      await this.sessions.revoke(session.organizationId, session.sessionId);
    }

    // Cleared whether or not the revoke found anything, so a client is never left holding a cookie
    // the server has already forgotten — and cleared BEFORE the audit write, so a failing audit
    // insert cannot leave the browser holding a cookie for a session the line above just ended.
    response.setHeader('Set-Cookie', serializeClearedSessionCookie(isSecure(request)));

    if (session !== undefined) {
      await this.audit.record(session.organizationId, {
        actorId: session.userId,
        action: 'auth.logout',
        summary: 'Oturum kapatıldı.',
        ip: clientIp(request),
      });
    }
    return { status: 'ok' };
  }
}

/**
 * The address the throttle counts against.
 *
 * `req.ip` honours X-Forwarded-For only when Express is configured to trust a proxy. That is
 * deliberate and it is the safe default: taking the header on trust lets any caller pick their own
 * throttling bucket by sending a different value, which is the same class of mistake as reading a
 * tenant id from a request header.
 */
function clientIp(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? '0.0.0.0';
}
