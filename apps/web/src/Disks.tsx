import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api } from './api.js';
import { CreatePool } from './CreatePool.js';
import { formatBytes } from './Dashboard.js';
import { ShareTreeNotice } from './ShareTree.js';
import type { Snapshot as SystemSnapshot } from './snapshot.js';
import { Empty, PromptBox } from './ui.js';

type Disk = OpenApi.components['schemas']['DiskInventoryEntry'];
type Inventory = OpenApi.components['schemas']['DiskInventory'];
type Storage = OpenApi.components['schemas']['StorageSetup'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

interface Props {
  notify: Notify;
  snapshot: SystemSnapshot;
}

/**
 * Depolama ekranı — kenar çubuğundaki Depolama kutusuna tıklayınca açılan yer.
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
 *
 * EKRAN ÖNCE DURUMU SÖYLER, sonra envanteri gösterir. Eskiden doğrudan ham aygıtların tablosuyla
 * açılıyordu, ve sahibin ilk sorusu — "depolamam hazır mı, değilse ne yapmam gerekiyor" —
 * hiçbir yerde cevaplanmıyordu: cevabın parçaları kenar çubuğunda, Sistem ekranında ve bu
 * tablonun altındaki bir uyarıda dağınık duruyordu.
 */
export function Disks({ notify, snapshot }: Props): React.JSX.Element {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  /** Adı sorulan disk. `by-id` adı taşınıyor çünkü kaydın anahtarı o. */
  const [naming, setNaming] = useState<{ byId: string; current: string } | null>(null);
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

  /**
   * Diske ad verir ya da adını kaldırır.
   *
   * BOŞ AD, ADI KALDIRIYOR — ve bu sunucunun da kuralı: "adı yok" boş bir metinle değil, satırın
   * olmamasıyla anlatılıyor. Kullanıcı için bu, ad kutusunu boşaltmanın "adı sil" demek olması.
   */
  async function saveLabel(byId: string, label: string): Promise<void> {
    const { response } = await api.PUT('/system/disks/{diskId}/label', {
      params: { path: { diskId: byId } },
      body: { label },
    });
    if (!response.ok) {
      notify('error', 'Ad kaydedilemedi.');
      return;
    }
    notify('ok', label.trim() === '' ? 'Diskin adı kaldırıldı.' : `Diskin adı: ${label.trim()}`);
    reload();
  }

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
  const pools = storage?.pools ?? [];
  // ÜÇ DURUM, ve üçünün de yapılacak farklı bir şeyi var. `storage === null` dördüncüsü:
  // depolama durumu okunamadı, ve o zaman hiçbir iddiada bulunulmuyor.
  const needsTree = storage !== null && pools.length > 0 && storage.parentDataset === undefined;
  const ready = storage !== null && pools.length > 0 && storage.parentDataset !== undefined;
  const smart = snapshot.telemetry?.disks ?? [];
  /** SMART health by `/dev/disk/by-id`, so the two lists join on the id and not on position. */
  const health = new Map(smart.map((entry) => [entry.id, entry]));

  return (
    <>
      <StorageState
        ready={ready}
        needsTree={needsTree}
        pools={pools}
        unknown={storage === null}
        snapshot={snapshot}
      />

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
              <Row
                key={disk.byId ?? disk.kname}
                disk={disk}
                smart={health.get(disk.byId ?? '')}
                onRename={(d) => setNaming({ byId: d.byId ?? '', current: d.label ?? '' })}
              />
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
      {/* Havuz var, ağaç yok: ürünün en sinsi ara durumu. Kutu tamamen sağlıklı görünür ve tek
          bir dosya sunamaz. Buradaki tavsiye bir KABUK KOMUTUYDU (`zfs create -o mountpoint=…`)
          ve bu, ürünün kabul ölçütüne aykırıydı: cihazın sahibi olağan hiçbir iş için terminale
          girmemeli. Artık bir düğme — ve AYNI düğme Paylaşımlar ekranında da duruyor, çünkü
          eksikliği orada fark eden birinin buraya geleceğini varsaymak sahada tutmadı. */}
      <ShareTreeNotice storage={storage} notify={notify} onPrepared={reload} />

      {/* Sihirbaz: gereken durumda AÇIK, gerekmeyen durumda katlanmış. Depolaması hazır bir
          kutuda ekranın diskleri silen bir sihirbazla bitmesi, en nadir eylemi en görünür yere
          koymak olurdu. */}
      {ready ? (
        <details>
          <summary className="note">Yeni bir havuz kur</summary>
          <CreatePool disks={disks} storage={storage} notify={notify} onCreated={reload} />
        </details>
      ) : (
        <CreatePool disks={disks} storage={storage} notify={notify} onCreated={reload} />
      )}
      {naming !== null && (
        <PromptBox
          title="Diske ad ver"
          label="Ad (boş bırakırsanız ad kaldırılır)"
          initial={naming.current}
          confirmLabel="Kaydet"
          onCancel={() => setNaming(null)}
          onSubmit={(value) => {
            const target = naming;
            setNaming(null);
            if (target !== null) void saveLabel(target.byId, value);
          }}
        />
      )}
    </>
  );
}

/**
 * Ekranın ilk satırı: depolama hangi durumda, ve sıradaki adım ne.
 *
 * ÜÇ DURUM VE HER BİRİNİN BİR CÜMLESİ VAR, çünkü bu ekranın cevaplaması gereken ilk soru
 * "kutuda hangi diskler var" değil — o ikinci soru. İlki, sahibin gerçekten sorduğu şey:
 * depolamam çalışıyor mu, çalışmıyorsa ne yapmam gerekiyor.
 */
function StorageState({
  ready,
  needsTree,
  pools,
  unknown,
  snapshot,
}: {
  ready: boolean;
  needsTree: boolean;
  pools: string[];
  unknown: boolean;
  snapshot: SystemSnapshot;
}): React.JSX.Element {
  const live = snapshot.telemetry?.pools ?? [];
  const used = live.reduce((sum, pool) => sum + pool.used, 0);
  const total = live.reduce((sum, pool) => sum + pool.used + pool.available, 0);
  const sick = live.filter((pool) => pool.health !== 'ONLINE');

  // BİLİNMİYOR, "kurulmadı" DEĞİL. İkisi bir ekranda aynı görünürse, sorulamayan bir soru
  // olumsuz bir cevap gibi okunur ve sahibi olmayan bir sorunu çözmeye çalışır.
  if (unknown) {
    return (
      <div className="netrow">
        <span className="lbl">Depolama</span>
        <span className="pill dim">durum okunamadı</span>
      </div>
    );
  }

  return (
    <>
      <div className="netrow">
        <span className="lbl">Depolama</span>
        {pools.length === 0 ? (
          <span className="pill warn">kurulmadı</span>
        ) : needsTree ? (
          <span className="pill warn">yarım</span>
        ) : sick.length > 0 ? (
          <span className="pill bad">{sick[0]?.health ?? 'sorunlu'}</span>
        ) : (
          <span className="pill">hazır</span>
        )}
        {pools.length > 0 && (
          <span className="note">
            {pools.join(', ')}
            {total > 0 && ` · ${formatBytes(used)} / ${formatBytes(total)}`}
          </span>
        )}
      </div>
      <p className="note">
        {pools.length === 0
          ? 'Bu kutuda henüz havuz yok. Aşağıdaki listeden diskleri seçip bir havuz kurun; havuz kurulduğunda paylaşım ağacı da birlikte kurulur.'
          : needsTree
            ? 'Havuz kurulu ama paylaşımların açılacağı ağaç yok. Aşağıdaki düğme onu kurar.'
            : ready
              ? 'Paylaşım açılabilir. Aşağıdaki liste kutudaki bütün diskleri gösterir — havuzda olmayanlar da dahil.'
              : ''}
      </p>
    </>
  );
}

function Row({
  disk,
  smart,
  onRename,
}: {
  disk: Disk;
  smart: OpenApi.components['schemas']['DiskStatus'] | undefined;
  onRename: (disk: Disk) => void;
}): React.JSX.Element {
  return (
    <tr>
      <td>
        <div>
          {/* ── ÖNCE İNSANIN VERDİĞİ AD ────────────────────────────────────────────────
              `wwn-0x5001b448b6bf6163` bir insanın ayırt edebileceği bir ad değil; "Sol yuva"
              öyle. Ad varsa kalın olan o oluyor ve modeli bir satır aşağı iniyor — model hâlâ
              orada, çünkü diski satın alırken bakılan şey o. */}
          <b>{disk.label ?? disk.model ?? disk.kname}</b>
          {disk.removable && <span className="pill dim"> çıkarılabilir</span>}
          {disk.byId !== undefined && (
            <button
              type="button"
              className="b"
              style={{ marginLeft: 8, padding: '2px 8px', fontSize: 10.5 }}
              onClick={() => onRename(disk)}
            >
              {disk.label === undefined ? '✎ ad ver' : '✎ adı değiştir'}
            </button>
          )}
        </div>
        {disk.label !== undefined && (
          <div className="m" style={{ opacity: 0.75, fontSize: '0.85em' }}>
            {disk.model ?? disk.kname}
          </div>
        )}
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
