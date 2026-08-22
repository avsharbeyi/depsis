import type { OpenApi } from '@depsis/contracts';
import { useEffect, useState } from 'react';

import { api } from './api.js';
import { IconFile, IconFiles } from './ui.js';

type Telemetry = OpenApi.components['schemas']['Telemetry'];
type FileEntry = OpenApi.components['schemas']['FileEntry'];

interface Props {
  onUnauthenticated: () => void;
  /** Telemetry is administrator-only; a member gets the rest of the page rather than an error. */
  isAdmin: boolean;
}

interface Snapshot {
  telemetry: Telemetry | null;
  /** Why telemetry is absent, when it is. Distinct states, not one "failed". */
  telemetryNote: string | null;
  entries: FileEntry[];
  users: number | null;
}

/**
 * What the box is doing, on one screen.
 *
 * The previous version was three numbers and a table nobody could act on. What an appliance's front
 * page has to answer is narrower than "everything": how full is it, is anything wrong, and what
 * changed recently. Each tile answers one of those and nothing else is on the page.
 */
export function Dashboard({ onUnauthenticated, isAdmin }: Props): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      // In parallel. Serially, the slowest of the three would set the whole page's latency, and one
      // of them reaches the privileged agent over a socket that serves one call at a time.
      const [telemetry, files, users] = await Promise.all([
        isAdmin ? api.GET('/system/telemetry', {}) : Promise.resolve(null),
        api.GET('/files', { params: { query: {} } }),
        isAdmin ? api.GET('/users', {}) : Promise.resolve(null),
      ]);
      if (cancelled) return;

      if (files.response.status === 401) {
        onUnauthenticated();
        return;
      }

      let telemetryNote: string | null = null;
      if (!isAdmin) {
        telemetryNote = 'Depolama durumu yalnızca yöneticilere açık.';
      } else if (telemetry?.response.status === 503) {
        // Not a failure. An appliance whose storage is not set up yet has no agent to ask, and
        // sending someone to look for a fault that is not there is worse than saying so.
        telemetryNote = 'Depolama ajanı erişilebilir değil. Havuz henüz kurulmadıysa bu beklenen.';
      } else if (telemetry?.data === undefined) {
        telemetryNote = 'Depolama durumu okunamadı.';
      }

      setSnapshot({
        telemetry: telemetry?.data ?? null,
        telemetryNote,
        entries: files.data?.items ?? [],
        users: users?.data?.items.length ?? null,
      });
    };

    void load();
    // Ten seconds: often enough that a pool going degraded is noticed by someone looking at the
    // screen, rare enough that an idle tab is not a load source on the agent.
    const timer = setInterval(() => void load(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [onUnauthenticated, isAdmin]);

  if (snapshot === null) {
    return (
      <>
        <div className="page-head">
          <h1>Panel</h1>
        </div>
        <div className="panel">
          <p className="muted">Yükleniyor…</p>
        </div>
      </>
    );
  }

  const pools = snapshot.telemetry?.pools ?? [];
  const used = pools.reduce((sum, p) => sum + p.used, 0);
  const free = pools.reduce((sum, p) => sum + p.available, 0);
  const total = used + free;
  const unhealthy = pools.filter((p) => p.health !== 'ONLINE');
  const memory = snapshot.telemetry?.memory;
  const recent = [...snapshot.entries]
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    .slice(0, 6);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Panel</h1>
          <p className="muted">Cihazın durumu ve son değişiklikler.</p>
        </div>
      </div>

      {unhealthy.length > 0 && (
        <p className="notice error" role="alert">
          {unhealthy.length} havuz sağlıklı değil:{' '}
          {unhealthy.map((p) => `${p.name} (${p.health})`).join(', ')}
        </p>
      )}

      <div className="tiles">
        <div className="tile">
          <span className="tile-label">Boş alan</span>
          <span className="tile-value">{total > 0 ? formatBytes(free) : '—'}</span>
          <span className="tile-hint">
            {total > 0 ? `${formatBytes(total)} toplam` : 'Havuz yapılandırılmadı'}
          </span>
          {total > 0 && <Meter part={used} whole={total} />}
        </div>

        <div className="tile">
          <span className="tile-label">Havuz sağlığı</span>
          <span className="tile-value">
            {pools.length === 0 ? '—' : unhealthy.length === 0 ? 'İyi' : 'Dikkat'}
          </span>
          <span className="tile-hint">
            {pools.length === 0 ? 'Havuz yok' : `${pools.length} havuz`}
          </span>
        </div>

        <div className="tile">
          <span className="tile-label">Bellek</span>
          <span className="tile-value">
            {memory === undefined ? '—' : formatBytes(memory.usedBytes ?? 0)}
          </span>
          <span className="tile-hint">
            {memory === undefined ? 'Okunamadı' : `${formatBytes(memory.totalBytes ?? 0)} toplam`}
          </span>
          {memory !== undefined && (
            <Meter part={memory.usedBytes ?? 0} whole={memory.totalBytes ?? 0} />
          )}
        </div>

        <div className="tile">
          <span className="tile-label">Hesaplar</span>
          <span className="tile-value">{snapshot.users ?? '—'}</span>
          <span className="tile-hint">
            {snapshot.users === null ? 'Yalnızca yöneticiye görünür' : 'kayıtlı kullanıcı'}
          </span>
        </div>
      </div>

      {snapshot.telemetryNote !== null && <p className="notice warning">{snapshot.telemetryNote}</p>}

      <div className="panel">
        <h2>Son değişenler</h2>
        {recent.length === 0 ? (
          <div className="empty">
            <IconFiles />
            <p>Kökte henüz bir şey yok.</p>
            <a className="nav-item current" href="#/files" style={{ display: 'inline-flex' }}>
              Dosyalara git
            </a>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Ad</th>
                  <th className="right">Boyut</th>
                  <th className="hide-narrow">Değiştirilme</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <span className="name-cell">
                        {entry.kind === 'folder' ? <IconFiles className="folder" /> : <IconFile />}
                        {entry.name}
                      </span>
                    </td>
                    <td className="right">
                      {entry.kind === 'folder' ? '—' : formatBytes(entry.size)}
                    </td>
                    <td className="hide-narrow">{formatWhen(entry.modifiedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {pools.length > 0 && (
        <div className="panel">
          <h2>Havuzlar</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Havuz</th>
                  <th>Sağlık</th>
                  <th className="right">Kullanılan</th>
                  <th className="right">Boş</th>
                  <th className="right">Doluluk</th>
                </tr>
              </thead>
              <tbody>
                {pools.map((pool) => (
                  <tr key={pool.name}>
                    <td>{pool.name}</td>
                    <td>
                      {/* ONLINE is the only state that needs no attention. Anything else is a pill
                          rather than plain text, because a degraded mirror that looks like every
                          other row is a degraded mirror nobody notices. */}
                      <span className={pool.health === 'ONLINE' ? 'pill ok' : 'pill bad'}>
                        {pool.health}
                      </span>
                    </td>
                    <td className="right">{formatBytes(pool.used)}</td>
                    <td className="right">{formatBytes(pool.available)}</td>
                    <td className="right">{percent(pool.used, pool.used + pool.available)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

/** A bar that turns amber at 80% and red at 92%, so "nearly full" is visible without reading. */
function Meter({ part, whole }: { part: number; whole: number }): React.JSX.Element {
  const ratio = whole > 0 ? Math.min(1, part / whole) : 0;
  const tone = ratio >= 0.92 ? 'bad' : ratio >= 0.8 ? 'warn' : '';
  return (
    <div
      className="meter"
      role="meter"
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={`meter-fill ${tone}`} style={{ width: `${ratio * 100}%` }} />
    </div>
  );
}

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
