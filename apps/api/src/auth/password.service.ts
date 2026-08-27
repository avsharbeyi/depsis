import { Injectable } from '@nestjs/common';
// The C implementation, compiled on (or prebuilt portably for) the machine it runs on — NOT
// @node-rs/argon2, whose Rust prebuilt targets x86-64-v2 and killed the API with SIGILL on the
// first real consumer box (a 2009 Athlon II). An appliance assumes the owner's oldest PC.
// Both produce and verify PHC-encoded strings, so hashes made by either verify under the other.
import { hash, verify } from 'argon2';

/**
 * OWASP's recommended Argon2id parameters: 19 MiB, two passes, one lane.
 *
 * SPELLED OUT rather than inherited, because the two libraries this class has lived on disagree
 * about defaults: @node-rs/argon2 shipped exactly these, the C `argon2` ships 64 MiB and three
 * passes — heavy enough that two hashes blew a five-second test budget, and heavier than a login
 * on a 2009-era appliance CPU should be. The parameters travel inside each PHC string, so hashes
 * written under either set keep verifying under this one.
 */
const PARAMS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class PasswordService {
  /**
   * A hash of a value nobody can supply, used to spend the same time on a login for an address
   * that does not exist as on one that does.
   *
   * Without it the two paths differ by the whole cost of an Argon2 verification — around 20 ms —
   * which is far more than enough to enumerate accounts over the network. Computed once at startup
   * so the cost is not paid twice on the failing path.
   */
  private readonly decoyPromise = hash('depsis-decoy-never-a-real-password', PARAMS);

  hash(password: string): Promise<string> {
    return hash(password, PARAMS);
  }

  /**
   * Verify, or spend the same effort failing.
   *
   * `stored` is null when the account has no password (or does not exist at all — the caller is
   * expected to pass null rather than skip the call, which is why this takes a nullable). In that
   * case the decoy is verified against and the answer is false.
   */
  async verify(stored: string | null, candidate: string): Promise<boolean> {
    if (stored === null) {
      await verify(await this.decoyPromise, candidate).catch(() => false);
      return false;
    }
    // A malformed stored hash must be a failed login, not a 500 that tells the caller the record
    // exists and is corrupt.
    return verify(stored, candidate).catch(() => false);
  }
}
