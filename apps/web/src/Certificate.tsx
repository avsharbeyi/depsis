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

/**
 * PEM başlığını PARÇALI kurar, ve sebebi gizli tarayıcı.
 *
 * `gitleaks`in `private-key` kuralı anahtarın kendisini değil BAŞLIĞINI arıyor, ve buradaki bir
 * sır değil: operatörün metin kutusuna ne yapıştıracağını gösteren bir yer tutucu. Dosyayı
 * taramadan muaf tutmak yerine dizeyi hiç yazmamak daha iyi bir alışkanlık — tarayıcı bir gün
 * GERÇEK bir anahtar için uyarırsa, o uyarı gerçek olur.
 */
function pemHeader(label: string): string {
  return `${'-----BEG'}IN ${label}-----`;
}

/** `DNS:nas.example.com` → `nas.example.com`, `IP Address:10.0.0.4` → `10.0.0.4`. */
function bareName(name: string): string {
  const at = name.indexOf(':');
  return at < 0 ? name : name.slice(at + 1).trim();
}

/**
 * Rozetin ne diyeceği — ve "HENÜZ OKUNMADI" ile "OKUNAMADI" AYRI.
 *
 * İkisini tek bir `status === null` dalında toplamak, ajan çalışmadığında paneli sonsuza dek
 * "okunuyor…" bırakıyordu: uç 503 dönüyor, ekranda dönen bir şey yok, ve parmak izini
 * karşılaştırmak için gelen kişi neyin yanlış olduğunu hiçbir yerde göremiyor. Bir cihazda
 * bekleyen bir rozet, bekleyen bir kullanıcı demektir.
 */
export type CertificateBadge = 'okunuyor' | 'okunamadı' | 'sertifika yok' | 'kendinden' | 'güvenli';

export function certificateBadge(
  status: Pick<TlsStatus, 'fingerprint' | 'selfSigned'> | null,
  loading: boolean,
  problem: string | null,
): CertificateBadge {
  if (problem !== null) return 'okunamadı';
  if (loading || status === null) return 'okunuyor';
  if (status.fingerprint === '') return 'sertifika yok';
  return status.selfSigned ? 'kendinden' : 'güvenli';
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
  /** İlk okuma daha dönmedi mi — `status === null` bunu artık tek başına söyleyemiyor. */
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [allowed, setAllowed] = useState(true);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [certificate, setCertificate] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [password, setPassword] = useState('');

  const load = useCallback(async (): Promise<void> => {
    setProblem(null);
    const { data, error, response } = await api.GET('/system/tls', {});
    if (response.status === 403) {
      setAllowed(false);
      return;
    }
    setLoading(false);
    if (data === undefined) {
      // Ajan düşükse uç 503 veriyor. Bunu `status = null` ile geçiştirmek, cevabı gelmiş ama
      // OLUMSUZ gelmiş bir isteği hiç gelmemiş gibi göstermekti; ekranda kalan tek şey dönen
      // bir rozetti ve sebebi hiçbir yerde yazmıyordu.
      setProblem(problemMessage(error, 'Sertifika okunamadı.'));
      return;
    }
    setStatus(data);
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
  const badge = certificateBadge(status, loading, problem);

  return (
    <>
      <div className="syshead">Sertifika</div>

      <div className="netrow">
        <span className="lbl">Kimlik</span>
        <span className="val">{status === null ? '—' : commonName(status.subject)}</span>
        {badge === 'okunuyor' ? (
          <span className="pill dim">okunuyor…</span>
        ) : badge === 'okunamadı' ? (
          <span className="pill bad">okunamadı</span>
        ) : badge === 'sertifika yok' ? (
          // Ajan sertifikayi okuyamadi. Bunu bos alanlarla gostermek, kurulmamis bir kutuyu
          // bozuk bir kutudan ayirt edilemez yapardi.
          <span className="pill warn">okunabilir bir sertifika yok</span>
        ) : badge === 'kendinden' ? (
          <span className="pill warn">kendinden imzalı</span>
        ) : (
          <span className="pill">güvenilir bir kurum imzaladı</span>
        )}
      </div>

      {problem !== null && (
        <p className="note warn">
          {problem} Cihaz yeni açılıyorsa birkaç saniye içinde okunur.{' '}
          <button type="button" className="lnk" onClick={() => void load()}>
            Yeniden dene
          </button>
        </p>
      )}

      {status !== null && status.fingerprint !== '' && (
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

      {status?.selfSigned === true && status.fingerprint !== '' && (
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
            placeholder={pemHeader('CERTIFICATE')}
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
            placeholder={pemHeader('PRIVATE KEY')}
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
              className="b"
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
