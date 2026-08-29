import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api, problemMessage } from './api.js';

type TlsStatus = OpenApi.components['schemas']['TlsStatus'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

/** `CN=nas.example.com, O=DEPSIS` içinden yalnız adı çıkarır; olmazsa olduğu gibi gösterir. */
function commonName(subject: string): string {
  for (const part of subject.split(',')) {
    const trimmed = part.trim();
    if (trimmed.toUpperCase().startsWith('CN=')) return trimmed.slice(3);
  }
  return subject;
}

/** `DNS:nas.example.com` → `nas.example.com`, `IP Address:10.0.0.4` → `10.0.0.4`. */
function bareName(name: string): string {
  const at = name.indexOf(':');
  return at < 0 ? name : name.slice(at + 1).trim();
}

/**
 * Sertifika — kutunun HTTPS kimliği.
 *
 * İKİ İŞ, VE İLKİ EN AZ İKİNCİSİ KADAR ÖNEMLİ.
 *
 * Birincisi GÖSTERMEK. Kurulum kendinden imzalı bir sertifika üretiyor ve tarayıcı haklı olarak
 * uyarıyor — bir NAS'a ilk kez bağlanan tarayıcının o sertifikayı doğrulamasının yolu yok. O uyarı
 * ekranında karşılaştırılacak tek şey PARMAK İZİ, ve onu görmenin tek yolu bugüne kadar kurulum
 * çıktısına bakmaktı: bir daha açılmayan bir pencere.
 *
 * İkincisi DEĞİŞTİRMEK. Sahibinin kendi alan adı varsa, o alan adı için aldığı sertifikayı kutuya
 * koyabilmeli. Bunun yolu `scp` ile iki dosya kopyalamak olmamalı.
 *
 * NE YAPMADIĞI DA YAZILI: bu panel sertifika ALMAZ. Let's Encrypt'in HTTP-01 doğrulaması kutuya
 * internetten 80 portuyla ulaşılmasını istiyor, DNS-01 ise alan adı sağlayıcısının API anahtarını
 * — ikisi de bir ev cihazında güvenilemeyecek varsayımlar. Sahibi sertifikayı sağlayıcısından
 * alıyor, buraya yapıştırıyor.
 */
export function CertificatePanel({ notify }: { notify: Notify }): React.JSX.Element | null {
  const [status, setStatus] = useState<TlsStatus | null>(null);
  const [allowed, setAllowed] = useState(true);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [certificate, setCertificate] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [password, setPassword] = useState('');

  const load = useCallback(async (): Promise<void> => {
    const { data, response } = await api.GET('/system/tls', {});
    if (response.status === 403) {
      setAllowed(false);
      return;
    }
    setStatus(data ?? null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!allowed) return null;

  async function install(): Promise<void> {
    setBusy(true);
    const { data, error } = await api.POST('/system/tls/certificate', {
      body: { certificate, privateKey, password },
    });
    setBusy(false);
    // Parola her durumda temizleniyor, başarıda da hatada da: ekranda duran bir parola alanı,
    // omzunun üstünden bakan biri için hazır bir hediye.
    setPassword('');
    if (data === undefined) {
      notify('error', problemMessage(error, 'Sertifika kurulamadı.'));
      return;
    }
    setStatus(data);
    setOpen(false);
    setCertificate('');
    setPrivateKey('');
    notify('ok', 'Sertifika kuruldu. Tarayıcınız eski sertifikayı hatırlıyorsa sayfayı yenileyin.');
  }

  const names = status?.names ?? [];

  return (
    <>
      <div className="syshead">Sertifika</div>

      <div className="netrow">
        <span className="lbl">Kimlik</span>
        <span className="val">{status === null ? '—' : commonName(status.subject)}</span>
        {status === null ? (
          <span className="pill dim">okunuyor…</span>
        ) : status.selfSigned ? (
          <span className="pill warn">kendinden imzalı</span>
        ) : (
          <span className="pill">güvenilir bir kurum imzaladı</span>
        )}
      </div>

      {status !== null && (
        <>
          {names.length > 0 && (
            <div className="netrow">
              <span className="lbl">Geçerli adresler</span>
              <span className="note">{names.map(bareName).join(' · ')}</span>
            </div>
          )}
          <div className="netrow">
            <span className="lbl">Bitiş</span>
            <span className="note">{status.notAfter}</span>
          </div>
          <div className="netrow">
            <span className="lbl">Parmak izi</span>
            <span className="note" style={{ fontFamily: 'var(--mono)', wordBreak: 'break-all' }}>
              {status.fingerprint}
            </span>
          </div>
        </>
      )}

      {status?.selfSigned === true && (
        <p className="note">
          Tarayıcı bu sertifika için uyarı gösteriyor, ve uyarı doğru: cihazın kendi ürettiği bir
          sertifikayı hiçbir tarayıcı doğrulayamaz. Uyarı ekranında gösterilen parmak izi yukarıdaki
          ile aynıysa bağlantı gerçekten bu cihazadır. Uyarıyı tamamen kaldırmanın yolu, kendi alan
          adınız için aldığınız bir sertifikayı aşağıdan kurmak.
        </p>
      )}

      {open ? (
        <>
          <p className="note">
            Sağlayıcınızdan aldığınız dosyaları yapıştırın. Sertifika alanına <b>zinciri</b>
            (sunucu sertifikası + ara sertifikalar) koyabilirsiniz. Şifreli bir özel anahtar kabul
            edilmiyor.
          </p>
          <label className="lbl" htmlFor="tls-cert">
            Sertifika (PEM)
          </label>
          <textarea
            id="tls-cert"
            className="sb"
            rows={6}
            spellCheck={false}
            placeholder="-----BEGIN CERTIFICATE-----"
            value={certificate}
            onChange={(event) => setCertificate(event.target.value)}
          />
          <label className="lbl" htmlFor="tls-key">
            Özel anahtar (PEM)
          </label>
          <textarea
            id="tls-key"
            className="sb"
            rows={5}
            spellCheck={false}
            placeholder="-----BEGIN PRIVATE KEY-----"
            value={privateKey}
            onChange={(event) => setPrivateKey(event.target.value)}
          />
          <div className="netrow">
            <span className="lbl">Parola</span>
            <input
              type="password"
              className="sb"
              aria-label="Parola"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button
              type="button"
              className="b"
              disabled={busy || certificate === '' || privateKey === '' || password === ''}
              onClick={() => void install()}
            >
              {busy ? 'Kuruluyor…' : 'Sertifikayı kur'}
            </button>
            <button
              type="button"
              className="b ghost"
              onClick={() => {
                setOpen(false);
                setPassword('');
              }}
            >
              Vazgeç
            </button>
          </div>
        </>
      ) : (
        <div className="netrow">
          <button type="button" className="b" onClick={() => setOpen(true)}>
            ⤓ Kendi sertifikamı kur
          </button>
        </div>
      )}
    </>
  );
}
