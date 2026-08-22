import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AgentRefusedError,
  AgentUnavailableError,
  type AgentRequest,
  type AgentResponse,
  type AgentService,
} from '../agent/agent.service.js';
import { AdminGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { DbService } from '../db/db.service.js';
import {
  BackupsService,
  InvalidSnapshotNameError,
  SnapshotNameTakenError,
  UnknownDatasetError,
  defaultSnapshotName,
} from './backups.service.js';

/**
 * Backups against a real PostgreSQL, with a fake agent.
 *
 * The split is deliberate. The agent is absent in every test environment and its half of this
 * feature — that `create_snapshot` reaches a ZFS pool — is measured on the Rust side; what cannot
 * be measured with a fake is everything this suite is about: that RLS hides another tenant's
 * shares, that the unique index turns a repeated name into a 409 rather than a second row, and
 * that a refused call leaves NOTHING behind. All three are properties of the database and of the
 * order the two are touched in, and a mocked `DbService` would assert only that the code calls the
 * methods the test author expected it to.
 *
 * Skipped unless `DEPSIS_TEST_DATABASE_URL` and `DEPSIS_TEST_OWNER_DATABASE_URL` point at a
 * migrated database.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];

const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

interface RecordedCall {
  request: AgentRequest;
  reason: string;
  correlationId: string;
}

/**
 * An agent that answers whatever the test tells it to.
 *
 * Not a socket. `agent.service.test.ts` measures the wire against a real stream socket; what is
 * left here is what this service DECIDES with the answers, and a socket adds nothing to that.
 */
function stubAgent(respond: (request: AgentRequest) => Promise<AgentResponse>): {
  agent: AgentService;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const agent = {
    call: (request: AgentRequest, reason: string, correlationId: string) => {
      calls.push({ request, reason, correlationId });
      return respond(request);
    },
  } as unknown as AgentService;
  return { agent, calls };
}

/** The happy answer: the agent took it and reports the name ZFS gave it. */
function takes(): (request: AgentRequest) => Promise<AgentResponse> {
  return (request) => {
    // Narrowed with `in` rather than cast: the operation set is a union, and a cast here would be
    // a place where a renamed field stopped being noticed by the type checker.
    const dataset = 'dataset' in request ? request.dataset : '?';
    const name = 'name' in request ? request.name : '?';
    return Promise.resolve<AgentResponse>({
      status: 'snapshot',
      full_name: `${dataset}@${name}`,
    });
  };
}

describeDb('backups, against a real PostgreSQL', () => {
  let db: DbService;
  let owner: DbService;
  let orgA = '';
  let orgB = '';
  let adminA = '';
  let adminB = '';
  const datasetA = 'tank/depsis/backups-a';
  const datasetB = 'tank/depsis/backups-b';

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name)
         VALUES ('backups-a','Backups A'), ('backups-b','Backups B')
         ON CONFLICT (slug) DO NOTHING`,
      );
      const orgs = await q.query<{ slug: string; id: string }>(
        `SELECT slug, id::text AS id FROM organizations WHERE slug IN ('backups-a','backups-b')`,
      );
      orgA = orgs.find((r) => r.slug === 'backups-a')?.id ?? '';
      orgB = orgs.find((r) => r.slug === 'backups-b')?.id ?? '';

      const seeded = await q.query<{ organization_id: string; id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1, 'yonetici-a', 'admin', 'x'), ($2, 'yonetici-b', 'admin', 'x')
         RETURNING organization_id::text AS organization_id, id::text AS id`,
        [orgA, orgB],
      );
      adminA = seeded.find((r) => r.organization_id === orgA)?.id ?? '';
      adminB = seeded.find((r) => r.organization_id === orgB)?.id ?? '';

      // One share per organisation. These rows are the allowlist the service validates against:
      // `shares.dataset` is what DEPSIS created for the tenant, and nothing else may be
      // snapshotted through this endpoint.
      await q.query(
        `INSERT INTO shares (organization_id, name, dataset)
         VALUES ($1, 'paylasim-a', $3), ($2, 'paylasim-b', $4)`,
        [orgA, orgB, datasetA, datasetB],
      );
    });
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM snapshots WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM shares    WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM users     WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM organizations WHERE id = ANY($1)`, [[orgA, orgB]]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  /** Counted as the OWNER, bypassing RLS: "the row is hidden" and "the row is absent" differ. */
  async function rowsNamed(name: string): Promise<number> {
    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ n: string }>(`SELECT count(*)::text AS n FROM snapshots WHERE name = $1`, [name]),
    );
    return Number(rows[0]?.n ?? '0');
  }

  it('takes a snapshot and records what the agent confirmed', async () => {
    const { agent, calls } = stubAgent(takes());
    const backups = new BackupsService(db, agent);

    const row = await backups.create(orgA, adminA, datasetA, 'alindi-1', 'corr-1');

    expect(row.dataset).toBe(datasetA);
    expect(row.name).toBe('alindi-1');
    // Verbatim from the agent, not reassembled here: the value a later DiffSnapshots must be given
    // is the one the agent confirmed.
    expect(row.full_name).toBe(`${datasetA}@alindi-1`);
    expect(row.created_by_username).toBe('yonetici-a');

    // §16: a privileged call has to be explainable afterwards and traceable to its request.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.op).toBe('create_snapshot');
    expect(calls[0]?.correlationId).toBe('corr-1');
    expect(calls[0]?.reason).toContain(datasetA);
  });

  it("refuses a dataset belonging to another tenant, and says 'no such dataset'", async () => {
    // The authorisation hole this closes: without the allowlist, any administrator could name any
    // dataset on the box — another tenant's, or the pool root — and have the privileged agent
    // operate on it. RLS makes the check structural rather than a filter, because orgB's share row
    // is invisible from orgA's context rather than merely skipped.
    const { agent, calls } = stubAgent(takes());
    const backups = new BackupsService(db, agent);

    await expect(backups.create(orgA, adminA, datasetB, 'sizinki', 'c')).rejects.toBeInstanceOf(
      UnknownDatasetError,
    );

    // And the agent was never asked. A check that runs after the call would still refuse the
    // response, but the privileged operation would already have happened.
    expect(calls).toHaveLength(0);
    expect(await rowsNamed('sizinki')).toBe(0);
  });

  it('refuses a dataset that exists nowhere with the same answer', async () => {
    // Same error as the case above, deliberately. A distinct "no such dataset" versus "not yours"
    // would let a caller map the box's datasets by the shape of the refusal.
    const { agent } = stubAgent(takes());
    const backups = new BackupsService(db, agent);

    await expect(
      backups.create(orgA, adminA, 'tank/does-not-exist', 'hayalet', 'c'),
    ).rejects.toBeInstanceOf(UnknownDatasetError);
  });

  it('writes no row when the agent refuses', async () => {
    // The ordering rule, and the reason it is in the contract: a row written before the call would
    // survive the refusal and list a backup that was never taken. A backup list is consulted
    // exactly when something has already gone wrong, so an entry that does not exist is worse than
    // no entry at all.
    const { agent } = stubAgent(() =>
      Promise.resolve<AgentResponse>({ status: 'refused', reason: 'dataset is busy' }),
    );
    const backups = new BackupsService(db, agent);

    await expect(backups.create(orgA, adminA, datasetA, 'reddedildi', 'c')).rejects.toBeInstanceOf(
      AgentRefusedError,
    );
    expect(await rowsNamed('reddedildi')).toBe(0);
  });

  it('writes no row when the agent fails, and carries its reason', async () => {
    const { agent } = stubAgent(() =>
      Promise.resolve<AgentResponse>({ status: 'failed', reason: 'pool is read-only' }),
    );
    const backups = new BackupsService(db, agent);

    await expect(backups.create(orgA, adminA, datasetA, 'basarisiz', 'c')).rejects.toThrow(
      /read-only/,
    );
    expect(await rowsNamed('basarisiz')).toBe(0);
  });

  it('writes no row when the agent cannot be reached', async () => {
    // Distinct from a refusal: nothing was necessarily done, so the caller should retry rather
    // than change the request. What matters here is the same as above — no record either way.
    const { agent } = stubAgent(() =>
      Promise.reject(new AgentUnavailableError('socket is not there')),
    );
    const backups = new BackupsService(db, agent);

    await expect(backups.create(orgA, adminA, datasetA, 'ulasilamadi', 'c')).rejects.toBeInstanceOf(
      AgentUnavailableError,
    );
    expect(await rowsNamed('ulasilamadi')).toBe(0);
  });

  it('turns a second snapshot of the same name on the same dataset into a conflict', async () => {
    const { agent } = stubAgent(takes());
    const backups = new BackupsService(db, agent);

    await backups.create(orgA, adminA, datasetA, 'ayni-ad', 'c');
    await expect(backups.create(orgA, adminA, datasetA, 'ayni-ad', 'c')).rejects.toBeInstanceOf(
      SnapshotNameTakenError,
    );

    // One row, not two. The unique index is what settles it, so two administrators racing on the
    // same name reach the same outcome as one clicking twice.
    expect(await rowsNamed('ayni-ad')).toBe(1);
  });

  it('lets the same snapshot name exist in another organization', async () => {
    // The unique index is per (organization, dataset, name). A global one would refuse orgB's
    // snapshot because orgA had used the string — which tells orgB something about orgA.
    const { agent } = stubAgent(takes());
    const backups = new BackupsService(db, agent);

    await backups.create(orgA, adminA, datasetA, 'paylasilan-ad', 'c');
    await expect(
      backups.create(orgB, adminB, datasetB, 'paylasilan-ad', 'c'),
    ).resolves.toBeTruthy();
  });

  it("never lists another tenant's snapshots", async () => {
    const { agent } = stubAgent(takes());
    const backups = new BackupsService(db, agent);

    await backups.create(orgB, adminB, datasetB, 'yalniz-b', 'c');

    const mine = await backups.list(orgA);
    expect(mine.map((s) => s.name)).not.toContain('yalniz-b');
    expect(mine.every((s) => s.dataset === datasetA)).toBe(true);

    const theirs = await backups.list(orgB);
    expect(theirs.map((s) => s.name)).toContain('yalniz-b');
  });

  it('lists newest first', async () => {
    const { agent } = stubAgent(takes());
    const backups = new BackupsService(db, agent);

    // Self-contained rather than relying on what earlier tests left behind: a suite whose
    // assertions depend on execution order fails for reasons nobody is looking for.
    await backups.create(orgA, adminA, datasetA, 'sira-1', 'c');
    await backups.create(orgA, adminA, datasetA, 'sira-2', 'c');

    const names = (await backups.list(orgA)).map((s) => s.name);
    expect(names.indexOf('sira-2')).toBeLessThan(names.indexOf('sira-1'));
  });

  it('keeps the snapshot when the account that took it is deleted, with no author', async () => {
    // `snapshots.created_by` is ON DELETE SET NULL and the listing LEFT JOINs, so the row outlives
    // the account. An INNER JOIN would make these rows vanish from the list while the data they
    // name is still on the pool — the one place a backup list must not be optimistic.
    const { agent } = stubAgent(takes());
    const backups = new BackupsService(db, agent);

    const gone = await owner.withoutTenant('migration-status', async (q) => {
      const rows = await q.query<{ id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1, 'silinecek', 'member', 'x')
         RETURNING id::text AS id`,
        [orgA],
      );
      return rows[0]?.id ?? '';
    });

    await backups.create(orgA, gone, datasetA, 'yetim', 'c');
    expect((await backups.list(orgA)).find((s) => s.name === 'yetim')?.created_by_username).toBe(
      'silinecek',
    );

    await owner.withoutTenant('migration-status', (q) =>
      q.query(`DELETE FROM users WHERE id = $1`, [gone]),
    );

    const orphan = (await backups.list(orgA)).find((s) => s.name === 'yetim');
    expect(orphan).toBeDefined();
    expect(orphan?.created_by_username).toBeNull();
  });

  it('records nothing when the name fails the database constraint', async () => {
    // The backstop, not the gate. The controller applies `snapshots_name_format` with zod before
    // anything is called, precisely so this path is unreachable: the agent runs first, so a name
    // only the database refuses would mean a snapshot on the pool that DEPSIS cannot record. What
    // is asserted here is that if the two validators ever drift apart, the outcome is a legible
    // 422 and no row rather than a 500 — and that the real agent, which types the operand as a
    // SafeComponent, would have refused a leading dash by construction anyway.
    const { agent } = stubAgent(takes());
    const backups = new BackupsService(db, agent);

    await expect(backups.create(orgA, adminA, datasetA, '-rf', 'c')).rejects.toBeInstanceOf(
      InvalidSnapshotNameError,
    );
    expect(await rowsNamed('-rf')).toBe(0);
  });
});

/**
 * The guard, which needs no database — an ordinary member calling an administrator endpoint.
 *
 * Outside the `describeDb` block on purpose: this is one of the §20 access-control acceptance
 * assertions, and it should not be silently skipped on a machine with no test database.
 */
describe('who may reach /backups', () => {
  function contextWith(role: string | undefined): ExecutionContext {
    const request = {
      depsis: role === undefined ? undefined : { organizationId: 'o', userId: 'u', role },
    } as unknown as AuthenticatedRequest;
    return {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  it('refuses a member with 403, not 404', () => {
    // 403 rather than 404, unlike the tenant-scoped refusals inside the service: the path is in
    // the published contract, so hiding it conceals nothing and makes a legitimate
    // administrator's misconfiguration harder to diagnose.
    expect(() => new AdminGuard().canActivate(contextWith('member'))).toThrow(ForbiddenException);
  });

  it('admits an administrator', () => {
    expect(new AdminGuard().canActivate(contextWith('admin'))).toBe(true);
  });

  it('fails closed when no session was established', () => {
    // The guard mounted without SessionGuard in front of it would otherwise admit everyone.
    expect(() => new AdminGuard().canActivate(contextWith(undefined))).toThrow(
      UnauthorizedException,
    );
  });
});

describe('the generated snapshot name', () => {
  it('matches the shape both the agent and the database require', () => {
    const name = defaultSnapshotName(new Date(Date.UTC(2026, 7, 22, 9, 4, 5)));
    expect(name).toBe('depsis-20260822-090405');
    expect(name).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,62}$/);
  });

  it('is UTC, so it does not jump backwards at a daylight-saving boundary', () => {
    // These names sort as strings in `zfs list -t snapshot`. A local-time name repeats an hour
    // once a year, and the repeat sorts before the snapshot taken earlier.
    const name = defaultSnapshotName(new Date(Date.UTC(2026, 9, 25, 0, 30, 0)));
    expect(name).toBe('depsis-20261025-003000');
  });
});
