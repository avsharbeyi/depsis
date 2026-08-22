import type { OpenApi } from '@depsis/contracts';
import { useEffect, useState } from 'react';

import { api } from './api.js';
import { formatBytes, formatWhen, percent } from './Dashboard.js';
import { Empty } from './ui.js';

type Transfer = OpenApi.components['schemas']['Transfer'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

/** Two seconds. Slower and a 40 MB/s upload appears to jump; faster buys nothing an eye can use. */
const POLL_MS = 2000;

/**
 * The three states, and what each one is allowed to look like.
 *
 * `stalled` gets amber rather than a quieter grey on purpose: a transfer list earns its place at
 * exactly the moment a transfer has STOPPED, and a stopped upload that looks like a slow one is
 * the same as no list at all.
 */
const STATES: Record<Transfer['state'], { label: string; pill: string; fill: string }> = {
  active: { label: 'sürüyor', pill: 'st2 dn', fill: 'var(--cool)' },
  stalled: { label: 'durdu', pill: 'st2 er', fill: 'var(--warn)' },
  completed: { label: 'bitti', pill: 'st2 up', fill: 'var(--live)' },
};

export function Transfers({ notify }: { notify: Notify }): React.JSX.Element {
  const [items, setItems] = useState<Transfer[] | null>(null);
  /** Set only while the list has never been read. Once real rows have arrived, a dropped poll
   *  leaves the last known ones on screen rather than replacing them with a failure. */
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    // A failure is reported once and then the poll keeps going quietly. Two seconds of toasts for
    // an appliance that is briefly unreachable would bury every other message on the desktop.
    let complained = false;
    /** Whether the list has ever been read successfully in this window's lifetime. */
    let everLoaded = false;

    const load = async (): Promise<void> => {
      const { data } = await api.GET('/transfers', {});
      if (!alive) return;
      if (data === undefined) {
        if (!complained) {
          complained = true;
          notify('error', 'Aktarımlar okunamadı.');
        }
        // Not `current ?? []`. On the FIRST poll that turned into "Süren aktarım yok." — which is
        // exactly the wrong thing to tell somebody whose upload may still be running. Once real
        // rows have been seen, a dropped poll leaves them alone instead: they were true a moment
        // ago, which is closer than either an empty list or an error panel.
        if (!everLoaded) setFailed(true);
        return;
      }
      complained = false;
      everLoaded = true;
      setFailed(false);
      setItems(data.items);
    };

    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [notify]);

  return (
    <>
      {failed ? (
        <Empty glyph="⚠" text="Aktarımlar okunamadı." />
      ) : items === null ? (
        <p className="note">Yükleniyor…</p>
      ) : items.length === 0 ? (
        <Empty glyph="⇅" text="Süren aktarım yok." />
      ) : (
        <div>
          {items.map((item) => {
            const state = STATES[item.state];
            const ratio =
              item.lengthBytes > 0 ? Math.min(1, item.offsetBytes / item.lengthBytes) : 0;
            return (
              <div className="trrow" key={item.id}>
                <div className="l">
                  <span title={item.filename}>{item.filename}</span>
                  <em>{percent(item.offsetBytes, item.lengthBytes)}</em>
                  <em style={{ color: 'var(--mut)' }}>
                    {formatBytes(item.offsetBytes)} / {formatBytes(item.lengthBytes)}
                  </em>
                  <span className={state.pill} style={{ flex: 'none' }}>
                    {state.label}
                  </span>
                </div>
                {/* Written out rather than reusing <Bar/>: the fill colour IS the reading here, and
                    the shared bar has one tint for every caller by design. */}
                <div
                  className="bar2"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(ratio * 100)}
                >
                  <span style={{ width: `${ratio * 100}%`, background: state.fill }} />
                </div>
                {item.state === 'stalled' && (
                  <div className="l">
                    <span style={{ color: 'var(--warn)' }}>
                      Bir dakikadan uzun süredir ilerlemiyor — son yazma{' '}
                      {formatWhen(item.updatedAt)}. Yükleyen sekme kapanmış olabilir; aynı dosya
                      yeniden seçilirse kaldığı yerden devam eder.
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="note">
        Bu liste SUNUCUNUN bildiği yüklemeleri gösterir; başka bir sekmede başlatılan bir yükleme de
        burada görünür. İndirmeler yok: bir indirme tek bir HTTP isteği ve sunucu tarafında bir
        durumu yok.
      </div>
    </>
  );
}
