/**
 * DEPSIS permission vocabulary, and the shapes the resolver walks over.
 *
 * This model is ALLOW-ONLY. There is deliberately no `deny`, and that is not a convenience:
 * POSIX ACLs — the only ACL type the kernel actually enforces on ZFS — cannot express a deny
 * ACE at all. A deny in this layer would be unenforceable at the substrate and would recreate
 * exactly the "two realities" §6.2 forbids, where a folder is closed on the web and open over
 * SMB (ADR-0004, ADR-0021).
 *
 * Narrowing is expressed by granting FEWER permissions to a principal on a descendant node.
 * See `resolve.ts` for the inheritance rule that makes that work.
 *
 * The permission NAMES here are the ones in the `folder_permission` enum (migration 0015) and
 * in the published `FolderPermission` schema, not the ones this package used in Phase 0
 * (`manage_acl`, `view_versions`, `view_audit`). ADR-0021 settled the conflict in that
 * direction: the enum lives in a database type and in a contract that generates clients, while
 * this package is an internal module — the wide surface decides the narrow one.
 */

/** The eleven permissions of §6.2, in canonical order. */
export const PERMISSIONS = [
  'list',
  'read',
  'download',
  'create',
  'modify',
  'move',
  'delete',
  'share',
  'manage',
  'versions',
  'audit',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * A grant target — ADR-0021 calls it a "temsilci". Either the user themselves or a team.
 *
 * Users and teams never share an id space, and the `kind` tag is what keeps them apart: a team
 * whose id happens to equal a user's id must not grant that user anything.
 */
export type Principal =
  { readonly kind: 'user'; readonly id: string } | { readonly kind: 'team'; readonly id: string };

/**
 * One row of `folder_grants`, attached to one node.
 *
 * Allow-only by construction: there is no `effect` field, because the only representable
 * effect is "allow". The database also rejects an empty `permissions` array — removing access
 * means deleting the row, not emptying it. A row that exists is a decision made AT this node,
 * which is why the resolver stops at it (see `resolveEffective`).
 */
export interface Grant {
  readonly principal: Principal;
  readonly permissions: readonly Permission[];
}

/**
 * One node in the folder tree.
 *
 * A node is either a `file_entries` folder or the root of a share — `folder_grants.entry_id`
 * is NULL for the latter, and ADR-0021 keeps both in one table precisely so that this walk is
 * written once.
 *
 * There is no `inherit` flag. Phase 0 had one and ADR-0021 removed it: switching inheritance
 * off at a node cuts it for EVERYONE, so narrowing for one team meant re-listing every other
 * principal, and anyone forgotten in that list silently lost access. Migration 0015 has no
 * column for it either, and adding one would make that footgun permanent.
 */
export interface AclNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly grants: readonly Grant[];
}

/**
 * A user account together with the teams it belongs to.
 *
 * This is the input side of a permission question ("what can this person do here"), whereas a
 * `Principal` is the target side of a grant. `principalsOf` turns one into the other.
 *
 * The organization-administrator exception is NOT modelled here and must not be: an admin
 * reaching everything is a fact about the session (§6.1), not a fact about the tree. The
 * calling layer applies it, so that this package keeps answering exactly one question — what
 * the grants say — and stays testable without inventing a session.
 */
export interface Subject {
  readonly userId: string;
  readonly teamIds: readonly string[];
}

/** The principals a subject resolves under: itself, plus every team it is a member of. */
export function principalsOf(subject: Subject): readonly Principal[] {
  return [
    { kind: 'user', id: subject.userId },
    ...subject.teamIds.map((id): Principal => ({ kind: 'team', id })),
  ];
}

export function samePrincipal(a: Principal, b: Principal): boolean {
  return a.kind === b.kind && a.id === b.id;
}

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Order a permission set canonically.
 *
 * Set iteration order follows insertion, which depends on the order grants were visited — so
 * two runs that agree on the answer could still disagree on the array. Callers compare these
 * arrays (dry-run diffs) and serialize them, so the order has to come from the vocabulary.
 */
export function sortPermissions(permissions: Iterable<Permission>): readonly Permission[] {
  const present = new Set(permissions);
  return PERMISSIONS.filter((permission) => present.has(permission));
}

/*
 * `ESCALATING_PERMISSIONS = ['manage', 'share']` used to be exported from here, documented as "the
 * permissions that let a subject widen someone else's access", and consulted by nothing. It is
 * deleted rather than wired up, and the question behind it is recorded so the deletion is a
 * decision instead of a tidy-up.
 *
 * The question: a non-administrator with `manage` at a node may currently grant any of the eleven
 * permissions there, including ones they do not hold themselves. Refusing that — "you cannot hand
 * out what you have not got" — sounds obviously right and is not, under ADR-0021. `manage` is
 * DELEGATION: the whole reason §6.2 separates it from `modify` is so an administrator can put one
 * person in charge of one folder, and that person is routinely someone who does not personally
 * need `download` on the files they are opening to a team. Tying the two together would make the
 * delegated manager useless unless they were first given everything they might ever grant, which
 * is the opposite of least privilege.
 *
 * What stops `manage` from being total is that it is per-node and given deliberately: nobody holds
 * it anywhere until an administrator writes a row that says so. A share's FIRST grant is therefore
 * always an administrator's — there is no node for a member to inherit `manage` from before one
 * exists — and `SharesService.create` writes it at the moment the share is made.
 */
