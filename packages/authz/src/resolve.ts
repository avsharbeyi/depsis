import {
  principalsOf,
  samePrincipal,
  sortPermissions,
  type AclNode,
  type Permission,
  type Principal,
  type Subject,
} from './permissions.js';

/**
 * Effective-permission resolution, per ADR-0021.
 *
 * This module is deliberately PURE: no I/O, no clock, no database. That is what lets the same
 * code answer a live request, back the dry-run preview §6.2 requires, and run in tests without
 * a stack.
 *
 * The rule, and nothing else:
 *
 *   1. A subject's PRINCIPALS are itself plus every team it belongs to.
 *   2. For each principal SEPARATELY, walk from the target node up to the root and take the
 *      grant on the NEAREST node that carries one. Grants for that principal further up are
 *      ignored — that is where narrowing comes from.
 *   3. Union the per-principal sets.
 *   4. No deny, ever.
 *
 * Why nearest-per-principal rather than a union along the chain: with a union, putting a
 * narrower grant on a subfolder would take nothing away, so the only way to narrow would be a
 * deny — the thing we refuse to have. Why union ACROSS principals: adding someone to a second
 * team must not reduce what they can do, and a narrow team clipping a wide one would make the
 * answer depend on the order the memberships happen to be listed in.
 *
 * The organization-administrator exception is NOT here. See the note on `Subject`.
 */

export interface ResolveInput {
  /**
   * The nodes from the share root down to the target, in that order, linked by `parentId`.
   *
   * Built from `parent_id`, never from a path string: a path is not an identity and never an
   * authorization input (ADR-0005). `resolve` verifies the links, because a chain assembled
   * wrongly does not fail — it quietly answers a different question.
   */
  readonly chain: readonly AclNode[];
  readonly subject: Subject;
}

/** Where one principal's contribution came from. */
export interface PrincipalSource {
  readonly principal: Principal;
  /** The nearest ancestor (or the target itself) carrying a grant for this principal. */
  readonly nodeId: string;
  readonly permissions: readonly Permission[];
}

export interface Resolution {
  readonly effective: ReadonlySet<Permission>;
  /** One entry per principal that matched a grant; principals with no grant are absent. */
  readonly sources: readonly PrincipalSource[];
  /**
   * The deepest node any part of `effective` came from — the target's own id when it carries a
   * grant, null when nothing granted anything. This is what `FolderPermissions.inheritedFrom`
   * reports: "where does this permission come from" has to be answerable, or an administrator
   * cannot find the row to remove.
   */
  readonly nearestSourceNodeId: string | null;
}

/**
 * A chain that is not root-first and parent-linked is a caller bug, and a silent one: the walk
 * would still return a set, just the wrong one. Throwing names the two ways it goes wrong —
 * a reversed chain, and a chain that starts partway down and so never sees the grants above.
 */
function assertChain(chain: readonly AclNode[]): void {
  const [root] = chain;
  if (root === undefined) {
    throw new Error('an ACL chain must contain at least the target node');
  }
  if (root.parentId !== null) {
    throw new Error(
      `ACL chain must start at the share root: node ${root.id} has parent ${root.parentId}`,
    );
  }
  let previous = root;
  for (const node of chain.slice(1)) {
    if (node.parentId !== previous.id) {
      throw new Error(
        `ACL chain is not parent-linked: node ${node.id} has parent ${String(node.parentId)}, ` +
          `expected ${previous.id}`,
      );
    }
    previous = node;
  }
}

/**
 * Rule 2 on its own: the nearest node at or above the target carrying a grant for ONE principal.
 *
 * Exported because two callers need a per-principal answer rather than a per-subject one, and
 * neither of them has a `Subject` to ask with. The POSIX application walks a folder's grants to
 * build one ACL entry per principal — a team is not a subject and has no user id — and the fake
 * subject that would let it reuse `resolve` is exactly the id-space confusion `samePrincipal`
 * exists to prevent. Written once here, so "nearest ancestor wins" has one implementation.
 *
 * Null when no node in the chain names this principal.
 */
export function nearestGrant(
  chain: readonly AclNode[],
  principal: Principal,
): PrincipalSource | null {
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const node = chain[index];
    if (node === undefined) continue;
    const grant = node.grants.find((candidate) => samePrincipal(candidate.principal, principal));
    if (grant === undefined) continue;
    return { principal, nodeId: node.id, permissions: sortPermissions(grant.permissions) };
  }
  return null;
}

/**
 * Resolve `subject`'s permissions at the end of `chain`, with the source of each contribution.
 *
 * Only the first grant found for a principal is used; migration 0015's unique indexes make a
 * second grant for the same principal on the same node impossible, so there is no merge rule
 * to guess at here.
 */
export function resolve(input: ResolveInput): Resolution {
  const { chain, subject } = input;
  assertChain(chain);

  const depthOf = new Map<string, number>();
  chain.forEach((node, index) => depthOf.set(node.id, index));

  const effective = new Set<Permission>();
  const sources: PrincipalSource[] = [];

  for (const principal of principalsOf(subject)) {
    // Nearest ancestor wins FOR THIS PRINCIPAL: the wider grants above it are not consulted.
    const source = nearestGrant(chain, principal);
    if (source === null) continue;
    sources.push(source);
    for (const permission of source.permissions) {
      effective.add(permission);
    }
  }

  let nearestSourceNodeId: string | null = null;
  let nearestDepth = -1;
  for (const source of sources) {
    const depth = depthOf.get(source.nodeId) ?? -1;
    if (depth > nearestDepth) {
      nearestDepth = depth;
      nearestSourceNodeId = source.nodeId;
    }
  }

  return { effective, sources, nearestSourceNodeId };
}

/** The effective set alone, for callers that do not need to explain where it came from. */
export function resolveEffective(input: ResolveInput): ReadonlySet<Permission> {
  return resolve(input).effective;
}

export function can(input: ResolveInput, permission: Permission): boolean {
  return resolveEffective(input).has(permission);
}

/**
 * A move touches two locations, so it needs rights on both. §6.2: "Taşıma işleminde hem kaynak
 * hem hedef yetkisi doğrulanmalı."
 *
 * Leaving the source requires `move`; landing in the destination requires `create`. Checking
 * one side only is a real and easy bug, which is why this is a named function rather than
 * something each call site open-codes.
 */
export function canMove(source: ResolveInput, destination: ResolveInput): boolean {
  return can(source, 'move') && can(destination, 'create');
}
