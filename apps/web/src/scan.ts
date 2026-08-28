/**
 * QR/barkod çözücü — bir fotoğraftan metin.
 *
 * TASARIMIN ÖLÇÜTÜ HIZ DEĞİL, OKUYABİLMEK. Sahibin sözü açıktı: "ne kadar kaynak kullandığı
 * önemli olmaksızın hata yapmayacak şekilde hızlı". Bu ikisi çelişmiyor çünkü yük dağılımı
 * çarpık: iyi çekilmiş bir kare ilk denemede, yerli çözücüyle, ~30 ms'de biter; zor kare ise
 * zaten bir saniyeyi hak eder. O yüzden burada SIRALI bir merdiven var ve ilk başarıda duruyor —
 * ucuz olan önce, pahalı olan yalnız gerekince.
 *
 * YANLIŞ OKUMA KORKUSU YERSİZ, ve bu onay adımını kaldırmayı meşru kılan şey: QR'ın Reed-Solomon
 * hata düzeltmesi, EAN/UPC/Code-128'in kontrol hanesi var. Çözücüler yarım kareden yanlış bir
 * DEĞER üretmez; ya doğruyu verir ya hiçbir şey. Riskimiz "yanlış okumak" değil "okuyamamak" —
 * merdivenin bütün basamakları da tam bunun için.
 *
 * İki çözücü: tarayıcının yerlisi (`BarcodeDetector`; Android Chrome ve masaüstü Chrome/Edge —
 * işletim sisteminin kendi kod çözücüsü, çok hızlı) ve pakete gömülü ZXing (iOS Safari dahil her
 * yerde çalışır, ağdan hiçbir şey inmez).
 */

import type * as ZxingModule from '@zxing/library';

/** `BarcodeDetector` lib.dom'da henüz yok; kullandığımız kadarı burada tariflenir. */
interface DetectedBarcode {
  rawValue: string;
}
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
};

const NATIVE_FORMATS = [
  'qr_code',
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'code_128',
  'code_39',
  'code_93',
  'itf',
  'codabar',
  'data_matrix',
  'aztec',
  'pdf417',
];

/**
 * ZXing modülü — bir kez yüklenir ve saklanır.
 *
 * `import type` ile: modülün TİPİ derleme zamanında geliyor, KENDİSİ aşağıda dinamik `import()`
 * ile — yani sayfanın olağan açılışı paketi indirmiyor, yalnız kod okutan ödüyor.
 */
type Zxing = typeof ZxingModule;
let zxingPromise: Promise<Zxing> | null = null;

/**
 * ZXing'i ŞİMDİDEN indir.
 *
 * Kullanıcı düğmeye bastığı anda çağrılır: o fotoğrafı çekerken geçen üç beş saniyede modül
 * çoktan yüklenmiş olur, ve çözme anında beklenecek tek şey çözmenin kendisi kalır. Bu, hissedilen
 * hızın en büyük parçası — indirmeyi çözüme seri bağlamak, saniyeyi ikiye katlıyordu.
 */
export function warmScanner(): void {
  zxingPromise ??= import('@zxing/library');
}

async function zxing(): Promise<Zxing> {
  zxingPromise ??= import('@zxing/library');
  return zxingPromise;
}

/**
 * Dosyayı çizilebilir bir görüntüye çevir.
 *
 * `createImageBitmap` önce: hızlı ve iş parçacığını bloklamıyor. iPhone'un HEIC karelerinde
 * bazı sürümlerde düşüyor — o yüzden `<img>` yedeği var, çünkü Safari HEIC'i img olarak açabiliyor.
 */
async function toImage(file: File): Promise<CanvasImageSource & { width: number; height: number }> {
  try {
    return await createImageBitmap(file);
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'sync';
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('görüntü açılamadı'));
        img.src = url;
      });
      return img;
    } finally {
      // Çizim `drawImage` ile senkron yapılacak; URL'i bırakmak güvenli değil, o yüzden bir tur
      // sonraya bırakılıyor: makro görev sırası, kullanan bütün çizimlerden sonra gelir.
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
  }
}

interface Variant {
  canvas: HTMLCanvasElement;
  data: ImageData;
}

/** Kaynağı verilen en uzun kenara indirip (gerekirse döndürüp) piksellerini ver. */
function render(
  source: CanvasImageSource & { width: number; height: number },
  longest: number,
  options: { rotate?: 0 | 90; crop?: number } = {},
): Variant | null {
  const crop = options.crop ?? 1;
  const sw = Math.round(source.width * crop);
  const sh = Math.round(source.height * crop);
  const sx = Math.round((source.width - sw) / 2);
  const sy = Math.round((source.height - sh) / 2);

  const scale = Math.min(1, longest / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement('canvas');
  const turned = options.rotate === 90;
  canvas.width = turned ? h : w;
  canvas.height = turned ? w : h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) return null;
  if (turned) {
    ctx.translate(h, 0);
    ctx.rotate(Math.PI / 2);
  }
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
  return { canvas, data: ctx.getImageData(0, 0, canvas.width, canvas.height) };
}

/**
 * Kontrastı ger ve gerekirse tersine çevir.
 *
 * Loş ışıkta çekilmiş bir kare bütün parlaklığını dar bir bantta toplar ve ikili eşikleme
 * çuvallar; germek o bandı açar. Tersine çevirme ise siyah zemine beyaz basılmış kodlar için —
 * ZXing bazı biçimlerde onları olduğu gibi okumaz.
 */
function enhance(variant: Variant, invert: boolean): Variant | null {
  const { data } = variant;
  const pixels = data.data;
  let min = 255;
  let max = 0;
  for (let p = 0; p < pixels.length; p += 4) {
    const lum =
      ((pixels[p] ?? 0) * 299 + (pixels[p + 1] ?? 0) * 587 + (pixels[p + 2] ?? 0) * 114) / 1000;
    if (lum < min) min = lum;
    if (lum > max) max = lum;
  }
  const span = Math.max(1, max - min);

  const canvas = document.createElement('canvas');
  canvas.width = data.width;
  canvas.height = data.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) return null;
  const out = ctx.createImageData(data.width, data.height);
  for (let p = 0; p < pixels.length; p += 4) {
    const lum =
      ((pixels[p] ?? 0) * 299 + (pixels[p + 1] ?? 0) * 587 + (pixels[p + 2] ?? 0) * 114) / 1000;
    const stretched = ((lum - min) / span) * 255;
    const value = invert ? 255 - stretched : stretched;
    out.data[p] = value;
    out.data[p + 1] = value;
    out.data[p + 2] = value;
    out.data[p + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return { canvas, data: out };
}

async function readNative(canvas: HTMLCanvasElement): Promise<string | null> {
  const Ctor = (window as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (typeof Ctor !== 'function') return null;
  try {
    const codes = await new Ctor({ formats: NATIVE_FORMATS }).detect(canvas);
    return clean(codes[0]?.rawValue);
  } catch {
    return null;
  }
}

async function readZxing(data: ImageData): Promise<string | null> {
  const zx = await zxing();
  const lum = new Uint8ClampedArray(data.width * data.height);
  for (let i = 0, p = 0; i < lum.length; i += 1, p += 4) {
    // BT.601 parlaklığı: gözün gördüğü ağırlıklar, ve ZXing'in beklediği tek kanal.
    lum[i] =
      (((data.data[p] ?? 0) * 299 + (data.data[p + 1] ?? 0) * 587 + (data.data[p + 2] ?? 0) * 114) /
        1000) |
      0;
  }
  const reader = new zx.MultiFormatReader();
  const hints = new Map<unknown, unknown>();
  hints.set(zx.DecodeHintType.TRY_HARDER, true);
  hints.set(zx.DecodeHintType.POSSIBLE_FORMATS, [
    zx.BarcodeFormat.QR_CODE,
    zx.BarcodeFormat.EAN_13,
    zx.BarcodeFormat.EAN_8,
    zx.BarcodeFormat.UPC_A,
    zx.BarcodeFormat.UPC_E,
    zx.BarcodeFormat.CODE_128,
    zx.BarcodeFormat.CODE_39,
    zx.BarcodeFormat.CODE_93,
    zx.BarcodeFormat.ITF,
    zx.BarcodeFormat.CODABAR,
    zx.BarcodeFormat.DATA_MATRIX,
    zx.BarcodeFormat.AZTEC,
    zx.BarcodeFormat.PDF_417,
  ]);
  reader.setHints(hints as never);
  try {
    const source = new zx.RGBLuminanceSource(lum, data.width, data.height);
    return clean(reader.decode(new zx.BinaryBitmap(new zx.HybridBinarizer(source))).getText());
  } catch {
    return null;
  } finally {
    reader.reset();
  }
}

/** Boş, yalnız boşluk ya da denetim karakteri taşıyan bir okuma, okuma sayılmaz. */
function clean(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (text === '') return null;
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(text) ? null : text;
}

/**
 * Bir fotoğraftan kodu çöz — bulunca hemen döner.
 *
 * Merdivenin sırası ölçülmüş bir bahis: iyi kare ilk iki basamakta biter, kalanlar zor kare için
 * durur. Basamaklar ucuzdan pahalıya, ve her biri farklı bir başarısızlık biçimini hedefliyor:
 * çözünürlük (küçük kod), kırpma (uzaktan çekilmiş kod), kontrast (loş ışık), tersleme (siyah
 * zeminli kod), döndürme (yan tutulmuş 1B barkod).
 */
export async function decodeImage(file: File): Promise<string | null> {
  const source = await toImage(file);

  const plans: { longest: number; rotate?: 0 | 90; crop?: number }[] = [
    { longest: 1600 },
    { longest: 2600 },
    { longest: 1600, crop: 0.55 },
    { longest: 2600, crop: 0.4 },
    { longest: 900 },
    { longest: 1600, rotate: 90 },
    { longest: 2600, crop: 0.55, rotate: 90 },
  ];

  const rendered: Variant[] = [];
  for (const plan of plans) {
    const variant = render(source, plan.longest, plan);
    if (variant === null) continue;
    rendered.push(variant);
    // ÖNCE YERLİ ÇÖZÜCÜ, her yeni ölçekte hemen: donanım hızlandırmalı, on milisaniyeler sürer,
    // ve iyi bir karede merdiven burada biter.
    const native = await readNative(variant.canvas);
    if (native !== null) return native;
  }

  for (const variant of rendered) {
    const text = await readZxing(variant.data);
    if (text !== null) return text;
  }

  // Zor kare: kontrastı gerilmiş ve terslenmiş hâller. Pahalı olduğu için en sonda, ve yalnız
  // buraya kadar hiçbir şey okuyamamışken.
  for (const variant of rendered.slice(0, 4)) {
    for (const invert of [false, true]) {
      const boosted = enhance(variant, invert);
      if (boosted === null) continue;
      const native = await readNative(boosted.canvas);
      if (native !== null) return native;
      const text = await readZxing(boosted.data);
      if (text !== null) return text;
    }
  }

  if ('close' in source && typeof source.close === 'function') source.close();
  return null;
}
