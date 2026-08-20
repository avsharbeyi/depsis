import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
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
