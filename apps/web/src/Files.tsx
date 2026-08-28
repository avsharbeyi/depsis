import type { OpenApi } from '@depsis/contracts';
import { Fragment, useEffect, useRef, useState } from 'react';

import { api, API_BASE_URL, problemMessage } from './api.js';
import { History } from './History.js';
import { Scan } from './Scan.js';
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

/** The maximum the contract allows on one page. This screen has no cursor pagination, so it asks
 *  for as much as it is permitted and says "+" when the server admits there is more, rather than
 *  silently drawing a truncated folder as if it were the whole thing. */
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
 * Whether the browser can show this file without downloading it first, and as what.
 *
 * `svg` is excluded from the picture list on purpose even though every browser renders it: an SVG
 * is a document that can carry script, and putting one in an `<img>` on the same origin as the
 * session cookie is a decision this screen has no reason to make. It still downloads normally.
 */
function previewAs(entry: FileEntry): 'image' | 'video' | null {
  if (entry.kind !== 'file') return null;
  const ext = suffix(entry.name);
  if (ext === 'svg') return null;
  if (KINDS[0]?.ext.has(ext) === true) return 'image';
  if (KINDS[1]?.ext.has(ext) === true) return 'video';
  return null;
}

/** The `.g` squares in this card are sized by their parent's rule (`.qf .g`, `.um .g`, `.frow .g`),
 *  so they cannot be the shared `Glyph`, which owns its own dimensions. Only the tint is shared. */
function tint(tone: Tone, alpha = 0.22): React.CSSProperties {
  const [r, g, b] = toneRgb(tone);
  return { background: `rgba(${r},${g},${b},${alpha})`, color: TONES[tone] };
}

/* ─── the screen ────────────────────────────────────────────────────────────── */

export function Files({ notify, isAdmin, onUnauthenticated }: Props): React.JSX.Element {
  // Back and forward are a real stack rather than a "previous folder" variable, because with one
  // variable going back twice returns to where you already were.
  const [history, setHistory] = useState<Loc[]>([ROOT]);
  const [pos, setPos] = useState(0);
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  /** Told apart from "no rows": an empty list is a fact about the folder, a failed read is not. */
  const [listFailed, setListFailed] = useState(false);
  const [more, setMore] = useState(false);
  const [preview, setPreview] = useState<FileEntry | null>(null);
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');
  const [picking, setPicking] = useState(false);
  /** Yedek gezgini açık mı. Kapı burada, pencere History.tsx'te — "çöp ve yedek" ikilisinin
      yedek yarısı. Sahibi bunu Dosyalar'ın içinde arıyor; ayrı ekran kafa karıştırıyordu. */
  const [backups, setBackups] = useState(false);
  /** "İşe bağla" penceresi: seçili girdiler + panodan gelen açık işler. */
  /** Kod okuyucu penceresi açık mı. Sonucu arama kutusuna koyar; arama zaten oradan akar. */
  const [scanning, setScanning] = useState(false);
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
  const [counts, setCounts] = useState<{ home: string | null; trash: string | null }>({
    home: null,
    trash: null,
  });
  const [storage, setStorage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const bar = useRef<HTMLDivElement>(null);
  const pickFile = useRef<HTMLInputElement>(null);
  const pickDir = useRef<HTMLInputElement>(null);
  const pickPhoto = useRef<HTMLInputElement>(null);

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
  const shareQuery = shareId === undefined ? {} : { shareId };

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

  /* ── the listing ── */
  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setListFailed(false);
    void (async () => {
      const q = trashed ? '' : term.trim();
      const result =
        q !== ''
          ? await api.GET('/search', { params: { query: { q, limit: PAGE, ...shareQuery } } })
          : await api.GET('/files', {
              params: {
                query: trashed
                  ? { trashed: true, limit: PAGE, ...shareQuery }
                  : parentId === undefined
                    ? { limit: PAGE, ...shareQuery }
                    : { parentId, limit: PAGE },
              },
            });
      if (cancelled) return;
      if (result.response.status === 401) {
        onUnauthenticated();
        return;
      }
      if (result.data === undefined) {
        // Not `setEntries([])`. A toast is transient chrome; the panel underneath it would be
        // asserting "Bu klasör boş" about a folder nobody managed to read.
        notify('error', q !== '' ? 'Arama yapılamadı.' : 'Klasör okunamadı.');
        setListFailed(true);
        setMore(false);
        return;
      }
      setEntries(sorted(result.data.items));
      setMore(result.data.hasMore);
      // A selection that survives a folder change acts on rows the user can no longer see.
      setSel(new Set());
    })();
    return () => {
      cancelled = true;
    };
    // `shareId` is a dependency: switching share has to re-read, and `parentId` is cleared by the
    // handler that sets it so a folder from the old share cannot survive the switch.
  }, [parentId, trashed, term, reloadKey, shareId, notify, onUnauthenticated]);

  /* ── the two counters in the sidebar strip ──
     Deliberately their own pair of requests: the strip claims a number for both places at once,
     and one of them is never the list on screen. A counter derived from whichever folder happens
     to be open would be right on the root and stale everywhere else. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [home, bin] = await Promise.all([
        api.GET('/files', { params: { query: { limit: PAGE, ...shareQuery } } }),
        api.GET('/files', { params: { query: { trashed: true, limit: PAGE, ...shareQuery } } }),
      ]);
      if (cancelled) return;
      setCounts({ home: countOf(home.data), trash: countOf(bin.data) });
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
      body: parentId === undefined ? { name } : { name, parentId },
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

  /** The bin holds whatever one page of it holds — there is no total in the contract — so what is
   *  on screen is what gets emptied, and the reader is told if there may be more behind it. */
  async function emptyTrash(): Promise<void> {
    const list = entries ?? [];
    const hadMore = more;
    const { done, signedOut } = await permanentDelete(list, 'Çöp boşaltılıyor');
    // Only when something actually went, and never as an 'ok': a run in which every delete was
    // refused ended on a green tick telling the reader to do it again, and 'ok' dismisses itself
    // after four seconds — so the one instruction that matters after a partial purge was the one
    // that vanished. Nothing at all once the session went with it; the sign-in note carries the
    // tally there and this stack is no longer on screen.
    if (hadMore && done > 0 && !signedOut) {
      notify('error', 'Çöpte bu sayfaya sığmayan öğeler kalmış olabilir; boşaltmayı yineleyin.');
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
      // `shareId` only for a TOP-LEVEL folder: with a parent, the parent decides the share and the
      // API refuses to be told twice.
      body: parent === undefined ? { name, ...shareQuery } : { name, parentId: parent },
    });
    if (data !== undefined) return data.id;
    // 409 is the ordinary case, not a fault: the user is re-uploading a folder they already have,
    // or two files from the same subdirectory raced. Adopt the existing folder and carry on.
    const listing = await api.GET('/files', {
      params: {
        query:
          parent === undefined ? { limit: PAGE, ...shareQuery } : { parentId: parent, limit: PAGE },
      },
    });
    const match = listing.data?.items.find((item) => item.kind === 'folder' && item.name === name);
    return match?.id ?? null;
  }

  async function runUploads(list: File[], keepPaths: boolean): Promise<void> {
    if (trashed) {
      notify('error', 'Çöp kutusuna yükleme yapılamaz.');
      return;
    }
    if (list.length === 0) return;

    const cache = new Map<string, string>();
    let failed = 0;

    for (const [index, file] of list.entries()) {
      const label = list.length === 1 ? file.name : `${index + 1}/${list.length} · ${file.name}`;
      setProgress({ label, percent: 0 });

      let target = parentId;
      if (keepPaths) {
        const segments = file.webkitRelativePath
          .split('/')
          .slice(0, -1)
          .filter((s) => s !== '');
        const resolved = await ensureChain(segments, cache);
        if (resolved === null) {
          failed += 1;
          notify('error', `"${file.name}" için klasör kurulamadı.`);
          continue;
        }
        target = resolved.id;
      }

      try {
        for await (const percent of uploadFile(file, target)) setProgress({ label, percent });
      } catch (problem) {
        failed += 1;
        notify('error', problem instanceof Error ? problem.message : `"${file.name}" yüklenemedi.`);
      }
    }

    setProgress(null);
    const done = list.length - failed;
    if (done > 0) {
      notify(
        'ok',
        done === 1 && list[0] !== undefined
          ? `"${list[0].name}" yüklendi.`
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
    void runUploads(files, keepPaths);
  }

  /* ── selection ── */

  const selected = (entries ?? []).filter((entry) => sel.has(entry.id));

  function toggle(id: string): void {
    setSel((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function stopPicking(): void {
    setPicking(false);
    setSel(new Set());
  }

  /**
   * A download is a plain `<a href download>`, one per file, and nothing else.
   *
   * The session is a same-origin cookie so the browser sends it, and the server answers with
   * `Content-Disposition: attachment` — which means a multi-gigabyte file goes from the socket to
   * the disk without ever passing through this tab's heap. Fetching it to build a blob URL would
   * work perfectly on the test fixtures and kill the tab on a real video.
   *
   * The anchor is built here rather than left in the row because the row's control has to be a
   * `<button>`: the stylesheet dresses `.fact button` and nothing else, and a link sitting among
   * them with no hover or disabled state reads as a dead control.
   */
  function download(list: FileEntry[]): void {
    for (const entry of list) {
      if (entry.kind !== 'file' || !can(entry, 'download')) continue;
      const anchor = document.createElement('a');
      anchor.href = `${API_BASE_URL}/files/${entry.id}/content`;
      anchor.download = entry.name;
      anchor.rel = 'noopener';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    }
  }

  /* ── render ── */

  const meta =
    entries === null ? '—' : `${entries.length}${more ? '+' : ''} ${searching ? 'sonuç' : 'öğe'}`;

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
        const dropped = Array.from(event.dataTransfer.files);
        if (dropped.length > 0) void runUploads(dropped, false);
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
            disabled={trashed}
            title="Kamerayla QR kod / barkod okut"
            aria-label="Kamerayla kod okut"
            onClick={() => setScanning(true)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM5 5h3v3H5zM16 5h3v3h-3zM5 16h3v3H5zM14 14h3v3h-3zM18 14h3v3h-3zM14 18h3v3h-3zM18 18h3v3h-3z"
                fill="currentColor"
              />
            </svg>
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
        <button type="button" className={!trashed ? 'qf on' : 'qf'} onClick={() => go(ROOT)}>
          <span className="g" style={tint('iris', 0.2)} aria-hidden>
            🏠
          </span>
          <span className="l">Dosyalarım</span>
          <span className="c">{counts.home ?? '—'}</span>
        </button>
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
        <button
          type="button"
          className="qf sm"
          disabled={shares === null || shares.length === 0}
          title="Bu paylaşımın yedeklerine (anlık görüntülerine) göz at"
          onClick={() => setBackups(true)}
        >
          <span className="g" style={tint('cool', 0.2)} aria-hidden>
            🕘
          </span>
          <span className="l">Yedekler</span>
        </button>
      </div>

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
              disabled={
                !selected.some((entry) => entry.kind === 'file' && can(entry, 'download')) || busy
              }
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

      <div className="flist">
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
            const chosenRow = sel.has(entry.id);
            const opens = !picking && !trashed && entry.kind === 'folder';
            const activate = (): void => {
              if (picking) {
                toggle(entry.id);
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
                onClick={clickable ? activate : undefined}
                onKeyDown={
                  clickable
                    ? (event) => {
                        // A div with a click handler is invisible to the keyboard; Space also has
                        // to be swallowed or the list scrolls out from under the row.
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        activate();
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
                    toggle(entry.id);
                  }}
                >
                  ✓
                </button>
                <Thumb entry={entry} tone={type.tone} glyph={type.glyph} />
                <span className="n" title={entry.name}>
                  {entry.name}
                </span>
                <span className="sz">
                  {entry.kind === 'folder' ? '—' : formatBytes(entry.size)}
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
                      {previewAs(entry) !== null && (
                        <button
                          type="button"
                          title="Görüntüle"
                          aria-label={`${entry.name} görüntüle`}
                          onClick={() => setPreview(entry)}
                        >
                          👁
                        </button>
                      )}
                      {entry.kind === 'file' && can(entry, 'download') && (
                        <button
                          type="button"
                          title="İndir"
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
      </div>

      <div className="ffoot">
        <span className="info">{storage ?? '…'}</span>
        <span className="val">{meta}</span>
      </div>

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

      {scanning && (
        <Scan
          onResult={(text) => {
            setScanning(false);
            setQuery(text);
            notify('ok', `Aranıyor: ${text}`);
          }}
          onClose={() => setScanning(false)}
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

      {backups && shares !== null && shares[0] !== undefined && (
        <History
          shareId={(shares.find((it) => it.id === shareId) ?? shares[0]).id}
          shareName={(shares.find((it) => it.id === shareId) ?? shares[0]).name}
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
        ) : (
          <img src={source} alt={entry.name} style={PREVIEW_MEDIA} />
        )}
      </div>
      <div className="note">{formatBytes(entry.size)}</div>
    </Win>
  );
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

function sorted(items: FileEntry[]): FileEntry[] {
  return [...items].sort((a, b) => {
    // Folders first, then Turkish collation: `İ` sorts with `I` and `ş` after `s`, which a
    // locale-less `localeCompare` gets wrong on exactly the names this appliance is full of.
    const byKind = Number(a.kind === 'file') - Number(b.kind === 'file');
    return byKind !== 0 ? byKind : a.name.localeCompare(b.name, 'tr');
  });
}

/** `hasMore` is all the contract gives — there is no total, on purpose (§14) — so the counter says
 *  "200+" rather than inventing a number it was refused. */
function countOf(page: FileEntryPage | undefined): string | null {
  if (page === undefined) return null;
  return `${page.items.length}${page.hasMore ? '+' : ''}`;
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
async function* uploadFile(file: File, parentId: string | undefined): AsyncGenerator<number> {
  const key = fingerprint(file, parentId);

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
    const metadata = [
      `filename ${base64(file.name)}`,
      ...(parentId === undefined ? [] : [`parentId ${base64(parentId)}`]),
    ].join(',');

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
      // The server and this loop disagree about where the file is. The server is right — it seeks
      // the staging file itself — so resume from what it says rather than retrying blindly.
      const authoritative = Number(sent.headers.get('upload-offset') ?? '');
      if (Number.isSafeInteger(authoritative) && authoritative >= 0) {
        offset = authoritative;
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
