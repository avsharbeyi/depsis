import { describe, expect, it } from 'vitest';

import { formatBytes, percent } from './Dashboard.js';

/**
 * The two functions on the dashboard that can be wrong without looking wrong.
 *
 * A capacity figure is the number an operator decides on, and there is no error state for "this
 * says 931 GB and the pool holds 1 TB" — it just quietly disagrees with every other tool.
 */
describe('formatBytes', () => {
  it('uses binary units, because every other tool on the box does', () => {
    // A NAS reports capacity in powers of two in `zpool list`, `df` and Windows Explorer. Dividing
    // by 1000 here would make the appliance look smaller than it is, consistently and invisibly.
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MiB');
    expect(formatBytes(1024 ** 4)).toBe('1.0 TiB');
  });

  it('does not put a decimal point on a byte count', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
  });

  it('drops the decimal once the number is large enough not to need it', () => {
    // `931.3 GiB` and `931 GiB` say the same thing; the second fits in a narrow column.
    expect(formatBytes(931 * 1024 ** 3)).toBe('931 GiB');
  });

  it('answers with an em dash rather than NaN', () => {
    // Reached whenever a field is missing from a response. `NaN B` in a capacity column reads as a
    // fault in the pool rather than a gap in the payload.
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
  });

  it('stops at the largest unit it knows rather than running off the end of the table', () => {
    expect(formatBytes(1024 ** 6)).toBe('1024 PiB');
  });
});

describe('percent', () => {
  it('rounds to a whole number', () => {
    expect(percent(1, 3)).toBe('33%');
    expect(percent(2, 3)).toBe('67%');
  });

  it('refuses to divide by zero', () => {
    // An empty pool is the ordinary state of a freshly created one, and `NaN%` beside it is the
    // most alarming way to render "nothing is wrong".
    expect(percent(0, 0)).toBe('—');
    expect(percent(5, 0)).toBe('—');
  });
});
