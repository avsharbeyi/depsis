import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id, with the library's defaults: 19 MiB, two passes, one lane.
 *
 * Those are OWASP's recommended Argon2id parameters, and they are left at the default deliberately
 * rather than raised: ADR-0009 says the parameters are calibrated to the hardware during setup, and
 * a number hard-coded here would be the one that survives that calibration. When the setup wizard
 * exists it will write them to config and this class will read them.
 */
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
  private readonly decoyPromise = hash('depsis-decoy-never-a-real-password');

  hash(password: string): Promise<string> {
    return hash(password);
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
