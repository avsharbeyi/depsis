import { describe, expect, it } from 'vitest';

import {
  base32Decode,
  base32Encode,
  generateSecret,
  otpauthUri,
  PERIOD_SECONDS,
  totp,
  verifyTotp,
} from './totp.js';

/**
 * RFC 6238 Appendix B, in full.
 *
 * This is the whole justification for implementing TOTP here rather than depending on a package:
 * the RFC publishes ground truth, so the implementation can be measured instead of trusted. If
 * these pass it is TOTP; if they do not, no amount of code review would have made it TOTP.
 *
 * The RFC's vectors use an ASCII secret repeated to the algorithm's block size — 20 bytes for
 * SHA-1, 32 for SHA-256, 64 for SHA-512 — and eight digits.
 */
const SEED_SHA1 = Buffer.from('12345678901234567890', 'ascii');
const SEED_SHA256 = Buffer.from('12345678901234567890123456789012', 'ascii');
const SEED_SHA512 = Buffer.from(
  '1234567890123456789012345678901234567890123456789012345678901234',
  'ascii',
);

describe('RFC 6238 Appendix B test vectors', () => {
  const vectors: Array<{ time: number; sha1: string; sha256: string; sha512: string }> = [
    { time: 59, sha1: '94287082', sha256: '46119246', sha512: '90693936' },
    { time: 1_111_111_109, sha1: '07081804', sha256: '68084774', sha512: '25091201' },
    { time: 1_111_111_111, sha1: '14050471', sha256: '67062674', sha512: '99943326' },
    { time: 1_234_567_890, sha1: '89005924', sha256: '91819424', sha512: '93441116' },
    { time: 2_000_000_000, sha1: '69279037', sha256: '90698825', sha512: '38618901' },
    { time: 20_000_000_000, sha1: '65353130', sha256: '77737706', sha512: '47863826' },
  ];

  for (const v of vectors) {
    it(`t=${v.time} matches all three algorithms`, () => {
      expect(totp(SEED_SHA1, v.time, { digits: 8, algorithm: 'sha1' })).toBe(v.sha1);
      expect(totp(SEED_SHA256, v.time, { digits: 8, algorithm: 'sha256' })).toBe(v.sha256);
      expect(totp(SEED_SHA512, v.time, { digits: 8, algorithm: 'sha512' })).toBe(v.sha512);
    });
  }
});

describe('totp', () => {
  it('produces six digits, zero-padded', () => {
    // A truncation that drops a leading zero is the classic TOTP bug: it works for 90% of codes and
    // fails for the rest, which reads to a user as "my authenticator is broken sometimes".
    const secret = generateSecret();
    for (let t = 0; t < 3000; t += 7) {
      expect(totp(secret, t)).toMatch(/^\d{6}$/);
    }
  });

  it('is stable within a period and changes across one', () => {
    const secret = generateSecret();
    const base = 1_700_000_000 - (1_700_000_000 % PERIOD_SECONDS);
    expect(totp(secret, base)).toBe(totp(secret, base + PERIOD_SECONDS - 1));
    expect(totp(secret, base)).not.toBe(totp(secret, base + PERIOD_SECONDS));
  });

  it('differs between secrets', () => {
    expect(totp(generateSecret(), 1_700_000_000)).not.toBe(totp(generateSecret(), 1_700_000_000));
  });
});

describe('verifyTotp', () => {
  const secret = generateSecret();
  const now = 1_700_000_000;

  it('accepts the current code and reports step 0', () => {
    expect(verifyTotp(secret, totp(secret, now), now)).toBe(0);
  });

  it('accepts one step either side, and reports which', () => {
    // The tolerance exists for clock skew between the phone and the server. Reporting WHICH step
    // matched is what lets the caller refuse a replay of that same step.
    expect(verifyTotp(secret, totp(secret, now - PERIOD_SECONDS), now)).toBe(-1);
    expect(verifyTotp(secret, totp(secret, now + PERIOD_SECONDS), now)).toBe(1);
  });

  it('refuses two steps away', () => {
    expect(verifyTotp(secret, totp(secret, now - 2 * PERIOD_SECONDS), now)).toBeNull();
    expect(verifyTotp(secret, totp(secret, now + 2 * PERIOD_SECONDS), now)).toBeNull();
  });

  it('refuses anything that is not six digits', () => {
    for (const junk of ['', '12345', '1234567', 'abcdef', '12 34 56 78', '../etc', '000000x']) {
      expect(verifyTotp(secret, junk, now), junk).toBeNull();
    }
  });

  it('tolerates spacing, because authenticator apps display codes in groups', () => {
    const code = totp(secret, now);
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(0);
  });

  it('refuses a code from a different secret', () => {
    expect(verifyTotp(secret, totp(generateSecret(), now), now)).toBeNull();
  });
});

describe('base32', () => {
  it('round-trips a secret', () => {
    const secret = generateSecret();
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
  });

  it('matches RFC 4648 §10 test vectors', () => {
    // Ground truth again rather than "it round-trips", which a consistently wrong implementation
    // would also satisfy — and an authenticator app would then compute different codes.
    const cases: Array<[string, string]> = [
      ['', ''],
      ['f', 'MY======'],
      ['fo', 'MZXQ===='],
      ['foo', 'MZXW6==='],
      ['foob', 'MZXW6YQ='],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI======'],
    ];
    for (const [plain, encoded] of cases) {
      expect(base32Encode(Buffer.from(plain, 'ascii')), plain).toBe(encoded);
      expect(base32Decode(encoded).toString('ascii'), encoded).toBe(plain);
    }
  });

  it('rejects characters outside the alphabet', () => {
    // Base32 has no 0, 1 or 8 — they are excluded because they are confusable with O, I and B when
    // a user reads a secret off a screen.
    expect(() => base32Decode('AAAA0AAA')).toThrow();
    expect(() => base32Decode('!!!!')).toThrow();
  });
});

describe('otpauthUri', () => {
  it('carries the parameters an authenticator needs', () => {
    const uri = otpauthUri({
      secret: SEED_SHA1,
      accountName: 'ada@example.test',
      issuer: 'DEPSIS',
    });
    expect(uri.startsWith('otpauth://totp/DEPSIS:ada%40example.test?')).toBe(true);
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
    // Unpadded: some scanners treat the `=` as part of the secret.
    expect(uri).not.toContain('%3D');
  });

  it('encodes a label that would otherwise break the URI', () => {
    // A display name containing `:` or `&` would silently produce a QR code that enrols under the
    // wrong account label — cosmetic until a user has three of them and cannot tell them apart.
    const uri = otpauthUri({
      secret: SEED_SHA1,
      accountName: 'a:b&c?d',
      issuer: 'Acme Ltd',
    });
    expect(uri).toContain('Acme%20Ltd:a%3Ab%26c%3Fd');
  });

  it('produces a secret an authenticator can decode back', () => {
    const secret = generateSecret();
    const uri = otpauthUri({ secret, accountName: 'x@y.test', issuer: 'DEPSIS' });
    const encoded = new URL(uri).searchParams.get('secret');
    expect(encoded).not.toBeNull();
    expect(base32Decode(encoded as string).equals(secret)).toBe(true);
  });
});
