import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, API_BASE_URL, problemMessage } from './api.js';
import { formatBytes, formatWhen } from './Dashboard.js';
import { ConfirmDialog, IconFile, IconFiles, IconUpload, PromptDialog } from './ui.js';

type FileEntry = OpenApi.components['schemas']['FileEntry'];

interface Props {
  onUnauthenticated: () => void;
  notify: (kind: 'ok' | 'error', text: string) => void;
}

/** Where we are in the tree. The root is an empty trail. */
interface Crumb {
  id: string;
  name: string;
}

type Modal =
  | { kind: 'none' }
  | { kind: 'new-folder' }
  | { kind: 'rename'; entry: FileEntry }
  | { kind: 'trash'; entry: FileEntry };

/**
 * The file browser.
 *
 * Navigation is by `parentId`, never by a path string. That is ADR-0005's rule and it is not
 * pedantry here: the server resolves an entry by id and derives the path from `parent_id`, so a
 * client that navigated by path would be asking about a different thing than the one it displayed —
 * and during a rename of a large subtree, briefly a different thing entirely.
 */
export function Files({ onUnauthenticated, notify }: Props): React.JSX.Element {
  const [trail, setTrail] = useState<Crumb[]>([]);
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [modal, setModal] = useState<Modal>({ kind: 'none' });
  const [progress, setProgress] = useState<{ name: string; percent: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const parentId = trail.length === 0 ? undefined : trail[trail.length - 1]?.id;
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, response } = await api.GET('/files', {
        params: { query: parentId === undefined ? {} : { parentId } },
      });
      if (cancelled) return;
      if (response.status === 401) {
        onUnauthenticated();
        return;
      }
      if (data === undefined) {
        notify('error', 'Klasör okunamadı.');
        setEntries([]);
        return;
      }
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
  }, [parentId, reloadKey, onUnauthenticated, notify]);

  async function createFolder(name: string): Promise<void> {
    setModal({ kind: 'none' });
    const { error } = await api.POST('/files/folders', {
      body: parentId === undefined ? { name } : { name, parentId },
    });
    if (error !== undefined) {
      notify('error', problemMessage(error, 'Klasör oluşturulamadı.'));
      return;
    }
    notify('ok', `"${name}" oluşturuldu.`);
    reload();
  }

  async function rename(entry: FileEntry, name: string): Promise<void> {
    setModal({ kind: 'none' });
    const { error } = await api.PATCH('/files/{id}', {
      params: { path: { id: entry.id } },
      body: { name },
    });
    if (error !== undefined) {
      notify('error', problemMessage(error, 'Yeniden adlandırılamadı.'));
      return;
    }
    notify('ok', `"${entry.name}" → "${name}"`);
    reload();
  }

  async function trash(entry: FileEntry): Promise<void> {
    setModal({ kind: 'none' });
    const { error } = await api.DELETE('/files/{id}', { params: { path: { id: entry.id } } });
    if (error !== undefined) {
      notify('error', problemMessage(error, 'Taşınamadı.'));
      return;
    }
    notify('ok', `"${entry.name}" çöp kutusuna taşındı.`);
    reload();
  }

  async function upload(files: FileList | File[]): Promise<void> {
    for (const file of Array.from(files)) {
      try {
        setProgress({ name: file.name, percent: 0 });
        for await (const percent of uploadFile(file, parentId)) {
          setProgress({ name: file.name, percent });
        }
        notify('ok', `"${file.name}" yüklendi.`);
      } catch (problem) {
        notify('error', problemMessage(problem, `"${file.name}" yüklenemedi.`));
      }
    }
    setProgress(null);
    reload();
  }

  const busy = progress !== null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dosyalar</h1>
          <Crumbs trail={trail} onNavigate={setTrail} />
        </div>
        <div className="actions">
          <button type="button" onClick={() => setModal({ kind: 'new-folder' })} disabled={busy}>
            Yeni klasör
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
          >
            Yükle
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const chosen = e.target.files;
              // Cleared immediately so choosing the SAME file twice fires `change` the second time.
              e.target.value = '';
              if (chosen !== null && chosen.length > 0) void upload(chosen);
            }}
          />
        </div>
      </div>

      {progress !== null && (
        <div className="progress" role="status">
          <span>{progress.name}</span>
          <div className="bar">
            <span style={{ width: `${progress.percent}%` }} />
          </div>
          <span>{progress.percent}%</span>
        </div>
      )}

      {/* The whole panel is the drop target, not a separate strip. A dedicated zone is a second
          place to aim at and is invisible until you already know it is there. */}
      <div
        className={dragging ? 'panel dropzone over' : 'panel dropzone'}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          // `relatedTarget` outside the panel: without this, dragging over a child row fires
          // dragleave on the parent and the highlight flickers off under the cursor.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length > 0) void upload(e.dataTransfer.files);
        }}
      >
        {entries === null ? (
          <p className="muted">Yükleniyor…</p>
        ) : entries.length === 0 ? (
          <div className="empty">
            <IconUpload />
            <p>Bu klasör boş. Dosyaları buraya sürükleyin.</p>
            <button type="button" className="primary" onClick={() => fileInput.current?.click()}>
              Dosya seç
            </button>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Ad</th>
                  <th className="right">Boyut</th>
                  <th className="hide-narrow">Değiştirilme</th>
                  <th className="shrink" aria-label="İşlemler" />
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <span className="name-cell">
                        {entry.kind === 'folder' ? <IconFiles className="folder" /> : <IconFile />}
                        {entry.kind === 'folder' ? (
                          <button
                            type="button"
                            className="linklike"
                            onClick={() =>
                              setTrail([...trail, { id: entry.id, name: entry.name }])
                            }
                          >
                            {entry.name}
                          </button>
                        ) : (
                          <span>{entry.name}</span>
                        )}
                      </span>
                    </td>
                    <td className="right">
                      {entry.kind === 'folder' ? '—' : formatBytes(entry.size)}
                    </td>
                    <td className="hide-narrow">{formatWhen(entry.modifiedAt)}</td>
                    <td className="shrink">
                      <div className="row-actions">
                        {entry.kind === 'file' && (
                          // A plain link, not a fetch into memory. The session is a same-origin
                          // cookie so the browser sends it, the server answers with
                          // Content-Disposition: attachment, and a multi-gigabyte file never
                          // touches this tab's heap.
                          <a
                            href={`${API_BASE_URL}/files/${entry.id}/content`}
                            download={entry.name}
                          >
                            İndir
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={() => setModal({ kind: 'rename', entry })}
                          disabled={busy}
                        >
                          Ad değiştir
                        </button>
                        <button
                          type="button"
                          onClick={() => setModal({ kind: 'trash', entry })}
                          disabled={busy}
                        >
                          Çöpe at
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal.kind === 'new-folder' && (
        <PromptDialog
          title="Yeni klasör"
          label="Klasör adı"
          confirmLabel="Oluştur"
          onSubmit={(name) => void createFolder(name)}
          onCancel={() => setModal({ kind: 'none' })}
        />
      )}
      {modal.kind === 'rename' && (
        <PromptDialog
          title="Yeniden adlandır"
          label="Yeni ad"
          initial={modal.entry.name}
          confirmLabel="Kaydet"
          onSubmit={(name) => void rename(modal.entry, name)}
          onCancel={() => setModal({ kind: 'none' })}
        />
      )}
      {modal.kind === 'trash' && (
        <ConfirmDialog
          title="Çöp kutusuna taşı"
          // The trash has no screen yet, so "moved to the trash" and "gone" look the same to the
          // person who clicked. Saying what actually happens is the least this can do until it does.
          body={`"${modal.entry.name}" listeden kalkacak. Baytlar silinmiyor — çöp kutusunu boşaltmak ayrı bir işlem.`}
          confirmLabel="Taşı"
          danger
          onConfirm={() => void trash(modal.entry)}
          onCancel={() => setModal({ kind: 'none' })}
        />
      )}
    </>
  );
}

function Crumbs({
  trail,
  onNavigate,
}: {
  trail: Crumb[];
  onNavigate: (next: Crumb[]) => void;
}): React.JSX.Element {
  return (
    <nav className="crumbs" aria-label="Konum">
      <button type="button" onClick={() => onNavigate([])}>
        Kök
      </button>
      {trail.map((crumb, index) => (
        <span key={crumb.id} style={{ display: 'contents' }}>
          <span className="sep" aria-hidden>
            ›
          </span>
          <button type="button" onClick={() => onNavigate(trail.slice(0, index + 1))}>
            {crumb.name}
          </button>
        </span>
      ))}
    </nav>
  );
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
  if (!created.ok) throw await problemOf(created);
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
      throw await problemOf(sent);
    }
    if (!sent.ok) throw await problemOf(sent);

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

async function problemOf(response: Response): Promise<unknown> {
  if (response.status === 503) {
    return new Error('Depolama ajanı çalışmıyor, bu kurulumda yükleme yapılamaz.');
  }
  try {
    return await response.json();
  } catch {
    return new Error(`Sunucu ${response.status} döndü.`);
  }
}
