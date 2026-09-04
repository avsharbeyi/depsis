import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { SessionGuard } from './session.guard.js';
import type { ResolvedSession, SessionService } from './session.service.js';

/**
 * What the guard does BESIDES turning a cookie into a tenant context.
 *
 * `last_seen_at` is the device list ADR-0009 asks for, and nothing in the repository ever moved it:
 * `SessionService.touch` had no caller at all, so every row said the session was last seen at the
 * moment it was created. A list built on that would have shown a stale phone as active.
 */

const SESSION: ResolvedSession = {
  sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  organizationId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'member',
  expiresAt: new Date(Date.now() + 60_000),
};

interface Fake {
  guard: SessionGuard;
  touches: string[];
}

function guardWith(session: ResolvedSession | null): Fake {
  const touches: string[] = [];
  const sessions = {
    resolve: () => Promise.resolve(session),
    touch: (_org: string, id: string) => {
      touches.push(id);
      return Promise.resolve();
    },
  } as unknown as SessionService;
  return { guard: new SessionGuard(sessions), touches };
}

function requestFor(cookie: string | undefined): ExecutionContext {
  const request = { headers: cookie === undefined ? {} : { cookie } };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/** The guard's own write is fire-and-forget, so give the microtask queue a turn. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('the session guard', () => {
  it('records that the session was seen', async () => {
    const { guard, touches } = guardWith(SESSION);
    expect(await guard.canActivate(requestFor('depsis_session=abc'))).toBe(true);
    await settle();
    expect(touches).toEqual([SESSION.sessionId]);
  });

  it('does not write on every request', async () => {
    // Bir kimlikli isteğe bir UPDATE eklemek, ürünün her isteğinin yoluna bir yazma koymak demek.
    // Beş dakikada bir "son görülme" için yeterince doğru.
    const { guard, touches } = guardWith(SESSION);
    for (let i = 0; i < 5; i += 1) {
      await guard.canActivate(requestFor('depsis_session=abc'));
    }
    await settle();
    expect(touches).toHaveLength(1);
  });

  it('does not record anything for a request it refuses', async () => {
    const { guard, touches } = guardWith(null);
    await expect(guard.canActivate(requestFor('depsis_session=abc'))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(guard.canActivate(requestFor(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await settle();
    expect(touches).toEqual([]);
  });

  it('does not let a failed write fail the request', async () => {
    // Bir istek "seni gördüm" yazılamadığı için başarısız olmamalı; bir sonraki istek yeniden
    // dener. Yakalanmamış bir reddetme ise süreci düşürürdü.
    const sessions = {
      resolve: () => Promise.resolve(SESSION),
      touch: () => Promise.reject(new Error('the pool is exhausted')),
    } as unknown as SessionService;
    const guard = new SessionGuard(sessions);
    expect(await guard.canActivate(requestFor('depsis_session=abc'))).toBe(true);
    await settle();
  });
});
