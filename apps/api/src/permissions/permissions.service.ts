import { Injectable, Logger } from '@nestjs/common';
import {
  PERMISSIONS,
  aggregateImpact,
  isPermission,
  resolve,
  resolveImpact,
  sortPermissions,
  type AclNode,
  type FolderImpact,
  type Grant,
  type Permission,
  type Subject,
  type UserImpact,
} from '@depsis/authz';

import { AgentService } from '../agent/agent.service.js';
import { DbService, type TenantQuery } from '../db/db.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import { LEGACY_OPEN_SHARE } from './legacy-open-share.js';

/**
 * §6.2's per-folder permissions: reading what a caller may do here, and rewriting the rows that
 * decide it.
 *
 * The RULE lives in `packages/authz` and nothing here re-implements it. That is not tidiness: the
 * dry-run preview and the live answer have to agree, and the only way to guarantee agreement is
 * for both to be the same function over different input (ADR-0021). This service's whole job is to
 * turn `file_entries`/`folder_grants` rows into the shapes that function takes, and its answers
 * back into the contract's.
 *
 * Three properties of the model shape every query below:
 *
 *   * **Identity is the id, never the path** (ADR-0005). The ancestor chain is built with a
 *     recursive CTE over `parent_id`. `file_entries.path` is display text that a rename job may be
 *     rewriting right now; a permission decision that read it would be a decision made from a
 *     cache.
 *   * **The share root is a node.** `folder_grants.entry_id IS NULL` means "the whole share", and
 *     ADR-0021 keeps it in the same table precisely so the walk is written once. In memory it
 *     becomes an `AclNode` whose id is the SHARE's id and whose parent is null.
 *   * **RLS is the isolation, and the predicate is belt as well as braces.** Every statement runs
 *     inside `withTenant`, and every statement also names `organization_id`. Either alone would
 *     look correct; the pair is what survives someone editing one of them.
 */

/** The maximum ancestor hops the chain walk will take before it refuses to answer. */
const MAX_TREE_DEPTH = 256;

/**
 * How many folders a dry-run will actually RESOLVE before it stops walking.
 *
 * The impact calculation is folders × subjects × chain length, and it runs inside a request with a
 * thirty-second statement timeout. A share with a hundred thousand folders would spend that budget
 * computing a number nobody reads to the last digit.
 *
 * What happens past the limit is written down here and in `impactOf`, because the contract has no
 * "approximate" flag to put it in: the per-user lists come from the first `IMPACT_FOLDER_LIMIT`
 * folders in breadth-first order — the ones nearest the change, where its effect is most visible —
 * and `foldersAffected` is then reported as the size of the WHOLE subtree rather than of the
 * sample. That number is an upper bound rather than the exact count, and rounding up is the only
 * safe direction: this figure exists to make an administrator hesitate, and a sample count would
 * say "three folders" about a change that reaches five thousand.
 */
const IMPACT_FOLDER_LIMIT = 1000;

/** The job that walks the subtree and rewrites POSIX ACLs, one `ApplyFolderAcl` per folder. */
export const APPLY_ACL_KIND = 'permissions.apply';

/** No such node in this tenant. 404, because 403 here would confirm that the id exists. */
export class NodeNotFoundError extends Error {
  constructor() {
    super('no such folder');
    this.name = 'NodeNotFoundError';
  }
}

/**
 * The caller may reach the folder but may not rewrite its grants.
 *
 * A separate error from "not found" on purpose: the caller has already been told the node exists —
 * they can read it — so there is nothing left to leak, and 403 is the answer that tells them to
 * ask an administrator rather than to check the link.
 */
export class NotManageableError extends Error {
  constructor() {
    super('changing permissions here needs the manage permission');
    this.name = 'NotManageableError';
  }
}

/**
 * A grant was aimed at a file.
 *
 * Refused rather than written, even though the schema would take the row. Inheritance in the
 * substrate is the POSIX DEFAULT ACL and only directories have one (`services/system-agent`'s
 * `acl.rs`), so a grant on a file could never be reflected onto the filesystem — it would be a row
 * saying one thing while SMB said another, which is the two realities ADR-0004 exists to prevent.
 */
export class NotAFolderError extends Error {
  constructor() {
    super('permissions are set on folders; a file inherits them from the folder it is in');
    this.name = 'NotAFolderError';
  }
}

/**
 * The write would leave a governed share with no grant rows at all.
 *
 * Refused, because `LEGACY_OPEN_SHARE` is a ONE-WAY door and nothing persists which side of it a
 * share is on: `shareIsGoverned` is an existence test over `folder_grants`, asked afresh on every
 * request. Emptying the last row therefore does not close the share, it OPENS it — the fallback
 * comes back and every member of the tenant gets the pre-§6.2 seven on every folder of the share,
 * including folders no grant ever named them on. A delegated manager of one folder could reach
 * that state from a root grant they were given, which is the model handing away more than it was
 * ever asked to hand away.
 *
 * The remedy is a sentence rather than a status: closing a share completely means a root grant
 * that names somebody — an administrator, if nobody else — not an empty list. That keeps the share
 * governed and grants nothing to anyone who is not on it.
 *
 * The permanent fix is a `shares.governed_at` that is set once and never cleared, so the predicate
 * stops being derivable from the rows. That needs a migration this round could not write.
 */
export class LastGrantError extends Error {
  constructor() {
    super(
      'this would remove the last permission row in the share, which puts the whole share back ' +
        'on the pre-§6.2 default and opens it to every member; to close it, write a root grant ' +
        'that names only the people who should keep access',
    );
    this.name = 'LastGrantError';
  }
}

/** A grant named a user or team that does not exist in this tenant. */
export class UnknownPrincipalError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`no such user or team in this organization: ${missing.join(', ')}`);
    this.name = 'UnknownPrincipalError';
  }
}

/**
 * The body named the same principal twice.
 *
 * Migration 0015's unique indexes refuse it too, but that refusal arrives as SQLSTATE 23505 after
 * a partial write has already been attempted, and its message names an index. Caught here, the
 * caller is told which of their two rows is the duplicate.
 */
export class DuplicatePrincipalError extends Error {
  constructor(readonly principal: string) {
    super(`the request names ${principal} twice; one node holds one row per principal`);
    this.name = 'DuplicatePrincipalError';
  }
}

/** Which node the caller is asking about. The two id spaces are kept apart deliberately. */
export type NodeRef = { kind: 'entry'; id: string } | { kind: 'share'; id: string };

/** Who is asking. `isAdmin` is §6.1's organisation administrator, which is outside the grant walk. */
export interface Actor {
  userId: string;
  isAdmin: boolean;
}

/** One row of the request body, after validation but before it becomes SQL. */
export interface GrantInput {
  userId: string | null;
  teamId: string | null;
  permissions: readonly Permission[];
}

export interface GrantView {
  userId: string | null;
  teamId: string | null;
  displayName: string;
  permissions: Permission[];
}

export interface FolderPermissionsView {
  effective: Permission[];
  inheritedFrom: string | null;
  grants: GrantView[];
  canManage: boolean;
}

export interface AffectedUserView {
  userId: string;
  username: string;
  before: Permission[];
  after: Permission[];
}

export interface ImpactView {
  foldersAffected: number;
  usersGaining: AffectedUserView[];
  usersLosing: AffectedUserView[];
}

export interface WriteResultView {
  applied: boolean;
  impact: ImpactView;
  applyingJobId: string | null;
}

/** A node as the tree queries return it, before grants are attached. */
interface NodeRow {
  id: string;
  parent_id: string | null;
}

interface GrantRow {
  entry_id: string | null;
  user_id: string | null;
  team_id: string | null;
  permissions: string[];
}

interface SubjectRow {
  id: string;
  username: string;
  role: string;
  team_ids: string[];
}

/** The node a request names, resolved to the pair every query below needs. */
interface Target {
  shareId: string;
  /** NULL is the share root, exactly as in `folder_grants.entry_id`. */
  entryId: string | null;
  isFolder: boolean;
}

@Injectable()
export class PermissionsService {
  private readonly logger = new Logger(PermissionsService.name);

  constructor(
    private readonly db: DbService,
    private readonly jobs: JobsService,
    private readonly agent: AgentService,
  ) {}

  /**
   * What the caller may do here, where it comes from, and — only for someone who may manage it —
   * the rows written at this node.
   */
  async read(organizationId: string, actor: Actor, ref: NodeRef): Promise<FolderPermissionsView> {
    return this.db.withTenant(organizationId, async (q) => {
      const target = await locate(q, organizationId, ref);
      const ancestors = await ancestorRows(q, organizationId, target);
      const nodeKey = target.entryId ?? target.shareId;

      const grants = await grantRows(
        q,
        organizationId,
        target.shareId,
        ancestors.map((row) => row.id),
      );
      const chain = buildChain(target.shareId, ancestors, groupGrants(grants, target.shareId));

      const subject = await subjectOf(q, organizationId, actor.userId);
      const resolution = resolve({ chain, subject });

      const canManage = actor.isAdmin || resolution.effective.has('manage');

      // The pre-§6.2 fallback, asked here for the same reason `FilesService` asks it: on an
      // appliance where nobody has written a grant yet, `GET /files` serves these seven and this
      // endpoint has to say so. Reporting the empty set that ADR-0021's walk returns would make
      // the one endpoint whose job is to explain access the only one that gets it wrong.
      //
      // It does not reach `canManage`, and cannot: `LEGACY_OPEN_SHARE` has no `manage` in it, so
      // the first grant of a share stays an administrator's to write (ADR-0021 §5). `write` below
      // therefore needs no matching branch — the walk it does already refuses everyone but them.
      const governed = actor.isAdmin || (await shareIsGoverned(q, organizationId, target.shareId));

      // Deliberately not `resolution.nearestSourceNodeId` for an administrator. Their full set
      // comes from §6.1's hierarchy and from no node at all, and naming one here would send them
      // to delete a row that is not what is granting them access. Nor for the fallback, which
      // stands in for a row no migration wrote: there is no node to send anyone to.
      const inheritedFrom = actor.isAdmin || !governed ? null : resolution.nearestSourceNodeId;

      const effective = actor.isAdmin
        ? new Set(PERMISSIONS)
        : governed
          ? resolution.effective
          : new Set(LEGACY_OPEN_SHARE);

      // The same rule `requirePermission` applies in `files.controller.ts`, and it has to be
      // applied here too or this becomes the one route that confirms an id. Every other endpoint
      // hides a node the caller cannot `list`; this one used to answer 200 with an empty set,
      // which tells a member probing uuids exactly which of them name folders in their tenant and
      // which name nothing — the distinction RLS and that 404 exist to erase.
      //
      // A SHARE root is exempt for the same reason `concealable` is false there: it is named by no
      // entry id and hidden from nobody, and `locate` has already refused another tenant's share.
      if (ref.kind === 'entry' && !effective.has('list')) throw new NodeNotFoundError();

      const here = grants.filter((row) => (row.entry_id ?? target.shareId) === nodeKey);
      return {
        effective: [...sortPermissions(effective)],
        inheritedFrom,
        // Empty for anyone without `manage`, and empty rather than absent: who can reach what is
        // itself information, and seeing it is a permission of its own (§6.2, ADR-0021).
        grants: canManage ? await describeGrants(q, organizationId, here) : [],
        canManage,
      };
    });
  }

  /**
   * Replace every explicit grant at one node, or say what replacing them would do.
   *
   * The body is the WHOLE set at this node. Merging would mean two administrators editing the same
   * folder each write half a list and neither sees the other's half; an empty array is therefore
   * how a node's grants are removed, which also puts inheritance back in force.
   */
  async write(
    organizationId: string,
    actor: Actor,
    ref: NodeRef,
    proposed: readonly GrantInput[],
    dryRun: boolean,
  ): Promise<WriteResultView> {
    const written = await this.db.withTenant(organizationId, async (q) => {
      const target = await locate(q, organizationId, ref);
      if (!target.isFolder) throw new NotAFolderError();

      const nodeKey = target.entryId ?? target.shareId;
      const ancestors = await ancestorRows(q, organizationId, target);

      // Bounded before anything expensive runs: past the limit the numbers below describe the
      // nearest slice of the subtree rather than all of it, and `foldersAffected` says so by
      // reporting the whole subtree instead of the sample.
      const subtree = await subtreeRows(q, organizationId, target);

      const treeIds = [...ancestors.map((row) => row.id), ...subtree.nodes.map((row) => row.id)];
      const grants = await grantRows(q, organizationId, target.shareId, treeIds);
      const before = groupGrants(grants, target.shareId);

      const governedBefore = await shareIsGoverned(q, organizationId, target.shareId);

      // Authority is decided on the tree as it stands, never on the tree the caller proposes: a
      // body that grants the caller `manage` must not be what admits the body.
      if (!actor.isAdmin) {
        const chain = buildChain(target.shareId, ancestors, before);
        const subject = await subjectOf(q, organizationId, actor.userId);
        const effective = governedBefore
          ? resolve({ chain, subject }).effective
          : new Set(LEGACY_OPEN_SHARE);
        // Before `manage`, and that order is the whole point. `NotManageableError`'s docstring
        // justifies its 403 with "the caller has already been told the node exists"; until this
        // line nothing checked that, so a node the caller cannot list answered 403 and confirmed
        // the id. Now an invisible node is 404 and only a visible-but-unmanageable one is 403,
        // which is the honest refusal that error describes.
        if (ref.kind === 'entry' && !effective.has('list')) throw new NodeNotFoundError();
        if (!effective.has('manage')) throw new NotManageableError();
      }

      await assertPrincipalsExist(q, organizationId, proposed);

      const after = new Map(before);
      after.set(
        nodeKey,
        proposed.map((grant): Grant => ({
          principal:
            grant.userId === null
              ? { kind: 'team', id: grant.teamId ?? '' }
              : { kind: 'user', id: grant.userId },
          permissions: grant.permissions,
        })),
      );

      // Which side of `LEGACY_OPEN_SHARE` the share is on after this write. The rows this body does
      // NOT touch are counted rather than inferred: the DELETE below clears exactly one node, so
      // "will anything be left" is a question about the rest of the share.
      const elsewhere = await grantsElsewhere(q, organizationId, target.shareId, nodeKey);
      const governedAfter = elsewhere > 0 || proposed.length > 0;
      // Refused on a dry run too. The preview exists to be trusted, and a preview of a write that
      // cannot happen is a worse answer than the refusal itself.
      if (governedBefore && !governedAfter) throw new LastGrantError();

      const subjects = await impactSubjects(q, organizationId);

      // CROSSING THE FALLBACK BOUNDARY IS THE BIGGEST PERMISSION CHANGE THE APPLIANCE CAN MAKE, and
      // it is the one the diff below cannot see on its own: `before` and `after` are built from
      // grant ROWS, and while a share is ungoverned the rows are not what anybody's access comes
      // from. Writing the first grant of a share therefore takes the pre-§6.2 seven away from every
      // other member across the WHOLE share, and an unaugmented preview reports `usersLosing: []`
      // on precisely that click. So the ungoverned side of the diff is seeded with the same
      // synthetic root grant `FilesService.syntheticGrants` attaches at request time, and the folder
      // scope widens from the target's subtree to the share's, because the change reaches folders
      // the target is not an ancestor of.
      //
      // Only one direction survives here — the other is `LastGrantError` above.
      const crossing = !governedBefore && governedAfter;
      const impactSubtree = crossing
        ? await subtreeRows(q, organizationId, {
            shareId: target.shareId,
            entryId: null,
            isFolder: true,
          })
        : subtree;
      const impact = impactOf({
        shareId: target.shareId,
        nodeKey,
        ancestors,
        subtree: impactSubtree,
        includeShareRoot: crossing,
        before: crossing ? withLegacyFallback(before, target.shareId, subjects.subjects) : before,
        after,
        subjects,
      });

      if (impact.truncated) {
        this.logger.warn(
          `dry-run for ${nodeKey} resolved ${IMPACT_FOLDER_LIMIT} of ${impact.view.foldersAffected} ` +
            `folders; foldersAffected is the whole subtree and the user lists are from the ` +
            `nearest folders only`,
        );
      }

      if (dryRun) return { impact: impact.view, target, changed: false };

      await q.query(
        `DELETE FROM public.folder_grants
          WHERE organization_id = $1 AND share_id = $2
            AND coalesce(entry_id, share_id) = $3`,
        [organizationId, target.shareId, nodeKey],
      );

      for (const grant of proposed) {
        await q.query(
          `INSERT INTO public.folder_grants
             (organization_id, share_id, entry_id, user_id, team_id, permissions, granted_by)
           VALUES ($1, $2, $3, $4, $5, $6::public.folder_permission[], $7)`,
          [
            organizationId,
            target.shareId,
            target.entryId,
            grant.userId,
            grant.teamId,
            [...grant.permissions],
            actor.userId,
          ],
        );
      }

      return { impact: impact.view, target, changed: true };
    });

    if (!written.changed) {
      return { applied: false, impact: written.impact, applyingJobId: null };
    }

    return {
      applied: true,
      impact: written.impact,
      applyingJobId: await this.enqueueApply(organizationId, written.target),
    };
  }

  /**
   * Queue the POSIX re-application, or report honestly that it did not happen.
   *
   * The grants are already committed at this point and that ordering is deliberate: ADR-0021 takes
   * the debt of a window in which the application layer is right and the filesystem is behind,
   * because the alternative — refusing the permission change because a daemon is down — leaves the
   * administrator with no way to close access at all.
   *
   * `null` is therefore a real answer and not an error path. The contract says the interface must
   * show it rather than pretend the change landed everywhere, because a folder that still opens
   * over SMB while the web says it is closed is the one failure §6.2 forbids by name.
   */
  private async enqueueApply(organizationId: string, target: Target): Promise<string | null> {
    if (!this.agent.isAvailable()) {
      this.logger.warn(
        `wrote grants for share ${target.shareId} with the agent unreachable: the POSIX ACLs ` +
          `under ${target.entryId ?? 'the share root'} are now stale`,
      );
      return null;
    }
    try {
      return await this.jobs.enqueue(organizationId, APPLY_ACL_KIND, {
        shareId: target.shareId,
        // NULL is the share root, the same convention as the column this came from. The job
        // re-reads the grants when it runs rather than carrying them: by then they may have been
        // changed again, and the newer answer is the right one to apply.
        entryId: target.entryId,
      });
    } catch (error) {
      this.logger.error(
        `grants for share ${target.shareId} were written but the apply job could not be ` +
          `queued: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}

// ─── the tree ─────────────────────────────────────────────────────────────────

async function locate(q: TenantQuery, organizationId: string, ref: NodeRef): Promise<Target> {
  if (ref.kind === 'share') {
    const rows = await q.query<{ id: string }>(
      `SELECT id::text AS id FROM public.shares WHERE organization_id = $1 AND id = $2`,
      [organizationId, ref.id],
    );
    const row = rows[0];
    if (row === undefined) throw new NodeNotFoundError();
    return { shareId: row.id, entryId: null, isFolder: true };
  }

  const rows = await q.query<{ id: string; share_id: string; kind: string }>(
    `SELECT id::text AS id, share_id::text AS share_id, kind
       FROM public.file_entries
      WHERE organization_id = $1 AND id = $2`,
    [organizationId, ref.id],
  );
  const row = rows[0];
  if (row === undefined) throw new NodeNotFoundError();
  return { shareId: row.share_id, entryId: row.id, isFolder: row.kind === 'folder' };
}

/**
 * The `file_entries` rows from the top of the share down to the target, in that order.
 *
 * Empty when the target IS the share root — the root is not a row in this table, and the caller
 * adds it (see `buildChain`).
 *
 * `depth` bounds the recursion. `parent_id` describes a tree and a cycle cannot be created through
 * the API, but a recursive CTE meeting one does not return a wrong answer, it never returns at
 * all — and this query runs inside a request.
 */
async function ancestorRows(
  q: TenantQuery,
  organizationId: string,
  target: Target,
): Promise<NodeRow[]> {
  if (target.entryId === null) return [];

  const rows = await q.query<NodeRow & { depth: number }>(
    `WITH RECURSIVE up AS (
       SELECT e.id, e.parent_id, 0 AS depth
         FROM public.file_entries e
        WHERE e.organization_id = $1 AND e.id = $2
       UNION ALL
       SELECT p.id, p.parent_id, up.depth + 1
         FROM public.file_entries p
         JOIN up ON p.id = up.parent_id
        WHERE p.organization_id = $1 AND up.depth < $3
     )
     SELECT id::text AS id, parent_id::text AS parent_id, depth FROM up ORDER BY depth DESC`,
    [organizationId, target.entryId, MAX_TREE_DEPTH],
  );

  const top = rows[0];
  if (top === undefined) throw new NodeNotFoundError();
  if (top.parent_id !== null) {
    // The walk stopped before the root, so the grants above the cut would be silently missing and
    // the answer would be a NARROWER permission set that looks like a real one. Refusing is the
    // only honest outcome.
    throw new Error(
      `the ancestor chain of ${target.entryId} is deeper than ${MAX_TREE_DEPTH} folders`,
    );
  }
  return rows.map((row) => ({ id: row.id, parent_id: row.parent_id }));
}

interface Subtree {
  /** Descendant folders, breadth-first, capped at `IMPACT_FOLDER_LIMIT`. */
  nodes: NodeRow[];
  /** Every folder below the target, counted without the cap. */
  total: number;
  truncated: boolean;
}

/**
 * The folders under the target, breadth-first and bounded.
 *
 * Ordered by depth so the slice is PREFIX-CLOSED: a node's parent is always shallower and therefore
 * always inside the slice, which is what lets a chain be built for every node that came back.
 *
 * Only folders, and only untrashed ones. A file carries no default ACL and a trashed folder is not
 * somewhere anybody browses; counting either as "a folder this change reaches" would inflate the
 * one number an administrator is being asked to read.
 */
async function subtreeRows(
  q: TenantQuery,
  organizationId: string,
  target: Target,
): Promise<Subtree> {
  const rows = await q.query<NodeRow & { total: string; max_depth: number }>(
    `WITH RECURSIVE down AS (
       SELECT e.id, e.parent_id, 0 AS depth
         FROM public.file_entries e
        WHERE e.organization_id = $1 AND e.share_id = $2
          AND e.parent_id IS NOT DISTINCT FROM $3::uuid
          AND e.kind = 'folder' AND e.trashed_at IS NULL
       UNION ALL
       SELECT c.id, c.parent_id, down.depth + 1
         FROM public.file_entries c
         JOIN down ON c.parent_id = down.id
        WHERE c.organization_id = $1 AND c.kind = 'folder' AND c.trashed_at IS NULL
          AND down.depth < $4
     )
     SELECT id::text AS id, parent_id::text AS parent_id,
            count(*) OVER () AS total, max(depth) OVER () AS max_depth
       FROM down
      ORDER BY depth, id
      LIMIT $5`,
    [organizationId, target.shareId, target.entryId, MAX_TREE_DEPTH, IMPACT_FOLDER_LIMIT],
  );

  // `max(depth) OVER ()` is read from the CTE and not from the returned slice, which the LIMIT
  // could have cut before the deepest row. The recursion emits children while the parent's depth is
  // below the bound, so a row AT the bound means the walk stopped with descendants still below it —
  // and those folders would be missing from `total` as well as from the sample. `foldersAffected`
  // would then UNDER-report, which is the one direction this number must never go: it exists to
  // make an administrator hesitate. `ancestorRows` refuses its own depth cut for the same reason,
  // and this is the same refusal pointing the other way.
  const maxDepth = rows[0]?.max_depth ?? 0;
  if (maxDepth >= MAX_TREE_DEPTH) {
    throw new Error(
      `the subtree under ${target.entryId ?? 'the share root'} is deeper than ` +
        `${MAX_TREE_DEPTH} folders, so its size cannot be reported honestly`,
    );
  }

  // `count(*) OVER ()` is evaluated before LIMIT, so the true size is known even when the slice is
  // not the whole subtree. Without it the cap would be invisible and the number simply wrong.
  const total = rows.length === 0 ? 0 : Number(rows[0]?.total ?? '0');
  return {
    nodes: rows.map((row) => ({ id: row.id, parent_id: row.parent_id })),
    total,
    truncated: total > rows.length,
  };
}

/**
 * Does ADR-0021 decide this share yet, or is it still on the pre-§6.2 fallback?
 *
 * Asked of the WHOLE share and not of the chain, which is the half `LEGACY_OPEN_SHARE` explains:
 * one grant anywhere switches the model on for everything, so that the first person to restrict a
 * folder does not leave the rest of the tree open behind them. An existence test rather than a
 * count — the number is never used and `LIMIT 1` lets the index stop at the first row.
 */
async function shareIsGoverned(
  q: TenantQuery,
  organizationId: string,
  shareId: string,
): Promise<boolean> {
  const rows = await q.query<{ one: number }>(
    `SELECT 1 AS one
       FROM public.folder_grants
      WHERE organization_id = $1 AND share_id = $2
      LIMIT 1`,
    [organizationId, shareId],
  );
  return rows.length > 0;
}

/**
 * How many grant rows this share holds at nodes OTHER than `nodeKey`.
 *
 * `write` replaces one node's rows wholesale, so this is what decides whether the share still has
 * a rule in it once the DELETE has run. Counted rather than existence-tested because the number is
 * nothing but an input to a boolean — but a `LIMIT 1` here would need the same shape anyway, and a
 * count of a share's grants is bounded by what an administrator wrote by hand.
 */
async function grantsElsewhere(
  q: TenantQuery,
  organizationId: string,
  shareId: string,
  nodeKey: string,
): Promise<number> {
  const rows = await q.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM public.folder_grants
      WHERE organization_id = $1 AND share_id = $2
        AND coalesce(entry_id, share_id) <> $3`,
    [organizationId, shareId, nodeKey],
  );
  return Number(rows[0]?.n ?? '0');
}

/**
 * The grant map an UNGOVERNED share actually behaves like, for the dry-run to diff against.
 *
 * The same shape `FilesService.syntheticGrants` builds at request time and for the same reason: the
 * fallback stands in for a share-wide default row that no migration wrote, so it hangs off the
 * share root and names each member individually. Placed BEFORE any real row at that node, matching
 * the live path — though in an ungoverned share there are no real rows for it to precede.
 */
function withLegacyFallback(
  grants: ReadonlyMap<string, readonly Grant[]>,
  shareId: string,
  subjects: readonly Subject[],
): Map<string, Grant[]> {
  const seeded = new Map<string, Grant[]>();
  for (const [key, list] of grants) seeded.set(key, [...list]);
  seeded.set(shareId, [
    ...subjects.map((subject): Grant => ({
      principal: { kind: 'user', id: subject.userId },
      permissions: LEGACY_OPEN_SHARE,
    })),
    ...(grants.get(shareId) ?? []),
  ]);
  return seeded;
}

async function grantRows(
  q: TenantQuery,
  organizationId: string,
  shareId: string,
  entryIds: readonly string[],
): Promise<GrantRow[]> {
  return q.query<GrantRow>(
    `SELECT entry_id::text AS entry_id, user_id::text AS user_id, team_id::text AS team_id,
            permissions::text[] AS permissions
       FROM public.folder_grants
      WHERE organization_id = $1 AND share_id = $2
        AND (entry_id IS NULL OR entry_id = ANY($3::uuid[]))`,
    [organizationId, shareId, [...entryIds]],
  );
}

/**
 * Index the grant rows by the node they sit on, with the share root keyed under the SHARE's id.
 *
 * `entry_id IS NULL` and "the share root" are the same node; giving it the share's id is what lets
 * one walk cover both cases, and what makes `inheritedFrom` name something a client can look up.
 */
function groupGrants(rows: readonly GrantRow[], shareId: string): Map<string, Grant[]> {
  const byNode = new Map<string, Grant[]>();
  for (const row of rows) {
    const key = row.entry_id ?? shareId;
    const list = byNode.get(key) ?? [];
    list.push({
      principal:
        row.user_id === null
          ? { kind: 'team', id: row.team_id ?? '' }
          : { kind: 'user', id: row.user_id },
      permissions: readPermissions(row.permissions),
    });
    byNode.set(key, list);
  }
  return byNode;
}

/**
 * Turn the database's `folder_permission[]` into the package's vocabulary.
 *
 * A value the build does not know is thrown on rather than dropped. ADR-0021 made the enum and
 * `FolderPermission` the authority and bound this package to them, so a mismatch means a schema
 * newer than this binary — and quietly dropping the permission would answer with a narrower set
 * that looks exactly like a real one.
 */
function readPermissions(values: readonly string[]): Permission[] {
  return values.map((value) => {
    if (!isPermission(value)) {
      throw new Error(`the database holds a permission this build does not know: ${value}`);
    }
    return value;
  });
}

/** Root-first `AclNode`s, the share root prepended and every entry's parent linked to it. */
function buildChain(
  shareId: string,
  ancestors: readonly NodeRow[],
  grants: ReadonlyMap<string, readonly Grant[]>,
): AclNode[] {
  const chain: AclNode[] = [{ id: shareId, parentId: null, grants: grants.get(shareId) ?? [] }];
  for (const row of ancestors) {
    chain.push({
      id: row.id,
      // A row directly under the share root has `parent_id NULL`, and in the ACL tree its parent is
      // the share. Leaving it null would make it look like a second root and `resolve` would refuse
      // the chain.
      parentId: row.parent_id ?? shareId,
      grants: grants.get(row.id) ?? [],
    });
  }
  return chain;
}

// ─── subjects ─────────────────────────────────────────────────────────────────

async function subjectOf(q: TenantQuery, organizationId: string, userId: string): Promise<Subject> {
  const rows = await q.query<{ team_id: string }>(
    `SELECT team_id::text AS team_id FROM public.team_members
      WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, userId],
  );
  return { userId, teamIds: rows.map((row) => row.team_id) };
}

interface ImpactSubjects {
  subjects: Subject[];
  usernames: Map<string, string>;
}

/**
 * Everyone whose access this change could move, with their team memberships.
 *
 * Administrators are left OUT, and not as an optimisation: §6.1 gives them everything everywhere,
 * so their effective set is the same before and after by definition. Feeding them to the resolver
 * would compute a diff from the grants alone and report an administrator "losing" access they
 * never lose.
 *
 * Disabled accounts are kept IN. The grant is on the account, so re-enabling it hands over the
 * access with no second permission change — and a preview that hid them would understate the
 * radius of exactly the click this preview exists to explain.
 */
async function impactSubjects(q: TenantQuery, organizationId: string): Promise<ImpactSubjects> {
  const rows = await q.query<SubjectRow>(
    `SELECT u.id::text AS id, u.username, u.role,
            coalesce(
              array_agg(tm.team_id::text) FILTER (WHERE tm.team_id IS NOT NULL),
              ARRAY[]::text[]
            ) AS team_ids
       FROM public.users u
       LEFT JOIN public.team_members tm
              ON tm.user_id = u.id AND tm.organization_id = u.organization_id
      WHERE u.organization_id = $1
      GROUP BY u.id, u.username, u.role`,
    [organizationId],
  );

  const subjects: Subject[] = [];
  const usernames = new Map<string, string>();
  for (const row of rows) {
    usernames.set(row.id, row.username);
    if (row.role === 'admin') continue;
    subjects.push({ userId: row.id, teamIds: row.team_ids });
  }
  return { subjects, usernames };
}

async function describeGrants(
  q: TenantQuery,
  organizationId: string,
  rows: readonly GrantRow[],
): Promise<GrantView[]> {
  if (rows.length === 0) return [];

  const userIds = rows.map((row) => row.user_id).filter((id): id is string => id !== null);
  const teamIds = rows.map((row) => row.team_id).filter((id): id is string => id !== null);

  const names = new Map<string, string>();
  if (userIds.length > 0) {
    const found = await q.query<{ id: string; username: string }>(
      `SELECT id::text AS id, username FROM public.users
        WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
      [organizationId, userIds],
    );
    for (const row of found) names.set(row.id, row.username);
  }
  if (teamIds.length > 0) {
    const found = await q.query<{ id: string; name: string }>(
      `SELECT id::text AS id, name FROM public.teams
        WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
      [organizationId, teamIds],
    );
    for (const row of found) names.set(row.id, row.name);
  }

  return rows.map((row) => {
    const id = row.user_id ?? row.team_id ?? '';
    return {
      userId: row.user_id,
      teamId: row.team_id,
      // A grant whose principal has no name is a grant whose row survived its owner, which the
      // foreign keys make impossible — but a blank string in a UI list is worse than a marker
      // somebody can search the logs for.
      displayName: names.get(id) ?? '(unknown)',
      permissions: readPermissions(row.permissions),
    };
  });
}

/**
 * Every user and team the body names has to be in this tenant.
 *
 * RLS makes the lookup answer "not in this organisation" and "does not exist" identically, which is
 * the right answer to give back: a 422 that distinguished them would tell one tenant which ids
 * exist in another. The foreign keys would also refuse, as SQLSTATE 23503 with a constraint name;
 * this turns it into a sentence naming the id the caller got wrong.
 */
async function assertPrincipalsExist(
  q: TenantQuery,
  organizationId: string,
  proposed: readonly GrantInput[],
): Promise<void> {
  const userIds = proposed.map((g) => g.userId).filter((id): id is string => id !== null);
  const teamIds = proposed.map((g) => g.teamId).filter((id): id is string => id !== null);

  const missing: string[] = [];
  if (userIds.length > 0) {
    const found = await q.query<{ id: string }>(
      `SELECT id::text AS id FROM public.users WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
      [organizationId, userIds],
    );
    const seen = new Set(found.map((row) => row.id));
    missing.push(...userIds.filter((id) => !seen.has(id)));
  }
  if (teamIds.length > 0) {
    const found = await q.query<{ id: string }>(
      `SELECT id::text AS id FROM public.teams WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
      [organizationId, teamIds],
    );
    const seen = new Set(found.map((row) => row.id));
    missing.push(...teamIds.filter((id) => !seen.has(id)));
  }

  if (missing.length > 0) throw new UnknownPrincipalError(missing);
}

// ─── the dry-run ──────────────────────────────────────────────────────────────

interface ImpactRequest {
  shareId: string;
  nodeKey: string;
  ancestors: readonly NodeRow[];
  subtree: Subtree;
  /**
   * Resolve the share root as well, because the change reaches it.
   *
   * True only when the write crosses the `LEGACY_OPEN_SHARE` boundary: the subtree then covers the
   * whole share and the root is a folder in it, but `nodeKey` may be an entry somewhere inside, so
   * the root would otherwise be the one node nobody asked about.
   */
  includeShareRoot: boolean;
  before: ReadonlyMap<string, readonly Grant[]>;
  after: ReadonlyMap<string, readonly Grant[]>;
  subjects: ImpactSubjects;
}

/**
 * What the change does to the whole subtree, per §6.2's dry-run requirement.
 *
 * The changed node comes FIRST and the descendants follow breadth-first, because `aggregateImpact`
 * reports each user from the shallowest folder where their set moved — which under ADR-0021's
 * nearest-ancestor rule is the node the change was written on.
 *
 * When the subtree was capped (see `IMPACT_FOLDER_LIMIT`), `foldersAffected` is reported as the
 * size of the whole subtree rather than of the resolved slice. That over-reports: some of those
 * folders carry their own grants and are not affected at all. It is the deliberate direction — the
 * contract has no field for "approximately", and a number that under-reports the radius of a
 * permission change is the one that gets somebody hurt.
 */
function impactOf(request: ImpactRequest): { view: ImpactView; truncated: boolean } {
  const { shareId, nodeKey, ancestors, subtree, includeShareRoot, before, after, subjects } =
    request;

  const parents = new Map<string, string | null>();
  parents.set(shareId, null);
  for (const row of ancestors) parents.set(row.id, row.parent_id ?? shareId);
  for (const row of subtree.nodes) parents.set(row.id, row.parent_id ?? shareId);

  // Deduplicated, because a share-wide walk contains `nodeKey` as well, and resolving one folder
  // twice would count it twice in `foldersAffected`.
  const targets = [
    ...new Set([
      nodeKey,
      ...(includeShareRoot ? [shareId] : []),
      ...subtree.nodes.map((row) => row.id),
    ]),
  ];

  const folders: FolderImpact[] = [];
  for (const id of targets) {
    folders.push(
      resolveImpact({
        before: chainTo(id, parents, before),
        after: chainTo(id, parents, after),
        subjects: subjects.subjects,
      }),
    );
  }

  const rolled = aggregateImpact(folders);
  return {
    view: {
      foldersAffected: subtree.truncated ? subtree.total + 1 : rolled.foldersAffected,
      usersGaining: rolled.usersGaining.map((user) => name(user, subjects.usernames)),
      usersLosing: rolled.usersLosing.map((user) => name(user, subjects.usernames)),
    },
    truncated: subtree.truncated,
  };
}

/** Walk `parents` up from `id` and hand back the chain root-first, with grants attached. */
function chainTo(
  id: string,
  parents: ReadonlyMap<string, string | null>,
  grants: ReadonlyMap<string, readonly Grant[]>,
): AclNode[] {
  const reversed: AclNode[] = [];
  let cursor: string | null = id;
  while (cursor !== null) {
    const parent: string | null | undefined = parents.get(cursor);
    if (parent === undefined) {
      // Only reachable if the subtree slice were not prefix-closed. It is — the rows come back
      // ordered by depth — and saying so loudly beats resolving a chain with a hole in it.
      throw new Error(`node ${cursor} has no parent in the loaded tree`);
    }
    reversed.push({ id: cursor, parentId: parent, grants: grants.get(cursor) ?? [] });
    cursor = parent;
  }
  return reversed.reverse();
}

function name(user: UserImpact, usernames: ReadonlyMap<string, string>): AffectedUserView {
  return {
    userId: user.userId,
    username: usernames.get(user.userId) ?? '(unknown)',
    before: [...user.before],
    after: [...user.after],
  };
}
