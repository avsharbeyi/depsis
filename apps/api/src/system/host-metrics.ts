import { readFileSync } from 'node:fs';
import { freemem, loadavg, platform, totalmem } from 'node:os';

export interface HostMemory {
  totalBytes: number;
  usedBytes: number;
}

/**
 * How much memory is actually in use, as Linux itself defines it.
 *
 * NOT `totalmem() - freemem()`. On Linux `os.freemem()` is /proc/meminfo's MemFree, which counts
 * only memory nobody has touched — it excludes the page cache and reclaimable slab, both of which
 * the kernel hands back on demand. A healthy Linux box fills its RAM with cache by design, so that
 * subtraction reports something close to "memory full" on a machine with plenty to spare. On a ZFS
 * box it is worse still: the ARC is deliberately sized to consume most of free memory.
 *
 * MemAvailable is the kernel's own estimate of what a new allocation could get, and is the value
 * /proc/meminfo exists to provide for exactly this question.
 */
export function readMemory(readMeminfo: () => string | null = defaultReadMeminfo): HostMemory {
  const total = totalmem();

  // No `platform() === 'linux'` guard. The read failing IS the not-Linux case, and one condition
  // that can be exercised by a caller beats two where one of them can only ever be true on the
  // target. An earlier attempt to prove the Linux branch ran compared readMemory() against a live
  // /proc/meminfo read taken moments earlier — the numbers move while the test runs, so it failed
  // against correct code. Injecting the reader makes the branch decidable on any machine.
  const meminfo = readMeminfo();
  const available = meminfo === null ? null : parseMemAvailable(meminfo);

  if (available !== null) {
    // Clamped, because MemAvailable is an estimate and can momentarily exceed MemTotal on a machine
    // with a lot of reclaimable slab. A negative "used" would be worse than a rounded one.
    return { totalBytes: total, usedBytes: Math.max(0, total - Math.min(available, total)) };
  }

  // Not Linux, or a kernel too old to publish MemAvailable (pre-3.14). Less accurate, but a number
  // with a defined meaning rather than an invented one.
  return { totalBytes: total, usedBytes: Math.max(0, total - freemem()) };
}

function defaultReadMeminfo(): string | null {
  try {
    return readFileSync('/proc/meminfo', 'utf8');
  } catch {
    return null;
  }
}

/**
 * Pull MemAvailable out of /proc/meminfo, in bytes.
 *
 * Separated from the file read so it can be tested off Linux. Without that split the parsing would
 * only ever run on the target and never in the suite — the test would pass on a developer machine
 * by exercising the fallback and prove nothing about the path production actually takes.
 */
export function parseMemAvailable(meminfo: string): number | null {
  // The unit is matched, not assumed. /proc/meminfo has always written kB, but a silently
  // mishandled unit here is a memory figure wrong by a factor of 1024 — which still looks like a
  // plausible number, and is therefore the kind of error nobody notices.
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
  if (match?.[1] === undefined) return null;
  return Number(match[1]) * 1024;
}

/**
 * The 1/5/15 minute load averages, or nothing.
 *
 * Omitted rather than reported as zeroes off Linux. `os.loadavg()` returns [0, 0, 0] on Windows
 * because Windows has no such concept, and a dashboard cannot tell that apart from an idle
 * machine — the field is optional in the contract precisely so it can be absent.
 */
export function readLoadAverage(): number[] | undefined {
  if (platform() === 'win32') return undefined;
  return loadavg();
}
