import { describe, expect, it } from 'vitest';

import {
  readCookie,
  SESSION_COOKIE,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from './cookie.js';
import { PasswordService } from './password.service.js';
import { generateToken, hashToken, secretsEqual, TOKEN_BYTES } from './token.js';

describe('session tokens', () => {
  it('are 32 bytes of entropy, base64url encoded', () => {
    const token = generateToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(TOKEN_BYTES);
    // base64url so it needs no escaping in a cookie; a `+`, `/` or `=` would.
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('do not repeat', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateToken()));
    expect(seen.size).toBe(500);
  });

  it('hash to 32 bytes, deterministically', () => {
    const token = generateToken();
    expect(hashToken(token)).toHaveLength(32);
    expect(hashToken(token).equals(hashToken(token))).toBe(true);
    expect(hashToken(token).equals(hashToken(generateToken()))).toBe(false);
  });

  it('cannot be recovered from the stored hash', () => {
    // Not a proof of SHA-256, obviously. It pins the property that matters at the call site: what
    // goes to the database does not contain the token.
    const token = generateToken();
    expect(hashToken(token).toString('base64url')).not.toContain(token);
  });
});

describe('secretsEqual', () => {
  it('compares equal secrets as equal', () => {
    expect(secretsEqual('abc', 'abc')).toBe(true);
  });

  it('rejects different secrets, including different lengths', () => {
    expect(secretsEqual('abc', 'abd')).toBe(false);
    // timingSafeEqual throws on a length mismatch, and a throw is itself a timing signal; this
    // pins that the length is checked first rather than allowed to blow up.
    expect(secretsEqual('abc', 'abcd')).toBe(false);
    expect(secretsEqual('', 'a')).toBe(false);
  });
});

describe('cookies', () => {
  it('reads the named cookie out of a header', () => {
    expect(readCookie('a=1; depsis_session=tok; b=2', SESSION_COOKIE)).toBe('tok');
    expect(readCookie('depsis_session=tok', SESSION_COOKIE)).toBe('tok');
  });

  it('returns null when absent, empty, or malformed', () => {
    expect(readCookie(undefined, SESSION_COOKIE)).toBeNull();
    expect(readCookie('', SESSION_COOKIE)).toBeNull();
    expect(readCookie('other=1', SESSION_COOKIE)).toBeNull();
    expect(readCookie('depsis_session=', SESSION_COOKIE)).toBeNull();
    expect(readCookie('novalue', SESSION_COOKIE)).toBeNull();
  });

  it('takes the first match and never concatenates duplicates', () => {
    // A caller who can get a second cookie of the same name into the header must not be able to
    // influence the value the server reads by appending to it.
    expect(readCookie('depsis_session=first; depsis_session=second', SESSION_COOKIE)).toBe('first');
  });

  it('does not match a cookie whose name merely contains ours', () => {
    expect(readCookie('xdepsis_session=nope', SESSION_COOKIE)).toBeNull();
    expect(readCookie('depsis_session_extra=nope', SESSION_COOKIE)).toBeNull();
  });

  it('sets HttpOnly, SameSite=Lax and a path on every cookie it writes', () => {
    const c = serializeSessionCookie('tok', { secure: true, expires: new Date(0) });
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Path=/');
    expect(c).toContain('Secure');
  });

  it('omits Secure on a plain-http deployment', () => {
    // ADR-0009 §S4: DEPSIS may be reached by IP with no trusted certificate. A `Secure` cookie on
    // plain http is dropped by the browser, which presents as "login silently does nothing".
    const c = serializeSessionCookie('tok', { secure: false, expires: new Date(0) });
    expect(c).not.toContain('Secure');
  });

  it('clears with an expiry in the past and the same attributes', () => {
    const c = serializeClearedSessionCookie(true);
    expect(c).toContain('depsis_session=;');
    expect(c).toContain('1970');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
  });
});

describe('PasswordService', () => {
  const passwords = new PasswordService();

  it('produces an Argon2id hash that verifies', async () => {
    const stored = await passwords.hash('correct horse battery staple');
    expect(stored.startsWith('$argon2id$')).toBe(true);
    await expect(passwords.verify(stored, 'correct horse battery staple')).resolves.toBe(true);
    await expect(passwords.verify(stored, 'wrong')).resolves.toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await passwords.hash('same');
    const b = await passwords.hash('same');
    expect(a).not.toBe(b);
    await expect(passwords.verify(a, 'same')).resolves.toBe(true);
    await expect(passwords.verify(b, 'same')).resolves.toBe(true);
  });

  it('returns false rather than throwing on a malformed stored hash', async () => {
    // A corrupt record must be a failed login, not a 500 — a 500 tells the caller the record
    // exists and is interesting.
    await expect(passwords.verify('not-a-hash', 'anything')).resolves.toBe(false);
    await expect(passwords.verify('$argon2id$v=19$m=1,t=1,p=1$aaa$bbb', 'x')).resolves.toBe(false);
  });

  it('spends comparable time on a missing account as on a wrong password', async () => {
    // The enumeration defence, measured rather than asserted. Without the decoy the null path
    // returns in microseconds while the real path costs an Argon2 verification — around 20 ms,
    // which is trivially distinguishable over a network.
    //
    // The bound is deliberately loose (a factor of four, both directions) because this runs on
    // whatever CI machine is free and a tight bound would be a flaky test rather than a stronger
    // guarantee. What it catches is the difference between "both paths hash" and "one path does
    // not", which is orders of magnitude, not tens of percent.
    const stored = await passwords.hash('a real password');

    const timeOf = async (fn: () => Promise<unknown>): Promise<number> => {
      const started = process.hrtime.bigint();
      await fn();
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    // Warm both paths first: the decoy hash is computed lazily on first use, and charging that
    // one-off cost to the measurement would make the null path look slower than it is.
    await passwords.verify(null, 'x');
    await passwords.verify(stored, 'x');

    const wrongPassword = await timeOf(() => passwords.verify(stored, 'wrong'));
    const noAccount = await timeOf(() => passwords.verify(null, 'wrong'));

    expect(noAccount).toBeGreaterThan(wrongPassword / 4);
    expect(noAccount).toBeLessThan(wrongPassword * 4);
  });
});
