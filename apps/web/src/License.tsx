import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api, problemMessage } from './api.js';

type LicenseStatus = OpenApi.components['schemas']['LicenseStatus'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

function when(value: string | null): string {
  if (value === null) return '';
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleDateString();
}

/**
 * Lisans — cihaz kime, hangi plan, ne zamana kadar.
 *
 * OKUMASI HERKESE AÇIK, kurması yöneticiye. Bir cihazın ne zaman desteksiz kalacağı, onu kullanan
 * herkesin görebilmesi gereken bir olgu; anahtarı yapıştırmak ise cihazı kuranın işi.
 *
 * NE YAPMADIĞI DA YAZILI: süresi dolmuş bir lisans burada söylenir, kimseyi kendi dosyalarından
 * kilitlemez. Bir yedekleme cihazını bir takvim gününde kullanılamaz hâle getirmek, verinin
 * kendisini rehin almaktır.
 */
export function LicensePanel({
  notify,
  isAdmin,
}: {
  notify: Notify;
  isAdmin: boolean;
}): React.JSX.Element | null {
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState('');

  const load = useCallback(async (): Promise<void> => {
    const { data } = await api.GET('/system/license', {});
    setStatus(data ?? null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function install(): Promise<void> {
    setBusy(true);
    const { data, error } = await api.POST('/system/license', { body: { key: key.trim() } });
    setBusy(false);
    if (data === undefined) {
      notify('error', problemMessage(error, 'Lisans kurulamadı.'));
      return;
    }
    setStatus(data);
    setKey('');
    setOpen(false);
    notify('ok', `Lisans kuruldu: ${data.licensedTo ?? ''}`.trim());
  }

  if (status === null) return null;

  return (
    <>
      <div className="syshead">Lisans</div>

      <div className="netrow">
        <span className="lbl">Durum</span>
        <span className="val">{status.licensedTo ?? '—'}</span>
        <Pill status={status} />
      </div>

      {status.detail !== null && <p className="note warn">{status.detail}</p>}

      {/* CİHAZ KODU. Bir lisansı tek cihaza bağlatmak isteyen müşterinin satıcıya ileteceği şey,
          ve bu yüzden lisans olsa da olmasa da GÖRÜNÜYOR: kurulumu yeni bitmiş, henüz lisanssız
          bir kutuda tam olarak buna ihtiyaç var. */}
      {status.deviceId !== null && (
        <div className="netrow">
          <span className="lbl">Cihaz kodu</span>
          <span className="note" style={{ fontFamily: 'var(--mono)', letterSpacing: '0.06em' }}>
            {status.deviceId}
          </span>
          <button
            type="button"
            className="b ghost"
            onClick={() => void navigator.clipboard?.writeText(status.deviceId ?? '')}
          >
            Kopyala
          </button>
        </div>
      )}

      {status.state !== 'absent' &&
        status.state !== 'unconfigured' &&
        status.state !== 'invalid' && (
          <>
            {status.plan !== null && (
              <div className="netrow">
                <span className="lbl">Plan</span>
                <span className="note">{status.plan}</span>
              </div>
            )}
            <div className="netrow">
              <span className="lbl">Geçerlilik</span>
              <span className="note">
                {status.expiresAt === null ? 'süresiz' : `${when(status.expiresAt)} tarihine kadar`}
              </span>
            </div>
            <div className="netrow">
              <span className="lbl">Lisans no</span>
              <span className="note" style={{ fontFamily: 'var(--mono)' }}>
                {status.licenseId}
              </span>
            </div>
          </>
        )}

      {status.state === 'expired' && (
        <p className="note">
          Lisansın süresi doldu. Cihaz çalışmaya devam ediyor ve dosyalarınız yerinde — süresi
          dolmuş bir lisans sizi kendi verinizden kilitlemez. Yenilemek için satıcınıza başvurun.
        </p>
      )}

      {isAdmin &&
        (open ? (
          <>
            <label className="lbl" htmlFor="license-key">
              Lisans anahtarı
            </label>
            <textarea
              id="license-key"
              className="sb"
              rows={4}
              spellCheck={false}
              placeholder="DEPSIS-1..."
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
            <div className="netrow">
              <button
                type="button"
                className="b"
                disabled={busy || key.trim() === ''}
                onClick={() => void install()}
              >
                {busy ? 'Kuruluyor…' : 'Lisansı kur'}
              </button>
              <button type="button" className="b ghost" onClick={() => setOpen(false)}>
                Vazgeç
              </button>
            </div>
          </>
        ) : (
          <div className="netrow">
            <button type="button" className="b" onClick={() => setOpen(true)}>
              ⤓ {status.state === 'absent' ? 'Lisans anahtarı gir' : 'Lisansı değiştir'}
            </button>
          </div>
        ))}
    </>
  );
}

/** Beş durum, beş cümle — ve hiçbiri diğerinin yerine geçmiyor. */
function Pill({ status }: { status: LicenseStatus }): React.JSX.Element {
  switch (status.state) {
    case 'valid':
      return <span className="pill">lisanslı</span>;
    case 'expired':
      return <span className="pill warn">süresi doldu</span>;
    case 'invalid':
      return <span className="pill bad">lisans doğrulanamıyor</span>;
    case 'unconfigured':
      return <span className="pill dim">lisans doğrulaması yapılandırılmamış</span>;
    default:
      return <span className="pill dim">lisanssız</span>;
  }
}
