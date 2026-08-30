import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api, problemMessage } from './api.js';
import { Connect } from './Connect.js';
import { ShareTreeNotice, useStorageSetup } from './ShareTree.js';
import { Empty, Win } from './ui.js';
import { Permissions, type PermissionTarget } from './Permissions.js';

type SharePage = OpenApi.components['schemas']['SharePage'];
type SmbPublishResult = OpenApi.components['schemas']['SmbPublishResult'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

/**
 * The same shape the database, the contract and the agent all insist on.
 *
 * Checked here as well so that a name the appliance cannot use is refused while the reader is
 * still looking at the field, rather than after a round trip that has already created a ZFS
 * dataset. The server checks it too, and that is the copy that matters — this one only saves the
 * trip.
 */
const NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,62}$/;

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
  /** Bağlanma komutlarındaki kullanıcı adı — Windows'un tahmin ettiği ad değil. */
  username: string;
  /** SMB parolası var mı; yoksa komutlar açılıyor ama hiçbir parola kabul edilmiyor. */
  smbReady: boolean;
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
export function Shares({
  notify,
  isAdmin,
  username,
  smbReady,
  onUnauthenticated,
}: Props): React.JSX.Element {
  const [page, setPage] = useState<SharePage | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SmbPublishResult | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [creating, setCreating] = useState(false);
  /** The share whose root permissions are open. The root is a node like any other (§6.2). */
  const [permissionsFor, setPermissionsFor] = useState<PermissionTarget | null>(null);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  /** Bir açma denemesi 503 aldı mı — sebebini sormaya değer kılan ikinci durum. */
  const [createUnavailable, setCreateUnavailable] = useState(false);

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

  /**
   * Kutunun depolama durumu — bu ekranın kendi işi için değil, AÇAMADIĞI paylaşımın sebebini
   * söyleyebilmek için.
   *
   * Sahadaki ilk kurulumda havuz kuruldu, paylaşım açılmadı, ve bu ekranın söyleyebildiği tek şey
   * "Depolama havuzu ayarlı değil ya da ajana ulaşılamıyor" oldu: iki ayrı sebebi bir cümlede
   * birleştiren, çaresi başka bir ekranda duran bir bildirim.
   *
   * YALNIZ CEVABININ İŞE YARADIĞI DURUMDA soruluyor. Zaten paylaşım sunan bir kutuda paylaşım
   * ağacı tanım gereği var; orada bu soruyu sormak, ekranın söyleyecek bir şeyi yokken ürettiği
   * bir istekten ibaret olurdu.
   */
  const storage = useStorageSetup(
    reloadKey,
    createUnavailable || (page !== null && page.items.length === 0),
  );

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

  async function create(input: {
    name: string;
    readOnly: boolean;
    quotaBytes: number | null;
  }): Promise<boolean> {
    const { data, error, response } = await api.POST('/shares', { body: input });
    if (response.status === 401) {
      onUnauthenticated();
      return false;
    }
    if (data === undefined) {
      if (response.status === 503) setCreateUnavailable(true);
      notify(
        'error',
        problemMessage(
          error,
          // 503'ün İKİ AYRI SEBEBİ var ve kullanıcının yapacağı şey ikisinde farklı. Havuz
          // varken paylaşım ağacı yoksa çare bu ekranın tepesindeki düğme; ajana ulaşılamıyorsa
          // beklemekten başka yapılacak bir şey yok. Tek cümlede birleştirmek, çaresi elinin
          // altında duran kişiye "yapabileceğin bir şey yok" demekti.
          response.status === 503
            ? storage !== null && storage.pools.length > 0 && storage.parentDataset === undefined
              ? 'Paylaşım ağacı kurulu değil. Bu sayfanın en üstündeki "Paylaşım ağacını kur" ' +
                'düğmesine basın; sonra paylaşımı yeniden açabilirsiniz.'
              : 'Depolama havuzu ayarlı değil ya da ajana ulaşılamıyor. Paylaşım açılmadı.'
            : 'Paylaşım açılamadı.',
        ),
      );
      return false;
    }

    // Two sentences, because two different things happened and only one of them is finished. The
    // share exists; the POSIX permissions behind it are a queued job, and a null id means the
    // agent could not be reached to start it. Saying only "açıldı" would leave the reader to
    // discover over SMB that the folder is not reachable yet.
    notify(
      'ok',
      data.applyingJobId === null
        ? `${data.share.name} açıldı. İzinler henüz dosya sistemine yazılamadı — ajana ` +
            'ulaşılamıyor.'
        : `${data.share.name} açıldı. Adresi kullanmadan önce "Yeniden yayımla" deyin.`,
    );
    reload();
    return true;
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
      {/* PAYLAŞIM AÇILAMAMASININ EN SIK SEBEBİ, ve çaresi burada duruyor. Havuz kurulurken
          "paylaşım ağacını da kur" işaretlenmediyse kutu tamamen sağlıklı görünür ve tek bir
          paylaşım açamaz; eski hâlinde bunun tek belirtisi, "Yeni paylaşım" denendiğinde çıkan
          ve ne yapılacağını söylemeyen bir bildirimdi. */}
      <ShareTreeNotice storage={storage} notify={notify} onPrepared={reload} />

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
          <button type="button" className="b" onClick={() => setCreating(true)}>
            Yeni paylaşım
          </button>
        )}
        {isAdmin && (
          <button type="button" className="b" disabled={busy} onClick={() => void republish()}>
            {busy ? 'Yayımlanıyor…' : 'Yeniden yayımla'}
          </button>
        )}
      </div>

      {creating && <NewShare onCancel={() => setCreating(false)} onCreate={create} />}

      {permissionsFor !== null && (
        <Permissions
          target={permissionsFor}
          notify={notify}
          onClose={() => setPermissionsFor(null)}
          onUnauthenticated={onUnauthenticated}
        />
      )}

      {shares.length === 0 ? (
        <Empty
          glyph="💽"
          text="Hiç paylaşım yok."
          action={
            isAdmin ? (
              <button type="button" className="b" onClick={() => setCreating(true)}>
                Paylaşım aç
              </button>
            ) : undefined
          }
        />
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
              {isAdmin && (
                <button
                  type="button"
                  className="b"
                  title="Bu paylaşımın kök izinleri"
                  onClick={() =>
                    setPermissionsFor({ kind: 'share', id: share.id, name: share.name })
                  }
                >
                  🔑 İzinler
                </button>
              )}
              <span className="st2 dn">{share.readOnly ? 'salt okunur' : 'yazılabilir'}</span>
              {share.published ? (
                <span className="st2 up">yayımlandı</span>
              ) : (
                <span className="st2" style={UNPUBLISHED}>
                  yayımlanmadı
                </span>
              )}
              {/* YALNIZ YAYIMLANMIŞ paylaşımda. Yayımlanmamış bir paylaşımın adresi Gezgin'de
                  açılmıyor, ve onun için bir `net use` satırı vermek çalışmayacak bir komut
                  vermektir — ekranın hemen üstünde "Samba bu adresi sunmuyor" yazarken. */}
              {share.published && (
                <Connect
                  shareName={share.name}
                  username={username}
                  smbReady={smbReady}
                  notify={notify}
                />
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

/**
 * Opening a share: a name, whether it is read-only, and an optional quota.
 *
 * Three fields and no permission picker, and the omission is deliberate rather than unfinished.
 * `POST /shares` writes the first grant to whoever created the share when the body names nobody,
 * which is the fail-closed default: the share is visible to its creator and to administrators, and
 * opening it to anyone else is a separate, deliberate act on the permissions panel. A picker here
 * would put the most consequential decision in the appliance — who can read this — behind the same
 * click as "what shall we call it".
 *
 * The sentence under the field says so, because a share that appears and is empty for everybody
 * else looks like a bug unless somebody was told.
 */
function NewShare({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (input: {
    name: string;
    readOnly: boolean;
    quotaBytes: number | null;
  }) => Promise<boolean>;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [quota, setQuota] = useState('');
  const [busy, setBusy] = useState(false);

  const trimmed = name.trim();
  const nameOk = NAME_PATTERN.test(trimmed);
  // An empty field is not "wrong" yet — nobody has typed anything — so the message only appears
  // once there is something to be wrong about.
  const nameError = trimmed !== '' && !nameOk;
  const gib = Number(quota);
  const quotaOk = quota.trim() === '' || (Number.isFinite(gib) && gib > 0);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!nameOk || !quotaOk || busy) return;
    setBusy(true);
    const done = await onCreate({
      name: trimmed,
      readOnly,
      // GiB in the field, bytes on the wire. The API takes bytes because `refquota` does, and
      // asking a person for a byte count is asking them to type a number they will get wrong.
      quotaBytes: quota.trim() === '' ? null : Math.round(gib * 1024 * 1024 * 1024),
    });
    setBusy(false);
    if (done) onCancel();
  }

  return (
    <Win title="Yeni paylaşım" glyph="💽" tone="cool" onClose={onCancel}>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="share-name">Ad</label>
        <input
          id="share-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
          autoFocus
          aria-invalid={nameError}
          aria-describedby="share-name-help"
        />
        <p className="note" id="share-name-help">
          {nameError
            ? 'Harf, rakam, nokta, tire ve alt çizgi. Nokta ya da tireyle başlayamaz.'
            : 'SMB adresinin son parçası olur: \\\\depsis\\' +
              (trimmed === '' ? 'ad' : trimmed) +
              '. ' +
              'Büyük/küçük harf ayrımı yok — Windows ikisini aynı görür.'}
        </p>

        <label htmlFor="share-quota">Kota (GiB, boş bırakılabilir)</label>
        <input
          id="share-quota"
          value={quota}
          inputMode="decimal"
          onChange={(event) => setQuota(event.target.value)}
          autoComplete="off"
          aria-invalid={!quotaOk}
          aria-describedby="share-quota-help"
        />
        <p className="note" id="share-quota-help">
          Anlık görüntüler bu kotanın dışında sayılır, yani yönetici yedek politikası kimseyi kendi
          alanının dışına kilitleyemez.
        </p>

        <label>
          <input
            type="checkbox"
            checked={readOnly}
            onChange={(event) => setReadOnly(event.target.checked)}
          />{' '}
          Salt okunur
        </label>

        <p className="note">
          Paylaşım <b>kapalı</b> açılır: başta yalnız siz ve diğer yöneticiler görür. Başkalarına
          açmak için listedeki <b>İzinler</b> düğmesinden bir kök izni yazın.
        </p>

        <div className="row">
          <button type="button" className="no" onClick={onCancel}>
            Vazgeç
          </button>
          <button type="submit" className="yes" disabled={!nameOk || !quotaOk || busy}>
            {busy ? 'Açılıyor…' : 'Aç'}
          </button>
        </div>
      </form>
    </Win>
  );
}
