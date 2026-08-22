import { Injectable, Logger } from '@nestjs/common';
import {
  nearestGrant,
  isPermission,
  type AclNode,
  type Grant,
  type Permission,
} from '@depsis/authz';

import { AgentService, expectStatus } from '../agent/agent.service.js';
import { DbService, type TenantQuery } from '../db/db.service.js';
import { PosixIdentityService } from '../identity/posix.service.js';

/**
 * THE OTHER HALF OF §6.2: putting a grant onto the filesystem.
 *
 * Until this existed, `PermissionsService.enqueueApply` wrote a `permissions.apply` row that no
 * process consumed. Every grant landed in Postgres, `applyingJobId` named a real uuid, the
 * interface could truthfully say "izinler uygulanıyor" — and the kernel was never told anything.
 * That is the two-realities failure ADR-0004 and §6.2 forbid by name, with the web claiming a
 * folder is shared and SMB refusing to open it.
 *
 * WHY IT IS A LOOP HERE AND NOT ONE CALL. `ApplyFolderAcl` is deliberately not recursive
 * (`services/system-agent/src/acl.rs` gives three reasons, one of them a closed root escalation),
 * and the agent has no way to read `folder_grants`. So the API is the side that knows the tree and
 * the API is the side that walks it: one call per folder, each carrying the entries THAT folder
 * resolves to. That is also what makes a narrower grant on a subfolder survive — a recursive apply
 * would overwrite it with the parent's, which is the widening direction.
 *
 * WHY IT IS IN THE API PACKAGE AND RUN FROM THE WORKER. The rule, the tenant chokepoint and the
 * agent client all live here; `apps/worker` reaches them through `worker-surface`. A copy of the
 * inheritance walk inside the worker would be a second implementation of ADR-0021, and the failure
 * mode of two implementations of a permission rule is that the enforced answer and the applied
 * answer drift apart without either side looking wrong.
 *
 * IDEMPOTENT, which §17 requires of every job: it reads the grants as they are NOW and writes an
 * absolute ACL per folder. Running it twice writes the same thing twice; running it after a newer
 * grant lands applies the newer answer, which is the right one.
 */

/** The `permissions.apply` payload, as `PermissionsService.enqueueApply` writes it. */
export interface ApplyAclPayload {
  shareId: string;
  /** NULL is the share root, the same convention as `folder_grants.entry_id`. */
  entryId: string | null;
}

/**
 * How many folders one job will rewrite.
 *
 * A bound rather than a promise to finish: a share with a hundred thousand folders is one job
 * holding a lease and one agent connection for hours, and the agent takes one connection at a time
 * for the whole appliance. Past this the job fails loudly with the count, because a silent partial
 * application is the divergence this class exists to close.
 */
const APPLY_FOLDER_LIMIT = 5000;

/** The same depth bound the permission walk uses, for the same reason: a cycle must not hang. */
const MAX_TREE_DEPTH = 256;

/** One folder's ACL, before the numbers are looked up. */
interface ResolvedEntry {
  principal: { kind: 'user' | 'team'; id: string };
  read: boolean;
  write: boolean;
  execute: boolean;
}

interface FolderRow {
  id: string;
  parent_id: string | null;
  parts: string[];
}

/**
 * The share's folders, split into the two roles they play.
 *
 * `all` is the tree the resolver walks — the whole share, because the ACL of a folder inside the
 * named subtree depends on the grants ABOVE it as much as on its own. `written` is the subset the
 * job actually rewrites. Loading only the subtree was the first version and it was wrong in the
 * quiet way: the chain could not reach the share root, so every folder resolved against a tree with
 * a hole in it.
 */
interface Folders {
  all: FolderRow[];
  written: string[];
}

interface GrantRow {
  entry_id: string | null;
  user_id: string | null;
  team_id: string | null;
  permissions: string[];
}

@Injectable()
export class AclApplyService {
  private readonly logger = new Logger(AclApplyService.name);

  constructor(
    private readonly db: DbService,
    private readonly agent: AgentService,
    private readonly posix: PosixIdentityService,
  ) {}

  /**
   * Rewrite the POSIX ACL of every folder at or under `entryId`, from the grants as they stand.
   *
   * The reads all happen first and the agent calls afterwards, outside the transaction. A
   * transaction held open across an unbounded number of round trips to a daemon that serialises
   * them is a transaction that outlives its usefulness, and nothing here writes to the database.
   */
  async apply(organizationId: string, payload: ApplyAclPayload, reason: string): Promise<void> {
    const plan = await this.db.withTenant(organizationId, async (q) => {
      const share = await shareName(q, organizationId, payload.shareId);
      const folders = await folderRows(q, organizationId, payload);
      const grants = await grantRows(q, organizationId, payload.shareId);
      return { share, folders, grants };
    });

    // The share root is a node like any other and `folder_grants.entry_id IS NULL` attaches to it,
    // so the ACL tree is keyed by the SHARE's id at the top — the same convention the resolver is
    // fed everywhere else in this module.
    const parents = new Map<string, string | null>([[payload.shareId, null]]);
    const partsOf = new Map<string, string[]>([[payload.shareId, []]]);
    for (const row of plan.folders.all) {
      parents.set(row.id, row.parent_id ?? payload.shareId);
      partsOf.set(row.id, row.parts);
    }

    const granted = new Map<string, Grant[]>();
    for (const row of plan.grants) {
      const principal = principalOf(row);
      if (principal === null) continue;
      // Dropped rather than thrown on, unlike `PermissionsService.readPermissions`, and the
      // asymmetry is deliberate: there the narrowed set would be REPORTED as if it were real and
      // an administrator would write it back. Here the consequence of a permission this build does
      // not know is a bit not set on disk, which is the safe direction ADR-0021 §3 names.
      const permissions = row.permissions.filter(isPermission);
      if (permissions.length === 0) continue;
      const key = row.entry_id ?? payload.shareId;
      const list = granted.get(key);
      if (list === undefined) granted.set(key, [{ principal, permissions }]);
      else list.push({ principal, permissions });
    }

    // Every principal any grant in this share names. A folder's ACL has to be able to say
    // "not you" as an ABSENCE, so the candidate list is share-wide and each folder keeps only the
    // ones the inheritance walk actually gives something to.
    const principals = [...new Set(plan.grants.map(keyOf).filter((key) => key !== null))].map(
      unkey,
    );

    // The share root is written only when the job names it. A job aimed at one entry rewrites that
    // entry's subtree; the root's own ACL is not part of it and overwriting it would widen or
    // narrow a folder nobody asked about.
    const targets =
      payload.entryId === null ? [payload.shareId, ...plan.folders.written] : plan.folders.written;

    const failures: string[] = [];
    for (const nodeId of targets) {
      const chain = chainTo(nodeId, payload.shareId, parents, granted);
      if (chain === null) {
        // A folder whose parent is missing from the loaded tree cannot be resolved, and guessing
        // would mean writing an ACL derived from a chain with a hole in it.
        failures.push(`${nodeId}: not reachable from the share root`);
        continue;
      }
      const resolved = principals
        .map((principal) => aclFor(chain, principal))
        .filter((entry): entry is ResolvedEntry => entry !== null);

      try {
        await this.applyOne(
          organizationId,
          plan.share,
          partsOf.get(nodeId) ?? [],
          resolved,
          reason,
        );
      } catch (error) {
        failures.push(`${nodeId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (failures.length > 0) {
      // The job fails so the queue records it and retries; the ones that succeeded stay applied,
      // which is safe because each call writes an absolute ACL for one folder.
      throw new Error(
        `${failures.length} of ${targets.length} folder(s) in share ${payload.shareId} could not ` +
          `be applied: ${failures.slice(0, 5).join('; ')}`,
      );
    }
  }

  /** One folder: turn principals into numbers, and send it. */
  private async applyOne(
    organizationId: string,
    share: string,
    path: readonly string[],
    resolved: readonly ResolvedEntry[],
    reason: string,
  ): Promise<void> {
    const entries: Array<{ gid: number; read: boolean; write: boolean; execute: boolean }> = [];
    for (const entry of resolved) {
      const gid = await this.gidFor(organizationId, entry.principal);
      if (gid === null) continue;
      entries.push({ gid, read: entry.read, write: entry.write, execute: entry.execute });
    }

    expectStatus(
      // No correlation id of the request that caused this — by the time the job runs, that
      // request is long over, so `AgentService` mints one and the job's `reason` is what ties the
      // agent's audit line back to who asked.
      await this.agent.call({ op: 'apply_folder_acl', share, path: [...path], entries }, reason),
      'acl_applied',
    );
  }

  /**
   * The number an ACL entry names, or null when there is not one yet.
   *
   * ADR-0004: entries go to GROUPS. A grant to a person therefore names that person's own private
   * group, which is their uid — migration 0015 allocates user uids and team gids from ONE counter
   * precisely so a uid can be used as a group id without colliding with a team's.
   *
   * `posixUidFor` allocates on first need, so a grant to an account that has never uploaded still
   * reaches disk. A team's gid is written when the team is created and can only be null for a team
   * that predates migration 0015; that entry is skipped with a line in the journal rather than
   * allocated here, because a background job quietly minting identities is a decision that should
   * be made where it can be seen.
   */
  private async gidFor(
    organizationId: string,
    principal: { kind: 'user' | 'team'; id: string },
  ): Promise<number | null> {
    if (principal.kind === 'user') {
      return this.posix.posixUidFor(organizationId, principal.id);
    }
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ posix_gid: number | null }>(
        `SELECT posix_gid FROM public.teams WHERE organization_id = $1 AND id = $2`,
        [organizationId, principal.id],
      ),
    );
    const gid = rows[0]?.posix_gid ?? null;
    if (gid === null) {
      this.logger.warn(
        `team ${principal.id} has no POSIX gid, so its grant is not reflected on the filesystem`,
      );
    }
    return gid;
  }
}

/**
 * §6.2's permissions as the three bits a directory actually has.
 *
 * `r` on a directory is "enumerate the names in it", which is `list` and nothing else. `w` is
 * "add, rename or remove names in it", which is any of the four that change its contents. `x` is
 * "traverse it", which every permission that reaches anything inside needs — including `read` and
 * `download`, which are about the FILES and would be unusable without it.
 *
 * A principal whose grant is only `manage`, `share`, `versions` or `audit` gets no entry at all:
 * those are DEPSIS concepts with no bit to carry them, and inventing one would hand out filesystem
 * access the grant never described. The ACL is a subset of the application's answer (ADR-0004),
 * never a superset.
 */
function aclFor(
  chain: readonly AclNode[],
  principal: ResolvedEntry['principal'],
): ResolvedEntry | null {
  const source = nearestGrant(chain, principal);
  if (source === null) return null;
  const has = (permission: Permission): boolean => source.permissions.includes(permission);

  const read = has('list');
  const write = has('create') || has('modify') || has('move') || has('delete');
  const execute = read || write || has('read') || has('download');
  if (!read && !write && !execute) return null;
  return { principal, read, write, execute };
}

async function shareName(q: TenantQuery, organizationId: string, shareId: string): Promise<string> {
  const rows = await q.query<{ name: string }>(
    `SELECT name FROM public.shares WHERE organization_id = $1 AND id = $2`,
    [organizationId, shareId],
  );
  const name = rows[0]?.name;
  // A share that is gone is not an error to retry: the job describes work that no longer has a
  // subject. It still fails, because a job that succeeds without doing anything is indistinguishable
  // from one that worked.
  if (name === undefined) throw new Error(`no such share: ${shareId}`);
  return name;
}

/**
 * Every folder of the share, with its path components, built from `parent_id` and never from
 * `path` (ADR-0005) — `path` is display text a rename job may be rewriting right now, and this
 * one is about to be handed to a privileged process as a filesystem location.
 *
 * The WHOLE share is loaded even when the job names one entry, because the ACL of a folder inside
 * that subtree depends on the grants ABOVE it too. Only the subtree is written; the rest is the
 * chain the resolver needs.
 *
 * Trashed folders are skipped. Their directories are still on disk — trashing sets a flag — but
 * they are not somewhere anybody browses, and a permanent delete removes them shortly after.
 */
async function folderRows(
  q: TenantQuery,
  organizationId: string,
  payload: ApplyAclPayload,
): Promise<Folders> {
  const rows = await q.query<FolderRow & { depth: number }>(
    `WITH RECURSIVE tree AS (
       SELECT e.id, e.parent_id, ARRAY[e.name]::text[] AS parts, 0 AS depth
         FROM public.file_entries e
        WHERE e.organization_id = $1 AND e.share_id = $2 AND e.parent_id IS NULL
          AND e.kind = 'folder' AND e.trashed_at IS NULL
       UNION ALL
       SELECT c.id, c.parent_id, tree.parts || c.name, tree.depth + 1
         FROM public.file_entries c
         JOIN tree ON c.parent_id = tree.id
        WHERE c.organization_id = $1 AND c.kind = 'folder' AND c.trashed_at IS NULL
          AND tree.depth < $3
     )
     SELECT id::text AS id, parent_id::text AS parent_id, parts, depth
       FROM tree
      ORDER BY depth, id
      LIMIT $4`,
    [organizationId, payload.shareId, MAX_TREE_DEPTH, APPLY_FOLDER_LIMIT],
  );
  if (rows.length >= APPLY_FOLDER_LIMIT) {
    throw new Error(
      `share ${payload.shareId} has at least ${APPLY_FOLDER_LIMIT} folders, which is more than ` +
        `one apply job will rewrite; the POSIX ACLs below it are stale`,
    );
  }

  const all = rows.map(strip);
  if (payload.entryId === null) return { all, written: all.map((row) => row.id) };

  // One entry named: keep the chain for resolution but write only its subtree. Membership is
  // decided by walking `parent_id` upward through the rows already loaded, so the answer comes
  // from the same tree the ACLs are resolved against.
  const parentOf = new Map(rows.map((row) => [row.id, row.parent_id]));
  const inSubtree = (id: string): boolean => {
    let cursor: string | null | undefined = id;
    for (let step = 0; cursor !== null && cursor !== undefined && step <= rows.length; step += 1) {
      if (cursor === payload.entryId) return true;
      cursor = parentOf.get(cursor);
    }
    return false;
  };
  return { all, written: all.filter((row) => inSubtree(row.id)).map((row) => row.id) };
}

function strip(row: FolderRow & { depth: number }): FolderRow {
  return { id: row.id, parent_id: row.parent_id, parts: row.parts };
}

async function grantRows(
  q: TenantQuery,
  organizationId: string,
  shareId: string,
): Promise<GrantRow[]> {
  return q.query<GrantRow>(
    `SELECT entry_id::text AS entry_id, user_id::text AS user_id, team_id::text AS team_id,
            permissions::text[] AS permissions
       FROM public.folder_grants
      WHERE organization_id = $1 AND share_id = $2`,
    [organizationId, shareId],
  );
}

function principalOf(row: GrantRow): Grant['principal'] | null {
  if (row.user_id !== null) return { kind: 'user', id: row.user_id };
  if (row.team_id !== null) return { kind: 'team', id: row.team_id };
  return null;
}

/** A principal as a map key, so `new Set` can dedupe it. */
function keyOf(row: GrantRow): string | null {
  if (row.user_id !== null) return `user:${row.user_id}`;
  if (row.team_id !== null) return `team:${row.team_id}`;
  return null;
}

function unkey(key: string): ResolvedEntry['principal'] {
  return key.startsWith('user:')
    ? { kind: 'user', id: key.slice(5) }
    : { kind: 'team', id: key.slice(5) };
}

/** Root-first chain, the share root synthesised as the node `entry_id IS NULL` hangs off. */
function chainTo(
  nodeId: string,
  shareId: string,
  parents: ReadonlyMap<string, string | null>,
  granted: ReadonlyMap<string, readonly Grant[]>,
): AclNode[] | null {
  const reversed: AclNode[] = [];
  let cursor: string | null = nodeId;
  for (let step = 0; cursor !== null; step += 1) {
    if (step > parents.size) return null;
    const parent: string | null | undefined = parents.get(cursor);
    if (parent === undefined) return null;
    reversed.push({ id: cursor, parentId: parent, grants: granted.get(cursor) ?? [] });
    cursor = parent;
  }
  const root = reversed[reversed.length - 1];
  if (root === undefined || root.id !== shareId) return null;
  return reversed.reverse();
}
