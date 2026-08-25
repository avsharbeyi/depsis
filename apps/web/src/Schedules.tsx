import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState, type ReactElement } from 'react';

import { api, problemMessage } from './api.js';
import { formatWhen } from './Dashboard.js';

type Schedule = OpenApi.components['schemas']['BackupSchedule'];
type Cadence = Schedule['cadence'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

const CADENCE: Record<Cadence, string> = {
  hourly: 'Saatlik',
  daily: 'Günlük',
  weekly: 'Haftalık',
};

const DAYS = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];

/**
 * Zamanlanmış yedekler: elle başlatılan bir yedek, alınmayan bir yedektir.
 *
 * Bir NAS'ın verisini kaybetme yolu bozuk bir yedekleme değil, ALINMAMIŞ bir yedek — ve sebebi
 * neredeyse her zaman birinin bir düğmeye basmayı unutması. Görüntü, çoğaltma ve off-site çoğaltma
 * ürünün içindeydi; üçünün de ortak eksiği kendiliğinden koşmamalarıydı.
 *
 * SAKLAMA SAYISI FORMDA ZORUNLU, ve varsayılanı yok. Saatlik görüntü alan ve hiçbirini silmeyen bir
 * zamanlama havuzu doldurur, ve dolu bir havuz yedeği olmayan bir havuzdan kötüdür — yazma da
 * durur. Kullanıcının o sayıyı bilerek vermesi, formun sorduğu en önemli şey.
 *
 * SON TURUN SONUCU HER SATIRDA. Bir zamanlamanın sessizce başarısız olması, yedeği olduğunu sanan
 * birinin olmadığını ancak ihtiyaç duyduğu gün öğrenmesi demek; `lastResult` o günü öne çekiyor.
 */
export function Schedules({ notify }: { notify: Notify }): ReactElement {
  const [items, setItems] = useState<Schedule[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const [dataset, setDataset] = useState('');
  const [label, setLabel] = useState('');
  const [cadence, setCadence] = useState<Cadence>('daily');
  const [atHour, setAtHour] = useState('3');
  const [atMinute, setAtMinute] = useState('0');
  const [weekday, setWeekday] = useState('0');
  const [keep, setKeep] = useState('7');

  const load = useCallback(async (): Promise<void> => {
    const { data, error, response } = await api.GET('/storage/backup-schedules', {});
    if (data === undefined) {
      // 403 bir hata değil bir DURUM: sıradan bir üye bu paneli görmüyor, ve her açılışta kırmızı
      // bir kutu göstermek ona yapabileceği bir şey olduğunu söylerdi.
      if (response.status === 403) {
        setForbidden(true);
        setItems([]);
        return;
      }
      notify('error', problemMessage(error, 'Zamanlamalar okunamadı.'));
      setItems([]);
      return;
    }
    setItems(data.items);
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const { data, error } = await api.POST('/storage/backup-schedules', {
      body: {
        dataset: dataset.trim(),
        label: label.trim(),
        cadence,
        atHour: cadence === 'hourly' ? null : Number.parseInt(atHour, 10),
        atMinute: Number.parseInt(atMinute, 10),
        weekday: cadence === 'weekly' ? Number.parseInt(weekday, 10) : null,
        keep: Number.parseInt(keep, 10),
        replicateTarget: null,
        offsite: null,
        enabled: true,
      },
    });
    setBusy(false);
    if (data === undefined) {
      notify('error', problemMessage(error, 'Zamanlama eklenemedi.'));
      return;
    }
    notify('ok', `"${data.label}" zamanlandı. İlk koşu: ${formatWhen(data.nextRunAt)}`);
    setOpen(false);
    setDataset('');
    setLabel('');
    await load();
  }

  async function toggle(item: Schedule): Promise<void> {
    setBusy(true);
    const { data, error } = await api.PUT('/storage/backup-schedules/{id}', {
      params: { path: { id: item.id } },
      body: {
        dataset: item.dataset,
        label: item.label,
        cadence: item.cadence,
        atHour: item.atHour,
        atMinute: item.atMinute,
        weekday: item.weekday,
        keep: item.keep,
        replicateTarget: item.replicateTarget,
        offsite: item.offsite,
        enabled: !item.enabled,
      },
    });
    setBusy(false);
    if (data === undefined) {
      notify('error', problemMessage(error, 'Zamanlama değiştirilemedi.'));
      return;
    }
    await load();
  }

  async function remove(item: Schedule): Promise<void> {
    setBusy(true);
    const { error, response } = await api.DELETE('/storage/backup-schedules/{id}', {
      params: { path: { id: item.id } },
    });
    setBusy(false);
    if (!response.ok) {
      notify('error', problemMessage(error, 'Zamanlama kaldırılamadı.'));
      return;
    }
    // Bu cümle olmadan düğme yanlış anlaşılırdı: kaldırmak "artık yenisini alma" demek, "elimdekini
    // at" demek değil.
    notify('ok', `"${item.label}" kaldırıldı. Aldığı görüntüler duruyor.`);
    await load();
  }

  if (forbidden || items === null) return <></>;

  return (
    <div className="repl">
      <div className="thead">
        <span className="lbl">Zamanlanmış yedekler</span>
        <button type="button" className="lnk" onClick={() => setOpen(!open)}>
          {open ? 'Vazgeç' : 'Zamanlama ekle'}
        </button>
      </div>

      {items.length === 0 && !open && (
        <p className="note">
          Hiç zamanlama yok — yedekler yalnız elle alınıyor. Bir NAS'ın verisini kaybetme yolu bozuk
          bir yedekleme değil, alınmamış bir yedektir.
        </p>
      )}

      {items.length > 0 && (
        <table className="tbl">
          <thead>
            <tr>
              <th>Ad</th>
              <th>Ne zaman</th>
              <th>Saklanan</th>
              <th>Sıradaki</th>
              <th>Son tur</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} style={item.enabled ? undefined : { opacity: 0.55 }}>
                <td>
                  <b>{item.label}</b>
                  <div className="m">{item.dataset}</div>
                </td>
                <td>
                  {CADENCE[item.cadence]}
                  {item.cadence === 'weekly' && ` · ${DAYS[item.weekday ?? 0] ?? ''}`}
                  {item.cadence === 'hourly'
                    ? ` · :${String(item.atMinute).padStart(2, '0')}`
                    : ` · ${String(item.atHour ?? 0).padStart(2, '0')}:${String(
                        item.atMinute,
                      ).padStart(2, '0')}`}
                </td>
                <td className="m">{item.keep}</td>
                <td className="m">{item.enabled ? formatWhen(item.nextRunAt) : 'kapalı'}</td>
                <td>
                  {item.lastResult === null ? (
                    <span className="m">—</span>
                  ) : (
                    // `ok` yeşil bir hap, geri kalan her şey CÜMLESİYLE. Bir zamanlamanın neden
                    // başarısız olduğunu gizlemek, yedeği olduğunu sanan birini o hâlde bırakmak.
                    <span className={item.lastResult === 'ok' ? 'pill ok' : 'pill warn'}>
                      {item.lastResult === 'ok' ? 'başarılı' : item.lastResult}
                    </span>
                  )}
                  {item.lastRunAt !== null && <div className="m">{formatWhen(item.lastRunAt)}</div>}
                </td>
                <td>
                  <button
                    type="button"
                    className="lnk"
                    disabled={busy}
                    onClick={() => void toggle(item)}
                  >
                    {item.enabled ? 'Durdur' : 'Başlat'}
                  </button>{' '}
                  <button
                    type="button"
                    className="lnk"
                    disabled={busy}
                    onClick={() => void remove(item)}
                  >
                    Kaldır
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {open && (
        <form onSubmit={(event) => void submit(event)}>
          <label className="fld">
            <span className="lbl">Ad</span>
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Gecelik yedek"
              maxLength={80}
              required
            />
          </label>

          <label className="fld">
            <span className="lbl">Veri kümesi</span>
            <input
              value={dataset}
              onChange={(event) => setDataset(event.target.value)}
              placeholder="tank/depsis"
              maxLength={255}
              required
            />
          </label>

          <label className="fld">
            <span className="lbl">Ritim</span>
            <select value={cadence} onChange={(event) => setCadence(event.target.value as Cadence)}>
              <option value="hourly">Saatlik</option>
              <option value="daily">Günlük</option>
              <option value="weekly">Haftalık</option>
            </select>
          </label>

          {cadence === 'weekly' && (
            <label className="fld">
              <span className="lbl">Gün</span>
              <select value={weekday} onChange={(event) => setWeekday(event.target.value)}>
                {DAYS.map((day, index) => (
                  <option key={day} value={String(index)}>
                    {day}
                  </option>
                ))}
              </select>
            </label>
          )}

          {cadence !== 'hourly' && (
            <label className="fld">
              <span className="lbl">Saat</span>
              <input
                value={atHour}
                onChange={(event) => setAtHour(event.target.value)}
                inputMode="numeric"
                maxLength={2}
                required
              />
            </label>
          )}

          <label className="fld">
            <span className="lbl">Dakika</span>
            <input
              value={atMinute}
              onChange={(event) => setAtMinute(event.target.value)}
              inputMode="numeric"
              maxLength={2}
              required
            />
          </label>

          <label className="fld">
            <span className="lbl">Kaç görüntü saklansın</span>
            <input
              value={keep}
              onChange={(event) => setKeep(event.target.value)}
              inputMode="numeric"
              maxLength={5}
              required
            />
            {/* Bu cümle formun en önemli parçası: budamanın neye dokunup neye dokunmadığı. */}
            <span className="note">
              Fazlası en eskisinden silinir. Yalnız BU zamanlamanın aldığı görüntüler — elle alınmış
              ya da başka bir ritimle alınmış olanlara dokunulmaz.
            </span>
          </label>

          <div className="row">
            <button type="submit" className="b" disabled={busy}>
              Ekle
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
