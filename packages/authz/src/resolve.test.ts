import { describe, expect, it } from 'vitest';
import type { AclNode, Grant, Permission, Subject } from './permissions.js';
import { principalsOf, sortPermissions } from './permissions.js';
import { can, canMove, resolve, resolveEffective } from './resolve.js';

/**
 * These tests are written against ADR-0021, which replaced the Phase 0 model this package used
 * to implement (union along the chain, narrowing via `inherit: false`). The old tests measured
 * that other model, so they were not kept.
 */

function node(id: string, parentId: string | null, grants: readonly Grant[] = []): AclNode {
  return { id, parentId, grants };
}

function toUser(id: string, ...permissions: Permission[]): Grant {
  return { principal: { kind: 'user', id }, permissions };
}

function toTeam(id: string, ...permissions: Permission[]): Grant {
  return { principal: { kind: 'team', id }, permissions };
}

function effective(chain: readonly AclNode[], subject: Subject): readonly Permission[] {
  return sortPermissions(resolveEffective({ chain, subject }));
}

const alice: Subject = { userId: 'u-alice', teamIds: ['t-legal'] };
const bob: Subject = { userId: 'u-bob', teamIds: ['t-legal'] };

describe('resolveEffective', () => {
  it('grants nothing when no grant matches: there is no default access', () => {
    const chain = [node('root', null), node('child', 'root', [toTeam('t-sales', 'list')])];
    expect(effective(chain, alice)).toEqual([]);
  });

  it('inherits from an ancestor when the target carries no grant', () => {
    const chain = [
      node('root', null, [toTeam('t-legal', 'list', 'read', 'download')]),
      node('child', 'root'),
      node('leaf', 'child'),
    ];
    expect(effective(chain, alice)).toEqual(['list', 'read', 'download']);
  });

  it('does not confuse a user id with a team id', () => {
    // The two id spaces are separate; a team whose id equals a user id grants that user nothing.
    const chain = [node('root', null, [toTeam('u-bob', 'read')])];
    expect(can({ chain, subject: bob }, 'read')).toBe(false);
  });

  it('lets a narrower grant on a descendant cut the ancestor for THAT principal', () => {
    // The §6.2 diagram's "İstisna: daha dar izin": one row hanging off the inheriting node,
    // with no deny anywhere.
    const chain = [
      node('root', null, [toTeam('t-legal', 'list', 'read', 'download', 'delete')]),
      node('interns', 'root', [toTeam('t-legal', 'list')]),
    ];
    expect(effective(chain, alice)).toEqual(['list']);
  });

  it('does not cut a DIFFERENT principal at the same node', () => {
    // The narrowing above is local. Alice keeps her own row; only the team's set was narrowed.
    const chain = [
      node('root', null, [
        toTeam('t-legal', 'list', 'read', 'download', 'delete'),
        toUser('u-alice', 'read', 'modify'),
      ]),
      node('interns', 'root', [toTeam('t-legal', 'list')]),
    ];
    expect(effective(chain, alice)).toEqual(['list', 'read', 'modify']);
    expect(effective(chain, bob)).toEqual(['list']);
  });

  it('unions a direct user grant with the grant its team holds', () => {
    const chain = [
      node('root', null, [toTeam('t-legal', 'list', 'read')]),
      node('contracts', 'root', [toUser('u-alice', 'create', 'modify')]),
    ];
    expect(effective(chain, alice)).toEqual(['list', 'read', 'create', 'modify']);
  });

  it('unions the grants of both teams a user belongs to', () => {
    const chain = [
      node('root', null, [toTeam('t-legal', 'list', 'read'), toTeam('t-audit', 'audit')]),
    ];
    const inBoth: Subject = { userId: 'u-carol', teamIds: ['t-legal', 't-audit'] };
    expect(effective(chain, inBoth)).toEqual(['list', 'read', 'audit']);
  });

  it('does not let a narrow team clip a wide one, in either membership order', () => {
    // Being added to a second team must never reduce what someone can do, and the answer must
    // not depend on the order the memberships happen to come back from the database.
    const chain = [
      node('root', null, [
        toTeam('t-wide', 'list', 'read', 'download', 'delete'),
        toTeam('t-narrow', 'list'),
      ]),
      node('project', 'root', [toTeam('t-narrow', 'list')]),
    ];
    const wideFirst: Subject = { userId: 'u-dora', teamIds: ['t-wide', 't-narrow'] };
    const narrowFirst: Subject = { userId: 'u-dora', teamIds: ['t-narrow', 't-wide'] };

    expect(effective(chain, wideFirst)).toEqual(['list', 'read', 'download', 'delete']);
    expect(effective(chain, narrowFirst)).toEqual(effective(chain, wideFirst));
  });

  it('does not depend on the order grants are listed within a node', () => {
    const grants = [toTeam('t-legal', 'read'), toUser('u-alice', 'create')];
    const forward = [node('root', null, grants)];
    const reversed = [node('root', null, [...grants].reverse())];
    expect(effective(forward, alice)).toEqual(effective(reversed, alice));
  });

  it('takes the nearest grant even when the near one is WIDER than the far one', () => {
    // "Nearest wins" is not "narrowest wins": the rule is positional, so an administrator can
    // widen a subtree with one row instead of restating the whole chain.
    const chain = [
      node('root', null, [toTeam('t-legal', 'list')]),
      node('shared', 'root', [toTeam('t-legal', 'list', 'read', 'create')]),
    ];
    expect(effective(chain, alice)).toEqual(['list', 'read', 'create']);
  });

  it('reports which node each principal was served from', () => {
    const chain = [
      node('root', null, [toTeam('t-legal', 'list')]),
      node('contracts', 'root', [toUser('u-alice', 'read')]),
    ];
    const resolution = resolve({ chain, subject: alice });

    expect(resolution.sources).toEqual([
      { principal: { kind: 'user', id: 'u-alice' }, nodeId: 'contracts', permissions: ['read'] },
      { principal: { kind: 'team', id: 't-legal' }, nodeId: 'root', permissions: ['list'] },
    ]);
    // `FolderPermissions.inheritedFrom`: the deepest node that contributed.
    expect(resolution.nearestSourceNodeId).toBe('contracts');
  });

  it('reports no source node at all when nothing granted anything', () => {
    const resolution = resolve({ chain: [node('root', null)], subject: alice });
    expect(resolution.nearestSourceNodeId).toBeNull();
    expect(resolution.sources).toEqual([]);
  });

  it('rejects a chain that is not parent-linked, instead of answering a different question', () => {
    const root = node('root', null, [toUser('u-alice', 'read')]);
    const child = node('child', 'root', [toUser('u-alice', 'list')]);
    const grandchild = node('grandchild', 'child');

    // A gap in the middle: the missing node's grants would be skipped silently.
    expect(() => resolveEffective({ chain: [root, grandchild], subject: alice })).toThrow(
      /parent-linked/,
    );
    // Reversed: the walk would still return a set, just for the wrong tree.
    expect(() => resolveEffective({ chain: [child, root], subject: alice })).toThrow(/share root/);
  });

  it('rejects a chain that starts partway down the tree', () => {
    const orphan = node('child', 'root', [toUser('u-alice', 'list')]);
    expect(() => resolveEffective({ chain: [orphan], subject: alice })).toThrow(/share root/);
    expect(() => resolveEffective({ chain: [], subject: alice })).toThrow(/at least/);
  });
});

describe('principalsOf', () => {
  it('expands a subject to itself plus every team', () => {
    expect(principalsOf(alice)).toEqual([
      { kind: 'user', id: 'u-alice' },
      { kind: 'team', id: 't-legal' },
    ]);
  });
});

describe('canMove', () => {
  // §6.2: "Taşıma işleminde hem kaynak hem hedef yetkisi doğrulanmalı."
  const source = [node('src', null, [toUser('u-alice', 'move')])];
  const destination = [node('dst', null, [toUser('u-alice', 'create')])];

  it('allows when the source grants move and the destination grants create', () => {
    expect(canMove({ chain: source, subject: alice }, { chain: destination, subject: alice })).toBe(
      true,
    );
  });

  it('refuses when the destination does not grant create', () => {
    const closed = [node('dst', null, [toUser('u-alice', 'read')])];
    expect(canMove({ chain: source, subject: alice }, { chain: closed, subject: alice })).toBe(
      false,
    );
  });

  it('refuses when the source does not grant move', () => {
    const closed = [node('src', null, [toUser('u-alice', 'read')])];
    expect(canMove({ chain: closed, subject: alice }, { chain: destination, subject: alice })).toBe(
      false,
    );
  });
});
