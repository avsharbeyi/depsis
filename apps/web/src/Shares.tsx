import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api, problemMessage } from './api.js';
import { Empty } from './ui.js';

type SharePage = OpenApi.components['schemas']['SharePage'];
type SmbPublishResult = OpenApi.components['schemas']['SmbPublishResult'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

/**
 * Amber, because neither `.st2` variant in the stylesheet says what this pill has to say.
 *
 * `.st2.up` would claim the address works and `.st2.dn` reads as "off", which for a share row is
 * indistinguishable from "disabled on purpose". A row DEPSIS knows about but Samba is not serving
 * is a caution: the name is real, the address is not yet.
 */
const UNPUBLISHED: React.CSSProperties = {
  background: 'rgba(245,185,68,.16)',
  color: 'var(--warn)',
};

interface Props {
  notify: Notify;
  isAdmin: boolean;
  onUnauthenticated: () => void;
}

/**
 * Shares and their SMB addresses — GET /shares, POST /system/smb.
 *
 * The screen exists for one sentence the rest of the appliance never says out loud: the address to
 * paste into Windows Explorer. A NAS whose whole purpose is to appear as a drive letter, and which
 * never tells anyone `\\depsis\belgeler`, has shipped the feature and hidden it.
 *
 * `published` is therefore reported exactly as the contract reports it, and never rounded up. A
 * row in DEPSIS's database is not smbd serving it, and treating the two as one thing sends the
 * reader to Explorer with an address that will time out — which they will read as a broken
 * appliance rather than as configuration that has not been applied yet.
 */
export function Shares({ notify, isAdmin, onUnauthenticated }: Props): React.JSX.Element {
  const [page, setPage] = useState<SharePage | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SmbPublishResult | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    void (async () => {
      const { data, response } = await api.GET('/shares', {});
      if (!alive) return;
      if (response.status === 401) {
        onUnauthenticated();
        return;
      }
      if (data === undefined) {
        setFailed(true);
        return;
      }
      setPage(data);
    })();
    return () => {
      alive = false;
    };
  }, [reloadKey, onUnauthenticated]);

  async function copyPath(uncPath: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(uncPath);
      notify('ok', 'Adres kopyalandı. Gezgin’in adres çubuğuna yapıştırın.');
    } catch {
      // A home NAS is reached over plain http on the LAN, and the clipboard API is refused outright
      // on an insecure origin. Saying so beats a button that appears to work and does nothing.
      notify('error', 'Panoya yazılamadı. Adresi elle seçip kopyalayabilirsiniz.');
    }
  }

  async function republish(): Promise<void> {
    setBusy(true);
    setResult(null);
    const { data, error, response } = await api.POST('/system/smb', {});
    setBusy(false);
    if (response.status === 401) {
      onUnauthenticated();
      return;
    }
    if (response.status === 503) {
      notify('error', 'Ajana ulaşılamadı ya da Samba kurulu değil. Yapılandırma yazılmadı.');
      return;
    }
    if (response.status === 409) {
      // The agent refused and rolled back, so the shares that worked a second ago still work. The
      // reason is the only useful thing here and it comes from the server.
      notify('error', problemMessage(error, 'Ajan yapılandırmayı reddetti. Eskisine dönüldü.'));
      return;
    }
    if (data === undefined) {
      notify('error', problemMessage(error, 'Yeniden yayımlanamadı.'));
      return;
    }
    // Kept on the page rather than in a toast: `verified:false` is a state of the appliance the
    // reader has to be able to look back at, and a toast is gone before they have decided what to
    // do about it.
    setResult(data);
    if (data.verified) notify('ok', `${data.shares} paylaşım yayımlandı ve doğrulandı.`);
    reload();
  }

  if (failed) {
    return (
      <Empty
        glyph="⚠"
        text="Paylaşımlar okunamadı."
        action={
          <button type="button" className="b" onClick={reload}>
            Yeniden dene
          </button>
        }
      />
    );
  }
  if (page === null) return <p className="note">Yükleniyor…</p>;

  const shares = page.items;
  const unpublished = shares.filter((share) => !share.published).length;

  return (
    <>
      {!page.smbAvailable && (
        <div className="warn" role="status">
          <span className="ic" aria-hidden>
            ⚠
          </span>
          <span className="tx">
            <b>Samba kurulu değil</b>
            Samba kurulu değil ya da ajana ulaşılamıyor. Paylaşımlar aşağıda listeleniyor ama şu an
            hiçbir adres çalışmıyor. Bu bir arıza değil: dosya paylaşımını sunan bileşen henüz
            kurulmamış.
          </span>
        </div>
      )}

      {result !== null &&
        (result.verified ? (
          <div className="notice ok" role="status">
            <span className="ic" aria-hidden>
              ✓
            </span>
            <span className="tx">
              <b>Yayımlandı ve doğrulandı</b>
              {result.shares} paylaşım için yapılandırma yazıldı ve canlı bir bağlantı denemesiyle
              doğrulandı. Adresler çalışıyor.
            </span>
          </div>
        ) : (
          // Deliberately not `.notice.ok`. The request returned 200, but 200 here means "yazdım ve
          // geri aldım" — a green tick would tell the reader the opposite of what happened.
          <div className="warn" role="alert">
            <span className="ic" aria-hidden>
              ⚠
            </span>
            <span className="tx">
              <b>Doğrulanamadı — eskisine dönüldü</b>
              Yapılandırma yazıldı ama canlı bağlantı denemesi geçmedi, bu yüzden ajan eski
              yapılandırmaya geri döndü. Paylaşımlar eskisi gibi çalışmaya devam ediyor; yeni
              yapılandırma uygulanmadı.
            </span>
          </div>
        ))}

      <div className="netrow">
        <span className="lbl">Paylaşımlar</span>
        <span className="val">{shares.length}</span>
        {/* `.st2.dn` and not `.st2.er`: the contract states outright that a false `smbAvailable`
            "bir arıza değil, kurulmamış bir bileşendir", and a rose error pill says the opposite
            of the sentence in the box above it. The Apps pane draws the same situation — a
            component the appliance does not ship — in exactly this neutral voice. */}
        <span className={page.smbAvailable ? 'st2 up' : 'st2 dn'}>
          {page.smbAvailable ? 'samba çalışıyor' : 'samba kurulu değil'}
        </span>
        {isAdmin && (
          <button type="button" className="b" disabled={busy} onClick={() => void republish()}>
            {busy ? 'Yayımlanıyor…' : 'Yeniden yayımla'}
          </button>
        )}
      </div>

      {shares.length === 0 ? (
        <Empty glyph="💽" text="Hiç paylaşım yok." />
      ) : (
        <div>
          {shares.map((share) => (
            <div className="urow" key={share.id}>
              <span
                className="av"
                style={{ background: 'rgba(91,200,245,.24)', color: 'var(--cool)' }}
                aria-hidden
              >
                💽
              </span>
              <span className="i">
                <b>{share.name}</b>
                <span>
                  {share.published
                    ? (share.dataset ?? 'paylaşımda')
                    : 'Samba bu adresi sunmuyor — yapıştırmak işe yaramaz'}
                </span>
              </span>
              {/* The address itself is the button. It is the one string on this screen the reader
                  came to take away with them, and putting it behind a separate "Kopyala" next to
                  an inert copy of the same text is a second thing to aim at for no reason. */}
              <button
                type="button"
                className="b"
                style={{ fontFamily: 'var(--mono)', fontSize: 11 }}
                title="Panoya kopyala"
                aria-label={`${share.uncPath} adresini panoya kopyala`}
                onClick={() => void copyPath(share.uncPath)}
              >
                {share.uncPath}
              </button>
              <span className="st2 dn">{share.readOnly ? 'salt okunur' : 'yazılabilir'}</span>
              {share.published ? (
                <span className="st2 up">yayımlandı</span>
              ) : (
                <span className="st2" style={UNPUBLISHED}>
                  yayımlanmadı
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {unpublished > 0 && page.smbAvailable && (
        <div className="note">
          {unpublished === shares.length
            ? 'Hiçbir paylaşım yayımlanmamış'
            : `${unpublished} paylaşım yayımlanmamış`}
          : DEPSIS bu satırları biliyor ama Samba onları sunmuyor, yani bu adresler Gezgin&apos;de
          açılmaz.
          {isAdmin
            ? ' “Yeniden yayımla” yapılandırmayı ajana yeniden yazdırır.'
            : ' Bir yöneticinin yeniden yayımlaması gerekiyor.'}
        </div>
      )}

      <div className="note">
        Bir adresi Windows&apos;ta kullanmak için Gezgin&apos;in adres çubuğuna yapıştırın; ağ
        sürücüsü olarak bağlarsanız her açılışta hazır olur. macOS&apos;ta Finder → Git → Sunucuya
        Bağlan (⌘K).
      </div>

      {isAdmin && (
        <div className="note">
          Yeniden yayımlamak yapılandırmayı atomik olarak yazar, doğrular ve canlı bir bağlantı
          denemesi yapar; üçünden biri geçmezse eski yapılandırmaya geri döner. Aynı yapılandırma
          iki kez yayımlanabilir, ikinci kez bir şeyi bozmaz.
        </div>
      )}
    </>
  );
}
