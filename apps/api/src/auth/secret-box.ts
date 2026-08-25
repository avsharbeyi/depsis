import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Authenticated encryption for the one secret DEPSIS has to be able to read back.
 *
 * Passwords are hashed with Argon2id and recovery codes with SHA-256, because nothing ever needs
 * the original. A TOTP secret is different: computing the expected code requires the secret itself,
 * so it must be recoverable, and "recoverable" is exactly what makes it worth protecting.
 *
 * What a key on the same host buys, stated plainly so nobody overestimates it. It does NOT protect
 * against an attacker who is root on the box — they can read the key file. What it does protect
 * against is the far more likely case: database access WITHOUT filesystem access. A leaked
 * `depsis_app` password, an SQL injection, a `pg_dump` taken as the owner for disaster recovery, a
 * support bundle, a developer copying a database. Every one of those hands over the whole MFA
 * estate today and none of them touches the key file. Splitting the capability so that database
 * access alone is not enough is the same move the agent makes with SO_PEERCRED, applied here.
 */

/** AES-256-GCM. 12-byte nonce is the size the mode is specified for; 16-byte tag is the full tag. */
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * A fixed salt for `derive`.
 *
 * Fixed rather than random because the derivation has to be REPRODUCIBLE — a random salt
 * would have to be stored, which is the storage this whole approach exists to avoid. HKDF is
 * specified to be safe with a constant salt when the input key is already uniformly random,
 * which a 32-byte key from `openssl rand` is.
 */
const DERIVE_SALT = Buffer.from('depsis/hkdf/v1');

/** Written into the envelope so a stored value always says what it is. */
export const KEY_VERSION_PLAINTEXT = 0;
export const KEY_VERSION_AES_GCM = 1;

export class SecretKeyUnavailableError extends Error {
  constructor(reason: string) {
    super(`the secret key is unavailable: ${reason}`);
    this.name = 'SecretKeyUnavailableError';
  }
}

export class SecretDecryptionError extends Error {
  constructor(reason: string) {
    super(`could not decrypt a stored secret: ${reason}`);
    this.name = 'SecretDecryptionError';
  }
}

/**
 * Read the key from a file, the way systemd's `LoadCredential=` presents it.
 *
 * A FILE rather than an environment variable. An environment variable is readable through
 * /proc/<pid>/environ by anything running as the same user, is inherited by every child process the
 * API spawns, and turns up in crash reporters and process listings. `LoadCredential=` gives a
 * mode-0400 file owned by the service user under $CREDENTIALS_DIRECTORY, which ADR-0006 already
 * relies on for the same reason.
 *
 * Base64 rather than raw bytes: a raw key file is indistinguishable from a truncated or corrupt
 * one, and a stray trailing newline silently changes the key. Base64 that must decode to exactly 32
 * bytes fails loudly instead.
 */
export function readKeyFile(path: string): Buffer {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    throw new SecretKeyUnavailableError(
      `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseKey(contents, path);
}

export function parseKey(contents: string, source = 'the key'): Buffer {
  const trimmed = contents.trim();
  if (trimmed === '') throw new SecretKeyUnavailableError(`${source} is empty`);

  const key = Buffer.from(trimmed, 'base64');
  // Base64 decoding is permissive — it ignores what it cannot parse rather than failing — so the
  // length check is what actually validates the input. Re-encoding and comparing catches a value
  // that decoded to the right length from the wrong characters.
  if (key.length !== KEY_BYTES) {
    throw new SecretKeyUnavailableError(
      `${source} must be base64 for exactly ${KEY_BYTES} bytes, got ${key.length}`,
    );
  }
  if (key.toString('base64').replace(/=+$/, '') !== trimmed.replace(/=+$/, '')) {
    throw new SecretKeyUnavailableError(`${source} is not valid base64`);
  }
  return key;
}

/** For generating one: `openssl rand -base64 32`. Here so tests and docs cannot disagree. */
export function generateKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

/**
 * Seal a secret for one specific row.
 *
 * The associated data binds the ciphertext to the user and organization it belongs to. Without it,
 * anyone who can UPDATE this table — but cannot decrypt — could copy Alice's stored secret onto
 * Bob's row and then sign in as Bob using Alice's phone. The ciphertext would decrypt perfectly,
 * because nothing in it would say whose it was. With it, the tag check fails.
 */
/**
 * Load the key that seals secrets at rest, or say why there is none.
 *
 * A bad key path is a LOGGED failure rather than a thrown one, deliberately. Refusing to boot would
 * lock out every user — including the ones with no second factor, and including the recovery codes
 * that are the way back in when the key is the thing that broke.
 *
 * It lives here rather than in `AuthModule` because there are two callers now: TOTP secrets and
 * the NT hash that gives a user SMB access. Two copies of "read the key, or explain" would be two
 * places to change the day the key moves, and one of them would be missed.
 */
export function loadSecretBox(keyFile: string | null, log: SecretBoxLog): SecretBox | null {
  if (keyFile === null) {
    log.warn(
      'DEPSIS_SECRET_KEY_FILE is not set: secrets cannot be sealed, so enrolling a second factor ' +
        'and storing an SMB credential will both be refused. Generate one with ' +
        '`openssl rand -base64 32` (ADR-0016).',
    );
    return null;
  }
  try {
    const box = new SecretBox(readKeyFile(keyFile));
    log.log(`secrets at rest are sealed with the key at ${keyFile}`);
    return box;
  } catch (error) {
    log.error(
      `${error instanceof Error ? error.message : String(error)}. ` +
        'Enrolment and SMB credentials will be refused and existing sealed values will not open; ' +
        'recovery codes still work.',
    );
    return null;
  }
}

/** Just enough of a logger to be satisfied by Nest's, without importing Nest into this file. */
export interface SecretBoxLog {
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new SecretKeyUnavailableError(`key must be ${KEY_BYTES} bytes, got ${key.length}`);
    }
  }

  /**
   * Derive a value from the appliance key instead of storing one.
   *
   * The problem this solves is narrow and specific. A multi-container application needs its server
   * and its database to agree on a password that no human will ever type. Three ways to get one:
   * ship a constant in the catalogue (then every DEPSIS on earth has the same one), generate a
   * random one and write it to a table (then the database holds a plaintext password, and a
   * `pg_dump` for disaster recovery carries it out of the building), or derive it. Derivation is
   * the only one where a database dump alone reveals nothing — the same split this class already
   * relies on for TOTP secrets.
   *
   * DETERMINISTIC on purpose. A container recreated after an upgrade gets the same password, so
   * the PostgreSQL data directory it inherits from its predecessor still opens. A random password
   * would lock the application out of its own database on the first upgrade.
   *
   * HKDF and not a bare HMAC: the `info` argument is what keeps a derived value from ever
   * colliding with a sealed one, and the prefix below keeps two callers with the same label from
   * colliding with each other.
   */
  derive(label: string, bytes: number): Buffer {
    if (!Number.isInteger(bytes) || bytes < 16 || bytes > 64) {
      throw new SecretKeyUnavailableError(`refusing to derive ${String(bytes)} bytes`);
    }
    return Buffer.from(hkdfSync('sha256', this.key, DERIVE_SALT, `depsis:derive:${label}`, bytes));
  }

  seal(plaintext: Buffer, binding: SecretBinding): Buffer {
    // A fresh random nonce per encryption. GCM fails catastrophically on nonce reuse — two messages
    // under the same key and nonce leak their XOR and, worse, the authentication key.
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(aad(binding));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.from([KEY_VERSION_AES_GCM]), nonce, body, cipher.getAuthTag()]);
  }

  open(envelope: Buffer, binding: SecretBinding): Buffer {
    if (envelope.length < 1 + NONCE_BYTES + TAG_BYTES) {
      throw new SecretDecryptionError('the stored value is too short to be an envelope');
    }
    const version = envelope[0];
    if (version !== KEY_VERSION_AES_GCM) {
      throw new SecretDecryptionError(`unknown envelope version ${String(version)}`);
    }

    const nonce = envelope.subarray(1, 1 + NONCE_BYTES);
    const body = envelope.subarray(1 + NONCE_BYTES, envelope.length - TAG_BYTES);
    const tag = envelope.subarray(envelope.length - TAG_BYTES);

    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
    decipher.setAAD(aad(binding));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      // Deliberately not repeating the underlying message. A tampered ciphertext, a wrong key and a
      // ciphertext moved to another row all fail here, and telling them apart helps only an
      // attacker: the difference is exactly which guess was closer.
      throw new SecretDecryptionError('authentication failed');
    }
  }

  /** Whether two keys are the same, without leaking how far a comparison got. */
  matches(other: Buffer): boolean {
    return other.length === this.key.length && timingSafeEqual(other, this.key);
  }
}

export interface SecretBinding {
  userId: string;
  organizationId: string;
}

function aad(binding: SecretBinding): Buffer {
  // A separator that cannot occur in a UUID, so `aa|bb` and `aab|b` are different associated data.
  // Concatenating identifiers without one is a classic way to make two distinct rows share a
  // binding.
  return Buffer.from(`${binding.userId}|${binding.organizationId}`, 'utf8');
}
