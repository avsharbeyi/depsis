import type { OpenApi } from '@depsis/contracts';
import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react';

import { api } from './api.js';
import { sfx } from './sfx.js';

/**
 * The pieces every screen is assembled from.
 *
 * The rule this file enforces is that no screen invents its own card, window, dialog or toast.
 * The previous version of the appliance grew four slightly different confirmation dialogs, one
 * per screen, and by the time the fourth was written the first one still used `window.confirm` —
 * an unstyleable box that puts the most destructive action in the product behind something that
 * looks like a phishing prompt.
 */

/* ─── tones ─────────────────────────────────────────────────────────────────── */

export type Tone = 'cool' | 'live' | 'iris' | 'warn' | 'rose' | 'dim';

/**
 * The whole palette, in one place.
 *
 * The reference wrote every badge tint inline — `rgba(91,200,245,.24)` appears a dozen times in
 * its markup. Copied into a dozen React components that becomes a dozen places to disagree the
 * first time a colour is adjusted, so the components take a tone name and look the value up here.
 */
export const TONES: Record<Tone, string> = {
  cool: '#5BC8F5',
  live: '#4FE3A8',
  iris: '#8FA6FF',
  warn: '#F5B944',
  rose: '#FF7E8A',
  dim: '#5B6D7E',
};

/** The same colours as channels, for the canvas plots in `sky.tsx`, which need gradients. */
export function toneRgb(tone: Tone): [number, number, number] {
  const hex = TONES[tone];
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function toneTint(tone: Tone, alpha: number): string {
  const [r, g, b] = toneRgb(tone);
  return `rgba(${r},${g},${b},${alpha})`;
}

/* ─── the brand mark ────────────────────────────────────────────────────────── */

/**
 * The only icon still drawn as a path. Everything else on the desktop is a glyph, but the mark
 * on the sign-in screen is the first thing anyone sees of the appliance and an emoji will not do.
 */
export function IconLogo(props: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 192 192" aria-hidden {...props}>
      <rect width="192" height="192" rx="34" fill="url(#depsis-mark)" />
      <defs>
        <linearGradient id="depsis-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={TONES.cool} />
          <stop offset="1" stopColor={TONES.iris} />
        </linearGradient>
      </defs>
      <g fill="none" stroke="#06202B" strokeWidth="11" strokeLinecap="round">
        <ellipse cx="96" cy="58" rx="52" ry="20" />
        <path d="M44 58v76c0 11 23 20 52 20s52-9 52-20V58" />
        <path d="M44 96c0 11 23 20 52 20s52-9 52-20" />
      </g>
    </svg>
  );
}

/* ─── primitives ────────────────────────────────────────────────────────────── */

/**
 * The tinted square that labels a card, a row or a menu item.
 *
 * The tint is the tone at 24% and the ink is the tone at full strength — the reference's ratio,
 * kept because at 24% the badge reads as a surface rather than as a second button.
 */
export function Glyph({
  tone,
  size,
  children,
}: {
  tone: Tone;
  size?: number;
  children: React.ReactNode;
}): React.JSX.Element {
  const style: React.CSSProperties = { background: toneTint(tone, 0.24), color: TONES[tone] };
  if (size !== undefined) {
    style.width = size;
    style.height = size;
    style.borderRadius = Math.round(size * 0.29);
    style.fontSize = Math.round(size * 0.46);
  }
  return (
    <span className="gl" style={style} aria-hidden>
      {children}
    </span>
  );
}

/**
 * A glass panel with a header strip. Becomes a tile — hoverable, clickable, reachable by
 * keyboard — the moment it is given an `onClick`.
 *
 * The header always renders its `.st` slot even when there is no meta text, because that element
 * carries `margin-left:auto` in the stylesheet and it is what pushes the actions to the right.
 * Without it a card with buttons and no meta puts them against the title.
 */
export function Card({
  glyph,
  tone,
  title,
  meta,
  actions,
  className,
  onClick,
  children,
}: {
  glyph: React.ReactNode;
  tone: Tone;
  title: string;
  meta?: string;
  actions?: React.ReactNode;
  className?: string;
  onClick?: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const classes = ['card'];
  if (onClick !== undefined) classes.push('tile');
  if (className !== undefined && className !== '') classes.push(className);

  const interactive =
    onClick === undefined
      ? {}
      : {
          role: 'button',
          tabIndex: 0,
          onClick,
          onKeyDown: (event: React.KeyboardEvent<HTMLElement>): void => {
            // A div with a click handler is invisible to the keyboard. Enter and Space are what
            // a real button answers to, and Space has to be swallowed or the desktop scrolls.
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            onClick();
          },
        };

  return (
    <section className={classes.join(' ')} {...interactive}>
      <div className="ch">
        <Glyph tone={tone}>{glyph}</Glyph>
        <span className="tt">{title}</span>
        <span className="st">{meta ?? ''}</span>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** A thin progress track. `ratio` is 0…1; anything else is treated as empty rather than drawn. */
export function Bar({ ratio }: { ratio: number }): React.JSX.Element {
  const safe = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  return (
    <div
      className="bar2"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(safe * 100)}
    >
      <span style={{ width: `${safe * 100}%` }} />
    </div>
  );
}

/**
 * What a list shows when it is empty. Takes an action so "no files here" can offer the upload
 * button instead of leaving the reader to find it.
 */
export function Empty({
  glyph,
  text,
  action,
}: {
  glyph: React.ReactNode;
  text: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="empty">
      <span className="ic" aria-hidden>
        {glyph}
      </span>
      <b>{text}</b>
      {action}
    </div>
  );
}

/* ─── overlays ──────────────────────────────────────────────────────────────── */

/**
 * Escape belongs to the topmost overlay only.
 *
 * A window can open a confirmation on top of itself, and both are listening. Without a stack one
 * Escape closes both, so the user answers a question they never saw and the window they were
 * working in disappears with it.
 */
const escapeStack: Array<() => void> = [];

function useEscape(onEscape: () => void): void {
  const latest = useRef(onEscape);
  useEffect(() => {
    latest.current = onEscape;
  });

  useEffect(() => {
    const entry = (): void => latest.current();
    escapeStack.push(entry);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (escapeStack[escapeStack.length - 1] !== entry) return;
      event.stopPropagation();
      entry();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const at = escapeStack.indexOf(entry);
      if (at >= 0) escapeStack.splice(at, 1);
    };
  }, []);
}

/**
 * Move focus into an overlay on open and put it back where it came from on close.
 *
 * Skipping the second half is the bug that makes a keyboard user start over from the top of the
 * page every time they close a dialog.
 */
function useOverlayFocus<T extends HTMLElement>(ref: React.RefObject<T | null>): void {
  useEffect(() => {
    const opener = document.activeElement;
    ref.current?.focus();
    return () => {
      // The opener can be gone — a row's own delete button, on a row the dialog just removed.
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [ref]);
}

/**
 * Closes when the backdrop itself is the thing pressed.
 *
 * `mousedown` rather than `click`: with `click` a text selection that starts inside the window and
 * ends outside it counts as a click on the backdrop, and the window vanishes mid-drag.
 */
function backdropCloser(onClose: () => void) {
  return (event: React.MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose();
  };
}

/** A modal window. `wide` is for the console and the app grid, which are unusable at 780px. */
export function Win({
  title,
  glyph,
  tone,
  wide,
  onClose,
  children,
}: {
  title: string;
  glyph: React.ReactNode;
  tone: Tone;
  wide?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const labelId = useId();
  useEscape(onClose);
  useOverlayFocus(ref);

  // The width is set here rather than through a class because the stylesheet has no `.win.wide`
  // rule; the class still goes on so the two can be reconciled later without touching callers.
  const style: React.CSSProperties | undefined =
    wide === true ? { width: 'min(1120px, 100%)' } : undefined;

  return (
    <div className="ovl" onMouseDown={backdropCloser(onClose)}>
      <div
        className={wide === true ? 'win wide' : 'win'}
        style={style}
        ref={ref}
        role="dialog"
        aria-modal
        aria-labelledby={labelId}
        tabIndex={-1}
      >
        <div className="wh">
          <Glyph tone={tone}>{glyph}</Glyph>
          <span className="tt" id={labelId}>
            {title}
          </span>
          <button type="button" className="wx" onClick={onClose} aria-label="Kapat">
            ×
          </button>
        </div>
        <div className="wb">{children}</div>
      </div>
    </div>
  );
}

/**
 * A yes/no question. `list` names the things about to be affected — deleting "3 öğe" without
 * saying which three is how people lose the wrong folder.
 */
export function ConfirmBox({
  title,
  body,
  list,
  yesLabel,
  danger,
  onYes,
  onNo,
}: {
  title: string;
  body: string;
  list?: string[];
  yesLabel: string;
  danger?: boolean;
  onYes: () => void;
  onNo: () => void;
}): React.JSX.Element {
  // The focus target is a button rather than the box, so the answer is one Enter away. It is a
  // ref rather than `autoFocus` because the overlay hook runs in an effect, and an effect that
  // focuses the container would take the focus straight back off an autofocused child.
  const focusRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  useEscape(onNo);
  useOverlayFocus(focusRef);

  // The reference sounds this box on the way up, and it is the one place the sound earns its keep:
  // a destructive question that appears while somebody is looking elsewhere is the question they
  // answer without reading. Silent unless the account asked for sound.
  useEffect(() => {
    sfx.warn();
  }, []);

  return (
    <div className="ovl" onMouseDown={backdropCloser(onNo)}>
      <div
        className={danger === true ? 'cf danger' : 'cf'}
        role="alertdialog"
        aria-modal
        aria-labelledby={titleId}
        aria-describedby={bodyId}
      >
        <h3 id={titleId}>{title}</h3>
        <p id={bodyId}>{body}</p>
        {list !== undefined && list.length > 0 && (
          <div className="lst2">
            {/* Keyed by position, not by text: a trash listing is flat across the whole share, so
                two rows can legitimately read the same — same name, same size, different folder —
                and the list is fixed for as long as the box is open. */}
            {list.map((item, index) => (
              <span key={index}>{item}</span>
            ))}
          </div>
        )}
        <div className="row">
          {/* On a destructive question the safe answer takes the focus, so a stray Enter cancels
              rather than deletes. On an ordinary one the affirmative does, because that is what
              the reader opened the box to press. */}
          <button
            type="button"
            className="no"
            onClick={onNo}
            ref={danger === true ? focusRef : null}
          >
            Vazgeç
          </button>
          <button
            type="button"
            className="yes"
            onClick={onYes}
            ref={danger === true ? null : focusRef}
          >
            {yesLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Ask for one string — a folder name, a nickname, a network id. */
export function PromptBox({
  title,
  label,
  initial,
  confirmLabel,
  onSubmit,
  onCancel,
}: {
  title: string;
  label: string;
  initial?: string;
  confirmLabel: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState(initial ?? '');
  const ref = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const fieldId = useId();
  useEscape(onCancel);
  useOverlayFocus(ref);

  const trimmed = value.trim();

  return (
    <div className="ovl" onMouseDown={backdropCloser(onCancel)}>
      <form
        className="cf"
        aria-labelledby={titleId}
        onSubmit={(event) => {
          event.preventDefault();
          // Enter on an empty field must do nothing rather than submit an empty name; the API
          // would reject it, but a 422 for something the form already knows is a wasted round
          // trip and a confusing error.
          if (trimmed !== '') onSubmit(trimmed);
        }}
      >
        <h3 id={titleId}>{title}</h3>
        <label htmlFor={fieldId}>{label}</label>
        <input
          id={fieldId}
          ref={ref}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoComplete="off"
        />
        <div className="row">
          <button type="button" className="no" onClick={onCancel}>
            Vazgeç
          </button>
          <button type="submit" className="yes" disabled={trimmed === ''}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ─── the folder picker ─────────────────────────────────────────────────────── */

type PickEntry = OpenApi.components['schemas']['FileEntry'];

/** One crumb of the picker's own trail. Ids, not names — same reason the file manager navigates
 *  by id: a name is not what the server resolves against (ADR-0005). */
interface PickCrumb {
  id: string;
  name: string;
}

/** The contract's ceiling for one page. The picker does not paginate, so a folder with more
 *  children than this says so rather than drawing a truncated list as if it were complete. */
const PICK_LIMIT = 200;

/**
 * Choose a destination folder.
 *
 * The tree is walked one listing at a time instead of expanded in advance: `GET /files` answers a
 * page per folder, and a picker that preloaded the tree would ask the appliance for every folder
 * on it in order to show the four the reader can actually see.
 *
 * `excludeIds` closes subtrees, not just rows. This picker is the only way down into a folder, so
 * a folder that cannot be entered cannot have its children chosen either — which is exactly the
 * rule that has to hold, because moving a folder inside itself is a cycle. It is a SET and not one
 * id because a move is a batch: with two source folders selected, a single-id exclusion left the
 * second one enterable and choosable, and the server's 409 then landed halfway through the batch —
 * the other rows inside the source, the source itself still where it was. A disabled row says so
 * before the click, and says it for every source.
 *
 * `null` from `onPick` is the share root: the trail starts empty, and `GET /files` with no
 * `parentId` is what the contract calls "the caller's roots". The second argument is the
 * destination as the reader saw it named, so the caller can put it in what it reports afterwards.
 */
export function FolderPicker({
  title,
  excludeIds,
  confirmLabel,
  onPick,
  onCancel,
}: {
  title: string;
  /** Bu girdiler ve alt ağaçları seçilemez — bir klasörü kendi içine taşımak döngü üretir. */
  excludeIds?: ReadonlySet<string>;
  confirmLabel: string;
  onPick: (parentId: string | null, where: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [trail, setTrail] = useState<PickCrumb[]>([]);
  const [folders, setFolders] = useState<PickEntry[] | null>(null);
  /** Told apart from "no subfolders": one is a fact about the folder, the other is a failed read,
   *  and a picker that showed "boş" for a listing nobody managed to load would invite the reader
   *  to drop a folder into a place they never saw. */
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);

  const ref = useRef<HTMLDivElement>(null);
  const labelId = useId();
  useEscape(onCancel);
  useOverlayFocus(ref);

  const here = trail[trail.length - 1];
  const parentId = here?.id;

  useEffect(() => {
    let cancelled = false;
    setFolders(null);
    setFailed(false);
    void (async () => {
      const { data } = await api.GET('/files', {
        params: {
          query: parentId === undefined ? { limit: PICK_LIMIT } : { parentId, limit: PICK_LIMIT },
        },
      });
      if (cancelled) return;
      if (data === undefined) {
        setFailed(true);
        setMore(false);
        return;
      }
      // Files are dropped rather than greyed out: this list answers one question — which folder —
      // and every row that cannot answer it is noise between the reader and the row that can.
      // Trashed entries never appear here at all; `trashed` defaults to false on the endpoint.
      setFolders(
        data.items
          .filter((item) => item.kind === 'folder')
          .sort((a, b) => a.name.localeCompare(b.name, 'tr')),
      );
      setMore(data.hasMore);
    })();
    return () => {
      cancelled = true;
    };
  }, [parentId]);

  const where = trail.length === 0 ? 'Paylaşım kökü' : trail.map((crumb) => crumb.name).join(' / ');

  return (
    <div className="ovl" onMouseDown={backdropCloser(onCancel)}>
      <div
        className="win"
        ref={ref}
        role="dialog"
        aria-modal
        aria-labelledby={labelId}
        tabIndex={-1}
      >
        <div className="wh">
          <Glyph tone="iris">⇄</Glyph>
          <span className="tt" id={labelId}>
            {title}
          </span>
          <button type="button" className="wx" onClick={onCancel} aria-label="Kapat">
            ×
          </button>
        </div>
        <div className="wb">
          {/* `.addr` carries a 13px side margin for the file manager's own columns; inside a
              window body that already has padding it would sit inset from everything else. */}
          <div className="addr" style={{ margin: 0 }}>
            <span className="nav">
              <button
                type="button"
                title="Yukarı"
                aria-label="Yukarı"
                disabled={trail.length === 0}
                onClick={() => setTrail((current) => current.slice(0, -1))}
              >
                ↑
              </button>
            </span>
            <span className="path">
              {trail.length === 0 ? (
                <b>Paylaşım kökü</b>
              ) : (
                <button type="button" onClick={() => setTrail([])}>
                  Paylaşım kökü
                </button>
              )}
              {trail.map((crumb, index) => (
                <Fragment key={crumb.id}>
                  {' / '}
                  {index === trail.length - 1 ? (
                    <b>{crumb.name}</b>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setTrail((current) => current.slice(0, index + 1))}
                    >
                      {crumb.name}
                    </button>
                  )}
                </Fragment>
              ))}
            </span>
          </div>

          {/* `.flist` owns the file manager's column inset and grows to fill its card; here it is
              one panel among several in a window body, so it keeps only the scrolling. */}
          <div className="flist" style={{ padding: 0, maxHeight: 300 }}>
            {failed ? (
              <Empty glyph="⚠" text="Klasörler okunamadı." />
            ) : folders === null ? (
              <Empty glyph="⋯" text="Yükleniyor…" />
            ) : folders.length === 0 ? (
              <Empty glyph="🗂" text="Burada alt klasör yok. Buraya taşıyabilirsiniz." />
            ) : (
              folders.map((folder) => {
                const blocked = excludeIds?.has(folder.id) === true;
                const enter = (): void =>
                  setTrail((current) => [...current, { id: folder.id, name: folder.name }]);
                return (
                  <div
                    key={folder.id}
                    className="frow"
                    role="button"
                    tabIndex={blocked ? -1 : 0}
                    aria-disabled={blocked}
                    style={blocked ? { opacity: 0.45 } : { cursor: 'pointer' }}
                    onClick={blocked ? undefined : enter}
                    onKeyDown={
                      blocked
                        ? undefined
                        : (event) => {
                            // A div with a click handler is invisible to the keyboard, and Space
                            // has to be swallowed or the list scrolls out from under the row.
                            if (event.key !== 'Enter' && event.key !== ' ') return;
                            event.preventDefault();
                            enter();
                          }
                    }
                  >
                    {/* `.frow .g` is sized by its parent's rule, so it cannot be the shared
                        `Glyph`, which owns its own dimensions. Only the tint is shared. */}
                    <span
                      className="g"
                      style={{ background: toneTint('iris', 0.22), color: TONES.iris }}
                      aria-hidden
                    >
                      📁
                    </span>
                    <span className="n" title={folder.name}>
                      {folder.name}
                    </span>
                    <span className="sz">{blocked ? 'taşınan klasör' : '›'}</span>
                  </div>
                );
              })
            )}
          </div>

          <div className="note">
            Hedef: <b>{where}</b>
            {more ? ' · Bu klasörde gösterilenden fazla alt klasör var.' : ''}
          </div>

          {/* The stylesheet's only button row is `.cf .row`, which belongs to the confirmation
              box; a window body has no rule for one, so the alignment is written here. */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="mk" onClick={onCancel}>
              Vazgeç
            </button>
            <button
              type="button"
              className="mk up"
              onClick={() => onPick(parentId ?? null, here?.name ?? where)}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── toasts ────────────────────────────────────────────────────────────────── */

export interface Toast {
  id: number;
  kind: 'ok' | 'error';
  text: string;
}

let nextToastId = 1;

/**
 * Transient messages that do not move the page.
 *
 * A message rendered inline pushes the list down and, halfway through a long one, lands off
 * screen — so the user sees nothing happen and clicks again. Successes clear themselves after
 * four seconds; failures never do. An error that disappears before it is read is the same as no
 * error at all, and the person is left with a file that quietly did not upload.
 */
export function useToasts(): {
  toasts: Toast[];
  push: (kind: Toast['kind'], text: string) => void;
  dismiss: (id: number) => void;
} {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (kind: Toast['kind'], text: string) => {
      const id = nextToastId++;
      setToasts((current) => [...current, { id, kind, text }]);
      // Two different sounds, because the two messages want different things from the reader: one
      // is an acknowledgement they can ignore, the other is a failure they have to come back to.
      if (kind === 'ok') {
        sfx.ok();
        window.setTimeout(() => dismiss(id), 4000);
      } else {
        sfx.error();
      }
    },
    [dismiss],
  );

  return { toasts, push, dismiss };
}

export function Toasts({
  toasts,
  dismiss,
}: {
  toasts: Toast[];
  dismiss: (id: number) => void;
}): React.JSX.Element {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={toast.kind === 'error' ? 'toast error' : 'toast'}
          role={toast.kind === 'error' ? 'alert' : 'status'}
        >
          <span className="g" aria-hidden>
            {toast.kind === 'error' ? '!' : '✓'}
          </span>
          <span className="n">{toast.text}</span>
          <button type="button" className="x" onClick={() => dismiss(toast.id)} aria-label="Kapat">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
