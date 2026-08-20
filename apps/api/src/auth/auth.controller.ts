import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { AuthService } from './auth.service.js';
import { serializeClearedSessionCookie, serializeSessionCookie } from './cookie.js';
import { SessionGuard, type AuthenticatedRequest } from './session.guard.js';
import { SessionService } from './session.service.js';

/**
 * ADR-0001 makes runtime validation mandatory at every boundary. The bounds are not decoration:
 * an unbounded password field is an unbounded Argon2 input, and Argon2's cost is a function of the
 * input it is handed.
 */
const loginSchema = z.object({
  organizationSlug: z.string().min(1).max(63),
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(1024),
});

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ status: 'ok' }> {
    requireSameOrigin(request);

    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      // A malformed body gets the same refusal as bad credentials. Reporting which field was wrong
      // would tell a caller that the fields it DID get right were accepted.
      throw new UnauthorizedException();
    }

    const result = await this.auth.login({
      organizationSlug: parsed.data.organizationSlug,
      email: parsed.data.email,
      password: parsed.data.password,
      userAgent: headerString(request, 'user-agent'),
      ip: clientIp(request),
    });

    if (result.outcome === 'throttled') {
      // 429, not 401 and not 403. The caller genuinely should retry later, and a client that cannot
      // tell "wrong password" from "slow down" will hammer a throttle it is already failing.
      throw new HttpException('too many attempts', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (result.outcome === 'rejected') {
      throw new UnauthorizedException();
    }

    response.setHeader(
      'Set-Cookie',
      serializeSessionCookie(result.session.token, {
        secure: isSecure(request),
        expires: result.session.expiresAt,
      }),
    );

    // The body carries nothing. The session is the cookie; echoing a user id or an organization id
    // here would put tenant identifiers in a response body that a cross-site page could not read
    // but a proxy log could.
    return { status: 'ok' };
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
    // the server has already forgotten.
    response.setHeader('Set-Cookie', serializeClearedSessionCookie(isSecure(request)));
    return { status: 'ok' };
  }
}

/**
 * The second half of the CSRF defence.
 *
 * `SameSite=Lax` stops the cookie riding along on a cross-site POST in browsers that honour it, and
 * this refuses the request outright when the declared origin is not ours. Both are needed:
 * SameSite is a browser behaviour and this is a server decision, and ADR-0009 asks for an explicit
 * origin check precisely because the session is cookie-based.
 *
 * A request with NO Origin and no Referer is allowed: that is what a non-browser client sends, and
 * a non-browser client is not subject to CSRF — nobody can make curl send somebody else's cookie.
 */
function requireSameOrigin(request: Request): void {
  const origin = headerString(request, 'origin');
  const referer = headerString(request, 'referer');
  const declared = origin ?? (referer === null ? null : originOf(referer));
  if (declared === null) return;

  const host = headerString(request, 'host');
  if (host === null) throw new ForbiddenException('missing host');

  const expected = `${isSecure(request) ? 'https' : 'http'}://${host}`;
  if (declared !== expected) {
    throw new ForbiddenException('cross-origin request refused');
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function headerString(request: Request, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string' && value !== '') return value;
  return null;
}

function isSecure(request: Request): boolean {
  // `req.secure` already accounts for X-Forwarded-Proto when Express is told to trust the proxy.
  // If it is not told, this reports the direct connection — which is the safe direction to be
  // wrong in, since it only ever omits the `Secure` attribute rather than adding it wrongly.
  return request.secure;
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
