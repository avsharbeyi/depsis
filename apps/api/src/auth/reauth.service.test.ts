import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { DbService } from '../db/db.service.js';
import type { LoginThrottleService } from './login-throttle.service.js';
import type { PasswordService } from './password.service.js';
import { ReauthService } from './reauth.service.js';

/**
 * The check that stands in front of the console and of pool creation.
 *
 * It exists because the two controllers had each written their own, and NEITHER went through the
 * login throttle: a stolen session cookie could be used to guess the password at full speed against
 * the endpoint that opens a shell and the endpoint that erases disks, leaving nothing in
 * `login_attempts`. The tests below are about that half — that a failure is counted and that a
 * throttled caller is refused — because it is the half that was missing and would be easy to
 * refactor back out.
 */

function harness(options: {
  passwordOk?: boolean;
  gate?: boolean;
  user?: { username_folded: string; password_hash: string | null } | undefined;
  missing?: boolean;
}): {
  service: ReauthService;
  record: ReturnType<typeof vi.fn>;
  gate: ReturnType<typeof vi.fn>;
  verify: ReturnType<typeof vi.fn>;
} {
  const record = vi.fn().mockResolvedValue(undefined);
  const gate = vi.fn().mockResolvedValue(options.gate ?? true);
  const verify = vi.fn().mockResolvedValue(options.passwordOk ?? true);

  const rows =
    options.missing === true
      ? []
      : [options.user ?? { username_folded: 'ayse', password_hash: 'argon2-hash' }];

  const db = {
    withTenant: (_org: string, fn: (q: unknown) => Promise<unknown>) =>
      fn({ query: () => Promise.resolve(rows) }),
  } as unknown as DbService;

  return {
    service: new ReauthService(
      db,
      { verify } as unknown as PasswordService,
      { gate, record } as unknown as LoginThrottleService,
    ),
    record,
    gate,
    verify,
  };
}

const request = { ip: '10.0.0.5', socket: {} } as unknown as Request;

describe('re-authentication', () => {
  it('passes when the password is right, and records the attempt', async () => {
    // Recorded even on success, because the throttle counts against a pair and a correct password
    // is evidence about that pair too — `AuthService` records its successes for the same reason.
    const { service, record } = harness({});
    await expect(service.require('o-1', 'u-1', 'right', request)).resolves.toBeUndefined();
    expect(record).toHaveBeenCalledWith('ayse', '10.0.0.5', true);
  });

  it('refuses a wrong password AND counts it', async () => {
    // The counting is the point. Without it an attacker with a stolen cookie guesses forever and
    // an administrator looking at `login_attempts` afterwards sees nothing at all.
    const { service, record } = harness({ passwordOk: false });
    await expect(service.require('o-1', 'u-1', 'wrong', request)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(record).toHaveBeenCalledWith('ayse', '10.0.0.5', false);
  });

  it('refuses without even hashing once the throttle says stop', async () => {
    // Past the threshold the answer is an immediate refusal, and it must not cost an Argon2
    // verification: a caller who can make the server hash on demand has a denial of service.
    const { service, verify, record } = harness({ gate: false });
    await expect(service.require('o-1', 'u-1', 'anything', request)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(verify).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('gives a throttled caller the same answer as a wrong password', async () => {
    // A distinct "you are being throttled" would confirm to an attacker that their guesses are
    // landing on a real account.
    const wrong = harness({ passwordOk: false });
    const throttled = harness({ gate: false });
    const [a, b] = await Promise.all([
      wrong.service.require('o-1', 'u-1', 'x', request).catch((e: Error) => e.message),
      throttled.service.require('o-1', 'u-1', 'x', request).catch((e: Error) => e.message),
    ]);
    expect(a).toBe(b);
  });

  it('keys the throttle on the account name, not on the user id', async () => {
    // `login_attempts` rows written by the login route carry the folded username. Keying this on
    // the uuid would put re-authentication failures in a bucket the login route never reads, so
    // guessing here would not count towards the same limit.
    const { service, gate } = harness({ user: { username_folded: 'veli', password_hash: 'h' } });
    await service.require('o-1', 'u-1', 'right', request);
    expect(gate).toHaveBeenCalledWith('veli', '10.0.0.5');
  });

  it('refuses an account that went away between the guard and here', async () => {
    const { service, verify } = harness({ missing: true });
    await expect(service.require('o-1', 'u-1', 'right', request)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(verify).not.toHaveBeenCalled();
  });

  it('records an attempt against an account with no password', async () => {
    // `password_hash: null` is passed to `verify` rather than short-circuited, so the attempt is
    // still counted. An account with no password would otherwise be a free, silent oracle.
    const { service, verify, record } = harness({
      user: { username_folded: 'ayse', password_hash: null },
      passwordOk: false,
    });
    await expect(service.require('o-1', 'u-1', 'guess', request)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(verify).toHaveBeenCalledWith(null, 'guess');
    expect(record).toHaveBeenCalledWith('ayse', '10.0.0.5', false);
  });

  it('falls back to the socket address when express has no ip', async () => {
    const { service, gate } = harness({});
    await service.require('o-1', 'u-1', 'right', {
      socket: { remoteAddress: '192.168.1.9' },
    } as unknown as Request);
    expect(gate).toHaveBeenCalledWith('ayse', '192.168.1.9');
  });
});
