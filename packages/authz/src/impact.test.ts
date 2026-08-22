import { describe, expect, it } from 'vitest';
import type { AclNode, Grant, Permission, Subject } from './permissions.js';
import { aggregateImpact, resolveImpact } from './impact.js';

function node(id: string, parentId: string | null, grants: readonly Grant[] = []): AclNode {
  return { id, parentId, grants };
}

function toTeam(id: string, ...permissions: Permission[]): Grant {
  return { principal: { kind: 'team', id }, permissions };
}

function toUser(id: string, ...permissions: Permission[]): Grant {
  return { principal: { kind: 'user', id }, permissions };
}

const alice: Subject = { userId: 'u-alice', teamIds: ['t-legal'] };
const bob: Subject = { userId: 'u-bob', teamIds: ['t-sales'] };
const carol: Subject = { userId: 'u-carol', teamIds: [] };
const everyone = [alice, bob, carol];

describe('resolveImpact', () => {
  it('separates the users who gain from the users who lose', () => {
    const before = [node('root', null, [toTeam('t-legal', 'list', 'read', 'delete')])];
    const after = [
      node('root', null, [toTeam('t-legal', 'list', 'read'), toTeam('t-sales', 'list')]),
    ];

    const impact = resolveImpact({ before, after, subjects: everyone });

    expect(impact.nodeId).toBe('root');
    expect(impact.gaining).toEqual([{ userId: 'u-bob', before: [], after: ['list'] }]);
    expect(impact.losing).toEqual([
      { userId: 'u-alice', before: ['list', 'read', 'delete'], after: ['list', 'read'] },
    ]);
  });

  it('reports a user who both gains and loses on BOTH lists', () => {
    // Half of this change is a loss, and an administrator has to see that half even though the
    // same click also handed the person something new.
    const before = [node('root', null, [toUser('u-carol', 'read', 'delete')])];
    const after = [node('root', null, [toUser('u-carol', 'read', 'create')])];

    const impact = resolveImpact({ before, after, subjects: everyone });

    expect(impact.gaining.map((user) => user.userId)).toEqual(['u-carol']);
    expect(impact.losing.map((user) => user.userId)).toEqual(['u-carol']);
    expect(impact.losing[0]).toEqual({
      userId: 'u-carol',
      before: ['read', 'delete'],
      after: ['read', 'create'],
    });
  });

  it('reports nobody when the rewrite changes no effective set', () => {
    // Reordering rows, or restating a grant a nearer node already overrides, is not a change.
    const before = [
      node('root', null, [toTeam('t-legal', 'list', 'read')]),
      node('child', 'root', [toTeam('t-legal', 'list')]),
    ];
    const after = [
      node('root', null, [toTeam('t-legal', 'list', 'read', 'download')]),
      node('child', 'root', [toTeam('t-legal', 'list')]),
    ];

    const impact = resolveImpact({ before, after, subjects: everyone });

    expect(impact.gaining).toEqual([]);
    expect(impact.losing).toEqual([]);
  });

  it('counts a removed grant as a loss down to whatever the ancestor still allows', () => {
    const before = [
      node('root', null, [toTeam('t-legal', 'list')]),
      node('child', 'root', [toTeam('t-legal', 'list', 'read', 'create')]),
    ];
    const after = [node('root', null, [toTeam('t-legal', 'list')]), node('child', 'root')];

    const impact = resolveImpact({ before, after, subjects: everyone });

    expect(impact.losing).toEqual([
      { userId: 'u-alice', before: ['list', 'read', 'create'], after: ['list'] },
    ]);
    expect(impact.gaining).toEqual([]);
  });

  it('refuses two chains that end at different nodes', () => {
    const before = [node('root', null)];
    const after = [node('root', null), node('child', 'root')];
    expect(() => resolveImpact({ before, after, subjects: everyone })).toThrow(/same node/);
  });
});

describe('aggregateImpact', () => {
  it('counts only the folders where somebody actually moved', () => {
    const changedNode = resolveImpact({
      before: [node('root', null, [toTeam('t-legal', 'list')])],
      after: [node('root', null, [toTeam('t-legal', 'list', 'read')])],
      subjects: everyone,
    });
    const inheritingChild = resolveImpact({
      before: [node('root', null, [toTeam('t-legal', 'list')]), node('child', 'root')],
      after: [node('root', null, [toTeam('t-legal', 'list', 'read')]), node('child', 'root')],
      subjects: everyone,
    });
    // Its own grant for the same principal shields it: nearest ancestor wins (ADR-0021).
    const shieldedChild = resolveImpact({
      before: [
        node('root', null, [toTeam('t-legal', 'list')]),
        node('own', 'root', [toTeam('t-legal', 'list')]),
      ],
      after: [
        node('root', null, [toTeam('t-legal', 'list', 'read')]),
        node('own', 'root', [toTeam('t-legal', 'list')]),
      ],
      subjects: everyone,
    });

    const summary = aggregateImpact([changedNode, inheritingChild, shieldedChild]);

    expect(summary.foldersAffected).toBe(2);
    expect(summary.usersGaining).toEqual([
      { userId: 'u-alice', before: ['list'], after: ['list', 'read'] },
    ]);
    expect(summary.usersLosing).toEqual([]);
  });

  it('reports each user once, from the shallowest folder where their set moved', () => {
    const first = resolveImpact({
      before: [node('root', null, [toUser('u-carol', 'list', 'read')])],
      after: [node('root', null, [toUser('u-carol', 'list')])],
      subjects: [carol],
    });
    const deeper = resolveImpact({
      before: [
        node('root', null, [toUser('u-carol', 'list', 'read')]),
        node('deep', 'root', [toUser('u-carol', 'list', 'read', 'delete')]),
      ],
      after: [node('root', null, [toUser('u-carol', 'list')]), node('deep', 'root')],
      subjects: [carol],
    });

    const summary = aggregateImpact([first, deeper]);

    expect(summary.foldersAffected).toBe(2);
    expect(summary.usersLosing).toEqual([
      { userId: 'u-carol', before: ['list', 'read'], after: ['list'] },
    ]);
  });

  it('is empty for a subtree nothing touched', () => {
    expect(aggregateImpact([])).toEqual({
      foldersAffected: 0,
      usersGaining: [],
      usersLosing: [],
    });
  });
});
