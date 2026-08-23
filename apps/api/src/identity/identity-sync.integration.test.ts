import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AgentService } from '../agent/agent.service.js';
import { generateKey, SecretBox } from '../auth/secret-box.js';
import { ntHash } from '../auth/nt-hash.js';
import { DbService } from '../db/db.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import { IdentitySyncService } from './identity-sync.service.js';

/**
 * The desired state DEPSIS hands the agent, against a real PostgreSQL.
 *
 * What is worth measuring here is the SHAPE of the request, because the shape is the whole
 * contract: the agent replaces group membership wholesale from it, so a uid the API forgets to
 * send is a person removed from a group, and a uid it sends by mistake is a person who keeps
 * access their grant no longer covers.
 *
 * The agent itself is a fake. Whether `useradd` works is measured on the Rust side against real
 * `getent` output, and in `tools/poc/p2-a-smb-identity.sh` against a real smbd.
 */
const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];
const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

interface SyncCall {
  op: string;
  users: Array<{ uid: number; login: string; nt_hash?: string }>;
  groups: Array<{ gid: number; members: number[] }>;
}

describeDb('the POSIX identity DEPSIS asks for, against a real PostgreSQL', () => {
  let db: DbService;
  let owner: DbService;
  let identity: IdentitySyncService;
  let calls: SyncCall[] = [];

  let org = '';
  let ali = '';
  let veli = '';
  let team = '';

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);

    const agent = {
      isAvailable: () => true,
      call: (request: Record<string, unknown>) => {
        calls.push(request as unknown as SyncCall);
        return Promise.resolve({
          status: 'posix_identity_synced',
          users_created: 0,
          groups_created: 0,
          passwords_set: 0,
        });
      },
    } as unknown as AgentService;

    identity = new IdentitySyncService(
      db,
      agent,
      new SecretBox(Buffer.from(generateKey(), 'base64')),
      new JobsService(db),
    );

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name) VALUES ('idsync','Id Sync')
         ON CONFLICT (slug) DO NOTHING`,
      );
      org =
        (
          await q.query<{ id: string }>(
            `SELECT id::text AS id FROM organizations WHERE slug = 'idsync'`,
          )
        )[0]?.id ?? '';

      const seeded = await q.query<{ username: string; id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash, posix_uid)
         VALUES ($1,'ali','member','x',300501), ($1,'veli','member','x',300502),
                ($1,'kimliksiz','member','x',NULL), ($1,'kapali','member','x',300503)
         RETURNING username, id::text AS id`,
        [org],
      );
      ali = seeded.find((r) => r.username === 'ali')?.id ?? '';
      veli = seeded.find((r) => r.username === 'veli')?.id ?? '';
      await q.query(`UPDATE users SET disabled_at = now() WHERE username = 'kapali'`);

      team =
        (
          await q.query<{ id: string }>(
            `INSERT INTO teams (organization_id, name, posix_gid)
             VALUES ($1,'muhasebe',300510) RETURNING id::text AS id`,
            [org],
          )
        )[0]?.id ?? '';
      await q.query(
        `INSERT INTO team_members (organization_id, team_id, user_id) VALUES ($1,$2,$3)`,
        [org, team, ali],
      );
    });
  });

  beforeEach(() => {
    calls = [];
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM job_queue WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM team_members WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM teams WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM users WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM organizations WHERE id = $1`, [org]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  it('sends every user that has a uid, and leaves out the ones that cannot be expressed', async () => {
    await identity.sync(org, 'test');

    const logins = calls[0]?.users.map((u) => u.login).sort();
    expect(logins).toEqual(['ali', 'veli']);
    // `kimliksiz` has no uid. Allocating one here would spend a number nothing records —
    // allocation belongs to `PosixIdentityService`, in the transaction that writes the row.
    expect(logins).not.toContain('kimliksiz');
    // A disabled account must not be able to reach the NAS over SMB either. Leaving it in would
    // make disabling an account a web-only act.
    expect(logins).not.toContain('kapali');
  });

  it('sends membership as uids, not as names', async () => {
    await identity.sync(org, 'test');

    expect(calls[0]?.groups).toEqual([{ gid: 300510, members: [300501] }]);
  });

  it('sends an EMPTY member list rather than omitting a group nobody is in', async () => {
    // The agent replaces membership wholesale, so an omitted group keeps whatever it had. That is
    // exactly how a member who left a team keeps reaching folders their grant no longer covers.
    await owner.withoutTenant('migration-status', (q) =>
      q.query(`DELETE FROM team_members WHERE organization_id = $1 AND team_id = $2`, [org, team]),
    );
    await identity.sync(org, 'test');
    expect(calls[0]?.groups).toEqual([{ gid: 300510, members: [] }]);

    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO team_members (organization_id, team_id, user_id) VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING`,
        [org, team, ali],
      ),
    );
  });

  it('omits the NT hash for a user who has never set a password since this existed', async () => {
    await identity.sync(org, 'test');
    // ABSENT, not null: the agent's field is optional and an absent one leaves whatever password
    // the account already had. Sending null would be a claim about a password nobody set.
    expect(calls[0]?.users.every((u) => u.nt_hash === undefined)).toBe(true);
  });

  it('seals the NT hash on a password change and sends it back unchanged', async () => {
    const password = 'gizli-parola-42';
    await db.withTenant(org, (q) => identity.rememberPassword(q, org, ali, password));

    // Sealed at rest: the stored bytes must not be the hash itself, or a database backup would
    // hand out SMB access on its own.
    const stored = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ nt_hash: Buffer | null; nt_hash_key_version: number | null }>(
        `SELECT nt_hash, nt_hash_key_version FROM users WHERE id = $1`,
        [ali],
      ),
    );
    expect(stored[0]?.nt_hash_key_version).toBe(1);
    expect(stored[0]?.nt_hash?.toString('ascii')).not.toBe(ntHash(password));

    // And it comes back out as exactly the hash Samba expects.
    await identity.sync(org, 'test');
    const sent = calls[0]?.users.find((u) => u.login === 'ali');
    expect(sent?.nt_hash).toBe(ntHash(password));
    expect(sent?.nt_hash).toMatch(/^[0-9A-F]{32}$/);

    // The other user is untouched — the seal is bound to the row, so one password change cannot
    // reach another account.
    expect(calls[0]?.users.find((u) => u.login === 'veli')?.nt_hash).toBeUndefined();
    expect(veli).not.toBe('');
  });

  it('queues a sync rather than doing one, and with a budget that outlives a restart', async () => {
    await owner.withoutTenant('migration-status', (q) =>
      q.query(`DELETE FROM job_queue WHERE organization_id = $1`, [org]),
    );
    await identity.enqueue(org, 'a test');

    const queued = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ kind: string; max_attempts: number }>(
        `SELECT kind, max_attempts FROM job_queue WHERE organization_id = $1`,
        [org],
      ),
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]?.kind).toBe('identity.sync');
    // Not the queue's default of five, which spends thirty seconds in total and does not survive
    // an agent restart — and what would be abandoned is a user who cannot reach the NAS.
    expect(queued[0]?.max_attempts).toBeGreaterThan(5);
    // Enqueuing must not have talked to the agent. It is an INSERT.
    expect(calls).toHaveLength(0);
  });
});
