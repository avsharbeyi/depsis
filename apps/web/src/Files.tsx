import type { Prefs } from './prefs.js';
import type { OpenApi } from '@depsis/contracts';
import { Fragment, useEffect, useRef, useState } from 'react';

import { api, API_BASE_URL, problemMessage } from './api.js';
import { History } from './History.js';
import { decodeImage, warmScanner } from './scan.js';
import { formatBytes } from './Dashboard.js';
import type { Tone } from './ui.js';
import { Bar, ConfirmBox, Empty, FolderPicker, PromptBox, TONES, toneRgb, Win } from './ui.js';
import { Permissions, type PermissionTarget } from './Permissions.js';
import { fingerprint, forgetUpload, recallUpload, rememberUpload, resumeOffset } from './resume.js';
import { TrashPolicyBar } from './TrashPolicy.js';

type FileEntry = OpenApi.components['schemas']['FileEntry'];
type FileEntryPage = OpenApi.components['schemas']['FileEntryPage'];

interface Props {
  notify: (kind: 'ok' | 'error', text: string) => void;
  /** Only an administrator may change the bin's retention policy, so only they are offered it. */
  isAdmin: boolean;
  /** The optional note replaces the default sign-out sentence. A batch cut off by an expired
   *  session reports what it already did there, because this screen unmounts with the desk. */
  onUnauthenticated: (note?: string) => void;
  /**
   * Kullanıcının kendi tercihleri — burada yalnız favori klasörler için.
   *
   * İsteğe bağlı: bu ekran kurulum sihirbazında ve tercihler okunmadan da çiziliyor, ve favorisi
   * olmayan bir şerit çalışan bir şerittir. Verilmediğinde yıldız düğmeleri hiç görünmüyor —
   * kaydedilemeyecek bir işi teklif etmemek, teklif edip sonra düşmekten iyidir.
   */
  prefs?: Prefs | undefined;
  savePrefs?: ((next: Prefs) => Promise<boolean>) | undefined;
  /**
   * Öğe sayısı, çizen kabın kullanabilmesi için.
   *
   * Mobilde kartın başlığında ("Dosyalar") görünüyor: tam ekranda alt çubuk ekranın epey altında
   * kalıyor ve sahibi sayıyı orada arıyor. İsteğe bağlı — masaüstünde kimse dinlemiyor ve sayı
   * zaten alt çubukta duruyor.
   */
  onMeta?: ((meta: string) => void) | undefined;
}

/** A step in the trail. Navigation is by id — never by a path string — because that is what the
 *  server resolves against (ADR-0005); a client walking by name would be asking about a different
 *  row than the one it drew the moment anything above it is renamed. */
interface Crumb {
  id: string;
  name: string;
}

/** Where the manager is looking. The trash is a column on the row, not a folder, so it cannot be
 *  a crumb — it is a flag beside the trail. */
interface Loc {
  trashed: boolean;
  trail: Crumb[];
}

const ROOT: Loc = { trashed: false, trail: [] };

/**
 * Klasör satırının sağındaki cümle: kaç öğe ve ne kadar yer.
 *
 * İKİSİ BİRDEN, çünkü ikisi farklı sorulara cevap. "37 öğe" klasörün ne olduğunu söylüyor;
 * "2,4 GB" onu silmenin ne kazandıracağını. Boş bir klasörde boyut yazmıyor — sıfır bayt zaten
 * "boş" kelimesinin içinde.
 *
 * Sayım bin ile sınırlı, o yüzden bin gören "1000+" yazıyor. Boyut sınırsız: tek bir aralık
 * sorgusu ve kullanıcının aradığı sayı tam olarak o.
 */
function folderMeta(entry: FileEntry): string {
  if (entry.childCount === undefined) return '—';
  if (entry.childCount === 0) return 'boş';
  const count = `${entry.childCount}${entry.childCount >= 1000 ? '+' : ''} öğe`;
  if (entry.subtreeBytes === undefined || entry.subtreeBytes === 0) return count;
  return `${count} · ${formatBytes(entry.subtreeBytes)}`;
}

/** Favori şeridinde görünen ad: yalnız ilk yedi harf, gerekiyorsa kısaltma işaretiyle. */
function shortName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length <= 7 ? trimmed : `${trimmed.slice(0, 7)}…`;
}

/**
 * `POST /files/folders` gövdesi.
 *
 * TEK YERDE, çünkü bu kural iki yerde ayrı ayrı yazılmıştı ve biri yanlıştı: yükleme yolundaki
 * `ensureFolder` seçili paylaşımı gönderiyor, "+ Klasör" düğmesi göndermiyordu. Sunucu `shareId`
 * gelmeyince kiracının VARSAYILAN paylaşımını seçiyor — yani "Arşiv" seçiliyken kökte açılan bir
 * klasör başka bir paylaşımda açılıyor, ekran "oluşturuldu" diyor ve klasör listede görünmüyordu.
 *
 * `shareId` YALNIZ ÜST DÜZEY bir klasörde: bir üst klasör varsa paylaşımı zaten o belirliyor ve
 * sözleşme aynı soruyu iki kez cevaplamayı kabul etmiyor.
 */
export function folderBody(
  name: string,
  parentId: string | undefined,
  shareId: string | undefined,
): OpenApi.components['schemas']['CreateFolderRequest'] {
  if (parentId !== undefined) return { name, parentId };
  return shareId === undefined ? { name } : { name, shareId };
}

/**
 * Sunucunun ad tekliği için kullandığı katlama (`public.fold_identity`), JavaScript'te.
 *
 * Büyük/küçük harf VE Türkçe i ailesi: veritabanı önce `İ`, `I` ve `ı`yı `i`ye çeviriyor, sonra
 * küçültüyor — ve sıra önemli, çünkü JavaScript'te `'İ'.toLowerCase()` bir `i` artı birleşen nokta
 * üretiyor, yani önce küçültmek iki tarafı ayırırdı.
 *
 * AKSANLAR KORUNUYOR: `Çağrı` ile `Cagri` sunucuda iki ayrı ad (`fold_identity` arama
 * normalleştirmesi değil), ve burada da öyle olmalı — yoksa istemci sunucunun kabul edeceği bir adı
 * "zaten var" sanıp var olmayan bir klasörü benimsemeye çalışırdı.
 */
export function foldName(value: string): string {
  const dotless = value.normalize('NFKC').replace(/[İIı]/g, 'i');
  return dotless.toLowerCase();
}

/** Sözleşmenin bir sayfada izin verdiği en büyük sayı. Sayfanın devamı artık imleçle geliyor
 *  ("Daha fazla göster"), ama sayfa yine de tavana kadar isteniyor: bir klasörü açan kişinin
 *  düğmeye hiç basmadan görebildiği satır sayısı ne kadar çoksa o kadar iyi. */
/** One row of the share picker. Only what the switcher needs — the rest of `Share` is the
 *  Shares screen's business. */
interface SharePick {
  id: string;
  name: string;
}

const PAGE = 200;

type Modal =
  | { kind: 'none' }
  | { kind: 'new-folder' }
  | { kind: 'rename'; entry: FileEntry }
  | { kind: 'trash'; entries: FileEntry[] }
  | { kind: 'permanent'; entries: FileEntry[] }
  | { kind: 'empty-trash' }
  | { kind: 'move'; entries: FileEntry[] }
  | { kind: 'copy'; entries: FileEntry[] }
  /** A drop, which chose its own destination — so it is answered by a `ConfirmBox` naming the
   *  folder rather than by the picker. */
  | { kind: 'move-drop'; entries: FileEntry[]; target: FileEntry };

/** How many direct children a folder about to be destroyed holds, as the server reported it.
 *  `more` is the contract's `hasMore` — there is no total (§14), so a full page becomes "200+". */
interface ChildCount {
  n: number;
  more: boolean;
}

/** Names in a confirmation before the list stops being read. Past this the box turns into a wall
 *  of text and the number at the top — the thing that actually has to land — is what gets skipped. */
const NAMES_SHOWN = 10;

/**
 * What the server says THIS caller may do to THIS row.
 *
 * The contract puts the list on every entry for one stated reason: so the interface does not draw
 * a button the server is going to refuse (§6.2, ADR-0021). Today every member gets the same seven
 * back, so reading the field changes nothing on screen — which is exactly why it has to be read
 * now, because the day the `folder_grants` ancestor walk lands, an unread field turns into a row
 * of buttons that answer 403.
 */
function can(
  entry: FileEntry,
  permission: OpenApi.components['schemas']['FolderPermission'],
): boolean {
  return entry.permissions.includes(permission);
}

/** Whether a drag carries files from outside the browser. An internal row drag has no `Files`
 *  entry, and without this test the whole card lights up as an upload target while the user is
 *  only moving a row from one folder to another. */
function hasFiles(transfer: DataTransfer): boolean {
  return Array.from(transfer.types).includes('Files');
}

/* ─── row glyphs ────────────────────────────────────────────────────────────── */

const KINDS: ReadonlyArray<{ glyph: string; tone: Tone; ext: ReadonlySet<string> }> = [
  {
    glyph: '🖼',
    tone: 'live',
    ext: new Set([
      'jpg',
      'jpeg',
      'png',
      'gif',
      'webp',
      'avif',
      'heic',
      'heif',
      'bmp',
      'svg',
      'tif',
      'tiff',
    ]),
  },
  {
    glyph: '🎞',
    tone: 'cool',
    ext: new Set(['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'mpg', 'mpeg', 'wmv']),
  },
  {
    glyph: '🎵',
    tone: 'warn',
    ext: new Set(['mp3', 'flac', 'wav', 'm4a', 'ogg', 'opus', 'aac', 'wma']),
  },
  {
    glyph: '🗜',
    tone: 'rose',
    ext: new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'iso']),
  },
  {
    glyph: '📄',
    tone: 'cool',
    ext: new Set([
      'pdf',
      'doc',
      'docx',
      'odt',
      'xls',
      'xlsx',
      'ods',
      'ppt',
      'pptx',
      'txt',
      'md',
      'csv',
      'rtf',
    ]),
  },
];

/**
 * The type badge, from the extension.
 *
 * `mimeType` is optional in the contract and the agent does not always fill it, so a listing would
 * be a mix of typed and untyped rows — the same file drawn two different ways depending on which
 * code path put it there. The suffix is always present and always agrees with itself.
 */
function typeOf(entry: FileEntry): { glyph: string; tone: Tone } {
  if (entry.kind === 'folder') return { glyph: '📁', tone: 'iris' };
  const ext = suffix(entry.name);
  for (const group of KINDS) {
    if (group.ext.has(ext)) return { glyph: group.glyph, tone: group.tone };
  }
  return { glyph: '📄', tone: 'dim' };
}

function suffix(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Düz metin olarak gösterilebilecek uzantılar.
 *
 * LİSTE, TAHMİN DEĞİL: `mimeType` sözleşmede isteğe bağlı ve ajan onu her zaman doldurmuyor, yani
 * türe bakan bir kontrol aynı dosyayı bazen açar bazen açmazdı (`typeOf` da aynı sebeple uzantıya
 * bakıyor). `html` ve `svg` bilerek YOK: ikisi de metin olarak gösterilebilir ama bir gün birinin
 * "önizlemeyi zenginleştirelim" diye bunları çizmesi, kiracının yüklediği bir belgeyi oturumun
 * kökeninde çalıştırmak olurdu. İçerik burada `<pre>` içinde METİN — React kaçırıyor.
 */
const TEXTUAL: ReadonlySet<string> = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'log',
  'json',
  'xml',
  'yml',
  'yaml',
  'ini',
  'cfg',
  'conf',
  'sql',
  'srt',
  'vtt',
]);

/**
 * Whether the browser can show this file without downloading it first, and as what.
 *
 * `svg` is excluded from the picture list on purpose even though every browser renders it: an SVG
 * is a document that can carry script, and putting one in an `<img>` on the same origin as the
 * session cookie is a decision this screen has no reason to make. It still downloads normally.
 *
 * ── RESİM VE VİDEONUN ÖTESİ ─────────────────────────────────────────────────────────────────
 *
 * §5.1 PDF, metin ve sesi de istiyor, ve üçü de tarayıcının elindekiyle açılıyor: ses bir
 * `<audio>` (medya öğeleri `Content-Disposition`ı umursamıyor), metin bir `Range` isteğiyle gelen
 * ilk 256 kB, PDF ise yeni bir sekme — çerçeveye alınamamasının gerekçesi `openPdfTab`te yazılı.
 * Ofis belgeleri (docx/xlsx/pptx) hâlâ yok: onları çizmek tarayıcıda bir belge motoru demek.
 */
export function previewAs(entry: FileEntry): 'image' | 'video' | 'audio' | 'text' | 'pdf' | null {
  if (entry.kind !== 'file') return null;
  const ext = suffix(entry.name);
  if (ext === 'svg') return null;
  if (KINDS[0]?.ext.has(ext) === true) return 'image';
  if (KINDS[1]?.ext.has(ext) === true) return 'video';
  if (KINDS[2]?.ext.has(ext) === true) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (TEXTUAL.has(ext)) return 'text';
  return null;
}

/* ─── seçim ─────────────────────────────────────────────────────────────────── */

/** Bir tıklamanın seçime ne yaptığını belirleyen iki tuş. */
export interface Modifiers {
  /** Shift: çapadan bu satıra kadarki aralık. */
  range: boolean;
  /** Ctrl / Cmd: aralık mevcut seçime EKLENİYOR, onun yerine geçmiyor. */
  add: boolean;
}

const NO_MODIFIERS: Modifiers = { range: false, add: false };

/** Fare ya da klavye olayından değiştiriciler. macOS'ta Ctrl'ün karşılığı Cmd. */
function mods(event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): Modifiers {
  return { range: event.shiftKey, add: event.ctrlKey || event.metaKey };
}

/**
 * Bir satıra tıklandığında seçimin yeni hâli.
 *
 * SAF, ve bunun bir sebebi var: aralık seçimi ekrandaki satır SIRASINA bağlı, yani listenin o
 * andaki hâlini bilmeden doğrulanamaz. Ayrı bir işlev olarak kalınca hem ölçülebiliyor hem de
 * "hangi satırlar" sorusu tek bir yerde cevaplanıyor.
 *
 * Çapa listede yoksa (klasör değişmiş, satır silinmiş) aralık İSTEĞİ TEKİLE düşüyor: olmayan bir
 * çapadan başlayan aralık, kullanıcının hiç görmediği satırları seçmek olurdu.
 */
export function nextSelection(
  ids: readonly string[],
  current: ReadonlySet<string>,
  id: string,
  anchorId: string | null,
  modifiers: Modifiers,
): ReadonlySet<string> {
  if (modifiers.range && anchorId !== null) {
    const from = ids.indexOf(anchorId);
    const to = ids.indexOf(id);
    if (from !== -1 && to !== -1) {
      const span = ids.slice(Math.min(from, to), Math.max(from, to) + 1);
      // Ctrl aralığı mevcut seçime EKLİYOR; yalnız Shift ise aralık seçimin kendisi oluyor —
      // her masaüstü dosya yöneticisinin davranışı, ve kas hafızası bunu bekliyor.
      const next = modifiers.add ? new Set(current) : new Set<string>();
      for (const row of span) next.add(row);
      return next;
    }
  }
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** The `.g` squares in this card are sized by their parent's rule (`.qf .g`, `.um .g`, `.frow .g`),
 *  so they cannot be the shared `Glyph`, which owns its own dimensions. Only the tint is shared. */
function tint(tone: Tone, alpha = 0.22): React.CSSProperties {
  const [r, g, b] = toneRgb(tone);
  return { background: `rgba(${r},${g},${b},${alpha})`, color: TONES[tone] };
}

/* ─── the screen ────────────────────────────────────────────────────────────── */

export function Files({
  notify,
  isAdmin,
  onUnauthenticated,
  prefs,
  savePrefs,
  onMeta,
}: Props): React.JSX.Element {
  // Back and forward are a real stack rather than a "previous folder" variable, because with one
  // variable going back twice returns to where you already were.
  const [history, setHistory] = useState<Loc[]>([ROOT]);
  /** Yayımlanmayı bekleyen bir yükleme: baytlar ara alanda, karar kullanıcıda. */
  const [clash, setClash] = useState<{ location: string; filename: string } | null>(null);
  /** Klasörün kendi öğe sayısı; sunucudan geliyor ve sayfa sınırından bağımsız. */
  const [total, setTotal] = useState<number | undefined>(undefined);

  /* ── FAVORİLER ────────────────────────────────────────────────────────────────────────────
     Sunucudaki tercih belgesinde duruyorlar, tarayıcıda değil: masasını televizyonda düzenleyen
     kişi aynı favorileri telefonunda bulmalı — kısayollarla aynı gerekçe. */
  const favorites = prefs?.favorites ?? [];
  const canFavorite = prefs !== undefined && savePrefs !== undefined;
  const isFavorite = (id: string): boolean => favorites.some((f) => f.id === id);

  /**
   * Kullanıcının kararını sunucuya iletir.
   *
   * Baytlar yeniden GÖNDERİLMİYOR: yükleme oturumu ara alandaki dosyayı hâlâ tutuyor ve bu uç
   * yalnız onu yayımlıyor. Bir gigabaytlık dosyada aradaki fark, bir saniye ile yarım saat.
   */
  async function resolveClash(policy: 'keep-both' | 'replace'): Promise<void> {
    const pending = clash;
    if (pending === null) return;
    setClash(null);
    const sent = await fetch(`${pending.location}/resolve`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy }),
    }).catch(() => null);
    if (sent === null || !sent.ok) {
      notify('error', `"${pending.filename}" yayımlanamadı.`);
      return;
    }
    notify(
      'ok',
      policy === 'replace'
        ? `"${pending.filename}" değiştirildi; eskisi çöp kutusunda.`
        : `"${pending.filename}" ikinci bir adla kaydedildi.`,
    );
    reload();
  }

  async function toggleFavorite(crumb: Crumb, trail: Crumb[]): Promise<void> {
    if (prefs === undefined || savePrefs === undefined) return;
    const already = isFavorite(crumb.id);
    const next = already
      ? favorites.filter((f) => f.id !== crumb.id)
      : [...favorites, { id: crumb.id, name: crumb.name, trail }];
    // KIRK TANE YETER, ve sınır sözleşmenin: bir şerit kırk öğeden sonra şerit olmaktan çıkıyor.
    if (next.length > 40) {
      notify('error', 'En fazla 40 favori tutulabilir.');
      return;
    }
    const ok = await savePrefs({ ...prefs, favorites: next });
    if (!ok) {
      notify('error', 'Favori kaydedilemedi.');
      return;
    }
    notify(
      'ok',
      already ? `${crumb.name} favorilerden çıkarıldı.` : `${crumb.name} favorilere eklendi.`,
    );
  }
  const [pos, setPos] = useState(0);
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  /** Told apart from "no rows": an empty list is a fact about the folder, a failed read is not. */
  const [listFailed, setListFailed] = useState(false);
  const [more, setMore] = useState(false);
  /**
   * Sunucunun bir sonraki sayfa için verdiği opak imleç; liste bittiyse `undefined`.
   *
   * BU EKRAN İMLECİ HİÇ OKUMUYORDU. Tek bir sayfa çekiliyor ve `hasMore` yalnız alt bilgideki bir
   * `+` işaretine dönüşüyordu — yani iki yüzden kalabalık bir klasörün geri kalanına ne
   * sıralamayla, ne aramayla, ne seçimle, hiçbir yoldan ulaşılamıyordu. Sözleşme imleci §14'te
   * baştan beri zorunlu tutuyor (`FileEntryPage.nextCursor`); eksik olan tek şey onu istemekti.
   */
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  /** Devamı gelirken. Düğme iki kez basılmamalı: aynı imleç iki kez harcanırsa aynı satırlar
   *  listeye iki kez girer ve seçim iki farklı satırı aynı kimlikle işaretler. */
  const [paging, setPaging] = useState(false);
  const [preview, setPreview] = useState<FileEntry | null>(null);
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');
  const [picking, setPicking] = useState(false);
  /**
   * Liste mi ızgara mı.
   *
   * §5.1 ızgara görünümünü istiyordu ve ekranda tek bir satır düzeni vardı: bir klasör dolusu
   * fotoğrafın hangisi olduğu ancak adından okunabiliyordu. İki düzen AYNI SATIRI çiziyor, yalnız
   * yerleşimi değişiyor (`.flist.gridview`) — ikinci bir satır bileşeni, zamanla ayrışan iki
   * davranış demek olurdu.
   *
   * Kip bu pencerede yaşıyor, tercihlerde değil: `Preferences` şemasında bir alan yok ve
   * sözleşmeyi bu ekran sahiplenmiyor. Kalıcı olması istendiğinde eklenecek yer `prefs`.
   */
  const [layout, setLayout] = useState<'list' | 'grid'>('list');
  /** Yedek gezgini açık mı. Kapı burada, pencere History.tsx'te — "çöp ve yedek" ikilisinin
      yedek yarısı. Sahibi bunu Dosyalar'ın içinde arıyor; ayrı ekran kafa karıştırıyordu. */
  const [backups, setBackups] = useState(false);
  /** "İşe bağla" penceresi: seçili girdiler + panodan gelen açık işler. */
  /**
   * Kod okuma KESTİRMESİ — sahibin tarif ettiği tek dokunuşluk zincir.
   *
   * Düğme → kamera → kod → arama → bulunan klasöre gir → fotoğraf yükleme. Araya onay ekranı
   * KONMUYOR, ve bu bilinçli bir geri adım: ilk sürüm okunanı gösterip "Tamam" bekliyordu, ama
   * QR'ın hata düzeltmesi ve barkodun kontrol hanesi zaten yanlış DEĞER üretilmesini engelliyor
   * (bkz. `scan.ts`) — kalan tek risk okuyamamak, ve onun cevabı onay değil yeniden çekmek.
   * Ne okunduğu yine söyleniyor: gidilen klasörle birlikte, bir bildirimde.
   */
  const [scanBusy, setScanBusy] = useState(false);
  /**
   * Kestirmenin son adımı: "bu klasöre fotoğraf yükle".
   *
   * Tarayıcılar dosya seçiciyi yalnız TAZE bir kullanıcı hareketiyle açıyor; kod çözme ve klasöre
   * gitme arasında geçen saniyeler o tazeliği tüketebiliyor. O yüzden iki yol birden: hareket hâlâ
   * geçerliyse seçici kendiliğinden açılır, değilse klasörün başında tek dokunuşluk bu şerit
   * durur. Sessizce hiçbir şey olmaması, ikisinden de kötü.
   */
  const [photoPrompt, setPhotoPrompt] = useState<string | null>(null);
  const [linking, setLinking] = useState<{
    entries: FileEntry[];
    tasks: { id: string; body: string }[] | null;
  } | null>(null);
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState<{ label: string; percent: number } | null>(null);
  const [modal, setModal] = useState<Modal>({ kind: 'none' });
  /** Filled while the permanent-delete box is open. Absent for a folder means "not counted", not
   *  "empty" — the box words those two differently on purpose. */
  const [childCounts, setChildCounts] = useState<ReadonlyMap<string, ChildCount>>(new Map());
  /** The ids being dragged. A drag begun on a row inside the selection carries the whole
   *  selection, so this is a set rather than one id. */
  const [drag, setDrag] = useState<ReadonlySet<string> | null>(null);
  /** The folder row the pointer is currently over, for `.frow.over`. */
  const [over, setOver] = useState<string | null>(null);
  /**
   * Çöpte kaç öğe var.
   *
   * EV SAYACI KALDIRILDI, sahibinin sözüyle: *"home simgesinde 200+ yazıyor ona gerek yok."* O
   * sayı zaten iki yerde birden duruyordu — simgenin üstünde ve ekranın altındaki sayaçta — ve
   * simgedeki hâli ikisinin daha kötüsüydü: `+` işareti "bilmiyoruz" demenin bir yolu, ve bir ev
   * düğmesinin üstünde bilinmeyen bir sayı taşımasının hiçbir karşılığı yok.
   *
   * Çöpünki duruyor: orada `+` hâlâ dürüst bir cevap. Çöp listelemesi bir klasör değil bir süzgeç
   * (`trashed_at` sütunu), ve sunucu ona bir toplam vermiyor.
   */
  const [counts, setCounts] = useState<{ trash: string | null }>({ trash: null });
  const [storage, setStorage] = useState<string | null>(null);
  /**
   * Hangi sıra.
   *
   * SUNUCUDA sıralanıyor, ekranda değil, ve bunun sebebi sayfalama: ekran bir seferde iki yüz
   * satır getiriyor, ve elde gelen sayfayı sıralamak yalnız O SAYFAYI sıralar — üç yüz dosyalık
   * bir klasörde "en büyük dosya" ilk iki yüzün en büyüğü olurdu. Sunucunun imleci sırayla
   * birlikte kuruluyor, yani ikinci sayfa birincinin gerçekten devamı.
   */
  const [order, setOrder] = useState<SortKey>('name');
  /**
   * Sıralamanın YÖNÜ, ve neden ayrı bir durum.
   *
   * Sahibin sözü: *"ada göre alfabetik ters ya da düz, tarihte geç ya da erken gibi
   * seçilemiyor."* Doğruydu — anahtar seçilebiliyordu, yön seçilemiyordu ve her anahtarın yönü
   * sunucuda sabitti. `null` "anahtarın kendi varsayılanı" demek: ada ve türe göre artan, tarihe
   * ve boyuta göre azalan. Bir sütun başlığına ilk basış o varsayılanı seçiyor, ikincisi
   * çeviriyor — Windows dosya gezgininin yaptığı şey.
   */
  const [dir, setDir] = useState<'asc' | 'desc' | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  /** Kaçıncı listeleme yürürlükte. Yalnız "daha fazla" için: gecikmiş bir sayfanın kendi
   *  klasörüne mi döndüğünü ayırt eden tek şey, ve state olsaydı cevabı beklerken eskimiş olurdu. */
  const listRun = useRef(0);
  /** Shift aralığının başladığı satır: son TEKİL seçim. Çizimi etkilemediği için ref. */
  const rangeAnchor = useRef<string | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const pickFile = useRef<HTMLInputElement>(null);
  const pickDir = useRef<HTMLInputElement>(null);
  const pickPhoto = useRef<HTMLInputElement>(null);
  const pickCode = useRef<HTMLInputElement>(null);

  const loc = history[pos] ?? ROOT;
  const trail = loc.trail;
  const trashed = loc.trashed;
  const last = trail[trail.length - 1];
  const parentId = last?.id;
  /**
   * The trash cannot be searched, so nothing typed there counts as a search.
   *
   * `GET /search` hard-filters `trashed_at IS NULL`, so a query typed in the bin came back full of
   * LIVE files — drawn under the "Çöp" breadcrumb, each with a "↺ Geri al" button that hit
   * `POST /files/{id}/restore` on a file that was never trashed. The service treats that as a
   * successful no-op, so the screen then toasted "X geri alındı" about a file it had not touched.
   * The contract has no trashed filter on /search, so the honest fix is that the box is inert here.
   */
  const searching = !trashed && term.trim() !== '';
  const busy = progress !== null;

  const reload = (): void => setReloadKey((k) => k + 1);

  function go(next: Loc): void {
    // Everything after the current position is a future that no longer happened.
    setHistory((h) => [...h.slice(0, pos + 1), next]);
    setPos(pos + 1);
    setQuery('');
    setTerm('');
    setSel(new Set());
  }

  /** Back and forward drop the search with them: a result list left over from two folders ago,
   *  under a breadcrumb pointing somewhere else, is the one view that cannot be read correctly. */
  function jump(to: number): void {
    setPhotoPrompt(null);
    setPos(to);
    setQuery('');
    setTerm('');
    setSel(new Set());
  }

  /**
   * Open a folder that came back from a search.
   *
   * The trail is rebuilt by walking `parentId` upwards rather than assumed, because a result can
   * be anywhere in the tree. Guessing — dropping the hit in as a single crumb under "Dosyalarım" —
   * would draw a breadcrumb that names a location the folder is not in.
   */
  async function openFound(entry: FileEntry): Promise<void> {
    const chain: Crumb[] = [{ id: entry.id, name: entry.name }];
    let parent = entry.parentId;
    // Bounded: the tree cannot contain a cycle, but a bad row must not hang the screen forever.
    for (let depth = 0; depth < 64 && parent !== null && parent !== undefined; depth += 1) {
      const { data } = await api.GET('/files/{id}', { params: { path: { id: parent } } });
      if (data === undefined) break;
      chain.unshift({ id: data.id, name: data.name });
      parent = data.parentId;
    }
    go({ trashed: false, trail: chain });
  }

  /** Bir girdinin İÇİNDE BULUNDUĞU klasöre git — dosya eşleşmesinin doğru varış noktası. */
  async function openContaining(entry: FileEntry): Promise<void> {
    const chain: Crumb[] = [];
    let parent = entry.parentId;
    for (let depth = 0; depth < 64 && parent !== null && parent !== undefined; depth += 1) {
      const { data } = await api.GET('/files/{id}', { params: { path: { id: parent } } });
      if (data === undefined) break;
      chain.unshift({ id: data.id, name: data.name });
      parent = data.parentId;
    }
    go({ trashed: false, trail: chain });
  }

  /**
   * Kestirmenin tamamı: fotoğraftaki kodu çöz, ara, bul, gir, yüklemeyi aç.
   *
   * Eşleşme seçimi ÖNCE ADI BİREBİR TUTAN KLASÖR: bir barkod numarası çoğu zaman klasörün tam
   * adıdır ve "içinde geçen" bir sonucu ona tercih etmek, kestirmeyi kumara çevirirdi. Sonra
   * herhangi bir klasör, en sonda bir dosyanın bulunduğu klasör — hiçbiri yoksa kestirme durur
   * ve okunan metni söyler; kullanıcı elindeki aramayla devam eder.
   */
  async function runCodeShortcut(file: File): Promise<void> {
    setScanBusy(true);
    setPhotoPrompt(null);
    let text: string | null = null;
    try {
      text = await decodeImage(file);
    } catch {
      text = null;
    }
    setScanBusy(false);
    if (text === null) {
      notify('error', 'Kod okunamadı. Kodu ortalayıp daha yakından, ışıklı bir yerde çekin.');
      return;
    }

    // Arama kutusuna YAZILIYOR: kestirme bir klasöre girse de, kullanıcı ne arandığını görmeli —
    // ve eşleşme çıkmazsa ekranda kalan şey doğrudan o aramanın sonucu olur.
    setQuery(text);
    setTerm(text);

    const found = await api.GET('/search', {
      params: { query: { q: text, limit: PAGE, ...shareQuery } },
    });
    const items = found.data?.items ?? [];
    const fold = (value: string): string => value.trim().toLocaleLowerCase('tr');
    const exact = items.find((it) => it.kind === 'folder' && fold(it.name) === fold(text));
    const folder = exact ?? items.find((it) => it.kind === 'folder');
    const target = folder ?? items[0];

    if (target === undefined) {
      notify('error', `Kod okundu ("${text}") ama eşleşen bir şey yok.`);
      return;
    }

    if (target.kind === 'folder') {
      await openFound(target);
      notify('ok', `${text} → ${target.name}`);
    } else {
      await openContaining(target);
      notify('ok', `${text} → ${target.name} dosyasının klasörü`);
    }

    // Tarayıcı hâlâ "kullanıcı az önce dokundu" sayıyorsa seçiciyi kendimiz açıyoruz; saymıyorsa
    // şerit kalıyor. `userActivation` olmayan tarayıcıda denemek serbest: en kötü hiçbir şey olmaz
    // ve şerit zaten orada.
    setPhotoPrompt(target.kind === 'folder' ? target.name : 'bu klasör');
    const activation = (navigator as { userActivation?: { isActive?: boolean } }).userActivation;
    if (activation?.isActive !== false) pickPhoto.current?.click();
  }

  /* ── search: one request per pause, not one per keystroke ── */
  useEffect(() => {
    const timer = window.setTimeout(() => setTerm(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  /* ── which share ──
     Undefined means the tenant's default, which is what the API assumes when the parameter is
     absent — so the first render behaves exactly as it did before shares could be created.

     This exists because `POST /shares` could open a share that nothing in the web app could ever
     show: every file route resolved the FIRST share and there was no way to name another. */
  /** The folder whose permissions panel is open, if any. */
  const [permissionsFor, setPermissionsFor] = useState<PermissionTarget | null>(null);
  const [shares, setShares] = useState<SharePick[] | null>(null);
  const [shareId, setShareId] = useState<string | undefined>(undefined);
  /**
   * Bu paylaşımda geri dönülecek bir nokta VAR MI.
   *
   * Sahibinin sözü: *"yedek diski olmadığı için dosyalardaki yedekler kısmına gerek yok, yedek
   * diski yarattığımızda ortaya çıkan bir şey olsun o."* Düğme aslında YEDEK DİSKİNİ değil, bu
   * paylaşımın anlık görüntülerini açıyor — ama istenen ilke düğmenin arkasında bir şey olması,
   * ve o ilke buraya olduğu gibi uyuyor: hiç anlık görüntü yokken düğme bir şey vaat edip boş bir
   * pencere açıyordu.
   *
   * `true` başlangıç değeri ve bu bilerek: cevap gelene kadar düğme DURUYOR. Tersi olsaydı,
   * ekranın her açılışında düğme bir an yok olup sonra belirirdi.
   */
  const [restorable, setRestorable] = useState(true);
  /**
   * Yedek diski TANIMLI VE TAKILI mı — "Yedekler" düğmesinin var olma şartı.
   *
   * Sahibin kuralı: *"yedekleme kısmı ancak yedek tanımlı bir disk varsa çalışır olmalı; eğer
   * yedek tanımlı bir disk yoksa yedekler butonunun da dosyalar kısmında görünmemesi gerekiyor."*
   * Ürün bu kuralı zaten bir yerde uyguluyor — Yedekleme penceresi üye için hiç çizilmiyor,
   * çünkü "pencereyi açıp 403 göstermek" bir yalan (App.tsx, `adminOnly`). Diskin yokluğu da
   * aynı şey: düğmeyi çizip arkasında "disk takılı değil" demek, sahibini olmayan bir şeyi
   * aramaya göndermek.
   *
   * VARSAYILAN GİZLİ. Öğrenene kadar çizilmiyor: bir okuma düşerse yanlış tarafa düşen şey
   * "bir an için görünmeyen düğme" olsun, "arkasında disk olmayan düğme" değil.
   */
  const [backupDisk, setBackupDisk] = useState(false);
  const shareQuery = shareId === undefined ? {} : { shareId };

  /**
   * Ekranın ADINI BİLDİĞİ paylaşım — bilmiyorsa `null`.
   *
   * "Varsayılan" seçiliyken listeyi sunucu seçiyor ve seçimi `ORDER BY created_at LIMIT 1`, yani
   * EN ESKİ paylaşım. Buradaki liste ise ada göre geliyor (`ORDER BY fold_identity(name), id`), o
   * yüzden `shares[0]` "varsayılan" değil "alfabetik ilk"tir. İkisi bir sanıldığında ekran bir
   * paylaşımın dosyalarını gösterirken "Yedekler" düğmesi BAŞKA bir paylaşımın anlık görüntülerini
   * açıyor, ve oradan yapılan bir geri yükleme yanlış paylaşımın köküne iniyordu — sunucu bunu
   * reddetmiyor, çünkü kökte hedef `null`.
   *
   * TAHMİN ETMEK YERİNE SUSMAK. Tek paylaşım varsa varsayılan da odur; birden fazlası varken
   * hangisinin varsayılan olduğunu sözleşme söylemiyor (`Share` şemasında `isDefault` yok), ve
   * bilmediği bir paylaşıma nişan almış bir düğme, cevabını söyleyen bir düğmeden kötü.
   */
  const currentShare = ((): SharePick | null => {
    if (shares === null) return null;
    const named = shares.find((item) => item.id === shareId);
    if (named !== undefined) return named;
    return shares.length === 1 ? (shares[0] ?? null) : null;
  })();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await api.GET('/shares', {});
      if (cancelled || data === undefined) return;
      setShares(data.items.map((item) => ({ id: item.id, name: item.name })));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ── geri dönülecek bir nokta var mı ──
     AJANA ULAŞILAMADIĞINDA DÜĞME DURUYOR, ve bu ucun kendi belgesindeki uyarının aynısı: boş
     liste "hiç görüntü yok" demek, `available: false` ise "öğrenemedik" demek. İkisini bir
     tutmak, bir dakikalığına düşmüş bir ajanın bütün geri dönüş noktalarını yokmuş gibi
     göstermesi olurdu. */
  useEffect(() => {
    // Hangi paylaşım olduğu bilinmiyorsa SORULMUYOR: alfabetik ilk paylaşımın görüntülerini sayıp
    // ekranda duran başka bir paylaşım hakkında karar vermek, düğmeyi yanlış yerde açıp kapatırdı.
    const askedShareId = currentShare?.id;
    if (askedShareId === undefined) return undefined;
    let cancelled = false;
    void (async () => {
      const { data } = await api.GET('/shares/{shareId}/snapshots', {
        params: { path: { shareId: askedShareId } },
      });
      if (cancelled || data === undefined) return;
      setRestorable(!data.available || data.items.length > 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentShare]);

  /* ── yedek diski yerinde mi ──
     ÜYEYE HİÇ SORULMUYOR: `BackupTargetController` sınıf düzeyinde yönetici kapılı, yani bir
     üyenin bu soruyu sorması 403 demek — ve zaten Yedekleme penceresi de üyeye açılmıyor.
     `prepared`, ajanın "iki veri kümesi de yerinde" cevabı; havuz içe alınmamışsa (fişi çekilmiş
     bir disk) false geliyor ve tur da tam bu alana bakıp "disk takılı değil" diyor. */
  useEffect(() => {
    if (!isAdmin) return undefined;
    let cancelled = false;
    void (async () => {
      const { data } = await api.GET('/backups/target', {});
      if (cancelled || data === undefined) return;
      setBackupDisk(data.configured && data.target != null && data.target.prepared);
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  /**
   * Listenin bir sayfası: `from` yoksa ilk sayfa, varsa imleçten devamı.
   *
   * SORGU TEK YERDE KURULUYOR, ve bu şart. İlk sayfa ile devamı farklı parametrelerle sorulsaydı
   * — sıralama ya da paylaşım biri düşseydi — sunucunun imleci başka bir sıranın ortasına
   * düşerdi: "daha fazla" ya satır atlar ya da aynı satırları yeniden getirirdi.
   */
  /**
   * Bir sütun başlığına basıldığında.
   *
   * AYNI SÜTUN İSE YÖNÜ ÇEVİR, başka sütun ise o sütunun kendi varsayılanıyla başla. İkincisi
   * önemli: tarihe göre sıralamaya artan yönle başlamak, "en son ne değişti" diye soran birine
   * klasörün en eski dosyasıyla cevap vermek olurdu.
   */
  function pickSort(key: SortKey): void {
    if (key !== order) {
      setOrder(key);
      setDir(DEFAULT_DIRECTION[key]);
      return;
    }
    setDir((current) => ((current ?? DEFAULT_DIRECTION[key]) === 'asc' ? 'desc' : 'asc'));
  }

  /** Yön sorguya yalnız SEÇİLDİĞİNDE giriyor; seçilmediyse kararı sunucu veriyor. */
  const way = dir === null ? {} : { direction: dir };

  function fetchPage(from: string | undefined) {
    const q = trashed ? '' : term.trim();
    const at = from === undefined ? {} : { cursor: from };
    return q !== ''
      ? api.GET('/search', { params: { query: { q, limit: PAGE, ...at, ...shareQuery } } })
      : api.GET('/files', {
          params: {
            query: trashed
              ? { trashed: true, limit: PAGE, ...at, ...shareQuery }
              : parentId === undefined
                ? { limit: PAGE, sort: order, ...way, ...at, ...shareQuery }
                : { parentId, limit: PAGE, sort: order, ...way, ...at },
          },
        });
  }

  /**
   * Listenin devamını getirir.
   *
   * SONSUZ KAYDIRMA DEĞİL, BİR DÜĞME. Kendiliğinden yüklenen bir liste alt bilgiyi — depolama
   * özetini, sayacı, sıralama seçicisini — sürekli bir satır aşağı iterek erişilemez kılıyor, ve
   * kullanıcı "hepsi bu kadar mı" sorusunun cevabını hiçbir zaman göremiyor.
   */
  async function loadMore(): Promise<void> {
    const from = cursor;
    if (from === undefined || paging) return;
    // HANGİ LİSTEYE EKLENDİĞİ ÖNEMLİ. Sayfa yoldayken kullanıcı başka bir klasöre girebilir; o
    // sayfa döndüğünde eklenecek liste artık başka bir klasörün listesidir, ve satırlar hiç
    // bulunmadıkları bir klasörün altında görünürdü.
    const run = listRun.current;
    setPaging(true);
    const result = await fetchPage(from);
    setPaging(false);
    if (run !== listRun.current) return;
    if (result.response.status === 401) {
      onUnauthenticated();
      return;
    }
    if (result.data === undefined) {
      // Ekrandaki satırlar duruyor: okunamayan şey devamı, ve gelen sayfayı silmek okunabilmiş
      // olanı da cezalandırmak olurdu.
      notify('error', 'Sonraki sayfa okunamadı.');
      return;
    }
    const page = result.data;
    setEntries((current) => merged(current ?? [], page.items, order, dir));
    setMore(page.hasMore);
    setCursor(page.nextCursor);
  }

  /* ── the listing ── */
  useEffect(() => {
    let cancelled = false;
    // Yürürlükteki listelemenin numarası: yolda olan bir "daha fazla" cevabı bununla kendi
    // listesine mi döndüğünü anlıyor.
    listRun.current += 1;
    setEntries(null);
    setListFailed(false);
    setCursor(undefined);
    void (async () => {
      const result = await fetchPage(undefined);
      if (cancelled) return;
      if (result.response.status === 401) {
        onUnauthenticated();
        return;
      }
      if (result.data === undefined) {
        // Not `setEntries([])`. A toast is transient chrome; the panel underneath it would be
        // asserting "Bu klasör boş" about a folder nobody managed to read.
        notify('error', searching ? 'Arama yapılamadı.' : 'Klasör okunamadı.');
        setListFailed(true);
        setMore(false);
        return;
      }
      // ── YENİDEN SIRALAMA YALNIZ ADA GÖRE ─────────────────────────────────────────────
      // `sorted` Türkçe harmanlamayı düzeltiyor (`İ` `I` ile, `ş` `s`den sonra) ve bunu sunucunun
      // `name_fold`u ondan farklı yapıyor. Ama bu düzeltme SIRAYI YENİDEN KURUYOR: boyuta göre
      // sıralanmış bir sayfaya uygulanınca sunucunun sırasını tamamen siler ve ekran "en büyük
      // önce" derken alfabetik bir liste gösterirdi.
      setEntries(order === 'name' ? sorted(result.data.items) : result.data.items);
      setMore(result.data.hasMore);
      setCursor(result.data.nextCursor);
      setTotal(result.data.total);
      // A selection that survives a folder change acts on rows the user can no longer see.
      setSel(new Set());
    })();
    return () => {
      cancelled = true;
    };
    // `shareId` is a dependency: switching share has to re-read, and `parentId` is cleared by the
    // handler that sets it so a folder from the old share cannot survive the switch.
  }, [parentId, trashed, term, reloadKey, shareId, order, dir, notify, onUnauthenticated]);

  /* ── çöp sayacı ──
     Kendi isteği, ve öyle olmak zorunda: şeritteki sayı ekrandaki listeden bağımsız. Açık olan
     klasörden türetilseydi kökte doğru, başka her yerde eski olurdu.

     Ev sayacı için ikinci bir istek VARDI ve kaldırıldı — sayı ekrandan kalkınca onu getiren
     istek de kalkıyor. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const bin = await api.GET('/files', {
        params: { query: { trashed: true, limit: PAGE, ...shareQuery } },
      });
      if (cancelled) return;
      setCounts({ trash: countOf(bin.data) });
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey, shareId]);

  /* ── the capacity line in the footer ── */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, response } = await api.GET('/system/telemetry', {});
      if (cancelled) return;
      if (data !== undefined) {
        const used = data.pools.reduce((sum, pool) => sum + pool.used, 0);
        const free = data.pools.reduce((sum, pool) => sum + pool.available, 0);
        setStorage(`${formatBytes(used)} kullanılıyor · ${formatBytes(free)} boş`);
        return;
      }
      // Told apart on purpose. "Not your role" and "the agent is down" send an operator to two
      // completely different places, and a single "unavailable" sends them to the wrong one.
      // `/system/telemetry` answers the ONE account in `system_setup`, not every `role = 'admin'`
      // — so "yöneticilere açık" would be wrong in the mouth of a second promoted administrator.
      if (response.status === 403) setStorage('Depolama durumu yalnız cihazı kuran hesaba açık.');
      else if (response.status === 503) setStorage('Depolama ajanı erişilebilir değil.');
      else setStorage('Depolama durumu okunamadı.');
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  /* ── how much a permanent delete is about to destroy ──
     The box opens straight away and the numbers land a moment later, because a confirmation that
     waits for a round trip before appearing reads as a click that did nothing.

     Only a positive count is shown. A trashed folder's children keep `trashed_at` NULL — the bin
     is one flag on one row (ADR-0008) — so it is not settled that this listing returns them, and
     an empty answer can mean "no children" or "not visible from here". Printing "0 öğe" over a
     folder that in fact holds forty is the one number this box must never print, so an empty
     answer produces no number at all and the box says "ve içindekiler" instead. */
  useEffect(() => {
    const doomed =
      modal.kind === 'permanent'
        ? modal.entries
        : modal.kind === 'empty-trash'
          ? (entries ?? [])
          : null;
    if (doomed === null) return undefined;
    // Only the rows the box will actually print. Emptying a bin that holds a full page of folders
    // would otherwise open two hundred listings at once to fill in ten lines of text.
    const folders = doomed.slice(0, NAMES_SHOWN).filter((entry) => entry.kind === 'folder');
    setChildCounts(new Map());
    if (folders.length === 0) return undefined;
    let cancelled = false;
    void (async () => {
      const pages = await Promise.all(
        folders.map(async (folder) => {
          const { data } = await api.GET('/files', {
            params: { query: { parentId: folder.id, limit: PAGE } },
          });
          return { id: folder.id, page: data };
        }),
      );
      if (cancelled) return;
      const next = new Map<string, ChildCount>();
      for (const { id, page } of pages) {
        if (page === undefined || page.items.length === 0) continue;
        next.set(id, { n: page.items.length, more: page.hasMore });
      }
      setChildCounts(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [modal, entries]);

  /* ── the upload menu closes the way every menu does ── */
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (event: MouseEvent): void => {
      const inside = event.target instanceof Node && bar.current?.contains(event.target) === true;
      if (!inside) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  /* ── the directory picker ──
     `webkitdirectory` is not in React's attribute typings and is not standardised, so it goes on
     through the DOM. Without it the same input silently behaves like an ordinary file picker and
     the folder tree the user chose arrives flattened. */
  useEffect(() => {
    const input = pickDir.current;
    if (input === null) return;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
  }, []);

  /* ── mutations ── */

  /**
   * Open a box that acts on rows, and only if there are rows.
   *
   * The three boxes behind this all begin with a count of what is about to happen, and a count of
   * nothing is the one thing they must never print: the permanent-delete body would read
   * " diskten silinecek. BU İŞLEM GERİ ALINAMAZ" with the number missing, over a list of nothing,
   * and answering "evet" would then do nothing and report nothing.
   */
  function openOn(kind: 'trash' | 'permanent' | 'move' | 'copy', list: FileEntry[]): void {
    if (list.length === 0) return;
    setModal({ kind, entries: list });
  }

  async function createFolder(name: string): Promise<void> {
    setModal({ kind: 'none' });
    const { error, response } = await api.POST('/files/folders', {
      body: folderBody(name, parentId, shareId),
    });
    if (response.status === 401) {
      onUnauthenticated();
      return;
    }
    if (error !== undefined) {
      notify('error', problemMessage(error, 'Klasör oluşturulamadı.'));
      return;
    }
    notify('ok', `"${name}" oluşturuldu.`);
    reload();
  }

  async function rename(entry: FileEntry, name: string): Promise<void> {
    setModal({ kind: 'none' });
    const { error, response } = await api.PATCH('/files/{id}', {
      params: { path: { id: entry.id } },
      body: { name },
    });
    if (response.status === 401) {
      onUnauthenticated();
      return;
    }
    if (error !== undefined) {
      notify('error', problemMessage(error, 'Yeniden adlandırılamadı.'));
      return;
    }
    notify('ok', `"${entry.name}" → "${name}"`);
    reload();
  }

  async function trash(list: FileEntry[]): Promise<void> {
    setModal({ kind: 'none' });
    let failed = 0;
    for (const entry of list) {
      const { error, response } = await api.DELETE('/files/{id}', {
        params: { path: { id: entry.id } },
      });
      // Without this, an expired session turned ten selected rows into ten toasts blaming the
      // rows for a refusal that had nothing to do with them, on a desk with no session left.
      if (response.status === 401) {
        onUnauthenticated();
        return;
      }
      if (error !== undefined) {
        failed += 1;
        notify('error', problemMessage(error, `"${entry.name}" çöp kutusuna taşınamadı.`));
      }
    }
    const moved = list.length - failed;
    if (moved > 0) {
      notify(
        'ok',
        moved === 1 && list[0] !== undefined
          ? `"${list[0].name}" çöp kutusuna taşındı.`
          : `${moved} öğe çöp kutusuna taşındı.`,
      );
    }
    setPicking(false);
    reload();
  }

  async function restore(list: FileEntry[]): Promise<void> {
    let failed = 0;
    for (const entry of list) {
      const { error, response } = await api.POST('/files/{id}/restore', {
        params: { path: { id: entry.id } },
      });
      if (response.status === 401) {
        onUnauthenticated();
        return;
      }
      if (error !== undefined) {
        failed += 1;
        // A 409 here is the interesting one: the name was taken back while the row sat in the bin.
        notify('error', problemMessage(error, `"${entry.name}" geri alınamadı.`));
      }
    }
    const back = list.length - failed;
    if (back > 0) {
      notify(
        'ok',
        back === 1 && list[0] !== undefined
          ? `"${list[0].name}" geri alındı.`
          : `${back} öğe geri alındı.`,
      );
    }
    setPicking(false);
    reload();
  }

  /**
   * Destroy the bytes.
   *
   * A loop, and the contract is why: `DELETE /files/{id}/permanent` walks a folder bottom-up and
   * is NOT atomic — cut off halfway, what went is gone and the rest stays in the bin, and calling
   * again picks up where it stopped. So the screen has to report a partial result honestly: how
   * many went, how many did not, and what the first refusal said. One "başarısız" toast over a
   * bin that is now half empty leaves the reader with no idea which half.
   *
   * Returns how many rows are gone, and whether the session outlived the run: emptying the bin
   * has something to add afterwards, and it must not add it to a desk that has been replaced by
   * the sign-in form.
   */
  async function permanentDelete(
    list: FileEntry[],
    label: string,
  ): Promise<{ done: number; signedOut: boolean }> {
    setModal({ kind: 'none' });
    if (list.length === 0) return { done: 0, signedOut: false };

    let done = 0;
    let firstError = '';
    for (const [index, entry] of list.entries()) {
      setProgress({
        label: `${label} · ${index + 1}/${list.length} · ${entry.name}`,
        percent: Math.round((index / list.length) * 100),
      });
      const { error, response } = await api.DELETE('/files/{id}/permanent', {
        params: { path: { id: entry.id } },
      });
      if (response.status === 401) {
        setProgress(null);
        // The tally goes with the sign-out, not into a toast: `onUnauthenticated` swaps the whole
        // desk for the sign-in form and the toast stack unmounts with it. A bin emptied down to
        // item 47 of 200 must not come back looking 46 items lighter for no stated reason.
        onUnauthenticated(
          done === 0
            ? undefined
            : `Oturumunuz sona erdi. Kesilmeden önce ${done} öğe kalıcı olarak silinmişti.`,
        );
        return { done, signedOut: true };
      }
      // 204: no body, so `data` is undefined on success too. `response.ok` is the only honest test.
      if (response.ok) {
        done += 1;
        continue;
      }
      // 404 is done, not failed, for the same reason the server accepts the agent's `not_found`:
      // the row this call exists to remove is already gone. The bin is FLAT — a folder and a file
      // trashed separately both appear as rows — so purging the folder first takes the file's row
      // with it, and counting the follow-up 404 as a failure would report destroyed data as
      // surviving, over a bin the reader can see is empty.
      if (response.status === 404) {
        done += 1;
        continue;
      }
      const message = problemMessage(
        error,
        response.status === 409
          ? // The entry exists but is not in the bin. Only the FALLBACK, because 409 on this route
            // carries at least six different refusals — a folder with bytes on disk the database
            // cannot name among them — and that sentence is the one worth reading.
            `"${entry.name}" çöpte değil — kalıcı silmek için önce çöpe atın.`
          : `"${entry.name}" kalıcı olarak silinemedi.`,
      );
      if (firstError === '') firstError = message;
    }
    setProgress(null);

    const failed = list.length - done;
    if (done > 0) {
      notify(
        'ok',
        done === 1 && list[0] !== undefined
          ? `"${list[0].name}" kalıcı olarak silindi.`
          : `${done} öğe kalıcı olarak silindi.`,
      );
    }
    if (failed > 0) {
      notify('error', `${failed} öğe silinemedi, ${done} öğe silindi. ${firstError}`);
    }
    setPicking(false);
    reload();
    return { done, signedOut: false };
  }

  /**
   * Çöpü boşaltır — ekrandaki sayfayı değil, çöpün tamamını.
   *
   * KALAN SAYFALAR ÖNCE İMLEÇLE TOPLANIYOR. Ekranda ne varsa onun silinmesi, iki yüz elli öğelik
   * bir çöpte düğmeye üç kez basmak ve her seferinde "boşaltmayı yineleyin" uyarısını okumak
   * demekti; bir temizlik işinin kaç kez tekrarlanacağını kullanıcının kendisinin sayması, bu
   * cihazda kabul edilebilir bir iş değil.
   *
   * Bir sayfa okunamazsa okunabilmiş olanlar YİNE siliniyor ve gerisi için uyarı veriliyor: yarım
   * kalmış bir boşaltma, hiç başlamamış olandan iyidir ve çöp yinelenebilir bir yer.
   */
  async function emptyTrash(): Promise<void> {
    const list = [...(entries ?? [])];
    let from = cursor;
    let hadMore = false;
    while (from !== undefined) {
      const page = await api.GET('/files', {
        params: { query: { trashed: true, limit: PAGE, cursor: from, ...shareQuery } },
      });
      if (page.data === undefined) {
        hadMore = true;
        break;
      }
      list.push(...page.data.items);
      // Boş bir sayfa sonun kendisi: ilerlemeyen bir imleç bu döngüyü sonsuz kılardı ve sonsuz
      // döngünün faturasını ödeyen, çöpünü boşaltmaya çalışan kullanıcı olurdu.
      if (page.data.items.length === 0) break;
      from = page.data.nextCursor;
    }
    const { done, signedOut } = await permanentDelete(list, 'Çöp boşaltılıyor');
    // Only when something actually went, and never as an 'ok': a run in which every delete was
    // refused ended on a green tick telling the reader to do it again, and 'ok' dismisses itself
    // after four seconds — so the one instruction that matters after a partial purge was the one
    // that vanished. Nothing at all once the session went with it; the sign-in note carries the
    // tally there and this stack is no longer on screen.
    if (hadMore && done > 0 && !signedOut) {
      notify(
        'error',
        'Çöpün tamamı okunamadı, bir kısmı silinmemiş olabilir; boşaltmayı yineleyin.',
      );
    }
  }

  /**
   * Move rows into another folder.
   *
   * `parentId` on `PATCH /files/{id}`: one column on the same row, one `rename(2)` on the disk.
   * The two refusals worth translating are both 409 — a destination in another share, which is an
   * EXDEV the server will not paper over (ADR-0008), and a folder dropped inside itself.
   *
   * `targetName` is carried all the way down to the toast because a move has no undo and the
   * screen is the only record of where things went. "3 öğe taşındı." over a two-hundred-row
   * listing tells the reader that something left, and nothing at all about where to look for it.
   */
  /**
   * Copy the selection into a folder.
   *
   * ONE request for the whole selection, unlike `move` — which loops, because each move is its own
   * immediate `renameat2`. A copy is a job: the endpoint answers 202 with a job id and the work
   * happens in the worker, so a thousand-file copy does not hold this screen open. §17 asks for
   * exactly that.
   *
   * The listing is NOT reloaded here. The rows do not exist yet; they appear as the job runs, and
   * the event stream is what brings them. Reloading immediately would show the destination
   * unchanged and read as a copy that did nothing.
   */
  async function copy(list: FileEntry[], target: string | null, targetName: string): Promise<void> {
    setModal({ kind: 'none' });
    if (list.length === 0) return;

    const { data, error, response } = await api.POST('/file-operations', {
      body: {
        operation: 'copy',
        sourceIds: list.map((entry) => entry.id),
        destinationId: target,
        // Sent explicitly rather than left to the document's default. It is the only policy the
        // server implements, and naming it here means a future default that changed would break
        // this call loudly instead of quietly copying under different rules.
        conflictPolicy: 'keep_both',
      },
    });
    if (response.status === 401) {
      onUnauthenticated();
      return;
    }
    if (data === undefined) {
      notify('error', problemMessage(error, 'Kopyalama başlatılamadı.'));
      return;
    }
    notify(
      'ok',
      `${tally(list)} "${targetName}" klasörüne kopyalanıyor. İlerlemesi Sistem işleri panosunda.`,
    );
  }

  async function move(list: FileEntry[], target: string | null, targetName: string): Promise<void> {
    setModal({ kind: 'none' });
    if (list.length === 0) return;

    let done = 0;
    let firstError = '';
    for (const [index, entry] of list.entries()) {
      if (entry.id === target) {
        // The picker closes this door for every selected folder; a drop can still land a row on
        // itself, and a cycle is not something to find out about from a 409.
        if (firstError === '') firstError = `"${entry.name}" kendi içine taşınamaz.`;
        continue;
      }
      // Every move, not only a batch. `busy` is what disables the row controls and turns off
      // `draggable`, so a single move that left the screen unlocked let a second irreversible
      // operation start on top of the first one.
      setProgress({
        label: `Taşınıyor · ${index + 1}/${list.length} · ${entry.name}`,
        percent: Math.round((index / list.length) * 100),
      });
      const { error, response } = await api.PATCH('/files/{id}', {
        params: { path: { id: entry.id } },
        body: { parentId: target },
      });
      if (response.status === 401) {
        setProgress(null);
        // As in `permanentDelete`: the toast stack goes with the desk, so a half-applied batch is
        // reported on the sign-in form or not at all.
        onUnauthenticated(
          done === 0
            ? undefined
            : `Oturumunuz sona erdi. Kesilmeden önce ${done} öğe "${targetName}" içine taşınmıştı.`,
        );
        return;
      }
      if (error === undefined) {
        done += 1;
        continue;
      }
      const message =
        response.status === 409
          ? problemMessage(
              error,
              `"${entry.name}" oraya taşınamadı: hedef başka bir paylaşımda ya da klasörün kendi altında.`,
            )
          : problemMessage(error, `"${entry.name}" taşınamadı.`);
      if (firstError === '') firstError = message;
    }
    setProgress(null);

    const failed = list.length - done;
    if (done > 0) {
      notify(
        'ok',
        done === 1 && list[0] !== undefined
          ? `"${list[0].name}" → "${targetName}"`
          : `${done} öğe "${targetName}" içine taşındı.`,
      );
    }
    if (failed > 0) {
      notify('error', `${failed} öğe taşınamadı, ${done} öğe taşındı. ${firstError}`);
    }
    setPicking(false);
    reload();
  }

  /* ── uploading ── */

  /**
   * Walk a relative path from the drop target down, making folders as needed.
   *
   * The cache is per upload run rather than per file: a folder of three hundred photos is one
   * `POST /files/folders` and two hundred and ninety-nine cache hits, not three hundred conflicts.
   */
  async function ensureChain(
    segments: string[],
    cache: Map<string, string>,
  ): Promise<{ id: string | undefined } | null> {
    let key = '';
    let current = parentId;
    for (const segment of segments) {
      key = key === '' ? segment : `${key}/${segment}`;
      const known = cache.get(key);
      if (known !== undefined) {
        current = known;
        continue;
      }
      const made = await ensureFolder(segment, current);
      if (made === null) return null;
      cache.set(key, made);
      current = made;
    }
    return { id: current };
  }

  async function ensureFolder(name: string, parent: string | undefined): Promise<string | null> {
    const { data } = await api.POST('/files/folders', {
      body: folderBody(name, parent, shareId),
    });
    if (data !== undefined) return data.id;
    // 409 is the ordinary case, not a fault: the user is re-uploading a folder they already have,
    // or two files from the same subdirectory raced. Adopt the existing folder and carry on.
    return findFolder(name, parent);
  }

  /**
   * 409'dan sonra: bu adı bu klasörde zaten tutan klasörü bul.
   *
   * ── BİREBİR AD KARŞILAŞTIRMASI YANLIŞ CEVAP VERİYORDU ───────────────────────────────────────
   *
   * Sunucu ad tekliğini `fold_identity` ile soruyor: büyük/küçük harf ve Türkçe i ailesi katlanmış.
   * Yani "FOTOĞRAFLAR" varken "fotoğraflar" 409 alıyor, ama `item.name === name` hiçbir satırı
   * tutmuyordu — `ensureChain` `null` dönüyor ve klasördeki ÜÇ YÜZ fotoğrafın her biri "klasör
   * kurulamadı" ile düşüyordu. Karşılaştırma artık sunucunun sorduğu soruyu soruyor (`foldName`).
   *
   * ── VE ARAMA, LİSTELEME DEĞİL ───────────────────────────────────────────────────────────────
   *
   * Listeleme `kind`i ARTAN sıralıyor (`file` < `folder`), yani klasörler dosyalardan SONRA
   * geliyor: iki yüzden çok dosyası olan bir üst klasörde aranan klasör ilk sayfada hiç
   * görünmüyor. `/search` ada göre soruyor ve önek eşleşmelerini başa alıyor, yani kalabalık
   * klasörde de tek istekte cevap veriyor. Listeleme yine de duruyor — aramanın normalleştirmesi
   * aksan atıyor ve tek harflik/boşluklu adlarda beklenmedik davranabiliyor; bulunamazsa eski yol
   * ikinci bir şans.
   */
  async function findFolder(name: string, parent: string | undefined): Promise<string | null> {
    const wanted = foldName(name);
    const here = (item: FileEntry): boolean =>
      item.kind === 'folder' &&
      foldName(item.name) === wanted &&
      // Arama BÜTÜN alt ağacı tarıyor: aynı adlı bir torun, aranan kardeş değil.
      (parent === undefined ? item.parentId === null : item.parentId === parent);

    if (name.trim() !== '') {
      const hits = await api.GET('/search', {
        params: {
          query: {
            q: name,
            limit: PAGE,
            ...shareQuery,
            ...(parent === undefined ? {} : { scope: parent }),
          },
        },
      });
      const hit = hits.data?.items.find(here);
      if (hit !== undefined) return hit.id;
    }

    const listing = await api.GET('/files', {
      params: {
        query:
          parent === undefined ? { limit: PAGE, ...shareQuery } : { parentId: parent, limit: PAGE },
      },
    });
    return listing.data?.items.find(here)?.id ?? null;
  }

  async function runUploads(list: Upload[]): Promise<void> {
    if (trashed) {
      notify('error', 'Çöp kutusuna yükleme yapılamaz.');
      return;
    }
    if (list.length === 0) return;

    const cache = new Map<string, string>();
    let failed = 0;

    for (const [index, { file, segments }] of list.entries()) {
      const label = list.length === 1 ? file.name : `${index + 1}/${list.length} · ${file.name}`;
      setProgress({ label, percent: 0 });

      let target = parentId;
      if (segments.length > 0) {
        const resolved = await ensureChain(segments, cache);
        if (resolved === null) {
          failed += 1;
          notify('error', `"${file.name}" için klasör kurulamadı.`);
          continue;
        }
        target = resolved.id;
      }

      try {
        for await (const percent of uploadFile(file, target, shareId)) {
          setProgress({ label, percent });
        }
      } catch (problem) {
        failed += 1;
        // ── ÇAKIŞMA BİR HATA DEĞİL, BİR SORU ──────────────────────────────────────────
        // Baytlar karşı tarafta ve duruyor; eksik olan tek şey kullanıcının kararı. Bunu bir
        // bildirimle geçiştirmek, bir gigabaytı çöpe atıp "yüklenemedi" demek olurdu.
        if (problem instanceof UploadNameClash) {
          setClash({ location: problem.location, filename: problem.filename });
          continue;
        }
        notify('error', problem instanceof Error ? problem.message : `"${file.name}" yüklenemedi.`);
      }
    }

    setProgress(null);
    const done = list.length - failed;
    if (done > 0) {
      notify(
        'ok',
        done === 1 && list[0] !== undefined
          ? `"${list[0].file.name}" yüklendi.`
          : `${done} dosya yüklendi.`,
      );
    }
    reload();
  }

  function chosen(event: React.ChangeEvent<HTMLInputElement>, keepPaths: boolean): void {
    // COPIED BEFORE THE INPUT IS CLEARED, and the order is the whole point.
    //
    // `event.target.files` is a LIVE FileList, not a snapshot. Setting `value = ''` empties the
    // list the variable still points at, so the previous version read `picked.length === 0` on
    // the very files the user had just chosen and returned without uploading anything. Choosing
    // a file from the Yükle menu did nothing at all, silently, on every platform. Found by the
    // e2e suite rather than by anyone using it, because there is no error to see.
    //
    // The clearing itself is still needed: without it, choosing the SAME file twice does not
    // fire `change` a second time. It just has to happen after the copy.
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    setMenuOpen(false);
    void runUploads(uploadsOf(files, keepPaths));
  }

  /* ── selection ── */

  const selected = (entries ?? []).filter((entry) => sel.has(entry.id));
  /** Ekrandaki her satır seçili mi — "Tümünü seç" düğmesinin iki yüzü buradan ayrılıyor. */
  const allPicked =
    entries !== null && entries.length > 0 && entries.every((entry) => sel.has(entry.id));

  /**
   * Bir satıra tıklandı.
   *
   * ── ÜÇ TIKLAMA, ÜÇ ANLAM ────────────────────────────────────────────────────────────────
   * Düz tıklama tekil (bu ekran kutu işaretleme kipinde çalışıyor, o yüzden düz tıklama seçimi
   * SİLMİYOR, ekliyor/çıkarıyor), Ctrl/Cmd de tekil ama açıkça, Shift ise ÇAPADAN buraya kadar
   * olan aralık. Üç yüz fotoğraflı bir klasörü başka bir paylaşıma taşımak, aralık seçimi olmadan
   * üç yüz ayrı tıklama demekti (§5.1).
   */
  function toggle(id: string, modifiers: Modifiers = NO_MODIFIERS): void {
    const ids = (entries ?? []).map((entry) => entry.id);
    setSel((current) => nextSelection(ids, current, id, rangeAnchor.current, modifiers));
    // Aralık çapayı YERİNDE bırakıyor: Shift'i basılı tutan biri aralığı büyütüp küçültebilmeli.
    if (!modifiers.range) rangeAnchor.current = id;
  }

  function stopPicking(): void {
    setPicking(false);
    setSel(new Set());
    rangeAnchor.current = null;
  }

  /**
   * A download is a plain `<a href download>`, one per entry, and nothing else.
   *
   * The session is a same-origin cookie so the browser sends it, and the server answers with
   * `Content-Disposition: attachment` — which means a multi-gigabyte file goes from the socket to
   * the disk without ever passing through this tab's heap. Fetching it to build a blob URL would
   * work perfectly on the test fixtures and kill the tab on a real video.
   *
   * The anchor is built here rather than left in the row because the row's control has to be a
   * `<button>`: the stylesheet dresses `.fact button` and nothing else, and a link sitting among
   * them with no hover or disabled state reads as a dead control.
   *
   * ── KLASÖRLER DE İNİYOR, VE ATLANAN SÖYLENİYOR ────────────────────────────────────────────
   *
   * Klasör satırında indirme düğmesi hiç çizilmiyordu ve karışık bir seçimde klasörler SESSİZCE
   * atlanıyordu: iki klasör ve bir dosya seçip indirmeye basan biri tek dosya alıyor, eksiğin
   * farkına ancak diskte sayarsa varıyordu. Klasör artık `/archive` üzerinden tek bir `.tar.gz`
   * olarak iniyor; yetkisi olmadığı için gerçekten atlanan bir şey kalırsa ekran onu söylüyor.
   */
  function download(list: FileEntry[]): void {
    let skipped = 0;
    for (const entry of list) {
      if (!can(entry, 'download')) {
        skipped += 1;
        continue;
      }
      const anchor = document.createElement('a');
      anchor.href =
        entry.kind === 'folder'
          ? `${API_BASE_URL}/files/${entry.id}/archive`
          : `${API_BASE_URL}/files/${entry.id}/content`;
      anchor.download = entry.kind === 'folder' ? `${entry.name}.tar.gz` : entry.name;
      anchor.rel = 'noopener';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    }
    if (skipped > 0) {
      notify('error', `${skipped} öğe indirilemedi: indirme izniniz yok.`);
    } else if (list.some((entry) => entry.kind === 'folder')) {
      // Bir klasörün arşivi sunucuda ÜRETİLİYOR, yani indirme hemen başlamıyor. Söylenmezse,
      // tarayıcının bir şey yapmadığı birkaç saniye tıklamanın işe yaramadığı gibi görünüyor.
      notify('ok', 'Klasör arşivleniyor; indirme birazdan başlayacak.');
    }
  }

  /* ── render ── */

  // ── SAYAÇ ARTIK KLASÖRÜN, SAYFANIN DEĞİL ────────────────────────────────────────────────
  // "200+ öğe" yazıyordu ve o "+" bir tahmin değil, bilginin yokluğuydu: ekran iki yüz satır
  // getiriyor ve arkasında ne olduğunu sormuyordu. Sunucu artık klasörün kendi sayısını
  // gönderiyor. Aramada toplam yok — arama bir klasör değil — ve orada eski davranış duruyor.
  //
  // EKRANDAKİ SAYI DA YAZIYOR, ama yalnız devamı varken: "350 öğe" derken iki yüz satır çizmek,
  // sayfalama düğmesi eklendikten sonra bile okuyana neyin eksik olduğunu söylemiyordu.
  const meta: string =
    entries === null
      ? '—'
      : total !== undefined && !searching
        ? more
          ? `${entries.length} / ${total} öğe`
          : `${total} öğe`
        : `${entries.length}${more ? '+' : ''} ${searching ? 'sonuç' : 'öğe'}`;

  /* Öğe sayısı DIŞARIYA da veriliyor: mobilde kartın başlığında ("Dosyalar") görünüyor, çünkü
     tam ekranda alt çubuk ekranın epey altında kalıyor ve sahibi sayıyı orada arıyor. */
  useEffect(() => {
    onMeta?.(meta);
  }, [meta, onMeta]);

  /**
   * Every folder the move picker must refuse — all of them, not the first.
   *
   * With a single id the picker only closed the door when the selection held exactly one folder.
   * Select two and the reader could walk INTO one source and press "Buraya taşı": `move` catches
   * a folder aimed at itself, and the server's `MoveIntoDescendantError` catches the rest with a
   * 409 — but by then the batch is half applied, the other rows sitting inside a folder that did
   * not move. Nothing is corrupted and the result is still not something to hand a reader.
   *
   * Spread rather than passed as `undefined`: `exactOptionalPropertyTypes`.
   */
  const moveExclude = ((): { excludeIds?: ReadonlySet<string> } => {
    if (modal.kind !== 'move') return {};
    const folders = modal.entries.filter((entry) => entry.kind === 'folder');
    return folders.length === 0 ? {} : { excludeIds: new Set(folders.map((entry) => entry.id)) };
  })();

  /**
   * The same exclusion for a copy, and it is not the same reason.
   *
   * A move into a selected folder is a cycle the row cannot be in. A COPY into one is worse than a
   * cycle: each step is a legal create, so nothing in the database stops it and the tree grows
   * until the dataset is full. The server refuses it with a 409; the picker refuses to offer it.
   */
  const copyExclude = ((): { excludeIds?: ReadonlySet<string> } => {
    if (modal.kind !== 'copy') return {};
    const folders = modal.entries.filter((entry) => entry.kind === 'folder');
    return folders.length === 0 ? {} : { excludeIds: new Set(folders.map((entry) => entry.id)) };
  })();

  return (
    <section
      // No `card` here, and that is the point. `App` mounts this screen inside `Win`, so a `.card`
      // put the file manager in a bordered, blurred, drop-shadowed panel floating inside another
      // bordered, blurred, drop-shadowed panel — two window frames around one window. The
      // reference never nests the two: there `.fm` IS the card, sitting in the left column in
      // place of the tiles. `.fm` alone is only display and flex, and `.wb > .fm` in the
      // stylesheet cancels the window body's padding so the columns keep their own 13px inset.
      className={picking ? 'fm on picking' : 'fm on'}
      style={dragOver ? DROP : undefined}
      onDragOver={(event) => {
        // Only a drag carrying files is an upload. Without the test, dragging a row from one
        // folder to another lights the whole card as a drop target and `preventDefault` here
        // would also make every square inch of it accept the row.
        if (!hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        if (!trashed) setDragOver(true);
      }}
      onDragLeave={(event) => {
        // Rows are children of the card, so crossing onto one fires `dragleave` on the card. If
        // the pointer is still somewhere inside, the highlight has to stay on or it strobes.
        const to = event.relatedTarget;
        if (!(to instanceof Node) || !event.currentTarget.contains(to)) setDragOver(false);
      }}
      onDrop={(event) => {
        if (!hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        setDragOver(false);
        // ── BIRAKILAN KLASÖR ARTIK GERÇEKTEN GEZİLİYOR ────────────────────────────────────
        // `dataTransfer.files` bir klasörü 0 BAYTLIK BİR DOSYA gibi veriyor. Eski hâl onun için
        // bir yükleme oturumu açıyor, tek bayt göndermiyor, yayım hiç olmuyor ve ekran
        // "Tatil 2025 yüklendi" diyordu — listede hiçbir şey yokken.
        //
        // Girdiler ŞİMDİ, senkron okunuyor: `dataTransfer` ilk `await`ten sonra boşalıyor ve
        // yürüyüş elinde boş bir listeyle kalırdı.
        const items = dropItems(event.dataTransfer);
        void (async () => {
          const { uploads, blind } = await collectDrop(items);
          if (blind > 0) {
            notify(
              'error',
              'Klasörler bu tarayıcıda sürüklenerek yüklenemiyor; "Yükle › Klasör yükle" kullanın.',
            );
          }
          if (uploads.length > 0) await runUploads(uploads);
        })();
      }}
    >
      {/* No `.ch` title row: the window this screen lives in already carries the glyph and the
          word "Dosyalar" in its own header, and repeating them two rows apart reads as a mistake.
          The one thing that row contributed — the item count — moved to the footer. */}
      {/* Only in the bin, and only for an administrator. The control that arms permanent
          deletion belongs on the screen showing the data it will delete — a settings pane would
          put it where its effect is invisible. */}
      {trashed && <TrashPolicyBar isAdmin={isAdmin} notify={notify} onChanged={reload} />}

      <div className="fbar" ref={bar}>
        <div className="search">
          <span style={{ color: 'var(--dim)', fontSize: 12 }} aria-hidden>
            ⌕
          </span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            // Inert in the trash rather than quietly searching somewhere else — see `searching`.
            disabled={trashed}
            placeholder={trashed ? 'Çöpte arama yapılamaz' : 'Dosya, klasör veya tür ara…'}
            aria-label="Ara"
          />
          {/* Kod okuyucu — kutunun İÇİNDE, girişin hemen sağında: mobilde arama zaten tam
              genişlik ilk satır, düğme düzeni bozmadan onun ucunda durur. */}
          <button
            type="button"
            className="qrbtn"
            disabled={trashed || scanBusy}
            title="QR kodu okut: kamera açılır, okunan kod aranır ve klasöre fotoğraf yüklemeye geçilir"
            aria-label="QR kodu okut ve fotoğraf yükle"
            onClick={() => {
              // Çözücüyü ŞİMDİ indirmeye başla: kullanıcı fotoğrafı çekerken modül yüklenir ve
              // çözme anında beklenecek tek şey çözmenin kendisi kalır.
              warmScanner();
              pickCode.current?.click();
            }}
          >
            {/* ── SİMGE DEĞİL, HARFLER ────────────────────────────────────────────────
                Kare kodu 18 piksele sığdırmanın iki denemesi de tutmadı: desen o boyda okunmuyor,
                geriye ne olduğu anlaşılmayan bir şekil kalıyor. "QR" iki harf ve herkesin tanıdığı
                bir kısaltma — küçük boyda bir simgenin yapamadığı şeyi yapıyor. */}
            QR
          </button>
        </div>
        <button
          type="button"
          className={picking ? 'mk act' : 'mk'}
          aria-pressed={picking}
          onClick={() => (picking ? stopPicking() : setPicking(true))}
        >
          ☑ Seç
        </button>
        {/* Izgara/liste. Tek düğme, iki durum: iki ayrı düğme çizmek, hangisinin AÇIK olduğunu
            renk farkına bırakırdı — düğmenin üstündeki simge zaten basıldığında ne olacağını
            söylüyor. */}
        <button
          type="button"
          className={layout === 'grid' ? 'mk act' : 'mk'}
          aria-pressed={layout === 'grid'}
          title={layout === 'grid' ? 'Liste görünümü' : 'Izgara görünümü'}
          onClick={() => setLayout((current) => (current === 'grid' ? 'list' : 'grid'))}
        >
          {layout === 'grid' ? '☰ Liste' : '▦ Izgara'}
        </button>
        {/* ── "TÜMÜNÜ SEÇ", VE SÖZÜ EKRANDAKİ KADAR ────────────────────────────────────────
            Yalnız seçim kipinde çiziliyor: kutular görünmezken "tümü" neyin tümü olduğunu
            söylemiyor. Kapsadığı şey EKRANDAKİ satırlar — klasör iki yüzden kalabalıksa devamı
            henüz getirilmemiş olabilir, ve o zaman düğme bunu `title`ında söylüyor. "Klasördeki
            her şey" demek, kullanıcının hiç görmediği satırları da işleme sokmak olurdu. */}
        {picking && (
          <button
            type="button"
            className="mk"
            disabled={entries === null || entries.length === 0}
            aria-pressed={allPicked}
            title={
              more
                ? 'Yüklenmiş satırların tümünü seçer; gerisi için önce "Daha fazla göster".'
                : 'Bu klasördeki her şeyi seçer.'
            }
            onClick={() => {
              setSel(allPicked ? new Set() : new Set((entries ?? []).map((row) => row.id)));
              rangeAnchor.current = null;
            }}
          >
            ☑ {allPicked ? 'Seçimi bırak' : 'Tümünü seç'}
          </button>
        )}
        {trashed ? (
          <button
            type="button"
            className="mk"
            disabled={busy || entries === null || entries.length === 0}
            onClick={() => setModal({ kind: 'empty-trash' })}
          >
            🗑 Çöpü boşalt
          </button>
        ) : (
          <button
            type="button"
            className="mk"
            disabled={busy}
            onClick={() => setModal({ kind: 'new-folder' })}
          >
            + Klasör
          </button>
        )}
        <button
          type="button"
          className="mk up"
          disabled={trashed || busy}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          ⤒ Yükle
        </button>

        <div className={menuOpen ? 'umenu on' : 'umenu'}>
          <button type="button" className="um" onClick={() => pickFile.current?.click()}>
            <span className="g" style={tint('cool')} aria-hidden>
              📄
            </span>
            <span>
              Dosya yükle<span className="sub">Tek veya çoklu dosya seçin</span>
            </span>
          </button>
          <button type="button" className="um" onClick={() => pickDir.current?.click()}>
            <span className="g" style={tint('iris')} aria-hidden>
              📁
            </span>
            <span>
              Klasör yükle<span className="sub">Klasör ağacıyla birlikte</span>
            </span>
          </button>
          <button type="button" className="um" onClick={() => pickPhoto.current?.click()}>
            <span className="g" style={tint('live')} aria-hidden>
              🖼
            </span>
            <span>
              Fotoğraf yükle<span className="sub">Galeri / Fotoğraflar · çoklu seçim</span>
            </span>
          </button>
        </div>

        <input ref={pickFile} type="file" multiple hidden onChange={(e) => chosen(e, false)} />
        <input ref={pickDir} type="file" multiple hidden onChange={(e) => chosen(e, true)} />
        <input
          ref={pickPhoto}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => chosen(e, false)}
        />
        {/* Kod karesi. `capture` telefonda doğrudan kamerayı açar — web kamera izni istemez ve
            kendinden imzalı sertifikayı umursamaz; sayfa içi canlı kameranın Android'de sessizce
            reddedilmesinin cevabı buydu. Masaüstünde sıradan bir dosya seçici olur, yani elde
            duran bir barkod fotoğrafı da okunur. */}
        <input
          ref={pickCode}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Aynı kare ikinci kez seçilebilsin: value temizlenmezse change bir daha düşmez.
            event.target.value = '';
            if (file !== undefined) void runCodeShortcut(file);
          }}
        />
      </div>

      <div className="addr">
        <span className="nav">
          <button
            type="button"
            title="Geri"
            aria-label="Geri"
            disabled={pos === 0}
            onClick={() => jump(pos - 1)}
          >
            ←
          </button>
          <button
            type="button"
            title="İleri"
            aria-label="İleri"
            disabled={pos >= history.length - 1}
            onClick={() => jump(pos + 1)}
          >
            →
          </button>
          <button
            type="button"
            title="Yukarı"
            aria-label="Yukarı"
            disabled={trashed || trail.length === 0}
            onClick={() => go({ trashed: false, trail: trail.slice(0, -1) })}
          >
            ↑
          </button>
        </span>
        <span className="path">
          {/* The address this appliance was actually reached at. The reference hard-codes
              "depsis.local" because it is a mock-up; nothing in the contract publishes a hostname,
              and a home NAS is normally opened by IP — so the one fixed label on the file manager
              would have disagreed with the address bar on almost every install. */}
          <button type="button" onClick={() => go(ROOT)}>
            {window.location.host}
          </button>
          {trashed ? (
            <>
              {' / '}
              <b>Çöp</b>
            </>
          ) : trail.length === 0 ? (
            <>
              {' / '}
              <b>Dosyalarım</b>
            </>
          ) : (
            <>
              {' / '}
              <button type="button" onClick={() => go(ROOT)}>
                Dosyalarım
              </button>
              {trail.map((crumb, index) => (
                <Fragment key={crumb.id}>
                  {' / '}
                  {index === trail.length - 1 ? (
                    <b>{crumb.name}</b>
                  ) : (
                    <button
                      type="button"
                      onClick={() => go({ trashed: false, trail: trail.slice(0, index + 1) })}
                    >
                      {crumb.name}
                    </button>
                  )}
                </Fragment>
              ))}
            </>
          )}
        </span>
      </div>

      {shares !== null && shares.length > 1 && (
        <div className="netrow" style={{ marginBottom: 10 }}>
          <span className="lbl">Paylaşım</span>
          <select
            className="b"
            aria-label="Hangi paylaşım"
            value={shareId ?? ''}
            onChange={(event) => {
              // The folder trail belongs to the old share — a parent id from it would 404 against
              // the new one, and a breadcrumb pointing at a folder in another share is worse than
              // no breadcrumb. Going home is the only honest reset.
              setShareId(event.target.value === '' ? undefined : event.target.value);
              go(ROOT);
            }}
          >
            <option value="">Varsayılan</option>
            {shares.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* "Geçmiş sürümler" düğmesi buradan KALDIRILDI, sahibinin kararıyla: çöp kutusu ve
          Yedekleme ekranı aynı soruyu zaten cevaplıyor ve üçüncü bir kapı yalnız kafa
          karıştırıyordu. History penceresi kodda duruyor; gerekirse Yedekleme'den yaşar. */}

      <div className="quick">
        {/* ── EV BİR SİMGE, BİR BAŞLIK DEĞİL ─────────────────────────────────────────────
            "Dosyalarım" yazısı şeridin yarısını kaplıyordu ve söylediği şey kullanıcının zaten
            bildiği bir şeydi: açtığı ekranın adı. Yerine kalan genişlik favorilere gidiyor —
            yani kullanıcının kendi seçtiği yerlere. */}
        <button
          type="button"
          className={!trashed ? 'qf ic on' : 'qf ic'}
          onClick={() => go(ROOT)}
          title="Dosyalarım"
          aria-label="Dosyalarım"
        >
          <span className="g" style={tint('iris', 0.2)} aria-hidden>
            🏠
          </span>
        </button>

        {/* ── FAVORİLER ──────────────────────────────────────────────────────────────────
            Adın yalnız ilk yedi harfi. Bir şeridin işi tanıtmak, okutmak değil: yedi harf
            kullanıcının kendi koyduğu bir adı tanımasına yetiyor, tam ad ise iki favoriden
            sonra şeridi bitiriyordu. Tam adı `title` taşıyor. */}
        {favorites.map((fav) => (
          <button
            key={fav.id}
            type="button"
            className="qf sm"
            title={fav.name}
            onClick={() => go({ trashed: false, trail: fav.trail })}
          >
            <span className="g" style={tint('warn', 0.2)} aria-hidden>
              ★
            </span>
            <span className="l">{shortName(fav.name)}</span>
          </button>
        ))}
        {/* Çöp ve Yedekler KÜÇÜK ve SAĞDA — sahibin sözü. Asıl kapı Dosyalarım; bu ikisi
            başvurulan yerler, ve mobilde koca bir ikinci satır olarak taşmamalılar. */}
        <span className="qsp" aria-hidden />
        <button
          type="button"
          className={trashed ? 'qf sm on' : 'qf sm'}
          onClick={() => go({ trashed: true, trail: [] })}
        >
          <span className="g" style={tint('rose', 0.18)} aria-hidden>
            🗑
          </span>
          <span className="l">Çöp</span>
          <span className="c">{counts.trash ?? '—'}</span>
        </button>
        {/* YEDEK DİSKİ YOKSA VE GERİ DÖNÜLECEK NOKTA YOKSA HİÇ ÇİZİLMİYOR — kapalı bir düğme
            olarak değil, hiç. Kapalı bir düğme "bir gün burada bir şey olacak" diyor ve
            kullanıcıyı onu açmanın yolunu aramaya gönderiyor; olmayan bir düğme hiçbir şey vaat
            etmiyor. Disk takıldığında ve ilk anlık görüntü alındığında kendiliğinden beliriyor. */}
        {backupDisk && restorable && (
          <button
            type="button"
            className="qf sm"
            disabled={shares === null || shares.length === 0}
            title="Bu paylaşımın yedeklerine (anlık görüntülerine) göz at"
            onClick={() => {
              // Yedekler paylaşıma göre saklanıyor, ve "Varsayılan" seçiliyken hangi paylaşımın
              // kastedildiğini bu ekran bilmiyor. Bir paylaşım tahmin edip onun görüntülerini
              // açmak, geri yüklemeyi yanlış paylaşımın köküne göndermek demekti.
              if (currentShare === null) {
                notify(
                  'error',
                  'Önce yukarıdan bir paylaşım seçin: yedekler paylaşıma göre tutulur.',
                );
                return;
              }
              setBackups(true);
            }}
          >
            <span className="g" style={tint('cool', 0.2)} aria-hidden>
              🕘
            </span>
            <span className="l">Yedekler</span>
          </button>
        )}
      </div>

      {scanBusy && (
        <div className="scanbar" role="status" aria-live="polite">
          <span className="sp" aria-hidden />
          Kod okunuyor…
        </div>
      )}

      {photoPrompt !== null && (
        <div className="scanbar act">
          <span className="tx">
            📷 <b>{photoPrompt}</b> klasörüne fotoğraf yükleyin
          </span>
          <button
            type="button"
            className="b pri"
            onClick={() => {
              setPhotoPrompt(null);
              pickPhoto.current?.click();
            }}
          >
            Fotoğrafları seç
          </button>
          <button type="button" className="lnk" onClick={() => setPhotoPrompt(null)}>
            Kapat
          </button>
        </div>
      )}

      <div className={sel.size > 0 ? 'selbar on' : 'selbar'}>
        <span className="n">{sel.size} seçili</span>
        {/* Every one of these is gated on `selected.length` as well as on `busy`. The selection
            bar is driven by `sel`, which the listing effect clears only AFTER the response lands,
            while `entries` is emptied the moment the request goes out — so during any re-list the
            bar was still lit over a `selected` that had already become []. Pressing "Kalıcı sil"
            there opened the one dialog in the appliance that must never be vague with no number
            in it at all, and confirming it did nothing and said nothing. */}
        {trashed ? (
          <>
            <button
              type="button"
              className="sb"
              disabled={busy || selected.length === 0}
              onClick={() => void restore(selected)}
            >
              ↺ Geri al
            </button>
            <button
              type="button"
              className="sb dl"
              disabled={busy || selected.length === 0 || !selected.every((e) => can(e, 'delete'))}
              onClick={() => openOn('permanent', selected)}
            >
              ✕ Kalıcı sil
            </button>
          </>
        ) : (
          <>
            {/* ONE folder, and only a folder. Permissions are set on folders — a file inherits
                the one it sits in, which is what `NotAFolderError` says at the endpoint — and a
                panel that opened for a multi-selection would have to invent a meaning for
                "the permissions of these four things". */}
            <button
              type="button"
              className="sb"
              disabled={busy || selected.length !== 1 || selected[0]?.kind !== 'folder'}
              onClick={() => {
                const only = selected[0];
                if (only !== undefined) {
                  setPermissionsFor({ kind: 'entry', id: only.id, name: only.name });
                }
              }}
            >
              🔑 İzinler
            </button>
            <button
              type="button"
              className="sb"
              disabled={!selected.some((entry) => can(entry, 'download')) || busy}
              onClick={() => download(selected)}
            >
              ⤓ İndir
            </button>
            <button
              type="button"
              className="sb"
              disabled={busy || selected.length === 0 || !selected.every((e) => can(e, 'move'))}
              onClick={() => openOn('move', selected)}
            >
              ⇄ Taşı
            </button>
            {/* `download` and not `read`, matching what the endpoint enforces: `read` is metadata,
                and a copy takes the contents. The server refuses either way; the button being
                disabled is what stops somebody clicking into a 403 they cannot act on. */}
            <button
              type="button"
              className="sb"
              disabled={busy || selected.length === 0 || !selected.every((e) => can(e, 'download'))}
              onClick={() => openOn('copy', selected)}
            >
              ⧉ Kopyala
            </button>
            {/* İş panosuyla köprü: bağ arka uçta aylardır vardı (panodaki 🗂 rozeti onu sayıyor)
                ama BAĞLAYAN bir kapı yoktu. Bağlamak dosyayı taşımaz, kopyalamaz — işin
                tartışmasında bir işaret açar. */}
            <button
              type="button"
              className="sb"
              disabled={busy || selected.length === 0}
              onClick={() => {
                setLinking({ entries: selected, tasks: null });
                void (async () => {
                  const { data } = await api.GET('/tasks', {});
                  setLinking((current) =>
                    current === null
                      ? current
                      : {
                          ...current,
                          tasks: (data?.items ?? [])
                            .filter((t) => t.status !== 'done' && t.status !== 'cancelled')
                            .map((t) => ({ id: t.id, body: t.body })),
                        },
                  );
                })();
              }}
            >
              ✓ İşe bağla
            </button>
            <button
              type="button"
              className="sb dl"
              disabled={busy || selected.length === 0 || !selected.every((e) => can(e, 'delete'))}
              onClick={() => openOn('trash', selected)}
            >
              🗑 Çöpe at
            </button>
          </>
        )}
        <button type="button" className="sb" onClick={stopPicking}>
          Vazgeç
        </button>
      </div>

      {progress !== null && (
        // `.prog` carries no padding of its own — it is used inside padded panels elsewhere — and
        // the file manager's columns are inset by 13px, so the row is aligned to them here.
        <div className="prog" role="status" style={{ padding: '0 13px 9px' }}>
          <span>{progress.label}</span>
          <Bar ratio={progress.percent / 100} label={progress.label} />
          <em>%{progress.percent}</em>
        </div>
      )}

      {/* ── SÜTUN BAŞLIKLARI ────────────────────────────────────────────────────────────
          Sahibin istediği şey: *"boyut kısmının üstünde bir buton boyuta göre sıralayacak,
          tarihteki tarihe göre falan — tıpkı windows dosya gezgini gibi."*

          BAŞLIKLAR SATIRIN KENDİ SÜTUNLARIYLA AYNI SINIFI TAŞIYOR (`.sz`, `.dt`), yani genişlik
          tek bir yerde tanımlı ve ikisi birlikte kayıyor. Ayrı genişlikler yazmak, başlığın bir
          gün satırın yarım santim solunda durması demekti.

          "Tür" simgenin üstünde: satırdaki küçük resim/simge zaten türü gösteren sütun, ve ona
          ayrı bir metin sütunu eklemek dar ekranda addan yer çalardı.

          Çöpte ve aramada çizilmiyor: ikisi de sıralanabilir bir klasör değil. Izgarada da yok —
          orada sütun diye bir şey yok. */}
      {!trashed && !searching && layout === 'list' && (
        <div className="fhead">
          <span className="pad" aria-hidden />
          <SortHead label="Tür" sort="type" active={order} dir={dir} onPick={pickSort} narrow />
          <SortHead label="Ad" sort="name" active={order} dir={dir} onPick={pickSort} grow />
          <SortHead
            label="Boyut"
            sort="size"
            active={order}
            dir={dir}
            onPick={pickSort}
            cell="sz"
          />
          <SortHead
            label="Tarih"
            sort="modified"
            active={order}
            dir={dir}
            onPick={pickSort}
            cell="dt"
          />
        </div>
      )}

      {/* Izgara sınıfı yalnız ÇİZİLECEK SATIR VARKEN: boş hâl ve hata kutusu da bu kabın çocuğu,
          ve bir ızgara hücresine sıkışmış "Bu klasör boş" kutusu, düzeltmeden kötü. */}
      <div
        className={
          layout === 'grid' && entries !== null && entries.length > 0 ? 'flist gridview' : 'flist'
        }
      >
        {listFailed ? (
          <Empty
            glyph="⚠"
            text={searching ? 'Arama yapılamadı.' : 'Klasör okunamadı.'}
            action={
              <button type="button" className="mk" onClick={reload}>
                Yeniden dene
              </button>
            }
          />
        ) : entries === null ? (
          <Empty glyph="⋯" text="Yükleniyor…" />
        ) : entries.length === 0 ? (
          <Empty
            glyph={searching ? '⌕' : trashed ? '🗑' : '🗂'}
            text={
              searching
                ? 'Eşleşen bir şey bulunamadı.'
                : trashed
                  ? 'Çöp kutusu boş.'
                  : 'Bu klasör boş. Dosyaları buraya sürükleyin.'
            }
            action={
              searching || trashed ? undefined : (
                <button type="button" className="mk up" onClick={() => pickFile.current?.click()}>
                  ⤒ Dosya seç
                </button>
              )
            }
          />
        ) : (
          entries.map((entry) => {
            const type = typeOf(entry);
            /** Bu satır önizlenebiliyorsa NASIL — düğmenin hem varlığı hem davranışı buradan. */
            const shows = previewAs(entry);
            const chosenRow = sel.has(entry.id);
            const opens = !picking && !trashed && entry.kind === 'folder';
            const activate = (modifiers: Modifiers): void => {
              if (picking) {
                toggle(entry.id, modifiers);
                return;
              }
              if (!opens) return;
              if (searching) void openFound(entry);
              else go({ trashed: false, trail: [...trail, { id: entry.id, name: entry.name }] });
            };
            const clickable = picking || opens;

            /* A row can be dragged into a folder row. Not in the bin — a trashed entry has no
               place in the tree to be moved to — not while a long operation is running, and not
               if the server would refuse the move anyway. */
            const draggable = !trashed && !busy && can(entry, 'move');
            const dragging = drag?.has(entry.id) === true;
            const target =
              drag !== null && !trashed && entry.kind === 'folder' && !drag.has(entry.id);

            const classes = ['frow'];
            if (chosenRow) classes.push('sel');
            if (dragging) classes.push('drag');
            if (over === entry.id) classes.push('over');

            return (
              <div
                key={entry.id}
                className={classes.join(' ')}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                style={clickable ? { cursor: 'pointer' } : undefined}
                draggable={draggable}
                onDragStart={(event) => {
                  if (!draggable) return;
                  // A drag begun on a row that is part of the selection carries the whole
                  // selection; one begun outside it carries that row alone. Anything else moves
                  // rows the user did not mean to touch, and a move is not undoable here.
                  const ids = sel.has(entry.id) ? new Set(sel) : new Set([entry.id]);
                  setDrag(ids);
                  event.dataTransfer.effectAllowed = 'move';
                  // Some browsers cancel a drag whose transfer is empty before it begins.
                  event.dataTransfer.setData('text/plain', entry.name);
                }}
                onDragEnd={() => {
                  setDrag(null);
                  setOver(null);
                }}
                onDragOver={(event) => {
                  if (!target) return;
                  // Stops the card underneath from treating this as a drop of its own.
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = 'move';
                  setOver(entry.id);
                }}
                onDragLeave={() => setOver((current) => (current === entry.id ? null : current))}
                onDrop={(event) => {
                  if (!target || drag === null) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const moving = (entries ?? []).filter((row) => drag.has(row.id));
                  setDrag(null);
                  setOver(null);
                  if (moving.length === 0) return;
                  // One row is a gesture aimed at one thing, and the toast afterwards names where
                  // it went. A batch is not: a drag begun on a selected row carries the WHOLE
                  // selection, so a small slip with fifty rows ticked would relocate all fifty on
                  // one unanswered gesture. Every other route to this operation states its count
                  // first, and this one has to as well.
                  if (moving.length === 1) void move(moving, entry.id, entry.name);
                  else setModal({ kind: 'move-drop', entries: moving, target: entry });
                }}
                onClick={clickable ? (event) => activate(mods(event)) : undefined}
                onKeyDown={
                  clickable
                    ? (event) => {
                        // A div with a click handler is invisible to the keyboard; Space also has
                        // to be swallowed or the list scrolls out from under the row.
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        // Shift+Enter de bir aralık: klavyeyle gezen biri aynı işi yapabilmeli.
                        activate(mods(event));
                      }
                    : undefined
                }
              >
                <button
                  type="button"
                  className={chosenRow ? 'ck on' : 'ck'}
                  aria-label={`${entry.name} seç`}
                  aria-pressed={chosenRow}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggle(entry.id, mods(event));
                  }}
                >
                  ✓
                </button>
                <Thumb entry={entry} tone={type.tone} glyph={type.glyph} />
                <span className="n" title={entry.name}>
                  {entry.name}
                </span>
                {/* ── KLASÖRDE BOYUT YERİNE İÇİNDEKİLER ────────────────────────────────
                    Bir klasörün "boyutu" ekranda hep "—" idi: doğru ama işe yaramaz. Kullanıcının
                    sorduğu şey içinde ne olduğu, ve "boş" da bir cevap — silmeden önce bakılan tek
                    şey çoğu zaman bu. Sayım bin ile sınırlı, o yüzden bin gören "1000+" yazıyor. */}
                <span className="sz">
                  {entry.kind !== 'folder' ? formatBytes(entry.size) : folderMeta(entry)}
                </span>
                {/* ── DEĞİŞME TARİHİ ────────────────────────────────────────────────────
                    Sunucu bu alanı zaten her satırda gönderiyordu ve ekran onu hiç çizmiyordu.
                    Bir dosya listesinde "hangisi yeni" sorusunun cevabı boyuttan önce gelir.

                    Dar ekranda gizleniyor (stil sayfası): 360 pikselde ad, boyut ve tarih yan
                    yana durmuyor, ve üçünden feda edilecek olan ad değil. */}
                <span className="dt" title={new Date(entry.modifiedAt).toLocaleString('tr')}>
                  {new Date(entry.modifiedAt).toLocaleDateString('tr')}
                </span>
                {/* Only when the server sent one. Its absence means "not scheduled to go" — either
                    no policy is set, or this row sits inside a trashed folder and dies on that
                    folder's date rather than its own. Inventing a date here would be a countdown
                    the purge does not honour. */}
                {entry.expiresAt !== undefined && (
                  <span className="sz" title="Kalıcı olarak silineceği tarih">
                    ⏳ {new Date(entry.expiresAt).toLocaleDateString('tr')}
                  </span>
                )}

                {/* The row itself is clickable while picking, so the actions have to swallow the
                    click or renaming a file would also select it. */}
                <div className="fact" onClick={(event) => event.stopPropagation()}>
                  {trashed ? (
                    <>
                      <button
                        type="button"
                        title="Geri al"
                        aria-label={`${entry.name} geri al`}
                        disabled={busy}
                        onClick={() => void restore([entry])}
                      >
                        ↺
                      </button>
                      <span className="gap" aria-hidden />
                      {can(entry, 'delete') && (
                        <button
                          type="button"
                          className="del"
                          title="Kalıcı sil"
                          aria-label={`${entry.name} kalıcı olarak sil`}
                          disabled={busy}
                          onClick={() => openOn('permanent', [entry])}
                        >
                          ✕
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      {/* ── YILDIZ: YALNIZ KLASÖRLERDE ─────────────────────────────────
                          Şerit gidilecek YERLERİ tutuyor; bir dosya bir yer değil, ve onu
                          şeride koymak tıklandığında ne olacağı belli olmayan bir düğme
                          üretirdi. Tercihler okunmadıysa düğme hiç çizilmiyor: kaydedilemeyecek
                          bir işi teklif etmemek, teklif edip sonra düşmekten iyidir. */}
                      {entry.kind === 'folder' && canFavorite && (
                        <button
                          type="button"
                          className={isFavorite(entry.id) ? 'fav on' : 'fav'}
                          title={isFavorite(entry.id) ? 'Favorilerden çıkar' : 'Favorilere ekle'}
                          aria-label={
                            isFavorite(entry.id)
                              ? `${entry.name} favorilerden çıkar`
                              : `${entry.name} favorilere ekle`
                          }
                          aria-pressed={isFavorite(entry.id)}
                          onClick={() =>
                            void toggleFavorite({ id: entry.id, name: entry.name }, [
                              ...trail,
                              { id: entry.id, name: entry.name },
                            ])
                          }
                        >
                          {isFavorite(entry.id) ? '★' : '☆'}
                        </button>
                      )}
                      {can(entry, 'move') && (
                        <button
                          type="button"
                          title="Taşı"
                          aria-label={`${entry.name} taşı`}
                          disabled={busy}
                          onClick={() => openOn('move', [entry])}
                        >
                          ⇄
                        </button>
                      )}
                      {/* `download`, `read` DEĞİL: önizleme de içeriği okuyor ve uç tam olarak o
                          izni istiyor. Onsuz düğme bir 403 açardı — PDF'te bir sekme dolusu hata
                          gövdesi olarak. §6.2: sunucunun reddedeceği bir şey teklif edilmiyor. */}
                      {shows !== null && can(entry, 'download') && (
                        <button
                          type="button"
                          // PDF pencerede DEĞİL, yeni bir sekmede açılıyor ve düğme bunu önceden
                          // söylüyor: sekmenin habersiz açılması tıklamanın kaçırılmasıdır.
                          title={shows === 'pdf' ? 'Yeni sekmede görüntüle' : 'Görüntüle'}
                          aria-label={`${entry.name} görüntüle`}
                          onClick={() => (shows === 'pdf' ? openPdfTab(entry) : setPreview(entry))}
                        >
                          👁
                        </button>
                      )}
                      {can(entry, 'download') && (
                        <button
                          type="button"
                          title={entry.kind === 'folder' ? 'Arşiv olarak indir' : 'İndir'}
                          aria-label={`${entry.name} indir`}
                          onClick={() => download([entry])}
                        >
                          ⤓
                        </button>
                      )}
                      {can(entry, 'modify') && (
                        <button
                          type="button"
                          title="Ad değiştir"
                          aria-label={`${entry.name} adını değiştir`}
                          disabled={busy}
                          onClick={() => setModal({ kind: 'rename', entry })}
                        >
                          ✎
                        </button>
                      )}
                      <span className="gap" aria-hidden />
                      {can(entry, 'delete') && (
                        <button
                          type="button"
                          className="del"
                          title="Çöpe at"
                          aria-label={`${entry.name} çöpe at`}
                          disabled={busy}
                          onClick={() => openOn('trash', [entry])}
                        >
                          🗑
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
        {/* ── LİSTENİN DEVAMI ──────────────────────────────────────────────────────────────
            Üçlü koşulun DIŞINDA ve listenin altında: gösterilecek satır varsa devamının da bir
            yolu olmalı, ve o yol sayfanın sonunda durmalı — kullanıcının "hepsi bu mu" diye
            sorduğu yerde.

            Sonsuz kaydırma DEĞİL. Kendiliğinden yüklenen bir liste alt bilgiyi (depolama özeti,
            sayaç, sıralama seçicisi) her seferinde bir sayfa daha aşağı iterek ulaşılamaz kılar,
            ve kullanıcı listenin bittiğini hiçbir zaman göremez.

            İMLEÇSİZ ÇİZİLMİYOR: `hasMore` doğru ama imleç yoksa basılacak bir şey de yok, ve
            kapalı duran bir düğme hiç olmayandan kötü — bir şey vaat edip vermez. Liste
            yenilenirken (`entries === null`) de yok: bir önceki klasörden kalan `hasMore`,
            "Yükleniyor…" yazısının altında bir düğme bırakırdı. */}
        {more && cursor !== undefined && entries !== null && entries.length > 0 && (
          <div
            className="fmore"
            style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 14px' }}
          >
            <button type="button" className="mk" disabled={paging} onClick={() => void loadMore()}>
              {paging ? 'Yükleniyor…' : 'Daha fazla göster'}
            </button>
          </div>
        )}
      </div>

      <div className="ffoot">
        <span className="info">{storage ?? '…'}</span>
        {/* ── SIRALAMA, SAYACIN YANINDA ────────────────────────────────────────────────────
            Bir GÖRÜNÜM ayarı, bir araç değil: yükleme ve silme düğmelerinin arasında dursaydı
            her ikisiyle karıştırılırdı. Alt çubuk zaten görünümün özeti — "48 öğe" — ve sıra
            oraya ait.

            ADRES ÇUBUĞUNDA DEĞİL, ve bu ÖLÇÜLDÜ. Orada duran seçici `.path`i daraltıyordu; 360
            piksellik bir ekranda kırıntı yolu kırpılıyor, ve kırpılan düğmenin merkezine yapılan
            tıklama düğmeye değil onu kırpan `.path`e düşüyordu — yani "Dosyalarım"a basılamaz
            oluyordu. Alt çubuk dar ekranda alt satıra sarıyor (`flex-wrap`), yani kimseden
            genişlik çalmıyor.

            Çöpte ve aramada gizli: ikisi de sıralanabilir bir klasör değil, ve olmayan bir
            seçeneği kapalı göstermek de bir şey vaat etmek olurdu. */}
        <span className="val">{meta}</span>
      </div>

      {/* ── ÇAKIŞMA BİR SORU, BİR HATA DEĞİL ────────────────────────────────────────────
          Baytlar sunucuda ve duruyor; eksik olan tek şey kullanıcının kararı. İki seçenek de
          veri kaybetmiyor: "değiştir" eskisini silmiyor, çöp kutusuna atıyor — üzerine yazmak
          ürünün hiçbir katmanında yok (ADR-0008) ve "değiştir" diyen kişinin istediği şey yeni
          dosyanın o adı alması, eskisinin geri getirilemez olması değil. */}
      {clash !== null && (
        <ConfirmBox
          title="Aynı adda bir dosya var"
          body={
            `"${clash.filename}" adında bir dosya bu klasörde zaten duruyor. Yüklediğiniz dosya ` +
            'sunucuda bekliyor, yeniden gönderilmeyecek. "Değiştir" eskisini silmez, çöp ' +
            'kutusuna atar.'
          }
          yesLabel="İkisini de tut"
          onYes={() => void resolveClash('keep-both')}
          onNo={() => setClash(null)}
        />
      )}
      {clash !== null && (
        <div className="clashalt">
          <button type="button" className="b" onClick={() => void resolveClash('replace')}>
            Değiştir (eskisi çöpe)
          </button>
        </div>
      )}

      {preview !== null && <Preview entry={preview} onClose={() => setPreview(null)} />}

      {modal.kind === 'new-folder' && (
        <PromptBox
          title="Yeni klasör"
          label="Klasör adı"
          confirmLabel="Oluştur"
          onSubmit={(name) => void createFolder(name)}
          onCancel={() => setModal({ kind: 'none' })}
        />
      )}
      {modal.kind === 'rename' && (
        <PromptBox
          title="Yeniden adlandır"
          label="Yeni ad"
          initial={modal.entry.name}
          confirmLabel="Kaydet"
          onSubmit={(name) => void rename(modal.entry, name)}
          onCancel={() => setModal({ kind: 'none' })}
        />
      )}
      {modal.kind === 'trash' && (
        <ConfirmBox
          title="Çöp kutusuna taşı"
          // Saying what actually happens, because "silindi" and "çöpe atıldı" look identical from
          // the outside and only one of them can be undone.
          body="Seçilenler listeden kalkacak ve Çöp'te durmaya devam edecek. Baytlar silinmiyor — çöpü boşaltmak ayrı bir karar."
          list={modal.entries.map((entry) => entry.name)}
          yesLabel="Çöpe at"
          danger
          onYes={() => void trash(modal.entries)}
          onNo={() => setModal({ kind: 'none' })}
        />
      )}
      {modal.kind === 'permanent' && (
        <ConfirmBox
          title="Kalıcı olarak sil"
          // The count comes first and the warning is shouted, because this is the one dialog in
          // the appliance whose "evet" cannot be taken back. "Emin misiniz?" tells the reader
          // nothing about what they are about to lose; "3 dosya ve 1 klasör" tells them everything.
          body={`${tally(modal.entries)} diskten silinecek. BU İŞLEM GERİ ALINAMAZ — çöp kutusundan geri getirilemez. Klasörler içindekilerle birlikte, alttan yukarı silinir; işlem yarıda kesilirse silinenler silinmiş kalır ve kalanlar çöpte durmaya devam eder.`}
          list={destroyList(modal.entries, childCounts)}
          yesLabel="Kalıcı olarak sil"
          danger
          onYes={() => void permanentDelete(modal.entries, 'Kalıcı siliniyor')}
          onNo={() => setModal({ kind: 'none' })}
        />
      )}
      {modal.kind === 'empty-trash' && (
        <ConfirmBox
          title="Çöpü boşalt"
          body={`Çöpteki ${tally(entries ?? [])}${more ? ' (ve bu sayfaya sığmayanlar)' : ''} diskten silinecek. BU İŞLEM GERİ ALINAMAZ. Öğeler tek tek silinir; yarıda kesilirse silinenler gitmiş olur, kalanlar çöpte durur ve boşaltmayı yinelemek kaldığı yerden devam eder.`}
          list={destroyList(entries ?? [], childCounts)}
          yesLabel="Çöpü boşalt"
          danger
          onYes={() => void emptyTrash()}
          onNo={() => setModal({ kind: 'none' })}
        />
      )}
      {modal.kind === 'move' && (
        <FolderPicker
          title={
            modal.entries.length === 1 && modal.entries[0] !== undefined
              ? `"${modal.entries[0].name}" nereye taşınsın?`
              : `${modal.entries.length} öğe nereye taşınsın?`
          }
          {...moveExclude}
          {...(shareId === undefined ? {} : { shareId })}
          {...(currentShare === null ? {} : { shareName: currentShare.name })}
          confirmLabel="Buraya taşı"
          onPick={(destination, where) => void move(modal.entries, destination, where)}
          onCancel={() => setModal({ kind: 'none' })}
        />
      )}
      {modal.kind === 'copy' && (
        <FolderPicker
          title={
            modal.entries.length === 1 && modal.entries[0] !== undefined
              ? `"${modal.entries[0].name}" nereye kopyalansın?`
              : `${modal.entries.length} öğe nereye kopyalansın?`
          }
          {...copyExclude}
          {...(shareId === undefined ? {} : { shareId })}
          {...(currentShare === null ? {} : { shareName: currentShare.name })}
          confirmLabel="Buraya kopyala"
          onPick={(destination, where) => void copy(modal.entries, destination, where)}
          onCancel={() => setModal({ kind: 'none' })}
        />
      )}
      {modal.kind === 'move-drop' && (
        <ConfirmBox
          title="Taşımayı onaylayın"
          // The count and the destination, both, because a drop chose the destination by pointer
          // and a move has no undo: the only two facts the reader needs before saying evet are how
          // many rows are about to leave and which folder they are about to be in.
          body={`${tally(modal.entries)} "${modal.target.name}" klasörüne taşınacak. Taşımanın geri alması yoktur — geri getirmek için aynı öğeleri elle geri taşımanız gerekir.`}
          list={nameList(modal.entries)}
          yesLabel="Taşı"
          onYes={() => void move(modal.entries, modal.target.id, modal.target.name)}
          onNo={() => setModal({ kind: 'none' })}
        />
      )}

      {linking !== null && (
        <Win title="İşe bağla" glyph="✓" tone="live" onClose={() => setLinking(null)}>
          <p className="note">
            {linking.entries.length} öge seçili. Bağ, dosyayı taşımaz — işin tartışmasında
            &quot;bağlı dosyalar&quot; olarak görünür ve panodaki 🗂 sayacına işler.
          </p>
          {linking.tasks === null && <p className="note">İşler okunuyor…</p>}
          {linking.tasks !== null && linking.tasks.length === 0 && (
            <Empty glyph="✓" text="Açık iş yok — önce İşler panosunda bir iş açın." />
          )}
          {(linking.tasks ?? []).map((task) => (
            <button
              key={task.id}
              type="button"
              className="pm"
              style={{ width: '100%', textAlign: 'left' }}
              disabled={busy}
              onClick={() => {
                const chosenEntries = linking.entries;
                setLinking(null);
                void (async () => {
                  let failedCount = 0;
                  for (const entry of chosenEntries) {
                    const { response } = await api.POST('/tasks/{id}/files', {
                      params: { path: { id: task.id } },
                      body: { fileEntryId: entry.id },
                    });
                    if (!response.ok) failedCount += 1;
                  }
                  if (failedCount > 0) {
                    notify('error', `${failedCount} öge bağlanamadı (belki zaten bağlıydı).`);
                  } else {
                    notify(
                      'ok',
                      `${chosenEntries.length} öge "${task.body.slice(0, 40)}" işine bağlandı.`,
                    );
                  }
                  stopPicking();
                })();
              }}
            >
              {task.body.length <= 70 ? task.body : `${task.body.slice(0, 69)}…`}
            </button>
          ))}
        </Win>
      )}

      {backups && currentShare !== null && (
        <History
          shareId={currentShare.id}
          shareName={currentShare.name}
          destinationId={parentId ?? null}
          destinationLabel={last?.name ?? 'paylaşımın kökü'}
          onClose={() => setBackups(false)}
          onRestored={() => {
            setBackups(false);
            reload();
          }}
          notify={notify}
        />
      )}

      {permissionsFor !== null && (
        <Permissions
          target={permissionsFor}
          notify={notify}
          onClose={() => setPermissionsFor(null)}
          onUnauthenticated={onUnauthenticated}
        />
      )}
    </section>
  );
}

/* ─── satır küçük resmi ─────────────────────────────────────────────────────── */

/**
 * Yalnız JPEG soruluyor.
 *
 * Uç, JPEG'in EXIF'ine GÖMÜLÜ küçük resmi çıkarıyor; PNG, WebP ve GIF öyle bir şey taşımıyor, yani
 * onlar için istek her zaman 204 dönerdi. Uzantıya bakıp hiç sormamak, bir klasör açılışında
 * yüzlerce boş gidiş dönüşü ortadan kaldırıyor.
 *
 * Uzantı, `mimeType` DEĞİL: sözleşmede o alan isteğe bağlı ve ajan her zaman doldurmuyor, yani ona
 * bakan bir kontrol aynı dosyayı bazen soruyor bazen sormuyor olurdu. `typeOf` da aynı sebeple
 * uzantıya bakıyor.
 */
const THUMBNAILED = new Set(['jpg', 'jpeg']);

/**
 * EXIF yönlendirmesinin (1–8) CSS karşılığı.
 *
 * Gömülü küçük resim ana görüntüyle aynı yönde saklanıyor, ve sunucu pikselleri çevirmiyor —
 * çevirmek, o ucun var olma sebebi olan "hiçbir şeyin kodunu çözme" kuralını bozardı. Döndürme
 * burada, bir dönüşüm olarak: bedava, ve kare zaten `object-fit: cover`.
 *
 * Aynalanan hâller (2, 4, 5, 7) fotoğraf makinelerinde neredeyse hiç görülmüyor ama tanımlı, ve
 * atlanmış bir değer sessizce yan yatmış bir fotoğraf demek.
 */
const ORIENTATION: Record<string, string> = {
  '2': 'scaleX(-1)',
  '3': 'rotate(180deg)',
  '4': 'scaleY(-1)',
  '5': 'rotate(90deg) scaleX(-1)',
  '6': 'rotate(90deg)',
  '7': 'rotate(270deg) scaleX(-1)',
  '8': 'rotate(270deg)',
};

/**
 * Satırın solundaki kare: küçük resim varsa o, yoksa tür simgesi.
 *
 * `fetch`, `<img src>` DEĞİL. Bir `<img>`'i doğrudan uca yöneltmek daha az kod olurdu ama 204'ü
 * "çözülemedi" diye ele alır ve tarayıcı konsoluna bir satır yazardı — küçük resmi olmayan seksen
 * fotoğraflık bir klasör, seksen satır. `fetch` ile 204 sessiz ve olağan bir cevap.
 *
 * `AbortController` kaçınılmaz: bir klasörden çıkmak, henüz cevaplanmamış onlarca isteği anlamsız
 * yapıyor, ve iptal edilmeyen her biri hem bir bağlantı hem de sökülmüş bir bileşene yazan bir
 * `setState` demek.
 */
function Thumb({
  entry,
  tone,
  glyph,
}: {
  entry: FileEntry;
  tone: Tone;
  glyph: string;
}): React.JSX.Element {
  const [source, setSource] = useState<{ url: string; spin: string | undefined } | null>(null);
  /**
   * SUNUCUNUN REDDEDECEĞİ BİR ŞEY SORULMUYOR, ve üç koşulun üçü de ölçülmüş bir sebeple burada.
   *
   * `THUMBNAILED`: uç yalnız JPEG'in EXIF'ine gömülü küçük resmi çıkarıyor, PNG ve WebP öyle bir
   * şey taşımıyor — onlar için istek her zaman 204 dönerdi.
   *
   * `trashedAt`: çöpteki bir girdi indirilemiyor, ve uç 404 veriyor. CI'nin mobil projesi tam
   * bunu yakaladı: çöp görünümünde iki JPEG vardı, iki 404, ve iki konsol hatası.
   *
   * `download`: bir satır `read` ile görünüp `download` olmadan durabiliyor, ve küçük resim
   * içeriğin küçültülmüş kopyası olduğu için o izni istiyor. Yine bir 4xx.
   *
   * Kuralı ikinci kez YAZMIYOR — reddi hâlâ sunucu veriyor. Buradaki iş, hiçbir zaman
   * cevaplanmayacak bir isteği hiç göndermemek, ve tarayıcı konsolunu bir klasör açılışında
   * onlarca kırmızı satırla doldurmamak.
   */
  const wanted =
    entry.kind === 'file' &&
    THUMBNAILED.has(suffix(entry.name)) &&
    entry.trashedAt === undefined &&
    can(entry, 'download');

  useEffect(() => {
    if (!wanted) return undefined;
    const stop = new AbortController();
    let url: string | null = null;

    void (async () => {
      try {
        const answer = await fetch(`${API_BASE_URL}/files/${entry.id}/thumbnail`, {
          credentials: 'same-origin',
          signal: stop.signal,
        });
        // 204 = gömülü küçük resmi yok. Bir hata değil, olağan cevap; kare simgede kalıyor.
        if (answer.status !== 200) return;
        const blob = await answer.blob();
        if (stop.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setSource({ url, spin: ORIENTATION[answer.headers.get('x-depsis-orientation') ?? '1'] });
      } catch {
        // Ağ hatası ya da iptal. Bir küçük resmin gelmemesi, dosya yöneticisinin bir sorunu değil.
      }
    })();

    return () => {
      stop.abort();
      // Nesne URL'i AÇIKÇA bırakılıyor: tarayıcı onu belge ömrü boyunca tutuyor, ve iki yüz
      // fotoğraflık bir klasörde gezinmek onları sızdırmanın en kolay yolu.
      if (url !== null) URL.revokeObjectURL(url);
      setSource(null);
    };
  }, [entry.id, wanted]);

  if (source === null) {
    return (
      <span className="g" style={tint(tone)} aria-hidden>
        {glyph}
      </span>
    );
  }
  return (
    <span className="g thumb" aria-hidden>
      <img
        src={source.url}
        alt=""
        style={source.spin === undefined ? undefined : { transform: source.spin }}
      />
    </span>
  );
}

/* ─── preview ───────────────────────────────────────────────────────────────── */

/**
 * Look at a picture without downloading it first.
 *
 * The reference has this and the port did not: a folder of photographs could only be inspected by
 * saving every candidate to the machine you were sitting at, which on a phone is not an option at
 * all. `GET /files/{id}/content` already exists, is in the contract, and `sky.tsx` already points
 * an element at it for wallpapers, so this needs no new endpoint.
 *
 * The element is pointed straight at the URL rather than fetched into a blob: the session is a
 * same-origin cookie the browser sends by itself, and a blob would pull a 40 MP photograph or a
 * whole video through this tab's heap before showing anything.
 *
 * SATIR KARESİ İÇİN KULLANILMIYOR, ve bu yorum bir zamanlar "çünkü bu API'nin arkasında bir küçük
 * resim servisi yok" diyordu. Artık var (`GET /files/{id}/thumbnail`), ama o uç TAM ÇÖZÜNÜRLÜKLÜ
 * dosyayı değil, JPEG'in içine gömülü ~160×120'lik küçük resmi döndürüyor — dosya başına 128 kB
 * okuyarak, ve hiçbir şeyin kodunu çözmeden. Satırdaki kare onu kullanıyor (`Thumb`); bu pencere
 * gerçek dosyayı kullanmaya devam ediyor, çünkü burada bakılan şey fotoğrafın kendisi.
 */
function Preview({ entry, onClose }: { entry: FileEntry; onClose: () => void }): React.JSX.Element {
  const source = `${API_BASE_URL}/files/${entry.id}/content`;
  const kind = previewAs(entry);

  return (
    <Win title={entry.name} glyph="👁" tone="cool" onClose={onClose}>
      <div style={PREVIEW_STAGE}>
        {kind === 'video' ? (
          // Controls but no autoplay: this window is opened to check WHICH file something is, and
          // a video that starts talking the moment it appears is startling in a room with people.
          <video src={source} controls style={PREVIEW_MEDIA} />
        ) : kind === 'audio' ? (
          // Aynı gerekçeyle otomatik çalmıyor. Ses öğesi `Content-Disposition: attachment`ı yok
          // sayıyor — indirmeyi başlatan tarayıcının GEZİNMESİ, bir medya öğesinin kaynağı değil —
          // ve CSP'nin `media-src 'self'` kuralı aynı kökene zaten izin veriyor.
          <audio src={source} controls style={PREVIEW_AUDIO} />
        ) : kind === 'text' ? (
          <TextHead entry={entry} />
        ) : (
          // PDF buraya HİÇ GELMİYOR: satırdaki düğme onu yeni bir sekmede açıyor (`openPdfTab`), ve
          // geri kalan tek önizlenebilir tür resim.
          <img src={source} alt={entry.name} style={PREVIEW_MEDIA} />
        )}
      </div>
      <div className="note">{formatBytes(entry.size)}</div>
    </Win>
  );
}

/** Metin önizlemesinin okuduğu en büyük parça. */
const TEXT_HEAD_BYTES = 256 * 1024;

/**
 * Bir metin dosyasının BAŞI.
 *
 * İLK 256 kB, VE `Range` İLE: bir günlük dosyası gigabaytlarca olabiliyor, oysa bu pencerenin
 * sorduğu soru "bu dosya ne" ve cevabı ilk ekranında duruyor. Tamamını çekmek, bakmak için açılan
 * bir pencerede sekmenin belleğini doldurmak olurdu.
 *
 * `fetch`, `<iframe>` DEĞİL: uç `Content-Disposition: attachment` gönderiyor (kiracının HTML'i =
 * depolanmış XSS) ve bir çerçeve onu indirme olarak açardı. İstek ise başlığı umursamıyor ve gelen
 * baytlar burada METİN olarak, `<pre>` içinde çiziliyor.
 *
 * Kesilen yerde bir UTF-8 karakteri ikiye bölünebiliyor; sonuçtaki tek bir "�", eksik olanın
 * söylendiği bir önizlemede kabul edilebilir bir bedel.
 */
function TextHead({ entry }: { entry: FileEntry }): React.JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const stop = new AbortController();
    void (async () => {
      try {
        const answer = await fetch(`${API_BASE_URL}/files/${entry.id}/content`, {
          credentials: 'same-origin',
          headers: { range: `bytes=0-${TEXT_HEAD_BYTES - 1}` },
          signal: stop.signal,
        });
        if (!answer.ok) {
          setFailed(true);
          return;
        }
        const body = await answer.text();
        if (stop.signal.aborted) return;
        setText(body);
      } catch {
        // İptal de buraya düşüyor, ve iptal bir hata değil: pencere kapandığı için okuma bitti.
        if (!stop.signal.aborted) setFailed(true);
      }
    })();
    return () => stop.abort();
  }, [entry.id]);

  if (failed) return <div className="note">Dosya okunamadı.</div>;
  if (text === null) return <div className="note">Yükleniyor…</div>;
  return (
    <pre style={PREVIEW_TEXT}>
      {text}
      {entry.size > TEXT_HEAD_BYTES ? '\n\n… (yalnız ilk 256 kB gösteriliyor)' : ''}
    </pre>
  );
}

/**
 * PDF'i yeni bir sekmede açar.
 *
 * ── NEDEN ÇERÇEVE DEĞİL ─────────────────────────────────────────────────────────────────────
 *
 * nginx her yanıta `frame-ancestors 'none'` ve `X-Frame-Options: DENY` yazıyor (deploy/nginx),
 * yani API'nin kendi kökeninden gelen bir belge bu sayfanın İÇİNE gömülemez — bir `<iframe>`
 * sessizce boş kalırdı, ve boş kalan bir önizleme hiç olmayandan kötü. Üst düzey bir sekmede o
 * kuralların ikisi de geçerli değil ve tarayıcının kendi PDF görüntüleyicisi dosyayı açıyor.
 *
 * `?inline=1` olmadan uç `attachment` gönderiyor ve sekme dosyayı indirip kapanırdı; o bayrağın
 * neden yalnız `.pdf`te açıldığı files.controller.ts'te yazılı.
 */
function openPdfTab(entry: FileEntry): void {
  const anchor = document.createElement('a');
  anchor.href = `${API_BASE_URL}/files/${entry.id}/content?inline=1`;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/** The reference's own preview geometry (11px radius, 340px cap, over a dark plate); the stylesheet
 *  has no rule for it and this screen does not own that file. */
const PREVIEW_STAGE: React.CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  background: 'rgba(0, 0, 0, 0.3)',
  borderRadius: 11,
  padding: 8,
  minHeight: 120,
};

const PREVIEW_MEDIA: React.CSSProperties = {
  maxWidth: '100%',
  maxHeight: 340,
  borderRadius: 11,
  display: 'block',
};

/** Ses çubuğu resim gibi kırpılmıyor: kısa kalırsa denetimleri sığmıyor, bu yüzden tam genişlik. */
const PREVIEW_AUDIO: React.CSSProperties = { width: '100%', display: 'block' };

/** Metnin kendi penceresi: aynı 340 piksellik tavan, ama kaydırma metnin içinde. */
const PREVIEW_TEXT: React.CSSProperties = {
  margin: 0,
  width: '100%',
  maxHeight: 340,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  textAlign: 'left',
  fontSize: 12,
  lineHeight: 1.5,
};

/* ─── helpers ───────────────────────────────────────────────────────────────── */

/** The stylesheet has no drop-target rule for the card — the reference never had one, because its
 *  upload was a button. The tint is written here rather than added to `styles.css` because this
 *  screen does not own that file. */
const DROP: React.CSSProperties = {
  boxShadow: 'inset 0 0 0 1.5px var(--live), 0 16px 40px -20px rgba(0, 0, 0, 0.8)',
  background: 'rgba(79, 227, 168, 0.07)',
};

/** "3 dosya ve 1 klasör" — the sentence the reader has to see before an irreversible button. */
function tally(entries: FileEntry[]): string {
  const files = entries.filter((entry) => entry.kind === 'file').length;
  const folders = entries.length - files;
  const parts: string[] = [];
  if (files > 0) parts.push(`${files} dosya`);
  if (folders > 0) parts.push(`${folders} klasör`);
  return parts.join(' ve ');
}

/** Just the names, capped the same way. A move does not destroy anything, so the per-folder
 *  weights `destroyList` goes and fetches would be paid for a number nobody needs here. */
function nameList(entries: FileEntry[]): string[] {
  const shown = entries.slice(0, NAMES_SHOWN).map((entry) => entry.name);
  if (entries.length > NAMES_SHOWN) {
    shown.push(`… ve ${entries.length - NAMES_SHOWN} öğe daha`);
  }
  return shown;
}

/** The same list, item by item, with each folder's weight beside it where the server gave one. */
function destroyList(entries: FileEntry[], counts: ReadonlyMap<string, ChildCount>): string[] {
  const shown = entries.slice(0, NAMES_SHOWN).map((entry) => {
    if (entry.kind !== 'folder') return `${entry.name} · ${formatBytes(entry.size)}`;
    const count = counts.get(entry.id);
    return count === undefined
      ? `${entry.name} · klasör ve içindekiler`
      : `${entry.name} · klasör · ${count.n}${count.more ? '+' : ''} öğe ve altındakiler`;
  });
  if (entries.length > NAMES_SHOWN) {
    shown.push(`… ve ${entries.length - NAMES_SHOWN} öğe daha`);
  }
  return shown;
}

/**
 * Ekrandaki sıralama, sözleşmenin `sort` numaralandırmasının aynısı.
 *
 * Türetilmiş DEĞİL, elle yazılmış: üretilen tipten türetmek daha temiz görünürdü ama o tip bir
 * sorgu parametresinin tipi, ve oradaki bir değişiklik burada sessizce yeni bir düğme yaratırdı.
 */
type SortKey = 'name' | 'type' | 'modified' | 'size';

/**
 * Her anahtarın kendi varsayılan yönü — sunucudaki `DEFAULT_DIRECTION`ın ikizi.
 *
 * İkizi olması ŞART, çünkü ekran yön göstergesini (▲/▼) yön seçilmeden önce de çiziyor: burada
 * yanlış bir varsayılan, sunucunun azalan verdiği bir listenin üstüne artan oku koyardı.
 */
const DEFAULT_DIRECTION: Readonly<Record<SortKey, 'asc' | 'desc'>> = {
  name: 'asc',
  type: 'asc',
  size: 'desc',
  modified: 'desc',
};

/**
 * Bir sütun başlığı.
 *
 * DÜĞME, BAŞLIK DEĞİL: basılabilir olduğu görünmeli ve klavyeyle sekmeyle ulaşılmalı.
 *
 * `aria-sort` YOK, ve bu bir eksiklik değil bir düzeltme: o öznitelik yalnız `columnheader` ya da
 * `rowheader` rolündeki bir öğede geçerli, ve bu liste bir tablo değil — satırlar `.frow`, sürükle
 * bırak alan, ızgara görünümüne dönebilen kutular. Düğmeye `aria-sort` koymak erişilebilirlik
 * kapısının (axe, `aria-allowed-attr`) haklı olarak reddettiği şey. Durum bunun yerine düğmenin
 * ERİŞİLEBİLİR ADINDA: gören biri oku okuyor, okuyucu aynı cümleyi duyuyor.
 */
function SortHead({
  label,
  sort,
  active,
  dir,
  onPick,
  grow,
  narrow,
  cell,
}: {
  label: string;
  sort: SortKey;
  active: SortKey;
  dir: 'asc' | 'desc' | null;
  onPick: (key: SortKey) => void;
  grow?: boolean;
  narrow?: boolean;
  cell?: 'sz' | 'dt';
}): React.JSX.Element {
  const on = active === sort;
  const way = on ? (dir ?? DEFAULT_DIRECTION[sort]) : null;
  const classes = ['sh'];
  if (on) classes.push('on');
  if (grow === true) classes.push('grow');
  if (narrow === true) classes.push('narrow');
  if (cell !== undefined) classes.push(cell);
  const state = way === null ? '' : way === 'asc' ? ' (şu an artan)' : ' (şu an azalan)';
  return (
    <button
      type="button"
      className={classes.join(' ')}
      aria-label={`${label} sütununa göre sırala${state}`}
      title={`${label} sütununa göre sırala${state}`}
      onClick={() => onPick(sort)}
    >
      {label}
      <span className="ar" aria-hidden>
        {way === null ? '' : way === 'asc' ? '▲' : '▼'}
      </span>
    </button>
  );
}

/**
 * Gelen sayfayı ekrandakinin sonuna ekler.
 *
 * ── SIRALAMA BİRİKMİŞ LİSTENİN TAMAMINA ─────────────────────────────────────────────────────
 * Yalnız yeni sayfayı sıralamak klasörleri listenin ORTASINA serperdi: sunucu `kind`i ARTAN
 * sıralıyor (`file` < `folder`), yani klasörler en son sayfada geliyor. Aynı karşılaştırma
 * birikmiş listenin tamamına uygulanınca sonuç, tek sayfaya sığan bir klasörde görülenin aynısı
 * oluyor — önce klasörler, sonra dosyalar.
 *
 * ── ADA GÖRE SIRALAMA DIŞINDA HİÇ DOKUNULMUYOR ──────────────────────────────────────────────
 * Boyuta ya da tarihe göre dizilmiş bir listeyi yeniden dizmek, sunucunun cevabını silip ekranda
 * "en büyük önce" derken alfabetik bir liste göstermek olurdu.
 */
export function merged(
  current: FileEntry[],
  page: FileEntry[],
  order: SortKey,
  direction: 'asc' | 'desc' | null = null,
): FileEntry[] {
  const next = [...current, ...page];
  return order === 'name' ? sorted(next, (direction ?? DEFAULT_DIRECTION.name) === 'desc') : next;
}

/**
 * Ada göre sırala — istenirse tersten.
 *
 * KLASÖRLER YÖNLE DÖNMÜYOR, ve bu sunucudaki kuralın aynısı: `kind` her sıralamada artan, yani
 * "tersten sırala" klasörleri listenin ortasına dağıtmıyor, yalnız adları çeviriyor. İkisi
 * ayrışsaydı ekrandaki sıra sunucunun imlecinin sırasından farklı olurdu ve "daha fazla göster"
 * satırları yanlış yere ekleyerek listeyi karıştırırdı.
 */
function sorted(items: FileEntry[], descending = false): FileEntry[] {
  return [...items].sort((a, b) => {
    // Folders first, then Turkish collation: `İ` sorts with `I` and `ş` after `s`, which a
    // locale-less `localeCompare` gets wrong on exactly the names this appliance is full of.
    const byKind = Number(a.kind === 'file') - Number(b.kind === 'file');
    if (byKind !== 0) return byKind;
    const byName = a.name.localeCompare(b.name, 'tr');
    return descending ? -byName : byName;
  });
}

/**
 * Sayfadan okunan sayı, "50+" biçiminde.
 *
 * YALNIZ ÇÖP İÇİN kaldı. Klasör listelemesi artık kendi toplamını gönderiyor, ama çöp bir klasör
 * değil bir süzgeç ve orada bir toplamın karşılığı yok — `hasMore` sözleşmenin verdiği tek şey, ve
 * `+` reddedilen bir sayıyı uydurmaktansa bilinmediğini söylemenin yolu.
 */
function countOf(page: FileEntryPage | undefined): string | null {
  if (page === undefined) return null;
  return `${page.items.length}${page.hasMore ? '+' : ''}`;
}

/* ─── bırakılanı yüklenebilir hâle getirmek ─────────────────────────────────── */

/**
 * Yüklenecek tek bir iş: dosya, ve hedefin ALTINDA açılması gereken klasör zinciri.
 *
 * `webkitRelativePath` YERİNE bir dizi, çünkü artık iki kaynak var: "Klasör yükle" seçicisi o
 * alanı dolduruyor, sürükle-bırak ise `FileSystemEntry` ağacını geziyor ve oradan gelen `File`
 * nesnelerinde o alan boş. Yol bilgisini dosyanın kendisinden değil yanından taşımak, ikisini tek
 * bir yükleme döngüsünde buluşturuyor.
 */
export interface Upload {
  file: File;
  segments: string[];
}

/** `webkitRelativePath`ten dosyanın ÜSTÜNDEKİ klasörler; dosya adının kendisi atılıyor. */
export function pathSegments(relative: string): string[] {
  return relative
    .split('/')
    .slice(0, -1)
    .filter((part) => part !== '');
}

/** Dosya seçicisinden gelenler. `keepPaths` yalnız "Klasör yükle" seçicisinde doğru. */
export function uploadsOf(files: readonly File[], keepPaths: boolean): Upload[] {
  return files.map((file) => ({
    file,
    segments: keepPaths ? pathSegments(file.webkitRelativePath) : [],
  }));
}

/**
 * Bırakılan bir öğe.
 *
 * `entry` varsa tarayıcı klasörün İÇİNİ gezdirebiliyor demektir. Yoksa elde yalnız düz bir `File`
 * var, ve orada bir klasör 0 baytlık türsüz bir dosyadan ayırt edilemiyor.
 */
type DropItem = { kind: 'entry'; entry: FileSystemEntry } | { kind: 'file'; file: File };

/**
 * Bırakma anında, `await`ten ÖNCE okunması gereken şey.
 *
 * `DataTransfer` olay işleyicisi döner dönmez boşalıyor: bir `await`ten sonra `items` boş bir
 * liste. Bu yüzden girdi nesneleri burada senkron alınıyor; yürüyüş sonra, elde duran girdilerle.
 */
function dropItems(transfer: DataTransfer): DropItem[] {
  const items = Array.from(transfer.items).filter((item) => item.kind === 'file');
  const first = items[0];
  // Girdi API'si olmayan tarayıcıda elde yalnız düz dosya listesi var.
  if (first === undefined || typeof first.webkitGetAsEntry !== 'function') {
    return Array.from(transfer.files).map((file): DropItem => ({ kind: 'file', file }));
  }
  const out: DropItem[] = [];
  for (const item of items) {
    const entry = item.webkitGetAsEntry();
    if (entry !== null) {
      out.push({ kind: 'entry', entry });
      continue;
    }
    // Girdisi verilemeyen ama dosyası olan bir öğe: yine de yüklenebilir.
    const file = item.getAsFile();
    if (file !== null) out.push({ kind: 'file', file });
  }
  return out;
}

/** Sürükle-bırakta inilecek en derin klasör. Kendine bağlanan bir ağaçta turun bitmesi şart. */
const DROP_MAX_DEPTH = 24;

/**
 * Bırakılanları yüklenecek işlere çevirir — klasörleri gezerek.
 *
 * `blind`: klasör olup olmadığı ANLAŞILAMAYAN öğe sayısı. Girdi API'si olmayan bir tarayıcıda
 * klasör de boş dosya da 0 bayt ve türsüz görünüyor; ikisini de yüklenmiş saymak, kullanıcıya
 * olmayan bir şey için "yüklendi" demekti. Sayılıyor, ve çağıran onu söylüyor.
 */
async function collectDrop(items: DropItem[]): Promise<{ uploads: Upload[]; blind: number }> {
  const uploads: Upload[] = [];
  let blind = 0;
  for (const item of items) {
    if (item.kind === 'file') {
      if (item.file.size === 0 && item.file.type === '') blind += 1;
      else uploads.push({ file: item.file, segments: [] });
      continue;
    }
    await walkEntry(item.entry, [], uploads);
  }
  return { uploads, blind };
}

/** Bir girdiyi — dosyaysa kendisini, klasörse altındaki her dosyayı — listeye ekler. */
async function walkEntry(
  entry: FileSystemEntry,
  segments: string[],
  into: Upload[],
): Promise<void> {
  if (entry.isFile) {
    const file = await entryFile(entry as FileSystemFileEntry);
    if (file !== null) into.push({ file, segments });
    return;
  }
  if (!entry.isDirectory || segments.length >= DROP_MAX_DEPTH) return;
  const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
  for (const child of children) {
    await walkEntry(child, [...segments, entry.name], into);
  }
}

/**
 * Bir klasörün BÜTÜN girdileri.
 *
 * `readEntries` her çağrıda yalnız bir küme veriyor — Chrome'da yüz — ve boş küme sonun kendisi.
 * Tek çağrı yapan bir kod, yüzden çok dosyalı bir klasörün gerisini sessizce düşürürdü.
 *
 * Okuma hatası turu bitirmiyor: o ana kadar okunanlar yükleniyor, çünkü okunabilmiş dosyaları
 * cezalandırmak kullanıcıya hiçbir şey kazandırmıyor.
 */
function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = [];
  return new Promise((resolve) => {
    const step = (): void => {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) {
            resolve(all);
            return;
          }
          all.push(...batch);
          step();
        },
        () => resolve(all),
      );
    };
    step();
  });
}

/** Girdinin `File` hâli; okunamıyorsa `null` (izin kalkmış, dosya silinmiş). */
function entryFile(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => {
    entry.file(
      (file) => resolve(file),
      () => resolve(null),
    );
  });
}

/**
 * Five mebibytes. Small enough that a dropped connection loses little, large enough that a gigabyte
 * is two hundred requests rather than two thousand.
 */
const CHUNK_BYTES = 5 * 1024 * 1024;

/**
 * A tus upload, yielding percent complete.
 *
 * `fetch` directly rather than through the generated client, and the reason is worth stating
 * because ADR-0001 says the client is generated: the body here is
 * `application/offset+octet-stream` — raw bytes with a caller-set `Upload-Offset` — which the
 * generated client models as JSON and would serialise. The PATH still comes from the contract,
 * because it is the same string the generated client would have used and `contract.test.ts` fails
 * on a route the document does not describe.
 */
async function* uploadFile(
  file: File,
  parentId: string | undefined,
  shareId: string | undefined,
): AsyncGenerator<number> {
  // ── SIFIR BAYT SESSİZCE "YÜKLENDİ" OLAMAZ ──────────────────────────────────────────────────
  //
  // Yayım son PATCH'in İÇİNDE oluyor ve sunucu 0 baytlık bir PATCH'i reddediyor (`Content-Length`
  // pozitif olmalı). Yani sıfır baytlık bir dosyada aşağıdaki döngü hiç dönmüyor: oturum açık
  // kalıyor, hiçbir şey yayımlanmıyor, üreteç sorunsuz bitiyor ve ekran "yüklendi" diyordu.
  // Sunucu tarafı düzelene kadar (uzunluk 0 ise POST'tan sonra hemen yayımlamak) doğru cevap ret.
  if (file.size === 0) {
    throw new Error(`"${file.name}" 0 bayt: boş dosyalar bu sürümde yüklenemiyor.`);
  }

  // ── KÖKE YÜKLEMEDE PAYLAŞIM ────────────────────────────────────────────────────────────────
  // Bir üst klasör varsa paylaşımı o belirliyor; kökte belirleyen hiçbir şey yoktu ve sunucu
  // `parentId` gelmeyince kiracının VARSAYILAN paylaşımını seçiyordu. Yani "Arşiv" seçiliyken
  // köke bırakılan dosyanın bütün baytları başka bir paylaşıma iniyor, ekran "yüklendi" diyor ve
  // dosya açık olan listede görünmüyordu. `folderBody`deki kuralın aynısı, bir kat aşağıda.
  const share = parentId === undefined ? shareId : undefined;
  // Parmak izinin ikinci parçası HEDEF: `undefined` iki farklı paylaşımın kökünü tek anahtara
  // katlıyordu, ve yarım kalmış bir yükleme yanlış paylaşımdaki oturuma devam edebilirdi.
  const key = fingerprint(file, parentId ?? (share === undefined ? undefined : `share:${share}`));

  // ── kaldığı yerden ──
  //
  // Önce bu tarayıcının kendi notuna bakılıyor. `POST /uploads` koşulsuz çağrıldığı sürece
  // sekmesi kapanmış bir yükleme yeniden seçildiğinde SIFIRDAN başlıyordu ve yarım kalan oturum
  // sunucuda öksüz kalıyordu — arayüz ise "kaldığı yerden devam eder" yazıyordu.
  //
  // HEAD sunucunun cevabı, notunki değil: not yalnız hangi oturumun sorulacağını söylüyor.
  let location = recallUpload(key);
  let offset = 0;
  if (location !== null) {
    const resumed = await probe(location, file.size);
    if (resumed === null) {
      // 404, boyut uyuşmazlığı, ya da bayt sayısı dolmuş ama yayımlanmamış bir oturum. Hepsinde
      // doğru davranış notu atıp sıfırdan başlamak.
      forgetUpload(key);
      location = null;
    } else {
      offset = resumed;
      yield Math.round((offset / Math.max(1, file.size)) * 100);
    }
  }

  if (location === null) {
    const metadata = uploadMetadata(file.name, parentId, share);

    const created = await fetch(`${API_BASE_URL}/uploads`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'upload-length': String(file.size), 'upload-metadata': metadata },
    });
    if (!created.ok) throw await failure(created, `"${file.name}" yüklenemedi.`);
    const fresh = created.headers.get('location');
    if (fresh === null) throw new Error('Sunucu yükleme adresi vermedi.');
    location = fresh;
    rememberUpload(key, fresh);
  }

  while (offset < file.size) {
    const end = Math.min(offset + CHUNK_BYTES, file.size);
    const sent = await fetch(location, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/offset+octet-stream',
        'upload-offset': String(offset),
      },
      body: file.slice(offset, end),
    });

    if (sent.status === 409) {
      const what = conflict(await problemCode(sent), sent.headers.get('upload-offset'));
      if (what.kind === 'name-taken') throw new UploadNameClash(location, file.name);
      if (what.kind === 'realign') {
        offset = what.offset;
        continue;
      }
      throw await failure(sent, `"${file.name}" yüklenemedi.`);
    }
    if (!sent.ok) throw await failure(sent, `"${file.name}" yüklenemedi.`);

    offset = end;
    yield Math.round((offset / Math.max(1, file.size)) * 100);
  }

  // Yayım bu noktada olmuş demektir; not artık yalnız yanlış cevap verebilir.
  forgetUpload(key);
}

/**
 * Hedefte aynı adda bir dosya var.
 *
 * KENDİ TÜRÜ, çünkü bu 409 diğer 409'la aynı şey değil: biri yüklemenin nerede kaldığını yeniden
 * hizalamayı, bu ise kullanıcıya bir soru sormayı gerektiriyor. Ayırt edici işaret sunucunun
 * `code` alanı — bir cümle olsaydı, cümlenin her düzeltilişi bu dalı sessizce bozardı.
 *
 * `location` taşınıyor çünkü çözüm baytları yeniden göndermek değil: dosya ara alanda duruyor ve
 * aynı oturum üzerinden yayımlanacak.
 */
/** Bir 409'un hangi 409 olduğu. */
export type Conflict =
  { kind: 'name-taken' } | { kind: 'realign'; offset: number } | { kind: 'other' };

/**
 * Yükleme sırasında gelen 409'u ayırır.
 *
 * ── SIRA ÖNEMLİ, VE BU BİR KUSURUN İZİ ──────────────────────────────────────────────────────
 * Sunucu son PATCH'te `Upload-Offset`i yanıta YAZDIKTAN sonra yayımı deniyor, yani ad çakışması
 * 409'unun üzerinde de bir `Upload-Offset` duruyor ve değeri dosyanın tam boyutu. Hizalama dalı
 * önce baksaydı — ve bakıyordu — imleci dosyanın sonuna alır, döngüyü "bitti" sayar, kaldığı yer
 * notunu siler ve ekran kullanıcıya hiç sorulmamış bir dosya için "yüklendi" derdi; baytlar ara
 * alanda öksüz kalırdı. O yüzden ayırt edici işaret olan `code` ÖNCE soruluyor.
 *
 * ── BAŞLIK YOKSA HİZALAMA DA YOK ────────────────────────────────────────────────────────────
 * `Number(null ?? '')` sıfır üretiyor. Başlıksız bir 409'u hizalama sayan bir dal, yüklemeyi
 * baştan başlatıp aynı 409'a yeniden düşerdi — sonu olmayan bir döngü, ve faturası kullanıcının
 * bağlantısı.
 */
export function conflict(code: string | null, offsetHeader: string | null): Conflict {
  if (code === 'name-taken') return { kind: 'name-taken' };
  if (offsetHeader === null) return { kind: 'other' };
  const offset = Number(offsetHeader);
  if (!Number.isSafeInteger(offset) || offset < 0) return { kind: 'other' };
  // Sunucu bu oturumun gerçekten nerede kaldığını kendi ölçüyor (ara dosyayı seek ediyor), yani
  // anlaşmazlıkta haklı olan taraf o; körlemesine yeniden denemek yerine oradan devam ediliyor.
  return { kind: 'realign', offset };
}

/** Sunucunun RFC 9457 gövdesindeki `code`. Gövde okunamazsa `null` — ve o zaman bu bir tahmin
 *  değil, "bilmiyorum" olur. */
async function problemCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.clone().json();
    const code = (body as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

export class UploadNameClash extends Error {
  constructor(
    readonly location: string,
    readonly filename: string,
  ) {
    super(`"${filename}" adında bir dosya zaten var.`);
    this.name = 'UploadNameClash';
  }
}

/** HEAD ile oturumun gerçek yerini sorar. Ağ hatası da "devam edilemez" demektir. */
async function probe(location: string, size: number): Promise<number | null> {
  let head: Response;
  try {
    head = await fetch(location, { method: 'HEAD', credentials: 'same-origin' });
  } catch {
    return null;
  }
  const number = (name: string): number | null => {
    const raw = head.headers.get(name);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  };
  return resumeOffset(
    { status: head.status, offset: number('upload-offset'), length: number('upload-length') },
    size,
  );
}

/**
 * tus `Upload-Metadata`: oturumun nereye açılacağını söyleyen tek kanal.
 *
 * `parentId` VARSA `shareId` YOK. Paylaşımı üst klasör belirliyor, ve iki cevap bir fazla —
 * klasör açmadaki (`folderBody`) kuralın aynısı. Kökte ise `shareId` şart: onsuz sunucu kiracının
 * varsayılan paylaşımını seçiyor, dosyanın bütün baytları oraya iniyor ve kullanıcı yüklediği
 * dosyayı açık olan listede bulamıyor.
 */
export function uploadMetadata(
  filename: string,
  parentId: string | undefined,
  shareId: string | undefined,
): string {
  return [
    `filename ${base64(filename)}`,
    ...(parentId === undefined ? [] : [`parentId ${base64(parentId)}`]),
    ...(parentId !== undefined || shareId === undefined ? [] : [`shareId ${base64(shareId)}`]),
  ].join(',');
}

/**
 * tus metadata is base64, and `btoa` cannot take a non-Latin-1 string — a Turkish filename would
 * throw before it ever reached the network.
 */
function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function body(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Always an `Error`, never a bare problem object: the catch site shows `.message` and a thrown
 *  plain object would put `[object Object]` in a toast. */
async function failure(response: Response, fallback: string): Promise<Error> {
  if (response.status === 503) {
    // The upload path is the one place the agent's absence is not a background detail: there is
    // nothing behind the API to write the bytes to, and no amount of retrying will change that.
    return new Error('Depolama ajanı çalışmıyor, bu kurulumda yükleme yapılamaz.');
  }
  if (response.status === 507) {
    return new Error('Kota doldu, yükleme için yer yok.');
  }
  return new Error(
    problemMessage(await body(response), `${fallback} (sunucu ${response.status} döndü)`),
  );
}
