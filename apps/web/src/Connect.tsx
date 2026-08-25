import { useState, type ReactElement } from 'react';

/**
 * "Bu bilgisayara bağla" — bir paylaşımı bir sürücü hâline getiren komutlar.
 *
 * BU BİR MASAÜSTÜ İSTEMCİSİ DEĞİL, ve olmadığını söylemek onu savunmaktan önemli. Faz 2'nin listesi
 * "masaüstü istemci ve Windows sürücü eşleme" diyor; burada yapılan ikinci yarı, ve birincisi
 * `docs/bilinen-sinirlamalar.md`'de duruyor. Ayrı bir uygulama paketleme, imzalama, otomatik
 * güncelleme ve platform başına bir yükleyici demek — §21'in kendi teslimat listesinde ayrı bir
 * madde olarak zaten bekliyor.
 *
 * Yapılan şey, o uygulamanın çözeceği asıl sürtünmeyi çözüyor: DEPSIS zaten SMB sunuyor, ama
 * kullanıcı adresi, kullanıcı adını ve `net use`'un söz dizimini bilmek zorunda kalıyordu. Paylaşım
 * ekranı adresi veriyordu; eksik olan komutun kendisiydi.
 *
 * ADRES TARAYICININ KENDİ ADRESİNDEN, sunucunun yapılandırılmış adından değil. Sunucunun birkaç
 * adresi olabiliyor ve hangisinin bu istemciye ulaştığını bilmiyor; tarayıcının bağlandığı ad,
 * tanım gereği AZ ÖNCE çalışmış olan. ZeroTier üzerinden bakan biri için de doğru olan bu.
 */
export function Connect({
  shareName,
  username,
  smbReady,
  notify,
}: {
  shareName: string;
  username: string;
  /** SMB parolası var mı. Yoksa aşağıdaki hiçbir komut çalışmıyor, ve bunu söylemek gerekiyor. */
  smbReady: boolean;
  notify: (kind: 'ok' | 'error', text: string) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);

  // `location.hostname`, `host` DEĞİL: port SMB'yi ilgilendirmiyor, ve `depsis:5173` bir UNC
  // adresinde geçersiz. IPv6 adresi köşeli parantezle geliyor ve UNC'de öyle yazılmıyor — ama
  // Windows'un `.ipv6-literal.net` biçimini uydurmak yerine olduğu gibi gösteriliyor: yanlış bir
  // adres vermektense, kullanıcının kopyalayıp düzelteceği doğru bir adres.
  const host = window.location.hostname;

  const lines: { os: string; text: string; note?: string }[] = [
    {
      os: 'Windows — Gezgin',
      text: `\\\\${host}\\${shareName}`,
      note: 'Adres çubuğuna yapıştırın. Bir kereliktir; her açılışta hazır olması için aşağıdakini kullanın.',
    },
    {
      os: 'Windows — kalıcı sürücü',
      // `/persistent:yes` her açılışta yeniden bağlanıyor; `/user:` olmadan Windows oturum açmış
      // kullanıcının adını deniyor, ki o neredeyse hiçbir zaman DEPSIS'teki ad değil.
      text: `net use Z: \\\\${host}\\${shareName} /user:${username} /persistent:yes`,
      note: 'Komut İstemi’nde çalıştırın. Z: doluysa başka bir harf seçin.',
    },
    {
      os: 'macOS — Finder',
      text: `smb://${username}@${host}/${shareName}`,
      note: 'Finder → Git → Sunucuya Bağlan (⌘K).',
    },
    {
      os: 'Linux',
      // `uid=$(id -u)`: onsuz bağlanan ağaç root'a ait görünüyor ve kullanıcı kendi dosyasını
      // düzenleyemiyor — bağlanmanın çalıştığı ama hiçbir şeyin yazılamadığı hâl.
      text: `sudo mount -t cifs //${host}/${shareName} /mnt/depsis -o username=${username},uid=$(id -u),gid=$(id -g)`,
      note: '/mnt/depsis dizininin önceden var olması gerekiyor.',
    },
  ];

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      notify('ok', 'Kopyalandı.');
    } catch {
      // Pano izni verilmemiş olabiliyor, ve bu bir arıza değil. Metin zaten ekranda ve seçilebilir.
      notify('error', 'Panoya yazılamadı; metni elle seçip kopyalayabilirsiniz.');
    }
  }

  if (!open) {
    return (
      <button type="button" className="lnk" onClick={() => setOpen(true)}>
        Bu bilgisayara bağla
      </button>
    );
  }

  return (
    <div className="conn">
      {!smbReady && (
        <div className="warn">
          <span className="ic" aria-hidden>
            ⚠
          </span>
          <span className="tx">
            <b>Bu hesabın SMB parolası yok.</b>
            SMB parolası, DEPSIS parolanız ayarlanırken oluşuyor; bu özellik gelmeden önce
            değiştirdiyseniz henüz yok. Aşağıdaki adresler açılır ama hiçbir parola kabul edilmez.
            <b> Hesap ekranından parolanızı bir kez değiştirin</b>, sonra buraya dönün.
          </span>
        </div>
      )}

      {lines.map((line) => (
        <div className="crow" key={line.os}>
          <div className="lbl">{line.os}</div>
          <div className="cmd">
            {/* Seçilebilir metin, ve kopyalama YALNIZ bir kolaylık: pano izni verilmemiş bir
                tarayıcıda düğme çalışmıyor, ve o durumda ekranda okunabilir bir şeyin durması
                gerekiyor. */}
            <code>{line.text}</code>
            <button
              type="button"
              className="b"
              aria-label={`${line.os} komutunu kopyala`}
              onClick={() => void copy(line.text)}
            >
              Kopyala
            </button>
          </div>
          {line.note !== undefined && <div className="note">{line.note}</div>}
        </div>
      ))}

      <div className="note">
        Kullanıcı adınız <b>{username}</b>, parolanız DEPSIS parolanızın aynısı.
      </div>

      <button type="button" className="lnk" onClick={() => setOpen(false)}>
        Kapat
      </button>
    </div>
  );
}
