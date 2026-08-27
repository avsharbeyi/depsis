import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api, problemMessage } from './api.js';
import { formatBytes } from './Dashboard.js';
import { Empty } from './ui.js';

type ProcessRow = OpenApi.components['schemas']['ProcessRow'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

/**
 * Görev yöneticisi — sahibin sözüyle "arkaplan hizmetleri... sistem görevi olmayanların
 * kapatabildiği bir panel".
 *
 * Kapatılabilirlik kararı BURADA VERİLMEZ: her satır ajandan `protected` bayrağıyla gelir ve
 * kapatma isteği aynı kuraldan geçer. Bu ekran yalnız bayrağın söylediğini çizer — düğme
 * çizmediğine ajan zaten "hayır" derdi, ikisi tek kaynaktan konuşur.
 *
 * Kapat = SIGTERM. Süreç kendini toplar; inat edeni ikinci basış da TERM'ler — SIGKILL bu
 * panelde bilerek yok, yarıda kesilen bir yazma bırakmanın düğmesi olmaz.
 */
export function Processes({ notify }: { notify: Notify }): React.JSX.Element {
  const [rows, setRows] = useState<ProcessRow[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [busyPid, setBusyPid] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data, error, response } = await api.GET('/system/processes', {});
      if (!alive) return;
      if (response.status === 403) {
        setFailed('Görev yöneticisi yalnız cihazı kuran hesaba açık.');
        return;
      }
      if (data === undefined) {
        setFailed(problemMessage(error, 'Süreç listesi okunamadı.'));
        return;
      }
      setFailed(null);
      // Bellek iştahına göre, çoktan aza: aranan süreç çoğunlukla "şu an ne yiyor" sorusunun
      // cevabıdır ve o cevap en üstte durmalı.
      setRows([...data.items].sort((a, b) => b.rssBytes - a.rssBytes));
      setTruncated(data.truncated);
    })();
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  async function kill(row: ProcessRow): Promise<void> {
    setBusyPid(row.pid);
    const { data, error } = await api.POST('/system/processes/kill', {
      body: { pid: row.pid, comm: row.comm },
    });
    setBusyPid(null);
    if (data !== undefined) {
      notify('ok', `'${row.comm}' kapatma sinyali aldı.`);
      // Sürecin kendini toplaması bir iki saniye sürebilir; hemen tazelenen liste onu hâlâ
      // gösterir ve düğme "çalışmadı" gibi okunur.
      window.setTimeout(reload, 1200);
      return;
    }
    notify('error', problemMessage(error, 'Süreç kapatılamadı.'));
    reload();
  }

  return (
    <>
      <div className="netrow">
        <span className="lbl">Görev yöneticisi</span>
        <span className="val">{rows?.length ?? '—'} süreç</span>
        <button type="button" className="b" onClick={reload}>
          Yenile
        </button>
      </div>

      <p className="note">
        Sistem süreçleri (DEPSIS'in kendisi, veritabanı, ağ) kilitli gelir ve bu panelden
        kapatılamaz — düğmesi olmayan satırlar onlar. Kapat, sürece toparlanma şansı veren nazik
        sinyaldir; inat eden süreç için tekrar basın.
      </p>

      {failed !== null && <Empty glyph="⚠" text={failed} />}
      {failed === null && rows === null && <p className="note">Yükleniyor…</p>}
      {truncated && (
        <p className="note">Liste ilk 400 süreçle sınırlı; kutuda bundan fazlası koşuyor.</p>
      )}

      {(rows ?? []).map((row) => (
        <div className="urow" key={row.pid}>
          <span className="i">
            <b>{row.comm}</b>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, opacity: 0.8 }}>
              {row.args === '' ? `pid ${row.pid}` : row.args.slice(0, 90)}
            </span>
          </span>
          <span className="val m">{row.user}</span>
          <span className="val m">{formatBytes(row.rssBytes)}</span>
          {row.protected ? (
            <span className="st2 dn">sistem</span>
          ) : (
            <button
              type="button"
              className="b"
              disabled={busyPid === row.pid}
              onClick={() => void kill(row)}
            >
              {busyPid === row.pid ? 'Kapatılıyor…' : 'Kapat'}
            </button>
          )}
        </div>
      ))}
    </>
  );
}
