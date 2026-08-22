import type { OpenApi } from '@depsis/contracts';
import { useEffect, useState } from 'react';

import { api } from './api.js';

type Telemetry = OpenApi.components['schemas']['Telemetry'];

interface Props {
  onUnauthenticated: () => void;
  /** Telemetry is administrator-only, and a member deserves to be told that rather than shown an error. */
  isAdmin: boolean;
}

/**
 * What the box is doing.
 *
 * `/system/telemetry` has answered since Phase 1 began and nothing had ever called it — a working
 * endpoint with no screen is, to the person who owns the appliance, an endpoint that does not
 * exist.
 */
export function Dashboard({ onUnauthenticated, isAdmin }: Props): React.JSX.Element {
  const [state, setState] = useState<
    { name: 'loading' } | { name: 'ready'; data: Telemetry } | { name: 'error'; message: string }
  >({ name: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const { data, response } = await api.GET('/system/telemetry', {});
      if (cancelled) return;
      if (response.status === 401) {
        onUnauthenticated();
        return;
      }
      if (response.status === 403) {
        // Not an error either. Telemetry is administrator-only because there is no per-user
        // narrowing of system detail yet, and saying so is more useful than a red box.
        setState({
          name: 'error',
          message: 'Sistem telemetrisi yalnızca yöneticilere açık.',
        });
        return;
      }
      if (response.status === 503) {
        // A distinct state, not an error. The agent being unreachable is a real and recoverable
        // condition on an appliance that has not finished setting up its storage, and calling it
        // "failed" sends someone looking for a fault that is not there.
        setState({
          name: 'error',
          message:
            'Depolama ajanı erişilebilir değil. Havuz henüz kurulmadıysa bu beklenen durumdur.',
        });
        return;
      }
      if (data === undefined) {
        setState({ name: 'error', message: 'Telemetri okunamadı.' });
        return;
      }
      setState({ name: 'ready', data });
    };

    if (!isAdmin) {
      setState({ name: 'error', message: 'Sistem telemetrisi yalnızca yöneticilere açık.' });
      return;
    }

    void load();
    // Ten seconds. Frequent enough that a pool going degraded is noticed while someone is looking
    // at the screen, rare enough that an idle tab is not a load source — every poll reaches the
    // privileged agent, and that agent serves one control connection at a time.
    const timer = setInterval(() => void load(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [onUnauthenticated, isAdmin]);

  if (state.name === 'loading') return <section className="card">Yükleniyor…</section>;
  if (state.name === 'error') {
    return (
      <section className="card">
        <h1>Panel</h1>
        <p className="warning" role="alert">
          {state.message}
        </p>
      </section>
    );
  }

  const { data } = state;
  return (
    <section className="card wide">
      <h1>Panel</h1>

      <div className="tiles">
        <Tile
          label="Yük ortalaması"
          value={(data.cpu?.loadAverage ?? []).map((n) => n.toFixed(2)).join(' · ') || '—'}
        />
        <Tile
          label="Bellek"
          value={`${formatBytes(data.memory?.usedBytes ?? 0)} / ${formatBytes(
            data.memory?.totalBytes ?? 0,
          )}`}
          hint={percent(data.memory?.usedBytes ?? 0, data.memory?.totalBytes ?? 0)}
        />
        <Tile label="Havuz sayısı" value={String(data.pools.length)} />
      </div>

      <h2>Havuzlar</h2>
      {data.pools.length === 0 ? (
        <p className="muted">
          Yapılandırılmış havuz yok. Bu, depolamanın henüz kurulmadığı anlamına gelir — telemetri
          çalışıyor, gösterecek havuz yok.
        </p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Havuz</th>
                <th>Sağlık</th>
                <th>Kullanılan</th>
                <th>Boş</th>
                <th>Doluluk</th>
              </tr>
            </thead>
            <tbody>
              {data.pools.map((pool) => (
                <tr key={pool.name}>
                  <td>{pool.name}</td>
                  <td>
                    {/* ONLINE is not the only healthy state, but it is the only one that needs no
                        attention. Anything else is called out rather than rendered as plain text,
                        because a degraded mirror that looks like every other row is a degraded
                        mirror nobody notices. */}
                    <span className={pool.health === 'ONLINE' ? 'ok' : 'bad'}>{pool.health}</span>
                  </td>
                  <td>{formatBytes(pool.used)}</td>
                  <td>{formatBytes(pool.available)}</td>
                  <td>{percent(pool.used, pool.used + pool.available)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Tile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): React.JSX.Element {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {hint !== undefined && <span className="tile-hint">{hint}</span>}
    </div>
  );
}

/**
 * Binary units, and labelled as such.
 *
 * `KiB` rather than `kB`: a NAS reports capacity in powers of two everywhere else — `zpool list`,
 * `df`, Windows Explorer — and a screen that quietly divides by 1000 makes the box look like it
 * has less space than every other tool says it does.
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
