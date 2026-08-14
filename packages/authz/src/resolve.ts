import { type AclNode, type Permission, type Principal, type SubjectRef } from './permissions.js';

/**
 * Effective-permission resolution.
 *
 * This module is deliberately PURE: no I/O, no clock, no database. That is what makes it
 * property-testable and what lets the same code run in the API, in tests, and in a future
 * dry-run "who would this change affect?" preview (master prompt §6.2).
 *
 * Resolution rules (ADR-0004):
 *   1. Allow-only. Union of every matching entry's permissions.
 *   2. Inheritance flows parent -> child while `inherit` is true.
 *   3. A node with `inherit: false` starts from the empty set. This is the ONLY narrowing
 *      mechanism; there is no deny.
 *   4. A subject matches an entry if it is that user, or a member of that group.
 */

export interface ResolveInput {
  /** Nodes from the root down to the target, in that order. */
  readonly chain: readonly AclNode[];
  readonly principal: Principal;
}

function subjectMatches(subject: SubjectRef, principal: Principal): boolean {
  return subject.kind === 'user'
    ? subject.id === principal.userId
    : principal.groupIds.includes(subject.id);
}

/**
 * Resolve the effective permission set for `principal` at the end of `chain`.
 *
 * `chain` must be ordered root-first. Passing it in any other order silently produces wrong
 * answers, so callers should build it from parentId links rather than from a path string
 * (ADR-0005: a path is never an authorization input).
 */
export function resolveEffective(input: ResolveInput): ReadonlySet<Permission> {
  const { chain, principal } = input;
  let effective = new Set<Permission>();

  for (const node of chain) {
    // Rule 3: a non-inheriting node discards everything accumulated above it.
    if (!node.inherit) {
      effective = new Set<Permission>();
    }
    for (const entry of node.entries) {
      if (!subjectMatches(entry.subject, principal)) continue;
      for (const permission of entry.permissions) {
        effective.add(permission);
      }
    }
  }

  return effective;
}

export function can(input: ResolveInput, permission: Permission): boolean {
  return resolveEffective(input).has(permission);
}

/**
 * A move touches two locations, so it needs rights on both. Master prompt §6.2:
 * "Taşıma işleminde hem kaynak hem hedef yetkisi doğrulanmalı."
 *
 * Removing from the source requires `move`; landing in the destination requires `create`.
 * Checking only one side is a real and easy bug, which is why this is a named function rather
 * than something each call site open-codes.
 */
export function canMove(source: ResolveInput, destination: ResolveInput): boolean {
  return can(source, 'move') && can(destination, 'create');
}
