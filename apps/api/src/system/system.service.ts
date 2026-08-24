import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { OpenApi } from '@depsis/contracts';

import { AgentService, AgentUnavailableError } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import { readLoadAverage, readMemory } from './host-metrics.js';

type Schemas = OpenApi.components['schemas'];
export type Telemetry = Schemas['Telemetry'];
type PoolStatus = Schemas['PoolStatus'];
type PoolHealth = PoolStatus['health'];
type DiskStatus = Schemas['DiskStatus'];
export type DiskInventory = Schemas['DiskInventory'];
type DiskInventoryEntry = Schemas['DiskInventoryEntry'];
export type ShareRoot = Schemas['ShareRoot'];
export type StorageSetup = Schemas['StorageSetup'];

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
     * A NARROWING NOW, NOT THE ONLY SOURCE — the same change `diskIds` went through, for the same
     * reason and at the same moment. It was configuration because the closed operation set had no
     * "list pools", which was defensible while the pool was made from a shell at install time. It
     * stopped being defensible when the product grew a pool wizard: the operator finished it and
     * the pool they had just built appeared nowhere until they edited `api.env` and restarted the
     * API.
     *
     * Empty means ASK THE BOX. Naming pools still overrides that, because a deployment with a
     * backup pool it does not want on the dashboard has a legitimate reason to narrow — and
     * because an operator who has already written the list should not find it ignored.
     *
     * If a named pool does not exist the agent refuses and the refusal is reported, which is the
     * failure mode to want: visible, not a silently empty list.
     */
    private readonly poolNames: readonly string[],
    /**
     * Which disks to ask for a SMART summary, by their `/dev/disk/by-id` name.
     *
     * AN OVERRIDE NOW, NOT THE ONLY SOURCE. It used to be the only one — the agent's closed
     * operation set had `ReadSmartSummary` and nothing that enumerates, so there was nothing to
     * discover from and the list had to be typed into `api.env` by hand. `ListDisks` closed that,
     * and leaving the hand-typed list as the sole authority would have kept its two failure modes
     * for no reason: a mistyped name graphs the temperature of nothing, and a name left behind
     * after a disk swap shows a permanent red row for a disk that is no longer in the box.
     *
     * So: empty means ASK THE BOX (see `smartTargets`). Naming disks still overrides that, because
     * a deployment with twenty disks and two it cares about has a legitimate reason to narrow, and
     * because an operator who has already written the list should not find it ignored.
     */
    private readonly diskIds: readonly string[] = [],
    /**
     * `DEPSIS_SHARE_PARENT_DATASET`, when a deployment set it.
     *
     * A NARROWING, like the two above it. When it is absent the box is asked which dataset is
     * mounted at the shares root — the question the variable was configuration for. It still wins
     * when it is set, because an operator who wrote a dataset name meant that one; the pairing it
     * records (this dataset must be the one MOUNTED AT the shares root) is exactly what
     * `ShareRootStatus` now checks rather than trusts.
     */
    private readonly shareParentDataset: string | null = null,
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
   * Throws AgentUnavailableError when a CONFIGURED pool cannot be read. The caller turns that into
   * a 503, because an empty `pools` array would make "there are no pools" and "we could not find
   * out" indistinguishable — and those are the two answers an operator most needs to tell apart.
   *
   * Not being able to ENUMERATE pools is a different thing and does not throw; see `poolTargets`.
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

  /**
   * What is physically in the box.
   *
   * Throws `AgentUnavailableError` when the inventory cannot be read, for the same reason `pools`
   * does: an empty list would make "this box has no disks" and "we could not ask" the same answer,
   * and the caller of this one is a wizard that is about to offer disks to overwrite.
   */
  async inventory(correlationId: string): Promise<DiskInventory> {
    const response = await this.agent.call({ op: 'list_disks' }, 'disk inventory', correlationId);

    if (response.status === 'refused' || response.status === 'failed') {
      throw new AgentUnavailableError(`disk inventory: ${response.reason}`);
    }
    if (response.status !== 'disks') {
      throw new AgentUnavailableError(
        `disk inventory: expected a disks answer, got '${response.status}'`,
      );
    }

    return {
      disks: response.disks.map((disk): DiskInventoryEntry => ({
        // `??` rather than spreading a conditional: the contract marks these optional and
        // `exactOptionalPropertyTypes` refuses an explicit `undefined`, so each one is written
        // only when the agent gave a value.
        ...(disk.by_id === null ? {} : { byId: disk.by_id }),
        kname: disk.kname,
        sizeBytes: disk.size_bytes,
        ...(disk.model === null ? {} : { model: disk.model }),
        ...(disk.serial === null ? {} : { serial: disk.serial }),
        ...(disk.wwn === null ? {} : { wwn: disk.wwn }),
        rotational: disk.rotational,
        removable: disk.removable,
        ...(disk.transport === null ? {} : { transport: disk.transport }),
        holds: disk.holds,
        mounted: disk.mounted,
        holdsSystem: disk.holds_system,
      })),
      complete: !response.truncated,
    };
  }

  /**
   * Which disks telemetry should read a SMART summary for.
   *
   * The configured list when there is one; otherwise every non-removable disk the box reports with
   * a stable `/dev/disk/by-id` name.
   *
   * REMOVABLE ONES ARE LEFT OUT of the discovered set. A USB stick is a disk and it is not part of
   * the appliance's storage; a card reader with no card in it is a block device that answers
   * nothing. Neither belongs on a health dashboard that an operator is meant to read as "the array
   * is fine". A deployment that genuinely wants one names it, which is what the override is for.
   *
   * A disk with no `by_id` is left out too, and there is no alternative: `ReadSmartSummary` takes a
   * by-id name by construction, precisely so that `/dev/sdX` cannot reach it (risk R1).
   *
   * Failure here is NOT fatal to telemetry. Discovery is a convenience over a configured list, so
   * an inventory that cannot be read falls back to the configured one — which, in the case this
   * branch exists for, is empty. Telemetry then reports no disks, exactly as it did before this
   * existed, rather than taking the pool status down with it.
   */
  private async smartTargets(
    correlationId: string,
  ): Promise<{ ids: readonly string[]; configured: boolean }> {
    if (this.diskIds.length > 0) return { ids: this.diskIds, configured: true };

    try {
      const { disks } = await this.inventory(correlationId);
      return {
        ids: disks
          .filter((disk) => !disk.removable && disk.byId !== undefined)
          .map((disk) => disk.byId as string),
        configured: false,
      };
    } catch (error) {
      this.logger.warn(
        `could not enumerate disks for SMART: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { ids: [], configured: false };
    }
  }

  /**
   * Does this machine already have a pool by that name?
   *
   * A REFUSAL IS `false`, not an error. `pool_status` on a name ZFS does not know comes back
   * refused, which is exactly the answer this question wants — and treating it as a fault would
   * make "no such pool" indistinguishable from "the agent is down" for a caller whose next step
   * is to create it.
   *
   * A transport failure still throws. That one really is "we could not find out".
   */
  async poolExists(name: string): Promise<boolean> {
    const response = await this.agent.call(
      { op: 'pool_status', pool: name },
      `does the pool '${name}' exist`,
      randomUUID(),
    );
    return response.status === 'pool_status';
  }

  /**
   * Every pool on the box.
   *
   * Throws `AgentUnavailableError` when the list cannot be read, for the same reason `inventory`
   * does: an empty list would make "this box has no pools" and "we could not ask" the same answer,
   * and the first is a screen telling the operator to create one.
   */
  async listPools(correlationId: string): Promise<string[]> {
    const response = await this.agent.call(
      { op: 'list_pools' },
      'which pools exist',
      correlationId,
    );
    if (response.status === 'refused' || response.status === 'failed') {
      throw new AgentUnavailableError(`pool list: ${response.reason}`);
    }
    if (response.status !== 'pools') {
      throw new AgentUnavailableError(
        `pool list: expected a pools answer, got '${response.status}'`,
      );
    }
    return response.pools;
  }

  /**
   * Where shares are served from, and whether the tree is prepared.
   *
   * `dataset` is what `DEPSIS_SHARE_PARENT_DATASET` was configuration for. The variable had to name
   * the dataset MOUNTED AT the shares root, and getting the pairing wrong produces an appliance
   * that creates datasets nothing serves — the row exists, `zfs list` shows it, and the share is
   * empty in the file manager because the agent resolves a directory that was never created.
   * Asking the box removes the chance to get it wrong.
   */
  async shareRoot(correlationId: string): Promise<ShareRoot> {
    const response = await this.agent.call(
      { op: 'share_root_status' },
      'is the share tree prepared',
      correlationId,
    );
    if (response.status === 'refused' || response.status === 'failed') {
      throw new AgentUnavailableError(`share root: ${response.reason}`);
    }
    if (response.status !== 'share_root') {
      throw new AgentUnavailableError(
        `share root: expected a share_root answer, got '${response.status}'`,
      );
    }
    return {
      ...(response.path === null ? {} : { path: response.path }),
      ...(response.dataset === null ? {} : { dataset: response.dataset }),
      empty: response.empty,
    };
  }

  /**
   * Is this box's storage set up, and with what?
   *
   * One call rather than three, because the wizard needs all of it to decide what to offer and a
   * screen assembled from three round trips can show a state the box was never in.
   *
   * The pool list is allowed to fail INTO AN EMPTY LIST here, unlike in `telemetry`. The two
   * callers want opposite things from the same failure: telemetry must not report "no pools" about
   * a machine it could not ask, while this endpoint's caller is deciding whether to offer a wizard
   * — and refusing the whole answer because one of three questions could not be reached would hide
   * the share-root half, which is the part that says whether shares can be created at all.
   */
  async storageSetup(correlationId: string): Promise<StorageSetup> {
    const shareRoot = await this.shareRoot(correlationId);
    const pools =
      this.poolNames.length > 0
        ? [...this.poolNames]
        : await this.listPools(correlationId).catch(() => []);
    const parent = this.shareParentDataset ?? shareRoot.dataset ?? null;

    return {
      pools,
      shareRoot,
      ...(parent === null ? {} : { parentDataset: parent }),
    };
  }

  /**
   * The dataset new shares are created under.
   *
   * The configured value when there is one, otherwise whatever is mounted at the shares root. The
   * fallback is null, and `FilesService` turns that into the 503 it always did — a box with no
   * pool yet is a box that cannot make a share, and saying so is better than inventing a dataset
   * name against a pool that may not exist.
   */
  async parentDataset(correlationId: string): Promise<string | null> {
    if (this.shareParentDataset !== null) return this.shareParentDataset;
    try {
      return (await this.shareRoot(correlationId)).dataset ?? null;
    } catch {
      // Discovery is a convenience over a configured value. An agent that cannot be reached leaves
      // the answer unknown, and the caller's own 503 says so better than a guess would.
      return null;
    }
  }

  private async pools(correlationId: string): Promise<PoolStatus[]> {
    const statuses: PoolStatus[] = [];

    for (const name of await this.poolTargets(correlationId)) {
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
   * Which pools telemetry should report on.
   *
   * The configured list when there is one; otherwise every pool the box has.
   *
   * DISCOVERY FAILING IS NOT FATAL, and the distinction from the `pools` loop below is worth
   * stating because the two look contradictory. A CONFIGURED pool the agent refuses is a real
   * fault — a typo, or a pool that has gone away — and dropping it would present a partial list as
   * complete, so that one fails the whole call. Not being able to ENUMERATE is different: it is
   * the ordinary state of a box with no ZFS installed yet, and a `zpool` that is not there would
   * otherwise take the CPU and memory cards down with it on a dashboard that was working
   * perfectly well before this feature existed.
   *
   * What does not collapse as a result: `GET /system/storage` still distinguishes the two, because
   * its caller is a wizard deciding whether to offer to create a pool.
   */
  private async poolTargets(correlationId: string): Promise<readonly string[]> {
    if (this.poolNames.length > 0) return this.poolNames;
    try {
      return await this.listPools(correlationId);
    } catch (error) {
      this.logger.warn(
        `could not enumerate pools: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
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

    const { ids, configured } = await this.smartTargets(correlationId);
    for (const id of ids) {
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
        // A CONFIGURED disk keeps its row. An operator who named it asked to be told about it, and
        // its silence is a fact — the long note above is about exactly that trade, and it stands.
        //
        // A DISCOVERED disk does not. Nobody asked about it: it is here because the box has it,
        // and the overwhelmingly common reason its summary cannot be read is that `smartctl` is
        // not installed. Painting every disk in the machine red for that would be a wall of false
        // alarms produced by a convenience — and it would teach an operator that the health column
        // means nothing, which is worse than an empty column.
        if (configured) statuses.push({ id, healthy: false });
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
