import type { OpenApi } from '@depsis/contracts';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';

import '@xterm/xterm/css/xterm.css';

import { api, API_BASE_URL, problemMessage } from './api.js';
import { formatWhen } from './Dashboard.js';

type ConsoleSession = OpenApi.components['schemas']['ConsoleSession'];

type Notify = (kind: 'ok' | 'error', text: string) => void;

/**
 * The administrator's shell, drawn by xterm.js over the appliance's SSE console.
 *
 * The reference faked this with a `<pre>` and a canned transcript. A real one is three endpoints
 * pulling in different directions — bytes out on an event stream, bytes in on a POST, and a
 * window size the pty has to be told about — and getting any of the three wrong produces a
 * terminal that looks right and behaves like a toy: `top` drawn at the wrong width, Ctrl-C
 * swallowed, accented characters split down the middle.
 */

/* ─── the base64 boundary ───────────────────────────────────────────────────── */

/*
 * Terminal traffic is raw bytes, not text, in both directions. The contract wraps it in base64
 * for exactly that reason — SSE carries lines of text, and a UTF-8 character can straddle two
 * reads — so the conversions must go byte-for-byte. Decoding to a JavaScript string and handing
 * that to `term.write` would re-encode it as UTF-16 and corrupt every multi-byte character, which
 * in Turkish means the shell mangles half the alphabet.
 */

function decodeFrame(text: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    // A frame we cannot decode is one frame lost. Tearing the whole stream down over it would
    // lose the session as well, which is a far worse trade.
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeInput(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/* ─── the terminal's look ───────────────────────────────────────────────────── */

/*
 * xterm paints its own background, so without `allowTransparency` the terminal would be an opaque
 * black rectangle sitting on the glass — the one element on the desktop that does not belong to
 * it. The sixteen colours are the stylesheet's palette rather than xterm's defaults, so `ls`
 * comes out in the appliance's greens and blues instead of VGA's.
 */
const TERMINAL_THEME = {
  background: 'rgba(0,0,0,0)',
  foreground: '#edf3f9',
  cursor: '#5bc8f5',
  cursorAccent: '#02040a',
  selectionBackground: 'rgba(91,200,245,0.28)',
  black: '#02040a',
  red: '#ff7e8a',
  green: '#4fe3a8',
  yellow: '#f5b944',
  blue: '#5bc8f5',
  magenta: '#8fa6ff',
  cyan: '#5bc8f5',
  white: '#edf3f9',
  brightBlack: '#5b6d7e',
  brightRed: '#ff9aa4',
  brightGreen: '#7defc0',
  brightYellow: '#ffcd72',
  brightBlue: '#8bd9f8',
  brightMagenta: '#adbcff',
  brightCyan: '#8bd9f8',
  brightWhite: '#ffffff',
};

function minutes(seconds: number): string {
  return `${Math.max(1, Math.round(seconds / 60))} dakika`;
}

/* ─── the screen ────────────────────────────────────────────────────────────── */

/**
 * What the door said when it refused to open.
 *
 * `fatal` separates "try again" from "stop trying": a wrong password is worth a second attempt,
 * a missing role or a stopped service is not, and a form that stays live after the second kind
 * invites the user to keep typing their password at something that will never answer.
 */
interface OpenFailure {
  text: string;
  command?: string;
  fatal: boolean;
}

export function Console({ notify }: { notify: Notify }): React.JSX.Element {
  const [session, setSession] = useState<ConsoleSession | null>(null);
  const [password, setPassword] = useState('');
  const [opening, setOpening] = useState(false);
  const [failure, setFailure] = useState<OpenFailure | null>(null);
  /** Set when the server has told us this session is gone; the terminal stays, frozen. */
  const [ended, setEnded] = useState(false);
  /** How many shells were already open when this screen loaded. An admin should know. */
  const [others, setOthers] = useState(0);

  const wellRef = useRef<HTMLDivElement>(null);
  const pendingClose = useRef<number | null>(null);

  /*
   * Ask whether the console service is even running before asking for a password.
   *
   * `systemctl disable depsis-console` is a supported state, and typing your password into a form
   * only to be told the feature is switched off is the kind of small insult that makes people
   * stop trusting the screen.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, response } = await api.GET('/console', {});
      if (cancelled) return;
      if (response.status === 403) {
        setFailure({ text: 'Konsol yalnız yöneticilere açık.', fatal: true });
        return;
      }
      if (data === undefined) return;
      if (!data.available) {
        setFailure({
          text: 'Konsol servisi çalışmıyor.',
          command: 'systemctl status depsis-console',
          fatal: true,
        });
        return;
      }
      setOthers(data.items.length);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function openSession(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (password === '') return;
    setOpening(true);
    setFailure(null);
    // 80×24 is a placeholder the pty lives with for one frame: the fit addon measures the real
    // well as soon as the terminal is in the document and reports the true size straight after.
    const { data, error, response } = await api.POST('/console', {
      body: { password, cols: 80, rows: 24 },
    });
    setOpening(false);
    // Never leave the password in a field. The window can be reopened by anyone at the keyboard.
    setPassword('');

    if (data === undefined) {
      if (response.status === 401) {
        setFailure({ text: 'Parola hatalı.', fatal: false });
      } else if (response.status === 429) {
        // Sayaç oturum açmayla ortak (bilerek: çalınan bir çerezle burada parola denemek,
        // girişteki hızda kilitlenmeli). Kullanıcıya düşen tek şey beklemek — ve bunun bir
        // servis arızası OLMADIĞINI bilmek; ilk hâli buraya düşünce systemctl komutu öneriyordu.
        setFailure({
          text: 'Çok fazla yanlış deneme. Birkaç dakika bekleyip yeniden deneyin — bu sayaç oturum açmayla ortaktır.',
          fatal: false,
        });
      } else if (response.status === 403) {
        setFailure({ text: 'Konsol yalnız yöneticilere açık.', fatal: true });
      } else if (response.status === 503) {
        setFailure({
          text: 'Konsol servisi çalışmıyor.',
          command: 'systemctl status depsis-console',
          fatal: true,
        });
      } else {
        setFailure({ text: problemMessage(error, 'Konsol açılamadı.'), fatal: false });
      }
      return;
    }

    setEnded(false);
    setSession(data);
  }

  /*
   * Attach xterm to the open session: bytes out on the event stream, bytes in on POST, and the
   * window size on every layout change.
   */
  useEffect(() => {
    const well = wellRef.current;
    if (session === null || well === null) return;
    const id = session.id;

    const term = new Terminal({
      allowTransparency: true,
      cursorBlink: true,
      fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, 'SF Mono', monospace",
      fontSize: 12,
      lineHeight: 1.3,
      scrollback: 5000,
      theme: TERMINAL_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(well);
    fit.fit();
    term.focus();

    /** The session is gone. Freeze the terminal rather than clearing it — the last screen of a shell is often the reason someone opened it. */
    const finish = (): void => {
      term.options.disableStdin = true;
      term.blur();
      setEnded(true);
    };

    let reported = { cols: term.cols, rows: term.rows };
    const tellSize = (): void => {
      const { cols, rows } = term;
      if (cols === reported.cols && rows === reported.rows) return;
      reported = { cols, rows };
      void api.POST('/console/{id}/resize', {
        params: { path: { id } },
        body: { cols, rows },
      });
    };
    // The size that went out with POST /console was a guess, so the true one is always worth one
    // request here even when the fit did not change anything.
    void api.POST('/console/{id}/resize', {
      params: { path: { id } },
      body: { cols: reported.cols, rows: reported.rows },
    });

    // Watching the element rather than the window: this terminal lives in a modal that can be
    // resized by the layout around it without the window ever changing size.
    const observer = new ResizeObserver(() => {
      fit.fit();
      tellSize();
    });
    observer.observe(well);

    const source = new EventSource(`${API_BASE_URL}/console/${id}/stream`);
    source.addEventListener('message', (event) => {
      const raw: unknown = event.data;
      if (typeof raw !== 'string') return;
      const bytes = decodeFrame(raw);
      if (bytes !== null) term.write(bytes);
    });
    source.addEventListener('error', () => {
      // EventSource reconnects by itself after a network hiccup and only closes for good when the
      // server refuses the request — which, for this path, means the session no longer exists.
      if (source.readyState === EventSource.CLOSED) finish();
    });

    const input = term.onData((data) => {
      void (async () => {
        const { response } = await api.POST('/console/{id}/input', {
          params: { path: { id } },
          body: { data: encodeInput(data) },
        });
        if (response.status === 410) finish();
      })();
    });

    return () => {
      observer.disconnect();
      source.close();
      input.dispose();
      term.dispose();
    };
  }, [session]);

  /*
   * Hand the shell back when this screen goes away.
   *
   * Separate from the effect above because of StrictMode: React mounts every effect, tears it
   * down and mounts it again, and a DELETE issued straight from a cleanup would kill the shell
   * the user had just opened — in development only, which is the worst place to hide something
   * that looks like a server fault. The rehearsal completes within the same tick, so deferring
   * the request by one and cancelling it on the remount tells the two apart.
   */
  useEffect(() => {
    if (session === null) return;
    if (pendingClose.current !== null) {
      window.clearTimeout(pendingClose.current);
      pendingClose.current = null;
    }
    const id = session.id;
    return () => {
      pendingClose.current = window.setTimeout(() => {
        pendingClose.current = null;
        void api.DELETE('/console/{id}', { params: { path: { id } } });
      }, 0);
    };
  }, [session]);

  if (session === null) {
    const blocked = failure !== null && failure.fatal;
    return (
      <>
        <div className="note">
          Konsol, oturumunuz açıkken bile parola istiyor. Açık bırakılmış bir oturum birinin ödünç
          alabileceği bir şeydir; bir kabuk ise cihazın tamamıdır — diskler, ayarlar ve başkalarının
          dosyaları dahil.
        </div>

        {others > 0 && <div className="note">Şu anda {others} konsol oturumu daha açık.</div>}

        {failure !== null && (
          <div className="notice error" role="alert">
            <span className="ic" aria-hidden>
              !
            </span>
            <div className="tx">
              <b>{failure.text}</b>
              {failure.command !== undefined && <span className="val">{failure.command}</span>}
            </div>
          </div>
        )}

        <form onSubmit={(event) => void openSession(event)}>
          <label>
            Parolanız
            <input
              type="password"
              value={password}
              autoComplete="current-password"
              disabled={blocked}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="b pri"
            style={{ marginTop: 11 }}
            disabled={opening || blocked || password === ''}
          >
            {opening ? 'Açılıyor…' : 'Konsolu aç'}
          </button>
        </form>
      </>
    );
  }

  return (
    <>
      {session.privileged ? (
        <div className="warn" role="alert">
          <span className="ic" aria-hidden>
            ⚠
          </span>
          <div className="tx">
            <b>Bu konsol root olarak çalışıyor</b>
            Yazdığınız her komut sınırsız yetkiyle çalışır. Yanlış bir silme işlemini geri alacak
            bir onay ekranı yok.
          </div>
        </div>
      ) : (
        <div className="note">Konsol ayrıcalıksız bir kullanıcı olarak çalışıyor — root değil.</div>
      )}

      {ended && (
        <div className="notice error" role="alert">
          <span className="ic" aria-hidden>
            !
          </span>
          <div className="tx">
            <b>Oturum kapandı (boşta kalma süresi)</b>
            Ekrandaki çıktı duruyor ama artık yazamazsınız. Yeni bir konsol için parolanızı tekrar
            girin.
          </div>
        </div>
      )}

      <div className="term" ref={wellRef} />

      <div className="note">
        İş denetimi (Ctrl-Z, <span className="val">fg</span>, <span className="val">bg</span>) tam
        çalışmıyor: bunun için kontrol terminali kurmak gerekiyor, o da konsol servisinin izin
        vermediği güvensiz koda ihtiyaç duyuyor.
      </div>

      <div className="netrow">
        {/* `.lbl` is the 9px tracked uppercase section caption, not a text class — a timestamp and
            two minute figures set in it were both unreadable and the one place in this build where
            a number is not in var(--mono) with tabular figures. The caption is a caption; the
            reading goes in `.val`, which is what every other `.netrow` in the product pairs it
            with. */}
        <span className="lbl">Oturum</span>
        <span className="val">
          {session.username} · {formatWhen(session.openedAt)} · boşta{' '}
          {minutes(session.idleTimeoutSeconds)}, en çok {minutes(session.maxAgeSeconds)}
        </span>
        <button
          type="button"
          className="b danger"
          onClick={() => {
            setSession(null);
            setEnded(false);
            notify('ok', ended ? 'Konsol kapatıldı.' : 'Konsol oturumu kapatıldı.');
          }}
        >
          {ended ? 'Yeni oturum' : 'Oturumu kapat'}
        </button>
      </div>
    </>
  );
}
