import { Injectable, Logger } from '@nestjs/common';
import {
  aggregateImpact,
  isPermission,
  resolveImpact,
  type AclNode,
  type FolderImpact,
  type Grant as AclGrant,
  type Permission,
  type Subject,
} from '@depsis/authz';

import { AgentService } from '../agent/agent.service.js';
import { DbService, type TenantQuery } from '../db/db.service.js';
import { IdentitySyncService } from '../identity/identity-sync.service.js';
import { PosixIdentityService } from '../identity/posix.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import { APPLY_ACL_KIND, APPLY_ACL_MAX_ATTEMPTS } from '../permissions/permissions.service.js';

export interface TeamRow {
  id: string;
  name: string;
  posix_gid: number | null;
  member_count: number;
  created_at: Date;
}

export interface TeamMemberRow {
  user_id: string;
  username: string;
  team_admin: boolean;
  added_at: Date;
}

/** One user's effective set at the shallowest folder where it moved, with a name to show. */
export interface AffectedUser {
  userId: string;
  username: string;
  before: readonly Permission[];
  after: readonly Permission[];
}

/** The `PermissionImpact` numbers for a bulk permission change. */
export interface ImpactSummary {
  foldersAffected: number;
  usersGaining: readonly AffectedUser[];
  usersLosing: readonly AffectedUser[];
}

const NO_IMPACT: ImpactSummary = { foldersAffected: 0, usersGaining: [], usersLosing: [] };

/**
 * How many folders a bulk preview will resolve before it stops walking.
 *
 * The same number `PermissionsService.IMPACT_FOLDER_LIMIT` uses and for the same reason, written
 * here rather than imported so the two dry-runs cannot silently drift onto different budgets. This
 * walk used to have none at all: `impactOfDroppingTeamGrants` iterated every folder of every share
 * carrying a grant for the team, resolving a chain per subject per folder, synchronously inside the
 * request — and `DELETE /teams/{id}?dryRun=true` is reachable by any organisation administrator.
 */
const IMPACT_FOLDER_LIMIT = 1000;

/** What a bulk change costs, and which shares' POSIX ACLs it leaves stale. */
interface BulkImpact {
  summary: ImpactSummary;
  /** The shares that carried a grant for the team, so the re-application can be queued for them. */
  shareIds: readonly string[];
}

/** The team name is already taken inside this organisation. */
export class TeamNameTakenError extends Error {
  constructor() {
    super('a team with that name already exists here');
    this.name = 'TeamNameTakenError';
  }
}

/**
 * Deleting this team would take the last grant out of a share.
 *
 * `folder_grants.team_id` is `ON DELETE CASCADE`, so deleting a team deletes its grants — and a
 * share whose only rule named this team would be left with none. Every share having at least one
 * grant is an invariant now (migration 0016, and `SharesService.create` writes the row and its
 * first grant together), so this cascade is one of exactly two ways to break it.
 *
 * What it costs has changed, and it is worth being precise because the refusal used to be
 * justified by the opposite outcome. While `LEGACY_OPEN_SHARE` existed, emptying a share OPENED it
 * — every member of the tenant got the pre-§6.2 seven across all of it. Now an empty share is
 * closed to everyone, including the administrator who emptied it, reachable only by an
 * organisation administrator's bypass. That is the safe direction, and it is still not a state to
 * arrive in by deleting a team: the folders become invisible to the people who were using them,
 * with nothing on screen connecting that to the team that went.
 *
 * `PermissionsService.write` refuses the same transition through the front door; this is the
 * cascade that would otherwise walk round it.
 */
export class LastGrantInShareError extends Error {
  constructor() {
    super(
      'deleting this team would remove the last permission row in a share, leaving it with no ' +
        'rule at all and invisible to everyone who is not an administrator; write a root grant ' +
        'naming whoever should keep access first, then delete the team',
    );
    this.name = 'LastGrantInShareError';
  }
}

/** No such team, or it belongs to another tenant — deliberately one answer. */
export class TeamNotFoundError extends Error {
  constructor() {
    super('no such team');
    this.name = 'TeamNotFoundError';
  }
}

/**
 * No such account in THIS organisation, or it is not a member of this team.
 *
 * One error for both, and for the reason `UsersService` gives: RLS hides another tenant's row from
 * the SELECT, so naming a foreign user id must be indistinguishable from naming one that does not
 * exist. A membership row is created with a plain INSERT whose only tenant check is
 * `organization_id`, and the foreign key on `user_id` is device-wide — so without the explicit
 * lookup this error comes from, a caller could enrol ANOTHER TENANT'S account into their team.
 */
export class TeamMemberNotFoundError extends Error {
  constructor() {
    super('no such member');
    this.name = 'TeamMemberNotFoundError';
  }
}

interface GrantRow {
  entry_id: string | null;
  share_id: string;
  user_id: string | null;
  team_id: string | null;
  permissions: string[];
}

interface NodeRow {
  id: string;
  parent_id: string | null;
  share_id: string;
}

/**
 * Teams, membership, and what removing either of them costs.
 *
 * §6.1 puts a team between the organisation and the user, and ADR-0004 says why it has to exist at
 * all rather than being a convenience: ACL entries are given to GROUPS, never to users, because
 * POSIX ACLs turn unwieldy past roughly thirty entries and the mask semantics start biting. A team
 * is therefore the unit a permission is actually granted to; a user only ever reaches a folder
 * through one.
 *
 * Every method takes the organisation from the caller's session and never from a request field
 * (ADR-0015 §6), and `withTenant` makes that structural: a query run with the wrong tenant context
 * returns nothing rather than someone else's rows.
 */
@Injectable()
export class TeamsService {
  private readonly logger = new Logger(TeamsService.name);

  constructor(
    private readonly db: DbService,
    private readonly jobs: JobsService,
    private readonly agent: AgentService,
    /** For the Unix side of a membership change. See `syncIdentity`. */
    private readonly identity: IdentitySyncService,
  ) {}

  /**
   * Every team in the organisation, for everybody.
   *
   * Not admin-only, and that is a decision rather than an oversight: granting a permission means
   * picking a target, so a member who can share a folder has to be able to name the team they are
   * sharing it with. What a team's ROSTER is stays behind its own endpoint.
   */
  async list(organizationId: string): Promise<TeamRow[]> {
    return this.db.withTenant(organizationId, (db) =>
      db.query<TeamRow>(
        `SELECT t.id::text AS id, t.name, t.posix_gid, t.created_at,
                (SELECT count(*)::int FROM public.team_members m
                  WHERE m.organization_id = t.organization_id AND m.team_id = t.id) AS member_count
           FROM public.teams t
          WHERE t.organization_id = $1
          ORDER BY t.name_fold`,
        [organizationId],
      ),
    );
  }

  async find(organizationId: string, id: string): Promise<TeamRow> {
    return this.db.withTenant(organizationId, (db) => findWithin(db, organizationId, id));
  }

  /**
   * Create a team, and reserve its POSIX group id in the SAME transaction.
   *
   * The gid is what an ACL entry names on disk (ADR-0004), so a team that exists without one is a
   * team a permission cannot be attached to. Allocating it here means there is no window in which
   * the row is committed and the identity is not — the ordering `UsersService.create` uses for the
   * same reason, and the ordering `allocate_posix_id`'s own COMMENT requires: the caller must WRITE
   * the returned value in the transaction that read it.
   *
   * `posix_gid` stays reserved but UNAPPLIED until the privileged agent creates the group. The
   * column being non-null therefore does not mean "the filesystem knows about this team"; migration
   * 0015 leaves it nullable for teams that predate this code, and `Team.posixGid` reports it either
   * way so the interface can say which state a team is in.
   */
  async create(organizationId: string, name: string): Promise<TeamRow> {
    try {
      const rows = await this.db.withTenant(organizationId, async (db) => {
        const posixGid = await PosixIdentityService.allocateWithin(db, 'team');
        return db.query<TeamRow>(
          `INSERT INTO public.teams (organization_id, name, posix_gid)
           VALUES ($1, $2, $3)
           RETURNING id::text AS id, name, posix_gid, created_at, 0 AS member_count`,
          [organizationId, name, posixGid],
        );
      });
      const row = rows[0];
      if (!row) throw new Error('the team row was not returned');
      return row;
    } catch (error) {
      throw translateDbError(error);
    }
  }

  /** Rename a team. The gid does not move: it is what the ACLs on disk already name. */
  async rename(organizationId: string, id: string, name: string): Promise<TeamRow> {
    try {
      return await this.db.withTenant(organizationId, async (db) => {
        const changed = await db.query<{ id: string }>(
          `UPDATE public.teams SET name = $3
            WHERE organization_id = $1 AND id = $2
            RETURNING id::text AS id`,
          [organizationId, id, name],
        );
        if (changed[0] === undefined) throw new TeamNotFoundError();
        return findWithin(db, organizationId, id);
      });
    } catch (error) {
      throw translateDbError(error);
    }
  }

  /**
   * Delete a team, or price the deletion without performing it.
   *
   * Deleting a team deletes every grant that names it (`ON DELETE CASCADE` in migration 0015), so
   * this is a BULK PERMISSION CHANGE wearing the clothes of an ordinary delete — §6.2's dry-run
   * requirement applies to it exactly as it applies to writing a grant. The preview and the delete
   * run in ONE transaction so the numbers describe the tree the delete actually acted on; computed
   * in a separate transaction they would describe a tree somebody may have changed in between.
   *
   * `usersGaining` is always empty for this operation and for `removeMember`, and that is a
   * property rather than a shortcut: every grant naming the team goes at once, so no nearer grant
   * is ever uncovered and no principal can end up contributing more. It is still computed by the
   * same resolver rather than hard-coded to `[]` — a hard-coded empty list would keep saying "empty"
   * on the day the operation stops being a pure removal.
   */
  async remove(
    organizationId: string,
    id: string,
    options: { dryRun: boolean },
  ): Promise<ImpactSummary> {
    const done = await this.db.withTenant(organizationId, async (db) => {
      await findWithin(db, organizationId, id);

      // Refused on a dry run too, for the reason `PermissionsService.write` refuses its own
      // version there: a preview of a deletion that cannot happen is a worse answer than the
      // refusal.
      await assertNoShareWouldOpen(db, organizationId, id);

      const members = await db.query<{ user_id: string }>(
        `SELECT user_id::text AS user_id FROM public.team_members
          WHERE organization_id = $1 AND team_id = $2`,
        [organizationId, id],
      );
      const impact = await impactOfDroppingTeamGrants(
        db,
        organizationId,
        id,
        members.map((m) => m.user_id),
      );

      if (options.dryRun) return { impact, changed: false };

      // ── SİLİNEN EKİBİN gid'İ EMEKLİ EDİLİYOR ────────────────────────────────────────────
      //
      // `allocate_posix_id` bir sonraki numarayı `MAX(users.posix_uid ∪ teams.posix_gid ∪
      // retired) + 1` ile buluyor, yani en yüksek numaralı ekip silinince gid'i serbest kalıyor
      // ve BİR SONRAKİ HESABA uid olarak veriliyor. Ajanın kimlik eşitlemesi grupları yalnız
      // yaratıyor, silmiyor — `depsis-t-<gid>` kutuda duruyor. `ensure_group` o numarada bir
      // grup görünce "var" deyip geçiyor, sonra `useradd -g depsis-p-<uid>` var olmayan bir
      // grubu istiyor ve patlıyor: o kiracının BÜTÜN eşitlemeleri kalıcı olarak düşüyor, yani
      // hiçbir yeni hesap SMB'ye giremiyor. Üstelik diskteki `group:<gid>` ACL girdileri de
      // yeni hesabın özel grubuyla eşleşiyor.
      //
      // `RETURNING` ile, ayrı bir SELECT ile değil: değer silinen satırdan aynı işlemde gelmeli.
      // 0015 öncesi kurulmuş ekiplerin `posix_gid`i NULL olabiliyor, o zaman emekli edilecek bir
      // numara da yok.
      const dropped = await db.query<{ posix_gid: number | null }>(
        `DELETE FROM public.teams WHERE organization_id = $1 AND id = $2
          RETURNING posix_gid`,
        [organizationId, id],
      );
      const posixGid = dropped[0]?.posix_gid ?? null;
      if (posixGid !== null) {
        await db.query(
          `INSERT INTO public.retired_posix_ids (id_value, note)
                VALUES ($1, $2)
           ON CONFLICT (id_value) DO NOTHING`,
          [posixGid, 'silinen ekip'],
        );
      }
      return { impact, changed: true };
    });

    if (done.changed) {
      await this.applyToShares(organizationId, done.impact.shareIds);
      await this.syncIdentity(organizationId, 'a team membership change');
    }
    return done.impact.summary;
  }

  async members(organizationId: string, teamId: string): Promise<TeamMemberRow[]> {
    return this.db.withTenant(organizationId, async (db) => {
      await findWithin(db, organizationId, teamId);
      return db.query<TeamMemberRow>(
        `SELECT m.user_id::text AS user_id, u.username, m.team_admin, m.added_at
           FROM public.team_members m
           JOIN public.users u
             ON u.id = m.user_id AND u.organization_id = m.organization_id
          WHERE m.organization_id = $1 AND m.team_id = $2
          ORDER BY u.username`,
        [organizationId, teamId],
      );
    });
  }

  /**
   * Put a user in a team, or change the flag on a membership that is already there.
   *
   * An UPSERT rather than an INSERT, because the contract makes this PUT: asking twice for the same
   * state is not an error, and a 409 on the second click would make the interface either remember
   * what it had already sent or swallow a conflict it cannot distinguish from a real one.
   *
   * The account is looked up under the tenant context FIRST. `team_members.user_id` references
   * `public.users` device-wide and the row's own RLS policy only checks `organization_id`, so the
   * foreign key would happily accept another tenant's account and the policy would see nothing
   * wrong with the row. The lookup is what makes that a 404 instead of a cross-tenant membership.
   */
  async putMember(
    organizationId: string,
    teamId: string,
    userId: string,
    teamAdmin: boolean,
  ): Promise<TeamMemberRow> {
    const added = await this.db.withTenant(organizationId, async (db) => {
      await findWithin(db, organizationId, teamId);

      const users = await db.query<{ username: string }>(
        `SELECT username FROM public.users WHERE organization_id = $1 AND id = $2`,
        [organizationId, userId],
      );
      const user = users[0];
      if (!user) throw new TeamMemberNotFoundError();

      const rows = await db.query<TeamMemberRow>(
        `INSERT INTO public.team_members (organization_id, team_id, user_id, team_admin)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (organization_id, team_id, user_id)
           DO UPDATE SET team_admin = EXCLUDED.team_admin
         RETURNING user_id::text AS user_id, team_admin, added_at`,
        [organizationId, teamId, userId, teamAdmin],
      );
      const row = rows[0];
      if (!row) throw new Error('the membership row was not returned');
      return { ...row, username: user.username };
    });

    // ── EKLEMEK DE EŞİTLER ──────────────────────────────────────────────────────────────────
    //
    // Etmiyordu, ve asimetrinin kendisi kazara olduğunu söylüyordu: `remove` ve `removeMember`
    // eşitliyor, `putMember` eşitlemiyordu. Bir ekibe yetki verip sonra kullanıcıyı ekleyince
    // arayüz erişimi olduğunu gösteriyor, ağ paylaşımı ona kapalı kalıyordu — çünkü
    // klasör ACL'i yetkiyi EKİBİN Unix grubuna veriyor ve kullanıcı o gruba hiç girmemiş oluyor.
    //
    // İşlemden SONRA, içinde değil: `enqueue` kendi kiracı işlemini açıyor. Bu depodaki her
    // enqueue çağrısının kullandığı sıra.
    await this.syncIdentity(organizationId, 'a team membership change');
    return added;
  }

  /**
   * Tell the agent the Unix groups have moved.
   *
   * MEMBERSHIP IS HALF THE MODEL. `folder_grants` names a team, `ApplyFolderAcl` writes that team's
   * gid onto the folder, and the kernel decides by asking whether the user is IN that group. So a
   * membership change that never reaches `/etc/group` is a grant that never takes effect — or,
   * worse, a removal that never takes effect, which leaves someone reaching folders their grant no
   * longer covers.
   *
   * `putMember` had no re-apply of any kind before this: `removeMember` queued an ACL job and its
   * counterpart queued nothing, so joining a team worked on the web and never on SMB.
   */
  private async syncIdentity(organizationId: string, why: string): Promise<void> {
    await this.identity.enqueue(organizationId, why);
  }

  /**
   * Take a user out of a team, or price it first.
   *
   * With no explicit deny in the model (ADR-0021), this is the ONLY way to express "everyone except
   * this person", so it will be reached for often — and it silently withdraws every permission the
   * team carried anywhere in the tree. That is why the same dry-run the grant endpoints offer is
   * offered here.
   */
  async removeMember(
    organizationId: string,
    teamId: string,
    userId: string,
    options: { dryRun: boolean },
  ): Promise<ImpactSummary> {
    const done = await this.db.withTenant(organizationId, async (db) => {
      await findWithin(db, organizationId, teamId);

      const existing = await db.query<{ user_id: string }>(
        `SELECT user_id::text AS user_id FROM public.team_members
          WHERE organization_id = $1 AND team_id = $2 AND user_id = $3`,
        [organizationId, teamId, userId],
      );
      if (existing[0] === undefined) throw new TeamMemberNotFoundError();

      // Losing a membership and losing the team's grants are the same event as far as THIS user's
      // effective permissions go: their principals no longer include the team, so every grant
      // naming it stops applying to them. Modelling it as "the team's grants are gone" lets the one
      // resolver answer both endpoints rather than two pieces of code agreeing by hand.
      const impact = await impactOfDroppingTeamGrants(db, organizationId, teamId, [userId]);

      if (options.dryRun) return { impact, changed: false };

      await db.query(
        `DELETE FROM public.team_members
          WHERE organization_id = $1 AND team_id = $2 AND user_id = $3`,
        [organizationId, teamId, userId],
      );
      return { impact, changed: true };
    });

    if (done.changed) {
      await this.applyToShares(organizationId, done.impact.shareIds);
      await this.syncIdentity(organizationId, 'a team membership change');
    }
    return done.impact.summary;
  }

  /**
   * Queue the POSIX re-application for every share this change touched.
   *
   * These two operations move effective permissions across whole shares and used to enqueue
   * NOTHING: the grant rows changed, the kernel was never told, and the folder stayed open over
   * SMB. `PUT /files/{id}/permissions` at least reports that divergence through a null
   * `applyingJobId`; `PermissionImpact` — the only thing these two return — has no field for it,
   * so an unreachable agent can only be written to the journal here. That gap is real and belongs
   * in the contract; see the notes with this change.
   *
   * After the transaction, never inside it. `JobsService.enqueue` opens its own tenant transaction,
   * and nesting one inside another takes a second connection from the same pool for work that has
   * to happen anyway — the same ordering `PermissionsService.write` uses.
   */
  private async applyToShares(organizationId: string, shareIds: readonly string[]): Promise<void> {
    if (shareIds.length === 0) return;
    // The `agent.isAvailable()` guard that used to stand here was the worst instance of the three,
    // because this path is a BULK REVOCATION and the endpoint has no way to report the miss:
    // `DELETE /teams/{id}` answers 204, and the dry-run's `PermissionImpact` has no
    // `applyingJobId` field at all. An administrator deleting a team during an agent restart got a
    // 204, lost every grant the team carried, and left the group's ACL entries on every folder —
    // with no signal anywhere but a log line. See `PermissionsService.enqueueApply`.
    for (const shareId of shareIds) {
      try {
        // `entryId: null` is the share root, so the job walks the whole share. A team's grants can
        // sit on any number of nodes in it and the cascade took all of them at once; re-applying
        // from the root is the only scope that is certainly a superset of what changed.
        await this.jobs.enqueue(
          organizationId,
          APPLY_ACL_KIND,
          { shareId, entryId: null },
          { maxAttempts: APPLY_ACL_MAX_ATTEMPTS },
        );
      } catch (error) {
        this.logger.error(
          `grants were dropped in share ${shareId} but the apply job could not be queued: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Is this user an administrator OF THIS TEAM?
   *
   * §6.1's "Ekip yöneticisi" row: an authority whose scope is one team, distinct from the
   * organisation administrator whose scope is everything. The two are asked separately on purpose —
   * an endpoint that accepted either without knowing which it got would be an endpoint whose test
   * cannot tell the two grants of authority apart.
   */
  async isTeamAdmin(organizationId: string, teamId: string, userId: string): Promise<boolean> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ team_admin: boolean }>(
        `SELECT team_admin FROM public.team_members
          WHERE organization_id = $1 AND team_id = $2 AND user_id = $3`,
        [organizationId, teamId, userId],
      ),
    );
    return rows[0]?.team_admin === true;
  }
}

/** Inside a transaction the caller already owns, so a preview and a write see the same rows. */
async function findWithin(db: TenantQuery, organizationId: string, id: string): Promise<TeamRow> {
  const rows = await db.query<TeamRow>(
    `SELECT t.id::text AS id, t.name, t.posix_gid, t.created_at,
            (SELECT count(*)::int FROM public.team_members m
              WHERE m.organization_id = t.organization_id AND m.team_id = t.id) AS member_count
       FROM public.teams t
      WHERE t.organization_id = $1 AND t.id = $2`,
    [organizationId, id],
  );
  const row = rows[0];
  if (!row) throw new TeamNotFoundError();
  return row;
}

/**
 * What happens to `affectedUserIds` if every grant naming `teamId` disappears.
 *
 * The whole calculation is delegated to `@depsis/authz`: this function's only job is to hand the
 * resolver a faithful copy of the tree and the same tree with the team's rows taken out. Deriving
 * the answer here instead would put a second implementation of ADR-0021's inheritance rule in the
 * codebase, and the failure mode of two implementations of a permission rule is that the preview
 * and the enforcement disagree — which is worse than having no preview.
 *
 * Scope: only the shares that actually carry a grant for this team are loaded, and only the
 * folders in them. A share nobody granted the team anything on cannot change for anybody.
 */
async function impactOfDroppingTeamGrants(
  db: TenantQuery,
  organizationId: string,
  teamId: string,
  affectedUserIds: readonly string[],
): Promise<BulkImpact> {
  const shareRows = await db.query<{ share_id: string }>(
    `SELECT DISTINCT share_id::text AS share_id FROM public.folder_grants
      WHERE organization_id = $1 AND team_id = $2`,
    [organizationId, teamId],
  );
  const shareIds = shareRows.map((row) => row.share_id);
  // The shares still go back even when there is nobody to price the change for: an empty team
  // whose grants are about to cascade away still changes what the filesystem should say.
  if (affectedUserIds.length === 0 || shareIds.length === 0) {
    return { summary: NO_IMPACT, shareIds };
  }

  const nodeRows = await db.query<NodeRow>(
    // Folders, plus any entry a grant happens to name. The second half is defensive: grants are
    // meant for folders, and a grant on a file whose node was left out would be silently dropped
    // from the tree — an omission that makes the preview understate the change rather than fail.
    `SELECT id::text AS id, parent_id::text AS parent_id, share_id::text AS share_id
       FROM public.file_entries
      WHERE organization_id = $1 AND share_id = ANY($2::uuid[]) AND trashed_at IS NULL
        AND (kind = 'folder'
             OR id IN (SELECT entry_id FROM public.folder_grants
                        WHERE organization_id = $1 AND entry_id IS NOT NULL))`,
    [organizationId, shareIds],
  );

  const grantRows = await db.query<GrantRow>(
    `SELECT entry_id::text AS entry_id, share_id::text AS share_id,
            user_id::text AS user_id, team_id::text AS team_id,
            permissions::text[] AS permissions
       FROM public.folder_grants
      WHERE organization_id = $1 AND share_id = ANY($2::uuid[])`,
    [organizationId, shareIds],
  );

  const membershipRows = await db.query<{ user_id: string; team_id: string }>(
    `SELECT user_id::text AS user_id, team_id::text AS team_id FROM public.team_members
      WHERE organization_id = $1 AND user_id = ANY($2::uuid[])`,
    [organizationId, [...affectedUserIds]],
  );

  // The share root is a node like any other — `folder_grants.entry_id IS NULL` means "the whole
  // share", and ADR-0021 keeps it in the same table so this walk is written once. Its id is the
  // share's, which cannot collide with an entry's.
  const parents = new Map<string, string | null>();
  for (const shareId of shareIds) parents.set(shareId, null);
  for (const node of nodeRows) parents.set(node.id, node.parent_id ?? node.share_id);

  const before = new Map<string, AclGrant[]>();
  const after = new Map<string, AclGrant[]>();
  for (const row of grantRows) {
    const nodeId = row.entry_id ?? row.share_id;
    const grant = toAclGrant(row);
    if (grant === null) continue;
    push(before, nodeId, grant);
    if (grant.principal.kind === 'team' && grant.principal.id === teamId) continue;
    push(after, nodeId, grant);
  }

  const teamsOf = new Map<string, string[]>();
  for (const row of membershipRows) {
    const list = teamsOf.get(row.user_id);
    if (list === undefined) teamsOf.set(row.user_id, [row.team_id]);
    else list.push(row.team_id);
  }
  const subjects: Subject[] = affectedUserIds.map((userId) => ({
    userId,
    teamIds: teamsOf.get(userId) ?? [],
  }));

  // Shallowest first. `aggregateImpact` reports each user once, with the before/after from the
  // FIRST folder it sees them in, and under ADR-0021's nearest-ancestor rule the meaningful one is
  // the highest node where their set moved — a deeper folder carrying its own grant for that
  // principal is not affected at all. A row order the database happened to return is not that.
  const ranked: Array<{ depth: number; impact: FolderImpact }> = [];
  for (const nodeId of parents.keys()) {
    // Bounded, because this loop is folders × subjects × chain length on the event loop inside a
    // request. Unbounded it was a cost any administrator could trigger with one query parameter.
    // The cut is silent to the caller for the reason `PermissionsService.impactOf` records: the
    // contract's `PermissionImpact` has no field that could say "approximately".
    if (ranked.length >= IMPACT_FOLDER_LIMIT) break;
    const beforeChain = chainTo(nodeId, parents, before);
    const afterChain = chainTo(nodeId, parents, after);
    if (beforeChain === null || afterChain === null) continue;
    ranked.push({
      depth: beforeChain.length,
      impact: resolveImpact({ before: beforeChain, after: afterChain, subjects }),
    });
  }
  ranked.sort((a, b) => a.depth - b.depth);

  const rolled = aggregateImpact(ranked.map((entry) => entry.impact));
  const usernames = await namesFor(db, organizationId, [
    ...rolled.usersGaining.map((u) => u.userId),
    ...rolled.usersLosing.map((u) => u.userId),
  ]);
  const named = (user: {
    userId: string;
    before: readonly Permission[];
    after: readonly Permission[];
  }): AffectedUser => ({
    userId: user.userId,
    username: usernames.get(user.userId) ?? '',
    before: user.before,
    after: user.after,
  });

  return {
    summary: {
      foldersAffected: rolled.foldersAffected,
      usersGaining: rolled.usersGaining.map(named),
      usersLosing: rolled.usersLosing.map(named),
    },
    shareIds,
  };
}

/**
 * Refuse if any share would be left with no grant rows once this team's cascade away.
 *
 * One statement rather than a loop: for every share that carries a grant naming the team, ask
 * whether it carries one that does NOT. A share where the answer is no is a share that stops being
 * governed the moment the team row goes.
 */
async function assertNoShareWouldOpen(
  db: TenantQuery,
  organizationId: string,
  teamId: string,
): Promise<void> {
  const rows = await db.query<{ share_id: string }>(
    `SELECT DISTINCT g.share_id::text AS share_id
       FROM public.folder_grants g
      WHERE g.organization_id = $1 AND g.team_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM public.folder_grants other
           WHERE other.organization_id = g.organization_id
             AND other.share_id = g.share_id
             AND other.team_id IS DISTINCT FROM $2
        )`,
    [organizationId, teamId],
  );
  if (rows.length > 0) throw new LastGrantInShareError();
}

function push(into: Map<string, AclGrant[]>, nodeId: string, grant: AclGrant): void {
  const list = into.get(nodeId);
  if (list === undefined) into.set(nodeId, [grant]);
  else list.push(grant);
}

/**
 * One `folder_grants` row as the resolver wants it, or null if it names neither principal.
 *
 * `folder_grants_one_principal` makes "neither" impossible in the database, so null here is a row
 * written by something that bypassed the constraint. Skipping it is the safe direction: a grant
 * nobody can be matched against grants nothing.
 */
function toAclGrant(row: GrantRow): AclGrant | null {
  const permissions = row.permissions.filter(isPermission);
  if (permissions.length === 0) return null;
  if (row.team_id !== null) {
    return { principal: { kind: 'team', id: row.team_id }, permissions };
  }
  if (row.user_id !== null) {
    return { principal: { kind: 'user', id: row.user_id }, permissions };
  }
  return null;
}

/**
 * The chain from the share root down to `nodeId`, built from `parent_id` and never from `path`.
 *
 * ADR-0005: identity is the id, and a path is a rendering of it. A chain assembled from path
 * strings would answer a different question the moment a rename was half-applied.
 *
 * Null when the walk cannot reach a root — a node whose parent was filtered out, which happens if
 * a folder is trashed while its child is not. Returning null skips that node rather than throwing:
 * a preview that cannot see one folder should report the rest, not fail the request.
 */
function chainTo(
  nodeId: string,
  parents: ReadonlyMap<string, string | null>,
  grants: ReadonlyMap<string, readonly AclGrant[]>,
): AclNode[] | null {
  const chain: AclNode[] = [];
  let current: string | null = nodeId;
  const seen = new Set<string>();
  while (current !== null) {
    if (seen.has(current)) return null;
    seen.add(current);
    if (!parents.has(current)) return null;
    const parentId: string | null = parents.get(current) ?? null;
    chain.push({ id: current, parentId, grants: grants.get(current) ?? [] });
    current = parentId;
  }
  return chain.reverse();
}

async function namesFor(
  db: TenantQuery,
  organizationId: string,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Map();
  const rows = await db.query<{ id: string; username: string }>(
    `SELECT id::text AS id, username FROM public.users
      WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
    [organizationId, unique],
  );
  return new Map(rows.map((row) => [row.id, row.username]));
}

/**
 * PostgreSQL's SQLSTATE, not its message.
 *
 * The message carries the constraint name and is localised by the server's `lc_messages`: a box
 * installed in Turkish would stop producing 409s and start producing 500s, and nothing in this
 * repository would notice until somebody tried it.
 *
 * The `constraint` FIELD is a different thing from the message and is safe to read: it is the index
 * name, not prose. It has to be read here because two unique indexes can raise 23505 on the same
 * INSERT — the name and the device-wide `posix_gid`. Reporting a gid collision as "that name is
 * taken" would send an administrator renaming a team to work around an exhausted identity space.
 */
function translateDbError(error: unknown): Error {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const failure = error as { code?: string; constraint?: string };
    if (failure.code === '23505' && failure.constraint !== 'teams_posix_gid_unique') {
      return new TeamNameTakenError();
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}
