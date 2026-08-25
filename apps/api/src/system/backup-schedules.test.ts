import { describe, expect, it } from 'vitest';

import { nextRun, prefixFor, prunable, snapshotNameFor } from './backup-schedules.service.js';

/**
 * The two decisions a scheduled backup gets to make, and both are pure so both can be measured.
 *
 * WHICH SNAPSHOTS DIE is the one that costs data when it is wrong, and it costs it silently: a
 * user looks for the snapshot they wanted on the day they need it, which is months after the
 * pruning that removed it. Every test below that names a hand-made snapshot is there because that
 * is the failure — a retention policy that reaches past its own snapshots.
 *
 * WHEN THE NEXT RUN IS is the one that costs the backup entirely when it is wrong: a schedule that
 * computes a time in the past runs every tick, and one that computes the same time it just ran at
 * runs forever in a loop. Both are pinned.
 */

function snap(name: string, iso: string): { name: string; createdAt: Date } {
  return { name, createdAt: new Date(iso) };
}

describe('which snapshots a schedule prunes', () => {
  it('never touches a snapshot it did not take', () => {
    // THE ONE THAT MATTERS. `gece-yarisi` is somebody's own snapshot, taken by hand before an
    // upgrade; `zfs-auto-snap_daily-…` is another tool's. A retention policy that counted either
    // towards `keep` — or worse, removed one — would be data loss the user finds out about on the
    // day they go looking.
    const inventory = [
      snap('depsis-daily-20260820T030000Z', '2026-08-20T03:00:00Z'),
      snap('gece-yarisi', '2026-08-21T00:00:00Z'),
      snap('depsis-daily-20260821T030000Z', '2026-08-21T03:00:00Z'),
      snap('zfs-auto-snap_daily-2026-08-22-0300', '2026-08-22T03:00:00Z'),
      snap('depsis-daily-20260822T030000Z', '2026-08-22T03:00:00Z'),
    ];

    const doomed = prunable(inventory, 'daily', 2);
    expect(doomed).toEqual(['depsis-daily-20260820T030000Z']);
    // Stated as its own assertion rather than left implicit in the list above, because this is the
    // property and the list is only one example of it.
    expect(doomed.every((name) => name.startsWith(prefixFor('daily')))).toBe(true);
  });

  it('does not count another cadence towards this one', () => {
    // An hourly and a daily schedule on the same dataset is the ordinary configuration. If the
    // daily one counted the hourly snapshots, `keep: 7` would leave seven HOURS of history and
    // remove every daily one — which reads as "my backups only go back a day" with nothing broken.
    const inventory = [
      snap('depsis-hourly-20260822T010000Z', '2026-08-22T01:00:00Z'),
      snap('depsis-hourly-20260822T020000Z', '2026-08-22T02:00:00Z'),
      snap('depsis-hourly-20260822T030000Z', '2026-08-22T03:00:00Z'),
      snap('depsis-daily-20260821T030000Z', '2026-08-21T03:00:00Z'),
      snap('depsis-daily-20260822T030000Z', '2026-08-22T03:00:00Z'),
    ];
    expect(prunable(inventory, 'daily', 2)).toEqual([]);
    expect(prunable(inventory, 'hourly', 2)).toEqual(['depsis-hourly-20260822T010000Z']);
  });

  it('keeps the newest and removes oldest-first', () => {
    const inventory = [
      snap('depsis-daily-a', '2026-08-20T03:00:00Z'),
      snap('depsis-daily-b', '2026-08-21T03:00:00Z'),
      snap('depsis-daily-c', '2026-08-22T03:00:00Z'),
      snap('depsis-daily-d', '2026-08-23T03:00:00Z'),
    ];
    // Oldest first, so a pruning interrupted half way leaves the NEWEST snapshots behind rather
    // than a random subset.
    expect(prunable(inventory, 'daily', 1)).toEqual([
      'depsis-daily-a',
      'depsis-daily-b',
      'depsis-daily-c',
    ]);
  });

  it('removes nothing when there is nothing spare', () => {
    const inventory = [snap('depsis-daily-a', '2026-08-20T03:00:00Z')];
    expect(prunable(inventory, 'daily', 1)).toEqual([]);
    expect(prunable(inventory, 'daily', 7)).toEqual([]);
    expect(prunable([], 'daily', 7)).toEqual([]);
  });

  it('breaks a tie by name rather than by whatever order it was handed', () => {
    // Two snapshots in the same second is not hypothetical on a fast pool. An undefined order
    // leaves "which one dies" to the sort implementation, and a test that passed today would
    // start failing on a different runtime for no reason anybody could act on.
    const inventory = [
      snap('depsis-daily-b', '2026-08-20T03:00:00Z'),
      snap('depsis-daily-a', '2026-08-20T03:00:00Z'),
    ];
    expect(prunable(inventory, 'daily', 1)).toEqual(['depsis-daily-a']);
    expect(prunable([...inventory].reverse(), 'daily', 1)).toEqual(['depsis-daily-a']);
  });

  it('names snapshots so that the name itself says which schedule made it', () => {
    const name = snapshotNameFor('daily', new Date('2026-08-26T03:00:00.000Z'));
    expect(name).toBe('depsis-daily-20260826T030000Z');
    // A `SafeComponent`: no `/`, no `:`, nothing that reads as an option. The agent checks this
    // again, and a name that failed there would be a schedule that silently never took anything.
    expect(name).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/u);
  });
});

describe('when a schedule next runs', () => {
  it('is always strictly after the moment it is computed from', () => {
    // THE LOOP GUARD. A tick that ran at exactly 03:00 recomputes from 03:00; if equality were
    // allowed, it would land on 03:00 again and the schedule would run every tick forever.
    const at3 = new Date('2026-08-26T03:00:00');
    const next = nextRun('daily', 3, 0, null, at3);
    expect(next.getTime()).toBeGreaterThan(at3.getTime());
    expect(next.getDate()).toBe(27);
  });

  it('finds today when today is still ahead, and tomorrow when it is not', () => {
    const morning = new Date('2026-08-26T01:00:00');
    const evening = new Date('2026-08-26T23:00:00');
    expect(nextRun('daily', 3, 0, null, morning).getDate()).toBe(26);
    expect(nextRun('daily', 3, 0, null, evening).getDate()).toBe(27);
  });

  it('rolls an hourly schedule to the next hour once the minute has passed', () => {
    const at = new Date('2026-08-26T10:45:00');
    const next = nextRun('hourly', null, 30, null, at);
    expect(next.getHours()).toBe(11);
    expect(next.getMinutes()).toBe(30);

    const before = new Date('2026-08-26T10:15:00');
    expect(nextRun('hourly', null, 30, null, before).getHours()).toBe(10);
  });

  it('finds the right weekday, and the next week when that day has gone', () => {
    // 2026-08-26 is a Wednesday (getDay() === 3).
    const wednesday = new Date('2026-08-26T12:00:00');
    expect(wednesday.getDay()).toBe(3);

    // Friday this week.
    const friday = nextRun('weekly', 3, 0, 5, wednesday);
    expect(friday.getDay()).toBe(5);
    expect(friday.getDate()).toBe(28);

    // Monday is behind us, so next Monday.
    const monday = nextRun('weekly', 3, 0, 1, wednesday);
    expect(monday.getDay()).toBe(1);
    expect(monday.getDate()).toBe(31);

    // Today, but the hour has passed: a week from now, not in twenty minutes.
    const later = nextRun('weekly', 3, 0, 3, wednesday);
    expect(later.getDay()).toBe(3);
    expect(later.getDate()).toBe(2);
  });

  it('drops seconds so a schedule does not drift', () => {
    // `next_run_at` is compared against `now()` on every tick. Carrying the seconds from whenever
    // the tick happened to run would push each run a little later than the last.
    const at = new Date('2026-08-26T10:15:37.500');
    const next = nextRun('hourly', null, 30, null, at);
    expect(next.getSeconds()).toBe(0);
    expect(next.getMilliseconds()).toBe(0);
  });
});
