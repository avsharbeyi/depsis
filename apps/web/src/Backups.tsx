import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api, problemMessage } from './api.js';
import { formatBytes, formatWhen, percent } from './Dashboard.js';
import type { Snapshot as SystemSnapshot } from './snapshot.js';
import { Empty } from './ui.js';

/**
 * The contract calls a backup a `Snapshot`, and so does `snapshot.ts` — for a completely different
 * thing (the desktop's polled view of the system). Renaming the one that only lives in this file
 * is cheaper than reading `Snapshot` twice on one screen and guessing which is which.
 */
type Backup = OpenApi.components['schemas']['Snapshot'];
type BackupPage = OpenApi.components['schemas']['SnapshotPage'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

/** The contract's `CreateSnapshotRequest.name` pattern, so the field refuses what the server would. */
const SNAPSHOT_NAME = '[A-Za-z0-9_][A-Za-z0-9._\\-]{0,62}';

interface Props {
  notify: Notify;
  snapshot: SystemSnapshot;
}

/**
 * Backups — GET/POST /backups.
 *
 * Reading is administrator-only as well as writing, so whether the form appears is decided by what
 * the server answered rather than by a role this component was handed: a 403 on the listing is the
 * same fact the POST would produce, and it cannot drift from it.
 */
export function Backups({ notify, snapshot }: Props): React.JSX.Element {
  const [page, setPage] = useState<BackupPage | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [dataset, setDataset] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    void (async () => {
      const { data, response } = await api.GET('/backups', {});
      if (!alive) return;
      if (response.status === 403) {
        setForbidden(true);
        setPage({ items: [], complete: false });
        return;
      }
      if (data === undefined) {
        // Not an empty page. "DEPSIS henüz bir yedek almadı" is a claim about the appliance, and
        // a read that never answered is not evidence for it.
        notify('error', 'Yedekler okunamadı.');
        setFailed(true);
        return;
      }
      setPage(data);
    })();
    return () => {
      alive = false;
    };
  }, [reloadKey, notify]);

  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = dataset.trim();
    if (trimmed === '') return;
    setBusy(true);
    // `name` is left out entirely when it is blank rather than sent as an empty string: the server
    // generates one from the timestamp only when the field is ABSENT.
    const body: OpenApi.components['schemas']['CreateSnapshotRequest'] =
      name.trim() === '' ? { dataset: trimmed } : { dataset: trimmed, name: name.trim() };
    const { data, error, response } = await api.POST('/backups', { body });
    setBusy(false);
    if (response.status === 503) {
      notify('error', 'Depolama ajanı çalışmıyor. Yedek alınamadı.');
      return;
    }
    if (data === undefined) {
      notify('error', problemMessage(error, 'Yedek alınamadı.'));
      return;
    }
    notify('ok', `"${data.fullName}" alındı.`);
    setName('');
    reload();
  }

  const items: Backup[] = page?.items ?? [];
  // Datasets that already carry a backup. The API publishes no share listing, so this is the only
  // honest source of a suggestion — and it is a suggestion, not the set of valid answers.
  const known = [...new Set(items.map((item) => item.dataset))].sort();
  const pools = snapshot.telemetry?.pools ?? [];

  return (
    <>
      {/* Driven by `complete`, not hard-coded. The schema documents that field as the signal the
          client is supposed to read in order to say this, so a banner that merely happens to agree
          with it today would be decoupled from the thing it is reporting. */}
      {page !== null && !page.complete && (
        <div className="warn">
          <span className="ic" aria-hidden>
            ⚠
          </span>
          <span className="tx">
            <b>Bu liste havuzun envanteri değil.</b>
            DEPSIS yalnız kendi aldığı anlık görüntüleri kaydeder. Kabuktan `zfs snapshot` ile
            alınmış bir görüntü burada görünmez — yokluğu, olmadığı anlamına gelmez.
          </span>
        </div>
      )}

      {failed ? (
        <Empty
          glyph="⚠"
          text="Yedekler okunamadı."
          action={
            <button type="button" className="b" onClick={reload}>
              Yeniden dene
            </button>
          }
        />
      ) : page === null ? (
        <p className="note">Yükleniyor…</p>
      ) : forbidden ? (
        <Empty glyph="🗄" text="Yedekler yalnız yöneticilere görünür." />
      ) : items.length === 0 ? (
        <Empty glyph="🗄" text="DEPSIS henüz bir yedek almadı." />
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Ad</th>
              <th>Dataset</th>
              <th>Alındı</th>
              <th>Alan</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.name}</td>
                <td className="m">{item.dataset}</td>
                <td className="m">{formatWhen(item.createdAt)}</td>
                <td>{item.createdBy ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pools.length > 0 && (
        <div>
          <div className="lbl" style={{ marginBottom: 6 }}>
            Havuzlar
          </div>
          {pools.map((pool) => (
            <div className="netrow" key={pool.name}>
              <span className="lbl">{pool.name}</span>
              <span className="val">
                {formatBytes(pool.used)} / {formatBytes(pool.used + pool.available)} ·{' '}
                {percent(pool.used, pool.used + pool.available)}
              </span>
            </div>
          ))}
        </div>
      )}
      {snapshot.telemetry === null && snapshot.telemetryNote !== null && (
        <div className="note">{snapshot.telemetryNote}</div>
      )}

      {!forbidden && !failed && (
        <form
          onSubmit={(event) => void create(event)}
          style={{ display: 'flex', flexDirection: 'column', gap: 9 }}
        >
          <div className="lbl">Yedek al</div>
          <label>
            Dataset
            <input
              value={dataset}
              onChange={(event) => setDataset(event.target.value)}
              required
              maxLength={255}
              list="depsis-datasets"
              autoComplete="off"
              spellCheck={false}
              placeholder="ör. tank/depsis/ev"
            />
            <small>
              Paylaşımın veri kümesi. Kendi kiracınıza ait olmayan bir ad &quot;böyle bir dataset
              yok&quot; yanıtını alır.
            </small>
          </label>
          <datalist id="depsis-datasets">
            {known.map((item) => (
              <option value={item} key={item} />
            ))}
          </datalist>
          <label>
            Ad (isteğe bağlı)
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={63}
              pattern={SNAPSHOT_NAME}
              autoComplete="off"
              spellCheck={false}
              placeholder="boş bırakılırsa tarihten üretilir"
            />
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="submit" className="b pri" disabled={busy || dataset.trim() === ''}>
              {busy ? 'Alınıyor…' : 'Yedek al'}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
