import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentService } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import {
  APPLY_ACL_KIND,
  LastGrantError,
  NodeNotFoundError,
  NotAFolderError,
  NotManageableError,
  PermissionsService,
  UnknownPrincipalError,
  type Actor,
} from './permissions.service.js';

/**
 * ADR-0021's inheritance rule, against a real PostgreSQL.
 *
 * The rule itself has unit tests in `packages/authz`, and they are not what this file duplicates.
 * What cannot be settled by a pure test is the half that lives in SQL: the ancestor chain built
 * from `parent_id` by a recursive CTE, the share root arriving as `entry_id IS NULL`, the
 * per-principal grant rows, and above all row level security — "another tenant's folder is not
 * found" is a property of a policy, and a fake would agree with whatever the code assumed.
 *
 * Skipped unless `DEPSIS_TEST_DATABASE_URL` points at a migrated database.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];

const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

/** The agent, as far as this service is concerned: one question, asked once per write. */
function agentThatIs(available: boolean): AgentService {
  return { isAvailable: () => available } as unknown as AgentService;
}

describeDb('folder permissions, against a real PostgreSQL', () => {
  let db: DbService;
  let owner: DbService;
  let permissions: PermissionsService;
  let offline: PermissionsService;

  // Two tenants, because the interesting half of an authorization test is what it refuses.
  let orgA = '';
  let orgB = '';

  let shareA = '';
  let shareB = '';
  // orgA's second share, deliberately left without a single grant row. See `LEGACY_OPEN_SHARE`.
  let shareC = '';
  let bakir = '';

  // orgA's tree:  <share> / projeler / {gizli, ortak}, plus an ungranted `bos`.
  let projeler = '';
  let gizli = '';
  let ortak = '';
  let bos = '';
  let belge = '';
  let theirFolder = '';

  let ekipBir = '';
  let ekipIki = '';

  let ali = '';
  let veli = '';
  let zeynep = '';
  let yonetici = '';
  let patron = '';

  const asUser = (id: string): Actor => ({ userId: id, isAdmin: false });
  const asAdmin = (id: string): Actor => ({ userId: id, isAdmin: true });

  async function grantsAt(entryId: string | null): Promise<number> {
    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM folder_grants
          WHERE share_id = $1 AND entry_id IS NOT DISTINCT FROM $2`,
        [shareA, entryId],
      ),
    );
    return Number(rows[0]?.n ?? '0');
  }

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);

    const jobs = new JobsService(db);
    permissions = new PermissionsService(db, jobs, agentThatIs(true));
    offline = new PermissionsService(db, jobs, agentThatIs(false));

    await owner.withoutTenant('migration-status', async (q) => {
      const orgs = await q.query<{ slug: string; id: string }>(
        `INSERT INTO organizations (slug, name)
         VALUES ('perms-a','Perms A'), ('perms-b','Perms B')
         ON CONFLICT (slug) DO UPDATE SET name = excluded.name
         RETURNING slug, id::text AS id`,
      );
      orgA = orgs.find((r) => r.slug === 'perms-a')?.id ?? '';
      orgB = orgs.find((r) => r.slug === 'perms-b')?.id ?? '';

      const people = await q.query<{ username: string; id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1,'ali','member','x'), ($1,'veli','member','x'), ($1,'zeynep','member','x'),
                ($1,'yonetici','member','x'), ($1,'patron','admin','x')
         RETURNING username, id::text AS id`,
        [orgA],
      );
      const idOf = (name: string): string => people.find((r) => r.username === name)?.id ?? '';
      ali = idOf('ali');
      veli = idOf('veli');
      zeynep = idOf('zeynep');
      yonetici = idOf('yonetici');
      patron = idOf('patron');

      const teams = await q.query<{ name: string; id: string }>(
        `INSERT INTO teams (organization_id, name) VALUES ($1,'muhasebe'), ($1,'ajans')
         RETURNING name, id::text AS id`,
        [orgA],
      );
      ekipBir = teams.find((r) => r.name === 'muhasebe')?.id ?? '';
      ekipIki = teams.find((r) => r.name === 'ajans')?.id ?? '';

      await q.query(
        `INSERT INTO team_members (organization_id, team_id, user_id)
         VALUES ($1,$2,$3), ($1,$2,$4), ($1,$5,$4)`,
        [orgA, ekipBir, ali, veli, ekipIki],
      );

      const shares = await q.query<{ name: string; id: string }>(
        `INSERT INTO shares (organization_id, name, dataset)
         VALUES ($1,'perms_a','tank/perms_a')
         RETURNING name, id::text AS id`,
        [orgA],
      );
      shareA = shares[0]?.id ?? '';

      const theirShare = await q.query<{ id: string }>(
        `INSERT INTO shares (organization_id, name, dataset)
         VALUES ($1,'perms_b','tank/perms_b')
         RETURNING id::text AS id`,
        [orgB],
      );
      shareB = theirShare[0]?.id ?? '';

      // A THIRD share in the same tenant that no test ever writes a grant into. It is the only
      // way to exercise `LEGACY_OPEN_SHARE` from here: the fallback is share-wide, and `perms_a`
      // stops being on it the moment the fixture below inserts its first row.
      const virginShare = await q.query<{ id: string }>(
        `INSERT INTO shares (organization_id, name, dataset)
         VALUES ($1,'perms_bakir','tank/perms_bakir')
         RETURNING id::text AS id`,
        [orgA],
      );
      shareC = virginShare[0]?.id ?? '';

      const untouched = await q.query<{ id: string }>(
        `INSERT INTO file_entries (organization_id, share_id, parent_id, kind, name, path)
         VALUES ($1,$2,NULL,'folder','bakir','/bakir')
         RETURNING id::text AS id`,
        [orgA, shareC],
      );
      bakir = untouched[0]?.id ?? '';

      const top = await q.query<{ name: string; id: string }>(
        `INSERT INTO file_entries (organization_id, share_id, parent_id, kind, name, path)
         VALUES ($1,$2,NULL,'folder','projeler','/projeler'),
                ($1,$2,NULL,'folder','bos','/bos')
         RETURNING name, id::text AS id`,
        [orgA, shareA],
      );
      projeler = top.find((r) => r.name === 'projeler')?.id ?? '';
      bos = top.find((r) => r.name === 'bos')?.id ?? '';

      const inner = await q.query<{ name: string; id: string }>(
        `INSERT INTO file_entries (organization_id, share_id, parent_id, kind, name, path)
         VALUES ($1,$2,$3,'folder','gizli','/projeler/gizli'),
                ($1,$2,$3,'folder','ortak','/projeler/ortak'),
                ($1,$2,$3,'file','plan.txt','/projeler/plan.txt')
         RETURNING name, id::text AS id`,
        [orgA, shareA, projeler],
      );
      gizli = inner.find((r) => r.name === 'gizli')?.id ?? '';
      ortak = inner.find((r) => r.name === 'ortak')?.id ?? '';
      belge = inner.find((r) => r.name === 'plan.txt')?.id ?? '';

      const theirs = await q.query<{ id: string }>(
        `INSERT INTO file_entries (organization_id, share_id, parent_id, kind, name, path)
         VALUES ($1,$2,NULL,'folder','onlarin','/onlarin')
         RETURNING id::text AS id`,
        [orgB, shareB],
      );
      theirFolder = theirs[0]?.id ?? '';

      // The grants the assertions below read. Narrowing lives at `gizli`, which carries a SMALLER
      // set for the same team than its parent does — ADR-0021's "istisna: daha dar izin".
      await q.query(
        `INSERT INTO folder_grants (organization_id, share_id, entry_id, team_id, permissions)
         VALUES ($1,$2,NULL,$3,'{list,read}'),
                ($1,$2,$4,$3,'{list,read,download,create,modify}'),
                ($1,$2,$5,$3,'{list}'),
                ($1,$2,$4,$6,'{share}')`,
        [orgA, shareA, ekipBir, projeler, gizli, ekipIki],
      );

      // `yonetici` is an ordinary member who was given `manage` on one folder. That is the whole
      // point of §6.2 separating it from the organisation role, and every write test below uses it
      // rather than an administrator, so an admin shortcut cannot make a failing rule look green.
      await q.query(
        `INSERT INTO folder_grants (organization_id, share_id, entry_id, user_id, permissions)
         VALUES ($1,$2,$3,$4,'{list,read,manage}')`,
        [orgA, shareA, projeler, yonetici],
      );
    });
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        const orgs = [orgA, orgB];
        await q.query(`DELETE FROM job_queue WHERE organization_id = ANY($1)`, [orgs]);
        await q.query(`DELETE FROM folder_grants WHERE organization_id = ANY($1)`, [orgs]);
        // `parent_id` is ON DELETE RESTRICT, so children go first. Deepest ids by hand rather than
        // a recursive delete: this tree is four rows and a clever query here would be the thing
        // that breaks when someone adds a fifth.
        await q.query(`DELETE FROM file_entries WHERE id = ANY($1::uuid[])`, [
          [gizli, ortak, belge],
        ]);
        await q.query(`DELETE FROM file_entries WHERE organization_id = ANY($1)`, [orgs]);
        await q.query(`DELETE FROM shares WHERE organization_id = ANY($1)`, [orgs]);
        await q.query(`DELETE FROM team_members WHERE organization_id = ANY($1)`, [orgs]);
        await q.query(`DELETE FROM teams WHERE organization_id = ANY($1)`, [orgs]);
        await q.query(`DELETE FROM users WHERE organization_id = ANY($1)`, [orgs]);
        await q.query(`DELETE FROM organizations WHERE id = ANY($1)`, [orgs]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  // ─── reading ────────────────────────────────────────────────────────────────

  it('takes the NEAREST ancestor for a principal and ignores the wider grant above it', async () => {
    // `muhasebe` has five permissions on `projeler` and one on `gizli`. If inheritance were a union
    // along the chain, the narrow grant would take nothing away and the only way to narrow would be
    // a deny — the thing ADR-0021 refuses to have.
    const here = await permissions.read(orgA, asUser(ali), { kind: 'entry', id: gizli });
    expect(here.effective).toEqual(['list']);
    expect(here.inheritedFrom).toBe(gizli);

    const above = await permissions.read(orgA, asUser(ali), { kind: 'entry', id: projeler });
    expect(above.effective).toEqual(['list', 'read', 'download', 'create', 'modify']);
    expect(above.inheritedFrom).toBe(projeler);
  });

  it('unions the sets of two teams, so a second membership never takes anything away', async () => {
    // `veli` is in both teams. `ajans` grants only `share` on `projeler`; if the narrower team
    // clipped the wider one the answer would depend on the order memberships happen to be listed.
    const view = await permissions.read(orgA, asUser(veli), { kind: 'entry', id: projeler });
    expect(view.effective).toEqual(['list', 'read', 'download', 'create', 'modify', 'share']);

    const alone = await permissions.read(orgA, asUser(ali), { kind: 'entry', id: projeler });
    expect(alone.effective).not.toContain('share');
  });

  it('inherits a share-root grant into a folder that carries none of its own', async () => {
    // `entry_id IS NULL` is a node like any other, which is why there is no second table and no
    // second walk. `inheritedFrom` names the SHARE, so an administrator can find the row.
    const view = await permissions.read(orgA, asUser(ali), { kind: 'entry', id: bos });
    expect(view.effective).toEqual(['list', 'read']);
    expect(view.inheritedFrom).toBe(shareA);

    const root = await permissions.read(orgA, asUser(ali), { kind: 'share', id: shareA });
    expect(root.effective).toEqual(['list', 'read']);
  });

  it('conceals a folder from someone with no grant and no team, rather than describing it', async () => {
    // This used to answer 200 with an empty `effective`, which made the one endpoint whose job is
    // to explain access the only one that would confirm an id: `GET /files/{id}` on the same node
    // is 404 and the row is absent from every listing, while a uuid that names nothing at all is
    // also 404. A member could tell "exists in my tenant, hidden from me" from "does not exist".
    await expect(
      permissions.read(orgA, asUser(zeynep), { kind: 'entry', id: projeler }),
    ).rejects.toBeInstanceOf(NodeNotFoundError);

    // The SHARE ROOT is not concealed, for the same reason `requirePermission` does not conceal it:
    // it is named by no entry id and hidden from nobody. The answer is honest and empty.
    const root = await permissions.read(orgA, asUser(zeynep), { kind: 'share', id: shareA });
    expect(root.effective).toEqual([]);
    expect(root.canManage).toBe(false);
  });

  it('separates "you cannot see this" from "you cannot manage this" on the write path', async () => {
    // `zeynep` has no grant anywhere in `perms_a`: 404, because a 403 would confirm the folder is
    // there. `ali` can list it and cannot manage it: 403, which is the refusal
    // `NotManageableError`'s own docstring describes — "the caller has already been told the node
    // exists". Until this pair existed, both answered 403 and the first one was a leak.
    await expect(
      permissions.write(orgA, asUser(zeynep), { kind: 'entry', id: projeler }, [], true),
    ).rejects.toBeInstanceOf(NodeNotFoundError);

    await expect(
      permissions.write(
        orgA,
        asUser(ali),
        { kind: 'entry', id: projeler },
        [{ userId: ali, teamId: null, permissions: ['read'] }],
        true,
      ),
    ).rejects.toBeInstanceOf(NotManageableError);
  });

  // ─── the pre-§6.2 fallback, read through THIS endpoint ──────────────────────
  //
  // `FilesService` has always applied `LEGACY_OPEN_SHARE`, so on an appliance where nobody has
  // written a grant yet `GET /files` serves seven permissions per row. This service did not, and
  // answered the same question about the same node with an empty set — the two realities §6.2
  // exists to prevent, in the worst place for them, since this is the endpoint the permissions
  // panel reads. These tests are what has to be deleted with the constant.

  it('reports the pre-§6.2 seven in a share that carries no grant at all', async () => {
    const view = await permissions.read(orgA, asUser(zeynep), { kind: 'entry', id: bakir });
    expect(view.effective).toEqual([
      'list',
      'read',
      'download',
      'create',
      'modify',
      'move',
      'delete',
    ]);
    // No node granted this, so there is none to name: sending an administrator to `bakir` to
    // delete a row that was never written is worse than saying nothing.
    expect(view.inheritedFrom).toBeNull();
    // And `manage` is still not in it, so the first grant of this share remains an
    // administrator's to write (ADR-0021 §5).
    expect(view.effective).not.toContain('manage');
    expect(view.canManage).toBe(false);
  });

  it('drops the fallback for the whole share the moment one grant exists anywhere in it', async () => {
    // `perms_a` has grants — none of them naming zeynep, and none of them on `bos`. The walk is
    // therefore in charge there and she cannot even see the folder, while `bakir` in the ungranted
    // share still reports seven in the same breath.
    await expect(
      permissions.read(orgA, asUser(zeynep), { kind: 'entry', id: bos }),
    ).rejects.toBeInstanceOf(NodeNotFoundError);

    const ungoverned = await permissions.read(orgA, asUser(zeynep), { kind: 'entry', id: bakir });
    expect(ungoverned.effective).toHaveLength(7);
  });

  it('hands an administrator everything, and does not blame a node for it', async () => {
    const view = await permissions.read(orgA, asAdmin(patron), { kind: 'entry', id: gizli });
    expect(view.effective).toHaveLength(11);
    expect(view.canManage).toBe(true);
    // Not `gizli`: an administrator's set comes from §6.1, and naming a node here would send them
    // to delete a row that is not what is granting them access.
    expect(view.inheritedFrom).toBeNull();
  });

  it('shows the rows at this node only to someone who may manage them', async () => {
    // Who can reach what is information in its own right, so `grants` is empty rather than
    // filtered for a caller without `manage` — §6.2 and the contract both say so.
    const asAli = await permissions.read(orgA, asUser(ali), { kind: 'entry', id: projeler });
    expect(asAli.canManage).toBe(false);
    expect(asAli.grants).toEqual([]);

    const asManager = await permissions.read(orgA, asUser(yonetici), {
      kind: 'entry',
      id: projeler,
    });
    expect(asManager.canManage).toBe(true);
    expect(asManager.grants).toHaveLength(3);
    expect(asManager.grants.map((g) => g.displayName).sort()).toEqual([
      'ajans',
      'muhasebe',
      'yonetici',
    ]);
  });

  it("answers 'no such folder' for another tenant's node, not 'forbidden'", async () => {
    // RLS makes the two indistinguishable to the query, and they have to stay indistinguishable in
    // the answer: a 403 here would confirm the id exists in someone else's organisation.
    await expect(
      permissions.read(orgA, asUser(ali), { kind: 'entry', id: theirFolder }),
    ).rejects.toBeInstanceOf(NodeNotFoundError);
    await expect(
      permissions.read(orgA, asUser(ali), { kind: 'share', id: shareB }),
    ).rejects.toBeInstanceOf(NodeNotFoundError);
  });

  // ─── writing ────────────────────────────────────────────────────────────────

  it('refuses a write from someone who can modify the folder but not manage it', async () => {
    // `ali` has `modify` on `projeler` and no `manage`. If writing were allowed to whoever can
    // write files, the authorization model could rewrite itself.
    await expect(
      permissions.write(
        orgA,
        asUser(ali),
        { kind: 'entry', id: projeler },
        [{ userId: ali, teamId: null, permissions: ['list', 'read', 'manage'] }],
        false,
      ),
    ).rejects.toBeInstanceOf(NotManageableError);

    expect(await grantsAt(projeler)).toBe(3);
  });

  it('lets a member with manage write, and inherits manage down the tree', async () => {
    // `yonetici`'s `manage` is on `projeler`; `ortak` carries no grant, so the nearest ancestor
    // rule is what admits this write. Nothing about the organisation role is involved.
    const result = await permissions.write(
      orgA,
      asUser(yonetici),
      { kind: 'entry', id: ortak },
      [{ userId: null, teamId: ekipIki, permissions: ['list', 'read', 'download'] }],
      false,
    );

    expect(result.applied).toBe(true);
    expect(await grantsAt(ortak)).toBe(1);

    const veliSees = await permissions.read(orgA, asUser(veli), { kind: 'entry', id: ortak });
    expect(veliSees.effective).toEqual(['list', 'read', 'download', 'create', 'modify']);
  });

  it('writes nothing at all on a dry run, and still says who would be affected', async () => {
    const before = await grantsAt(gizli);

    const preview = await permissions.write(
      orgA,
      asUser(yonetici),
      { kind: 'entry', id: gizli },
      [{ userId: null, teamId: ekipBir, permissions: ['list', 'read', 'download'] }],
      true,
    );

    expect(preview.applied).toBe(false);
    expect(preview.applyingJobId).toBeNull();
    expect(await grantsAt(gizli)).toBe(before);

    // `ali` and `veli` are both in `muhasebe` and both would gain; `patron` is an administrator and
    // must appear in neither list, because §6.1 already gives them everything.
    const gaining = preview.impact.usersGaining.map((u) => u.username).sort();
    expect(gaining).toEqual(['ali', 'veli']);
    expect(preview.impact.usersLosing).toEqual([]);
    expect(preview.impact.foldersAffected).toBeGreaterThanOrEqual(1);

    const alice = preview.impact.usersGaining.find((u) => u.username === 'ali');
    expect(alice?.before).toEqual(['list']);
    expect(alice?.after).toEqual(['list', 'read', 'download']);

    // And the read still answers with the OLD set, which is the property a preview has to have.
    const after = await permissions.read(orgA, asUser(ali), { kind: 'entry', id: gizli });
    expect(after.effective).toEqual(['list']);
  });

  it('reports who LOSES access when a grant is removed, separately from who gains', async () => {
    // An empty body removes every explicit row at this node and puts inheritance back in force —
    // the share root's `{list,read}` — so `muhasebe` drops three permissions on `projeler`.
    const preview = await permissions.write(
      orgA,
      asAdmin(patron),
      { kind: 'entry', id: projeler },
      [],
      true,
    );

    // `yonetici` is in the list too, and that is the point of showing it: the body that empties
    // this node also removes the row that was giving them `manage`, so the person clicking is
    // about to remove their own authority over the folder.
    const losing = preview.impact.usersLosing.map((u) => u.username).sort();
    expect(losing).toEqual(['ali', 'veli', 'yonetici']);

    const alice = preview.impact.usersLosing.find((u) => u.username === 'ali');
    expect(alice?.before).toEqual(['list', 'read', 'download', 'create', 'modify']);
    expect(alice?.after).toEqual(['list', 'read']);

    // The subtree, not the row count: `ortak` and the file below `projeler` inherit from it, so the
    // radius of this one click is wider than the single row it would delete.
    expect(preview.impact.foldersAffected).toBeGreaterThan(1);

    // `gizli` carries its own `muhasebe` row, so it is NOT affected — which is the whole reason the
    // count is computed by resolving rather than by counting descendants.
    expect(await grantsAt(projeler)).toBe(3);
  });

  it('queues the POSIX re-application, and says so plainly when it cannot', async () => {
    const applied = await permissions.write(
      orgA,
      asAdmin(patron),
      { kind: 'share', id: shareA },
      [{ userId: null, teamId: ekipBir, permissions: ['list', 'read'] }],
      false,
    );
    expect(applied.applyingJobId).not.toBeNull();

    const queued = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ kind: string; payload: { shareId: string; entryId: string | null } }>(
        `SELECT kind, payload FROM job_queue WHERE id = $1`,
        [applied.applyingJobId],
      ),
    );
    expect(queued[0]?.kind).toBe(APPLY_ACL_KIND);
    expect(queued[0]?.payload.shareId).toBe(shareA);
    expect(queued[0]?.payload.entryId).toBeNull();

    // With the agent down the row is still written and the null says the filesystem is behind.
    // Hiding that would mean the interface reporting a permission the kernel has not been told
    // about — ADR-0021's accepted debt, made visible rather than papered over.
    const stale = await offline.write(
      orgA,
      asAdmin(patron),
      { kind: 'share', id: shareA },
      [{ userId: null, teamId: ekipBir, permissions: ['list', 'read'] }],
      false,
    );
    expect(stale.applied).toBe(true);
    expect(stale.applyingJobId).toBeNull();
    expect(await grantsAt(null)).toBe(1);
  });

  it('refuses a grant on a file, which no default ACL could ever carry', async () => {
    await expect(
      permissions.write(
        orgA,
        asAdmin(patron),
        { kind: 'entry', id: belge },
        [{ userId: null, teamId: ekipBir, permissions: ['read'] }],
        false,
      ),
    ).rejects.toBeInstanceOf(NotAFolderError);
  });

  it("refuses a grant naming another tenant's user or team", async () => {
    const theirUser = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1,'yabanci','member','x') RETURNING id::text AS id`,
        [orgB],
      ),
    );
    const outsider = theirUser[0]?.id ?? '';

    await expect(
      permissions.write(
        orgA,
        asAdmin(patron),
        { kind: 'entry', id: ortak },
        [{ userId: outsider, teamId: null, permissions: ['read'] }],
        false,
      ),
    ).rejects.toBeInstanceOf(UnknownPrincipalError);
  });

  it("does not write into another tenant's tree even for an administrator here", async () => {
    await expect(
      permissions.write(orgA, asAdmin(patron), { kind: 'entry', id: theirFolder }, [], false),
    ).rejects.toBeInstanceOf(NodeNotFoundError);
  });

  // ─── the fallback boundary ──────────────────────────────────────────────────
  //
  // These run LAST and they run against `perms_bakir`, because they are the two tests that put a
  // grant into it: the fallback is share-wide, so the moment one of them writes, the tests above
  // that read `bakir` as an ungoverned share stop describing the same world.

  it('previews the first grant of a share as the loss it actually is', async () => {
    // `before` here is not "nobody has anything". While a share is ungoverned every member holds
    // the pre-§6.2 seven everywhere in it, and writing the first grant takes that away from
    // everyone the grant does not name — across the WHOLE share, including folders the target is
    // not an ancestor of. A preview built from grant rows alone reports `usersLosing: []` on the
    // single most disruptive click the appliance has, which is the opposite of what §6.2 asks a
    // dry-run to do.
    const preview = await permissions.write(
      orgA,
      asAdmin(patron),
      { kind: 'entry', id: bakir },
      [{ userId: null, teamId: ekipBir, permissions: ['list', 'read'] }],
      true,
    );

    expect(preview.applied).toBe(false);
    expect(preview.impact.usersGaining).toEqual([]);
    // Everyone who is not an administrator, including the two who ARE named by the grant: they had
    // seven and end with two, so they lose five and gain nothing.
    expect(preview.impact.usersLosing.map((u) => u.username).sort()).toEqual([
      'ali',
      'veli',
      'yonetici',
      'zeynep',
    ]);
    const losingAli = preview.impact.usersLosing.find((u) => u.username === 'ali');
    expect(losingAli?.before).toHaveLength(7);
    expect(losingAli?.after).toEqual(['list', 'read']);

    // The share root is in the radius too, although the grant is written a level below it: the
    // fallback hangs off the root and the change removes it from there as well.
    expect(preview.impact.foldersAffected).toBeGreaterThanOrEqual(2);
  });

  it('will not let the last grant of a share be removed, because that OPENS the share', async () => {
    const first = await permissions.write(
      orgA,
      asAdmin(patron),
      { kind: 'entry', id: bakir },
      [{ userId: null, teamId: ekipBir, permissions: ['list', 'read'] }],
      false,
    );
    expect(first.applied).toBe(true);

    // `LEGACY_OPEN_SHARE`'s docstring promises the fallback is gone for good once any grant exists.
    // Nothing persisted that: `shareIsGoverned` is an EXISTS query re-asked on every request, so an
    // empty body at the only node carrying rows used to delete them and hand the whole share back
    // to every member of the tenant — reachable by anyone the root grant gave `manage` to, and by
    // an administrator trying to lock the share DOWN.
    await expect(
      permissions.write(orgA, asAdmin(patron), { kind: 'entry', id: bakir }, [], false),
    ).rejects.toBeInstanceOf(LastGrantError);
    // Refused on the preview as well: a dry-run of a write that cannot happen is worse than the
    // refusal, because the caller would plan around it.
    await expect(
      permissions.write(orgA, asAdmin(patron), { kind: 'entry', id: bakir }, [], true),
    ).rejects.toBeInstanceOf(LastGrantError);

    // The row is still there, and — the property that matters — the share is still governed, so
    // `zeynep` still cannot see the folder that was open to her a moment ago.
    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ n: string }>(`SELECT count(*)::text AS n FROM folder_grants WHERE share_id = $1`, [
        shareC,
      ]),
    );
    expect(Number(rows[0]?.n ?? '0')).toBe(1);
    await expect(
      permissions.read(orgA, asUser(zeynep), { kind: 'entry', id: bakir }),
    ).rejects.toBeInstanceOf(NodeNotFoundError);

    // Narrowing to nobody is still expressible — it just has to be said out loud, with a root grant
    // that names somebody rather than with an empty list.
    const closed = await permissions.write(
      orgA,
      asAdmin(patron),
      { kind: 'share', id: shareC },
      [{ userId: patron, teamId: null, permissions: ['list', 'read', 'manage'] }],
      false,
    );
    expect(closed.applied).toBe(true);
    // And with a second node carrying rows, emptying the first is an ordinary write again.
    const emptied = await permissions.write(
      orgA,
      asAdmin(patron),
      { kind: 'entry', id: bakir },
      [],
      false,
    );
    expect(emptied.applied).toBe(true);
  });
});
