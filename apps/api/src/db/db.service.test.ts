import { describe, expect, it, vi } from 'vitest';

import { TenantContextError, TenantContextNotEstablishedError } from './db.errors.js';
import { DbService, type TenantQuery } from './db.service.js';

/**
 * These exercise the chokepoint's logic against a fake pool.
 *
 * What that can and cannot settle is worth being explicit about, because this project treats a mock
 * result as evidence of nothing about the real system. A fake proves the ORDER of operations and
 * which branch is taken when the verification disagrees — both of which are pure logic in this
 * file. It proves nothing about whether `set_config(..., true)` really behaves like `SET LOCAL`, or
 * whether the context survives a connection returning to the pool. Those are database behaviour and
 * belong to P1-B, which runs against a real server.
 */

interface QueryResult {
  rows: unknown[];
}

/** The two methods of `PoolClient` that `DbService` actually uses. */
interface FakeClient {
  query: (text: string, params?: readonly unknown[]) => Promise<QueryResult>;
  release: () => void;
}

/** Records every statement the service issues, in order. */
function recording(respond: (text: string) => QueryResult): {
  client: FakeClient;
  calls: string[];
  released: () => number;
} {
  const calls: string[] = [];
  let releases = 0;
  const client: FakeClient = {
    query: (text: string) => {
      calls.push(text.trim().split('\n')[0] ?? text);
      const result = respond(text);
      return Promise.resolve(result);
    },
    release: () => {
      releases += 1;
    },
  };
  return { client, calls, released: () => releases };
}

/**
 * Substitute the pool without opening a socket.
 *
 * The pool is private on purpose — ADR-0015 forbids it escaping this file — so a test in the same
 * module is the narrowest place this substitution can be made. Production code has no such access,
 * and `typecheck` still rejects any non-test file attempting it.
 */
function serviceWith(client: FakeClient): DbService {
  const service = new DbService('postgresql://unused');
  (service as unknown as { pool: unknown }).pool = {
    connect: () => Promise.resolve(client),
    query: () => Promise.resolve({ rows: [] }),
    end: () => Promise.resolve(undefined),
    on: () => undefined,
  };
  return service;
}

const ORG = '01a01abe-ef4c-7839-b820-736ea56db38f';
const OTHER = '00000000-0000-7000-8000-000000000000';

/** A database that reports back whatever `observed` says the tenant context is. */
function respondingWith(observed: string | null): (text: string) => QueryResult {
  return (text) =>
    text.includes('set_config') ? { rows: [{ applied: observed, observed }] } : { rows: [] };
}

describe('withTenant', () => {
  it('sets the context, verifies it, then runs the handler, then commits', async () => {
    const { client, calls, released } = recording(respondingWith(ORG));
    const service = serviceWith(client);

    const seen: string[] = [];
    await service.withTenant(ORG, async (db: TenantQuery) => {
      seen.push('handler');
      await db.query('SELECT 1');
    });

    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toContain('set_config');
    // The handler must not run before the verification. If it did, a transaction with no context
    // would execute the caller's queries and return zero rows — the exact silent outcome ADR-0015
    // exists to convert into an error.
    expect(calls[2]).toBe('SELECT 1');
    expect(calls[3]).toBe('COMMIT');
    expect(seen).toEqual(['handler']);
    expect(released()).toBe(1);
  });

  it('throws, and never runs the handler, when the context reads back as another tenant', async () => {
    const { client, calls, released } = recording(respondingWith(OTHER));
    const service = serviceWith(client);
    const handler = vi.fn();

    await expect(service.withTenant(ORG, handler)).rejects.toBeInstanceOf(
      TenantContextNotEstablishedError,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
    expect(released()).toBe(1);
  });

  it('throws when the context reads back as NULL', async () => {
    // The shape a session-pooling PgBouncer produces, and the one that would otherwise present as
    // an empty result set rather than a failure.
    const { client } = recording(respondingWith(null));
    const service = serviceWith(client);

    await expect(
      service.withTenant(ORG, () => Promise.resolve('unreachable')),
    ).rejects.toBeInstanceOf(TenantContextNotEstablishedError);
  });

  it('names both the expected and the observed tenant in the error', async () => {
    // Whoever reads this at 3am needs to know which of the two is wrong.
    const { client } = recording(respondingWith(OTHER));
    const service = serviceWith(client);

    await expect(service.withTenant(ORG, () => Promise.resolve(1))).rejects.toThrow(
      new RegExp(`${ORG}[\\s\\S]*${OTHER}`),
    );
  });

  it('rejects an organization id that is not a UUID before touching the database', async () => {
    const { client, calls } = recording(respondingWith(ORG));
    const service = serviceWith(client);

    await expect(
      service.withTenant("' OR true --", () => Promise.resolve('unreachable')),
    ).rejects.toBeInstanceOf(TenantContextError);

    expect(calls).toEqual([]);
  });

  it('rolls back and releases when the handler throws', async () => {
    const { client, calls, released } = recording(respondingWith(ORG));
    const service = serviceWith(client);
    const boom = new Error('handler failed');

    await expect(service.withTenant(ORG, () => Promise.reject(boom))).rejects.toBe(boom);

    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
    expect(released()).toBe(1);
  });

  it('surfaces the handler error even when the rollback itself fails', async () => {
    // A broken connection makes ROLLBACK throw too. Rethrowing that would bury the real cause
    // behind a generic connection error, and the original problem would never reach a log.
    const inner = new Error('the real problem');
    let releases = 0;
    const client: FakeClient = {
      query: (text: string) => {
        if (text === 'ROLLBACK') return Promise.reject(new Error('connection terminated'));
        if (text.includes('set_config')) {
          return Promise.resolve({ rows: [{ applied: ORG, observed: ORG }] });
        }
        if (text === 'BEGIN') return Promise.resolve({ rows: [] });
        return Promise.reject(inner);
      },
      release: () => {
        releases += 1;
      },
    };
    const service = serviceWith(client);

    await expect(service.withTenant(ORG, (db) => db.query('SELECT 1'))).rejects.toBe(inner);
    expect(releases).toBe(1);
  });

  it('hands the caller a query function and not the client', async () => {
    const { client } = recording(respondingWith(ORG));
    const service = serviceWith(client);

    await service.withTenant(ORG, (db) => {
      // If this ever gains a `release`, a caller can return the connection to the pool mid
      // transaction and the next borrower inherits an open one.
      expect(Object.keys(db)).toEqual(['query']);
      expect((db as unknown as { release?: unknown }).release).toBeUndefined();
      return Promise.resolve();
    });
  });
});

describe('withoutTenant', () => {
  it('runs in a transaction and never sets a tenant', async () => {
    const { client, calls } = recording(respondingWith(ORG));
    const service = serviceWith(client);

    await service.withoutTenant('health-check', (db) => db.query('SELECT current_user'));

    expect(calls).toEqual(['BEGIN', 'SELECT current_user', 'COMMIT']);
    expect(calls.some((c) => c.includes('set_config'))).toBe(false);
  });

  it('rolls back when the handler throws', async () => {
    const { client, calls, released } = recording(respondingWith(ORG));
    const service = serviceWith(client);

    await expect(
      service.withoutTenant('migration-status', () => Promise.reject(new Error('nope'))),
    ).rejects.toThrow('nope');

    expect(calls).toContain('ROLLBACK');
    expect(released()).toBe(1);
  });
});
