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
 * `GET /remote` always answers 200, including when zerotier-one is not installed at all, and this
 * screen depends on that: DEPSIS does not package ZeroTier, so "not installed" is a state of the
 * box rather than a fault, and the card has to be able to say so in a readable answer.
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
        <Empty glyph="🌐" text="Uzak erişim kurulu değil." />
        <div className="note">
          DEPSIS ZeroTier&apos;i paketlemez, indirmez ve kurmaz — bir ürünün kurulum betiği kök
          kabuğa uzaktan bir betik boşaltmamalı. Kurmak isterseniz imzalı apt deposundan:
          <span className="val" style={{ display: 'block', marginTop: 6 }}>
            sudo apt install zerotier-one
          </span>
          <span className="val" style={{ display: 'block' }}>
            sudo systemctl enable --now zerotier-one
          </span>
          Kurulduktan sonra bu pencere düğüm kimliğini ve ağları gösterir.
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

      {isAdmin && (
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
      )}

      {/* Tanılama YÖNETİCİDE: uç zaten öyle, ve çalışmayacak bir bağlantıyı göstermemek. */}
      {/* EVİN KENDİ AĞI. Yukarısı başkasının ağına KATILMAKLA ilgili; bu, ağı bu cihazın
          yönetmesiyle — my.zerotier.com'a bağlı olmadan. `zerotier-one`'ın kendisi controller,
          yani ayrı bir servis yok. */}
      {isAdmin && status !== null && status.available && (
        <Controller notify={notify} onChanged={reload} />
      )}

      {isAdmin && status !== null && status.available && <Diagnostics notify={notify} />}

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

/**
 * Bağlantı tanılaması: kimi görüyoruz ve nasıl ulaşıyoruz.
 *
 * `GET /remote` "çevrimiçi" ve "ağa katıldı" diyor, ve her baytı bir kök üzerinden AKTARILAN bir
 * bağlantı için de aynı şeyi diyor — doğru, ve bir kat daha yavaş. Kullanıcının "neden yavaş"
 * sorusunun cevabı bu tablonun `Yol` sütununda, başka hiçbir ekranda değil.
 *
 * VARSAYILAN OLARAK KAPALI ve yalnız yöneticide. Uç zaten yöneticiye kapalı; bu, çalışmayacak bir
 * bağlantıyı hiç göstermemek için. Kapalı olması da bilinçli: bir tanılama tablosu, bir şey ters
 * gittiğinde bakılan yer, her açılışta okunacak bir şey değil.
 */
function Diagnostics({ notify }: { notify: Notify }): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<OpenApi.components['schemas']['RemotePeerPage'] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    const { data, error } = await api.GET('/remote/peers', {});
    setBusy(false);
    if (data === undefined) {
      notify('error', problemMessage(error, 'Tanılama okunamadı.'));
      return;
    }
    setPage(data);
  }, [notify]);

  if (!open) {
    return (
      <button
        type="button"
        className="lnk"
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        Bağlantı tanılaması
      </button>
    );
  }

  const peers = page?.items ?? [];
  // Aktarılanlar ÖNCE: tabloya bakma sebebi onlar, ve otuz satırın arasına karışmaları bakma
  // sebebini gizlemek olurdu. Sonra gecikmeye göre — ölçülmemişler en sona.
  const ordered = [...peers].sort((a, b) => {
    if (a.direct !== b.direct) return a.direct ? 1 : -1;
    return (a.latencyMs ?? Number.MAX_SAFE_INTEGER) - (b.latencyMs ?? Number.MAX_SAFE_INTEGER);
  });
  const relayed = peers.filter((peer) => !peer.direct).length;

  return (
    <div className="diag">
      <div className="thead">
        <span className="lbl">Bağlantı tanılaması</span>
        <button type="button" className="lnk" disabled={busy} onClick={() => void load()}>
          {busy ? 'Okunuyor…' : 'Yenile'}
        </button>
        <button type="button" className="lnk" onClick={() => setOpen(false)}>
          Kapat
        </button>
      </div>

      {page !== null && !page.available && (
        <p className="note">ZeroTier bu kutuda çalışmıyor, yani görülecek bir eş de yok.</p>
      )}
      {page !== null && page.available && peers.length === 0 && (
        <p className="note">Henüz hiçbir eş görülmedi.</p>
      )}

      {relayed > 0 && (
        <div className="warn">
          <span className="ic" aria-hidden>
            ⚠
          </span>
          <span className="tx">
            <b>{relayed} eşe doğrudan ulaşılamıyor.</b>
            Trafik ZeroTier köklerinden aktarılıyor: çalışıyor, ama doğrudan bir yola göre belirgin
            biçimde yavaş. Genellikle sebebi iki tarafın da güvenlik duvarı ya da NAT'ı; ağın
            yönlendiricisinde UDP 9993&apos;e izin vermek çoğu durumda yetiyor.
          </span>
        </div>
      )}

      {ordered.length > 0 && (
        <table className="tbl">
          <thead>
            <tr>
              <th>Düğüm</th>
              <th>Rol</th>
              <th>Yol</th>
              <th>Gecikme</th>
              <th>Sürüm</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((peer) => (
              <tr key={peer.address}>
                <td className="m">{peer.address}</td>
                <td>{peer.role}</td>
                <td>
                  <span className={peer.direct ? 'pill ok' : 'pill warn'}>
                    {peer.direct ? 'doğrudan' : 'aktarmalı'}
                  </span>
                </td>
                {/* null = HENÜZ ÖLÇÜLMEDİ, kötü bir ölçüm değil. "—" ikisini ayırt ediyor. */}
                <td className="m">{peer.latencyMs === null ? '—' : `${peer.latencyMs} ms`}</td>
                <td className="m">{peer.version === '' ? '—' : peer.version}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
