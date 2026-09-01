/**
 * Bir kullanıcı aracısından cihazın NE OLDUĞUNU okur.
 *
 * ── NEDEN BURADA ────────────────────────────────────────────────────────────────────────────
 *
 * Uzak erişim listesinde her satır on onaltılık hanelik bir ZeroTier adresiydi, ve `8a4f2c9b01`
 * bir insanın "bu benim telefonum" diyebileceği bir şey değil. ZeroTier'ın üye kaydında işletim
 * sistemi ya da model diye bir alan yok — taşıdığı şey adres, yetki ve atanmış IP'ler. Bunu bilen
 * tek taraf, o cihazın DEPSIS'e girerken kendini tanıttığı tarayıcı.
 *
 * ── NE KADAR AYRINTI ────────────────────────────────────────────────────────────────────────
 *
 * Sürüm numaraları YOK, ve olmaması bilerek: "Windows PC" bir insanın listede aradığı şey,
 * "Windows NT 10.0; Win64; x64" değil. Android'de model kodu TUTULUYOR (`SM-S926B`) çünkü orada
 * ayırt edici olan tek şey o — bir evde üç Android telefon olabilir, ve üçü de "Android" yazsaydı
 * liste hiçbir şey söylemezdi.
 *
 * Model kodunu pazarlama adına ("Galaxy S24+") çevirmek KASITLI OLARAK yapılmıyor. Böyle bir tablo
 * her yeni telefonla eskiyor, ve eskidiğinde yanlış ad göstermek hiç ad göstermemekten kötü.
 *
 * ── KULLANICI ARACISI GÜVENİLİR Mİ ──────────────────────────────────────────────────────────
 *
 * Hayır, ve buna güvenilmiyor da: bu değer hiçbir yetki kararına girmiyor. İşi listede bir satırı
 * insanın tanıyabileceği hâle getirmek. Yalan söyleyen bir tarayıcı, kendi satırına yanlış bir ad
 * yazdırmış olur — sahibinin zaten elle değiştirebildiği bir adı.
 */

/** Ekranda gösterilecek en uzun ad. Sütun bunu sığdırıyor; sütunun taşması, adın kendisinden kötü. */
const MAX = 80;

/**
 * Android'in kullanıcı aracısındaki model kodu.
 *
 * `Linux; Android 14; SM-S926B` — üçüncü alan model. `Build/…` eki bazı cihazlarda modelin peşine
 * yapışıyor ve atılıyor. `wv` (WebView) da bir model değil, bir uygulama içi tarayıcı işareti.
 */
function androidModel(ua: string): string | null {
  const match = /Android\s[\d.]+;\s*([^);]+)/u.exec(ua);
  const raw = match?.[1]?.replace(/\sBuild\/.*$/u, '').trim();
  if (raw === undefined || raw === '' || raw === 'wv' || raw.toLowerCase() === 'k') return null;
  return raw;
}

/**
 * Kullanıcı aracısından okunabilen cihaz adı, ya da okunamadığını söyleyen `null`.
 *
 * `null` ve boş metin DEĞİL: "bu cihazın ne olduğunu bilmiyoruz" ile "adı yok" farklı iki şey, ve
 * ikincisi ekranda bir şey göstermemek için bir sebep, birincisi ise satırı olduğu gibi bırakmak
 * için — bilinmeyen bir değer, bilinen bir değerin üstüne YAZILMAMALI.
 */
export function deviceNameFrom(userAgent: string | null | undefined): string | null {
  if (userAgent === null || userAgent === undefined) return null;
  const ua = userAgent.trim();
  if (ua === '') return null;

  // Sıra önemli ve tek bir kuralı var: DAHA ÖZEL OLAN ÖNCE. Android'in kullanıcı aracısı `Linux`
  // da içeriyor, iPad'inki (masaüstü modunda) `Macintosh` da — genel olanı önce sorsaydık, her
  // telefon "Linux PC" olurdu.
  if (/Android/u.test(ua)) {
    const model = androidModel(ua);
    return (model === null ? 'Android' : `Android · ${model}`).slice(0, MAX);
  }
  if (/iPhone/u.test(ua)) return 'iPhone';
  if (/iPad/u.test(ua)) return 'iPad';
  // iPadOS masaüstü modunda kendini Macintosh olarak tanıtıyor ve dokunmatik noktalarıyla ele
  // veriyor. Ayırt edilemediğinde "Mac" demek yanlış değil; ikisi de aynı ailenin cihazı.
  if (/Macintosh|Mac OS X/u.test(ua)) return 'Mac';
  if (/Windows NT/u.test(ua)) return 'Windows PC';
  if (/CrOS/u.test(ua)) return 'Chromebook';
  if (/Linux/u.test(ua)) return 'Linux PC';
  return null;
}
