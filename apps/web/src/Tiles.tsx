import type { OpenApi } from '@depsis/contracts';
import { useEffect, useState } from 'react';

import type { PaneId } from './App.js';
import { api } from './api.js';
import { formatBytes, formatWhen, percent } from './Dashboard.js';
import type { Snapshot } from './snapshot.js';
import { Bar, Card, Empty } from './ui.js';

type FileEntry = OpenApi.components['schemas']['FileEntry'];
type Note = OpenApi.components['schemas']['Note'];
type Task = OpenApi.components['schemas']['Task'];

/**
 * The row of three summaries across the top of the desktop.
 *
 * Each tile answers one question and opens the window that answers it properly. They are a fixed
 * 232px tall (`.tiles` in the stylesheet) because a summary that grows with its contents pushes
 * the actual work surface — the file manager below — off the screen.
 */

/** The listing is only ever read for a count and four rows, so one page is enough. */
const ROOT_PAGE = 50;

interface Desk {
  /** False until the first round trip has finished, so "empty" and "not asked yet" differ. */
  loaded: boolean;
  root: { entries: FileEntry[]; hasMore: boolean } | null;
  notes: Note[] | null;
  tasks: Task[] | null;
}

const NOTHING: Desk = { loaded: false, root: null, notes: null, tasks: null };

export function Tiles({
  snapshot,
  meId,
  onOpen,
  hideFiles = false,
}: {
  snapshot: Snapshot;
  meId: string;
  onOpen: (pane: PaneId) => void;
  /**
   * Dosyalar kutusu çizilmesin.
   *
   * Telefonda ana ekranın en üstünde dosya gezgininin KENDİSİ duruyor; hemen altına bir de
   * "Dosyalar" özet kutusu koymak, aynı adı taşıyan iki kutunun alt alta durması demek. Kutunun
   * söylediği şey (kaç öğe var, en son ne değişti) zaten üstteki gezginde görünüyor.
   */
  hideFiles?: boolean;
}): React.JSX.Element {
  const [desk, setDesk] = useState<Desk>(NOTHING);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      // In parallel: three summaries that do not depend on each other should not add their
      // latencies together on a screen the user is staring at.
      const [root, notes, tasks] = await Promise.all([
        api.GET('/files', { params: { query: { sort: 'modified', limit: ROOT_PAGE } } }),
        api.GET('/notes', {}),
        api.GET('/tasks', {}),
      ]);
      if (cancelled) return;

      // A 401 is left alone here. `useSnapshot` polls the same session and owns the sign-out, and
      // two components racing to unmount the application produced a flash of the login form under
      // the old dashboard.
      setDesk({
        loaded: true,
        root:
          root.data === undefined ? null : { entries: root.data.items, hasMore: root.data.hasMore },
        notes: notes.data?.items ?? null,
        tasks: tasks.data?.items ?? null,
      });
    };

    void load();
    // Fifteen seconds. A note written in the notes window should reach its tile while the user is
    // still on the desktop, and three small reads at that rate are nothing next to the telemetry
    // poll that is already running.
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="tiles">
      {!hideFiles && <FilesTile desk={desk} snapshot={snapshot} onOpen={onOpen} />}
      <NotesTile desk={desk} onOpen={onOpen} />
      <TasksTile desk={desk} meId={meId} onOpen={onOpen} />
    </div>
  );
}

/* ─── files ─────────────────────────────────────────────────────────────────── */

function FilesTile({
  desk,
  snapshot,
  onOpen,
}: {
  desk: Desk;
  snapshot: Snapshot;
  onOpen: (pane: PaneId) => void;
}): React.JSX.Element {
  const root = desk.root;
  const count = root === null ? '—' : `${root.entries.length}${root.hasMore ? '+' : ''}`;

  /**
   * The size beside the count is the pool's used space, not the sum of the rows above it.
   *
   * Adding up the listing would be wrong in a way nobody would catch: a folder reports `size: 0`,
   * so the sum is the weight of the loose files in the root and nothing else — a number that says
   * "1.2 MiB" about a full two-terabyte appliance.
   */
  const pools = snapshot.telemetry?.pools ?? [];
  const used = pools.reduce((sum, pool) => sum + pool.used, 0);
  const size = pools.length === 0 ? '' : ` · ${formatBytes(used)}`;

  // Sorted here as well as asked for in the query: the contract names a `modified` sort but not a
  // direction, and "son değişenler" with the oldest first is the opposite of what it claims to be.
  const recent =
    root === null
      ? []
      : [...root.entries].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 4);

  return (
    <Card
      glyph="🗂"
      tone="iris"
      title="Dosyalar"
      meta={root === null ? '' : `${count} öğe`}
      onClick={() => onOpen('files')}
    >
      <div className="tbody">
        {!desk.loaded && <span className="thint">Yükleniyor…</span>}
        {desk.loaded && root === null && <Empty glyph="🗂" text="Dosyalar okunamadı" />}
        {root !== null && (
          <>
            <div className="tfig">
              {count}
              <small>öğe{size}</small>
            </div>
            {recent.length === 0 ? (
              <Empty glyph="🗂" text="Kökte henüz bir şey yok" />
            ) : (
              <div className="tmini">
                {recent.map((entry) => (
                  <div className="r" key={entry.id}>
                    <span>{entry.name}</span>
                    <em>{formatWhen(entry.modifiedAt)}</em>
                  </div>
                ))}
              </div>
            )}
            <span className="thint">Açmak için tıklayın →</span>
          </>
        )}
      </div>
    </Card>
  );
}

/* ─── notes ─────────────────────────────────────────────────────────────────── */

function NotesTile({
  desk,
  onOpen,
}: {
  desk: Desk;
  onOpen: (pane: PaneId) => void;
}): React.JSX.Element {
  const notes = desk.notes;
  // Newest edit first: the note someone is in the middle of writing is the one worth a slot.
  const recent =
    notes === null
      ? []
      : [...notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3);

  return (
    <Card
      glyph="📝"
      tone="warn"
      title="Notlar"
      meta={notes === null ? '' : `${notes.length} not`}
      onClick={() => onOpen('notes')}
    >
      <div className="tbody">
        {!desk.loaded && <span className="thint">Yükleniyor…</span>}
        {desk.loaded && notes === null && <Empty glyph="📝" text="Notlar okunamadı" />}
        {notes !== null &&
          (recent.length === 0 ? (
            <Empty glyph="📝" text="Henüz not yok" />
          ) : (
            <div className="nlist">
              {/* Rows rather than buttons. The whole tile opens the notes window; a row that
                  opened one particular note would be a second target inside a target, and on a
                  touch screen the two are indistinguishable. */}
              {recent.map((note) => (
                <div className="nitem" key={note.id}>
                  <span className="t">{note.title}</span>
                  <span className="d">{formatWhen(note.updatedAt)}</span>
                </div>
              ))}
            </div>
          ))}
        {notes !== null && <span className="thint">Büyütmek için tıklayın →</span>}
      </div>
    </Card>
  );
}

/* ─── tasks ─────────────────────────────────────────────────────────────────── */

function TasksTile({
  desk,
  meId,
  onOpen,
}: {
  desk: Desk;
  meId: string;
  onOpen: (pane: PaneId) => void;
}): React.JSX.Element {
  // Sahibin kurali: PANO herkesindir, ama MASAÜSTÜ kisiseldir — bu kutucukta yalniz bana
  // atanmis (ya da henuz kimseye atanmamis) isler durur. Baskasinin isini burada
  // saymak, "senin 3 isin var" diyen bir sayacin yalan soylemesiydi.
  const tasks =
    desk.tasks === null
      ? null
      : desk.tasks.filter((task) => task.assigneeId === meId || task.assigneeId === null);
  const done = tasks === null ? 0 : tasks.filter((task) => task.doneAt !== null).length;
  const total = tasks?.length ?? 0;

  /**
   * Unfinished work first, finished work only to fill the gap.
   *
   * `/tasks` returns completed items too, and ordered by position alone a board whose top three
   * entries were ticked off last week shows a tile with nothing left to do on it.
   */
  const byPosition = (a: Task, b: Task): number => a.position - b.position;
  const pending = tasks === null ? [] : tasks.filter((t) => t.doneAt === null).sort(byPosition);
  const finished = tasks === null ? [] : tasks.filter((t) => t.doneAt !== null).sort(byPosition);
  const shown = [...pending, ...finished].slice(0, 3);

  return (
    <Card
      glyph="✓"
      tone="live"
      title="İşler"
      meta={tasks === null ? '' : `${done}/${total}`}
      onClick={() => onOpen('tasks')}
    >
      <div className="tbody">
        {!desk.loaded && <span className="thint">Yükleniyor…</span>}
        {desk.loaded && tasks === null && <Empty glyph="✓" text="İşler okunamadı" />}
        {tasks !== null &&
          (total === 0 ? (
            <Empty glyph="✓" text="İş listesi boş" />
          ) : (
            <>
              <div className="prog">
                <Bar ratio={done / total} label="Tamamlanan işler" />
                <em>{percent(done, total)}</em>
              </div>
              {shown.map((task) => (
                <div className={task.doneAt === null ? 'jitem' : 'jitem done'} key={task.id}>
                  {/* A span, not a button: ticking an item off belongs in the window where the
                      change can be undone and its failure reported. */}
                  <span className={task.doneAt === null ? 'jck' : 'jck on'} aria-hidden>
                    ✓
                  </span>
                  <span className="tx">{task.body}</span>
                </div>
              ))}
            </>
          ))}
      </div>
    </Card>
  );
}
