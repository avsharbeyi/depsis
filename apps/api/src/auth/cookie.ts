/**
 * Session cookie handling, written by hand rather than pulled in.
 *
 * Reading one cookie and writing one Set-Cookie is a dozen lines; a dependency here would be a
 * dependency on the request path of every authenticated call, for no capability this does not have.
 */

export const SESSION_COOKIE = 'depsis_session';

/**
 * The half-finished login.
 *
 * A separate cookie from the session, not a flag on the same one. Two names mean a piece of code
 * that expects a session cannot accidentally be handed a challenge — the mistake is unrepresentable
 * rather than merely discouraged.
 */
export const PENDING_COOKIE = 'depsis_pending';

/**
 * Find one cookie in a Cookie header.
 *
 * The header is attacker-controlled, so this does not split-and-trust: it takes the FIRST match
 * (browsers send the most specific first) and never concatenates duplicates, because a caller who
 * can inject a second cookie of the same name should not be able to influence the value the server
 * reads by appending to it.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined || header === '') return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value === '' ? null : value;
  }
  return null;
}

export interface CookieOptions {
  /** False only when the deployment is plain http, which ADR-0009 treats as a degraded mode. */
  secure: boolean;
  expires: Date;
}

/**
 * Build the Set-Cookie value.
 *
 * `HttpOnly` so script cannot read it; `SameSite=Lax` so it is not sent on cross-site POSTs, which
 * is the first half of the CSRF defence ADR-0009 requires; `Path=/` because the whole API is behind
 * it. `Secure` is a parameter rather than a constant: ADR-0009 §S4 records that DEPSIS may be
 * reached by IP without a trusted certificate, and a `Secure` cookie on plain http is simply
 * dropped — which would present as "login silently does nothing".
 */
export function serializeSessionCookie(token: string, options: CookieOptions): string {
  return build(SESSION_COOKIE, token, options, 'Lax');
}

/**
 * The challenge cookie, with `SameSite=Strict` rather than `Lax`.
 *
 * Stricter than the session cookie on purpose: nothing legitimately navigates INTO the second
 * factor step from another site, so there is no usability cost, and the cookie exists for five
 * minutes at most.
 */
export function serializePendingCookie(token: string, options: CookieOptions): string {
  return build(PENDING_COOKIE, token, options, 'Strict');
}

export function serializeClearedPendingCookie(secure: boolean): string {
  return build(PENDING_COOKIE, '', { secure, expires: EPOCH }, 'Strict');
}

const EPOCH = new Date(0);

function build(
  name: string,
  token: string,
  options: CookieOptions,
  sameSite: 'Lax' | 'Strict',
): string {
  const parts = [
    `${name}=${token}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${sameSite}`,
    `Expires=${options.expires.toUTCString()}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** The same cookie, expired, which is how a cookie is deleted. */
export function serializeClearedSessionCookie(secure: boolean): string {
  return build(SESSION_COOKIE, '', { secure, expires: EPOCH }, 'Lax');
}
