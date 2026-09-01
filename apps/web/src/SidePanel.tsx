import type { OpenApi } from '@depsis/contracts';
import React from 'react';
import { useEffect, useState } from 'react';

import type { PaneId } from './App.js';
import { api } from './api.js';
import { formatBytes, percent } from './Dashboard.js';
import { Ring, Spark } from './sky.js';
import type { Snapshot } from './snapshot.js';
import { Card, Empty } from './ui.js';

type RemoteStatus = OpenApi.components['schemas']['RemoteStatus'];

/**
 * The right-hand column: storage, load, and the way in from outside.
 *
 * Everything here is read-only on purpose. It is the strip a person glances at, and a control
 * that changes the machine sitting in a glance-strip is a control that gets pressed by accident.
 * The work happens in the windows these cards point at.
 */

type Remote = { state: 'loading' } | { state: 'error' } | { state: 'ready'; status: RemoteStatus };

export function SidePanel({
  snapshot,
  onOpen,
}: {
  snapshot: Snapshot;
  /**
   * Optional so the shared signature — `{ snapshot }` — still satisfies this component. When it
   * is supplied the remote card becomes a way into its window; when it is not, the card is still
   * a truthful readout rather than a button that does nothing.
   */
  onOpen?: (pane: PaneId) => void;
}): React.JSX.Element {
  const [remote, setRemote] = useState<Remote>({ state: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const { data } = await api.GET('/remote', {});
      if (cancelled) return;
      // `/remote` answers 200 even when ZeroTier is not installed — `available: false` is a state,
      // not a fault — so anything that is not a body here really is a failure to reach the API.
      setRemote(data === undefined ? { state: 'error' } : { state: 'ready', status: data });
    };
    void load();
    // Thirty seconds. A network authorisation is granted by a human in another browser tab; it
    // does not need to be noticed within a second, and this call reaches out to a daemon.
    const timer = window.setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <aside className="side" aria-label="Cihaz durumu">
      <StorageCard snapshot={snapshot} {...(onOpen === undefined ? {} : { onOpen })} />
      <SystemCard snapshot={snapshot} {...(onOpen === undefined ? {} : { onOpen })} />
      <RemoteCard remote={remote} {...(onOpen === undefined ? {} : { onOpen })} />
    </aside>
  );
}

/** The amber caution box, used for the things that are true but not errors. */
function Notice({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="notice">
      <span className="ic" aria-hidden>
        ⚠
      </span>
      <span className="tx">{text}</span>
    </div>
  );
}

/* ─── storage ───────────────────────────────────────────────────────────────── */

function StorageCard({
  snapshot,
  onOpen,
}: {
  snapshot: Snapshot;
  onOpen?: (pane: PaneId) => void;
}): React.JSX.Element {
  const telemetry = snapshot.telemetry;
  const pools = telemetry?.pools ?? [];
  const used = pools.reduce((sum, pool) => sum + pool.used, 0);
  const free = pools.reduce((sum, pool) => sum + pool.available, 0);
  const total = used + free;
  const unhealthy = pools.filter((pool) => pool.health !== 'ONLINE');
  const disks = telemetry?.disks ?? [];

  return (
    <Card
      glyph="💽"
      tone="cool"
      title="Depolama"
      {...(onOpen === undefined ? {} : { onClick: () => onOpen('disks') })}
      meta={pools.length === 0 ? '' : `${pools.length} havuz`}
    >
      <div className="cb">
        {telemetry === null ? (
          <Notice text={snapshot.telemetryNote ?? 'Depolama durumu okunamadı.'} />
        ) : pools.length === 0 ? (
          <Empty glyph="💽" text="Havuz yapılandırılmadı" />
        ) : (
          <>
            <div className="ring">
              <Ring
                ratio={total > 0 ? used / total : 0}
                tone={unhealthy.length === 0 ? 'cool' : 'rose'}
              />
              <div>
                <b>{formatBytes(used)}</b>
                <small>
                  {formatBytes(total)} içinde · {percent(used, total)}
                </small>
              </div>
            </div>

            {pools.map((pool) => (
              <div className="r" key={pool.name}>
                <span
                  className="d"
                  style={{ background: pool.health === 'ONLINE' ? 'var(--live)' : 'var(--rose)' }}
                />
                <span className="n">{pool.name}</span>
                <span className="v">{pool.health}</span>
              </div>
            ))}

            {/* Temperature is the one reading that predicts a failure before the pool notices it,
                and it is per disk rather than per pool — a mirror is exactly as cool as its
                hottest half. */}
            {disks.map((disk) => (
              <div className="r" key={disk.id}>
                <span
                  className="d"
                  style={{ background: disk.healthy ? 'var(--live)' : 'var(--rose)' }}
                />
                <span className="n" title={disk.id}>
                  {diskLabel(disk.id, disk.label)}
                </span>
                <span className="v">
                  {disk.temperatureCelsius === undefined ? '—' : `${disk.temperatureCelsius} °C`}
                </span>
              </div>
            ))}

            {unhealthy.length > 0 && (
              <div className="warn" role="alert">
                <span className="ic" aria-hidden>
                  ⚠
                </span>
                <span className="tx">
                  <b>{unhealthy.length} havuz sağlıklı değil</b>
                  {unhealthy.map((pool) => `${pool.name} (${pool.health})`).join(', ')}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

/**
 * `/dev/disk/by-id/ata-WDC_WD40EFRX-68N32N0_WD-WCC7K4KP1H2X` in a 90px column is a row of
 * ellipsis. The last segment is what identifies the drive to whoever has to pull it out; the full
 * path stays on the `title` for anyone who needs to paste it into a command.
 */
function diskLabel(id: string, given?: string): string {
  // KULLANICININ VERDİĞİ AD VARSA O. Bu sütunun işi diski POMPADAN ÇEKECEK insana onu tanıtmak,
  // ve bunu en iyi yapan şey kişinin kendi koyduğu ad — "Sol yuva", "Eski Seagate".
  if (given !== undefined && given.trim() !== '') return given;
  const parts = id.split('/');
  return parts[parts.length - 1] ?? id;
}

/* ─── system ────────────────────────────────────────────────────────────────── */

function SystemCard({
  snapshot,
  onOpen,
}: {
  snapshot: Snapshot;
  onOpen?: (pane: PaneId) => void;
}): React.JSX.Element {
  const telemetry = snapshot.telemetry;
  const cpu = telemetry?.cpu;
  const load = cpu?.loadAverage?.[0];
  const temperature = cpu?.temperatureCelsius;
  const memory = telemetry?.memory;
  const memoryUsed = memory?.usedBytes;
  const memoryTotal = memory?.totalBytes;

  return (
    <Card
      glyph="📊"
      tone="rose"
      title="Sistem"
      {...(onOpen === undefined ? {} : { onClick: () => onOpen('system') })}
      meta=""
    >
      <div className="cb">
        {telemetry === null ? (
          <Notice text={snapshot.telemetryNote ?? 'Sistem durumu okunamadı.'} />
        ) : (
          <>
            {/* Load average, not "% işlemci". The reference wrote a percentage and the agent
                reports `loadAverage`, which has no ceiling — 1.8 on an eight-core box is idle and
                on a single-core box it is overloaded. Printing it as a percentage would be a
                number that is wrong in both directions. */}
            <div className="fig">
              {load === undefined ? '—' : load.toFixed(2)}
              <small>yük ortalaması</small>
            </div>
            <Spark values={snapshot.cpuHistory} />

            {temperature !== undefined && (
              <div className="r">
                <span
                  className="d"
                  style={{ background: temperature >= 80 ? 'var(--rose)' : 'var(--live)' }}
                />
                <span className="n">İşlemci sıcaklığı</span>
                <span className="v">{Math.round(temperature)} °C</span>
              </div>
            )}

            {memoryUsed !== undefined && memoryTotal !== undefined && memoryTotal > 0 && (
              <div className="r">
                <span
                  className="d"
                  style={{
                    background: memoryUsed / memoryTotal >= 0.9 ? 'var(--warn)' : 'var(--live)',
                  }}
                />
                <span className="n">Bellek</span>
                <span className="v">
                  {formatBytes(memoryUsed)} / {formatBytes(memoryTotal)}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

/* ─── remote access ─────────────────────────────────────────────────────────── */

function RemoteCard({
  remote,
  onOpen,
}: {
  remote: Remote;
  onOpen?: (pane: PaneId) => void;
}): React.JSX.Element {
  const meta =
    remote.state !== 'ready'
      ? ''
      : !remote.status.available
        ? 'kurulu değil'
        : remote.status.online === true
          ? 'çevrimiçi'
          : 'çevrimdışı';

  const open: { onClick?: () => void } = {};
  if (onOpen !== undefined) open.onClick = () => onOpen('remote');

  return (
    <Card glyph="🌐" tone="cool" title="Uzak erişim" meta={meta} {...open}>
      <div className="cb">
        {remote.state === 'loading' && <span className="thint">Yükleniyor…</span>}

        {remote.state === 'error' && (
          <div className="notice error" role="alert">
            <span className="ic" aria-hidden>
              !
            </span>
            <span className="tx">Uzak erişim durumu okunamadı.</span>
          </div>
        )}

        {remote.state === 'ready' && !remote.status.available && (
          <Empty
            glyph="🌐"
            text="ZeroTier kurulu değil"
            action={
              <span>
                DEPSIS onu paketlemiyor. Cihaza kurup servisi başlattığınızda düğüm kimliği ve ağlar
                burada görünür.
              </span>
            }
          />
        )}

        {remote.state === 'ready' && remote.status.available && (
          <>
            {/* Sahibin sözüyle: "bakınca görmen gereken önemli şeyler". Düğüm kimliği ve sürüm
                bir tanılama ayrıntısı — onlar Uzaktan erişim penceresinde. Burada, bir cihazdan
                bağlanacak kişinin KOPYALAYACAĞI üç şey duruyor. */}
            {remote.status.networks.slice(0, 1).map((n) => (
              <React.Fragment key={n.networkId}>
                {n.addresses.length > 0 && (
                  <div className="r">
                    <span className="d" style={{ background: 'var(--live)' }} />
                    <span>Bağlantı IP</span>
                    <b className="m">{n.addresses.join(' · ')}</b>
                  </div>
                )}
                <div className="r">
                  <span className="d" style={{ background: 'var(--cyan, #5bc8f5)' }} />
                  <span>Bağlantı kimliği</span>
                  <b className="m">{n.networkId}</b>
                </div>
              </React.Fragment>
            ))}
            <div className="r">
              <span className="d" style={{ background: 'var(--iris, #8fa6ff)' }} />
              <span>Samba</span>
              <b className="m">{'\\\\depsis'}</b>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
