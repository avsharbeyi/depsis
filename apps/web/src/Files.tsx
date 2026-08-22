import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, API_BASE_URL, problemMessage } from './api.js';
import { formatBytes } from './Dashboard.js';

type FileEntry = OpenApi.components['schemas']['FileEntry'];

interface Props {
  onUnauthenticated: () => void;
}

/** Where we are in the tree. The root is an empty trail. */
interface Crumb {
  id: string;
  name: string;
}

/**
 * The file browser.
 *
 * Navigation is by `parentId`, never by a path string. That is ADR-0005's rule and it is not
 * pedantry here: the server resolves an entry by id and derives the path from `parent_id`, so a
 * client that navigated by path would be asking about a different thing than the one it displayed
 * — and during a rename of a large subtree, briefly a different thing entirely.
 */
export function Files({ onUnauthenticated }: Props): React.JSX.Element {
  const [trail, setTrail] = useState<Crumb[]>([]);
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const parentId = trail.length === 0 ? undefined : trail[trail.length - 1]?.id;

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setError(null);
      const { data, response } = await api.GET('/files', {
        params: { query: parentId === undefined ? {} : { parentId } },
      });
      if (cancelled) return;
      if (response.status === 401) {
        onUnauthenticated();
        return;
      }
      if (data === undefined) {
        setError('Klasör okunamadı.');
        setEntries([]);
        return;
      }
      // Folders first, then files, each by name. The server already orders by (kind, name_fold);
      // this is not a second opinion, it is what keeps the list stable if that ever changes.
      setEntries(
        [...data.items].sort((a, b) => {
          // Folders before files, then by name in the Turkish collation — `İ` sorts with `I` and
          // `ş` after `s`, which `localeCompare` without a locale does not do.
          const byKind = Number(a.kind === 'file') - Number(b.kind === 'file');
          return byKind !== 0 ? byKind : a.name.localeCompare(b.name, 'tr');
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [parentId, reloadKey, onUnauthenticated]);

  async function createFolder(): Promise<void> {
    const name = window.prompt('Klasör adı');
    if (name === null || name.trim() === '') return;
    setBusy('Klasör oluşturuluyor…');
    const { error: problem } = await api.POST('/files/folders', {
      body: parentId === undefined ? { name } : { name, parentId },
    });
    setBusy(null);
    if (problem !== undefined) {
      setError(problemMessage(problem, 'Klasör oluşturulamadı.'));
      return;
    }
    reload();
  }

  async function rename(entry: FileEntry): Promise<void> {
    const name = window.prompt('Yeni ad', entry.name);
    if (name === null || name.trim() === '' || name === entry.name) return;
    setBusy('Yeniden adlandırılıyor…');
    const { error: problem } = await api.PATCH('/files/{id}', {
      params: { path: { id: entry.id } },
      body: { name },
    });
    setBusy(null);
    if (problem !== undefined) {
      setError(problemMessage(problem, 'Yeniden adlandırılamadı.'));
      return;
    }
    reload();
  }

  async function trash(entry: FileEntry): Promise<void> {
    // A confirmation, because the trash is not yet visible anywhere: until there is a screen that
    // lists it, "moved to the trash" and "gone" look the same to the person who clicked.
    if (!window.confirm(`"${entry.name}" çöp kutusuna taşınsın mı?`)) return;
    setBusy('Çöp kutusuna taşınıyor…');
    const { error: problem } = await api.DELETE('/files/{id}', {
      params: { path: { id: entry.id } },
    });
    setBusy(null);
    if (problem !== undefined) {
      setError(problemMessage(problem, 'Taşınamadı.'));
      return;
    }
    reload();
  }

  async function upload(file: File): Promise<void> {
    setError(null);
    try {
      for await (const progress of uploadFile(file, parentId)) {
        setBusy(`${file.name} — ${progress}%`);
      }
      setBusy(null);
      reload();
    } catch (problem) {
      setBusy(null);
      setError(problemMessage(problem, `${file.name} yüklenemedi.`));
    }
  }

  return (
    <section className="card wide">
      <div className="row-between">
        <h1>Dosyalar</h1>
        <div className="actions">
          <button type="button" onClick={() => void createFolder()} disabled={busy !== null}>
            Yeni klasör
          </button>
          <button type="button" onClick={() => fileInput.current?.click()} disabled={busy !== null}>
            Yükle
          </button>
          <input
            ref={fileInput}
            type="file"
            hidden
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              // Cleared immediately so choosing the SAME file twice fires `change` the second time.
              e.target.value = '';
              if (chosen !== undefined) void upload(chosen);
            }}
          />
        </div>
      </div>

      <nav className="crumbs" aria-label="Konum">
        <button type="button" className="crumb" onClick={() => setTrail([])}>
          Kök
        </button>
        {trail.map((crumb, index) => (
          <span key={crumb.id}>
            {' / '}
            <button
              type="button"
              className="crumb"
              onClick={() => setTrail(trail.slice(0, index + 1))}
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </nav>

      {busy !== null && (
        <p className="muted" role="status">
          {busy}
        </p>
      )}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {entries === null ? (
        <p className="muted">Yükleniyor…</p>
      ) : entries.length === 0 ? (
        <p className="muted">Bu klasör boş.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Ad</th>
                <th>Boyut</th>
                <th>Değiştirilme</th>
                <th aria-label="İşlemler" />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    {entry.kind === 'folder' ? (
                      <button
                        type="button"
                        className="linklike"
                        onClick={() => setTrail([...trail, { id: entry.id, name: entry.name }])}
                      >
                        📁 {entry.name}
                      </button>
                    ) : (
                      <span>📄 {entry.name}</span>
                    )}
                  </td>
                  <td>{entry.kind === 'folder' ? '—' : formatBytes(entry.size)}</td>
                  <td className="hide-narrow">{formatWhen(entry.modifiedAt)}</td>
                  <td className="actions">
                    {entry.kind === 'file' && (
                      // A plain link, not a fetch into memory. The session is a same-origin cookie,
                      // so the browser sends it; the server answers with Content-Disposition:
                      // attachment, and a multi-gigabyte file never touches this tab's heap.
                      <a
                        className="button-like"
                        href={`${API_BASE_URL}/files/${entry.id}/content`}
                        download={entry.name}
                      >
                        İndir
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => void rename(entry)}
                      disabled={busy !== null}
                    >
                      Ad değiştir
                    </button>
                    <button
                      type="button"
                      onClick={() => void trash(entry)}
                      disabled={busy !== null}
                    >
                      Çöpe at
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Five mebibytes. Small enough that a dropped connection loses little, large enough that a
 * gigabyte is two hundred requests rather than two thousand. */
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
    headers: {
      'upload-length': String(file.size),
      'upload-metadata': metadata,
    },
  });
  if (!created.ok) throw await problemOf(created);
  const location = created.headers.get('location');
  if (location === null) throw new Error('Sunucu yükleme adresi vermedi.');

  let offset = 0;
  while (offset < file.size) {
    const end = Math.min(offset + CHUNK_BYTES, file.size);
    const chunk = file.slice(offset, end);
    const sent = await fetch(location, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/offset+octet-stream',
        'upload-offset': String(offset),
      },
      body: chunk,
    });

    if (sent.status === 409) {
      // The server and this loop disagree about where the file is. The server is right — it seeks
      // the staging file itself — so resume from what it says rather than retrying blindly.
      const authoritative = Number(sent.headers.get('upload-offset') ?? '');
      if (Number.isSafeInteger(authoritative) && authoritative >= 0) {
        offset = authoritative;
        continue;
      }
      throw await problemOf(sent);
    }
    if (!sent.ok) throw await problemOf(sent);

    offset = end;
    yield Math.round((offset / Math.max(1, file.size)) * 100);
  }
}

/** tus metadata is base64, and `btoa` cannot take a non-Latin-1 string — a Turkish filename would
 * throw before it ever reached the network. */
function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function problemOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return new Error(`Sunucu ${response.status} döndü.`);
  }
}

function formatWhen(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '—';
  return when.toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' });
}
