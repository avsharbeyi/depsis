import type { OpenApi } from '@depsis/contracts';
import { Fragment, useEffect, useRef, useState } from 'react';

import { api, API_BASE_URL, problemMessage } from './api.js';
import { formatBytes } from './Dashboard.js';
import type { Tone } from './ui.js';
import { Bar, ConfirmBox, Empty, PromptBox, TONES, toneRgb, Win } from './ui.js';

type FileEntry = OpenApi.components['schemas']['FileEntry'];
type FileEntryPage = OpenApi.components['schemas']['FileEntryPage'];

interface Props {
  notify: (kind: 'ok' | 'error', text: string) => void;
  onUnauthenticated: () => void;
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
const PAGE = 200;

type Modal =
  | { kind: 'none' }
  | { kind: 'new-folder' }
  | { kind: 'rename'; entry: FileEntry }
  | { kind: 'trash'; entries: FileEntry[] };

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

export function Files({ notify, onUnauthenticated }: Props): React.JSX.Element {
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
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState<{ label: string; percent: number } | null>(null);
  const [modal, setModal] = useState<Modal>({ kind: 'none' });
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

  /* ── the listing ── */
  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setListFailed(false);
    void (async () => {
      const q = trashed ? '' : term.trim();
      const result =
        q !== ''
          ? await api.GET('/search', { params: { query: { q, limit: PAGE } } })
          : await api.GET('/files', {
              params: {
                query: trashed
                  ? { trashed: true, limit: PAGE }
                  : parentId === undefined
                    ? { limit: PAGE }
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
  }, [parentId, trashed, term, reloadKey, notify, onUnauthenticated]);

  /* ── the two counters in the sidebar strip ──
     Deliberately their own pair of requests: the strip claims a number for both places at once,
     and one of them is never the list on screen. A counter derived from whichever folder happens
     to be open would be right on the root and stale everywhere else. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [home, bin] = await Promise.all([
        api.GET('/files', { params: { query: { limit: PAGE } } }),
        api.GET('/files', { params: { query: { trashed: true, limit: PAGE } } }),
      ]);
      if (cancelled) return;
      setCounts({ home: countOf(home.data), trash: countOf(bin.data) });
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

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
      const { error } = await api.DELETE('/files/{id}', { params: { path: { id: entry.id } } });
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
      const { error } = await api.POST('/files/{id}/restore', {
        params: { path: { id: entry.id } },
      });
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
      body: parent === undefined ? { name } : { name, parentId: parent },
    });
    if (data !== undefined) return data.id;
    // 409 is the ordinary case, not a fault: the user is re-uploading a folder they already have,
    // or two files from the same subdirectory raced. Adopt the existing folder and carry on.
    const listing = await api.GET('/files', {
      params: {
        query: parent === undefined ? { limit: PAGE } : { parentId: parent, limit: PAGE },
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
    const picked = event.target.files;
    // Cleared straight away so choosing the SAME file again still fires `change`.
    event.target.value = '';
    if (picked === null || picked.length === 0) return;
    setMenuOpen(false);
    void runUploads(Array.from(picked), keepPaths);
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
      if (entry.kind !== 'file') continue;
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
        event.preventDefault();
        setDragOver(false);
        const dropped = Array.from(event.dataTransfer.files);
        if (dropped.length > 0) void runUploads(dropped, false);
      }}
    >
      {/* No `.ch` title row: the window this screen lives in already carries the glyph and the
          word "Dosyalar" in its own header, and repeating them two rows apart reads as a mistake.
          The one thing that row contributed — the item count — moved to the footer. */}
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
        </div>
        <button
          type="button"
          className={picking ? 'mk act' : 'mk'}
          aria-pressed={picking}
          onClick={() => (picking ? stopPicking() : setPicking(true))}
        >
          ☑ Seç
        </button>
        <button
          type="button"
          className="mk"
          disabled={trashed || busy}
          onClick={() => setModal({ kind: 'new-folder' })}
        >
          + Klasör
        </button>
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

      <div className="quick">
        <button type="button" className={!trashed ? 'qf on' : 'qf'} onClick={() => go(ROOT)}>
          <span className="g" style={tint('iris', 0.2)} aria-hidden>
            🏠
          </span>
          <span className="l">Dosyalarım</span>
          <span className="c">{counts.home ?? '—'}</span>
        </button>
        <button
          type="button"
          className={trashed ? 'qf on' : 'qf'}
          onClick={() => go({ trashed: true, trail: [] })}
        >
          <span className="g" style={tint('rose', 0.18)} aria-hidden>
            🗑
          </span>
          <span className="l">Çöp</span>
          <span className="c">{counts.trash ?? '—'}</span>
        </button>
      </div>

      <div className={sel.size > 0 ? 'selbar on' : 'selbar'}>
        <span className="n">{sel.size} seçili</span>
        {trashed ? (
          <button type="button" className="sb" onClick={() => void restore(selected)}>
            ↺ Geri al
          </button>
        ) : (
          <>
            <button
              type="button"
              className="sb"
              disabled={selected.every((entry) => entry.kind !== 'file')}
              onClick={() => download(selected)}
            >
              ⤓ İndir
            </button>
            <button
              type="button"
              className="sb dl"
              onClick={() => setModal({ kind: 'trash', entries: selected })}
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
          <Bar ratio={progress.percent / 100} />
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

            return (
              <div
                key={entry.id}
                className={chosenRow ? 'frow sel' : 'frow'}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                style={clickable ? { cursor: 'pointer' } : undefined}
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
                <span className="g" style={tint(type.tone)} aria-hidden>
                  {type.glyph}
                </span>
                <span className="n" title={entry.name}>
                  {entry.name}
                </span>
                <span className="sz">
                  {entry.kind === 'folder' ? '—' : formatBytes(entry.size)}
                </span>

                {/* The row itself is clickable while picking, so the actions have to swallow the
                    click or renaming a file would also select it. */}
                <div className="fact" onClick={(event) => event.stopPropagation()}>
                  {trashed ? (
                    <button
                      type="button"
                      title="Geri al"
                      aria-label={`${entry.name} geri al`}
                      onClick={() => void restore([entry])}
                    >
                      ↺
                    </button>
                  ) : (
                    <>
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
                      {entry.kind === 'file' && (
                        <button
                          type="button"
                          title="İndir"
                          aria-label={`${entry.name} indir`}
                          onClick={() => download([entry])}
                        >
                          ⤓
                        </button>
                      )}
                      <button
                        type="button"
                        title="Ad değiştir"
                        aria-label={`${entry.name} adını değiştir`}
                        disabled={busy}
                        onClick={() => setModal({ kind: 'rename', entry })}
                      >
                        ✎
                      </button>
                      <span className="gap" aria-hidden />
                      <button
                        type="button"
                        className="del"
                        title="Çöpe at"
                        aria-label={`${entry.name} çöpe at`}
                        disabled={busy}
                        onClick={() => setModal({ kind: 'trash', entries: [entry] })}
                      >
                        🗑
                      </button>
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
    </section>
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
 * Deliberately NOT also used as a row thumbnail. The reference sets `background-size: cover` on
 * `.frow .g` for that, but there is no thumbnail service behind this API — a folder of two hundred
 * photographs would fetch two hundred full-resolution originals to fill two hundred 27px squares.
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
  const location = created.headers.get('location');
  if (location === null) throw new Error('Sunucu yükleme adresi vermedi.');

  let offset = 0;
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
