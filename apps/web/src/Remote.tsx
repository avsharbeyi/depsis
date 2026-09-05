import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api, problemMessage } from './api.js';
import { Controller } from './Controller.js';
import { formatWhen } from './Dashboard.js';
import { ConfirmBox, Empty } from './ui.js';

type RemoteStatus = OpenApi.components['schemas']['RemoteStatus'];
type RemoteNetwork = OpenApi.components['schemas']['RemoteNetwork'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

/** The contract's `JoinNetworkRequest.networkId` pattern. Sixteen hex digits, no more, no less. */
const NETWORK_ID = /^[0-9a-f]{16}$/;

/**
 * ZeroTier's own status words, in Turkish.
 *
 * `OK` is deliberately absent from the pills below when the network is unauthorised: a device that
 * has joined but not been approved reports a status that reads healthy, and showing it as such is
 * how a user concludes the product is broken.
 */
const STATUS: Record<RemoteNetwork['status'], string> = {
  OK: 'bağlı',
  ACCESS_DENIED: 'erişim reddedildi',
  NOT_FOUND: 'ağ bulunamadı',
  REQUESTING_CONFIGURATION: 'yapılandırma isteniyor',
  PORT_ERROR: 'arayüz hatası',
  AUTHENTICATION_REQUIRED: 'kimlik doğrulaması gerekiyor',
  UNKNOWN: 'bilinmiyor',
};

/** No amber variant exists in the stylesheet's `.st2` set, and this file does not own the sheet. */
const PENDING: React.CSSProperties = { background: 'rgba(245,185,68,.16)', color: '#F5B944' };

interface Props {
  notify: Notify;
  isAdmin: boolean;
}

/**
 * Remote access — GET /remote, POST /remote/networks, DELETE /remote/networks/{networkId}.
 *
 * `GET /remote` always answers 200, including when zerotier-one is not answering at all, and this
 * screen depends on that: the appliance SHIPS with ZeroTier (the ISO's first boot installs it), so
 * a silent daemon is a fault to be explained here rather than a missing component to be installed
 * by hand — the card has to be able to say so in a readable answer.
 */
export function Remote({ notify, isAdmin }: Props): React.JSX.Element {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [networkId, setNetworkId] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState<RemoteNetwork | null>(null);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data } = await api.GET('/remote', {});
      if (!alive) return;
      if (data === undefined) {
        setFailed(true);
        return;
      }
      setStatus(data);
    })();
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  async function copyNodeId(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      notify('ok', 'Düğüm kimliği kopyalandı.');
    } catch {
      // Clipboard access is refused outright on an insecure origin, which is exactly how a NAS on
      // a home LAN is usually reached. Saying so beats a button that silently does nothing.
      notify('error', 'Panoya yazılamadı. Kimliği elle seçip kopyalayabilirsiniz.');
    }
  }

  async function join(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const id = networkId.trim().toLowerCase();
    // Validated here as well as on the server and in the agent. The value becomes a path segment
    // downstream, and a check in two places is cheaper than one forgotten in the third.
    if (!NETWORK_ID.test(id)) {
      notify('error', 'Ağ kimliği tam 16 onaltılık hane olmalı (0-9, a-f).');
      return;
    }
    setBusy(true);
    const body: OpenApi.components['schemas']['JoinNetworkRequest'] =
      label.trim() === '' ? { networkId: id } : { networkId: id, label: label.trim() };
    const { data, error, response } = await api.POST('/remote/networks', { body });
    setBusy(false);
    if (response.status === 503) {
      notify('error', 'ZeroTier çalışmıyor. Ağa katılınamadı.');
      return;
    }
    if (data === undefined) {
      notify('error', problemMessage(error, 'Ağa katılınamadı.'));
      return;
    }
    setNetworkId('');
    setLabel('');
    notify(
      'ok',
      data.authorized
        ? 'Ağa katılındı.'
        : 'Ağa katılındı — cihaz onay bekliyor. ZeroTier Central’da onaylanana kadar trafik akmaz.',
    );
    reload();
  }

  async function leave(network: RemoteNetwork): Promise<void> {
    setLeaving(null);
    setBusy(true);
    const { error, response } = await api.DELETE('/remote/networks/{networkId}', {
      params: { path: { networkId: network.networkId } },
    });
    setBusy(false);
    if (response.status === 503) {
      notify('error', 'ZeroTier çalışmıyor. Ağdan ayrılınamadı.');
      return;
    }
    if (!response.ok) {
      notify('error', problemMessage(error, 'Ağdan ayrılınamadı.'));
      return;
    }
    notify('ok', 'Ağdan ayrılındı.');
    reload();
  }

  if (failed) return <Empty glyph="🌐" text="Uzak erişim durumu okunamadı." />;
  if (status === null) return <p className="note">Yükleniyor…</p>;

  if (!status.available) {
    return (
      <>
        {/* ── BU EKRAN BİR ZAMANLAR TERMİNAL KOMUTU VERİYORDU ────────────────────────────
            "DEPSIS ZeroTier'i paketlemez, indirmez ve kurmaz" diyip iki `sudo apt` satırı
            gösteriyordu. O cümle ADR-0020'nin ilk hâlinden kalmaydı ve ADR sahada revize edildi:
            cihaz ZeroTier ile birlikte geliyor, kurulumu ISO'nun ilk açılışı yapıyor
            (`deploy/iso/firstboot.sh`). Sahibi uzaktan erişimi açmak isteyince karşısına terminal
            çıkması, bu üründe bir özelliğin eksik olması demek.

            Geriye kalan tek durum, kurulumun BAŞARISIZ olması — ve o zaman söylenecek şey bir
            komut değil, ne olduğu. */}
        <Empty glyph="🌐" text="Uzak erişim şu an kullanılamıyor." />
        <div className="note">
          ZeroTier bu cihazla birlikte kuruluyor; şu an yanıt vermiyor. Çoğu zaman servis
          başlatılamamıştır: <b>Sistem</b> ekranından cihazı yeniden başlatmak yeterlidir. Yeniden
          başlattıktan sonra da bu ekran aynı şeyi diyorsa ZeroTier kurulum sırasında
          indirilememiştir; satıcı desteğine başvurun.
        </div>
      </>
    );
  }

  const online = status.online === true;
  const nodeId = status.nodeId ?? null;

  return (
    <>
      <div className="netrow">
        <span className="lbl">Düğüm kimliği</span>
        <span className="val">{nodeId ?? '—'}</span>
        {nodeId !== null && (
          <button type="button" className="b" onClick={() => void copyNodeId(nodeId)}>
            Kopyala
          </button>
        )}
      </div>
      <div className="netrow">
        <span className="lbl">Durum</span>
        <span className={online ? 'st2 up' : 'st2 dn'}>{online ? 'çevrimiçi' : 'çevrimdışı'}</span>
      </div>
      <div className="netrow">
        <span className="lbl">Sürüm</span>
        <span className="val">{status.version ?? '—'}</span>
      </div>

      <div className="lbl">Ağlar</div>
      {status.networks.length === 0 ? (
        <Empty glyph="🔗" text="Hiçbir ağa katılınmamış." />
      ) : (
        <div>
          {status.networks.map((network) => (
            <div key={network.networkId}>
              <div className="urow">
                <span
                  className="av"
                  style={{ background: 'rgba(91,200,245,.24)', color: '#5BC8F5' }}
                  aria-hidden
                >
                  🔗
                </span>
                <span className="i">
                  <b>{network.label ?? network.name ?? network.networkId}</b>
                  <span>
                    {network.addresses.length > 0
                      ? network.addresses.join(' · ')
                      : 'adres atanmadı'}
                  </span>
                </span>
                <span className="val">{network.networkId}</span>
                {network.authorized ? (
                  <span className={network.status === 'OK' ? 'st2 up' : 'st2 er'}>
                    {STATUS[network.status]}
                  </span>
                ) : (
                  <span className="st2" style={PENDING}>
                    onay bekliyor
                  </span>
                )}
                {isAdmin && (
                  <button
                    type="button"
                    className="revoke"
                    disabled={busy}
                    onClick={() => setLeaving(network)}
                  >
                    Ayrıl
                  </button>
                )}
              </div>
              {!network.authorized && (
                <div className="note">
                  Cihaz bu ağa katıldı ama henüz onaylanmadı ve hiçbir trafik akmıyor: ağ
                  yöneticisinin ZeroTier Central&apos;da bu düğümü onaylaması gerekiyor.
                </div>
              )}
              {network.joinedAt !== null && network.joinedAt !== undefined && (
                // The date goes in `.val` — mono, tabular — like every other figure on this card.
                <div className="netrow">
                  <span className="lbl">Katılındı</span>
                  <span className="val">{formatWhen(network.joinedAt)}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── BAŞKASININ AĞINA KATILMAK, KAPALI BİR AYRINTI ──────────────────────────────────
          Bu ürünün asıl işi KENDİ ağını kurmak; başka bir ZeroTier ağına katılmak ileri
          kullanımın bir köşesi. Form açıkça duruyorken ekranın en görünür yeri, kullanıcıların
          çoğunun hiç kullanmayacağı bir şeye gidiyordu — ve on altı haneli bir ağ kimliği
          isteyen bir kutu, doğru ekranı bulduğundan emin olmayan birini durduruyor.

          Kaldırılmadı, KATLANDI: özelliği silmek onu isteyenden almak olurdu. */}
      {isAdmin && (
        <details className="foldrow">
          <summary>Başka bir ağa katıl</summary>
          <form
            onSubmit={(event) => void join(event)}
            style={{ display: 'flex', flexDirection: 'column', gap: 9 }}
          >
            <div className="lbl">Ağa katıl</div>
            <label>
              Ağ kimliği
              <input
                value={networkId}
                onChange={(event) => setNetworkId(event.target.value)}
                required
                maxLength={16}
                autoComplete="off"
                spellCheck={false}
                placeholder="16 onaltılık hane"
                style={{ fontFamily: 'var(--mono)' }}
              />
              <small>ZeroTier Central&apos;daki ağ kimliği; 0-9 ve a-f, tam 16 hane.</small>
            </label>
            <label>
              Etiket (isteğe bağlı)
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                maxLength={64}
                autoComplete="off"
                placeholder="ör. Ev"
              />
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="submit" className="b pri" disabled={busy}>
                {busy ? 'Katılınıyor…' : 'Katıl'}
              </button>
            </div>
          </form>
        </details>
      )}

      {/* EVİN KENDİ AĞI. Yukarısı başkasının ağına KATILMAKLA ilgili; bu, ağı bu cihazın
          yönetmesiyle — my.zerotier.com'a bağlı olmadan. `zerotier-one`'ın kendisi controller,
          yani ayrı bir servis yok. */}
      {isAdmin && status !== null && status.available && (
        <Controller notify={notify} onChanged={reload} />
      )}

      {/* BAĞLANTI TANILAMASI KALDIRILDI. Eşlerin gecikmesini, yolunu ve sürümünü gösteren bir
          tablo, kullanıcının HİÇBİR ŞEY yapamayacağı bir bilgi: aktarma üzerinden bağlanan bir
          eşi doğrudan bağlanır yapmanın ekranda bir yolu yok. Okuyan kişiye yalnız endişe
          veriyordu. Uç (`GET /remote/peers`) duruyor; bir gün bir şey yapılabilecekse ekran o
          zaman geri gelir. */}

      {leaving !== null && (
        <ConfirmBox
          title="Ağdan ayrıl"
          body="Cihaz bu ağdaki adreslerini bırakır ve ağdaki kimse ona ulaşamaz. Yeniden katılmak için ağ kimliği yeterli."
          list={[leaving.label ?? leaving.name ?? leaving.networkId]}
          yesLabel="Ayrıl"
          danger
          onYes={() => void leave(leaving)}
          onNo={() => setLeaving(null)}
        />
      )}
    </>
  );
}
