import { Injectable, Logger } from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';

import { AgentService, AgentUnavailableError } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import { readLoadAverage, readMemory } from './host-metrics.js';

type Schemas = OpenApi.components['schemas'];
export type Telemetry = Schemas['Telemetry'];
type PoolStatus = Schemas['PoolStatus'];
type PoolHealth = PoolStatus['health'];

/**
 * The health strings the API is willing to repeat.
 *
 * Derived from the contract's own enum rather than written out again, so widening the spec cannot
 * leave this list behind. Anything the agent reports that is not in here becomes UNKNOWN.
 */
const KNOWN_HEALTH: readonly string[] = [
  'ONLINE',
  'DEGRADED',
  'FAULTED',
  'OFFLINE',
  'REMOVED',
  'UNAVAIL',
  'SUSPENDED',
] satisfies readonly PoolHealth[];

@Injectable()
export class SystemService {
  private readonly logger = new Logger(SystemService.name);

  constructor(
    private readonly agent: AgentService,
    private readonly db: DbService,
    /**
     * Which pools to report on.
     *
     * Configuration, not discovery, because the agent's operation set is closed and has no "list
     * pools" — adding one is a change to the Rust-side contract (ADR-0006), not something the API
     * gets to decide. It is also not wrong for a deployment to state its own pools: which disks
     * form which pool is a deployment fact, and ADR-0007 already keeps pool CREATION out of any
     * generic interface for the same reason.
     *
     * If the name is wrong the agent refuses and the refusal is reported, which is the failure mode
     * to want: visible, not a silently empty list.
     */
    private readonly poolNames: readonly string[],
  ) {}

  /**
   * Is this user the administrator this box was set up by?
   *
   * The only administrator concept that exists. There is no role column on `users`; the setup
   * wizard records one `admin_user_id` in `system_setup` and that is the whole model.
   *
   * Two consequences worth stating rather than discovering later. A second organisation's users can
   * never see telemetry, because `system_setup` records the FIRST organisation's administrator. And
   * if that account is disabled, nobody can. Both are limitations of having no role model, not
   * decisions taken here — a proper one belongs in an ADR, and this endpoint should be revisited
   * with it.
   *
   * `withoutTenant` because `system_setup` has no `organization_id` and no RLS: it is the row that
   * brings the first tenant into existence, so it necessarily predates tenancy (ADR-0015 §5d).
   */
  async isSystemAdministrator(userId: string): Promise<boolean> {
    const rows = await this.db.withoutTenant('system-admin-check', (q) =>
      q.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM system_setup WHERE admin_user_id = $1`,
        [userId],
      ),
    );
    return rows[0]?.n === '1';
  }

  /**
   * Hardware and storage status.
   *
   * Throws AgentUnavailableError when the pools cannot be read. The caller turns that into a 503,
   * because an empty `pools` array would make "there are no pools" and "we could not find out"
   * indistinguishable — and those are the two answers an operator most needs to tell apart.
   */
  async telemetry(correlationId: string): Promise<Telemetry> {
    const memory = readMemory();
    const loadAverage = readLoadAverage();

    return {
      pools: await this.pools(correlationId),
      // temperatureCelsius is absent on purpose: nothing in the agent's operation set reports CPU
      // temperature. `read_smart_summary` returns a DISK temperature, which is a different sensor,
      // and putting it here would be mislabelling a real number rather than omitting an unknown one.
      cpu: loadAverage === undefined ? {} : { loadAverage },
      memory,
    };
  }

  private async pools(correlationId: string): Promise<PoolStatus[]> {
    const statuses: PoolStatus[] = [];

    for (const name of this.poolNames) {
      // Sequential, not Promise.all. The agent serialises anyway, so concurrency would only queue
      // inside AgentService — and a failure here should stop rather than leave a partial list that
      // reads as complete.
      const response = await this.agent.call(
        { op: 'pool_status', pool: name },
        `telemetry for pool ${name}`,
        correlationId,
      );

      if (response.status === 'refused' || response.status === 'failed') {
        // A configured pool the agent will not report on is a real fault — a typo in the
        // configuration, or a pool that no longer exists. Reporting the rest and dropping this one
        // would hide it.
        throw new AgentUnavailableError(`pool '${name}': ${response.reason}`);
      }
      if (response.status !== 'pool_status') {
        throw new AgentUnavailableError(
          `pool '${name}': expected a pool_status answer, got '${response.status}'`,
        );
      }

      statuses.push({
        name,
        health: this.narrowHealth(name, response.health),
        used: response.used_bytes,
        available: response.available_bytes,
        // usedBySnapshots and scrubState are optional in the contract and are omitted rather than
        // guessed: `zpool list -o health` does not carry either, and the agent has no operation
        // that does.
      });
    }

    return statuses;
  }

  /**
   * Repeat the agent's health string only if it is one we know.
   *
   * The agent passes `zpool list -H -o health` through verbatim, so this is the boundary where an
   * unrecognised state has to be handled. Mapping it to ONLINE would be the shortest path to
   * showing an operator a false green; UNKNOWN plus a log line keeps the fact that something was
   * said and not understood.
   */
  private narrowHealth(pool: string, reported: string): PoolHealth {
    const upper = reported.trim().toUpperCase();
    if (KNOWN_HEALTH.includes(upper)) return upper as PoolHealth;
    this.logger.warn(`pool '${pool}' reported an unrecognised health state: '${reported}'`);
    return 'UNKNOWN';
  }
}
