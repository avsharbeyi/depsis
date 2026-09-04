import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentService } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import { IdentitySyncService } from '../identity/identity-sync.service.js';
import {
  EveryoneTeamIsFixedError,
  LastGrantInShareError,
  TeamMemberNotFoundError,
  TeamNameTakenError,
  TeamNotFoundError,
  TeamsService,
} from './teams.service.js';

/**
 * Teams, membership, and the dry-run, against a real PostgreSQL.
 *
 * Three of the things asserted here cannot be settled by a fake, and they are the reason this file
 * is longer than the service:
 *
 *   * **Tenant isolation** is row level security, which is a property of the connection and the
 *     policy — a stub returns whatever it was told to. The specific hole tested below is real and
 *     was reachable: `team_members.user_id` has a device-wide foreign key and the table's policy
 *     only checks `organization_id`, so nothing in the SCHEMA stops one tenant enrolling another
 *     tenant's account into their team.
 *   * **gid allocation** is `MAX + 1` over two tables behind an advisory lock. Serialised, the
 *     broken version passes; the test has to overlap two transactions for real.
 *   * **The dry-run** is the whole inheritance rule of ADR-0021 run over a tree, and its interesting
 *     cases — a narrow grant on a subfolder hiding a wide one above it, and a second team that
 *     keeps contributing after the first is gone — only exist once there are rows in
 *     `file_entries` and `folder_grants`.
 *
 * Skipped unless `DEPSIS_TEST_DATABASE_URL` points at a migrated database.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];

const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

describeDb('teams and membership, against a real PostgreSQL', () => {
  let db: DbService;
  let owner: DbService;
  let teams: TeamsService;

  let orgA = '';
  let orgB = '';
  // Three accounts in A: the founder, an ordinary member, and one who will run a team.
  let founderA = '';
  let memberA = '';
  let leadA = '';
  let userB = '';

  // A share in A. Each impact test builds its OWN two-level folder tree inside it: the previews
  // below assert exact folder counts, and a grant left behind by an earlier test would be counted
  // by a later one — a test that passes or fails depending on what ran before it.
  let shareA = '';
  let folderSeq = 0;

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);
    // The agent, as far as this service is concerned: one question, asked once per bulk change.
    // Available, so that the POSIX re-application these operations owe actually lands on the queue
    // and the tests below can read it back.
    const agent = { isAvailable: () => true } as unknown as AgentService;
    teams = new TeamsService(
      db,
      new JobsService(db),
      agent,
      // A real one. Membership changes enqueue an `identity.sync` now, and a stub that swallowed
      // it would let the enqueue silently stop happening — the `putMember` gap this closes was
      // invisible for exactly that reason. Its own agent is never reached from `enqueue`, which is
      // a database INSERT.
      new IdentitySyncService(db, agent, null, new JobsService(db)),
    );

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name)
         VALUES ('teams-a','Teams A'), ('teams-b','Teams B')
         ON CONFLICT (slug) DO NOTHING`,
      );
      const orgs = await q.query<{ slug: string; id: string }>(
        `SELECT slug, id::text AS id FROM organizations WHERE slug IN ('teams-a','teams-b')`,
      );
      orgA = orgs.find((r) => r.slug === 'teams-a')?.id ?? '';
      orgB = orgs.find((r) => r.slug === 'teams-b')?.id ?? '';

      const seeded = await q.query<{ id: string; username: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1,'kurucu','admin','x'), ($1,'uye','member','x'), ($1,'lider','member','x')
         RETURNING id::text AS id, username`,
        [orgA],
      );
      founderA = seeded.find((r) => r.username === 'kurucu')?.id ?? '';
      memberA = seeded.find((r) => r.username === 'uye')?.id ?? '';
      leadA = seeded.find((r) => r.username === 'lider')?.id ?? '';

      const theirs = await q.query<{ id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1,'onlarin','member','x')
         RETURNING id::text AS id`,
        [orgB],
      );
      userB = theirs[0]?.id ?? '';

      const share = await q.query<{ id: string }>(
        `INSERT INTO shares (organization_id, name, dataset)
         VALUES ($1,'ekip','tank/shares/ekip')
         RETURNING id::text AS id`,
        [orgA],
      );
      shareA = share[0]?.id ?? '';
    });

    expect(orgA).not.toBe('');
    expect(orgB).not.toBe('');
    expect(shareA).not.toBe('');
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        const orgs = [orgA, orgB];
        await q.query(`DELETE FROM job_queue WHERE organization_id = ANY($1)`, [orgs]);
        await q.query(`DELETE FROM folder_grants WHERE organization_id = ANY($1)`, [orgs]);
        await q.query(`DELETE FROM team_members WHERE organization_id = ANY($1)`, [orgs]);
        await q.query(`DELETE FROM teams WHERE organization_id = ANY($1)`, [orgs]);
        // Children before parents: `file_entries.parent_id` is ON DELETE RESTRICT on purpose.
        await q.query(
          `DELETE FROM file_entries WHERE organization_id = ANY($1) AND parent_id IS NOT NULL`,
          [orgs],
        );
        await q.query(`DELETE FROM file_entries WHERE organization_id = ANY($1)`, [orgs]);
        await q.query(`DELETE FROM shares WHERE organization_id = ANY($1)`, [orgs]);
        await q.query(`DELETE FROM users WHERE organization_id = ANY($1)`, [orgs]);
        await q.query(`DELETE FROM organizations WHERE id = ANY($1)`, [orgs]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  it('creates a team with a POSIX gid in the transaction that creates it', async () => {
    // A team without a gid is a team no ACL entry can name (ADR-0004: entries are given to groups),
    // so there must be no window in which the row is committed and the identity is not.
    const created = await teams.create(orgA, 'Muhasebe');
    expect(created.member_count).toBe(0);
    expect(created.posix_gid).not.toBeNull();
    expect(created.posix_gid).toBeGreaterThanOrEqual(300000);
    expect(created.posix_gid).toBeLessThanOrEqual(399999);
  });

  it('gives two teams created AT THE SAME MOMENT two different gids', async () => {
    // `allocate_posix_id` is `MAX + 1` over `users.posix_uid` and `teams.posix_gid` and holds
    // nothing while it reads, so two overlapping transactions see the same maximum. Two teams with
    // one gid means an ACL entry written for one grants the other — the filesystem knows only
    // numbers. `Promise.all`, not a loop: the pool gives each call its own connection, so the two
    // transactions genuinely overlap. Serialised, this passes against the broken version.
    const [first, second] = await Promise.all([
      teams.create(orgA, 'Esz-Bir'),
      teams.create(orgA, 'Esz-Iki'),
    ]);
    expect(first.posix_gid).not.toBeNull();
    expect(second.posix_gid).not.toBeNull();
    expect(first.posix_gid).not.toBe(second.posix_gid);
  });

  it('does not hand a team the gid of an account created beside it', async () => {
    // One counter serves both tables, so a uid and a gid must never collide either.
    const team = await teams.create(orgA, 'Cakisma');
    const uids = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ posix_uid: number }>(`SELECT posix_uid FROM users WHERE posix_uid = $1`, [
        team.posix_gid,
      ]),
    );
    expect(uids).toHaveLength(0);
  });

  it('refuses a second team whose name folds onto the first', async () => {
    await teams.create(orgA, 'Satis');
    // `fold_identity` decides collisions — case and the Turkish i-family — and the API has to
    // report its decision as a 409 rather than a 500.
    await expect(teams.create(orgA, 'SATIS')).rejects.toBeInstanceOf(TeamNameTakenError);
  });

  it('lets the same team name exist in another organization', async () => {
    await expect(teams.create(orgB, 'Muhasebe')).resolves.toBeTruthy();
  });

  it("does not let one tenant read, rename or delete another tenant's team", async () => {
    const theirs = await teams.create(orgB, 'Onlarin');
    await expect(teams.find(orgA, theirs.id)).rejects.toBeInstanceOf(TeamNotFoundError);
    await expect(teams.rename(orgA, theirs.id, 'Bizim')).rejects.toBeInstanceOf(TeamNotFoundError);
    await expect(teams.remove(orgA, theirs.id, { dryRun: false })).rejects.toBeInstanceOf(
      TeamNotFoundError,
    );
    await expect(teams.members(orgA, theirs.id)).rejects.toBeInstanceOf(TeamNotFoundError);

    // And it really is untouched, read back through its own tenant.
    expect((await teams.find(orgB, theirs.id)).name).toBe('Onlarin');
  });

  it("refuses to enrol another tenant's account, which the schema alone does not stop", async () => {
    // The hole: `team_members.user_id` references `public.users` device-wide, and the row's RLS
    // policy only checks `organization_id`. Both would accept this insert. What refuses it is the
    // service looking the account up under the tenant context first — and 404, not 403, because a
    // caller must not learn that the id names a real account somewhere else.
    const team = await teams.create(orgA, 'Sizinti');
    await expect(teams.putMember(orgA, team.id, userB, false)).rejects.toBeInstanceOf(
      TeamMemberNotFoundError,
    );

    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query(`SELECT 1 FROM team_members WHERE team_id = $1`, [team.id]),
    );
    expect(rows).toHaveLength(0);
  });

  it('adds the same member twice without complaining, and updates the flag', async () => {
    // PUT, not POST: asking for a state that already holds is not an error (§ the contract's own
    // wording). A 409 on the second click would make the interface either remember what it sent or
    // swallow a conflict it cannot tell from a real one.
    const team = await teams.create(orgA, 'Tekrarli');
    const first = await teams.putMember(orgA, team.id, memberA, false);
    expect(first.team_admin).toBe(false);
    expect(first.username).toBe('uye');

    const again = await teams.putMember(orgA, team.id, memberA, true);
    expect(again.team_admin).toBe(true);
    expect(again.user_id).toBe(memberA);

    expect(await teams.members(orgA, team.id)).toHaveLength(1);
    expect((await teams.find(orgA, team.id)).member_count).toBe(1);
  });

  it('tells a team administrator apart from an organization administrator', async () => {
    // Two different grants of authority (§6.1). The service answers only the narrow question — is
    // this person an administrator OF THIS TEAM — so that the controller has to ask the wide one
    // separately and a test can fail on either alone.
    const team = await teams.create(orgA, 'Yetkili');
    await teams.putMember(orgA, team.id, leadA, true);
    await teams.putMember(orgA, team.id, memberA, false);

    expect(await teams.isTeamAdmin(orgA, team.id, leadA)).toBe(true);
    // An ordinary member of the team is not one.
    expect(await teams.isTeamAdmin(orgA, team.id, memberA)).toBe(false);
    // Neither is the organisation's administrator, who is not in the team at all. That the
    // controller lets them through anyway is the controller's decision, not this one's — and
    // conflating the two here is what would make the endpoint impossible to reason about.
    expect(await teams.isTeamAdmin(orgA, team.id, founderA)).toBe(false);
    // A team administrator of ONE team is nothing in another.
    const other = await teams.create(orgA, 'Baska');
    expect(await teams.isTeamAdmin(orgA, other.id, leadA)).toBe(false);
  });

  it('reports the gid as null for a team that predates the allocator, without hiding it', async () => {
    // Every team this code creates has a gid; a team restored from a backup taken before migration
    // 0015 does not, and null means "not reflected on the filesystem yet" — a permission granted to
    // it is visible on the web and absent over SMB. The field is in the response precisely so the
    // interface can say so.
    const seeded = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ id: string }>(
        `INSERT INTO teams (organization_id, name) VALUES ($1,'Eski') RETURNING id::text AS id`,
        [orgA],
      ),
    );
    const id = seeded[0]?.id ?? '';
    expect((await teams.find(orgA, id)).posix_gid).toBeNull();
  });

  it('previews a member removal without performing it, and the numbers survive repetition', async () => {
    // The tree: the top folder grants the team read+list, the subfolder grants it list only. Under
    // ADR-0021 the NEAREST grant for a principal wins, so a member sees {read,list} above and
    // {list} below — that narrowing is what stands in for the deny this model refuses to have.
    // Taking them out of the team costs them both.
    const { top, sub } = await makeFolders();
    const team = await teams.create(orgA, 'Onizleme');
    await teams.putMember(orgA, team.id, memberA, false);
    await grantTeam(team.id, top, ['read', 'list']);
    await grantTeam(team.id, sub, ['list']);

    const preview = await teams.removeMember(orgA, team.id, memberA, { dryRun: true });
    expect(preview.foldersAffected).toBe(2);
    expect(preview.usersLosing).toHaveLength(1);
    const losing = preview.usersLosing[0];
    expect(losing?.userId).toBe(memberA);
    expect(losing?.username).toBe('uye');
    // Reported at the SHALLOWEST folder where the set moved, and in the vocabulary's own order —
    // not the order the grants happened to be read in.
    expect(losing?.before).toEqual(['list', 'read']);
    expect(losing?.after).toEqual([]);

    // Nothing was written. A preview that removed the row would be a preview exactly once.
    expect(await teams.members(orgA, team.id)).toHaveLength(1);

    // Asking twice gives the same answer, which is the property a preview is worth nothing without.
    const second = await teams.removeMember(orgA, team.id, memberA, { dryRun: true });
    expect(second).toEqual(preview);
  });

  it('leaves a member what another team and their own grant already gave them', async () => {
    // Two teams reaching the same folder, plus a grant in the person's own name. ADR-0021 unions
    // ACROSS principals precisely so that being in two teams cannot reduce anybody — so removing
    // one team must subtract only what that team alone was contributing.
    const { top, sub } = await makeFolders();
    const going = await teams.create(orgA, 'Giden');
    const staying = await teams.create(orgA, 'Kalan');
    await teams.putMember(orgA, going.id, memberA, false);
    await teams.putMember(orgA, staying.id, memberA, false);
    await grantTeam(going.id, top, ['read', 'list', 'download']);
    await grantTeam(staying.id, top, ['list']);
    await grantUser(memberA, sub, ['list', 'read']);

    const preview = await teams.remove(orgA, going.id, { dryRun: true });
    const losing = preview.usersLosing.find((u) => u.userId === memberA);
    expect(losing?.before).toEqual(['list', 'read', 'download']);
    // `list` survives on the other team's grant; `read` and `download` were the leaving team's.
    expect(losing?.after).toEqual(['list']);
    expect(preview.foldersAffected).toBe(2);
  });

  it('never reports a gain, because removing grants can only subtract', async () => {
    // Worth asserting rather than assuming. The effective set is a union over principals, and
    // deleting a team removes every grant naming it AT ONCE — so no nearer grant is ever uncovered
    // and no principal can end up contributing more. A non-empty `usersGaining` here would mean the
    // resolver had been handed a tree that is not the one the write produces, and the preview would
    // be describing a different change from the real one.
    const { top, sub } = await makeFolders();
    const team = await teams.create(orgA, 'Genisleyen');
    await teams.putMember(orgA, team.id, memberA, false);
    await grantTeam(team.id, top, ['read', 'list', 'download', 'modify']);
    await grantTeam(team.id, sub, ['list']);

    const preview = await teams.remove(orgA, team.id, { dryRun: true });
    expect(preview.usersGaining).toEqual([]);
    expect(preview.usersLosing.find((u) => u.userId === memberA)?.after).toEqual([]);
  });

  it('prices a team deletion over every folder it reaches, not just the nearest', async () => {
    // A team is granted things in more than one place and the radius of the click is all of them.
    const first = await makeFolders();
    const second = await makeFolders();
    const team = await teams.create(orgA, 'Genis');
    await teams.putMember(orgA, team.id, memberA, false);
    await teams.putMember(orgA, team.id, leadA, true);
    await grantTeam(team.id, first.top, ['read', 'list']);
    await grantTeam(team.id, second.sub, ['list']);

    const preview = await teams.remove(orgA, team.id, { dryRun: true });
    // `first.top`, the folder under it that inherits from it, and `second.sub`.
    expect(preview.foldersAffected).toBe(3);
    // Both members, and each with a name the interface can show.
    expect(preview.usersLosing.map((u) => u.username).sort()).toEqual(['lider', 'uye']);
  });

  it('deletes the team, its membership and its grants in one go', async () => {
    const { top } = await makeFolders();
    const team = await teams.create(orgA, 'Gidecek');
    await teams.putMember(orgA, team.id, memberA, false);
    await grantTeam(team.id, top, ['read', 'list']);

    const impact = await teams.remove(orgA, team.id, { dryRun: false });
    expect(impact.usersLosing.map((u) => u.userId)).toContain(memberA);

    await expect(teams.find(orgA, team.id)).rejects.toBeInstanceOf(TeamNotFoundError);
    // `ON DELETE CASCADE` on both, which is why deleting a team is a bulk permission change and
    // needs the dry-run at all.
    const leftovers = await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `SELECT 1 FROM team_members WHERE team_id = $1
          UNION ALL SELECT 1 FROM folder_grants WHERE team_id = $1`,
        [team.id],
      ),
    );
    expect(leftovers).toHaveLength(0);
  });

  it('retires the gid of a deleted team, and never hands it to an account', async () => {
    // BU SÜİTİN EN PAHALI HATASIYDI. `allocate_posix_id` bir sonraki numarayı
    // `MAX(users.posix_uid ∪ teams.posix_gid ∪ retired) + 1` ile buluyor, yani silinen ekip en
    // yüksek numaralıysa gid'i serbest kalıp BİR SONRAKİ HESABA uid olarak veriliyordu. Ajanın
    // eşitlemesi grupları yalnız yaratıyor, silmiyor: `depsis-t-<gid>` kutuda duruyor,
    // `ensure_group` o numarada bir grup görüp "var" diyor, ve ardından gelen
    // `useradd -g depsis-p-<uid>` var olmayan bir grubu isteyip patlıyor — o kiracının BÜTÜN
    // eşitlemeleri kalıcı olarak ölüyor, yani yeni hiçbir hesap SMB'ye giremiyor.
    const team = await teams.create(orgA, 'Emekli');
    const gid = team.posix_gid as number;
    expect(gid).not.toBeNull();

    await teams.remove(orgA, team.id, { dryRun: false });

    const retired = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM retired_posix_ids WHERE id_value = $1`,
        [gid],
      ),
    );
    expect(retired[0]?.n).toBe('1');

    // Ve asıl ölçüm: sıradaki numara o gid DEĞİL. Mezar taşı olmadan burası tam olarak `gid`
    // dönerdi.
    const next = await teams.create(orgA, 'Sonraki');
    expect(next.posix_gid).not.toBe(gid);
    expect(next.posix_gid).toBeGreaterThan(gid);
  });

  it('removes a member for real, and refuses to remove one twice', async () => {
    const team = await teams.create(orgA, 'Cikacak');
    await teams.putMember(orgA, team.id, memberA, false);

    await teams.removeMember(orgA, team.id, memberA, { dryRun: false });
    expect(await teams.members(orgA, team.id)).toHaveLength(0);

    // 404 rather than a silent success: the caller named somebody who is not in this team, and
    // reporting that as done would hide a mistyped id behind a green tick.
    await expect(
      teams.removeMember(orgA, team.id, memberA, { dryRun: false }),
    ).rejects.toBeInstanceOf(TeamMemberNotFoundError);
  });

  it('renames a team without moving its gid', async () => {
    // The gid is what the ACLs on disk already name, so a rename must not disturb it.
    const team = await teams.create(orgA, 'Adsiz');
    const renamed = await teams.rename(orgA, team.id, 'Adli');
    expect(renamed.name).toBe('Adli');
    expect(renamed.posix_gid).toBe(team.posix_gid);

    await expect(teams.rename(orgA, team.id, 'Muhasebe')).rejects.toBeInstanceOf(
      TeamNameTakenError,
    );
  });

  it("will not rename or delete the 'Herkes' team out from under everyone_team()", async () => {
    // `everyone_team()` ekibi ADIYLA arıyor ve bulamazsa YENİSİNİ açıp kiracının bütün
    // kullanıcılarını ona alıyor. Adını değiştirmek ya da silmek, bir sonraki hesap açılışında
    // ikinci (ya da boş) bir "Herkes" doğuruyor: bugünkü paylaşımların kök hibeleri eski ekipte
    // kalıyor ve yeni kullanıcılar "herkes görür" diye açılmış paylaşımları göremiyor. Hiçbir
    // ekran bunu söylemiyor, o yüzden ret ekranda görünen tek şey.
    const everyoneId = await db.withTenant(orgA, async (q) => {
      const rows = await q.query<{ id: string }>(`SELECT public.everyone_team($1)::text AS id`, [
        orgA,
      ]);
      return rows[0]?.id ?? '';
    });
    expect(everyoneId).not.toBe('');

    await expect(teams.rename(orgA, everyoneId, 'Tüm Personel')).rejects.toBeInstanceOf(
      EveryoneTeamIsFixedError,
    );
    // Kuru koşuda da: gerçekleşemeyecek bir silmenin önizlemesi, retten kötü bir cevap.
    await expect(teams.remove(orgA, everyoneId, { dryRun: true })).rejects.toBeInstanceOf(
      EveryoneTeamIsFixedError,
    );
    await expect(teams.remove(orgA, everyoneId, { dryRun: false })).rejects.toBeInstanceOf(
      EveryoneTeamIsFixedError,
    );

    // Aynı kimliğe katlanan bir düzeltme serbest: ekibi kaybettiren şey ad değil, KATLANMIŞ ad.
    const fixed = await teams.rename(orgA, everyoneId, 'herkes');
    expect(fixed.name).toBe('herkes');
    expect(await teams.find(orgA, everyoneId)).toBeTruthy();
  });

  it('queues the POSIX re-application for every share the cascade reaches', async () => {
    // Deleting a team and taking a member out of one are bulk permission changes that used to
    // enqueue NOTHING: the grants went, the kernel was never told, and the folder stayed open over
    // SMB. `PermissionImpact` has no `applyingJobId` to report that with — see the notes — so the
    // only evidence is the row on the queue, which is what this reads.
    const { top } = await makeFolders();
    const team = await teams.create(orgA, 'Uygulanacak');
    await teams.putMember(orgA, team.id, memberA, false);
    await grantTeam(team.id, top, ['read', 'list']);

    const before = await appliesQueued();
    await teams.removeMember(orgA, team.id, memberA, { dryRun: true });
    expect(await appliesQueued()).toBe(before);

    await teams.removeMember(orgA, team.id, memberA, { dryRun: false });
    expect(await appliesQueued()).toBe(before + 1);

    await teams.remove(orgA, team.id, { dryRun: false });
    expect(await appliesQueued()).toBe(before + 2);
  });

  it('refuses to delete a team whose grant is the only one left in a share', async () => {
    // `folder_grants.team_id` is ON DELETE CASCADE, and `LEGACY_OPEN_SHARE` is decided by whether a
    // share has any grant rows at all — so a team deletion can be the thing that puts a share back
    // on the pre-§6.2 default and hands it to every member of the tenant. `PermissionsService.write`
    // refuses that transition through the front door; this is the cascade that walked round it, and
    // it fires while somebody is trying to REMOVE access.
    const lonely = await owner.withoutTenant('migration-status', async (q) => {
      const share = await q.query<{ id: string }>(
        `INSERT INTO shares (organization_id, name, dataset)
         VALUES ($1,'yalniz','tank/shares/yalniz') RETURNING id::text AS id`,
        [orgA],
      );
      return share[0]?.id ?? '';
    });
    const team = await teams.create(orgA, 'Tek-Kural');
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO folder_grants (organization_id, share_id, entry_id, team_id, permissions)
         VALUES ($1,$2,NULL,$3,'{list,read}')`,
        [orgA, lonely, team.id],
      ),
    );

    await expect(teams.remove(orgA, team.id, { dryRun: false })).rejects.toBeInstanceOf(
      LastGrantInShareError,
    );
    // Refused on the preview too, so nobody plans around a deletion that cannot happen.
    await expect(teams.remove(orgA, team.id, { dryRun: true })).rejects.toBeInstanceOf(
      LastGrantInShareError,
    );
    expect((await teams.find(orgA, team.id)).name).toBe('Tek-Kural');

    // A second rule in the same share, and the deletion is ordinary again: the share stays governed
    // without this team, which is what the refusal was protecting.
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO folder_grants (organization_id, share_id, entry_id, user_id, permissions)
         VALUES ($1,$2,NULL,$3,'{list,read}')`,
        [orgA, lonely, founderA],
      ),
    );
    await expect(teams.remove(orgA, team.id, { dryRun: false })).resolves.toBeTruthy();
  });

  it('reports no impact for a team that was never granted anything', async () => {
    const team = await teams.create(orgA, 'Bos');
    await teams.putMember(orgA, team.id, memberA, false);
    const impact = await teams.remove(orgA, team.id, { dryRun: true });
    expect(impact).toEqual({ foldersAffected: 0, usersGaining: [], usersLosing: [] });
  });

  /** How many POSIX re-application jobs this tenant has on the queue. */
  async function appliesQueued(): Promise<number> {
    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM job_queue
          WHERE organization_id = $1 AND kind = 'permissions.apply'`,
        [orgA],
      ),
    );
    return Number(rows[0]?.n ?? '0');
  }

  /** A fresh two-level tree, so one test's grants cannot be counted by the next one's preview. */
  async function makeFolders(): Promise<{ top: string; sub: string }> {
    folderSeq += 1;
    const name = `ust${folderSeq}`;
    return owner.withoutTenant('migration-status', async (q) => {
      const top = await q.query<{ id: string }>(
        `INSERT INTO file_entries (organization_id, share_id, parent_id, kind, name, path)
         VALUES ($1,$2,NULL,'folder',$3,'/' || $3)
         RETURNING id::text AS id`,
        [orgA, shareA, name],
      );
      const topId = top[0]?.id ?? '';
      const sub = await q.query<{ id: string }>(
        `INSERT INTO file_entries (organization_id, share_id, parent_id, kind, name, path)
         VALUES ($1,$2,$3,'folder','alt','/' || $4 || '/alt')
         RETURNING id::text AS id`,
        [orgA, shareA, topId, name],
      );
      return { top: topId, sub: sub[0]?.id ?? '' };
    });
  }

  /** A grant to a team, written the way the permissions endpoint will write it. */
  async function grantTeam(teamId: string, entryId: string, permissions: string[]): Promise<void> {
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO folder_grants (organization_id, share_id, entry_id, team_id, permissions)
         VALUES ($1,$2,$3,$4,$5::folder_permission[])`,
        [orgA, shareA, entryId, teamId, permissions],
      ),
    );
  }

  async function grantUser(userId: string, entryId: string, permissions: string[]): Promise<void> {
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO folder_grants (organization_id, share_id, entry_id, user_id, permissions)
         VALUES ($1,$2,$3,$4,$5::folder_permission[])`,
        [orgA, shareA, entryId, userId, permissions],
      ),
    );
  }
});
