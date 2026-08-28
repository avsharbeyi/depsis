import { useRef, useState } from 'react';

import { Win } from './ui.js';

/**
 * Kamerayla QR/barkod okuma — dosya aramasının gözü.
 *
 * İKİNCİ TASARIM, ve ilkinin sahada öğrettiğiyle: ilk sürüm sayfanın içinde canlı kamera
 * açıyordu (`getUserMedia`) ve iki yerde birden düştü. Android Chrome, kendinden imzalı
 * sertifikayla açılmış bir sayfaya kamerayı SORMADAN reddediyor — izin penceresi hiç çıkmıyor,
 * kullanıcı "izin görünmüyor" diye bakakalıyor. iOS Safari ise çözücü API'yi (BarcodeDetector)
 * hiç vermiyor.
 *
 * Şimdiki akış ikisinde de aynı çalışıyor: düğme TELEFONUN KENDİ KAMERA UYGULAMASINI açar
 * (`<input capture>` — web kamera izni diye bir şey gerekmez, sertifikaya bakmaz), kullanıcı
 * kodu fotoğraflar, kare CİHAZDA çözülür — Android/masaüstünde yerli BarcodeDetector ile,
 * o yoksa pakete gömülü ZXing ile (ağdan hiçbir şey inmez; modül yalnız gerektiğinde,
 * dinamik import ile yüklenir). Okunan yazı ÖNCE gösterilir; "Tamam" denince aramaya geçer —
 * yarım kareden yanlış okuma aramaya sızmaz.
 */

/** `BarcodeDetector` lib.dom'da henüz yok; kullandığımız kadarı burada tariflenir. */
interface DetectedBarcode {
  rawValue: string;
}
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
};

/** Yerli çözücünün tür adları — QR + market/kargo barkodlarının yaygınları. */
const NATIVE_FORMATS = [
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

/**
 * Fotoğrafı çözülebilir boyuta indirip piksellerini ver.
 *
 * Telefon kamerası 12 megapiksel çeker; çözücüler 1-2 megapikselde hem daha hızlı hem daha
 * isabetli (büyük karede ince çizgiler yumuşar). En uzun kenar 1600'e indiriliyor.
 */
async function rasterize(file: File): Promise<{ canvas: HTMLCanvasElement; data: ImageData }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('canvas yok');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return { canvas, data: ctx.getImageData(0, 0, canvas.width, canvas.height) };
}

/** Yerli çözücü — varsa. Android Chrome ve masaüstü Chrome/Edge burada biter. */
async function decodeNative(canvas: HTMLCanvasElement): Promise<string | null> {
  const Ctor = (window as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (typeof Ctor !== 'function') return null;
  try {
    const codes = await new Ctor({ formats: NATIVE_FORMATS }).detect(canvas);
    const raw = codes[0]?.rawValue.trim();
    return raw === undefined || raw === '' ? null : raw;
  } catch {
    return null;
  }
}

/**
 * ZXing ile çöz — iOS'un (ve yerli çözücüsü olmayan her tarayıcının) yolu.
 *
 * DİNAMİK import: paket ~yüz kilobayt ve yalnız kod okutan öder; sayfanın olağan açılışı onu
 * hiç indirmez. Ağdan değil kendi sunucumuzdan gelir — vite paketin parçası olarak sunar.
 */
async function decodeZxing(data: ImageData): Promise<string | null> {
  const zx = await import('@zxing/library');
  const lum = new Uint8ClampedArray(data.width * data.height);
  for (let i = 0, p = 0; i < lum.length; i += 1, p += 4) {
    // Gözün gördüğü parlaklık: yeşil ağır basar. Tam katsayılar BT.601.
    lum[i] =
      (((data.data[p] ?? 0) * 299 + (data.data[p + 1] ?? 0) * 587 + (data.data[p + 2] ?? 0) * 114) /
        1000) |
      0;
  }
  const source = new zx.RGBLuminanceSource(lum, data.width, data.height);
  const reader = new zx.MultiFormatReader();
  const hints = new Map();
  hints.set(zx.DecodeHintType.TRY_HARDER, true);
  hints.set(zx.DecodeHintType.POSSIBLE_FORMATS, [
    zx.BarcodeFormat.QR_CODE,
    zx.BarcodeFormat.EAN_13,
    zx.BarcodeFormat.EAN_8,
    zx.BarcodeFormat.UPC_A,
    zx.BarcodeFormat.UPC_E,
    zx.BarcodeFormat.CODE_128,
    zx.BarcodeFormat.CODE_39,
    zx.BarcodeFormat.ITF,
    zx.BarcodeFormat.DATA_MATRIX,
  ]);
  reader.setHints(hints);
  try {
    const result = reader.decode(new zx.BinaryBitmap(new zx.HybridBinarizer(source)));
    const raw = result.getText().trim();
    return raw === '' ? null : raw;
  } catch {
    return null;
  }
}

export function Scan({
  onResult,
  onClose,
}: {
  /** Onaylanan metin — çağıran bunu arama kutusuna koyar. */
  onResult: (text: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const picker = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [shot, setShot] = useState<string | null>(null);
  const [found, setFound] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<string | null>(null);

  async function onFile(file: File): Promise<void> {
    setBusy(true);
    setFound(null);
    setVerdict(null);
    const url = URL.createObjectURL(file);
    setShot((old) => {
      if (old !== null) URL.revokeObjectURL(old);
      return url;
    });
    try {
      const { canvas, data } = await rasterize(file);
      const raw = (await decodeNative(canvas)) ?? (await decodeZxing(data));
      if (raw === null) {
        setVerdict(
          'Kod okunamadı. Kodu kadrajın ortasına alıp daha yakından, ışıklı bir yerde yeniden çekin.',
        );
      } else {
        setFound(raw);
      }
    } catch {
      setVerdict('Fotoğraf işlenemedi; yeniden deneyin.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Win title="Kodu okut" glyph="▦" tone="cool" onClose={onClose}>
      {/* Gizli dosya girişi: `capture` telefonda doğrudan kamera uygulamasını açar — web kamera
          izni gerekmez, kendinden imzalı sertifika umursanmaz, iOS ve Android'de aynı davranır.
          Masaüstünde sıradan bir dosya seçici olur: barkodun fotoğrafı da okunur. */}
      <input
        ref={picker}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Aynı dosya ikinci kez seçilebilsin: value temizlenmezse change hiç düşmez.
          event.target.value = '';
          if (file !== undefined) void onFile(file);
        }}
      />

      {shot !== null && (
        <img
          src={shot}
          alt="Çekilen kare"
          style={{
            width: '100%',
            maxHeight: '38vh',
            objectFit: 'contain',
            borderRadius: 10,
            border: '1px solid var(--edge)',
            background: '#000',
          }}
        />
      )}

      {found !== null && (
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
      )}
      {verdict !== null && <p className="note">{verdict}</p>}
      {shot === null && verdict === null && (
        <p className="note">
          Düğmeye basınca kamera açılır; QR kodu ya da barkodu fotoğraflayın. Okunan yazı önce
          burada gösterilir, siz onaylayınca aranır.
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        {found !== null && (
          <button
            type="button"
            className="b pri"
            style={{ flex: 1 }}
            onClick={() => onResult(found)}
          >
            Tamam — ara
          </button>
        )}
        <button
          type="button"
          className={found === null ? 'b pri' : 'b'}
          style={found === null ? { flex: 1 } : undefined}
          disabled={busy}
          onClick={() => picker.current?.click()}
        >
          {busy ? 'Çözülüyor…' : shot === null ? '📷 Kamerayı aç' : 'Yeniden çek'}
        </button>
      </div>
    </Win>
  );
}
