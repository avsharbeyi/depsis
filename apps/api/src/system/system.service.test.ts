import { describe, expect, it, vi } from 'vitest';

import { AgentUnavailableError, type AgentResponse } from '../agent/agent.service.js';
import type { AgentService } from '../agent/agent.service.js';
import type { DbService } from '../db/db.service.js';
import { SystemService } from './system.service.js';

/**
 * A stub agent, not a socket.
 *
 * The wire itself is measured in agent.service.test.ts against a real stream socket; what is left
 * to settle here is what this service DECIDES with the answers, which a socket adds nothing to.
 */
function stubAgent(answers: Record<string, AgentResponse>): {
  agent: AgentService;
  calls: Array<{ pool: string; reason: string; correlationId: string }>;
} {
  const calls: Array<{ pool: string; reason: string; correlationId: string }> = [];
  const agent = {
    call: (request: { op: string; pool?: string }, reason: string, correlationId: string) => {
      const pool = request.pool ?? '';
      calls.push({ pool, reason, correlationId });
      const answer = answers[pool];
      if (answer === undefined) return Promise.reject(new AgentUnavailableError('no stub answer'));
      return Promise.resolve(answer);
    },
  } as unknown as AgentService;
  return { agent, calls };
}

function stubDb(adminUserId: string | null): DbService {
  return {
    withoutTenant: (_justification: string, fn: (q: unknown) => Promise<unknown>) =>
      fn({
        query: (_sql: string, params: readonly unknown[]) =>
          Promise.resolve([{ n: params[0] === adminUserId ? '1' : '0' }]),
      }),
  } as unknown as DbService;
}

const ONLINE: AgentResponse = {
  status: 'pool_status',
  health: 'ONLINE',
  used_bytes: 1_000,
  available_bytes: 9_000,
};

describe('telemetry', () => {
  it('reports every configured pool, in order, with an audit reason and the callerid', async () => {
    const { agent, calls } = stubAgent({
      tank: ONLINE,
      backup: { status: 'pool_status', health: 'DEGRADED', used_bytes: 5, available_bytes: 6 },
    });
    const system = new SystemService(agent, stubDb(null), ['tank', 'backup']);

    const telemetry = await system.telemetry('corr-1');

    expect(telemetry.pools).toEqual([
      { name: 'tank', health: 'ONLINE', used: 1_000, available: 9_000 },
      { name: 'backup', health: 'DEGRADED', used: 5, available: 6 },
    ]);
    // §16: a privileged call has to be explainable, and traceable back to the request that caused
    // it. Both are asserted rather than assumed, because both are easy to forget at a call site.
    expect(calls.map((c) => c.correlationId)).toEqual(['corr-1', 'corr-1']);
    expect(calls[0]?.reason).toContain('tank');
  });

  it('never repeats a health state it does not recognise', async () => {
    // The agent passes `zpool list -H -o health` through verbatim, so this is the boundary where an
    // unexpected state has to be handled. Mapping it to ONLINE is the shortest path to showing an
    // operator a false green on a pool that is in trouble.
    const { agent } = stubAgent({
      tank: { status: 'pool_status', health: 'WEIRD', used_bytes: 1, available_bytes: 2 },
    });
    const system = new SystemService(agent, stubDb(null), ['tank']);

    expect((await system.telemetry('c')).pools[0]?.health).toBe('UNKNOWN');
  });

  it('accepts the states zpoolprops(7) documents, whatever their case', async () => {
    for (const health of ['ONLINE', 'DEGRADED', 'FAULTED', 'OFFLINE', 'REMOVED', 'UNAVAIL']) {
      const { agent } = stubAgent({
        tank: {
          status: 'pool_status',
          health: health.toLowerCase(),
          used_bytes: 1,
          available_bytes: 2,
        },
      });
      const system = new SystemService(agent, stubDb(null), ['tank']);
      expect((await system.telemetry('c')).pools[0]?.health).toBe(health);
    }
  });

  it('fails rather than dropping a pool the agent refuses', async () => {
    // A configured pool the agent will not report on is a typo in the configuration or a pool that
    // has gone away. Returning the other pools and omitting this one would present a partial list
    // as if it were the whole truth.
    const { agent } = stubAgent({
      tank: ONLINE,
      gone: { status: 'refused', reason: 'no such pool' },
    });
    const system = new SystemService(agent, stubDb(null), ['tank', 'gone']);

    await expect(system.telemetry('c')).rejects.toBeInstanceOf(AgentUnavailableError);
    await expect(system.telemetry('c')).rejects.toThrow(/gone.*no such pool/);
  });

  it('reports no pools when none are configured, without calling the agent', async () => {
    const { agent, calls } = stubAgent({});
    const system = new SystemService(agent, stubDb(null), []);

    expect((await system.telemetry('c')).pools).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('omits what it cannot measure instead of inventing it', async () => {
    const { agent } = stubAgent({});
    const telemetry = await new SystemService(agent, stubDb(null), []).telemetry('c');

    // Nothing in the agent's operation set reports CPU temperature. `read_smart_summary` returns a
    // DISK temperature, which is a different sensor — putting it here would mislabel a real number.
    expect(telemetry.cpu?.temperatureCelsius).toBeUndefined();
    expect(telemetry.memory?.totalBytes).toBeGreaterThan(0);
    // Used must be a real subset of total, not a number that only looks plausible.
    expect(telemetry.memory?.usedBytes).toBeGreaterThan(0);
    expect(telemetry.memory?.usedBytes).toBeLessThanOrEqual(telemetry.memory?.totalBytes ?? 0);
  });
});

describe('who counts as the administrator', () => {
  it('is the user system_setup recorded, and nobody else', async () => {
    const { agent } = stubAgent({});
    const system = new SystemService(agent, stubDb('admin-1'), []);

    expect(await system.isSystemAdministrator('admin-1')).toBe(true);
    expect(await system.isSystemAdministrator('someone-else')).toBe(false);
  });

  it('reads system_setup without a tenant context, and says why', async () => {
    const justifications: string[] = [];
    const db = {
      withoutTenant: (justification: string, fn: (q: unknown) => Promise<unknown>) => {
        justifications.push(justification);
        return fn({ query: () => Promise.resolve([{ n: '0' }]) });
      },
      // If the service ever reached for a tenant context instead, the row would be invisible and a
      // legitimate administrator would be silently denied rather than the call failing.
      withTenant: vi.fn(),
    } as unknown as DbService;

    const { agent } = stubAgent({});
    await new SystemService(agent, db, []).isSystemAdministrator('u');

    expect(justifications).toEqual(['system-admin-check']);
    expect(
      (db as unknown as { withTenant: ReturnType<typeof vi.fn> }).withTenant,
    ).not.toHaveBeenCalled();
  });
});
