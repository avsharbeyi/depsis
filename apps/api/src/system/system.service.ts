import { Injectable, Logger } from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';

import { AgentService, AgentUnavailableError } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import { readLoadAverage, readMemory } from './host-metrics.js';

type Schemas = OpenApi.components['schemas'];
export type Telemetry = Schemas['Telemetry'];
type PoolStatus = Schemas['PoolStatus'];
type PoolHealth = PoolStatus['health'];
type DiskStatus = Schemas['DiskStatus'];

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
    /**
     * Which disks to ask for a SMART summary, by their `/dev/disk/by-id` name.
     *
     * Configuration for the same reason as `poolNames`: `ReadSmartSummary` exists in the agent's
     * closed operation set, "list disks" does not, so there is nothing to enumerate from.
     *
     * Defaulted rather than required, and the default is the honest one — a deployment that names
     * no disks reports no disks, which is what an appliance nobody has configured SMART for should
     * say. It also keeps a caller that only cares about pools from having to pass an empty array to
     * express "the same as before".
     */
    private readonly diskIds: readonly string[] = [],
  ) {}

  /**
   * Is this user the administrator this box was set up by?
   *
   * NOT the only administrator concept any more, and that is the thing to know before using this.
   * `users.role` exists and `AdminGuard` tests it; `POST /users` and the role patch let an
   * administrator promote any number of accounts to `admin`. So `role = 'admin'` is a strict
   * SUPERSET of the single account this predicate matches, and the two gates disagree today:
   * `GET /system/telemetry` uses this one, `POST /backups` uses `AdminGuard`. The weaker gate is
   * in front of the more privileged operation — a promoted administrator cannot read pool and SMART
   * status but can make the privileged agent take a ZFS snapshot. That inversion is almost
   * certainly not intended and wants ONE decision for the whole of `system/`, made deliberately:
   * either telemetry moves to `AdminGuard` and this stays for setup and recovery only, or backups
   * move onto this predicate. It is not the kind of thing to settle as a side effect of an audit
   * fix, so it is written down here instead of changed.
   *
   * Two further consequences of this predicate specifically. A second organisation's users can
   * never match it, because `system_setup` records the FIRST organisation's administrator. And if
   * that account is disabled, nobody matches it at all.
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
      disks: await this.disks(correlationId),
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
   * One SMART summary per configured disk.
   *
   * Deliberately NOT the same failure rule as `pools`, and the difference is worth stating because
   * an inconsistency that is not explained gets "fixed" later by someone who assumes it was an
   * oversight.
   *
   * A pool the agent will not report on has no honest partial answer: the pool either has capacity
   * and a health state or it does not, so dropping it from the list would present an incomplete
   * inventory as a complete one, and reporting it as healthy would be a lie. There is nothing to
   * say, so the whole call fails and the operator gets a 503 that means "ask again".
   *
   * A disk is different: failing the whole telemetry because one disk's smartctl call was refused
   * would take away the pool status too, which is the part that says whether the array is still
   * serving data. So the row is kept.
   *
   * But `healthy: false` for an unreadable summary IS a fabrication, and calling it anything else
   * would be dishonest. "smartctl was refused" and "SMART says this drive is failing" are two
   * different facts and this field reports them as one value; the only trace of the difference is
   * the `logger.warn` below, which no API consumer sees. The practical cost is a stale `by-id` name
   * in `DEPSIS_SMART_DISKS` after a disk swap: a permanent red row on every telemetry poll that no
   * amount of staring at the disk will explain.
   *
   * It stays until the contract can carry the third state, because the alternatives are worse.
   * Omitting the row makes a configured disk vanish with no signal at all, which is the same lie
   * told more quietly. Failing the call takes the pool status with it. What `depsis.yaml` owes:
   * either `healthy: { type: [boolean, 'null'] }` or a `status: healthy|unhealthy|unknown` on
   * `DiskStatus`, plus somewhere to put the reason — and this branch becomes two lines the day it
   * lands.
   *
   * The exception is an agent that cannot be REACHED. That is not a fact about any disk, and
   * painting every row red would be a false alarm on top of a real one, so the transport error is
   * left to propagate into the same 503 the pool query would have produced.
   */
  private async disks(correlationId: string): Promise<DiskStatus[]> {
    const statuses: DiskStatus[] = [];

    for (const id of this.diskIds) {
      // Sequential for the same reason as the pool loop: the agent serialises anyway, so
      // concurrency here would only move the queue from its accept loop into AgentService.
      const response = await this.agent.call(
        { op: 'read_smart_summary', disk_by_id: id },
        `telemetry for disk ${id}`,
        correlationId,
      );

      if (response.status !== 'smart') {
        const detail =
          response.status === 'refused' || response.status === 'failed'
            ? response.reason
            : `expected a smart answer, got '${response.status}'`;
        this.logger.warn(`disk '${id}': SMART summary unavailable: ${detail}`);
        statuses.push({ id, healthy: false });
        continue;
      }

      statuses.push({
        id,
        healthy: response.healthy,
        // Spread rather than `temperatureCelsius: response.temperature_celsius`, because the
        // contract has no null for this field and `exactOptionalPropertyTypes` makes "absent" and
        // "present and undefined" different types. A drive that reports no temperature — several
        // SSDs do not — has the field omitted rather than shown as 0, which a graph would draw.
        ...(response.temperature_celsius === undefined || response.temperature_celsius === null
          ? {}
          : { temperatureCelsius: response.temperature_celsius }),
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
