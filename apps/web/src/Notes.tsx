import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, problemMessage } from './api.js';
import { ConfirmBox, Empty } from './ui.js';

type Note = OpenApi.components['schemas']['Note'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

/** How long typing has to stop before the note is written back. */
const AUTOSAVE_MS = 800;

/**
 * The short date in the list — "10 Ağu", the reference's own form.
 *
 * `formatWhen` is the wrong tool here: "22.08.2026 14:03" in a 9.5px monospace column pushes the
 * title out of a 200px sidebar, and nobody scanning their own notes needs the year.
 */
function shortDate(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '—';
  return when.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
}

function clock(): string {
  return new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Notes — GET/POST /notes, PATCH/DELETE /notes/{id}.
 *
 * Private to their author by contract, which is why there is no owner column and no sharing
 * control anywhere on this screen: showing either would promise something the endpoint does not do.
 *
 * There is no save button. A note is a scratch surface and a person who types three words and
 * closes the window expects those three words to still be there; the write happens
 * `AUTOSAVE_MS` after the last keystroke, and again on the way out.
 */
export function Notes({ notify }: { notify: Notify }): React.JSX.Element {
  const [notes, setNotes] = useState<Note[] | null>(null);
  /** Told apart from "no notes": an empty list is a fact, a read that never answered is not. */
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [status, setStatus] = useState('');
  const [confirming, setConfirming] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);
  const [focusTitle, setFocusTitle] = useState(false);

  const titleRef = useRef<HTMLInputElement>(null);
  // What has been typed but not yet written back. Held in a ref rather than in state because the
  // unmount cleanup below has to read the *last* value, and a cleanup closes over the state it was
  // rendered with — which, mid-keystroke, is one render behind.
  const pendingRef = useRef<{ id: string; title: string; body: string } | null>(null);
  const timerRef = useRef<number | null>(null);

  const flush = useCallback(async (): Promise<void> => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending === null) return;

    // An empty title is a 422 the form can see coming, so the body is saved on its own instead of
    // throwing away the sentence the person just wrote because they were mid-way through
    // retitling. UpdateNoteRequest allows either field alone.
    const trimmed = pending.title.trim();
    const patch: { title?: string; body?: string } = { body: pending.body };
    if (trimmed !== '') patch.title = trimmed;

    const { data, error } = await api.PATCH('/notes/{id}', {
      params: { path: { id: pending.id } },
      body: patch,
    });
    if (error !== undefined || data === undefined) {
      notify('error', problemMessage(error, 'Not kaydedilemedi.'));
      setStatus('kaydedilemedi');
      return;
    }
    const saved = data;
    // The saved note replaces its old copy *in place*. The endpoint orders by `updated_at` and
    // re-sorting here would make the row being edited jump to the top under the reader's cursor
    // every eight hundred milliseconds.
    setNotes((current) =>
      current === null ? current : current.map((note) => (note.id === saved.id ? saved : note)),
    );
    setStatus(trimmed === '' ? `kaydedildi ${clock()} · başlık boş` : `kaydedildi ${clock()}`);
  }, [notify]);

  // The window can close between one keystroke and the timer, and closing it unmounts this
  // component. Without this the last thing typed is the one thing lost.
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  });
  useEffect(
    () => () => {
      void flushRef.current();
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void (async () => {
      const { data } = await api.GET('/notes', {});
      if (cancelled) return;
      if (data === undefined) {
        // Not `setNotes([])`. The toast fades; the panel underneath it would go on stating
        // "Henüz not yok" about a list nobody managed to read.
        notify('error', 'Notlar okunamadı.');
        setFailed(true);
        return;
      }
      setNotes(data.items);
      const first = data.items[0];
      if (first === undefined) return;
      setSelectedId(first.id);
      setTitle(first.title);
      setBody(first.body);
    })();
    return () => {
      cancelled = true;
    };
  }, [notify, reloadKey]);

  useEffect(() => {
    if (!focusTitle) return;
    setFocusTitle(false);
    titleRef.current?.select();
  }, [focusTitle]);

  function select(note: Note): void {
    void flush();
    setSelectedId(note.id);
    setTitle(note.title);
    setBody(note.body);
    setStatus('');
  }

  function edit(next: { title: string; body: string }): void {
    if (selectedId === null) return;
    setTitle(next.title);
    setBody(next.body);
    pendingRef.current = { id: selectedId, ...next };
    setStatus('yazılıyor…');
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void flush();
    }, AUTOSAVE_MS);
  }

  async function create(): Promise<void> {
    await flush();
    setBusy(true);
    const { data, error } = await api.POST('/notes', { body: { title: 'Yeni not', body: '' } });
    setBusy(false);
    if (error !== undefined || data === undefined) {
      notify('error', problemMessage(error, 'Not oluşturulamadı.'));
      return;
    }
    const created = data;
    setNotes((current) => [created, ...(current ?? [])]);
    setSelectedId(created.id);
    setTitle(created.title);
    setBody(created.body);
    setStatus('');
    // "Yeni not" is a placeholder, not a title. Selecting it means the first thing typed replaces
    // it instead of being appended to it.
    setFocusTitle(true);
  }

  async function remove(note: Note): Promise<void> {
    setConfirming(null);
    // A queued write for the note about to disappear would resurrect nothing but would report a
    // 404 as a failure the reader cannot act on.
    if (pendingRef.current?.id === note.id) pendingRef.current = null;
    setBusy(true);
    const { error } = await api.DELETE('/notes/{id}', { params: { path: { id: note.id } } });
    setBusy(false);
    if (error !== undefined) {
      notify('error', problemMessage(error, 'Not silinemedi.'));
      return;
    }
    const remaining = (notes ?? []).filter((item) => item.id !== note.id);
    setNotes(remaining);
    if (selectedId === note.id) {
      const next = remaining[0];
      if (next === undefined) {
        setSelectedId(null);
        setTitle('');
        setBody('');
      } else {
        setSelectedId(next.id);
        setTitle(next.title);
        setBody(next.body);
      }
      setStatus('');
    }
    notify('ok', 'Not silindi.');
  }

  const newButton = (
    <button type="button" className="b" disabled={busy} onClick={() => void create()}>
      ＋ Yeni not
    </button>
  );

  // Rendered by every branch below, because the question can be asked from the list and answered
  // after the list has emptied out.
  const overlay =
    confirming === null ? null : (
      <ConfirmBox
        title="Not silinsin mi?"
        body="Bu kalıcı — notların çöp kutusu yok."
        list={[confirming.title]}
        yesLabel="Sil"
        danger
        onYes={() => void remove(confirming)}
        onNo={() => setConfirming(null)}
      />
    );

  if (failed) {
    return (
      <Empty
        glyph="⚠"
        text="Notlar okunamadı."
        action={
          <button type="button" className="b" onClick={() => setReloadKey((key) => key + 1)}>
            Yeniden dene
          </button>
        }
      />
    );
  }

  if (notes === null) {
    return <div className="note">Notlar yükleniyor…</div>;
  }

  if (notes.length === 0) {
    return (
      <>
        <Empty glyph="📝" text="Henüz not yok" action={newButton} />
        {overlay}
      </>
    );
  }

  return (
    <>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '200px 1fr',
          gap: 12,
          flex: 1,
          minHeight: 0,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, minHeight: 0 }}>
          {newButton}
          <div className="nlist">
            {notes.map((note) => (
              <div
                key={note.id}
                className="nitem"
                role="button"
                tabIndex={0}
                aria-current={note.id === selectedId}
                style={
                  note.id === selectedId
                    ? { background: 'rgba(91,200,245,.16)', borderColor: 'rgba(91,200,245,.34)' }
                    : undefined
                }
                onClick={() => select(note)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  select(note);
                }}
              >
                <span className="t">{note.title}</span>
                <span className="d">{shortDate(note.updatedAt)}</span>
                <button
                  type="button"
                  className="ndel"
                  disabled={busy}
                  aria-label={`${note.title} notunu sil`}
                  title="Notu sil"
                  onClick={(event) => {
                    // The row itself opens the note; without this the delete question arrives on
                    // top of a note that was switched to underneath it.
                    event.stopPropagation();
                    setConfirming(note);
                  }}
                >
                  🗑
                </button>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
          {selectedId === null ? (
            <div className="note">Soldan bir not seçin ya da yeni not oluşturun.</div>
          ) : (
            <>
              <div className="ch" style={{ padding: 0 }}>
                <span className="tt">Not</span>
                <span className="st" aria-live="polite">
                  {status}
                </span>
              </div>
              <input
                ref={titleRef}
                className="ntitle"
                value={title}
                aria-label="Not başlığı"
                onChange={(event) => edit({ title: event.target.value, body })}
              />
              <textarea
                className="nbig"
                value={body}
                aria-label="Not metni"
                onChange={(event) => edit({ title, body: event.target.value })}
              />
              <div className="note">
                Yazdıklarınız kendiliğinden kaydedilir. Notlar yalnız size görünür.
              </div>
            </>
          )}
        </div>
      </div>

      {overlay}
    </>
  );
}
