import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState, type ReactElement } from 'react';

import { api, problemMessage } from './api.js';

type Backup = OpenApi.components['schemas']['Snapshot'];
type Status = OpenApi.components['schemas']['OffsiteStatus'];
type HostKey = OpenApi.components['schemas']['OffsiteHostKeyPage']['items'][number];
type Notify = (kind: 'ok' | 'error', text: string) => void;

/**
 * Başka bir makineye yedekleme — yangının, hırsızlığın ve fidye yazılımının hesaba katıldığı yer.
 *
 * İkinci bir havuza çoğaltmak bir diskin ölmesini atlatıyor. Atlatmadığı şey kutunun çalınması,
 * evin yanması, ya da fidye yazılımının bağlı her veri kümesine ulaşması — ki insanlar "yedek"
 * derken çoğunlukla bunu kastediyor.
 *
 * ÜÇ ADIM, ve sıraları öğretici olduğu için ayrı ayrı gösteriliyor: anahtar üret, karşı tarafa
 * yapıştır, host anahtarını onayla. Tek bir "bağlan" düğmesi bunları gizlerdi, ve gizlediği şeyin
 * ikisi kullanıcının başka bir makinede yapması gereken işler — gizlenirse yapılmaz.
 *
 * PARMAK İZİ KARŞILAŞTIRMASI BU EKRANIN VAR OLMA SEBEBİ. "Bağlan ve ne çıkarsa kabul et" bir
 * replikasyonda saldırganın bu cihazdaki her dosyanın kopyasını alması demek; yanlış makineye
 * giden bir yedek, hiç yedek olmamasından kötü.
 */
export function Offsite({
  backups,
  notify,
  onQueued,
}: {
  backups: Backup[];
  notify: Notify;
  onQueued: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [user, setUser] = useState('');
  const [keys, setKeys] = useState<HostKey[] | null>(null);

  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [base, setBase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [password, setPassword] = useState('');

  const load = useCallback(async (): Promise<void> => {
    const { data, error } = await api.GET('/storage/offsite', {});
    if (data === undefined) {
      notify('error', problemMessage(error, 'Off-site durumu okunamadı.'));
      return;
    }
    setStatus(data);
  }, [notify]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  const portNumber = Number.parseInt(port, 10);
  const validPort = Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;
  // `known_hosts`'un kendi arama anahtarı, ve arayüz onu sunucuyla AYNI kuralla kuruyor: 22 için
  // çıplak ad, başka port için köşeli parantez. Farklı kurmak, güvenilen bir hedefi güvenilmiyor
  // göstermek olurdu.
  const pattern = validPort && portNumber !== 22 ? `[${host.trim()}]:${port}` : host.trim();
  const trusted =
    host.trim() !== '' &&
    (status?.trusted ?? []).some((entry) => entry.split(',').includes(pattern));

  const sendable = backups.filter((item) => item.state === 'present' || item.state === 'unmanaged');
  const chosen = sendable.find((item) => item.fullName === source);
  const bases =
    chosen === undefined
      ? []
      : sendable.filter((item) => item.dataset === chosen.dataset && item.fullName !== source);

  const named = `${user.trim()}@${host.trim()}:${target.trim()}`;

  async function generate(): Promise<void> {
    setBusy(true);
    const { data, error } = await api.POST('/storage/offsite/identity', {});
    setBusy(false);
    if (data === undefined) {
      notify('error', problemMessage(error, 'Anahtar üretilemedi.'));
      return;
    }
    setStatus(data);
    notify('ok', 'Anahtar üretildi. Açık yarısını hedefe ekleyin.');
  }

  async function scan(): Promise<void> {
    if (!validPort) return;
    setBusy(true);
    setKeys(null);
    const { data, error } = await api.POST('/storage/offsite/scan', {
      body: { host: host.trim(), port: portNumber },
    });
    setBusy(false);
    if (data === undefined) {
      notify('error', problemMessage(error, 'Hedefe ulaşılamadı.'));
      return;
    }
    setKeys(data.items);
  }

  async function trust(key: HostKey): Promise<void> {
    setBusy(true);
    const { data, error } = await api.POST('/storage/offsite/trust', {
      body: { host: host.trim(), port: portNumber, line: key.line },
    });
    setBusy(false);
    if (data === undefined) {
      notify('error', problemMessage(error, 'Host anahtarı kaydedilemedi.'));
      return;
    }
    setStatus(data);
    setKeys(null);
    notify('ok', `${host.trim()} artık güvenilen hedefler arasında.`);
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (chosen === undefined || busy || !validPort) return;
    setBusy(true);
    const { data, error } = await api.POST('/storage/offsite/replicate', {
      body: {
        host: host.trim(),
        port: portNumber,
        user: user.trim(),
        source: chosen.dataset,
        snapshot: chosen.name,
        target: target.trim(),
        base: base === '' ? null : (bases.find((b) => b.fullName === base)?.name ?? null),
        confirm: confirm.trim(),
        password,
      },
    });
    setBusy(false);
    // PAROLA HER DURUMDA TEMİZLENİYOR, başarıda da hatada da. Ekranda duran bir parola, formu
    // kapatmayı unutan biri için açık kalmış bir kapı.
    setPassword('');
    if (data === undefined) {
      notify('error', problemMessage(error, 'Off-site çoğaltma başlatılamadı.'));
      return;
    }
    notify('ok', 'Off-site çoğaltma işi kuyruğa alındı.');
    setConfirm('');
    setOpen(false);
    onQueued();
  }

  if (!open) {
    return (
      <button type="button" className="lnk" onClick={() => setOpen(true)}>
        Başka bir makineye yedekle
      </button>
    );
  }

  return (
    <div className="repl">
      <div className="warn">
        <span className="ic" aria-hidden>
          ⚠
        </span>
        <span className="tx">
          <b>Hedef makinedeki veri kümesi yok edilir.</b>
          Karşı tarafta <code>zfs recv -F</code> çalışıyor: hedefteki her şey ve ortak tabandan yeni
          her anlık görüntü siliniyor. Yok edilen şey BU cihazda değil, karşı tarafta.
        </span>
      </div>

      {/* ── 1. anahtar ── */}
      <div className="thead">
        <span className="lbl">1. Bu cihazın anahtarı</span>
      </div>
      {status === null && <p className="note">Okunuyor…</p>}
      {status !== null && !status.hasIdentity && (
        <div className="row">
          <button type="button" className="b" disabled={busy} onClick={() => void generate()}>
            Anahtar üret
          </button>
          <span className="note">
            Bir kez üretilir ve bu cihazda kalır. Özel yarısı hiçbir ekranda görünmüyor.
          </span>
        </div>
      )}
      {status !== null && status.hasIdentity && (
        <>
          <p className="note">
            Aşağıdaki satırı hedef makinede <code>~/.ssh/authorized_keys</code> dosyasına ekleyin.
          </p>
          <textarea className="mono" readOnly rows={3} value={status.publicKey ?? ''} />
          <p className="note m">{status.fingerprint}</p>
        </>
      )}

      {/* ── 2. hedef ── */}
      <div className="thead">
        <span className="lbl">2. Hedef makine</span>
      </div>
      <label className="fld">
        <span className="lbl">Makine adı ya da IPv4 adresi</span>
        <input
          value={host}
          onChange={(event) => setHost(event.target.value)}
          placeholder="yedek.ornek.org"
          maxLength={253}
        />
      </label>
      <label className="fld">
        <span className="lbl">Port</span>
        <input
          value={port}
          onChange={(event) => setPort(event.target.value)}
          inputMode="numeric"
          maxLength={5}
        />
      </label>
      <label className="fld">
        <span className="lbl">Karşı taraftaki hesap</span>
        <input
          value={user}
          onChange={(event) => setUser(event.target.value)}
          placeholder="depsis"
          maxLength={32}
        />
      </label>

      {/* ── 3. host anahtarı ── */}
      <div className="thead">
        <span className="lbl">3. Hedefin kimliği</span>
        <button
          type="button"
          className="lnk"
          disabled={busy || host.trim() === '' || !validPort}
          onClick={() => void scan()}
        >
          Host anahtarını sor
        </button>
      </div>

      {trusted && (
        <p className="note">
          ✔ <b>{pattern}</b> onaylanmış hedefler arasında.
        </p>
      )}

      {keys !== null && keys.length === 0 && (
        <p className="note">Hedef bir host anahtarı bildirmedi.</p>
      )}

      {keys !== null && keys.length > 0 && (
        <>
          <p className="note">
            Aşağıdaki parmak izini hedef makinede{' '}
            <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> çıktısıyla{' '}
            <b>karşılaştırın</b>. Eşleşmiyorsa onaylamayın — yanlış makineye giden bir yedek, hiç
            yedek olmamasından kötüdür.
          </p>
          <table className="tbl">
            <tbody>
              {keys.map((key) => (
                <tr key={key.line}>
                  <td>{key.kind}</td>
                  <td className="m">{key.fingerprint}</td>
                  <td>
                    <button
                      type="button"
                      className="b"
                      disabled={busy}
                      onClick={() => void trust(key)}
                    >
                      Bu anahtarı onayla
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* ── 4. gönderim ── */}
      <form onSubmit={(event) => void submit(event)}>
        <div className="thead">
          <span className="lbl">4. Gönderim</span>
        </div>

        <label className="fld">
          <span className="lbl">Gönderilecek anlık görüntü</span>
          <select value={source} onChange={(event) => setSource(event.target.value)} required>
            <option value="">Seçin…</option>
            {sendable.map((item) => (
              <option key={item.fullName} value={item.fullName}>
                {item.fullName}
              </option>
            ))}
          </select>
        </label>

        <label className="fld">
          <span className="lbl">Karşı taraftaki hedef veri kümesi</span>
          <input
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder="yedek/depsis"
            maxLength={255}
            required
          />
        </label>

        {bases.length > 0 && (
          <label className="fld">
            <span className="lbl">Artımlı taban (isteğe bağlı)</span>
            <select value={base} onChange={(event) => setBase(event.target.value)}>
              {/* Boş = TAM gönderim, ve bu varsayılan. Karşı tarafın neyi tuttuğunu bu ekran
                  bilmiyor, ve yanlış bir taban seçmek reddedilen bir işten başka bir şey
                  üretmiyor. */}
              <option value="">Tam gönderim</option>
              {bases.map((item) => (
                <option key={item.fullName} value={item.fullName}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="fld">
          <span className="lbl">
            Onaylamak için hedefin tam adını yazın
            {user.trim() === '' || host.trim() === '' || target.trim() === '' ? '' : `: ${named}`}
          </span>
          <input
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="off"
            required
          />
        </label>

        <label className="fld">
          <span className="lbl">Parolanız</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        <div className="row">
          {/* Host onaylanmadan kapalı, ve bu arayüzün nezaketi değil sunucunun kuralının aynası:
              ajan güvenilmeyen bir hedefe bağlanmayı reddediyor. Düğmenin açık olması, reddedilecek
              bir işi kuyruğa aldırmak olurdu. */}
          <button
            type="submit"
            className="b danger"
            disabled={
              busy ||
              chosen === undefined ||
              !trusted ||
              status?.hasIdentity !== true ||
              user.trim() === '' ||
              target.trim() === '' ||
              confirm.trim() !== named
            }
          >
            Gönder
          </button>
          <button type="button" className="b" onClick={() => setOpen(false)}>
            Vazgeç
          </button>
        </div>
      </form>
    </div>
  );
}
