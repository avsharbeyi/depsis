import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentRefusedError,
  AgentUnavailableError,
  type AgentRequest,
  type AgentResponse,
  type AgentService,
} from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import type { OrganizationsService } from '../organizations/organizations.service.js';
import {
  ShareListNotDeviceWideError,
  SharesService,
  SmbPublishFailedError,
  SmbUnavailableError,
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
        await q.query(`DELETE FROM shares WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
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
      shares: new SharesService(db, agent, stubSoleOrganization(sole), SMB_HOST),
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
