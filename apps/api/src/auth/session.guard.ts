import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import type { Request } from 'express';

import { readCookie, SESSION_COOKIE } from './cookie.js';
import { SessionService, type ResolvedSession } from './session.service.js';

/** What a handler is allowed to know about who is calling. */
export interface AuthenticatedRequest extends Request {
  depsis?: ResolvedSession;
}

/**
 * Turn a cookie into a tenant context, or refuse.
 *
 * ADR-0015 §6: the tenant is never read from the request. A header, a query parameter or a body
 * field naming an organization is ignored — the only thing the caller supplies is an opaque token,
 * and the server decides what it means. This is the HTTP-side counterpart of the agent's
 * SO_PEERCRED rule.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);

    if (token === null) {
      throw new UnauthorizedException();
    }

    const session = await this.sessions.resolve(token);
    if (session === null) {
      // Deliberately the same response as a missing cookie. Expired, revoked, belonging to a
      // disabled user, and never existing are one outcome here, exactly as they are one outcome in
      // `resolve_session` (migration 0003).
      throw new UnauthorizedException();
    }

    request.depsis = session;
    return true;
  }
}

/**
 * The organisation's administrators, and nobody else.
 *
 * Stacked AFTER `SessionGuard` — it reads the session that guard established rather than resolving
 * one itself, so there is exactly one place a cookie becomes an identity.
 *
 * 403 rather than 404, and the distinction is deliberate here where it is refused elsewhere: these
 * endpoints leak nothing by admitting they exist. `GET /users` is not a secret; who may call it is.
 * The endpoints that DO leak by existing — a file belonging to another tenant — answer 404, and
 * that difference is a decision rather than an inconsistency.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const session = request.depsis;
    // Not merely "not an admin": an absent session here means this guard was mounted without
    // `SessionGuard` in front of it, which would otherwise fail OPEN on every request.
    if (session === undefined) throw new UnauthorizedException();
    if (session.role !== 'admin') {
      throw new ForbiddenException('this endpoint is for administrators');
    }
    return true;
  }
}
