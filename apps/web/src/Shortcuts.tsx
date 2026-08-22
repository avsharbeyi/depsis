import { useCallback, useEffect, useRef, useState } from 'react';

import type { PaneId } from './App.js';
import type { Prefs } from './prefs.js';
import { toneRgb, type Tone } from './ui.js';

/**
 * The shortcut field on the desktop.
 *
 * Grid-snapped rather than free-floating, exactly as the reference draws it. A desk where icons
 * land wherever the finger let go looks untidy inside a week, and — more to the point — a saved
 * layout of pixel coordinates is meaningless on the next screen the same account signs in from.
 * What is stored is a list of cells, and it is stored on the SERVER (`/me/preferences`), because
 * somebody who arranges their desk on the television must find that desk on their phone.
 */

interface PaneMeta {
  id: PaneId;
  label: string;
  glyph: string;
  tone: Tone;
}

/**
 * Everything that can become a shortcut.
 *
 * The label lives here rather than in the saved preference: `Preferences.shortcuts[].label` exists
 * in the contract, but a copy written into the database in March is a copy that still says the old
 * name in June. The id is the durable part, the wording is the interface's business.
 */
const CATALOGUE: readonly PaneMeta[] = [
  { id: 'files', label: 'Dosyalar', glyph: '🗂', tone: 'iris' },
  { id: 'notes', label: 'Notlar', glyph: '📝', tone: 'warn' },
  { id: 'tasks', label: 'İşler', glyph: '✓', tone: 'live' },
  { id: 'users', label: 'Kullanıcılar', glyph: '👥', tone: 'warn' },
  { id: 'account', label: 'Hesabım', glyph: '👤', tone: 'cool' },
  { id: 'transfers', label: 'Aktarımlar', glyph: '⇅', tone: 'cool' },
  { id: 'backups', label: 'Yedekleme', glyph: '🛡', tone: 'live' },
  { id: 'apps', label: 'Uygulamalar', glyph: '🧩', tone: 'iris' },
  { id: 'remote', label: 'Uzak erişim', glyph: '🌐', tone: 'cool' },
  { id: 'console', label: 'Terminal', glyph: '▮', tone: 'dim' },
  { id: 'background', label: 'Arka plan', glyph: '🎨', tone: 'iris' },
];

/** `.sc` is 78px wide in the stylesheet and the gutter between tiles is 12px. */
const CELL = 78;
const GAP = 12;
const STEP = CELL + GAP;
/** Below this the pointer was resting, not dragging, and the press is a click on the icon. */
const DRAG_SLOP = 4;

type Stored = NonNullable<Prefs['shortcuts']>[number];

interface Placed {
  id: PaneId;
  cell: number;
}

function metaFor(id: string): PaneMeta | undefined {
  return CATALOGUE.find((pane) => pane.id === id);
}

/** The tint `.sc .g` and `.pm .g` expect; the same 24%/100% pair `Glyph` uses. */
function tint(tone: Tone): React.CSSProperties {
  const [r, g, b] = toneRgb(tone);
  return { background: `rgba(${r},${g},${b},.24)`, color: `rgb(${r},${g},${b})` };
}

function readLayout(stored: readonly Stored[] | undefined): Placed[] {
  const seen = new Set<string>();
  const out: Placed[] = [];
  for (const entry of stored ?? []) {
    const pane = metaFor(entry.id);
    if (pane === undefined || seen.has(pane.id)) continue;
    seen.add(pane.id);
    out.push({ id: pane.id, cell: entry.cell });
  }
  return out;
}

/**
 * Entries this build does not recognise are carried through untouched.
 *
 * A newer version of the interface — or an older one — may have put a shortcut here for something
 * this code has never heard of. Dropping it on the first drag would silently delete part of
 * somebody's desk to fix a problem nobody had.
 */
function writeLayout(prefs: Prefs, layout: readonly Placed[]): Prefs {
  const foreign = (prefs.shortcuts ?? []).filter((entry) => metaFor(entry.id) === undefined);
  return {
    ...prefs,
    shortcuts: [...foreign, ...layout.map(({ id, cell }) => ({ id, cell }))],
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function Shortcuts({
  prefs,
  save,
  onOpen,
  notify,
}: {
  prefs: Prefs;
  save: (p: Prefs) => Promise<boolean>;
  onOpen: (pane: PaneId) => void;
  /**
   * Optional, so the shared signature — `{ prefs, save, onOpen }` — still satisfies this
   * component. Without it a refused arrangement still snaps back to where it was, which is the
   * part that must not be skipped; with it the snap-back can also say why it happened.
   */
  notify?: (kind: 'ok' | 'error', text: string) => void;
}): React.JSX.Element {
  const fieldRef = useRef<HTMLDivElement>(null);
  const [grid, setGrid] = useState<{ cols: number; rows: number }>({ cols: 1, rows: 1 });
  const [layout, setLayout] = useState<Placed[]>(() => readLayout(prefs.shortcuts));
  const [drag, setDrag] = useState<{ id: PaneId; x: number; y: number; cell: number } | null>(null);
  const [picker, setPicker] = useState<{ cell: number; x: number; y: number } | null>(null);

  /**
   * The saved layout is adopted by value, not by identity.
   *
   * `usePrefs` hands back a fresh object after every PUT, so an effect keyed on the array itself
   * would re-seed the state on every save — including the save this component just started — and
   * an icon mid-drag would jump back to where it came from. The signature only changes when the
   * cells actually do.
   */
  const signature = JSON.stringify(prefs.shortcuts ?? []);
  const storedRef = useRef<readonly Stored[] | undefined>(prefs.shortcuts);
  useEffect(() => {
    storedRef.current = prefs.shortcuts;
  });
  useEffect(() => {
    setLayout(readLayout(storedRef.current));
  }, [signature]);

  useEffect(() => {
    const field = fieldRef.current;
    if (field === null) return;
    const measure = (): void => {
      setGrid({
        cols: Math.max(1, Math.floor((field.clientWidth + GAP) / STEP)),
        rows: Math.max(1, Math.floor((field.clientHeight + GAP) / STEP)),
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(field);
    measure();
    return () => observer.disconnect();
  }, []);

  const positionOf = useCallback(
    (cell: number): { left: number; top: number } => ({
      left: (cell % grid.cols) * STEP,
      top: Math.floor(cell / grid.cols) * STEP,
    }),
    [grid.cols],
  );

  /** Where an icon whose top-left corner sits at (x, y) would land. Nearest cell, so a half-step
   *  nudge still commits to a move rather than snapping back. */
  const cellUnderCorner = useCallback(
    (x: number, y: number): number => {
      const col = clamp(Math.round(x / STEP), 0, grid.cols - 1);
      const row = clamp(Math.round(y / STEP), 0, grid.rows - 1);
      return row * grid.cols + col;
    },
    [grid.cols, grid.rows],
  );

  /** Which cell a bare click on the field belongs to. Floor, not round: a click 50px into an
   *  80px-wide cell is a click on that cell, not on the one next door. */
  const cellUnderPoint = useCallback(
    (x: number, y: number): number => {
      const col = clamp(Math.floor(x / STEP), 0, grid.cols - 1);
      const row = clamp(Math.floor(y / STEP), 0, grid.rows - 1);
      return row * grid.cols + col;
    },
    [grid.cols, grid.rows],
  );

  /**
   * Move the icons, then keep them there only if the server agreed.
   *
   * The optimistic half is deliberate — an icon that waits for a round trip before following the
   * finger feels broken. The rollback is the half that was missing: `PUT /me/preferences` answers
   * 422 on a document it refuses, `usePrefs.save` correctly leaves `prefs` untouched, and the
   * re-seed effect below is keyed on the STORED cells, which a refusal does not change. So without
   * this the icon sat happily in its new cell, nothing was written, and the desk quietly reverted
   * on the next reload.
   */
  const persist = useCallback(
    (next: Placed[]): void => {
      const previous = layout;
      setLayout(next);
      void (async () => {
        const ok = await save(writeLayout(prefs, next));
        if (ok) return;
        setLayout(previous);
        notify?.('error', 'Kısayol düzeni kaydedilemedi.');
      })();
    },
    [layout, notify, prefs, save],
  );

  /* ─── dragging ────────────────────────────────────────────────────────────── */

  const grabRef = useRef<{
    id: PaneId;
    /** Where inside the icon the finger went down, so it does not jump under the cursor. */
    dx: number;
    dy: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  /** Set when a drag ends, so the click that follows the release does not also open the pane. */
  const draggedRef = useRef(false);

  const onPointerDown = (id: PaneId, event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    grabRef.current = {
      id,
      dx: event.clientX - box.left,
      dy: event.clientY - box.top,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    // Capture, so a fast drag that outruns the pointer keeps sending moves to this element rather
    // than to whatever is underneath it.
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const grab = grabRef.current;
    const field = fieldRef.current;
    if (grab === null || field === null) return;
    if (!grab.moved) {
      const travelled = Math.hypot(event.clientX - grab.startX, event.clientY - grab.startY);
      if (travelled < DRAG_SLOP) return;
      grab.moved = true;
    }
    const rect = field.getBoundingClientRect();
    const x = event.clientX - rect.left - grab.dx;
    const y = event.clientY - rect.top - grab.dy;
    setDrag({ id: grab.id, x, y, cell: cellUnderCorner(x, y) });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const grab = grabRef.current;
    grabRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDrag(null);
    const field = fieldRef.current;
    if (grab === null || field === null) return;
    if (!grab.moved) return;
    draggedRef.current = true;

    // Recomputed from the release point rather than read off the drag state: the last pointermove
    // may not have been rendered yet, and committing a stale cell moves the icon somewhere the
    // user never saw the ghost.
    const rect = field.getBoundingClientRect();
    const target = cellUnderCorner(
      event.clientX - rect.left - grab.dx,
      event.clientY - rect.top - grab.dy,
    );

    const moving = layout.find((item) => item.id === grab.id);
    if (moving === undefined || moving.cell === target) return;
    const occupant = layout.find((item) => item.cell === target && item.id !== grab.id);
    // Occupied cells swap rather than refuse. Refusing looks like the drag failed; stacking would
    // hide one icon behind another with no way to get it back.
    const next = layout.map((item) => {
      if (item.id === grab.id) return { ...item, cell: target };
      if (occupant !== undefined && item.id === occupant.id) return { ...item, cell: moving.cell };
      return item;
    });
    // One write, on release. Saving per pointermove would spend fifty PUTs on a single drag.
    persist(next);
  };

  /* ─── adding and removing ─────────────────────────────────────────────────── */

  const add = (id: PaneId, cell: number): void => {
    const taken = new Set(layout.map((item) => item.cell));
    let free = cell;
    // The click may land on a cell that filled up while the menu was open, or the menu may have
    // been opened over an icon's shadow. Walking forward is less surprising than doing nothing.
    while (taken.has(free)) free += 1;
    persist([...layout, { id, cell: free }]);
  };

  const remove = (id: PaneId): void => {
    persist(layout.filter((item) => item.id !== id));
  };

  /* ─── the add menu ────────────────────────────────────────────────────────── */

  useEffect(() => {
    if (picker === null) return;
    const close = (): void => setPicker(null);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    // `mousedown` rather than `click`: the menu must be gone before the press lands on whatever is
    // behind it, otherwise closing it also opens a window.
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [picker]);

  const placed = new Set(layout.map((item) => item.id));
  const available = CATALOGUE.filter((pane) => !placed.has(pane.id));

  return (
    <div
      className="shorts"
      ref={fieldRef}
      onClick={(event) => {
        // Only a press on the bare field opens the menu; a press that started on an icon has
        // already been handled by the icon itself.
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        setPicker({
          cell: cellUnderPoint(event.clientX - rect.left, event.clientY - rect.top),
          x: event.clientX,
          y: event.clientY,
        });
      }}
    >
      {layout.length === 0 && (
        <span
          className="thint"
          style={{ position: 'absolute', left: 2, top: 4, pointerEvents: 'none' }}
        >
          Boş bir yere tıklayarak kısayol ekleyin.
        </span>
      )}

      <div
        className={drag === null ? 'ghost' : 'ghost on'}
        style={drag === null ? undefined : positionOf(drag.cell)}
      />

      {layout.map((item) => {
        const pane = metaFor(item.id);
        if (pane === undefined) return null;
        const dragging = drag !== null && drag.id === item.id;
        const place = dragging ? { left: drag.x, top: drag.y } : positionOf(item.cell);

        return (
          <div
            key={item.id}
            className={dragging ? 'sc dragging' : 'sc'}
            style={place}
            role="button"
            tabIndex={0}
            aria-label={pane.label}
            onPointerDown={(event) => onPointerDown(item.id, event)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onClick={() => {
              if (draggedRef.current) {
                draggedRef.current = false;
                return;
              }
              onOpen(item.id);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onOpen(item.id);
            }}
          >
            <span className="g" style={tint(pane.tone)} aria-hidden>
              {pane.glyph}
            </span>
            <span className="l">{pane.label}</span>
            <button
              type="button"
              className="x"
              aria-label={`${pane.label} kısayolunu kaldır`}
              // The press must not become a drag of the icon it sits on.
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                remove(item.id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}

      {picker !== null && (
        <div
          className="pmenu on"
          role="menu"
          aria-label="Kısayol ekle"
          // `.pmenu` is fixed and anchored to the dock in the stylesheet; here it belongs to the
          // cell that was clicked, so the anchoring is overridden rather than a class invented.
          style={{
            left: Math.min(picker.x, window.innerWidth - 248),
            top: Math.min(picker.y, window.innerHeight - 260),
            bottom: 'auto',
            transform: 'none',
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="pmh">Kısayol ekle</div>
          {available.length === 0 ? (
            <div className="pm dis">Eklenecek başka bir şey kalmadı</div>
          ) : (
            available.map((pane) => (
              <button
                key={pane.id}
                type="button"
                className="pm"
                role="menuitem"
                onClick={() => {
                  add(pane.id, picker.cell);
                  setPicker(null);
                }}
              >
                <span className="g" style={tint(pane.tone)} aria-hidden>
                  {pane.glyph}
                </span>
                {pane.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
