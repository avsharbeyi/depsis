/**
 * Yarıda kalmış bir yüklemeyi bulmak: parmak izi ve not defteri.
 *
 * NEDEN TARAYICIDA. Sunucu `upload_sessions` satırını zaten tutuyor ve `/transfers` onu
 * gösteriyor, ama o satırdan hangi YEREL dosyanın devamı olduğu çıkarılamıyor: aynı klasöre aynı
 * adla ve aynı boyutta iki farklı dosya yüklemek tamamen olağan (bir belgeyi düzeltip yeniden
 * göndermek gibi), ve yanlış oturuma devam etmek iki dosyanın yarısını birbirine dikmek demek.
 * tus istemcilerinin standart cevabı da bu: parmak izi istemcide durur, çünkü `lastModified` yalnız
 * istemcide var.
 *
 * NE VAAT EDİLİYOR. Aynı tarayıcıda, aynı dosya yeniden seçilirse kaldığı yerden devam eder.
 * Başka bir tarayıcıda ya da temizlenmiş bir profilde devam etmez, ve arayüz de öyle diyor —
 * `Transfers.tsx` bir zamanlar koşulsuz "devam eder" yazıyordu ve hiçbir şey devam etmiyordu.
 */

/** Yükleme kimliklerinin durduğu yer. Tek anahtar: silmek isteyen tek satırla siliyor. */
const KEY = 'depsis.upload.resume';

/**
 * Notların ömrü.
 *
 * Sunucunun aktarım listesiyle aynı pencere (`TRANSFER_WINDOW_HOURS`), ve aynı olması gerekiyor:
 * daha uzun tutmak, listede artık görünmeyen bir oturuma devam etmeyi denemek demek — HEAD 404
 * döner, kullanıcı bir gecikme yer, sonuç yine sıfırdan yükleme olur.
 */
export const MEMO_TTL_MS = 24 * 60 * 60 * 1000;

export interface Memo {
  /** Sunucunun verdiği `Location`. Yeniden kurmak yerine saklanıyor: yol sözleşmenin işi. */
  location: string;
  /** Notun yazıldığı an, epoch milisaniye. */
  at: number;
}

export type Memos = Record<string, Memo>;

/**
 * Bir dosyayı bir hedef klasörde tekil kılan dize.
 *
 * `lastModified` ŞART. Ad ve boyut tek başına aynı klasördeki iki sürümü ayırt etmiyor, ve
 * ayırt edemediğinde bu modülün tamamı bir bozulma kaynağına dönüşüyor. Kök klasör `parentId`
 * taşımadığı için ayrı bir sözcükle yazılıyor; `undefined`'ın boş dizeye çevrilmesi, adı boş
 * olan bir klasörle karışırdı.
 */
export function fingerprint(
  file: { name: string; size: number; lastModified: number },
  parentId: string | undefined,
): string {
  return [parentId ?? 'root', file.size, file.lastModified, file.name].join('\u0000');
}

/** Bozuk ya da yabancı içeriğe karşı: ne bulursa bulsun, dönen şey bu modülün tipinde. */
export function parseMemos(raw: string | null): Memos {
  if (raw === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Memos = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { location, at } = entry as { location?: unknown; at?: unknown };
    if (typeof location !== 'string' || location === '') continue;
    if (typeof at !== 'number' || !Number.isFinite(at)) continue;
    out[key] = { location, at };
  }
  return out;
}

/** Süresi geçenleri atar. Saf: `now` dışarıdan gelir, böylece ölçülebilir. */
export function prune(memos: Memos, now: number): Memos {
  const out: Memos = {};
  for (const [key, memo] of Object.entries(memos)) {
    if (now - memo.at < MEMO_TTL_MS) out[key] = memo;
  }
  return out;
}

/**
 * HEAD'in söylediğine bakıp devam edilip edilmeyeceğine karar verir.
 *
 * `offset >= size` DEVAM DEĞİL, YENİDEN. Bayt sayısı dolmuş ama yayımlanmamış bir oturum gerçek
 * bir durum: `UploadsController.sendChunk` önce offset'i yazıyor, sonra yayımlıyor, ve yayım
 * yer yokluğundan (507) ya da ad çakışmasından (409) düşebiliyor. Böyle bir oturuma "devam"
 * etmek, tek bir bayt göndermeden "yüklendi" demek olurdu — dosya ortada yokken.
 */
export function resumeOffset(
  head: { status: number; offset: number | null; length: number | null },
  size: number,
): number | null {
  if (head.status !== 200) return null;
  if (head.length !== size) return null;
  if (head.offset === null || !Number.isSafeInteger(head.offset)) return null;
  if (head.offset <= 0 || head.offset >= size) return null;
  return head.offset;
}

/* ── depolama; tarayıcı yoksa ya da reddediyorsa sessizce devre dışı ────────── */

function read(): Memos {
  try {
    return prune(parseMemos(window.localStorage.getItem(KEY)), Date.now());
  } catch {
    return {};
  }
}

function write(memos: Memos): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(memos));
  } catch {
    // Gizli sekmede ya da kota dolu bir profilde yazma atıyor. Devam ettirme bir kolaylık;
    // olmaması yüklemeyi durdurmamalı.
  }
}

export function recallUpload(key: string): string | null {
  return read()[key]?.location ?? null;
}

export function rememberUpload(key: string, location: string): void {
  const memos = read();
  memos[key] = { location, at: Date.now() };
  write(memos);
}

export function forgetUpload(key: string): void {
  const memos = read();
  if (!(key in memos)) return;
  delete memos[key];
  write(memos);
}
