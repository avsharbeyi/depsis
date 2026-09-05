import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  MultiFormatWriter,
  RGBLuminanceSource,
} from '@zxing/library';
import { describe, expect, it } from 'vitest';

import { clean } from './scan.js';

/**
 * ZXing'in ADLARI hâlâ yerinde mi, ve çözücü gerçekten okuyor mu.
 *
 * Bu testin var olma sebebi somut: paketin CommonJS yapısı bu adları dışa AÇMIYOR — orada hepsi
 * `default` altında duruyor — ve tarayıcı yapısı açıyor. İki yapıdan yanlış olanına düşen bir
 * derleme, `new MultiFormatReader()` satırında bir TypeError'a dönüşür ve QR düğmesi HER karede,
 * ne kadar net olursa olsun, "kod okunamadı" der. Bir tip hatası bunu göstermez, çünkü tipler
 * doğrudur; yalnız çalışma zamanı yanlıştır.
 *
 * Kodu kütüphanenin KENDİ yazıcısı üretiyor: dosyaya gömülü bir PNG, bir gün neden düştüğü
 * anlaşılmayan bir ikili yığın olurdu.
 */
describe('kod çözücünün kablolaması', () => {
  it('kendi ürettiği QR kodunu okuyor', () => {
    const text = 'URN578493';
    const matrix = new MultiFormatWriter().encode(text, BarcodeFormat.QR_CODE, 300, 300, new Map());
    const width = matrix.getWidth();
    const height = matrix.getHeight();
    const luminance = new Uint8ClampedArray(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) luminance[y * width + x] = matrix.get(x, y) ? 0 : 255;
    }

    const reader = new MultiFormatReader();
    const hints = new Map<unknown, unknown>();
    hints.set(DecodeHintType.TRY_HARDER, true);
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
    reader.setHints(hints as never);
    const source = new RGBLuminanceSource(luminance, width, height);

    expect(reader.decode(new BinaryBitmap(new HybridBinarizer(source))).getText()).toBe(text);
  });
});

describe('okunan metnin temizlenmesi', () => {
  it('GS1 ayırıcısını AYIKLIYOR, okumayı çöpe atmıyor', () => {
    // Eskiden bu okuma büsbütün atılıyordu ve kullanıcı "kod okunamadı" görüyordu — oysa kod
    // okunmuştu. GS1 alanlarını U+001D ile ayırır ve bu, geçerli bir yükün olağan hâli.
    expect(clean('0105901234123457\u001D10ABC123')).toBe('0105901234123457 10ABC123');
  });

  it('boş ve yalnız denetim karakterinden ibaret okumayı reddediyor', () => {
    expect(clean('   ')).toBeNull();
    expect(clean('\u0000\u0001')).toBeNull();
    expect(clean(undefined)).toBeNull();
  });

  it('sıradan bir kodu olduğu gibi bırakıyor', () => {
    expect(clean('  URN578493 ')).toBe('URN578493');
  });
});
