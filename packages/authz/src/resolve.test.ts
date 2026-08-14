import { describe, expect, it } from 'vitest';
import type { AclNode, Principal } from './permissions.js';
import { can, canMove, resolveEffective } from './resolve.js';

const alice: Principal = { userId: 'u-alice', groupIds: ['g-legal'] };
const bob: Principal = { userId: 'u-bob', groupIds: [] };

function node(over: Partial<AclNode> & Pick<AclNode, 'id'>): AclNode {
  return { parentId: null, entries: [], inherit: true, ...over };
}

describe('resolveEffective', () => {
  it('returns nothing when no entry matches', () => {
    const chain = [node({ id: 'root' })];
    expect(resolveEffective({ chain, principal: alice }).size).toBe(0);
  });

  it('grants via direct user entry', () => {
    const chain = [
      node({
        id: 'root',
        entries: [{ subject: { kind: 'user', id: 'u-alice' }, permissions: ['list', 'read'] }],
      }),
    ];
    const eff = resolveEffective({ chain, principal: alice });
    expect([...eff].sort()).toEqual(['list', 'read']);
  });

  it('grants via group membership', () => {
    const chain = [
      node({
        id: 'root',
        entries: [{ subject: { kind: 'group', id: 'g-legal' }, permissions: ['download'] }],
      }),
    ];
    expect(can({ chain, principal: alice }, 'download')).toBe(true);
    expect(can({ chain, principal: bob }, 'download')).toBe(false);
  });

  it('does not confuse a user id with a group id', () => {
    // Same string in both id spaces must not cross over.
    const chain = [
      node({
        id: 'root',
        entries: [{ subject: { kind: 'group', id: 'u-bob' }, permissions: ['read'] }],
      }),
    ];
    expect(can({ chain, principal: bob }, 'read')).toBe(false);
  });

  it('unions permissions down an inheriting chain', () => {
    const chain = [
      node({
        id: 'root',
        entries: [{ subject: { kind: 'group', id: 'g-legal' }, permissions: ['list'] }],
      }),
      node({
        id: 'child',
        parentId: 'root',
        entries: [{ subject: { kind: 'user', id: 'u-alice' }, permissions: ['read'] }],
      }),
    ];
    expect([...resolveEffective({ chain, principal: alice })].sort()).toEqual(['list', 'read']);
  });

  it('narrows by breaking inheritance, which is the only narrowing mechanism (ADR-0004)', () => {
    const chain = [
      node({
        id: 'root',
        entries: [
          { subject: { kind: 'user', id: 'u-alice' }, permissions: ['list', 'read', 'delete'] },
        ],
      }),
      node({
        id: 'restricted',
        parentId: 'root',
        inherit: false,
        entries: [{ subject: { kind: 'user', id: 'u-alice' }, permissions: ['list'] }],
      }),
    ];
    const eff = resolveEffective({ chain, principal: alice });
    expect([...eff]).toEqual(['list']);
    expect(eff.has('delete')).toBe(false);
  });

  it('re-accumulates below a non-inheriting node', () => {
    const chain = [
      node({
        id: 'root',
        entries: [{ subject: { kind: 'user', id: 'u-alice' }, permissions: ['delete'] }],
      }),
      node({ id: 'break', parentId: 'root', inherit: false }),
      node({
        id: 'leaf',
        parentId: 'break',
        entries: [{ subject: { kind: 'user', id: 'u-alice' }, permissions: ['read'] }],
      }),
    ];
    const eff = resolveEffective({ chain, principal: alice });
    expect([...eff]).toEqual(['read']);
    expect(eff.has('delete')).toBe(false);
  });
});

describe('canMove', () => {
  const sourceChain = [
    node({
      id: 'src',
      entries: [{ subject: { kind: 'user', id: 'u-alice' }, permissions: ['move'] }],
    }),
  ];
  const destChain = [
    node({
      id: 'dst',
      entries: [{ subject: { kind: 'user', id: 'u-alice' }, permissions: ['create'] }],
    }),
  ];

  it('allows when both sides grant', () => {
    expect(
      canMove({ chain: sourceChain, principal: alice }, { chain: destChain, principal: alice }),
    ).toBe(true);
  });

  it('refuses when the destination does not grant create (§6.2)', () => {
    const noCreate = [node({ id: 'dst' })];
    expect(
      canMove({ chain: sourceChain, principal: alice }, { chain: noCreate, principal: alice }),
    ).toBe(false);
  });

  it('refuses when the source does not grant move', () => {
    const noMove = [node({ id: 'src' })];
    expect(
      canMove({ chain: noMove, principal: alice }, { chain: destChain, principal: alice }),
    ).toBe(false);
  });
});
