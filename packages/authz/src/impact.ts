import { sortPermissions, type AclNode, type Permission, type Subject } from './permissions.js';
import { resolve } from './resolve.js';

/**
 * Dry-run: who gains what, who loses what.
 *
 * §6.2 makes this mandatory — "Her izin değişimi dry-run ile etkilenecek kullanıcı/klasör
 * sayısını göstermeli" — and ADR-0021 says why it is not a nicety: inheritance reaches a whole
 * subtree, so "let me open this folder to the team" can open five hundred files the person
 * clicking never looked at.
 *
 * Like `resolve`, this is PURE. It takes the tree before and after the proposed write and
 * compares effective sets. It has no database, no usernames and no folder listing, because
 * both halves of a dry-run have to agree with the real answer, and the way to guarantee that
 * is to run the same resolver over hypothetical input rather than to re-derive the rule here.
 */

export interface ImpactInput {
  /** The chain as it is now, root-first, ending at the node whose grants are changing. */
  readonly before: readonly AclNode[];
  /** The same chain with the proposed grants in place. Must end at the same node. */
  readonly after: readonly AclNode[];
  /**
   * Every subject to evaluate, with its team memberships.
   *
   * The caller decides who is in scope — normally every member of the organization, since a
   * change can also affect someone who reaches the folder through a team they are in. A
   * subject listed twice is reported twice; the caller owns that list.
   */
  readonly subjects: readonly Subject[];
}

/** One user's effective set at one folder, before and after. Both are canonically ordered. */
export interface UserImpact {
  readonly userId: string;
  readonly before: readonly Permission[];
  readonly after: readonly Permission[];
}

export interface FolderImpact {
  readonly nodeId: string;
  /** Users who end up with at least one permission they did not have. */
  readonly gaining: readonly UserImpact[];
  /**
   * Users who lose at least one permission. A user who gains one thing and loses another
   * appears in BOTH lists on purpose: dropping the loss because there was also a gain hides
   * exactly the half an administrator has to stop and look at. Giving access back is cheap;
   * taking it away stops someone's work the moment it lands.
   */
  readonly losing: readonly UserImpact[];
}

/** The `PermissionImpact` numbers, minus the usernames the API layer joins in. */
export interface SubtreeImpact {
  readonly foldersAffected: number;
  readonly usersGaining: readonly UserImpact[];
  readonly usersLosing: readonly UserImpact[];
}

function byUserId(a: UserImpact, b: UserImpact): number {
  return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
}

function lastNodeId(chain: readonly AclNode[], side: string): string {
  const target = chain[chain.length - 1];
  if (target === undefined) {
    throw new Error(`the ${side} chain must contain at least the target node`);
  }
  return target.id;
}

/**
 * Compare one folder before and after a proposed change.
 *
 * Both chains describe the same node — a change is a rewrite of some grants, never a move of
 * the node itself — so a mismatch means the caller built one of the two from the wrong tree,
 * and the diff it would produce would be pure fiction.
 */
export function resolveImpact(input: ImpactInput): FolderImpact {
  const { before, after, subjects } = input;
  const nodeId = lastNodeId(after, 'after');
  const beforeNodeId = lastNodeId(before, 'before');
  if (beforeNodeId !== nodeId) {
    throw new Error(
      `impact chains must end at the same node: before ends at ${beforeNodeId}, after at ${nodeId}`,
    );
  }

  const gaining: UserImpact[] = [];
  const losing: UserImpact[] = [];

  for (const subject of subjects) {
    const had = resolve({ chain: before, subject }).effective;
    const has = resolve({ chain: after, subject }).effective;

    const gained = [...has].some((permission) => !had.has(permission));
    const lost = [...had].some((permission) => !has.has(permission));
    if (!gained && !lost) continue;

    const delta: UserImpact = {
      userId: subject.userId,
      before: sortPermissions(had),
      after: sortPermissions(has),
    };
    if (gained) gaining.push(delta);
    if (lost) losing.push(delta);
  }

  return { nodeId, gaining: gaining.sort(byUserId), losing: losing.sort(byUserId) };
}

/**
 * Roll per-folder impacts up into the shape `PermissionImpact` wants.
 *
 * `folders` is the subtree in traversal order, the changed node first. Each user is reported
 * once, with the before/after from the shallowest folder where their set moved — under
 * ADR-0021's nearest-ancestor rule that is the node the change was written on, since a
 * descendant carrying its own grant for that principal is not affected at all.
 *
 * `foldersAffected` counts folders where somebody's effective set actually changed, not rows
 * written: the radius of the click is what §6.2 asks for.
 */
export function aggregateImpact(folders: readonly FolderImpact[]): SubtreeImpact {
  const gaining = new Map<string, UserImpact>();
  const losing = new Map<string, UserImpact>();
  let foldersAffected = 0;

  for (const folder of folders) {
    if (folder.gaining.length === 0 && folder.losing.length === 0) continue;
    foldersAffected += 1;
    for (const user of folder.gaining) {
      if (!gaining.has(user.userId)) gaining.set(user.userId, user);
    }
    for (const user of folder.losing) {
      if (!losing.has(user.userId)) losing.set(user.userId, user);
    }
  }

  return {
    foldersAffected,
    usersGaining: [...gaining.values()].sort(byUserId),
    usersLosing: [...losing.values()].sort(byUserId),
  };
}
