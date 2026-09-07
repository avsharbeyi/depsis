/**
 * Bir dosyanın karesi: gömülü küçük resim, yoksa tarayıcıda küçültülmüş gerçek dosya.
 *
 * ── NEDEN BU DOSYA VAR ──────────────────────────────────────────────────────────────────────
 *
 * Uç yalnız JPEG'in EXIF'ine GÖMÜLÜ küçük resmi çıkarıyor; sunucu hiçbir görüntünün kodunu
 * çözmüyor ve bu bilerek böyle (`thumbnails.service.ts`). Sahada ölçülen şey şu: sahibinin
 * telefondan gelen fotoğraflarının hiçbirinde gömülü küçük resim yok — mesajlaşma ve galeri
 * uygulamaları yeniden kodlarken onu atıyor. Cihazın kaydında bunun karşılığı tek bir turda 244
 * tane 204, yani bir fotoğraf klasörünün tamamı boş simge.
 *
 * Yani özellik "var ama çalışmıyor"du. Doğru cevap kod çözmeyi SUNUCUYA taşımak değil — o,
 * ayrıcalıklı tarafa bir görüntü çözücü koymak demek. Kodu zaten çözen, kum havuzunda koşan ve
 * bu iş için sertleştirilmiş bir çözücü var: tarayıcının kendisi. Dosya bir kez indiriliyor, bir
 * kez küçültülüyor ve sonucu saklanıyor.
 */

import { API_BASE_URL } from './api.js';

/** Kodu çözülecek en büyük dosya. Telefon fotoğrafları 0,1–3 MB; bu onların çok üstünde. */
export const DECODE_LIMIT = 8 * 1024 * 1024;

/** Üretilen karenin uzun kenarı. Izgara 96–160 piksel çiziyor; 320 retina için iki katı. */
const EDGE = 320;

/**
 * Aynı anda kaç GÖMÜLÜ küçük resim isteniyor.
 *
 * ── SAHADA ÖLÇÜLDÜ ──────────────────────────────────────────────────────────────────────────
 *
 * Her satır kendi karesini bağımsız istiyordu, ve iki yüz satırlık bir klasör iki yüz eşzamanlı
 * istek demekti. Her biri ajanda bir çağrı; ajanın kuyruğu 32'de dolu, ve dolduktan sonra AJANA
 * GİDEN HER ŞEY reddediliyor — listeleme, yükleme, indirme. Günlükteki karşılığı tek bir turda
 * 18 tane "32 calls are already queued" ve 181 tane hız sınırı reddiydi.
 *
 * Kullanıcının gördüğü şey: "50 tane dosya seçtim, 4-5 dakika beklemem gerekiyor indir butonu
 * çalışsın diye." Ekran donmuş değildi; sırada bekliyordu.
 */
const HEAD_AT_ONCE = 4;

/**
 * Aynı anda kaç TAM DOSYA indirilip küçültülüyor.
 *
 * Gömülü olandan daha dar, çünkü maliyeti başka ölçekte: gömülü küçük resim 128 kB'lık bir okuma,
 * bu ise dosyanın tamamı. İki, bir klasörü gezerken ağda ve bellekte fotoğraf açmaya ya da dosya
 * yüklemeye yer kalsın diye.
 */
const DECODE_AT_ONCE = 2;

/** Basit bir eşzamanlılık sayacı: sıraya giren işler, boşalan yeri sıradaki alıyor. */
function limiter(most: number): () => Promise<() => void> {
  const waiting: (() => void)[] = [];
  let running = 0;
  return () =>
    new Promise((resolve) => {
      const start = (): void => {
        running += 1;
        resolve(() => {
          running -= 1;
          waiting.shift()?.();
        });
      };
      if (running < most) start();
      else waiting.push(start);
    });
}

const headSlot = limiter(HEAD_AT_ONCE);
const decodeSlot = limiter(DECODE_AT_ONCE);

/**
 * Üretilen kareler tarayıcının kendi önbelleğinde.
 *
 * `Cache API`, `localStorage` DEĞİL: saklanan şey ikili veri ve beş megabaytlık bir metin kotasına
 * sığmaz. Tarayıcı yer sıkışınca kendisi atıyor, yani ayrı bir temizleme işine gerek yok.
 *
 * Anahtar satırın KİMLİĞİ + BOYUTU + DEĞİŞME ZAMANI: dosya ağdan değişince anahtar da değişiyor,
 * yani eski kare yeni dosyanın karesi olarak asla gösterilmiyor.
 */
const CACHE = 'depsis-thumbs-v1';

function cacheKey(id: string, size: number, modifiedAt: string): string {
  return `https://depsis.invalid/thumb/${id}/${size}/${encodeURIComponent(modifiedAt)}`;
}

/**
 * Önbellekten kare. Önbellek yoksa (güvensiz bağlam, kapatılmış depolama) sessizce `null`.
 *
 * Hiçbir hâlde ATMIYOR: bir önbellek arızası, karenin hiç gelmemesine yol açmamalı.
 */
async function cached(key: string): Promise<Blob | null> {
  try {
    if (typeof caches === 'undefined') return null;
    const store = await caches.open(CACHE);
    const hit = await store.match(key);
    return hit === undefined ? null : await hit.blob();
  } catch {
    return null;
  }
}

async function remember(key: string, blob: Blob): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    const store = await caches.open(CACHE);
    await store.put(key, new Response(blob, { headers: { 'content-type': blob.type } }));
  } catch {
    // Kota dolmuş ya da depolama kapalı. Kare yine gösteriliyor, yalnız bir dahakine yeniden
    // üretiliyor.
  }
}

/** EXIF yönlendirmesinin (1–8) CSS karşılığı. */
export const ORIENTATION: Record<string, string> = {
  '1': '',
  '2': 'scaleX(-1)',
  '3': 'rotate(180deg)',
  '4': 'scaleY(-1)',
  '5': 'rotate(90deg) scaleX(-1)',
  '6': 'rotate(90deg)',
  '7': 'rotate(270deg) scaleX(-1)',
  '8': 'rotate(270deg)',
};

export type Preview = {
  /** `URL.createObjectURL` sonucu; çağıran onu bırakmakla yükümlü. */
  url: string;
  /** Yalnız gömülü küçük resimde: uç pikselleri çevirmiyor, dönüş CSS'te. */
  spin: string | undefined;
};

/** Karesi gömülü olarak gelebilecek tek tür. */
export const EMBEDDED = new Set(['jpg', 'jpeg']);

/** Tarayıcının kodunu çözebildiği yaygın türler. */
const DECODABLE = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif']);

export function suffixOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Bu satırın bir karesi olabilir mi — hiç denemeye değer mi. */
export function couldHavePreview(name: string, size: number): boolean {
  const suffix = suffixOf(name);
  return EMBEDDED.has(suffix) || (DECODABLE.has(suffix) && size <= DECODE_LIMIT);
}

/**
 * Bir satırın karesi, üç yoldan biriyle.
 *
 * Sıra önemli ve ölçülmüş bir sebeple böyle:
 *
 * 1. **Önbellek.** Ağa ve ajana hiç gidilmiyor.
 * 2. **Gömülü küçük resim** (yalnız JPEG). 128 kB'lık bir okuma, kod çözme yok.
 * 3. **Tam dosya.** Ancak 2 boş döndüyse ve dosya sınırın altındaysa. Pahalı olan yol en sonda.
 *
 * `null` = kare yok; çağıran simgede kalıyor. ATMIYOR: bir karenin gelmemesi dosya yöneticisinin
 * sorunu değil.
 */
export async function previewOf(
  entry: { id: string; name: string; size: number; modifiedAt: string },
  signal: AbortSignal,
): Promise<Preview | null> {
  const key = cacheKey(entry.id, entry.size, entry.modifiedAt);
  const known = await cached(key);
  if (known !== null) return { url: URL.createObjectURL(known), spin: undefined };
  if (signal.aborted) return null;

  const suffix = suffixOf(entry.name);
  if (EMBEDDED.has(suffix)) {
    const release = await headSlot();
    let embedded: Preview | null = null;
    try {
      if (signal.aborted) return null;
      const answer = await fetch(`${API_BASE_URL}/files/${entry.id}/thumbnail`, {
        credentials: 'same-origin',
        signal,
      });
      if (answer.status === 200) {
        const blob = await answer.blob();
        if (signal.aborted) return null;
        // Gömülü olan SAKLANMIYOR: zaten küçük, ve ikinci istek sunucunun kendi belleğindeki
        // önbellekten geliyor. Saklanması gereken, üretilmesi pahalı olan.
        embedded = {
          url: URL.createObjectURL(blob),
          spin: ORIENTATION[answer.headers.get('x-depsis-orientation') ?? '1'],
        };
      }
      // 204 = gömülü küçük resmi yok, 503 = ajan meşgul. İkisinde de aşağıdaki yola düşülüyor.
    } catch {
      return null;
    } finally {
      release();
    }
    if (embedded !== null) return embedded;
  }

  if (!DECODABLE.has(suffix) || entry.size > DECODE_LIMIT) return null;
  if (signal.aborted) return null;

  const release = await decodeSlot();
  try {
    if (signal.aborted) return null;
    const answer = await fetch(`${API_BASE_URL}/files/${entry.id}/content`, {
      credentials: 'same-origin',
      signal,
    });
    if (!answer.ok) return null;
    const full = await answer.blob();
    if (signal.aborted) return null;
    const small = await shrink(full);
    if (small === null || signal.aborted) return null;
    await remember(key, small);
    return { url: URL.createObjectURL(small), spin: undefined };
  } catch {
    return null;
  } finally {
    release();
  }
}

/**
 * Bir görüntüyü `EDGE` piksele küçültür.
 *
 * `imageOrientation: 'from-image'`: EXIF'te yan yatmış bir fotoğraf DÖNDÜRÜLMÜŞ olarak çözülüyor,
 * yani üretilen karenin ayrıca CSS ile çevrilmesi gerekmiyor — gömülü yolun `spin` alanının bu
 * yolda boş olmasının sebebi bu.
 *
 * Ortam yoksa (`createImageBitmap` ya da tuval olmayan bir çalıştırma) `null`: kare gelmiyor, ama
 * hiçbir şey patlamıyor.
 */
async function shrink(blob: Blob): Promise<Blob | null> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    // Bozuk ya da tarayıcının çözemediği bir görüntü.
    return null;
  }
  try {
    const scale = Math.min(1, EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context === null) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((made) => resolve(made), 'image/jpeg', 0.72);
    });
  } finally {
    // Bitmap'i bırakmak ZORUNLU: her biri kod çözülmüş tam boy piksel tutuyor, ve altı yüz
    // fotoğraflık bir albümde bırakılmayanlar sekmeyi düşürür.
    bitmap.close();
  }
}
