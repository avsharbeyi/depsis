import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentRefusedError,
  AgentUnavailableError,
  type AgentRequest,
  type AgentResponse,
  type AgentService,
} from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import type { OrganizationsService } from '../organizations/organizations.service.js';
import {
  ShareListNotDeviceWideError,
  ShareNameTakenError,
  ShareStorageUnconfiguredError,
  ShareWithoutGrantsError,
  SharesService,
  SmbPublishFailedError,
  SmbUnavailableError,
  UnknownGrantPrincipalError,
  UnpublishableShareError,
  describeRefusal,
  uncPath,
} from './shares.service.js';

/**
 * Shares against a real PostgreSQL, with a fake agent.
 *
 * The split is the one `backups.integration.test.ts` draws and for the same reason: whether
 * `publish_samba_config` actually reaches smbd is measured on the Rust side, against a real
 * `smb.conf` and a real `testparm`. What cannot be measured with a fake is everything this suite
 * is about — that RLS hides another tenant's shares from the list, that a publish REFUSES rather
 * than quietly dropping another tenant's shares off the box, and that `published` never claims
 * more than the agent confirmed.
 *
 * Skipped unless `DEPSIS_TEST_DATABASE_URL` and `DEPSIS_TEST_OWNER_DATABASE_URL` point at a
 * migrated database.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];

const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

const SMB_HOST = 'depsis-test';
// The pool half of a share's identity. Only `create` reads it; every other test here works on
// rows that were inserted directly, exactly as they were before this route existed.
const PARENT_DATASET = 'tank/depsis';

interface RecordedCall {
  request: AgentRequest;
  reason: string;
  correlationId: string;
}

/**
 * An agent that answers whatever the test tells it to.
 *
 * Not a socket: `agent.service.test.ts` measures the wire, and what is left here is what this
 * service DECIDES with the answers. `isAvailable` is part of the fake because `GET /shares`
 * consults it — a listing has to distinguish "Samba is not installed" from "we cannot ask".
 */
function stubAgent(
  respond: (request: AgentRequest) => Promise<AgentResponse>,
  available = true,
): { agent: AgentService; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const agent = {
    isAvailable: () => available,
    call: (request: AgentRequest, reason: string, correlationId: string) => {
      calls.push({ request, reason, correlationId });
      return respond(request);
    },
  } as unknown as AgentService;
  return { agent, calls };
}

/**
 * The device-wide question, stubbed.
 *
 * `resolve_sole_organization()` counts every organisation in the database, and a shared test
 * database has several from other suites — so the real function answers `null` here whatever this
 * suite seeds, and both branches of `publish` would be unreachable through it. Stubbing the answer
 * is what makes the refusal and the happy path both testable; the function itself is exercised by
 * `organizations`' own tests.
 */
function stubSoleOrganization(id: string | null): OrganizationsService {
  return {
    resolveSoleId: () => Promise.resolve(id),
  } as unknown as OrganizationsService;
}

/** The happy answer: everything asked for is being served, proved by a live connection. */
function publishes(): (request: AgentRequest) => Promise<AgentResponse> {
  return (request) =>
    Promise.resolve<AgentResponse>({
      status: 'published',
      shares: 'shares' in request ? request.shares.length : 0,
      verified: true,
    });
}

describe('the UNC path', () => {
  it('is the address a person types into Explorer', () => {
    expect(uncPath('depsis', 'belgeler')).toBe('\\\\depsis\\belgeler');
  });

  it('uses the configured server name rather than anything derived', () => {
    // The whole point of the setting: a box reachable only as `nas.ev` must not advertise
    // `\\depsis\...`, which resolves to nothing and looks like a DEPSIS fault.
    expect(uncPath('nas.ev', 'yedek')).toBe('\\\\nas.ev\\yedek');
  });
});

describe('a refusal, as a sentence', () => {
  it('names the missing include line, because that is the one the reader can fix', () => {
    const sentence = describeRefusal(
      'samba rejected the new configuration and it was rolled back: smbd does not offer belgeler; ' +
        'check that smb.conf contains `include = /etc/samba/depsis.conf`',
    );
    expect(sentence).toContain('include = /etc/samba/depsis.conf');
    // And the reassurance that matters more than the cause: nothing went down.
    expect(sentence).toMatch(/previous configuration/i);
  });

  it('never repeats the agent’s own prose', () => {
    const raw = 'samba rejected the new configuration and it was rolled back: something odd';
    expect(describeRefusal(raw)).not.toContain('something odd');
    expect(describeRefusal(raw)).toMatch(/previous/i);
  });
});

describeDb('shares, against a real PostgreSQL', () => {
  let db: DbService;
  let owner: DbService;
  let orgA = '';
  let orgB = '';

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name)
         VALUES ('shares-a','Shares A'), ('shares-b','Shares B')
         ON CONFLICT (slug) DO NOTHING`,
      );
      const orgs = await q.query<{ slug: string; id: string }>(
        `SELECT slug, id::text AS id FROM organizations WHERE slug IN ('shares-a','shares-b')`,
      );
      orgA = orgs.find((r) => r.slug === 'shares-a')?.id ?? '';
      orgB = orgs.find((r) => r.slug === 'shares-b')?.id ?? '';
    });
  });

  beforeEach(async () => {
    // Each test starts from the same two shares for A and one for B. Rebuilt rather than shared,
    // because half of these tests create or rename rows and a suite whose order matters is a suite
    // that fails for the wrong reason.
    await owner.withoutTenant('migration-status', async (q) => {
      // Before the shares: `folder_grants.share_id` is ON DELETE RESTRICT, so a share with a
      // grant on it cannot be deleted. Both creation paths write one now.
      await q.query(`DELETE FROM folder_grants WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
      await q.query(`DELETE FROM shares WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
      await q.query(
        `INSERT INTO shares (organization_id, name, dataset, read_only)
         VALUES ($1, 'belgeler', 'tank/depsis/a-belgeler', false),
                ($1, 'arsiv',    'tank/depsis/a-arsiv',    true),
                ($2, 'gizli',    'tank/depsis/b-gizli',    false)`,
        [orgA, orgB],
      );
    });
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        // Before the shares: `folder_grants.share_id` is ON DELETE RESTRICT, so a share with a
        // grant on it cannot be deleted. Both creation paths write one now.
        await q.query(`DELETE FROM folder_grants WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM shares WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        // And the teams before the organisation, for the same reason: `teams.organization_id`
        // is ON DELETE RESTRICT, and `everyone_team()` creates one the first time a share is
        // opened implicitly.
        await q.query(`DELETE FROM team_members WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM teams WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM organizations WHERE id = ANY($1)`, [[orgA, orgB]]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  function service(
    respond: (request: AgentRequest) => Promise<AgentResponse> = publishes(),
    options: { available?: boolean; soleOrganization?: string | null } = {},
  ): { shares: SharesService; calls: RecordedCall[] } {
    const { agent, calls } = stubAgent(respond, options.available ?? true);
    const sole = options.soleOrganization === undefined ? orgA : options.soleOrganization;
    return {
      shares: new SharesService(
        db,
        agent,
        stubSoleOrganization(sole),
        SMB_HOST,
        PARENT_DATASET,
        new JobsService(db),
      ),
      calls,
    };
  }

  it('lists only this tenant’s shares, with the address a client would use', async () => {
    const { shares } = service();

    const listing = await shares.list(orgA);

    expect(listing.items.map((s) => s.name)).toEqual(['arsiv', 'belgeler']);
    expect(listing.items.map((s) => s.unc_path)).toEqual([
      `\\\\${SMB_HOST}\\arsiv`,
      `\\\\${SMB_HOST}\\belgeler`,
    ]);
    // RLS, not a WHERE clause: orgB's share is invisible from orgA's context rather than filtered
    // out by something a future edit could forget.
    expect(listing.items.some((s) => s.name === 'gizli')).toBe(false);
    expect(listing.items.find((s) => s.name === 'arsiv')?.read_only).toBe(true);
  });

  it('reports a share that exists in the database as NOT published', async () => {
    // The single most important assertion in this file. A row is not a share smbd is serving, and
    // reporting one as the other sends a user to type an address that does not answer.
    const { shares } = service();

    const listing = await shares.list(orgA);

    expect(listing.items.every((s) => !s.published)).toBe(true);
    // Samba is not claimed absent, though: nobody has asked yet, and `smbAvailable: false` is a
    // positive claim that the package is missing.
    expect(listing.smbAvailable).toBe(true);
  });

  it('reports published only for the shares a successful publish covered', async () => {
    const { shares, calls } = service();

    const result = await shares.publish(orgA, 'corr-1');
    expect(result).toEqual({ shares: 2, verified: true });

    const after = await shares.list(orgA);
    expect(after.items.every((s) => s.published)).toBe(true);

    // A share created after the publish is not being served, and says so — the configuration on
    // disk predates it.
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO shares (organization_id, name, dataset) VALUES ($1, 'yeni', 'tank/depsis/a-yeni')`,
        [orgA],
      ),
    );
    const later = await shares.list(orgA);
    expect(later.items.find((s) => s.name === 'yeni')?.published).toBe(false);
    expect(later.items.find((s) => s.name === 'belgeler')?.published).toBe(true);

    // §16: the privileged call is explainable and traceable to the request that caused it.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.op).toBe('publish_samba_config');
    expect(calls[0]?.correlationId).toBe('corr-1');
  });

  it('sends the agent the dataset and the read-only flag each share actually has', async () => {
    const { shares, calls } = service();

    await shares.publish(orgA, 'corr-2');

    const request = calls[0]?.request;
    const specs = request !== undefined && 'shares' in request ? request.shares : [];
    expect(specs).toEqual([
      { name: 'arsiv', dataset: 'tank/depsis/a-arsiv', read_only: true },
      { name: 'belgeler', dataset: 'tank/depsis/a-belgeler', read_only: false },
    ]);
  });

  it('publishes the same configuration twice without complaint', async () => {
    const { shares, calls } = service();

    const first = await shares.publish(orgA, 'corr-3');
    const second = await shares.publish(orgA, 'corr-4');

    expect(second).toEqual(first);
    expect(calls).toHaveLength(2);
  });

  it('refuses to publish when the box holds more than one organization', async () => {
    // The hazard the refusal exists for: `publish_samba_config` REPLACES the generated file, so a
    // list filtered to one tenant does not add that tenant's shares — it deletes everyone else's.
    // orgA pressing republish must not take orgB's drives offline.
    const { shares, calls } = service(publishes(), { soleOrganization: null });

    await expect(shares.publish(orgA, 'corr-5')).rejects.toBeInstanceOf(
      ShareListNotDeviceWideError,
    );

    // And the agent was never asked. A check made after the call would still report an error, but
    // orgB's shares would already be gone from smb.conf.
    expect(calls).toHaveLength(0);
  });

  it('refuses a share whose name would rewrite the server’s own settings', async () => {
    // `shares_name_format` in migration 0008 accepts `global`; samba.rs refuses it, and refuses
    // the WHOLE publish with it. Catching it here names the offending share and leaves every other
    // share on the box being served.
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO shares (organization_id, name, dataset) VALUES ($1, 'Global', 'tank/depsis/a-global')`,
        [orgA],
      ),
    );
    const { shares, calls } = service();

    await expect(shares.publish(orgA, 'corr-6')).rejects.toBeInstanceOf(UnpublishableShareError);
    expect(calls).toHaveLength(0);
  });

  it('reports Samba as absent, and every share as unpublished, when the agent says so', async () => {
    const { shares } = service();
    await shares.publish(orgA, 'corr-7');
    expect((await shares.list(orgA)).items.every((s) => s.published)).toBe(true);

    // Samba removed under a running appliance. Nothing is being served any more, so nothing may
    // still be reported as published.
    const absent = new SharesService(
      db,
      stubAgent(() =>
        Promise.resolve<AgentResponse>({
          status: 'smb_unavailable',
          reason: 'samba is not installed: /usr/bin/testparm is not present',
        }),
      ).agent,
      stubSoleOrganization(orgA),
      SMB_HOST,
      PARENT_DATASET,
      new JobsService(db),
    );
    await expect(absent.publish(orgA, 'corr-8')).rejects.toBeInstanceOf(SmbUnavailableError);

    const listing = await absent.list(orgA);
    expect(listing.smbAvailable).toBe(false);
    expect(listing.items.every((s) => !s.published)).toBe(true);
  });

  it('keeps the previously published shares marked published when a publish is refused', async () => {
    // The agent rolls back on refusal, so the shares that were being served still are. Clearing
    // the record here would report a working share as unpublished because an unrelated new share
    // had a bad mountpoint — and would send the user to fix an address that works.
    let refuse = false;
    const { shares } = service((request) =>
      refuse
        ? Promise.resolve<AgentResponse>({
            status: 'refused',
            reason: 'samba rejected the new configuration and it was rolled back: bad mountpoint',
          })
        : publishes()(request),
    );

    await shares.publish(orgA, 'corr-9');
    refuse = true;
    await expect(shares.publish(orgA, 'corr-10')).rejects.toBeInstanceOf(AgentRefusedError);

    expect((await shares.list(orgA)).items.every((s) => s.published)).toBe(true);
  });

  it('stops claiming anything is served when a publish FAILS rather than being refused', async () => {
    // The one outcome that leaves the appliance worse than it was found. `samba.rs` gives
    // `RollbackFailed` its own variant — rejected AND the restore failed — and dispatch turns it
    // into `failed`, not `refused`. Collapsed with the refusal above, it produced two lies at
    // once: a 409 whose text promised "the previous one has been put back, so shares that were
    // working still are", and a `GET /shares` that kept reporting `published: true` for shares
    // smbd may now be refusing entirely. An administrator was told to retry a fixable problem
    // while SMB was down device-wide.
    let broken = false;
    const { shares } = service((request) =>
      broken
        ? Promise.resolve<AgentResponse>({
            status: 'failed',
            reason:
              'SAMBA IS BROKEN AND COULD NOT BE RESTORED. /etc/samba/depsis.conf now holds a ' +
              'configuration that was rejected',
          })
        : publishes()(request),
    );

    await shares.publish(orgA, 'corr-broken-1');
    expect((await shares.list(orgA)).items.every((s) => s.published)).toBe(true);

    broken = true;
    const error = await shares.publish(orgA, 'corr-broken-2').catch((e: unknown) => e);

    // Not an `AgentRefusedError`, because that is the error `describeRefusal` answers — and every
    // sentence it returns ends with a promise that is false here.
    expect(error).toBeInstanceOf(SmbPublishFailedError);
    expect(error).not.toBeInstanceOf(AgentRefusedError);
    expect((await shares.list(orgA)).items.every((s) => !s.published)).toBe(true);
  });

  it('claims nothing about Samba when the agent cannot be reached', async () => {
    const { shares } = service(publishes(), { available: false });

    const listing = await shares.list(orgA);

    // The contract's invariant: smbAvailable false means every published is false. smbd does not
    // depend on the agent, so some of these may well still be served — but a page saying "Samba is
    // unavailable" beside a share marked published is a page nobody can act on.
    expect(listing.smbAvailable).toBe(false);
    expect(listing.items.every((s) => !s.published)).toBe(true);
    // The shares themselves are still listed: the database knows them, and the address is still
    // worth showing.
    expect(listing.items).toHaveLength(2);
  });

  it('turns an answer the agent should not have given into an unavailability, not a success', async () => {
    const { shares } = service(() =>
      Promise.resolve<AgentResponse>({ status: 'ok', schema_version: 1 }),
    );

    await expect(shares.publish(orgA, 'corr-11')).rejects.toBeInstanceOf(AgentUnavailableError);
    expect((await shares.list(orgA)).items.every((s) => !s.published)).toBe(true);
  });
});

describeDb('opening a share', () => {
  let db: DbService;
  let owner: DbService;
  let jobs: JobsService;
  let org = '';
  let other = '';
  let admin = '';
  let uye = '';
  let outsider = '';

  /**
   * The agent's happy answer to `create_dataset`, plus a refusal for anything else.
   *
   * Deliberately narrow. A fixture that answers every operation would let this suite pass while
   * `create` called something it should not — and the one call it is allowed to make is the whole
   * subject of the first test below.
   */
  const creates =
    (status: 'created' | 'conflict' = 'created') =>
    (request: AgentRequest): Promise<AgentResponse> => {
      if (request.op !== 'create_dataset') {
        return Promise.reject(new Error(`create must not call '${request.op}'`));
      }
      return Promise.resolve<AgentResponse>(
        status === 'created'
          ? { status: 'created', dataset: request.dataset }
          : { status: 'conflict', reason: 'dataset already exists' },
      );
    };

  function service(
    respond: (request: AgentRequest) => Promise<AgentResponse> = creates(),
    parentDataset: string | null = PARENT_DATASET,
  ): { shares: SharesService; calls: RecordedCall[] } {
    const { agent, calls } = stubAgent(respond);
    return {
      shares: new SharesService(
        db,
        agent,
        stubSoleOrganization(org),
        SMB_HOST,
        parentDataset,
        jobs,
      ),
      calls,
    };
  }

  const grantsOf = async (
    shareId: string,
  ): Promise<{ user_id: string | null; team_id: string | null; permissions: string[] }[]> =>
    owner.withoutTenant('migration-status', (q) =>
      q.query(
        `SELECT user_id::text AS user_id, team_id::text AS team_id, permissions::text[] AS permissions
           FROM folder_grants WHERE share_id = $1 AND entry_id IS NULL`,
        [shareId],
      ),
    );

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);
    jobs = new JobsService(db);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name)
         VALUES ('mkshare-a','Make A'), ('mkshare-b','Make B')
         ON CONFLICT (slug) DO NOTHING`,
      );
      const orgs = await q.query<{ slug: string; id: string }>(
        `SELECT slug, id::text AS id FROM organizations WHERE slug IN ('mkshare-a','mkshare-b')`,
      );
      org = orgs.find((r) => r.slug === 'mkshare-a')?.id ?? '';
      other = orgs.find((r) => r.slug === 'mkshare-b')?.id ?? '';

      const seeded = await q.query<{ username: string; id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1,'mk-patron','admin','x'), ($1,'mk-uye','member','x'), ($2,'mk-yabanci','member','x')
         RETURNING username, id::text AS id`,
        [org, other],
      );
      admin = seeded.find((r) => r.username === 'mk-patron')?.id ?? '';
      uye = seeded.find((r) => r.username === 'mk-uye')?.id ?? '';
      outsider = seeded.find((r) => r.username === 'mk-yabanci')?.id ?? '';
    });
  });

  beforeEach(async () => {
    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(`DELETE FROM folder_grants WHERE organization_id = ANY($1)`, [[org, other]]);
      await q.query(`DELETE FROM shares WHERE organization_id = ANY($1)`, [[org, other]]);
    });
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM folder_grants WHERE organization_id = ANY($1)`, [[org, other]]);
        await q.query(`DELETE FROM shares WHERE organization_id = ANY($1)`, [[org, other]]);
        await q.query(`DELETE FROM users WHERE organization_id = ANY($1)`, [[org, other]]);
        await q.query(`DELETE FROM team_members WHERE organization_id = ANY($1)`, [[org, other]]);
        await q.query(`DELETE FROM teams WHERE organization_id = ANY($1)`, [[org, other]]);
        await q.query(`DELETE FROM organizations WHERE id = ANY($1)`, [[org, other]]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  it('creates the dataset, the row and the root grant, in that order', async () => {
    const { shares, calls } = service();

    const made = await shares.create(
      org,
      admin,
      { name: 'belgeler', readOnly: false, quotaBytes: null, grants: null },
      'corr-mk-1',
    );

    // One call, and only the one. `create_dataset` with the acltype the operation set can express
    // — `nfsv4` reports itself as configured while enforcing nothing (P0-B), which is why the
    // request carries no choice.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request).toMatchObject({
      op: 'create_dataset',
      dataset: 'tank/depsis/belgeler',
      acltype: 'posixacl',
      refquota_bytes: null,
    });

    expect(made.share.name).toBe('belgeler');
    expect(made.share.dataset).toBe('tank/depsis/belgeler');
    expect(made.share.unc_path).toBe('\\\\depsis-test\\belgeler');
    // Creating is not publishing. Saying otherwise sends someone to type an address that does not
    // answer, which is the failure `GET /shares` exists to prevent.
    expect(made.share.published).toBe(false);

    // THE INVARIANT, measured on the row that was just written rather than assumed from the code:
    // a share exists and it has a grant.
    const grants = await grantsOf(made.share.id);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.user_id).toBe(admin);
    expect(grants[0]?.team_id).toBeNull();
    // All eleven, because nobody said otherwise and the person who created it is the person who
    // should be able to hand it out. `manage` is in there for that reason.
    expect(grants[0]?.permissions).toHaveLength(11);
    expect(grants[0]?.permissions).toContain('manage');
  });

  it('writes the grants the caller named, and nothing for the caller', async () => {
    const { shares } = service();

    const made = await shares.create(
      org,
      admin,
      {
        name: 'ortak',
        readOnly: false,
        quotaBytes: 5_000_000_000,
        grants: [{ userId: uye, teamId: null, permissions: ['list', 'read'] }],
      },
      'corr-mk-2',
    );

    const grants = await grantsOf(made.share.id);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.user_id).toBe(uye);
    expect(grants[0]?.permissions).toEqual(['list', 'read']);
    // The administrator is NOT added alongside. They can already reach everything through §6.1's
    // hierarchy, and a row naming them would be a second grant of authority that survives their
    // account being demoted.
    expect(grants.some((g) => g.user_id === admin)).toBe(false);
  });

  it('refuses an empty grant list rather than treating it as "no opinion"', async () => {
    const { shares, calls } = service();

    await expect(
      shares.create(
        org,
        admin,
        { name: 'bos', readOnly: false, quotaBytes: null, grants: [] },
        'corr-mk-3',
      ),
    ).rejects.toBeInstanceOf(ShareWithoutGrantsError);

    // Refused before the agent, so no dataset is left on the pool for a request that was never
    // going to succeed — and nothing in the product can destroy one.
    expect(calls).toHaveLength(0);
  });

  it('refuses a name the tenant already uses, folding case as an SMB client would', async () => {
    const { shares, calls } = service();
    await shares.create(
      org,
      admin,
      { name: 'Belgeler', readOnly: false, quotaBytes: null, grants: null },
      'corr-mk-4',
    );

    // `belgeler` and `Belgeler` are one name to Windows, so the second must not be creatable. The
    // İ-family folds the same way: `BELGELER` too.
    await expect(
      shares.create(
        org,
        admin,
        { name: 'belgeler', readOnly: false, quotaBytes: null, grants: null },
        'corr-mk-5',
      ),
    ).rejects.toBeInstanceOf(ShareNameTakenError);

    // One call, from the first create. The refusal happened before the agent, which is what stops
    // a duplicate click from leaving an orphan dataset behind.
    expect(calls).toHaveLength(1);
  });

  it('reports a dataset that already exists on the pool as the name being taken', async () => {
    const { shares } = service(creates('conflict'));

    // Reachable without a race: deleting a share from the database leaves its dataset, because the
    // operation set has no destroy (ADR-0007).
    const error = await shares
      .create(
        org,
        admin,
        { name: 'kalinti', readOnly: false, quotaBytes: null, grants: null },
        'corr-mk-6',
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShareNameTakenError);
    expect((error as ShareNameTakenError).where).toBe('pool');

    // And no row was written for it.
    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ n: string }>(`SELECT count(*)::text AS n FROM shares WHERE organization_id = $1`, [
        org,
      ]),
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('refuses a grant naming somebody outside this organisation, and writes no row', async () => {
    const { shares } = service();

    await expect(
      shares.create(
        org,
        admin,
        {
          name: 'sizinti',
          readOnly: false,
          quotaBytes: null,
          grants: [{ userId: outsider, teamId: null, permissions: ['list'] }],
        },
        'corr-mk-7',
      ),
    ).rejects.toBeInstanceOf(UnknownGrantPrincipalError);

    // A foreign key would NOT have caught this: referential integrity is checked below row level
    // security, so the row would have inserted cleanly as a cross-tenant permission.
    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ n: string }>(`SELECT count(*)::text AS n FROM shares WHERE organization_id = $1`, [
        org,
      ]),
    );
    // The share row and the grant are one transaction, so the failing grant took the share with
    // it. The dataset survives on the pool, which is the trade this ordering accepts and the
    // reason the name check happens first.
    expect(rows[0]?.n).toBe('0');
  });

  it('refuses a reserved smb.conf section before it can poison every other share', async () => {
    const { shares, calls } = service();

    // The agent refuses these too — and it refuses the WHOLE publish, so one such share would stop
    // every other share on the box from being served.
    await expect(
      shares.create(
        org,
        admin,
        { name: 'global', readOnly: false, quotaBytes: null, grants: null },
        'corr-mk-8',
      ),
    ).rejects.toBeInstanceOf(UnpublishableShareError);
    expect(calls).toHaveLength(0);
  });

  it('says so plainly when the appliance has no pool configured for shares', async () => {
    const { shares, calls } = service(creates(), null);

    await expect(
      shares.create(
        org,
        admin,
        { name: 'nerede', readOnly: false, quotaBytes: null, grants: null },
        'corr-mk-9',
      ),
    ).rejects.toBeInstanceOf(ShareStorageUnconfiguredError);
    expect(calls).toHaveLength(0);
  });

  it('carries the quota through as refquota, which excludes snapshots', async () => {
    const { shares, calls } = service();

    await shares.create(
      org,
      admin,
      { name: 'kotali', readOnly: true, quotaBytes: 1_073_741_824, grants: null },
      'corr-mk-10',
    );

    // `refquota` and not `quota`: an administrator's snapshot policy must not be able to lock a
    // user out of their own space (ADR-0008).
    expect(calls[0]?.request).toMatchObject({ refquota_bytes: 1_073_741_824 });
    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ read_only: boolean }>(
        `SELECT read_only FROM shares WHERE organization_id = $1 AND name = 'kotali'`,
        [org],
      ),
    );
    expect(rows[0]?.read_only).toBe(true);
  });
});
