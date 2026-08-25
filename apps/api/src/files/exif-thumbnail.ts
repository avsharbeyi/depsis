/**
 * Bir JPEG'in İÇİNE GÖMÜLÜ küçük resmi çıkar — hiçbir şeyin kodunu ÇÖZMEDEN.
 *
 * NEDEN BÖYLE. Bir küçük resim üretmenin apaçık yolu, dosyayı çözüp yeniden boyutlandırmak. O yol
 * bu ürüne bir görüntü kütüphanesi sokuyor (`sharp`/libvips: onlarca megabayt yerel ikili ve
 * tarihsel olarak en verimli RCE yüzeylerinden biri), ve onu API sürecinin içine koyuyor — yani
 * güvenilmeyen kullanıcı baytlarını çözen bir kod, oturumları ve veritabanı bağlantısını tutan
 * sürecin içinde. Bir NAS'ın en çok yüklenen şeyi fotoğraf, yani o kod her gün güvenilmeyen veri
 * görecek.
 *
 * Telefon ve fotoğraf makinesi JPEG'leri küçük resmi ZATEN İÇİNDE taşıyor: EXIF'in IFD1 bölümünde,
 * tam bir JPEG olarak, tipik 160×120. Onu almak bayt dilimlemek — kodlanmış piksel verisine hiç
 * dokunulmuyor. Çıkan bayt dizisi tarayıcıya gidiyor ve ÇÖZÜM ORADA yapılıyor: tarayıcının görüntü
 * çözücüsü sandbox'lı, sürekli denetlenen ve bu iş için özel olarak sertleştirilmiş olan.
 *
 * Kapsamadığı şey ekran görüntüleri ve EXIF taşımayan resimler; onlar için istemci dosyayı indirip
 * kendi canvas'ında küçültüyor. İkisi birlikte, sunucuya tek bir görüntü kütüphanesi sokmadan
 * ızgarayı dolduruyor.
 *
 * HER OKUMA SINIR KONTROLLÜ. Bu dosyanın tamamı güvenilmeyen bayt üzerinde çalışıyor, ve
 * `readUInt16BE` gibi bir çağrının kendi başına atması bir 500 demek — o yüzden her erişim önce
 * uzunluğa bakıyor ve sınırın dışına çıkan her şey "küçük resim yok" cevabına dönüyor.
 */

/** Ne bulunduğu. `bytes` her zaman tam bir JPEG. */
export interface EmbeddedThumbnail {
  bytes: Buffer;
  /**
   * EXIF yönlendirmesi (1–8), ya da bilinmiyorsa 1.
   *
   * Gömülü küçük resim ana görüntüyle AYNI yönde saklanıyor, yani ana görüntü döndürülmesi
   * gerekiyorsa küçük resim de gerekiyor. Döndürmeyi burada YAPMIYORUZ — o, piksellere dokunmak
   * demek olurdu ve bu dosyanın var olma sebebi tam olarak ona dokunmamak. Sayı istemciye
   * gidiyor ve orada bir CSS dönüşümüne çevriliyor.
   */
  orientation: number;
}

/** JPEG işaretçileri. */
const SOI = 0xd8;
const APP1 = 0xe1;
const SOS = 0xda;

/**
 * Gerçek gömülü küçük resimler ~10 kB. 256 kB'ı aşan bir "küçük resim", ya bozuk bir dosya ya da
 * bu ucu bir indirme kanalına çevirmeye çalışan bir başlık — ikisinde de cevap yok.
 */
const MAX_THUMBNAIL = 256 * 1024;

/**
 * `buffer` bir JPEG'in BAŞLANGICI olabilir; tamamı olmak zorunda değil.
 *
 * EXIF, JPEG işaretçi uzunluğu 16 bit olduğu için en çok 64 kB ve SOI'den hemen sonra geliyor:
 * ilk 128 kB fazlasıyla yetiyor, ve çağıran zaten yalnız o kadarını okuyor.
 *
 * Bulamazsa `null` — ve bulamamak normal: PNG, ekran görüntüsü, EXIF'siz JPEG, hepsi buraya düşüyor.
 */
export function embeddedThumbnail(buffer: Buffer): EmbeddedThumbnail | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== SOI) return null;

  let at = 2;
  while (at + 4 <= buffer.length) {
    if (buffer[at] !== 0xff) return null;
    const marker = buffer[at + 1];
    if (marker === undefined) return null;
    // Dolgu baytları: bazı kodlayıcılar işaretçiden önce FF tekrarlıyor.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // Taranmış veri başladıysa metadata bitmiştir; buradan sonrası piksel ve biz oraya bakmıyoruz.
    if (marker === SOS) return null;

    const length = buffer.readUInt16BE(at + 2);
    // Uzunluk kendi iki baytını da sayıyor; 2'den küçük bir değer sonsuz döngü demek.
    if (length < 2) return null;
    const start = at + 4;
    const end = at + 2 + length;
    if (end > buffer.length) return null;

    if (marker === APP1 && buffer.subarray(start, start + 6).toString('latin1') === 'Exif\0\0') {
      return fromExif(buffer.subarray(start + 6, end));
    }
    at = end;
  }
  return null;
}

/** `tiff` bir TIFF başlığıyla başlıyor, ve bütün ofsetler ONA göre. */
function fromExif(tiff: Buffer): EmbeddedThumbnail | null {
  if (tiff.length < 8) return null;
  const order = tiff.subarray(0, 2).toString('latin1');
  if (order !== 'II' && order !== 'MM') return null;
  const little = order === 'II';

  const u16 = (at: number): number | null =>
    at + 2 > tiff.length ? null : little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at);
  const u32 = (at: number): number | null =>
    at + 4 > tiff.length ? null : little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at);

  if (u16(2) !== 0x2a) return null;
  const ifd0 = u32(4);
  if (ifd0 === null || ifd0 < 8) return null;

  const orientation = tagValue(tiff, ifd0, 0x0112, u16, u32) ?? 1;

  // IFD0'ın sonundaki ofset IFD1'i gösteriyor — küçük resmin bölümü. 0 ise küçük resim yok.
  const count0 = u16(ifd0);
  if (count0 === null) return null;
  const ifd1 = u32(ifd0 + 2 + count0 * 12);
  if (ifd1 === null || ifd1 === 0 || ifd1 < 8) return null;

  const offset = tagValue(tiff, ifd1, 0x0201, u16, u32);
  const length = tagValue(tiff, ifd1, 0x0202, u16, u32);
  if (offset === null || length === null) return null;
  if (length <= 0 || length > MAX_THUMBNAIL) return null;
  if (offset < 0 || offset + length > tiff.length) return null;

  const bytes = tiff.subarray(offset, offset + length);
  // SOI KONTROLÜ, ve bu bir incelik değil: ofset dosyanın içindeki HERHANGİ bir yeri gösterebilir,
  // ve onu doğrulamadan `image/jpeg` diye sunmak, rastgele baytları bir görüntü gibi etiketlemek
  // olurdu. Çağıran o dosyayı zaten indirebiliyor — yani sızıntı değil — ama bir cevabın söylediği
  // şey doğru olmalı.
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== SOI) return null;

  return {
    bytes: Buffer.from(bytes),
    orientation: orientation >= 1 && orientation <= 8 ? orientation : 1,
  };
}

/**
 * Bir IFD'de bir etiketi ara ve SAYISAL değerini döndür.
 *
 * Yalnız SHORT (3) ve LONG (4) okunuyor, ve yalnız tek değerli olanlar: aranan üç etiket
 * (yönlendirme, küçük resim ofseti, küçük resim uzunluğu) hepsi öyle. Daha genel bir okuyucu,
 * hiçbir çağıranın kullanmayacağı yollar açardı.
 */
function tagValue(
  tiff: Buffer,
  ifd: number,
  tag: number,
  u16: (at: number) => number | null,
  u32: (at: number) => number | null,
): number | null {
  const count = u16(ifd);
  if (count === null) return null;
  // Bir IFD'de binlerce girdi yok; büyük bir sayı bozuk ya da kasıtlı, ve ikisinde de taramaya
  // değmez. Sınır, dizinin gerçekten dosyanın içine sığmasıyla da doğrulanıyor.
  if (count > 4096) return null;
  if (ifd + 2 + count * 12 > tiff.length) return null;

  for (let i = 0; i < count; i += 1) {
    const at = ifd + 2 + i * 12;
    if (u16(at) !== tag) continue;
    const type = u16(at + 2);
    const values = u32(at + 4);
    if (values !== 1) return null;
    if (type === 3) return u16(at + 8);
    if (type === 4) return u32(at + 8);
    return null;
  }
  return null;
}
