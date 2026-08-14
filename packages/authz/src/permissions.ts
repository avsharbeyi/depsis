/**
 * DEPSIS permission vocabulary.
 *
 * Per ADR-0004 this model is ALLOW-ONLY. There is deliberately no `deny`.
 * That is not a simplification we chose for convenience — POSIX ACLs, which are the only ACL
 * type the Linux kernel actually enforces on ZFS, cannot express a deny ACE at all. A `deny`
 * in this layer would be unenforceable at the substrate and would recreate exactly the
 * "two realities" problem the master prompt §6.2 forbids.
 *
 * Narrowing is expressed by granting FEWER permissions on a descendant, never by denying.
 */

/** The permission set from master prompt §6.2. */
export const PERMISSIONS = [
  'list',
  'read',
  'download',
  'create',
  'modify',
  'move',
  'delete',
  'share',
  'manage_acl',
  'view_versions',
  'view_audit',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** A stable subject identifier. Users and groups never share an id space. */
export type SubjectRef =
  { readonly kind: 'user'; readonly id: string } | { readonly kind: 'group'; readonly id: string };

/**
 * An ACL entry attached to one node. Allow-only by construction: there is no `effect` field,
 * because the only representable effect is "allow".
 */
export interface AclEntry {
  readonly subject: SubjectRef;
  readonly permissions: readonly Permission[];
}

/**
 * One node in the folder tree.
 *
 * `inherit` is per-node. When false, the node starts from an empty set rather than from its
 * parent's effective set — this is how a narrower subtree is expressed without a deny.
 */
export interface AclNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly entries: readonly AclEntry[];
  readonly inherit: boolean;
}

/** The subject making a request, plus every group it belongs to (transitively resolved). */
export interface Principal {
  readonly userId: string;
  readonly groupIds: readonly string[];
}

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Permissions that let a subject change who else has access. Granting these is what makes a
 * subject an administrator of a subtree, so callers that enumerate "privileged" grants should
 * use this rather than hardcoding names.
 */
export const ESCALATING_PERMISSIONS: readonly Permission[] = ['manage_acl', 'share'];
