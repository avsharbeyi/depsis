import { freemem, totalmem } from 'node:os';
import { describe, expect, it } from 'vitest';

import { parseMemAvailable, readMemory } from './host-metrics.js';

/**
 * A real /proc/meminfo head, from Debian 13 under WSL2. Kept verbatim, including the alignment,
 * because the padding between the label and the number is exactly what a careless regex gets wrong.
 */
const MEMINFO = [
  'MemTotal:        8114420 kB',
  'MemFree:          317744 kB',
  'MemAvailable:    6893212 kB',
  'Buffers:           45180 kB',
  'Cached:          6398844 kB',
  'SwapCached:            0 kB',
].join('\n');

describe('parseMemAvailable', () => {
  it('reads the field Linux says to use, in bytes', () => {
    expect(parseMemAvailable(MEMINFO)).toBe(6_893_212 * 1024);
  });

  it('does not confuse MemAvailable with MemFree', () => {
    // The whole point of the function. MemFree excludes the page cache, and on this very sample the
    // difference is 6.3 GB — the gap between "nearly out of memory" and "mostly idle".
    expect(parseMemAvailable(MEMINFO)).not.toBe(317_744 * 1024);
  });

  it('returns null rather than a wrong number when the field is absent', () => {
    // Kernels before 3.14 have no MemAvailable. Guessing one from MemFree + Cached is a folk
    // formula, not the kernel's estimate; the caller falls back to something with a defined meaning.
    expect(
      parseMemAvailable('MemTotal:        8114420 kB\nMemFree:          317744 kB'),
    ).toBeNull();
  });

  it('refuses a unit it does not recognise', () => {
    // If /proc/meminfo ever reported something other than kB, silently multiplying by 1024 would
    // produce a plausible-looking figure that is wrong by three orders of magnitude.
    expect(parseMemAvailable('MemAvailable:    6893212 MB')).toBeNull();
    expect(parseMemAvailable('MemAvailable:    6893212')).toBeNull();
  });
});

describe('readMemory', () => {
  it('reports a total that matches the OS and a used value inside it', () => {
    const memory = readMemory();
    expect(memory.totalBytes).toBe(totalmem());
    expect(memory.usedBytes).toBeGreaterThan(0);
    expect(memory.usedBytes).toBeLessThanOrEqual(memory.totalBytes);
  });

  it('subtracts MemAvailable when /proc/meminfo has it — on any platform', () => {
    // The reader is injected precisely so this branch is decidable off Linux. Reading a live
    // /proc/meminfo and comparing would not settle it: the numbers move while the test runs, which
    // is how an earlier version of this failed against code that was right.
    const total = totalmem();
    const available = Math.floor(total / 2);
    const meminfo = `MemTotal: ${Math.floor(total / 1024)} kB\nMemAvailable: ${Math.floor(available / 1024)} kB\n`;

    const memory = readMemory(() => meminfo);
    expect(memory.usedBytes).toBe(total - Math.floor(available / 1024) * 1024);
  });

  it('falls back when there is no /proc/meminfo to read', () => {
    // Asserted as a RELATIONSHIP between the two branches, not against a second live reading of
    // freemem(). Comparing to `totalmem() - freemem()` computed in the test failed by 80 kB, because
    // free memory moves between the two calls — the same mistake, made twice in one afternoon, and
    // caught both times only by running it.
    const fallback = readMemory(() => null);
    const fromMeminfo = readMemory(() => `MemAvailable: ${Math.floor(totalmem() / 4 / 1024)} kB\n`);

    expect(fallback.usedBytes).toBeGreaterThan(0);
    expect(fallback.usedBytes).toBeLessThanOrEqual(fallback.totalBytes);
    // The fixture says three quarters are in use; a fallback that happened to agree to the byte
    // would mean the branch was not taken at all.
    expect(fallback.usedBytes).not.toBe(fromMeminfo.usedBytes);
    // And it is genuinely the freemem() figure, to within the drift of one process's allocations.
    expect(Math.abs(fallback.usedBytes - (totalmem() - freemem()))).toBeLessThan(64 * 1024 * 1024);
  });

  it('never reports more used than exists, even if MemAvailable exceeds the total', () => {
    // MemAvailable is an estimate and can momentarily exceed MemTotal on a machine with a lot of
    // reclaimable slab. Unclamped that is a negative "used", which no dashboard renders sensibly.
    const memory = readMemory(() => `MemAvailable: ${totalmem()} kB\n`);
    expect(memory.usedBytes).toBe(0);
  });
});
