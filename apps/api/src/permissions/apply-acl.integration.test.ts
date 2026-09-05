import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentService } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import { PosixIdentityService } from '../identity/posix.service.js';
import { APPLY_CHUNK, MAX_TREE_DEPTH, AclApplyService } from './apply-acl.service.js';

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
  /** Absent on `secure_share_root`, which names a share and no path inside it. */
  path?: string[];
  entries?: Array<{ gid: number; read: boolean; write: boolean; execute: boolean }>;
}

/**
 * An agent that answers each operation with its own status.
 *
 * One status for everything was fine while `apply` made one kind of call. It now makes two —
 * `secure_share_root` on the share root, then `apply_folder_acl` per folder — and answering the
 * first with `acl_applied` would exercise the service's "the agent said something impossible"
 * branch on every test rather than its happy path.
 */
function aclAgent(
  respond: (request: Record<string, unknown>) => Promise<{ status: string; [k: string]: unknown }>,
  // A GETTER, not the array. Every test starts with `calls = []`, so an agent that captured the
  // array it was built with would keep pushing into the one nobody reads any more — which is
  // exactly what the first version of this helper did, and it turned nine passing tests into nine
  // assertions against an empty list.
  sink: () => AclCall[],
): AgentService {
  return {
    isAvailable: () => true,
    call: (request: Record<string, unknown>) => {
      sink().push(request as unknown as AclCall);
      return respond(request);
    },
  } as unknown as AgentService;
}

/** The ordinary answers: the root is secured, every folder's ACL is written. */
const answersNormally = (
  request: Record<string, unknown>,
): Promise<{ status: string; [k: string]: unknown }> =>
  Promise.resolve(
    request['op'] === 'secure_share_root'
      ? { status: 'share_root_secured', mode: 0o750 }
      : { status: 'acl_applied', entries: 1 },
  );

/** Only the folder writes, for assertions about which folders were rewritten. */
const aclCallsIn = (calls: readonly AclCall[]): AclCall[] =>
  calls.filter((call) => call.op === 'apply_folder_acl');

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
    aclCallsIn(calls).find((call) => (call.path ?? []).join('/') === path.join('/'));

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);

    acl = new AclApplyService(
      db,
      aclAgent(answersNormally, () => calls),
      new PosixIdentityService(db),
    );

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

    expect(aclCallsIn(calls).map((call) => call.op)).toEqual(Array(4).fill('apply_folder_acl'));
    expect(calls.every((call) => call.share === 'acl_a')).toBe(true);
    // Paths are components under the share root, built from `parent_id` and not from the `path`
    // column (ADR-0005) — this string is about to be handed to a privileged process.
    expect(
      aclCallsIn(calls)
        .map((call) => (call.path ?? []).join('/'))
        .sort(),
    ).toEqual(['', 'belgeler', 'belgeler/gizli', 'belgeler/ortak']);
    // Only folders. A file carries no default ACL and inherits the directory's.
    expect(calls.some((call) => (call.path ?? []).includes('not.txt'))).toBe(false);
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

    expect(aclCallsIn(calls).map((call) => (call.path ?? []).join('/'))).toEqual([
      'belgeler/gizli',
    ]);
    // And the answer is still resolved against the WHOLE chain, so the root grant above the named
    // entry is not lost just because the job did not rewrite the root.
    expect(calls[0]?.entries).toEqual([{ gid: takimGid, read: true, write: false, execute: true }]);
  });

  it('closes the share root before writing its ACL, and never after', async () => {
    // WHAT THIS CLOSES. `zfs create` leaves a mountpoint at 0755 root:root and `ApplyFolderAcl`
    // refuses to touch the base triple, so every share root was `other::r-x`: any principal Samba
    // authenticated could enumerate the top-level folder names whatever the grants said.
    calls = [];
    await acl.apply(org, { shareId: share, entryId: null }, 'test');

    const ops = calls.map((call) => call.op);
    expect(ops[0]).toBe('secure_share_root');
    expect(calls[0]?.share).toBe('acl_a');

    // FIRST, and the order is a POSIX rule rather than a preference: `chmod` on a file that
    // already carries an ACL sets the MASK from the group bits instead of the `group::` entry, so
    // securing afterwards would clamp every named entry to r-x. The `setfacl` calls that follow
    // recompute the mask correctly.
    expect(ops.indexOf('secure_share_root')).toBeLessThan(ops.indexOf('apply_folder_acl'));
    expect(ops.filter((op) => op === 'secure_share_root')).toHaveLength(1);
  });

  it('does not touch the root mode for a job aimed at one folder inside the share', async () => {
    // A subtree apply is not about the root, and re-securing it on every folder-scoped write would
    // be a round trip that changes nothing — and would clamp the root's mask between the chmod and
    // an ACL write that is never going to come, because this job does not write the root.
    calls = [];
    await acl.apply(org, { shareId: share, entryId: gizli }, 'test');

    expect(calls.map((call) => call.op)).not.toContain('secure_share_root');
  });

  it('applies the rest of the share even when the root cannot be closed', async () => {
    // An older agent does not know this operation. Failing the whole job for that would trade a
    // narrow, pre-existing leak for the entire permission model going unapplied — so it is logged
    // and the walk continues.
    const refusing = new AclApplyService(
      db,
      aclAgent(
        (request) =>
          request['op'] === 'secure_share_root'
            ? Promise.resolve({ status: 'refused', reason: 'unknown operation' })
            : Promise.resolve({ status: 'acl_applied', entries: 1 }),
        () => [],
      ),
      new PosixIdentityService(db),
    );

    await expect(
      refusing.apply(org, { shareId: share, entryId: null }, 'test'),
    ).resolves.toBeDefined();
  });

  it('names the missing program when the box has no setfacl', async () => {
    // AJAN BU CÜMLEYİ ÖZELLİKLE ÜRETİYOR ve `setfacl`ı adıyla anıyor; sorun onun buraya kadar
    // gelip burada atılmasıydı. `acl_unavailable` ne `refused` ne `failed` sayıldığı için
    // `expectStatus` genel bir "expected 'acl_applied'" hatasına çeviriyor ve gerekçeyi
    // düşürüyordu — iş kartında ne olduğu, dolayısıyla ne yapılacağı okunamıyordu.
    const noAcl = new AclApplyService(
      db,
      aclAgent(
        (request) =>
          request['op'] === 'secure_share_root'
            ? Promise.resolve({ status: 'share_root_secured', mode: 0o750 })
            : Promise.resolve({
                status: 'acl_unavailable',
                reason: 'setfacl is not installed on this appliance (apt install acl)',
              }),
        () => [],
      ),
      new PosixIdentityService(db),
    );

    const error = await noAcl
      .apply(org, { shareId: share, entryId: null }, 'test')
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    // Eksik programın adı hatanın metninde: iş kartında görünen tek şey bu.
    expect((error as Error).message).toContain('setfacl');
  });

  it('applies a share larger than one chunk across several jobs, covering every folder once', async () => {
    // THE OLD BEHAVIOUR WAS TOTAL FAILURE, not a partial one. `folderRows` threw when the share
    // held more folders than the bound, and it threw BEFORE the write loop — so a large share got
    // no ACLs at all, deterministically, on every retry, until the job died. Every permission
    // change in it, revocations included, committed to Postgres and never reached disk. Five
    // thousand folders is nothing for a NAS, and counting trashed folders made it easier to reach.
    //
    // `APPLY_CHUNK + 1` rather than a literal: the bound is a tuning number and this test has to
    // keep measuring chunking when it moves.
    const extra = APPLY_CHUNK + 1;
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO file_entries (organization_id, share_id, parent_id, kind, name, path)
         SELECT $1, $2, $3, 'folder', 'c' || i, '/belgeler/c' || i
           FROM generate_series(1, $4) AS i`,
        [org, share, belgeler, extra],
      ),
    );

    calls = [];
    const firstPass = await acl.apply(org, { shareId: share, entryId: null }, 'test');
    // It stopped, and it SAYS it stopped — the cursor is the whole difference between a chunk and
    // a truncation.
    expect(firstPass.next).not.toBeNull();
    const firstWritten = aclCallsIn(calls).map((call) => (call.path ?? []).join('/'));
    expect(firstWritten.length).toBe(APPLY_CHUNK + 1); // the chunk, plus the share root

    // Keep going until it says it is done, exactly as the worker does by re-queueing.
    let cursor = firstPass.next;
    const everything = [...firstWritten];
    for (let round = 0; cursor !== null && round < 10; round += 1) {
      calls = [];
      const pass = await acl.apply(org, { shareId: share, entryId: null, after: cursor }, 'test');
      everything.push(...aclCallsIn(calls).map((call) => (call.path ?? []).join('/')));
      cursor = pass.next;
    }
    expect(cursor).toBeNull();

    // EVERY folder, and each of them ONCE. A cursor that overlapped would merely waste agent
    // calls; one that skipped would leave a folder carrying the pre-change ACL with nothing
    // recording it, which is the failure this whole class exists to prevent.
    const seen = new Set(everything);
    expect(seen.size).toBe(everything.length);
    expect(everything).toHaveLength(extra + 4); // the seeded folders, plus the fixture's four nodes
    expect(seen.has('')).toBe(true); // the share root, written in the first chunk only
    expect(seen.has('belgeler/c1')).toBe(true);
    expect(seen.has(`belgeler/c${extra}`)).toBe(true);

    await owner.withoutTenant('migration-status', (q) =>
      q.query(`DELETE FROM file_entries WHERE organization_id = $1 AND name LIKE 'c%'`, [org]),
    );
  });

  it('refuses a tree deeper than the bound instead of quietly dropping the bottom of it', async () => {
    // THE OLD BEHAVIOUR WAS SILENCE. `tree.depth < MAX_TREE_DEPTH` simply stopped returning rows,
    // so folders below the bound were absent from `all`, from `written`, from `targets` — and
    // therefore from `failures`, which can only name ids that were in `targets`. The job reported
    // SUCCESS having left those directories carrying the pre-change ACL. A bound that drops work
    // without saying so is the same defect as a constraint that accepts what it claims to refuse.
    //
    // One chain, MAX_TREE_DEPTH + 1 deep. `generate_series` with a recursive insert would be
    // neater but the ids have to be known to chain them, so a loop it is.
    const deep: string[] = [];
    await owner.withoutTenant('migration-status', async (q) => {
      // Annotated because the loop assigns from its own result: without it TypeScript infers
      // `parent` from an expression that references `parent`.
      let parent: string | null = null;
      let path = '';
      for (let level = 0; level <= MAX_TREE_DEPTH; level += 1) {
        path = `${path}/d${level}`;
        const row: { id: string }[] = await q.query<{ id: string }>(
          `INSERT INTO file_entries (organization_id, share_id, parent_id, kind, name, path)
           VALUES ($1,$2,$3,'folder',$4,$5) RETURNING id::text AS id`,
          [org, share, parent, `d${level}`, path],
        );
        parent = row[0]?.id ?? null;
        if (parent !== null) deep.push(parent);
      }
    });

    calls = [];
    await expect(acl.apply(org, { shareId: share, entryId: null }, 'test')).rejects.toThrow(
      /nested deeper than/,
    );
    // And nothing was written. Refusing AFTER writing part of the tree would leave the shallow
    // half on the new answer and the deep half on the old one, which is the divergence with no
    // record that this whole class exists to prevent.
    expect(calls).toHaveLength(0);

    await owner.withoutTenant('migration-status', async (q) => {
      for (const id of [...deep].reverse()) {
        await q.query(`DELETE FROM file_entries WHERE id = $1`, [id]);
      }
    });
  });

  it('rewrites a trashed folder too, because its directory is live on SMB', async () => {
    // The walk used to filter `trashed_at IS NULL`, justified in a comment as "they are not
    // somewhere anybody browses". That is false for the half of the appliance the ACLs exist for:
    // trashing sets a flag and touches nothing else, so the directory is still at its original
    // path inside the same Samba section — `samba.rs` vetoes only `/.depsis/` — and it is
    // browsable over SMB the whole time it sits in the bin. A narrowing at the root reported
    // success and left the binned branch carrying the OLD, wider ACL.
    await owner.withoutTenant('migration-status', (q) =>
      // Both columns together: `file_entries_trash_pair` is
      // `(trashed_at IS NULL) = (trashed_by IS NULL)`, so a half-set pair is refused — which is
      // the constraint doing exactly its job on a fixture that got it wrong.
      q.query(`UPDATE file_entries SET trashed_at = now(), trashed_by = $2 WHERE id = $1`, [
        ortak,
        ayse,
      ]),
    );

    calls = [];
    await acl.apply(org, { shareId: share, entryId: null }, 'test');
    expect(aclCallsIn(calls).map((call) => (call.path ?? []).join('/'))).toContain(
      'belgeler/ortak',
    );

    await owner.withoutTenant('migration-status', (q) =>
      q.query(`UPDATE file_entries SET trashed_at = NULL, trashed_by = NULL WHERE id = $1`, [
        ortak,
      ]),
    );
  });

  it('does not lose a LIVE folder just because its parent is in the bin', async () => {
    // The sharper half of the same defect, and the one a reader is least likely to predict. The
    // filter sat on both the anchor AND the recursive join, so a child could not enter a tree its
    // parent was absent from — one binned folder near the root silently took its whole subtree out
    // of every future apply, live descendants included.
    const derin =
      (
        await owner.withoutTenant('migration-status', (q) =>
          q.query<{ id: string }>(
            `INSERT INTO file_entries (organization_id, share_id, parent_id, kind, name, path)
             VALUES ($1,$2,$3,'folder','derin','/belgeler/ortak/derin') RETURNING id::text AS id`,
            [org, share, ortak],
          ),
        )
      )[0]?.id ?? '';

    await owner.withoutTenant('migration-status', (q) =>
      q.query(`UPDATE file_entries SET trashed_at = now(), trashed_by = $2 WHERE id = $1`, [
        ortak,
        ayse,
      ]),
    );

    calls = [];
    await acl.apply(org, { shareId: share, entryId: null }, 'test');
    const written = aclCallsIn(calls).map((call) => (call.path ?? []).join('/'));
    expect(written).toContain('belgeler/ortak/derin');

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(`UPDATE file_entries SET trashed_at = NULL, trashed_by = NULL WHERE id = $1`, [
        ortak,
      ]);
      await q.query(`DELETE FROM file_entries WHERE id = $1`, [derin]);
    });
  });
});
