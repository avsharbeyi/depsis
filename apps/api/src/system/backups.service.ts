import { Injectable, Logger } from '@nestjs/common';

import { AgentService, expectStatus } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';

/** One row of `public.snapshots`, plus the name of whoever asked for it. */
export interface SnapshotRow {
  id: string;
  dataset: string;
  name: string;
  full_name: string;
  /** NULL when the account has been deleted since — `snapshots.created_by` is ON DELETE SET NULL. */
  created_by_username: string | null;
  created_at: Date;
}

/**
 * The dataset is not one this tenant has a share on.
 *
 * A 404 rather than a 403 at the controller, and the reason is the one §20 keeps repeating: a 403
 * would confirm that the dataset exists on the box, which is exactly what a caller probing for
 * another tenant's dataset names is trying to learn.
 */
export class UnknownDatasetError extends Error {
  constructor() {
    super('no such dataset');
    this.name = 'UnknownDatasetError';
  }
}

/** This dataset already has a snapshot by that name in DEPSIS's own record. */
export class SnapshotNameTakenError extends Error {
  constructor() {
    super('a snapshot with that name already exists on this dataset');
    this.name = 'SnapshotNameTakenError';
  }
}

/**
 * The database refused the name's shape.
 *
 * Unreachable through the controller, which applies the same pattern with zod before anything is
 * called — and that is the reason it is a distinct error rather than folded into the conflict
 * above. If it is ever raised, the two validators have drifted apart, and a 422 saying so is what
 * makes that visible instead of a 409 that reads as an ordinary duplicate.
 */
export class InvalidSnapshotNameError extends Error {
  constructor() {
    super('that snapshot name is not one this appliance can record');
    this.name = 'InvalidSnapshotNameError';
  }
}

/**
 * A snapshot name derived from the clock, for a caller that did not choose one.
 *
 * UTC, not local time. The appliance's timezone is a setting somebody can change, and a name that
 * sorts correctly today and jumps an hour backwards at the end of October is worse than one that
 * never matches the wall clock in the first place — `zfs list -t snapshot` sorts these as strings.
 *
 * Second resolution means two snapshots of one dataset inside the same second collide. That is a
 * 409 rather than a silent second name, because the interesting case is a double-submitted form,
 * and answering it with two snapshots a second apart is not what anybody meant.
 *
 * Exported so the format is testable without going through HTTP, and so the pattern this has to
 * satisfy — `snapshots_name_format`, which mirrors the agent's `SafeComponent` — has one owner.
 */
export function defaultSnapshotName(now: Date = new Date()): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const stamp =
    `${pad(now.getUTCFullYear(), 4)}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `depsis-${stamp}`;
}

/**
 * ZFS snapshots DEPSIS took, and the taking of new ones.
 *
 * The listing is DEPSIS's own record and not the pool's inventory, because the agent's operation
 * set is closed (ADR-0006) and has `CreateSnapshot` and `DiffSnapshots` but nothing that lists.
 * `SnapshotPage.complete` is the contract's way of making the client say so; see the controller.
 */
@Injectable()
export class BackupsService {
  private readonly logger = new Logger(BackupsService.name);

  constructor(
    private readonly db: DbService,
    private readonly agent: AgentService,
  ) {}

  /** Newest first — a backup list is read from the top. */
  async list(organizationId: string): Promise<SnapshotRow[]> {
    return this.db.withTenant(organizationId, (db) =>
      db.query<SnapshotRow>(
        `SELECT s.id::text AS id,
                s.dataset,
                s.name,
                s.full_name,
                s.created_at,
                u.username AS created_by_username
           FROM public.snapshots s
           -- LEFT, because created_by is ON DELETE SET NULL: the snapshot outlives the account
           -- that asked for it, and an INNER JOIN would make those rows disappear from the list
           -- while the data they name is still on the pool.
           LEFT JOIN public.users u ON u.id = s.created_by
          WHERE s.organization_id = $1
          ORDER BY s.created_at DESC, s.id DESC`,
        [organizationId],
      ),
    );
  }

  /**
   * Take a snapshot, then record it.
   *
   * That order is the whole point of the method, and the contract states it too. Writing the row
   * first and calling the agent afterwards would leave a row describing a backup that was never
   * taken every time the agent refuses — and a backup list whose entries might not exist is worse
   * than no list, because it is consulted precisely when something has already gone wrong.
   *
   * The reverse failure is real but survivable: the agent takes the snapshot and the INSERT fails,
   * leaving a snapshot on the pool that DEPSIS does not know about. That is the same state as a
   * snapshot taken from a shell, which the schema already says this table cannot see, and it costs
   * a listing entry rather than a restore.
   *
   * Throws `UnknownDatasetError`, `AgentRefusedError`, `AgentUnavailableError` or
   * `SnapshotNameTakenError`; the controller maps each to its status.
   */
  async create(
    organizationId: string,
    userId: string,
    dataset: string,
    name: string,
    correlationId: string,
  ): Promise<SnapshotRow> {
    // Which datasets may be snapshotted is NOT the caller's choice. Without this the endpoint is a
    // way to run a privileged operation against any dataset name a user can type — including
    // another tenant's, and including the pool root — with an administrator's session as the only
    // thing between them and it. The tenant's own shares are the authority: they are the datasets
    // DEPSIS created for this organisation, and the query runs under RLS so another tenant's share
    // is not merely filtered out, it is invisible.
    await this.requireOwnDataset(organizationId, dataset);

    const response = await this.agent.call(
      { op: 'create_snapshot', dataset, name },
      `backup of ${dataset} requested through POST /backups`,
      correlationId,
    );
    // `expectStatus` rather than a hand-written check, because `refused` and `failed` are ORDINARY
    // answers on this wire: a call site that only tests for its own variant reads a refusal as a
    // missing field and reports success.
    const taken = expectStatus(response, 'snapshot');

    // `full_name` verbatim from the agent rather than reassembled as `${dataset}@${name}`. The
    // value a later `DiffSnapshots` has to be given is the one the agent confirmed, and the two
    // strings agreeing today is not a guarantee that they always will.
    return this.record(organizationId, userId, dataset, name, taken.full_name);
  }

  private async requireOwnDataset(organizationId: string, dataset: string): Promise<void> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ one: number }>(
        `SELECT 1 AS one FROM public.shares
          WHERE organization_id = $1 AND dataset = $2
          LIMIT 1`,
        [organizationId, dataset],
      ),
    );
    if (rows.length === 0) throw new UnknownDatasetError();
  }

  private async record(
    organizationId: string,
    userId: string,
    dataset: string,
    name: string,
    fullName: string,
  ): Promise<SnapshotRow> {
    try {
      const rows = await this.db.withTenant(organizationId, (db) =>
        db.query<SnapshotRow>(
          `INSERT INTO public.snapshots (organization_id, created_by, dataset, name, full_name)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id::text AS id, dataset, name, full_name, created_at,
                     (SELECT username FROM public.users WHERE id = $2) AS created_by_username`,
          [organizationId, userId, dataset, name, fullName],
        ),
      );
      const row = rows[0];
      if (!row) throw new Error('the snapshot row was not returned');
      return row;
    } catch (error) {
      throw translateDbError(error, dataset, name, fullName, this.logger);
    }
  }
}

/**
 * SQLSTATE, never the message text.
 *
 * The message carries the constraint name and is localised by the server's `lc_messages`, so a box
 * installed in Turkish would stop producing 409s and start producing 500s with nothing in this
 * repository noticing.
 */
function translateDbError(
  error: unknown,
  dataset: string,
  name: string,
  fullName: string,
  logger: Logger,
): Error {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: string }).code;
    if (code === '23505') return new SnapshotNameTakenError();
    if (code === '23514') {
      // `snapshots_name_format` mirrors the agent's `SafeComponent`, so reaching it means the two
      // validators disagree — the agent accepted a name this table refuses. Worth a log line
      // rather than a bare 409: the snapshot EXISTS on the pool at this point and DEPSIS is about
      // to forget it.
      logger.error(
        `the agent took '${fullName}' but the database refused to record it: ` +
          `name '${name}' on dataset '${dataset}' fails snapshots_name_format. ` +
          'The snapshot is on the pool and will not appear in GET /backups.',
      );
      return new InvalidSnapshotNameError();
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}
