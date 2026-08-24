import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api } from './api.js';
import { CreatePool } from './CreatePool.js';
import { formatBytes } from './Dashboard.js';
import type { Snapshot as SystemSnapshot } from './snapshot.js';
import { Empty } from './ui.js';

type Disk = OpenApi.components['schemas']['DiskInventoryEntry'];
type Inventory = OpenApi.components['schemas']['DiskInventory'];
type Storage = OpenApi.components['schemas']['StorageSetup'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

interface Props {
  notify: Notify;
  snapshot: SystemSnapshot;
}

/**
 * Disks — GET /system/disks.
 *
 * Deliberately not part of the storage card in the side panel, and not merged into telemetry. Those
 * answer "how are the disks I was told about"; this answers "what is in the box", and the two come
 * apart in exactly the case that matters — a disk nobody configured is invisible to the first and
 * is the whole subject of the second.
 *
 * WHAT THIS SCREEN IS FOR. §8.1 requires every destructive storage operation to be preceded by an
 * analysis that names the affected disks by serial or WWN. This is that analysis, shown on its own
 * before there is anything to confirm — an inventory somebody can read while the appliance is
 * still safe is worth more than the same list inside a dialogue they are trying to get past.
 *
 * The `holds` column is the one to read. Empty means the disk carries nothing DEPSIS could find;
 * anything else means using it destroys something.
 */
export function Disks({ notify, snapshot }: Props): React.JSX.Element {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  /**
   * What the box's storage already is.
   *
   * Read beside the inventory rather than inside the wizard, because it is also worth SAYING on
   * this screen: an appliance with a pool and no share tree looks completely healthy here and
   * cannot serve a single file.
   */
  const [storage, setStorage] = useState<Storage | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'forbidden' | 'unavailable' | 'failed'>(
    'loading',
  );
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    let alive = true;
    setState('loading');
    void (async () => {
      const { data, response } = await api.GET('/system/disks', {});
      if (!alive) return;
      if (response.status === 403) {
        setState('forbidden');
        return;
      }
      if (response.status === 503) {
        // Its own state, not an empty list. "This box has no disks" and "we could not ask" look
        // identical as an empty table, and they are the two answers furthest apart in meaning.
        setState('unavailable');
        return;
      }
      if (data === undefined) {
        notify('error', 'Disk envanteri okunamadı.');
        setState('failed');
        return;
      }
      setInventory(data);
      setState('ready');
      // Separately, and its failure is not this screen's failure: the inventory is worth showing
      // even when the storage question could not be answered.
      const setup = await api.GET('/system/storage', {});
      if (alive) setStorage(setup.data ?? null);
    })();
    return () => {
      alive = false;
    };
  }, [reloadKey, notify]);

  if (state === 'loading') return <p className="note">Yükleniyor…</p>;
  if (state === 'forbidden') return <Empty glyph="🖴" text="Diskler yalnız yöneticilere görünür." />;
  if (state === 'unavailable') {
    return (
      <Empty
        glyph="⚠"
        text="Depolama ajanına ulaşılamıyor, bu yüzden disklerin ne olduğu sorulamadı."
        action={
          <button type="button" className="b" onClick={reload}>
            Yeniden dene
          </button>
        }
      />
    );
  }
  if (state === 'failed' || inventory === null) {
    return (
      <Empty
        glyph="⚠"
        text="Disk envanteri okunamadı."
        action={
          <button type="button" className="b" onClick={reload}>
            Yeniden dene
          </button>
        }
      />
    );
  }

  const disks = inventory.disks;
  const smart = snapshot.telemetry?.disks ?? [];
  /** SMART health by `/dev/disk/by-id`, so the two lists join on the id and not on position. */
  const health = new Map(smart.map((entry) => [entry.id, entry]));

  return (
    <>
      {!inventory.complete && (
        <div className="warn">
          <span className="ic" aria-hidden>
            ⚠
          </span>
          <span className="tx">
            <b>Bu liste kesildi.</b>
            Kutu, ajanın tek yanıtta bildirebileceğinden fazla blok aygıtı sunuyor. Aşağıdaki
            listeyi tam bir envanter olarak okumayın.
          </span>
        </div>
      )}

      {disks.length === 0 ? (
        <Empty glyph="🖴" text="Ajan bu kutuda hiç disk bulamadı." />
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Disk</th>
              <th>Boyut</th>
              <th>Üstünde ne var</th>
              <th>SMART</th>
            </tr>
          </thead>
          <tbody>
            {disks.map((disk) => (
              <Row key={disk.byId ?? disk.kname} disk={disk} smart={health.get(disk.byId ?? '')} />
            ))}
          </tbody>
        </table>
      )}

      <p className="note">
        Kararlı ad (<code>/dev/disk/by-id</code>) kimliktir; <code>sda</code> gibi bir çekirdek adı
        yeniden başlatmada başka bir diski gösterebilir. Bir diskin serisi boş görünebilir — bazı
        hipervizörler onu bozuk bildiriyor, o yüzden kimlik için WWN kullanılır.
      </p>

      {/* The wizard renders inside the inventory rather than in a window of its own: §8.1 wants the
          analysis in front of the operator while they confirm, and a dialogue that covers the table
          it was opened from takes it away at exactly the wrong moment. */}
      {storage !== null && storage.parentDataset === undefined && storage.pools.length > 0 && (
        <div className="warn">
          <span className="ic" aria-hidden>
            ⚠
          </span>
          <span className="tx">
            <b>Bu kutuda havuz var ama paylaşım ağacı yok.</b>
            DEPSIS paylaşımları hangi veri kümesinin altında açacağını bilmiyor, o yüzden yeni
            paylaşım açılamıyor. Aşağıdaki sihirbaz yeni bir havuzla birlikte kurabilir; var olan
            bir havuz için kabuktan:{' '}
            <code>
              zfs create -o mountpoint={storage.shareRoot.path ?? '/srv/depsis'} -o acltype=posixacl
              -o xattr=sa {storage.pools[0]}/depsis
            </code>
          </span>
        </div>
      )}

      <CreatePool disks={disks} storage={storage} notify={notify} onCreated={reload} />
    </>
  );
}

function Row({
  disk,
  smart,
}: {
  disk: Disk;
  smart: OpenApi.components['schemas']['DiskStatus'] | undefined;
}): React.JSX.Element {
  return (
    <tr>
      <td>
        <div>
          <b>{disk.model ?? disk.kname}</b>
          {disk.removable && <span className="pill dim"> çıkarılabilir</span>}
        </div>
        <div className="m" style={{ opacity: 0.75, fontSize: '0.85em' }}>
          {disk.byId ?? `${disk.kname} — kararlı adı yok`}
        </div>
        <div className="m" style={{ opacity: 0.55, fontSize: '0.8em' }}>
          {[
            disk.kname,
            disk.transport,
            disk.rotational ? 'döner' : 'katı hâl',
            // The serial when there is one. Absent is shown as absent rather than as a blank
            // column: a reader has to be able to tell "no serial" from "I forgot to render it".
            disk.serial === undefined ? 'seri yok' : `s/n ${disk.serial}`,
            disk.wwn,
          ]
            .filter((part) => part !== undefined && part !== '')
            .join(' · ')}
        </div>
      </td>
      <td className="m">{formatBytes(disk.sizeBytes)}</td>
      <td>
        {disk.holdsSystem ? (
          // The one state that is never a candidate, so it is said first and in the strongest
          // words the row has. Overwriting this disk destroys the appliance.
          <span className="pill bad">sistem diski</span>
        ) : disk.holds.length === 0 ? (
          <span className="pill live">boş</span>
        ) : (
          <>
            <span className="m">{disk.holds.join(', ')}</span>
            {disk.mounted && <span className="pill warn"> bağlı</span>}
          </>
        )}
      </td>
      <td>
        {smart === undefined ? (
          <span className="m" style={{ opacity: 0.55 }}>
            —
          </span>
        ) : (
          <>
            <span className={smart.healthy ? 'pill live' : 'pill bad'}>
              {smart.healthy ? 'sağlıklı' : 'sorunlu'}
            </span>
            {smart.temperatureCelsius !== undefined && (
              <span className="m"> {smart.temperatureCelsius}°C</span>
            )}
          </>
        )}
      </td>
    </tr>
  );
}
