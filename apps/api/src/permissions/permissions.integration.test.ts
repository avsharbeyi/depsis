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
  // orgA's second share, carrying exactly ONE root grant and nothing else — the shape migration
  // 0016 leaves behind for a share that predates §6.2. It used to be the share with no grants at
  // all, which is a state the appliance can no longer be in.
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

      // A THIRD share in the same tenant, governed by a single root grant and carrying no other
      // rule. Two things need it: a chain exactly one node long, and a share where the tests below
      // can write the SECOND grant without disturbing `perms_a`'s carefully layered fixture.
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

      // `perms_bakir`'s single root grant. Seven permissions naming `zeynep`: the same set
      // migration 0016 writes when it backfills a share nobody had granted, and `zeynep` because
      // she is the member `perms_a` never names — so what she can reach is decided by this share
      // alone, with nothing bleeding in from the fixture above.
      await q.query(
        `INSERT INTO folder_grants (organization_id, share_id, entry_id, user_id, permissions)
         VALUES ($1,$2,NULL,$3,'{list,read,download,create,modify,move,delete}')`,
        [orgA, shareC, zeynep],
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

  // ─── one root grant, inherited all the way down ─────────────────────────────
  //
  // These two used to measure `LEGACY_OPEN_SHARE`: a share with no grant rows at all served every
  // member the pre-§6.2 seven, and this endpoint had to agree with `GET /files` about that or the
  // permissions panel would be the one screen in the product that got access wrong. The exception
  // is gone and `perms_bakir` now carries the root grant migration 0016 would have written for it,
  // so what is left to measure is the ordinary rule — and the same seven come out, which is the
  // point of the backfill.

  it('reports a root grant at every node below it, and names the root as the source', async () => {
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
    // The share root, and this is the half the fallback could never answer: there IS a row now, so
    // an administrator asking "where does this come from" can be sent to the node that grants it.
    // It used to be null because nothing had granted anything.
    expect(view.inheritedFrom).toBe(shareC);
    // `manage` is not in the backfilled set, so authority over a share's permissions still starts
    // with an administrator rather than arriving with the data (ADR-0021 §5).
    expect(view.effective).not.toContain('manage');
    expect(view.canManage).toBe(false);
  });

  it('decides each chain on its own: a grant in one share reaches nothing in another', async () => {
    // `zeynep`'s root grant is in `perms_bakir` and nothing in `perms_a` names her, so `bos` is
    // invisible to her while `bakir` reports seven in the same breath. Under the fallback these
    // two answers came from different RULES — one from the walk, one from a share-wide exception —
    // and the pair is kept because it is now the same rule applied twice, which is the property
    // worth having a test for.
    await expect(
      permissions.read(orgA, asUser(zeynep), { kind: 'entry', id: bos }),
    ).rejects.toBeInstanceOf(NodeNotFoundError);

    const granted = await permissions.read(orgA, asUser(zeynep), { kind: 'entry', id: bakir });
    expect(granted.effective).toHaveLength(7);
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

  // ─── writes into `perms_bakir` ──────────────────────────────────────────────
  //
  // These run LAST and against `perms_bakir` because they are the tests that add a SECOND grant to
  // it, and the two above describe it with exactly one.

  it('previews a second grant as a gain for the people it names and a loss for nobody', async () => {
    // This test used to assert the opposite, and the difference is the whole shape of the change.
    // While `LEGACY_OPEN_SHARE` existed, `before` in an ungoverned share was not "nobody has
    // anything" — every member held the pre-§6.2 seven everywhere in it, so writing the FIRST
    // grant silently took that away from everyone the grant did not name, across folders the
    // target was not even an ancestor of. The preview had to be seeded with a synthetic root grant
    // to see it, or it reported `usersLosing: []` on the most disruptive click in the appliance.
    //
    // There is no such click any more. `perms_bakir` is governed by its root grant, this write
    // adds a narrower one below it for a team, and the arithmetic is the ordinary kind: the team's
    // members gain what they did not have, and nobody's existing grant is touched.
    const preview = await permissions.write(
      orgA,
      asAdmin(patron),
      { kind: 'entry', id: bakir },
      [{ userId: null, teamId: ekipBir, permissions: ['list', 'read'] }],
      true,
    );

    expect(preview.applied).toBe(false);
    // `ali` and `veli` are `muhasebe`; neither is named anywhere in this share today.
    expect(preview.impact.usersGaining.map((u) => u.username).sort()).toEqual(['ali', 'veli']);
    const gainingAli = preview.impact.usersGaining.find((u) => u.username === 'ali');
    expect(gainingAli?.before).toEqual([]);
    expect(gainingAli?.after).toEqual(['list', 'read']);

    // `zeynep` holds the root grant's seven and this write does not touch the root, so she keeps
    // them: a narrower grant below an ancestor narrows it for the principals it NAMES, and nearest
    // ancestor is resolved per principal (ADR-0021).
    expect(preview.impact.usersLosing).toEqual([]);

    // The radius is the subtree the write names, and no longer the whole share: `includeShareRoot`
    // went with the fallback, because a write that reaches past its own subtree no longer exists.
    expect(preview.impact.foldersAffected).toBeGreaterThanOrEqual(1);
  });

  it('will not let the last grant of a share be removed', async () => {
    // THE INVARIANT: every share holds at least one grant, always. `perms_bakir` holds exactly
    // one — its root — so emptying that node is the write this refuses.
    //
    // It used to be refused for the opposite reason, and the history is why the guard is still
    // here after the reason changed. While `LEGACY_OPEN_SHARE` existed, deleting a share's last
    // grant did not close the share, it OPENED it: the fallback was an EXISTS query re-asked on
    // every request, so the share fell back to giving every member of the tenant seven
    // permissions on everything. That was reachable by anyone the root grant had given `manage`
    // to. Now an empty share would instead be invisible to everyone but an administrator — the
    // safe direction, and still not a state to arrive in by clicking save on an empty list.
    await expect(
      permissions.write(orgA, asAdmin(patron), { kind: 'share', id: shareC }, [], false),
    ).rejects.toBeInstanceOf(LastGrantError);
    // Refused on the preview as well: a dry-run of a write that cannot happen is worse than the
    // refusal, because the caller would plan around it.
    await expect(
      permissions.write(orgA, asAdmin(patron), { kind: 'share', id: shareC }, [], true),
    ).rejects.toBeInstanceOf(LastGrantError);

    // The row is still there and still doing its job.
    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ n: string }>(`SELECT count(*)::text AS n FROM folder_grants WHERE share_id = $1`, [
        shareC,
      ]),
    );
    expect(Number(rows[0]?.n ?? '0')).toBe(1);
    expect(
      (await permissions.read(orgA, asUser(zeynep), { kind: 'entry', id: bakir })).effective,
    ).toHaveLength(7);

    // Closing a share to everyone is still expressible — it just has to be said out loud, with a
    // root grant naming somebody rather than with an empty list.
    const closed = await permissions.write(
      orgA,
      asAdmin(patron),
      { kind: 'share', id: shareC },
      [{ userId: patron, teamId: null, permissions: ['list', 'read', 'manage'] }],
      false,
    );
    expect(closed.applied).toBe(true);
    // And `zeynep`, who is no longer named, loses the share entirely. Said here rather than
    // assumed, because "narrowing works" and "narrowing is what just happened" are different
    // claims and only the second one survives a bug in the DELETE above.
    await expect(
      permissions.read(orgA, asUser(zeynep), { kind: 'entry', id: bakir }),
    ).rejects.toBeInstanceOf(NodeNotFoundError);

    // With a second node carrying rows, emptying one of them is an ordinary write again: the guard
    // is about the SHARE having a rule, not about any particular node keeping one.
    const second = await permissions.write(
      orgA,
      asAdmin(patron),
      { kind: 'entry', id: bakir },
      [{ userId: null, teamId: ekipBir, permissions: ['list', 'read'] }],
      false,
    );
    expect(second.applied).toBe(true);
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
