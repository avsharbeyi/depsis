import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api, problemMessage } from './api.js';
import { DatabaseBackups } from './DatabaseBackups.js';
import { Offsite } from './Offsite.js';
import { Pool } from './Scrub.js';
import { Schedules } from './Schedules.js';
import { Replicate } from './Replicate.js';
import { formatBytes, formatWhen } from './Dashboard.js';
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
/**
 * Durumun insan tarafı, ve rengi.
 *
 * `missing` GÜL: kayıtta duran ama havuzda olmayan bir görüntü, var olmayan bir geri dönüş
 * noktası — ve bu listenin bir zamanlar sessizce yalan söylediği durumun ta kendisi. Ekranda
 * uyarı rengiyle durması, onu bir bilgi değil bir eylem çağrısı yapıyor.
 *
 * `unmanaged` NÖTR, uyarı değil: kabuktan alınmış bir görüntü tamamen meşru, ve DEPSIS onu
 * silmiyor. Yalnız artık saklamıyormuş gibi davranmıyor.
 */
const STATE: Record<string, { text: string; tone: string }> = {
  present: { text: 'Havuzda', tone: 'pill ok' },
  missing: { text: 'Havuzda yok', tone: 'pill bad' },
  unmanaged: { text: 'Kabuktan', tone: 'pill dim' },
  unknown: { text: 'Doğrulanmadı', tone: 'pill dim' },
};

/**
 * Durum rozeti.
 *
 * Kendi bileşeni, çünkü `state` sözleşmede isteğe bağlı ve bir sözlük araması `undefined`
 * dönebiliyor. Sunucu her zaman dolduruyor ama tip onu bilmiyor, ve bilmediği için bir varsayılan
 * gerekiyor — "doğrulanmadı", çünkü bilinmeyen bir durumu "havuzda" göstermek, listenin yeniden
 * yalan söylemesi olurdu.
 */
function Durum({ state }: { state: Backup['state'] }): React.JSX.Element {
  const shown = STATE[state ?? 'unknown'] ?? STATE['unknown'];
  return <span className={shown?.tone}>{shown?.text}</span>;
}

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
      {/* Sahibin sorusu bire bir buydu: "yedekleme ilk diski ikinci diske kopyalayacak ama yok."
          VAR — ama yedek olarak değil, aynanın kendisi olarak; ve bu ayrımı ekran söylemezse
          kimse söylemez. Ayna anı korur, yedek geçmişi: ikisi ayrı soru. */}
      <div className="note">
        <b>Disk kopyası ile yedek ayrı şeylerdir.</b> Havuzunuzu <b>ayna (mirror)</b> kurduysanız
        birinci diskteki her bayt zaten <b>anında</b> ikinci diske de yazılıyor — disk kopyası
        sürekli ve kendiliğinden, bir düğmesi yok. Aynanın koruMAdığı şey geçmiştir: yanlışlıkla
        silinen dosya iki diskten birden silinir. Onu koruyan aşağıdaki <b>yedekler</b> — belirli
        anların dondurulmuş görüntüleri. Bir zamanlama kurun; silinen dosya Dosyalar ekranındaki
        "Yedekler" kapısından geri gelir.
      </div>

      {/* `complete` false OLDUĞUNDA, ve artık bunun tek bir sebebi var: ajana ulaşılamadı.
          Eskiden her zaman false'tu — ajanda anlık görüntüleri listeleyecek bir işlem yoktu ve bu
          kutu "bu liste havuzun envanteri değil" diyordu. Artık liste havuzla karşılaştırılıyor,
          ve kutu yalnız karşılaştırmanın YAPILAMADIĞI hâlde çıkıyor. */}
      {page !== null && !page.complete && (
        <div className="warn">
          <span className="ic" aria-hidden>
            ⚠
          </span>
          <span className="tx">
            <b>Havuza sorulamadı.</b>
            Aşağıdakiler DEPSIS'in kendi kaydı, ve doğrulanmadı: kabuktan silinmiş bir görüntü
            burada hâlâ görünüyor olabilir. Depolama ajanı geri geldiğinde her satırın durumu
            yazacak.
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
              <th>Durum</th>
              <th>Alındı</th>
              <th>Yer</th>
              <th>Alan kişi</th>
            </tr>
          </thead>
          <tbody>
            {/* Anahtar `fullName`, `id` DEĞİL: havuzda bulunup kayıtta olmayan satırların kimliği
                null, ve null bir anahtar React'te aynı satırı iki kez çizdirir. `fullName`
                (`dataset@ad`) havuzda zaten benzersiz. */}
            {items.map((item) => (
              <tr key={item.fullName}>
                <td>{item.name}</td>
                <td className="m">{item.dataset}</td>
                <td>
                  <Durum state={item.state} />
                </td>
                <td className="m">{formatWhen(item.createdAt)}</td>
                {/* Yalnız havuzda bulunanlarda var: DEPSIS bir görüntünün yerini kaydetmiyor,
                    çünkü rakam zamanla değişiyor. */}
                <td className="m">
                  {item.usedBytes === undefined ? '—' : formatBytes(item.usedBytes)}
                </td>
                <td>{item.createdBy ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Yıkıcı form, ve varsayılan olarak kapalı: bir yedek listesine bakan kişinin çoğu
          zaman yapacağı şey bakmak. */}
      {page !== null && !forbidden && (
        <Replicate backups={items} notify={notify} onQueued={reload} />
      )}

      {/* İKİNCİ HAVUZ YETMİYOR, ve ayrı bir satır olması bunu söylüyor. Yukarıdaki çoğaltma bir
          diskin ölmesini atlatıyor; kutunun çalınmasını, evin yanmasını ya da fidye yazılımının
          bağlı her veri kümesine ulaşmasını atlatmıyor — ki insanlar "yedek" derken çoğunlukla
          bunu kastediyor. */}
      {page !== null && !forbidden && <Offsite backups={items} notify={notify} onQueued={reload} />}

      {/* ELLE BAŞLATILAN BİR YEDEK, ALINMAYAN BİR YEDEKTİR. Yukarıdaki iki form bir düğmeye
          basıldığında çalışıyor; bu, basılmadığında. */}
      {page !== null && !forbidden && <Schedules notify={notify} />}

      {/* EN ÇOK GÖZDEN KAÇAN SATIR. Yukarıdaki her şey kullanıcının DOSYALARINI koruyor; bu,
          o dosyaların kime ait olduğunu. */}
      {page !== null && !forbidden && <DatabaseBackups notify={notify} />}

      {pools.length > 0 && (
        <div>
          <div className="lbl" style={{ marginBottom: 6 }}>
            Havuzlar
          </div>
          {pools.map((pool) => (
            <Pool key={pool.name} pool={pool} notify={notify} />
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
