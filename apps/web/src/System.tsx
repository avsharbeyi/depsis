import type { Snapshot } from './snapshot.js';
import { formatBytes } from './Dashboard.js';
import { Empty } from './ui.js';
import { Ring, Spark } from './sky.js';
import { CertificatePanel } from './Certificate.js';
import { UpdatePanel } from './Update.js';

/**
 * Sistem penceresi — sahibin sözüyle "işlemci ram disk kullanımları sıcaklıkları... grafik ekran".
 *
 * Kenar çubuğundaki Sistem kutusu bir ÖZET; bu, ona tıklayınca açılan AYRINTI. Aynı telemetri
 * akışını (`useSnapshot`) okuyor — ikinci bir yoklama açmıyor, çünkü iki ayrı zamanlayıcı aynı
 * diskin sıcaklığı hakkında ayrı şeyler söyleyebilir.
 *
 * Grafik, `cpuHistory`: son ~6 dakikanın yük ortalaması. Anlık bir sayı "şu an ne oluyor"u
 * söyler ama "biraz önce ne oldu"yu değil, ve bir NAS'ta ikincisi çoğu zaman aranan sorudur.
 */
export function System({
  snapshot,
  onProcesses,
  notify,
}: {
  snapshot: Snapshot | null;
  /** Yazılım güncellemesi bu ekranda: kutunun kendisiyle ilgili her şey burada aranıyor.
      Panel yetkiyi kendi soruyor ve yönetici değilse hiç çizilmiyor. */
  notify?: ((kind: 'ok' | 'error', text: string) => void) | undefined;
  /** Görev yöneticisini aç — sahibi onu bu ekranın içinde arıyor, ayrı bir rıhtım simgesinde
      değil. Yalnız kurucu yöneticiye veriliyor; yoksa düğme hiç çizilmiyor. */
  onProcesses?: (() => void) | undefined;
}): React.JSX.Element {
  if (snapshot === null)
    return (
      <>
        {notify !== undefined && <UpdatePanel notify={notify} />}
        {notify !== undefined && <CertificatePanel notify={notify} />}
        <p className="note">Sistem durumu okunuyor…</p>
      </>
    );

  const telemetry = snapshot.telemetry;
  if (telemetry === null) {
    return (
      <>
        {notify !== undefined && <UpdatePanel notify={notify} />}
        {notify !== undefined && <CertificatePanel notify={notify} />}
        <Empty glyph="📈" text={snapshot.telemetryNote ?? 'Sistem durumu okunamadı.'} />
      </>
    );
  }

  const load = telemetry.cpu.loadAverage?.[0];
  const temp = telemetry.cpu.temperatureCelsius;
  const mem = telemetry.memory;
  const memUsed = mem?.usedBytes ?? 0;
  const memTotal = mem?.totalBytes ?? 0;
  const disks = telemetry.disks ?? [];

  return (
    <>
      {notify !== undefined && <UpdatePanel notify={notify} />}
      {notify !== undefined && <CertificatePanel notify={notify} />}

      {onProcesses !== undefined && (
        <div className="netrow" style={{ marginBottom: 4 }}>
          <span className="lbl">Arka plan görevleri</span>
          <button type="button" className="b" onClick={onProcesses}>
            ⚙ Görev yöneticisi
          </button>
        </div>
      )}

      {/* ── işlemci ── */}
      <div className="syshead">İşlemci</div>
      <div className="sysgrid">
        <Stat
          label="Yük ortalaması"
          value={typeof load === 'number' ? load.toFixed(2) : '—'}
          note="1 dakikalık; çekirdek sayısına göre okuyun"
        />
        <Stat
          label="Sıcaklık"
          value={typeof temp === 'number' ? `${Math.round(temp)}°C` : '—'}
          {...(typeof temp === 'number' && temp >= 75 ? { tone: 'warn' as const } : {})}
        />
      </div>
      <div className="sysspark">
        <Spark values={snapshot.cpuHistory} />
        <span className="note">Son ~6 dakikanın yük ortalaması</span>
      </div>

      {/* ── bellek ── */}
      <div className="syshead">Bellek</div>
      {memTotal > 0 ? (
        <div className="ring">
          <Ring ratio={memUsed / memTotal} tone="iris" />
          <div>
            <b>{formatBytes(memUsed)}</b>
            <small>
              {formatBytes(memTotal)} içinde · {Math.round((memUsed / memTotal) * 100)}%
            </small>
          </div>
        </div>
      ) : (
        <p className="note">Bellek bilgisi yok.</p>
      )}

      {/* ── depolama ── */}
      <div className="syshead">Depolama havuzları</div>
      {telemetry.pools.length === 0 ? (
        <Empty glyph="💽" text="Havuz yapılandırılmadı" />
      ) : (
        telemetry.pools.map((pool) => {
          const total = pool.used + pool.available;
          return (
            <div className="sysrow" key={pool.name}>
              <span
                className="d"
                style={{ background: pool.health === 'ONLINE' ? 'var(--live)' : 'var(--rose)' }}
              />
              <span className="i">
                <b>{pool.name}</b>
                <span className="m">{pool.health}</span>
              </span>
              <span className="val m">
                {formatBytes(pool.used)} / {formatBytes(total)}
              </span>
              <span className="val">{total > 0 ? Math.round((pool.used / total) * 100) : 0}%</span>
            </div>
          );
        })
      )}

      {/* ── diskler ── */}
      <div className="syshead">Diskler</div>
      {disks.length === 0 ? (
        <p className="note">
          İzlenen disk yok. Diskler ekranından bir havuz kurunca sıcaklık ve sağlık buraya düşer.
        </p>
      ) : (
        disks.map((disk) => (
          <div className="sysrow" key={disk.id}>
            <span
              className="d"
              style={{ background: disk.healthy ? 'var(--live)' : 'var(--rose)' }}
            />
            <span className="i">
              <b className="m">{disk.id}</b>
              <span className="m">{disk.healthy ? 'sağlıklı' : 'DİKKAT'}</span>
            </span>
            <span className="val">
              {typeof disk.temperatureCelsius === 'number' ? `${disk.temperatureCelsius}°C` : '—'}
            </span>
          </div>
        ))
      )}
    </>
  );
}

function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: 'warn';
}): React.JSX.Element {
  return (
    <div className="sysstat">
      <span className="lbl">{label}</span>
      <b style={tone === 'warn' ? { color: 'var(--warn)' } : undefined}>{value}</b>
      {note !== undefined && <span className="note">{note}</span>}
    </div>
  );
}
