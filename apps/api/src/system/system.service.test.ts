import { describe, expect, it, vi } from 'vitest';

import { AgentUnavailableError, type AgentResponse } from '../agent/agent.service.js';
import type { AgentService } from '../agent/agent.service.js';
import type { DbService } from '../db/db.service.js';
import { SystemService } from './system.service.js';

/**
 * A stub agent, not a socket.
 *
 * The wire itself is measured in agent.service.test.ts against a real stream socket; what is left
 * to settle here is what this service DECIDES with the answers, which a socket adds nothing to.
 */
function stubAgent(answers: Record<string, AgentResponse>): {
  agent: AgentService;
  calls: Array<{ key: string; reason: string; correlationId: string }>;
} {
  const calls: Array<{ key: string; reason: string; correlationId: string }> = [];
  const agent = {
    call: (
      request: { op: string; pool?: string; disk_by_id?: string },
      reason: string,
      correlationId: string,
    ) => {
      // Keyed by the POOL for `pool_status` and by the OPERATION otherwise. A pool called
      // `list_disks` would collide, and a pool called `list_disks` is not a thing worth defending
      // against in a stub.
      const key = request.op === 'pool_status' ? (request.pool ?? '') : request.op;
      calls.push({ key, reason, correlationId });
      const answer = answers[key];
      if (answer === undefined) return Promise.reject(new AgentUnavailableError('no stub answer'));
      return Promise.resolve(answer);
    },
  } as unknown as AgentService;
  return { agent, calls };
}

/** Two disks: the appliance's own, and a blank one. */
const INVENTORY: AgentResponse = {
  status: 'disks',
  truncated: false,
  disks: [
    {
      by_id: 'ata-SYSTEM_DISK_1',
      kname: 'sda',
      size_bytes: 512_110_190_592,
      model: 'Samsung SSD 860',
      serial: 'S3Z8NB0K',
      wwn: '0x5002538e40a1b2c3',
      rotational: false,
      removable: false,
      transport: 'sata',
      holds: ['gpt', 'vfat', 'ext4'],
      mounted: true,
      holds_system: true,
    },
    {
      by_id: 'ata-BLANK_2',
      kname: 'sdb',
      size_bytes: 4_000_787_030_016,
      model: 'WDC WD40EFRX',
      serial: null,
      wwn: '0x50014ee2b1c2d3e4',
      rotational: true,
      removable: false,
      transport: 'sata',
      holds: [],
      mounted: false,
      holds_system: false,
    },
  ],
};

function stubDb(adminUserId: string | null): DbService {
  return {
    withoutTenant: (_justification: string, fn: (q: unknown) => Promise<unknown>) =>
      fn({
        query: (_sql: string, params: readonly unknown[]) =>
          Promise.resolve([{ n: params[0] === adminUserId ? '1' : '0' }]),
      }),
  } as unknown as DbService;
}

const ONLINE: AgentResponse = {
  status: 'pool_status',
  health: 'ONLINE',
  used_bytes: 1_000,
  available_bytes: 9_000,
};

describe('telemetry', () => {
  it('reports every configured pool, in order, with an audit reason and the callerid', async () => {
    const { agent, calls } = stubAgent({
      tank: ONLINE,
      backup: { status: 'pool_status', health: 'DEGRADED', used_bytes: 5, available_bytes: 6 },
      read_smart_summary: { status: 'smart', healthy: true, temperature_celsius: 30, raw: '{}' },
    });
    // Disks named explicitly, so this test measures the pool loop and nothing else.
    const system = new SystemService(agent, stubDb(null), ['tank', 'backup'], ['ata-X']);

    const telemetry = await system.telemetry('corr-1');

    expect(telemetry.pools).toEqual([
      { name: 'tank', health: 'ONLINE', used: 1_000, available: 9_000 },
      { name: 'backup', health: 'DEGRADED', used: 5, available: 6 },
    ]);
    // §16: a privileged call has to be explainable, and traceable back to the request that caused
    // it. Both are asserted rather than assumed, because both are easy to forget at a call site.
    expect(new Set(calls.map((c) => c.correlationId))).toEqual(new Set(['corr-1']));
    expect(calls[0]?.reason).toContain('tank');
  });

  it('never repeats a health state it does not recognise', async () => {
    // The agent passes `zpool list -H -o health` through verbatim, so this is the boundary where an
    // unexpected state has to be handled. Mapping it to ONLINE is the shortest path to showing an
    // operator a false green on a pool that is in trouble.
    const { agent } = stubAgent({
      tank: { status: 'pool_status', health: 'WEIRD', used_bytes: 1, available_bytes: 2 },
    });
    const system = new SystemService(agent, stubDb(null), ['tank']);

    expect((await system.telemetry('c')).pools[0]?.health).toBe('UNKNOWN');
  });

  it('accepts the states zpoolprops(7) documents, whatever their case', async () => {
    for (const health of ['ONLINE', 'DEGRADED', 'FAULTED', 'OFFLINE', 'REMOVED', 'UNAVAIL']) {
      const { agent } = stubAgent({
        tank: {
          status: 'pool_status',
          health: health.toLowerCase(),
          used_bytes: 1,
          available_bytes: 2,
        },
      });
      const system = new SystemService(agent, stubDb(null), ['tank']);
      expect((await system.telemetry('c')).pools[0]?.health).toBe(health);
    }
  });

  it('fails rather than dropping a pool the agent refuses', async () => {
    // A configured pool the agent will not report on is a typo in the configuration or a pool that
    // has gone away. Returning the other pools and omitting this one would present a partial list
    // as if it were the whole truth.
    const { agent } = stubAgent({
      tank: ONLINE,
      gone: { status: 'refused', reason: 'no such pool' },
    });
    const system = new SystemService(agent, stubDb(null), ['tank', 'gone']);

    await expect(system.telemetry('c')).rejects.toBeInstanceOf(AgentUnavailableError);
    await expect(system.telemetry('c')).rejects.toThrow(/gone.*no such pool/);
  });

  it('reports no pools when the box has none, having asked', async () => {
    // Not "the agent is never called" any more, and the change is the point: `DEPSIS_ZFS_POOLS`
    // empty used to mean "report nothing", which on an appliance whose pool was made through the
    // wizard meant reporting nothing about the pool it had just created.
    const { agent, calls } = stubAgent({ list_pools: { status: 'pools', pools: [] } });
    const system = new SystemService(agent, stubDb(null), []);

    expect((await system.telemetry('c')).pools).toEqual([]);
    expect(calls.map((c) => c.key).sort()).toEqual(['list_disks', 'list_pools']);
  });

  it('reports every pool the box has when nobody configured a list', async () => {
    const { agent } = stubAgent({
      list_pools: { status: 'pools', pools: ['tank', 'yedek'] },
      tank: ONLINE,
      yedek: ONLINE,
      list_disks: { status: 'disks', truncated: false, disks: [] },
    });
    const telemetry = await new SystemService(agent, stubDb(null), []).telemetry('c');
    expect(telemetry.pools.map((p) => p.name)).toEqual(['tank', 'yedek']);
  });

  it('keeps a configured disk red when its SMART cannot be read', async () => {
    // An operator who named a disk asked to be told about it, and its silence is a fact. The long
    // note in `disks` is about exactly this trade and it stands for the configured case.
    const { agent } = stubAgent({
      list_pools: { status: 'pools', pools: [] },
      read_smart_summary: { status: 'failed', reason: 'smartctl exited 127' },
    });
    const system = new SystemService(agent, stubDb(null), [], ['ata-NAMED']);
    expect((await system.telemetry('c')).disks).toEqual([{ id: 'ata-NAMED', healthy: false }]);
  });

  it('omits a DISCOVERED disk whose SMART cannot be read rather than painting it red', async () => {
    // Nobody asked about it: it is here because the box has it, and the overwhelmingly common
    // reason smartctl says nothing is that it is not installed. A wall of false alarms produced by
    // a convenience teaches an operator that the health column means nothing.
    const { agent } = stubAgent({
      list_pools: { status: 'pools', pools: [] },
      list_disks: INVENTORY,
      read_smart_summary: { status: 'failed', reason: 'smartctl exited 127' },
    });
    expect((await new SystemService(agent, stubDb(null), []).telemetry('c')).disks).toEqual([]);
  });

  it('does not ask which pools exist when a list was configured', async () => {
    // An operator who narrowed the list — a backup pool they do not want on the dashboard — must
    // not find it widened back.
    const { agent, calls } = stubAgent({
      tank: ONLINE,
      list_disks: { status: 'disks', truncated: false, disks: [] },
    });
    const telemetry = await new SystemService(agent, stubDb(null), ['tank']).telemetry('c');
    expect(telemetry.pools.map((p) => p.name)).toEqual(['tank']);
    expect(calls.some((c) => c.key === 'list_pools')).toBe(false);
  });

  it('says an unchanging failure once, not on every poll', async () => {
    // Telemetry is polled by every open dashboard. CI's first e2e run produced a screenful of the
    // same "spawn /usr/sbin/zpool: No such file or directory" line, several a second, which is a
    // box with no ZFS installed saying so forever. Said once it is information; on a loop it
    // teaches whoever greps the log that warnings here mean nothing.
    const { agent } = stubAgent({});
    const system = new SystemService(agent, stubDb(null), []);
    const warn = vi.spyOn(
      (system as unknown as { logger: { warn: (m: string) => void } }).logger,
      'warn',
    );

    await system.telemetry('c');
    await system.telemetry('c');
    await system.telemetry('c');

    // Two distinct conditions — the pool list and the disk inventory — each once.
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('keeps the rest of telemetry when the pool list cannot be enumerated', async () => {
    // Deliberately NOT the same rule as a configured pool the agent refuses. That one is a real
    // fault — a typo, or a pool that has gone away — and dropping it would present a partial list
    // as complete. Not being able to ENUMERATE is the ordinary state of a box with no ZFS
    // installed yet, and a missing `zpool` must not take the CPU and memory cards down with it.
    const { agent } = stubAgent({});
    const telemetry = await new SystemService(agent, stubDb(null), []).telemetry('c');
    expect(telemetry.pools).toEqual([]);
    expect(telemetry.memory).toBeDefined();
  });

  it('finds the disks to read SMART for when nobody configured a list', async () => {
    // The reason `ListDisks` was added. `DEPSIS_SMART_DISKS` had to be typed into api.env by hand,
    // and there was nothing to type it FROM — so the common case was an appliance reporting no
    // disk health at all while having disks.
    const { agent, calls } = stubAgent({
      list_pools: { status: 'pools', pools: [] },
      list_disks: INVENTORY,
      read_smart_summary: { status: 'smart', healthy: true, temperature_celsius: 31, raw: '{}' },
    });
    const system = new SystemService(agent, stubDb(null), []);

    const telemetry = await system.telemetry('c');

    expect(telemetry.disks?.map((d) => d.id)).toEqual(['ata-SYSTEM_DISK_1', 'ata-BLANK_2']);
    expect(calls.filter((c) => c.key === 'list_disks')).toHaveLength(1);
  });

  it('leaves a removable disk out of the discovered set', async () => {
    // A USB stick is a disk and it is not part of the appliance's storage. On a health dashboard
    // an operator reads as "the array is fine", a card reader with no card in it is noise.
    const { agent } = stubAgent({
      list_pools: { status: 'pools', pools: [] },
      list_disks: {
        status: 'disks',
        truncated: false,
        disks: [
          {
            by_id: 'usb-Generic_Flash',
            kname: 'sdc',
            size_bytes: 8_000_000_000,
            model: null,
            serial: null,
            wwn: null,
            rotational: false,
            removable: true,
            transport: 'usb',
            holds: ['vfat'],
            mounted: false,
            holds_system: false,
          },
        ],
      },
    });

    expect((await new SystemService(agent, stubDb(null), []).telemetry('c')).disks).toEqual([]);
  });

  it('does not discover when a list was configured', async () => {
    // An operator who narrowed the list on purpose must not find it widened back.
    const { agent, calls } = stubAgent({
      list_pools: { status: 'pools', pools: [] },
      read_smart_summary: { status: 'smart', healthy: true, temperature_celsius: 30, raw: '{}' },
    });
    const system = new SystemService(agent, stubDb(null), [], ['ata-ONLY_THIS_ONE']);

    const telemetry = await system.telemetry('c');

    expect(telemetry.disks?.map((d) => d.id)).toEqual(['ata-ONLY_THIS_ONE']);
    expect(calls.some((c) => c.key === 'list_disks')).toBe(false);
  });

  it('keeps the pool status when the inventory cannot be read', async () => {
    // Discovery is a convenience over a configured list. Letting it fail the whole call would
    // take away the pool health — the part that says whether the array is still serving data —
    // because of a feature that exists to save somebody typing.
    const { agent } = stubAgent({ tank: ONLINE });
    const system = new SystemService(agent, stubDb(null), ['tank']);

    const telemetry = await system.telemetry('c');

    expect(telemetry.pools).toHaveLength(1);
    expect(telemetry.disks).toEqual([]);
  });

  it('reports the share tree as prepared when a dataset is mounted at the root', async () => {
    const { agent } = stubAgent({
      share_root_status: {
        status: 'share_root',
        path: '/srv/depsis',
        dataset: 'tank/depsis',
        empty: true,
      },
      list_pools: { status: 'pools', pools: ['tank'] },
    });
    const setup = await new SystemService(agent, stubDb(null), []).storageSetup('c');

    expect(setup.shareRoot).toEqual({ path: '/srv/depsis', dataset: 'tank/depsis', empty: true });
    expect(setup.parentDataset).toBe('tank/depsis');
    expect(setup.pools).toEqual(['tank']);
  });

  it('reports no parent dataset when nothing is mounted at the root', async () => {
    // The state a fresh box is in. `POST /shares` answers 503 for it, and the wizard offers to fix
    // it — so it has to be absent rather than an empty string, which would be a dataset name.
    const { agent } = stubAgent({
      share_root_status: { status: 'share_root', path: '/srv/depsis', dataset: null, empty: true },
      list_pools: { status: 'pools', pools: [] },
    });
    const setup = await new SystemService(agent, stubDb(null), []).storageSetup('c');
    expect(setup).not.toHaveProperty('parentDataset');
    expect(setup.shareRoot).not.toHaveProperty('dataset');
  });

  it('lets the configured dataset win over what the box reports', async () => {
    // An operator who wrote `DEPSIS_SHARE_PARENT_DATASET` meant that one. Discovery is a fallback,
    // and a fallback that overrode the setting would be a setting that silently stopped working.
    const { agent } = stubAgent({
      share_root_status: {
        status: 'share_root',
        path: '/srv/depsis',
        dataset: 'tank/depsis',
        empty: true,
      },
      list_pools: { status: 'pools', pools: ['tank'] },
    });
    const system = new SystemService(agent, stubDb(null), [], [], 'baska/havuz');
    expect((await system.storageSetup('c')).parentDataset).toBe('baska/havuz');
    expect(await system.parentDataset('c')).toBe('baska/havuz');
  });

  it('answers the parent dataset from the box when nothing was configured', async () => {
    // The whole point: an operator who created a pool through the wizard can create a share
    // without editing `api.env` and restarting the API.
    const { agent } = stubAgent({
      share_root_status: {
        status: 'share_root',
        path: '/srv/depsis',
        dataset: 'tank/depsis',
        empty: true,
      },
    });
    expect(await new SystemService(agent, stubDb(null), []).parentDataset('c')).toBe('tank/depsis');
  });

  it('answers null rather than guessing when the box cannot be asked', async () => {
    // There is no sensible dataset name to invent: a wrong one produces datasets nothing serves —
    // the row exists, `zfs list` shows it, and the share is empty in the file manager.
    const { agent } = stubAgent({});
    expect(await new SystemService(agent, stubDb(null), []).parentDataset('c')).toBeNull();
  });

  it('still reports the share root when the pool list cannot be read', async () => {
    // The two callers of this data want opposite things from the same failure. Telemetry must not
    // report "no pools" about a machine it could not ask; this endpoint's caller is deciding
    // whether to offer a wizard, and refusing the whole answer would hide the half that says
    // whether shares can be created at all.
    const { agent } = stubAgent({
      share_root_status: { status: 'share_root', path: '/srv/depsis', dataset: null, empty: true },
    });
    const setup = await new SystemService(agent, stubDb(null), []).storageSetup('c');
    expect(setup.pools).toEqual([]);
    expect(setup.shareRoot.path).toBe('/srv/depsis');
  });

  it('carries every field the wizard needs, and an absent serial as absent', async () => {
    // `serial` is nullable BECAUSE it was measured to be: VPD page 0x80 is broken under Hyper-V
    // (ADR-0000), which is the hypervisor this project develops against. A confirmation dialogue
    // keyed on the serial alone would show an empty field on exactly that box.
    const { agent } = stubAgent({ list_disks: INVENTORY });
    const inventory = await new SystemService(agent, stubDb(null), []).inventory('c');

    expect(inventory.complete).toBe(true);
    expect(inventory.disks[0]).toEqual({
      byId: 'ata-SYSTEM_DISK_1',
      kname: 'sda',
      sizeBytes: 512_110_190_592,
      model: 'Samsung SSD 860',
      serial: 'S3Z8NB0K',
      wwn: '0x5002538e40a1b2c3',
      rotational: false,
      removable: false,
      transport: 'sata',
      holds: ['gpt', 'vfat', 'ext4'],
      mounted: true,
      holdsSystem: true,
    });
    // Absent, not null and not an empty string: the field is optional in the contract, and a `""`
    // reaching a confirmation dialogue would render as a disk whose serial is blank rather than
    // unknown.
    expect(inventory.disks[1]).not.toHaveProperty('serial');
  });

  it('refuses rather than reporting an empty box', async () => {
    // The most dangerous wrong answer this endpoint could give. Its caller is choosing disks to
    // overwrite, and "there are none" reads as a finished, safe inventory.
    const { agent } = stubAgent({ list_disks: { status: 'refused', reason: 'lsblk is missing' } });
    await expect(new SystemService(agent, stubDb(null), []).inventory('c')).rejects.toThrow(
      /lsblk is missing/,
    );
  });

  it('reports a truncated inventory as incomplete', async () => {
    const { agent } = stubAgent({ list_disks: { status: 'disks', truncated: true, disks: [] } });
    expect((await new SystemService(agent, stubDb(null), []).inventory('c')).complete).toBe(false);
  });

  it('omits what it cannot measure instead of inventing it', async () => {
    const { agent } = stubAgent({ list_pools: { status: 'pools', pools: [] } });
    const telemetry = await new SystemService(agent, stubDb(null), []).telemetry('c');

    // Nothing in the agent's operation set reports CPU temperature. `read_smart_summary` returns a
    // DISK temperature, which is a different sensor — putting it here would mislabel a real number.
    expect(telemetry.cpu?.temperatureCelsius).toBeUndefined();
    expect(telemetry.memory?.totalBytes).toBeGreaterThan(0);
    // Used must be a real subset of total, not a number that only looks plausible.
    expect(telemetry.memory?.usedBytes).toBeGreaterThan(0);
    expect(telemetry.memory?.usedBytes).toBeLessThanOrEqual(telemetry.memory?.totalBytes ?? 0);
  });
});

describe('who counts as the administrator', () => {
  it('is the user system_setup recorded, and nobody else', async () => {
    const { agent } = stubAgent({});
    const system = new SystemService(agent, stubDb('admin-1'), []);

    expect(await system.isSystemAdministrator('admin-1')).toBe(true);
    expect(await system.isSystemAdministrator('someone-else')).toBe(false);
  });

  it('reads system_setup without a tenant context, and says why', async () => {
    const justifications: string[] = [];
    const db = {
      withoutTenant: (justification: string, fn: (q: unknown) => Promise<unknown>) => {
        justifications.push(justification);
        return fn({ query: () => Promise.resolve([{ n: '0' }]) });
      },
      // If the service ever reached for a tenant context instead, the row would be invisible and a
      // legitimate administrator would be silently denied rather than the call failing.
      withTenant: vi.fn(),
    } as unknown as DbService;

    const { agent } = stubAgent({});
    await new SystemService(agent, db, []).isSystemAdministrator('u');

    expect(justifications).toEqual(['system-admin-check']);
    expect(
      (db as unknown as { withTenant: ReturnType<typeof vi.fn> }).withTenant,
    ).not.toHaveBeenCalled();
  });
});
