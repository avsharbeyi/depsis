import { useCallback, useEffect, useRef, useState } from 'react';

import { Win } from './ui.js';

/**
 * Kamerayla QR/barkod okuyucu — dosya aramasının gözü.
 *
 * Sahibin isteği ve akışı bire bir: kamera kodu okur, OKUNAN YAZI ÖNCE GÖSTERİLİR, "Tamam"
 * denince aramaya geçer. Otomatik geçiş bilerek yok — barkod okuyucular yarım kareden yanlış
 * okur, ve yanlış bir aramanın "sonuç yok"u, kullanıcıya dosyanın olmadığını söyler. Onay adımı
 * ucuz, yanlış arama pahalı.
 *
 * Tarayıcının YERLİ `BarcodeDetector` API'siyle: kütüphane yok, indirme yok, çözme işi işletim
 * sisteminin kendi kod çözücüsünde. Bedeli dürüstçe söyleniyor: bu API her tarayıcıda yok
 * (Android Chrome'da var, iOS Safari'de yok) — olmayan yerde düğme bir özür gösterir, sahte bir
 * tarayıcı değil.
 */

/** `BarcodeDetector` lib.dom'da henüz yok; kullandığımız kadarı burada tariflenir. */
interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

/** Okutulacak türler: QR + market/kargo barkodlarının yaygınları. */
const FORMATS = [
  'qr_code',
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'code_128',
  'code_39',
  'itf',
  'data_matrix',
];

export function Scan({
  onResult,
  onClose,
}: {
  /** Onaylanan metin — çağıran bunu arama kutusuna koyar. */
  onResult: (text: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const video = useRef<HTMLVideoElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const [found, setFound] = useState<string | null>(null);
  // Aralık döngüsünün gördüğü kopya: kapanış ilk çizimin `found`unu görür (bayat kapanış), ref
  // her zaman şimdiyi. Onsuz döngü, duraklatılmış karede boş yere çözmeye devam ederdi.
  const foundRef = useRef<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const supported =
    typeof (window as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector === 'function';

  useEffect(() => {
    if (!supported) return undefined;
    let alive = true;
    let timer = 0;

    void (async () => {
      try {
        // Arka kamera: kod okumak telefonun işi ve telefonun kodu gören yüzü arkası. Masaüstünde
        // bu ipucu sessizce yok sayılır ve eldeki kamera açılır.
        const media = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        if (!alive) {
          for (const track of media.getTracks()) track.stop();
          return;
        }
        stream.current = media;
        const el = video.current;
        if (el === null) return;
        el.srcObject = media;
        await el.play();

        const Ctor = (window as unknown as { BarcodeDetector: BarcodeDetectorCtor })
          .BarcodeDetector;
        const detector = new Ctor({ formats: FORMATS });

        // 300 ms'de bir kare: insan eli kodu saniyeler boyunca tutuyor, daha sık sormak yalnız
        // pil yakar. Bulunca durur — video da durdurulur ki ekranda okunan kare donsun ve
        // kullanıcı NEYİ okuduğunu görsün.
        timer = window.setInterval(() => {
          void (async () => {
            const target = video.current;
            if (target === null || target.readyState < 2 || foundRef.current !== null) return;
            try {
              const codes = await detector.detect(target);
              const raw = codes[0]?.rawValue.trim();
              if (raw !== undefined && raw !== '') {
                target.pause();
                foundRef.current = raw;
                setFound(raw);
              }
            } catch {
              // Tek karelik çözme hatası olağan (bulanık kare); döngü sürer.
            }
          })();
        }, 300);
      } catch (error) {
        if (!alive) return;
        setFailure(
          error instanceof DOMException && error.name === 'NotAllowedError'
            ? 'Kamera izni verilmedi. Tarayıcının adres çubuğundan kameraya izin verin.'
            : 'Kamera açılamadı.',
        );
      }
    })();

    return () => {
      alive = false;
      window.clearInterval(timer);
      const media = stream.current;
      if (media !== null) for (const track of media.getTracks()) track.stop();
    };
    // `found` bilerek bağımlılık DEĞİL: efekt kamerayı bir kez kurar; bulununca döngü içteki
    // koşulla durur. `found`a bağlamak her bulunuşta kamerayı kapatıp yeniden açardı.
  }, [supported]);

  const resume = useCallback(() => {
    foundRef.current = null;
    setFound(null);
    void video.current?.play();
  }, []);

  return (
    <Win title="Kodu okut" glyph="▦" tone="cool" onClose={onClose}>
      {!supported && (
        <div className="note">
          Bu tarayıcı kamerayla kod okumayı desteklemiyor (BarcodeDetector yok). Android
          Chrome&apos;da çalışır; iPhone&apos;da Safari henüz vermiyor.
        </div>
      )}
      {supported && failure !== null && <div className="note">{failure}</div>}
      {supported && failure === null && (
        <>
          <video
            ref={video}
            playsInline
            muted
            style={{
              width: '100%',
              maxHeight: '52vh',
              borderRadius: 10,
              border: '1px solid var(--edge)',
              background: '#000',
              objectFit: 'cover',
            }}
          />
          {found === null ? (
            <p className="note">QR kodu ya da barkodu kameraya gösterin…</p>
          ) : (
            <>
              <div
                className="val"
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 15,
                  padding: '10px 12px',
                  border: '1px solid var(--edge)',
                  borderRadius: 10,
                  margin: '10px 0',
                  wordBreak: 'break-all',
                }}
              >
                {found}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="b pri"
                  style={{ flex: 1 }}
                  onClick={() => onResult(found)}
                >
                  Tamam — ara
                </button>
                <button type="button" className="b" onClick={resume}>
                  Yeniden okut
                </button>
              </div>
            </>
          )}
        </>
      )}
    </Win>
  );
}
