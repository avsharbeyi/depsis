import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP, and RFC 4648 base32 to carry the secret.
 *
 * Written here rather than pulled from a package, and the reason is that this is the rare case
 * where hand-rolling is the auditable choice: TOTP is not a cryptographic design, it is HMAC-SHA1
 * followed by a documented truncation, and **the RFC publishes test vectors**. So the
 * implementation can be measured against ground truth rather than trusted — which is this
 * project's standard for everything else and would not be available for a dependency without
 * reading its source anyway.
 *
 * `totp.test.ts` runs every vector from RFC 6238 Appendix B. If those pass, this is TOTP; if they
 * do not, no amount of review would have made it TOTP.
 */

/** RFC 6238 §4 default, and what every authenticator app assumes. */
export const PERIOD_SECONDS = 30;
export const DIGITS = 6;

/**
 * How many periods either side of "now" are accepted.
 *
 * One step, so a code is valid for at most 90 seconds. RFC 6238 §5.2 recommends at most one step
 * and explains the trade: every extra step widens the window in which a code observed over the
 * user's shoulder, or captured in a phishing proxy, still works.
 */
export const DEFAULT_WINDOW = 1;

/**
 * Generate a secret.
 *
 * 20 bytes = 160 bits, which is the HMAC-SHA1 block-appropriate size RFC 4226 §4 recommends and
 * what authenticator apps expect. Longer buys nothing here: the output is six digits regardless.
 */
export function generateSecret(): Buffer {
  return randomBytes(20);
}

/**
 * One TOTP value for a given secret and unix time.
 *
 * `algorithm` is a parameter only so the RFC's SHA-256 and SHA-512 vectors can be run against it.
 * DEPSIS issues SHA-1 secrets because that is what authenticator apps implement; offering a choice
 * in the enrolment flow would produce QR codes half the apps silently compute wrongly.
 */
export function totp(
  secret: Buffer,
  unixSeconds: number,
  options: { digits?: number; period?: number; algorithm?: 'sha1' | 'sha256' | 'sha512' } = {},
): string {
  const digits = options.digits ?? DIGITS;
  const period = options.period ?? PERIOD_SECONDS;
  const algorithm = options.algorithm ?? 'sha1';

  // The counter is a 64-bit big-endian integer. `Math.floor` on a Number is exact well past any
  // plausible date — 2^53 seconds is far beyond year 285 million — so BigInt is used for the
  // encoding rather than for the arithmetic.
  const counter = BigInt(Math.floor(unixSeconds / period));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);

  const digest = createHmac(algorithm, secret).update(message).digest();

  // RFC 4226 §5.3 dynamic truncation: the low nibble of the last byte selects a four-byte window,
  // and the top bit of that window is masked off so the result is a positive 31-bit integer.
  const lastByte = digest[digest.length - 1];
  if (lastByte === undefined) throw new Error('empty HMAC digest');
  const offset = lastByte & 0x0f;

  const b0 = digest[offset];
  const b1 = digest[offset + 1];
  const b2 = digest[offset + 2];
  const b3 = digest[offset + 3];
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) {
    throw new Error('HMAC digest too short for dynamic truncation');
  }

  const binary = ((b0 & 0x7f) << 24) | (b1 << 16) | (b2 << 8) | b3;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Check a code against the accepted window, in constant time per candidate.
 *
 * Returns the matching step offset (so the caller can store it and refuse a replay of the same
 * step), or null.
 *
 * The comparison is `timingSafeEqual` rather than `===` and the loop does not break early. A loop
 * that returned as soon as it matched would leak, through timing, WHICH step matched — which is a
 * small leak, but the fix costs two comparisons and no thought.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  unixSeconds: number,
  options: { window?: number; digits?: number; period?: number } = {},
): number | null {
  const window = options.window ?? DEFAULT_WINDOW;
  const digits = options.digits ?? DIGITS;
  const period = options.period ?? PERIOD_SECONDS;

  const candidate = code.trim().replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(candidate)) return null;

  const supplied = Buffer.from(candidate, 'utf8');
  let matched: number | null = null;

  for (let step = -window; step <= window; step += 1) {
    const expected = Buffer.from(
      totp(secret, unixSeconds + step * period, { digits, period }),
      'utf8',
    );
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) {
      matched = step;
    }
  }
  return matched;
}

// ─── RFC 4648 base32, for the otpauth:// URI ──────────────────────────────────
//
// Authenticator apps read the secret as base32. Node has base64 built in and no base32, and the
// alphabet is thirty-two characters — so this is here for the same reason the cookie helpers are.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];

  // Padding to a multiple of eight is what RFC 4648 specifies. Authenticator apps generally accept
  // it either way, but a QR code that some scanner rejects is a support ticket nobody can debug.
  while (output.length % 8 !== 0) output += '=';
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`not base32: ${JSON.stringify(char)}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * The URI an authenticator app scans.
 *
 * The label and issuer are percent-encoded because both come from tenant and user data. An
 * unencoded `:` or `&` in a display name would silently produce a QR code that enrols the wrong
 * account name — cosmetic until the user has three of them and cannot tell which is which.
 */
export function otpauthUri(params: {
  secret: Buffer;
  accountName: string;
  issuer: string;
}): string {
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.accountName)}`;
  const query = new URLSearchParams({
    secret: base32Encode(params.secret).replace(/=+$/, ''),
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
