import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Session tokens: generated here, hashed here, and compared here.
 *
 * 32 bytes from the CSPRNG. That is 256 bits of entropy, so the token cannot be guessed and, as
 * migration 0003 argues, a UNIQUE collision on its hash is only reachable by someone who already
 * holds the value.
 */
export const TOKEN_BYTES = 32;

/** The value that goes in the cookie. base64url so it survives a cookie without escaping. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * The value that goes in the database.
 *
 * SHA-256 rather than Argon2, and migration 0003 explains why: the input is already full-entropy
 * random, so there is no dictionary attack to slow down, while a per-request Argon2 would put 20 ms
 * of CPU on the path every authenticated request takes.
 */
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * Constant-time comparison, for the places that compare a secret to a secret.
 *
 * Session lookup goes through the database by hash and does not use this; CSRF token comparison
 * does. Length is checked first because `timingSafeEqual` throws on a length mismatch, and a throw
 * is itself a timing signal.
 */
export function secretsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
