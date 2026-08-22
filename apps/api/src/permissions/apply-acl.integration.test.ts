import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentService } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import { PosixIdentityService } from '../identity/posix.service.js';
import { AclApplyService } from './apply-acl.service.js';

/**
 * The half of §6.2 that leaves the database: `permissions.apply`, against a real PostgreSQL.
 *
 * This job did not exist. `PermissionsService` enqueued it, `WorkerService` never claimed it
 * because no handler was registered, and so every grant lived in Postgres alone — the folder was
 * closed on the web and open over SMB, which is exactly the split ADR-0004 and §6.2 forbid. The
 * assertions below are about the AGENT CALLS, because the calls are the only evidence the kernel
 * was told anything; a test that read back rows would pass just as happily against the version
 * that queued a job nobody ran.
 *
 * The database is real for the usual reason: the tree walk, the path components accumulated from
 * `parent_id`, and the per-principal nearest-ancestor grant all live in SQL and in the resolver,
 * and a fake would agree with whatever this file assumed.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];

const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

interface AclCall {
  op: string;
  share: string;
  path: string[];
  entries: Array<{ gid: number; read: boolean; write: boolean; execute: boolean }>;
}

describeDb('applying folder grants to POSIX, against a real PostgreSQL', () => {
  let db: DbService;
  let owner: DbService;
  let acl: AclApplyService;
  let calls: AclCall[] = [];

  let org = '';
  let share = '';
  let takim = '';
  let takimGid = 0;
  let ayse = '';
  let ayseUid = 0;

  // <share> / belgeler / {gizli, ortak}
  let belgeler = '';
  let gizli = '';
  let ortak = '';

  const aclFor = (path: string[]): AclCall | undefined =>
    calls.find((call) => call.path.join('/') === path.join('/'));

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);

    const agent = {
      isAvailable: () => true,
      call: (request: Record<string, unknown>) => {
        calls.push(request as unknown as AclCall);
        return Promise.resolve({ status: 'acl_applied' });
      },
    } as unknown as AgentService;
    acl = new AclApplyService(db, agent, new PosixIdentityService(db));

    await owner.withoutTenant('migration-status', async (q) => {
      org =
        (
          await q.query<{ id: string }>(
            `INSERT INTO organizations (slug, name) VALUES ('acl-a','Acl A')
             RETURNING id::text AS id`,
          )
        )[0]?.id ?? '';

      ayse =
        (
          await q.query<{ id: string }>(
            `INSERT INTO users (organization_id, username, role, password_hash)
             VALUES ($1,'ayse','member','x') RETURNING id::text AS id`,
            [org],
          )
        )[0]?.id ?? '';

      const team = await q.query<{ id: string; posix_gid: number }>(
        `INSERT INTO teams (organization_id, name, posix_gid)
         VALUES ($1,'takim', public.allocate_posix_id('team'))
         RETURNING id::text AS id, posix_gid`,
        [org],
      );
      takim = team[0]?.id ?? '';
      takimGid = team[0]?.posix_gid ?? 0;

      share =
        (
          await q.query<{ id: string }>(
            `INSERT INTO shares (organization_id, name, dataset)
             VALUES ($1,'acl_a','tank/acl_a') RETURNING id::text AS id`,
            [org],
          )
        )[0]?.id ?? '';

      belgeler =
        (
          await q.query<{ id: string }>(
            `INSERT INTO file_entries (organization_id, share_id, parent_id, kind, name, path)
             VALUES ($1,$2,NULL,'folder','belgeler','/belgeler') RETURNING id::text AS id`,
            [org, share],
          )
        )[0]?.id ?? '';

      const inner = await q.query<{ id: string; name: string }>(
        `INSERT INTO file_entries (organization_id, share_id, parent_id, kind, name, path)
         VALUES ($1,$2,$3,'folder','gizli','/belgeler/gizli'),
                ($1,$2,$3,'folder','ortak','/belgeler/ortak'),
                ($1,$2,$3,'file','not.txt','/belgeler/not.txt')
         RETURNING id::text AS id, name`,
        [org, share, belgeler],
      );
      gizli = inner.find((r) => r.name === 'gizli')?.id ?? '';
      ortak = inner.find((r) => r.name === 'ortak')?.id ?? '';

      // The share root opens `belgeler` to the team with everything a folder can carry; `gizli`
      // narrows the SAME team to reading only. That pair is ADR-0021's "istisna: daha dar izin",
      // and it is the case a recursive `setfacl -R` was measured destroying.
      await q.query(
        `INSERT INTO folder_grants (organization_id, share_id, entry_id, team_id, permissions)
         VALUES ($1,$2,NULL,$3,'{list,read,download,create,modify,move,delete}'),
                ($1,$2,$4,$3,'{list,read}')`,
        [org, share, takim, gizli],
      );
      // A grant to a PERSON, which ADR-0004 still expresses as a group: their own private group,
      // whose gid is their uid.
      await q.query(
        `INSERT INTO folder_grants (organization_id, share_id, entry_id, user_id, permissions)
         VALUES ($1,$2,$3,$4,'{manage,audit}')`,
        [org, share, ortak, ayse],
      );
    });

    ayseUid = await new PosixIdentityService(db).posixUidFor(org, ayse);
    expect(org).not.toBe('');
    expect(takimGid).toBeGreaterThan(0);
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM job_queue WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM folder_grants WHERE organization_id = $1`, [org]);
        await q.query(
          `DELETE FROM file_entries WHERE organization_id = $1 AND parent_id IS NOT NULL`,
          [org],
        );
        await q.query(`DELETE FROM file_entries WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM shares WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM teams WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM users WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM organizations WHERE id = $1`, [org]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  it('sends one apply_folder_acl per folder, the share root included', async () => {
    calls = [];
    await acl.apply(org, { shareId: share, entryId: null }, 'test');

    expect(calls.map((call) => call.op)).toEqual(Array(4).fill('apply_folder_acl'));
    expect(calls.every((call) => call.share === 'acl_a')).toBe(true);
    // Paths are components under the share root, built from `parent_id` and not from the `path`
    // column (ADR-0005) — this string is about to be handed to a privileged process.
    expect(calls.map((call) => call.path.join('/')).sort()).toEqual([
      '',
      'belgeler',
      'belgeler/gizli',
      'belgeler/ortak',
    ]);
    // Only folders. A file carries no default ACL and inherits the directory's.
    expect(calls.some((call) => call.path.includes('not.txt'))).toBe(false);
  });

  it("turns §6.2's permissions into the three bits a directory has", async () => {
    calls = [];
    await acl.apply(org, { shareId: share, entryId: null }, 'test');

    // Everything: `list` is r, the four content-changing ones are w, and anything that reaches
    // inside needs x.
    expect(aclFor(['belgeler'])?.entries).toEqual([
      { gid: takimGid, read: true, write: true, execute: true },
    ]);
  });

  it('keeps a narrower grant on a subfolder narrower, which is what recursion would destroy', async () => {
    calls = [];
    await acl.apply(org, { shareId: share, entryId: null }, 'test');

    // `list,read` on a directory is r and x and no w: the team can see what is in it and open the
    // files, and cannot add, rename or delete anything. The wide grant one level up does not reach
    // here, per principal — which is the whole of ADR-0021's narrowing, and the reason
    // `ApplyFolderAcl` has no `recursive` operand.
    expect(aclFor(['belgeler', 'gizli'])?.entries).toEqual([
      { gid: takimGid, read: true, write: false, execute: true },
    ]);
  });

  it('gives a grant that names a person their own private group, and drops what POSIX cannot say', async () => {
    calls = [];
    await acl.apply(org, { shareId: share, entryId: null }, 'test');

    const entries = aclFor(['belgeler', 'ortak'])?.entries ?? [];
    // The team is still here, inherited from the root; Ayşe's own row is the second entry and it
    // names her uid as a gid — migration 0015 allocates both from one counter so that works.
    expect(entries).toContainEqual({ gid: takimGid, read: true, write: true, execute: true });
    // Her grant is `manage` and `audit`, which are DEPSIS concepts with no bit on a directory. An
    // entry with no bits set would be filesystem access the grant never described, so there is
    // none: the applied ACL is a subset of the application's answer (ADR-0004), never a superset.
    expect(entries.some((entry) => entry.gid === ayseUid)).toBe(false);
  });

  it('writes only the named subtree when the job names an entry', async () => {
    calls = [];
    await acl.apply(org, { shareId: share, entryId: gizli }, 'test');

    expect(calls.map((call) => call.path.join('/'))).toEqual(['belgeler/gizli']);
    // And the answer is still resolved against the WHOLE chain, so the root grant above the named
    // entry is not lost just because the job did not rewrite the root.
    expect(calls[0]?.entries).toEqual([{ gid: takimGid, read: true, write: false, execute: true }]);
  });
});
