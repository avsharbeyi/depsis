import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';

/**
 * The second half of the CSRF defence.
 *
 * `SameSite=Lax` stops the cookie riding along on a cross-site POST in browsers that honour it, and
 * this refuses the request outright when the declared origin is not ours. Both are needed: SameSite
 * is a browser behaviour and this is a server decision, and ADR-0009 asks for an explicit origin
 * check precisely because the session is cookie-based.
 *
 * A request with NO Origin and no Referer is allowed: that is what a non-browser client sends, and
 * a non-browser client is not subject to CSRF — nobody can make curl send somebody else's cookie.
 *
 * This lives in its own file rather than beside the first controller that needed it. It was private
 * to `auth.controller.ts` and therefore applied to exactly the three routes in that file, which
 * left every other cookie-authenticated state change unprotected — including `DELETE /me/mfa`, the
 * one that removes a second factor. A defence that is easy to forget on the next controller is a
 * defence that will be.
 */
export function requireSameOrigin(request: Request): void {
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

/** A header as a non-empty string, or null. Exported because the login path records the caller's
 * user agent and this is the one place that already normalises Express's `string | string[]`. */
export function headerString(request: Request, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string' && value !== '') return value;
  return null;
}

/**
 * `req.secure` already accounts for X-Forwarded-Proto when Express is told to trust the proxy. If
 * it is not told, this reports the direct connection — the safe direction to be wrong in, since it
 * only ever omits the `Secure` cookie attribute rather than adding it wrongly.
 */
export function isSecure(request: Request): boolean {
  return request.secure;
}
