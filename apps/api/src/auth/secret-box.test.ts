import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  generateKey,
  parseKey,
  SecretBox,
  SecretDecryptionError,
  SecretKeyUnavailableError,
  KEY_VERSION_AES_GCM,
} from './secret-box.js';

const ALICE = { userId: '01a01f92-7cdc-70ba-b6f3-753009cb025f', organizationId: 'org-1' };
const BOB = { userId: '01a01f98-4388-7c2e-9f60-5fe19c79462d', organizationId: 'org-1' };
const SECRET = randomBytes(20);

function box(): SecretBox {
  return new SecretBox(Buffer.from(generateKey(), 'base64'));
}

describe('sealing and opening', () => {
  it('round-trips a secret', () => {
    const b = box();
    expect(b.open(b.seal(SECRET, ALICE), ALICE)).toEqual(SECRET);
  });

  it('never produces the same ciphertext twice', () => {
    // A fresh nonce per encryption. GCM under a reused nonce leaks the XOR of the two plaintexts
    // and the authentication key with it, so this is not a nicety.
    const b = box();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(b.seal(SECRET, ALICE).toString('hex'));
    expect(seen.size).toBe(200);
  });

  it('says what it is in its first byte', () => {
    expect(box().seal(SECRET, ALICE)[0]).toBe(KEY_VERSION_AES_GCM);
  });

  it('refuses a ciphertext moved to another user', () => {
    // The attack this closes: someone who can UPDATE the table but cannot decrypt copies Alice's
    // stored secret onto Bob's row, then signs in as Bob using Alice's phone. Without the binding
    // the ciphertext decrypts perfectly, because nothing in it says whose it was.
    const b = box();
    const sealed = b.seal(SECRET, ALICE);
    expect(() => b.open(sealed, BOB)).toThrow(SecretDecryptionError);
  });

  it('refuses a ciphertext moved to another organization', () => {
    const b = box();
    const sealed = b.seal(SECRET, ALICE);
    expect(() => b.open(sealed, { ...ALICE, organizationId: 'org-2' })).toThrow(
      SecretDecryptionError,
    );
  });

  it('cannot be fooled by shifting the separator between the two identifiers', () => {
    // `aa|bb` and `aab|b` must be different associated data. Concatenating identifiers without a
    // separator is a standard way to make two distinct rows share a binding.
    const b = box();
    const sealed = b.seal(SECRET, { userId: 'aa', organizationId: 'bb' });
    expect(() => b.open(sealed, { userId: 'aab', organizationId: 'b' })).toThrow(
      SecretDecryptionError,
    );
  });

  it('refuses a tampered ciphertext', () => {
    const b = box();
    const sealed = b.seal(SECRET, ALICE);
    for (const index of [0, 5, 20, sealed.length - 1]) {
      const tampered = Buffer.from(sealed);
      tampered[index] = (tampered[index] ?? 0) ^ 0xff;
      expect(() => b.open(tampered, ALICE), `flipping byte ${index} must be caught`).toThrow(
        SecretDecryptionError,
      );
    }
  });

  it('refuses a ciphertext sealed under a different key', () => {
    const sealed = box().seal(SECRET, ALICE);
    expect(() => box().open(sealed, ALICE)).toThrow(SecretDecryptionError);
  });

  it('refuses something too short to be an envelope', () => {
    expect(() => box().open(Buffer.alloc(8), ALICE)).toThrow(/too short/);
  });

  it('tells the same story for every kind of failure', () => {
    // Which guess was closer is information only an attacker wants. A wrong key, a tampered byte
    // and a ciphertext from another row all have to look identical from outside.
    const b = box();
    const sealed = b.seal(SECRET, ALICE);
    const tampered = Buffer.from(sealed);
    tampered[30] = (tampered[30] ?? 0) ^ 0x01;

    const messages = new Set<string>();
    for (const attempt of [
      () => b.open(sealed, BOB),
      () => b.open(tampered, ALICE),
      () => box().open(sealed, ALICE),
    ]) {
      try {
        attempt();
      } catch (error) {
        messages.add((error as Error).message);
      }
    }
    expect(messages.size).toBe(1);
  });
});

describe('the key itself', () => {
  it('accepts a key of exactly the right size', () => {
    expect(parseKey(generateKey())).toHaveLength(32);
  });

  it('tolerates the whitespace a key file collects', () => {
    const key = generateKey();
    // A trailing newline is what `openssl rand -base64 32 > key` writes, and what an editor adds.
    expect(parseKey(`${key}\n`)).toEqual(parseKey(key));
    expect(parseKey(`  ${key}  `)).toEqual(parseKey(key));
  });

  it('refuses a key of the wrong length rather than padding it', () => {
    expect(() => parseKey(randomBytes(16).toString('base64'))).toThrow(SecretKeyUnavailableError);
    expect(() => parseKey(randomBytes(64).toString('base64'))).toThrow(SecretKeyUnavailableError);
  });

  it('refuses input that is not base64 at all', () => {
    // Buffer.from(…, 'base64') ignores characters it cannot parse rather than failing, so a
    // 44-character password would decode to something of plausible length. The round-trip check is
    // what actually rejects it.
    expect(() => parseKey('!'.repeat(44))).toThrow(SecretKeyUnavailableError);
    expect(() => parseKey('correct horse battery staple, a fine passphrase!')).toThrow(
      SecretKeyUnavailableError,
    );
  });

  it('refuses an empty key file', () => {
    expect(() => parseKey('')).toThrow(/empty/);
    expect(() => parseKey('   \n ')).toThrow(/empty/);
  });

  it('generates keys that differ', () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateKey()));
    expect(keys.size).toBe(100);
  });
});
