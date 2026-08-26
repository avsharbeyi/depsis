import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api } from './api.js';
import { Empty } from './ui.js';

type AuditEvent = OpenApi.components['schemas']['AuditEvent'];

/**
 * Eylem sınıfları, filtre olarak. `action` bir önek filtresi kabul ediyor (`auth`, `auth.login`
 * ve altındakilerin hepsi), ve buradaki liste kayıt edilen eylemlerin SINIFLARI — tek tek adları
 * saymak, yeni bir eylem eklendiğinde burada bir satır unutmak demek olurdu.
 */
const CLASSES: ReadonlyArray<[string, string]> = [
  ['', 'Hepsi'],
  ['auth', 'Oturum ve parola'],
  ['mfa', 'İki adımlı doğrulama'],
  ['user', 'Hesaplar'],
  ['team', 'Ekipler'],
  ['permissions', 'İzinler'],
  ['share', 'Paylaşımlar'],
  ['files', 'Dosyalar'],
  ['storage', 'Depolama'],
  ['remote', 'Uzaktan erişim'],
  ['console', 'Konsol'],
  ['setup', 'Kurulum'],
];

/** Eylem sınıfının rozet tonu. `st2` biçimini ödünç alıyor: renk burada durum değil tür anlatıyor. */
function toneOf(action: string): string {
  if (action.startsWith('auth.login-failed')) return 'er';
  if (action.startsWith('files.permanently') || action.startsWith('storage.')) return 'er';
  if (action.startsWith('auth') || action.startsWith('mfa')) return 'up';
  return 'dn';
}

/**
 * Denetim kaydı — kim, neyi, ne zaman.
 *
 * YALNIZ YÖNETİCİ GÖRÜYOR (App.tsx bu paneli `adminOnly` işaretliyor, uç da 403 döndürüyor) ve
 * satırlar SİLİNEMİYOR: uygulamanın veritabanı rolünün bu tabloda UPDATE/DELETE yetkisi yok.
 * Ekranda "temizle" düğmesi olmaması bir eksik değil, tablonun kendisinin sözü.
 *
 * Sayfalama imleçli — "daha eski" düğmesi son satırın kimliğini `before` olarak verir. Sonsuz
 * kaydırma bilerek yok: denetim okuyan kişi belirli bir olayı arıyordur, ve kaç sayfa indiğini
 * bilmek aramanın parçasıdır.
 */
export function Audit({ onUnauthenticated }: { onUnauthenticated: () => void }): React.JSX.Element {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [klass, setKlass] = useState('');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (before: string | null, replace: boolean) => {
      setBusy(true);
      const { data, response } = await api.GET('/audit', {
        params: {
          query: {
            limit: 50,
            ...(before === null ? {} : { before }),
            ...(klass === '' ? {} : { action: klass }),
          },
        },
      });
      setBusy(false);
      if (response.status === 401) {
        onUnauthenticated();
        return;
      }
      if (data === undefined) {
        setFailed(true);
        return;
      }
      setFailed(false);
      setEvents((previous) =>
        replace || previous === null ? data.items : [...previous, ...data.items],
      );
      setCursor(data.nextBefore);
    },
    [klass, onUnauthenticated],
  );

  useEffect(() => {
    setEvents(null);
    void load(null, true);
  }, [load]);

  return (
    <>
      <div className="netrow">
        <span className="lbl">Denetim kaydı</span>
        <select
          className="b"
          aria-label="Hangi eylemler"
          value={klass}
          onChange={(event) => setKlass(event.target.value)}
        >
          {CLASSES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <span className="val">{events?.length ?? '—'}</span>
        <button type="button" className="b" onClick={() => void load(null, true)} disabled={busy}>
          Yenile
        </button>
      </div>

      <p className="note">
        Bu kayıt yalnız BÜYÜR: satırlar uygulama tarafından değiştirilemez ve silinemez — veritabanı
        rolünün bu tabloda öyle bir yetkisi yok. Parola, jeton ve dosya içeriği hiçbir satırda yer
        almaz; IP yalnız oturum olaylarında tutulur.
      </p>

      {failed && <Empty glyph="⚠" text="Denetim kaydı okunamadı." />}
      {!failed && events === null && <p className="note">Yükleniyor…</p>}
      {!failed && events !== null && events.length === 0 && (
        <Empty glyph="—" text="Bu sınıfta kayıt yok." />
      )}

      {(events ?? []).map((event) => (
        <div className="urow" key={event.id}>
          <span className="i">
            <b>{event.actorUsername}</b>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{event.action}</span>
          </span>
          <span className="val" style={{ flexBasis: '55%', fontSize: 12 }}>
            {event.summary}
            {event.ip !== null && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, opacity: 0.7 }}>
                {' '}
                — {event.ip}
              </span>
            )}
          </span>
          <span className="val" style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
            {new Date(event.createdAt).toLocaleString('tr')}
          </span>
          <span className={`st2 ${toneOf(event.action)}`}>{event.action.split('.')[0]}</span>
        </div>
      ))}

      {cursor !== null && (
        <div className="netrow">
          <button
            type="button"
            className="b"
            onClick={() => void load(cursor, false)}
            disabled={busy}
          >
            Daha eski
          </button>
        </div>
      )}
    </>
  );
}
