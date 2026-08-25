import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api, problemMessage } from './api.js';
import { formatBytes, formatWhen } from './Dashboard.js';
import { Empty, Win } from './ui.js';

type Notify = (kind: 'ok' | 'error', text: string) => void;
type Snapshot = OpenApi.components['schemas']['ShareSnapshotPage']['items'][number];
type Entry = OpenApi.components['schemas']['SnapshotListing']['items'][number];

/**
 * Geçmiş sürümler: bir paylaşımın dünkü hâline bakmak, ve bir dosyayı geri getirmek.
 *
 * BU EKRAN OLMADAN anlık görüntülerin kullanıcı için bir anlamı yoktu. Yedekleme paneli onları
 * listeliyordu — kaç tane var, ne kadar yer tutuyor — ve yapılabilecek tek şey bütün veri kümesini
 * geri almaktı, ki o da o görüntüden beri yazılmış her şeyi atmak demek. "Dün bir raporu sildim"in
 * cevabı hiçbir yerde yoktu, ve bir insanın yedeğine sorduğu tek soru bu.
 *
 * SALT OKUNUR, ve başka türlüsü mümkün değil: bir ZFS anlık görüntüsü değiştirilemez. Buradan
 * yapılabilecek tek yazma işlemi, bir dosyayı CANLI ağaca kopyalamak.
 *
 * Üzerine hiçbir zaman yazmıyor. Sunucu boş bir ad seçiyor ve seçtiğini söylüyor; kullanıcı hangi
 * kopyayı istediğinden emin olmadığı için buraya geliyor, ve "geri yükledim" deyip elindekini
 * silmek, o belirsizliğin en kötü çözümü olurdu.
 */
export function History({
  shareId,
  shareName,
  destinationId,
  destinationLabel,
  onClose,
  onRestored,
  notify,
}: {
  shareId: string;
  shareName: string;
  /** Geri yüklenen dosyanın ineceği canlı klasör; `null` paylaşımın kökü. */
  destinationId: string | null;
  destinationLabel: string;
  onClose: () => void;
  onRestored: () => void;
  notify: Notify;
}): React.JSX.Element {
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [chosen, setChosen] = useState<string | null>(null);
  const [trail, setTrail] = useState<string[]>([]);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error } = await api.GET('/shares/{shareId}/snapshots', {
        params: { path: { shareId } },
      });
      if (cancelled) return;
      if (data === undefined) {
        notify('error', problemMessage(error, 'Geçmiş sürümler okunamadı.'));
        setSnapshots([]);
        return;
      }
      setAvailable(data.available);
      setSnapshots(data.items);
      // En yenisi seçili açılıyor: geri yükleyen birinin aradığı sürüm neredeyse her zaman en
      // son iyi olan, ve boş bir ekranla karşılamak bir tık daha istemek olurdu.
      setChosen(data.items[0]?.name ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [shareId, notify]);

  const load = useCallback(
    async (snapshot: string, path: string[]): Promise<void> => {
      setBusy(true);
      const { data, error } = await api.GET('/shares/{shareId}/snapshots/{snapshot}/entries', {
        params: { path: { shareId, snapshot }, query: { path: path.join('/') } },
      });
      setBusy(false);
      if (data === undefined) {
        notify('error', problemMessage(error, 'Bu klasör okunamadı.'));
        setEntries([]);
        return;
      }
      setEntries(data.items);
      setTruncated(data.truncated);
    },
    [shareId, notify],
  );

  useEffect(() => {
    if (chosen === null) return;
    void load(chosen, trail);
  }, [chosen, trail, load]);

  const restore = async (entry: Entry): Promise<void> => {
    if (chosen === null) return;
    setRestoring(entry.name);
    const { data, error } = await api.POST('/shares/{shareId}/snapshots/{snapshot}/restore', {
      params: { path: { shareId, snapshot: chosen } },
      body: { path: [...trail, entry.name], destinationId },
    });
    setRestoring(null);
    if (data === undefined) {
      notify('error', problemMessage(error, 'Geri yükleme başlatılamadı.'));
      return;
    }
    notify(
      'ok',
      data.name === entry.name
        ? `${entry.name} geri yükleniyor: ${destinationLabel} içine inecek.`
        : // Ad DEĞİŞTİYSE söylenmesi şart. Sessizce başka bir ada indirmek, kullanıcının aradığı
          // dosyayı bulamaması demek — ve elindekinin üzerine yazmamanın bedeli bu cümle.
          `${entry.name} geri yükleniyor. ${destinationLabel} içinde bu adda bir dosya zaten var, ` +
            `bu yüzden "${data.name}" adıyla inecek.`,
    );
    onRestored();
  };

  const empty = snapshots !== null && snapshots.length === 0;

  return (
    <Win title={`${shareName} · geçmiş sürümler`} glyph="🕓" tone="iris" wide onClose={onClose}>
      {!available && (
        <div className="warn">
          <span className="ic" aria-hidden>
            ⚠
          </span>
          {/* "Soramadım" ile "yok" farklı şeyler, ve bu ekranda fark hayati: boş bir liste,
              yedeği olan birine yedeği olmadığını söylerdi. */}
          <span className="tx">
            <b>Havuz sorulamadı.</b>
            Anlık görüntülerin olup olmadığı bilinmiyor — bu, hiç olmadığı anlamına GELMEZ. Sistem
            ajanı yanıt verdiğinde bu pencereyi yeniden açın.
          </span>
        </div>
      )}

      {snapshots === null && <p className="note">Okunuyor…</p>}

      {empty && available && (
        <Empty
          glyph="🕓"
          text="Bu paylaşımın anlık görüntüsü yok. Yedekleme panelinden bir tane alın; alındıktan sonra o günkü hâl buradan okunabilir."
        />
      )}

      {snapshots !== null && snapshots.length > 0 && (
        <>
          <div className="netrow" style={{ marginBottom: 10 }}>
            <span className="lbl">Sürüm</span>
            <select
              className="b"
              aria-label="Hangi anlık görüntü"
              value={chosen ?? ''}
              onChange={(event) => {
                setChosen(event.target.value);
                // Yol eski görüntüye ait: yeni görüntüde o klasör olmayabilir, ve olmayan bir
                // klasörün 404'ünü göstermektense köke dönmek dürüst olan.
                setTrail([]);
              }}
            >
              {snapshots.map((snapshot) => (
                <option key={snapshot.name} value={snapshot.name}>
                  {formatWhen(snapshot.createdAt)} · {snapshot.name} (
                  {formatBytes(snapshot.usedBytes)})
                </option>
              ))}
            </select>
          </div>

          <div className="crumb">
            <button type="button" className="lnk" onClick={() => setTrail([])}>
              {shareName}
            </button>
            {trail.map((part, index) => (
              <span key={`${part}-${String(index)}`}>
                {' / '}
                <button
                  type="button"
                  className="lnk"
                  onClick={() => setTrail(trail.slice(0, index + 1))}
                >
                  {part}
                </button>
              </span>
            ))}
          </div>

          {busy && <p className="note">Okunuyor…</p>}

          {truncated && (
            <p className="note">
              Bu klasör listelenebilecek olandan büyük; aşağıdaki liste kesildi. Aradığınız dosya
              görünmüyorsa yok demek değil.
            </p>
          )}

          {entries !== null && entries.length === 0 && !busy && (
            <p className="note">Bu klasör o gün boştu.</p>
          )}

          {entries !== null && entries.length > 0 && (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Ad</th>
                  <th>Boyut</th>
                  <th>Değiştirilme</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.name}>
                    <td>
                      {entry.directory ? (
                        <button
                          type="button"
                          className="lnk"
                          onClick={() => setTrail([...trail, entry.name])}
                        >
                          📁 {entry.name}
                        </button>
                      ) : (
                        <span>📄 {entry.name}</span>
                      )}
                    </td>
                    <td className="m">{entry.directory ? '—' : formatBytes(entry.sizeBytes)}</td>
                    <td className="m">{formatWhen(entry.modifiedAt)}</td>
                    <td>
                      {/* Klasörler için yok, ve bu bir eksiklik değil: ajanın kapalı işlem kümesi
                          tek bir dosya kopyalıyor, ve bir ağacı geri getirmek çağıranın maliyetini
                          seçtiği bir çağrı olurdu (ADR-0006 §2.2). Klasörün içine girip
                          dosyaları tek tek almak çalışıyor. */}
                      {!entry.directory && (
                        <button
                          type="button"
                          className="b"
                          disabled={restoring !== null}
                          onClick={() => void restore(entry)}
                        >
                          {restoring === entry.name ? 'Başlatılıyor…' : 'Geri getir'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <p className="note">
            Geri getirilen dosya <b>{destinationLabel}</b> içine iner ve mevcut hiçbir dosyanın
            üzerine yazılmaz — aynı adda bir dosya varsa yeni bir ad seçilir ve size söylenir.
          </p>
        </>
      )}
    </Win>
  );
}
