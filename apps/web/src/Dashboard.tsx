/**
 * The three formatters every screen shares.
 *
 * This file used to be the dashboard — a page of tables in an admin panel that the owner of the
 * appliance rejected. The page is gone and the desktop draws its own tiles now, but these
 * functions are called from a dozen places and `format.test.ts` pins their behaviour, so they
 * stay at this path rather than moving: a rename here buys nothing and costs the test its import.
 */

/**
 * Binary units, and labelled as such.
 *
 * `KiB` rather than `kB`: a NAS reports capacity in powers of two everywhere else — `zpool list`,
 * `df`, Windows Explorer — and a screen that quietly divides by 1000 makes the box look like it has
 * less space than every other tool says it does.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit] ?? 'B'}`;
}

/** A share of a total, or an em dash when the total is zero — never `NaN%`. */
export function percent(part: number, total: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return '—';
  return `${Math.round((part / total) * 100)}%`;
}

export function formatWhen(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '—';
  return when.toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' });
}
