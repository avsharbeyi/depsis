/**
 * The NT hash — MD4 of the password in UTF-16LE — and DEPSIS's own MD4, because Node has none.
 *
 * WHY THIS FILE EXISTS AT ALL. Samba authenticates against its own store and needs an NT hash,
 * which cannot be derived from the Argon2 hash `PasswordService` keeps. That leaves three ways to
 * give a DEPSIS user an SMB password, and they are not equally good:
 *
 *   a) the user sets a SEPARATE SMB password — honest, and a second secret to forget;
 *   b) the plaintext crosses the privilege boundary to `smbpasswd` — one operand, and it is the
 *      user's ACTUAL password, which they may well have reused somewhere that matters more;
 *   c) DEPSIS computes the hash here and only the HASH ever leaves this process.
 *
 * (c) is what this makes possible. `tools/poc/p2-b-smb-password.sh` measured that a precomputed
 * hash installs through `pdbedit` and genuinely authenticates, so the remaining obstacle was
 * arithmetic — and it turned out Node cannot help: OpenSSL 3 moved MD4 into the legacy provider,
 * and `crypto.createHash('md4')` throws. Hence eighty lines of RFC 1320 rather than a plaintext
 * password on a socket.
 *
 * MD4 IS BROKEN AND THAT IS NOT A REASON NOT TO USE IT HERE. It is collision-broken and preimage-
 * weakened, and it is also exactly and only what the NTLM wire format specifies: this is not a
 * choice DEPSIS gets to make, it is the shape of the thing Samba stores. Nothing in this file is
 * a password hash in the sense `PasswordService` is — the Argon2 hash remains the one that
 * protects the account. What this produces is password-EQUIVALENT material for one protocol, and
 * it must be treated as a secret on that basis: never logged, never returned by an endpoint, and
 * handed to the privileged side only for immediate installation.
 */

/** The 64 per-round left-rotation amounts, in the order RFC 1320 §3.4 applies them. */
const SHIFTS: readonly number[] = [
  3, 7, 11, 19, 3, 7, 11, 19, 3, 7, 11, 19, 3, 7, 11, 19, 3, 5, 9, 13, 3, 5, 9, 13, 3, 5, 9, 13, 3,
  5, 9, 13, 3, 9, 11, 15, 3, 9, 11, 15, 3, 9, 11, 15, 3, 9, 11, 15,
];

/** Which 32-bit word of the block each round mixes in. Round 1 is in order; 2 and 3 are not. */
const ORDER: readonly number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3,
  7, 11, 15, 0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15,
];

/** `x <<< n`, on 32 bits. The `>>> 0` is what keeps JavaScript's signed shifts out of the result. */
function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

/**
 * MD4, RFC 1320.
 *
 * Written out rather than pulled from a package: this is a fixed, sixty-line algorithm with
 * published test vectors, and a dependency for it would be a supply-chain surface around something
 * that can be verified completely by a test. `md4.test.ts` checks it against RFC 1320's own
 * vectors AND against a hash `tools/poc/p2-b-smb-password.sh` read back out of Samba, which is the
 * one that proves the result is usable rather than merely self-consistent.
 */
export function md4(message: Uint8Array): Uint8Array {
  // Padding: a 0x80 byte, zeroes, then the length in BITS as a 64-bit little-endian integer.
  const bitLength = BigInt(message.length) * 8n;
  const padded = new Uint8Array((((message.length + 8) >> 6) + 1) << 6);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setBigUint64(padded.length - 8, bitLength, true);

  let [a, b, c, d] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];

  for (let offset = 0; offset < padded.length; offset += 64) {
    const x = new Array<number>(16);
    for (let i = 0; i < 16; i += 1) x[i] = view.getUint32(offset + i * 4, true);

    const [aa, bb, cc, dd] = [a, b, c, d];
    for (let round = 0; round < 48; round += 1) {
      // The three rounds differ only in the mixing function and the additive constant. Written as
      // one loop so the shift and order tables above line up index-for-index with RFC 1320.
      let f: number;
      let k: number;
      if (round < 16) {
        f = (b & c) | (~b & d);
        k = 0;
      } else if (round < 32) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x5a827999;
      } else {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      }
      const word = x[ORDER[round] ?? 0] ?? 0;
      const shift = SHIFTS[round] ?? 0;
      const next = rotl((a + f + word + k) >>> 0, shift);
      // Rotate the registers, which is what makes each round touch a different one.
      a = d;
      d = c;
      c = b;
      b = next;
    }

    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a, true);
  outView.setUint32(4, b, true);
  outView.setUint32(8, c, true);
  outView.setUint32(12, d, true);
  return out;
}

/**
 * The NT hash of a password, uppercase hex — the form Samba's smbpasswd format carries.
 *
 * UTF-16LE, and that encoding is the half people get wrong: a hash computed over UTF-8 installs
 * perfectly and authenticates nobody, which is a failure with no error attached to it. Measured
 * against Samba in `tools/poc/p2-b-smb-password.sh` rather than assumed.
 *
 * NO length or content rules here. A password DEPSIS accepted is a password SMB has to accept, and
 * a second opinion in this function would produce accounts whose web password works and whose SMB
 * password silently does not.
 */
export function ntHash(password: string): string {
  const utf16 = Buffer.from(password, 'utf16le');
  return Buffer.from(md4(utf16)).toString('hex').toUpperCase();
}
