import { describe, expect, it } from 'vitest';

import { embeddedThumbnail } from './exif-thumbnail.js';

/**
 * Gömülü küçük resim ayrıştırıcısı.
 *
 * BU DOSYANIN TAMAMI GÜVENİLMEYEN BAYT ÜZERİNDE ÇALIŞAN KODU ÖLÇÜYOR, ve testlerin çoğu "doğru
 * çıkarıyor mu" değil "bozuk girdide ATIYOR MU" sorusunu soruyor. Bir ayrıştırıcının burada
 * verebileceği iki cevap var: bir küçük resim, ya da `null`. Üçüncü bir cevap — bir istisna — bir
 * 500 demek, ve kullanıcının yüklediği herhangi bir dosyanın sunucuya 500 verdirebilmesi, bir
 * dosya yöneticisinin taşıyamayacağı bir şey.
 *
 * O yüzden aşağıdaki kesme testleri tek tek değil, HER UZUNLUKTA kesilerek yapılıyor: elle seçilmiş
 * üç kesme noktası, ayrıştırıcının atladığı dördüncüyü bulmaz.
 */

/** İki baytlık big-endian. */
function u16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value);
  return b;
}

/** Küçük resim olarak gömülecek en küçük geçerli JPEG: SOI + EOI. */
const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

/**
 * EXIF taşıyan bir JPEG'in başlangıcını kur.
 *
 * Gerçek bir fotoğraf yerine elle kurulmuş bir dosya, çünkü ölçülen şey ayrıştırıcının SINIR
 * davranışı ve bir örnek fotoğraf onu ancak tek bir noktada yoklardı.
 */
function jpegWithExif(
  options: {
    orientation?: number;
    thumbnail?: Buffer | null;
    /** IFD1'i hiç yazma — küçük resmi olmayan bir fotoğraf. */
    noIfd1?: boolean;
    /** Küçük resim uzunluğunu bilerek yalan söyle. */
    lengthOverride?: number;
    /** Küçük resim ofsetini bilerek yalan söyle. */
    offsetOverride?: number;
    big?: boolean;
  } = {},
): Buffer {
  const {
    orientation = 1,
    thumbnail = TINY_JPEG,
    noIfd1 = false,
    lengthOverride,
    offsetOverride,
    big = false,
  } = options;

  const w16 = (v: number): Buffer => {
    const b = Buffer.alloc(2);
    if (big) b.writeUInt16BE(v);
    else b.writeUInt16LE(v);
    return b;
  };
  const w32 = (v: number): Buffer => {
    const b = Buffer.alloc(4);
    if (big) b.writeUInt32BE(v);
    else b.writeUInt32LE(v);
    return b;
  };
  const entry = (tag: number, type: number, value: number): Buffer =>
    Buffer.concat([w16(tag), w16(type), w32(1), w32(value)]);

  // TIFF: başlık 8 bayt, sonra IFD0, sonra IFD1, sonra küçük resmin baytları.
  const ifd0At = 8;
  const ifd0 = Buffer.concat([w16(1), entry(0x0112, 3, orientation)]);
  const ifd1At = ifd0At + ifd0.length + 4;

  const ifd1Entries = noIfd1 ? [] : [0x0201, 0x0202];
  const thumbAt = ifd1At + 2 + ifd1Entries.length * 12 + 4;
  const body = thumbnail ?? Buffer.alloc(0);

  const ifd1 = noIfd1
    ? Buffer.alloc(0)
    : Buffer.concat([
        w16(2),
        entry(0x0201, 4, offsetOverride ?? thumbAt),
        entry(0x0202, 4, lengthOverride ?? body.length),
      ]);

  const tiff = Buffer.concat([
    Buffer.from(big ? 'MM' : 'II', 'latin1'),
    w16(0x2a),
    w32(ifd0At),
    ifd0,
    w32(noIfd1 ? 0 : ifd1At),
    ifd1,
    noIfd1 ? Buffer.alloc(0) : w32(0),
    body,
  ]);

  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe1]),
    u16(app1.length + 2),
    app1,
  ]);
}

describe('the embedded thumbnail reader', () => {
  it('pulls the thumbnail out of a little-endian JPEG', () => {
    const found = embeddedThumbnail(jpegWithExif());
    expect(found?.bytes).toEqual(TINY_JPEG);
    expect(found?.orientation).toBe(1);
  });

  it('reads a big-endian file the same way', () => {
    // "MM" — Motorola sıralaması. Canon ve Nikon bunu kullanıyor, ve bayt sırasını sabit varsayan
    // bir okuyucu o dosyalarda sessizce boş dönerdi.
    const found = embeddedThumbnail(jpegWithExif({ big: true }));
    expect(found?.bytes).toEqual(TINY_JPEG);
  });

  it('carries the orientation through without touching the pixels', () => {
    // 6 = 90° saat yönünde. Döndürmeyi burada yapmıyoruz; sayıyı taşımak, dönmeyi istemciye bir
    // CSS dönüşümü olarak bırakmayı mümkün kılıyor.
    expect(embeddedThumbnail(jpegWithExif({ orientation: 6 }))?.orientation).toBe(6);
  });

  it('falls back to 1 for an orientation outside the standard range', () => {
    expect(embeddedThumbnail(jpegWithExif({ orientation: 99 }))?.orientation).toBe(1);
  });

  it('says no when the file has EXIF but no thumbnail', () => {
    // Ekran görüntülerinin ve düzenlenmiş fotoğrafların çoğu böyle: EXIF var, IFD1 yok.
    expect(embeddedThumbnail(jpegWithExif({ noIfd1: true }))).toBeNull();
  });

  it('says no for something that is not a JPEG at all', () => {
    expect(embeddedThumbnail(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'))).toBeNull();
    expect(embeddedThumbnail(Buffer.alloc(0))).toBeNull();
    expect(embeddedThumbnail(Buffer.from('düz metin', 'utf8'))).toBeNull();
  });

  it('refuses a thumbnail whose offset points outside the data', () => {
    // Uzunluk ve ofset DOSYANIN İÇİNDEN geliyor, yani ikisi de saldırganın elinde. Sınır kontrolü
    // olmasaydı bu bir okuma taşması olurdu.
    expect(embeddedThumbnail(jpegWithExif({ offsetOverride: 0x7fffffff }))).toBeNull();
    expect(embeddedThumbnail(jpegWithExif({ lengthOverride: 0x7fffffff }))).toBeNull();
  });

  it('refuses a thumbnail that is not itself a JPEG', () => {
    // Ofset dosyanın içindeki başka bir yeri gösteriyor. Çağıran o dosyayı zaten indirebiliyor —
    // yani sızıntı değil — ama rastgele baytları `image/jpeg` diye etiketlemek, cevabın yalan
    // söylemesi olurdu.
    const bogus = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    expect(embeddedThumbnail(jpegWithExif({ thumbnail: bogus }))).toBeNull();
  });

  it('refuses a thumbnail larger than any real one', () => {
    expect(embeddedThumbnail(jpegWithExif({ lengthOverride: 512 * 1024 }))).toBeNull();
  });

  it('never throws, at any truncation of a valid file', () => {
    // HER uzunlukta. Elle seçilmiş üç kesme noktası, ayrıştırıcının atladığı dördüncüyü bulmaz —
    // ve buradaki soru "doğru cevap veriyor mu" değil, "bir 500 üretebilir mi".
    const whole = jpegWithExif();
    for (let n = 0; n <= whole.length; n += 1) {
      expect(() => embeddedThumbnail(whole.subarray(0, n))).not.toThrow();
    }
    // Ve tamamı hâlâ çalışıyor: kesme testi, ayrıştırıcıyı hep null döndürerek geçirilemez.
    expect(embeddedThumbnail(whole)).not.toBeNull();
  });

  it('never throws on a file whose every byte has been corrupted in turn', () => {
    const whole = jpegWithExif();
    for (let at = 0; at < whole.length; at += 1) {
      for (const value of [0x00, 0xff, 0x7f]) {
        const broken = Buffer.from(whole);
        broken[at] = value;
        expect(() => embeddedThumbnail(broken)).not.toThrow();
      }
    }
  });

  it('does not loop forever on a marker that claims a zero length', () => {
    // `length < 2` kontrolü olmasaydı, `at` ilerlemez ve döngü hiç bitmezdi — bir dosya
    // yükleyerek bir iş parçacığını sonsuza kadar meşgul etmenin yolu.
    const stuck = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x00, 0x00, 0x00]);
    expect(embeddedThumbnail(stuck)).toBeNull();
  });

  it('skips a marker that is not APP1 and keeps looking', () => {
    const exif = jpegWithExif();
    // Önce bir APP0 (JFIF) — neredeyse her JPEG'de var, ve onu atlamayan bir okuyucu hiçbir
    // gerçek dosyada EXIF bulamazdı.
    const app0 = Buffer.concat([
      Buffer.from([0xff, 0xe0]),
      u16(16),
      Buffer.from('JFIF\0', 'latin1'),
      Buffer.alloc(9),
    ]);
    const withApp0 = Buffer.concat([exif.subarray(0, 2), app0, exif.subarray(2)]);
    expect(embeddedThumbnail(withApp0)?.bytes).toEqual(TINY_JPEG);
  });

  it('stops at the start of scan data instead of walking into pixels', () => {
    const exif = jpegWithExif({ noIfd1: true });
    const sos = Buffer.from([0xff, 0xda, 0x00, 0x0c]);
    const withScan = Buffer.concat([exif, sos, Buffer.alloc(4096, 0xff)]);
    expect(embeddedThumbnail(withScan)).toBeNull();
  });
});
