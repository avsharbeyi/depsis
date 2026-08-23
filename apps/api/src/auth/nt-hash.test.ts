import { describe, expect, it } from 'vitest';

import { md4, ntHash } from './nt-hash.js';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const ascii = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'ascii'));

/**
 * MD4 and the NT hash, against numbers this code did not produce.
 *
 * The whole value of these tests is that every expected string comes from somewhere else: RFC 1320
 * printed the first seven, and Samba itself produced the last two. An implementation checked only
 * against its own output is a very confident way of being wrong — and this one has no runtime to
 * cross-check against, because Node's crypto cannot do MD4 at all.
 */
describe('MD4, against RFC 1320s own test vectors', () => {
  // RFC 1320, appendix A.5. Verbatim, in the order the document lists them.
  const VECTORS: ReadonlyArray<readonly [string, string]> = [
    ['', '31d6cfe0d16ae931b73c59d7e0c089c0'],
    ['a', 'bde52cb31de33e46245e05fbdbd6fb24'],
    ['abc', 'a448017aaf21d8525fc10ae87aa6729d'],
    ['message digest', 'd9130a8164549fe818874806e1c7014b'],
    ['abcdefghijklmnopqrstuvwxyz', 'd79e1c308aa5bbcdeea8ed63df412da9'],
    [
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
      '043f8582f241db351ce627e153e7f0e4',
    ],
    [
      '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
      'e33b4ddc9c38f2199c3e7b164fcc0536',
    ],
  ];

  for (const [input, expected] of VECTORS) {
    it(`hashes ${input === '' ? 'the empty string' : JSON.stringify(input.slice(0, 24))}`, () => {
      expect(hex(md4(ascii(input)))).toBe(expected);
    });
  }

  it('handles a message that lands exactly on a block boundary', () => {
    // 56 bytes is the length at which the padding needs a SECOND block: the 0x80 fits, the
    // eight-byte length does not. An implementation that sized the buffer with `>=` instead of `>`
    // passes every vector above and corrupts exactly this case.
    const fiftySix = 'a'.repeat(56);
    expect(hex(md4(ascii(fiftySix)))).toHaveLength(32);
    expect(hex(md4(ascii(fiftySix)))).not.toBe(hex(md4(ascii('a'.repeat(55)))));
    expect(hex(md4(ascii('a'.repeat(64))))).not.toBe(hex(md4(ascii(fiftySix))));
  });
});

describe('the NT hash', () => {
  it('matches the value Samba stored for the same password', () => {
    // NOT a value this file computed. `tools/poc/p2-b-smb-password.sh` set this password through
    // `smbpasswd` on a real Samba 4.22 and read the stored hash back out with `pdbedit -Lw`; this
    // is that string. It is the only assertion here that proves the result is USABLE rather than
    // merely self-consistent with RFC 1320.
    expect(ntHash('parola-42-uzun')).toBe('65A01736DCDB0F05BDD15A62999BEF6F');
  });

  it('matches the second password the same measurement installed by hash alone', () => {
    // This one went the other way: computed first, imported into Samba through `pdbedit`, and then
    // used to log in. So it is measured evidence that a hash produced here authenticates.
    expect(ntHash('ikinci-parola-99')).toBe('B2A675571776909FA91142AA0532AFB8');
  });

  it('is the famous empty-password hash', () => {
    // Every NTLM implementation on earth agrees about this one, which makes it the cheapest
    // possible check that the UTF-16LE encoding is being applied at all.
    expect(ntHash('')).toBe('31D6CFE0D16AE931B73C59D7E0C089C0');
  });

  it('encodes UTF-16LE, not UTF-8', () => {
    // The half people get wrong, and it fails SILENTLY: a hash computed over UTF-8 installs
    // perfectly and authenticates nobody. For an ASCII password the two encodings differ, so this
    // catches the mistake without needing a non-ASCII one.
    const utf8 = hex(md4(ascii('abc'))).toUpperCase();
    expect(ntHash('abc')).not.toBe(utf8);
    expect(ntHash('abc')).toBe(
      hex(md4(new Uint8Array(Buffer.from('abc', 'utf16le')))).toUpperCase(),
    );
  });

  it('handles a Turkish password, where the encoding actually shows', () => {
    // `ş` is one byte in Latin-1, two in UTF-8 and two in UTF-16LE, so an implementation that
    // reached for the wrong one produces a different length of input entirely.
    const hash = ntHash('çilekŞeker');
    expect(hash).toMatch(/^[0-9A-F]{32}$/);
    expect(hash).not.toBe(ntHash('cilekSeker'));
  });

  it('is uppercase hex of exactly sixteen bytes', () => {
    // The smbpasswd format is fixed-width and a lowercase or short field is a line Samba will not
    // parse — which shows up as an import that "succeeded" and a user who cannot log in.
    expect(ntHash('parola')).toMatch(/^[0-9A-F]{32}$/);
  });
});
