import { useCallback, useEffect, useId, useRef, useState } from 'react';

/**
 * The handful of pieces every screen needs.
 *
 * They exist because the alternative was `window.prompt` and `window.confirm`, which is what the
 * first version of the file browser used to name a folder and to confirm a deletion. Those are not
 * a design decision — they cannot be styled, cannot be labelled, are blocked outright by some
 * browsers, and put the appliance's most destructive action behind a dialog that looks like a
 * phishing prompt.
 */

/* ─── icons ─────────────────────────────────────────────────────────────────
 *
 * Inline, and only the seven that are used. An icon font or a package would be a dependency and a
 * network request for a few hundred bytes of path data; these are `currentColor` so they inherit
 * whatever the surrounding text is doing, including the dark palette.
 */

type IconProps = { className?: string };

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function IconDashboard(p: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...p}>
      <g {...stroke}>
        <rect x="3" y="3" width="7.5" height="8" rx="1.5" />
        <rect x="13.5" y="3" width="7.5" height="5" rx="1.5" />
        <rect x="3" y="14" width="7.5" height="7" rx="1.5" />
        <rect x="13.5" y="11" width="7.5" height="10" rx="1.5" />
      </g>
    </svg>
  );
}

export function IconFiles(p: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...p}>
      <path {...stroke} d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h7A1.5 1.5 0 0 1 19 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5Z" />
    </svg>
  );
}

export function IconFile(p: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...p}>
      <g {...stroke}>
        <path d="M6 3.5h7l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1Z" />
        <path d="M13 3.5V8a1 1 0 0 0 1 1h4" />
      </g>
    </svg>
  );
}

export function IconUsers(p: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...p}>
      <g {...stroke}>
        <circle cx="9" cy="8" r="3.2" />
        <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" />
        <path d="M16 5.4a3.2 3.2 0 0 1 0 5.2M17.5 14.4a5.5 5.5 0 0 1 3 5.1" />
      </g>
    </svg>
  );
}

export function IconAccount(p: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...p}>
      <g {...stroke}>
        <circle cx="12" cy="8.5" r="3.5" />
        <path d="M5 20a7 7 0 0 1 14 0" />
      </g>
    </svg>
  );
}

export function IconUpload(p: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...p}>
      <g {...stroke}>
        <path d="M12 16V4.5M8 8l4-4 4 4" />
        <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
      </g>
    </svg>
  );
}

export function IconLogo(p: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 192 192" aria-hidden {...p}>
      <rect width="192" height="192" rx="34" fill="var(--accent)" />
      <g fill="none" stroke="var(--accent-fg)" strokeWidth="11" strokeLinecap="round">
        <ellipse cx="96" cy="58" rx="52" ry="20" />
        <path d="M44 58v76c0 11 23 20 52 20s52-9 52-20V58" />
        <path d="M44 96c0 11 23 20 52 20s52-9 52-20" />
      </g>
    </svg>
  );
}

/* ─── dialog ─────────────────────────────────────────────────────────────── */

interface PromptProps {
  title: string;
  label: string;
  initial?: string;
  confirmLabel?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/**
 * Ask for one string.
 *
 * A real `<dialog>` rather than a div with a high z-index: the element brings the focus trap, the
 * inert background, the backdrop and the escape key with it, and every one of those is something a
 * hand-rolled modal gets wrong the first time.
 */
export function PromptDialog({
  title,
  label,
  initial = '',
  confirmLabel = 'Tamam',
  onSubmit,
  onCancel,
}: PromptProps): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState(initial);
  const id = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    dialog.showModal();
    // `cancel` fires for the escape key. Without this the dialog closes and the component that
    // opened it still believes it is open, so the next attempt renders nothing.
    const onCancelEvent = (event: Event): void => {
      event.preventDefault();
      onCancel();
    };
    dialog.addEventListener('cancel', onCancelEvent);
    return () => dialog.removeEventListener('cancel', onCancelEvent);
  }, [onCancel]);

  return (
    <dialog ref={ref} aria-labelledby={id}>
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim() !== '') onSubmit(value.trim());
        }}
      >
        <h2 id={id}>{title}</h2>
        <label>
          {label}
          {/* Focused on open: a modal that exists for one field and does not focus it makes the
              keyboard user hunt for it. */}
          <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} required />
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Vazgeç
          </button>
          <button type="submit" className="primary" disabled={value.trim() === ''}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}

interface ConfirmProps {
  title: string;
  body: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Tamam',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmProps): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    dialog.showModal();
    const onCancelEvent = (event: Event): void => {
      event.preventDefault();
      onCancel();
    };
    dialog.addEventListener('cancel', onCancelEvent);
    return () => dialog.removeEventListener('cancel', onCancelEvent);
  }, [onCancel]);

  return (
    <dialog ref={ref} aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <p className="muted">{body}</p>
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>
          Vazgeç
        </button>
        <button
          type="button"
          className={danger ? 'danger' : 'primary'}
          onClick={onConfirm}
          // Focused on open — the dialog exists to be answered.
          autoFocus
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

/* ─── toasts ─────────────────────────────────────────────────────────────── */

export interface Toast {
  id: number;
  kind: 'ok' | 'error';
  text: string;
}

let nextToastId = 1;

/**
 * Transient messages that do not move the page.
 *
 * An error rendered inline pushes the table down and, on a long list, lands off-screen — so the
 * user sees nothing happen and clicks again. Errors do NOT auto-dismiss: a message that vanishes
 * before it is read is the same as no message.
 */
export function useToasts(): {
  toasts: Toast[];
  push: (kind: Toast['kind'], text: string) => void;
  dismiss: (id: number) => void;
} {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: Toast['kind'], text: string) => {
      const id = nextToastId++;
      setToasts((current) => [...current, { id, kind, text }]);
      if (kind === 'ok') setTimeout(() => dismiss(id), 4000);
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
        <div key={toast.id} className={`toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
          <span>{toast.text}</span>
          <button type="button" onClick={() => dismiss(toast.id)} aria-label="Kapat">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
