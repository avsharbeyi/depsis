import type { OpenApi } from '@depsis/contracts';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';

import { Account } from './Account.js';
import { api } from './api.js';
import { Apps } from './Apps.js';
import { Backups } from './Backups.js';
import { Disks } from './Disks.js';
import { Background } from './Background.js';
import { formatBytes } from './Dashboard.js';
import { Files } from './Files.js';
import { Notes } from './Notes.js';
import { Notifications } from './Notifications.js';
import { usePrefs, type Prefs } from './prefs.js';
import { Remote } from './Remote.js';
import { SetupWizard } from './SetupWizard.js';
import { setSoundEnabled, sfx } from './sfx.js';
import { Shares } from './Shares.js';
import { Shortcuts } from './Shortcuts.js';
import { SidePanel } from './SidePanel.js';
import { BrandMark, SignIn } from './SignIn.js';
import { Sky } from './sky.js';
import { useSnapshot, type Snapshot } from './snapshot.js';
import { Tasks } from './Tasks.js';
import { Tiles } from './Tiles.js';
import { Transfers } from './Transfers.js';
import { toneRgb, Toasts, useToasts, Win, type Tone } from './ui.js';
import { Jobs } from './Jobs.js';
import { Teams } from './Teams.js';
import { Users } from './Users.js';

/**
 * The console is the one pane loaded on demand, and the reason is a measurement rather than a
 * habit.
 *
 * `@xterm/xterm` is 333 kB raw / 84 kB gzipped — measured by building twice with the imports
 * stubbed — which is MORE than the entire rest of this application. Bundling it into the initial
 * chunk makes every sign-in on a phone pay for a terminal emulator, and a terminal is the pane
 * most sessions never open: it is administrator-only and asks for a password again before it will
 * do anything.
 *
 * Split out, the first paint costs ~92 kB gzipped instead of ~177 kB, and the console's own chunk
 * is fetched while its password form is on screen — so the wait lands in a moment the person is
 * already typing through.
 */
const Console = lazy(() => import('./Console.js').then((module) => ({ default: module.Console })));

/** Straight from the contract, so a field renamed in the YAML breaks this file. */
type CurrentUser = OpenApi.components['schemas']['CurrentUser'];

/** What a screen calls to say something happened. Passed down rather than imported so that a
 *  screen cannot raise a toast into a toaster that is not on the page. */
type Notify = (kind: 'ok' | 'error', text: string) => void;

/* ─── panes ─────────────────────────────────────────────────────────────────── */

export type PaneId =
  | 'files'
  | 'notes'
  | 'tasks'
  | 'users'
  | 'teams'
  | 'jobs'
  | 'shares'
  | 'disks'
  | 'account'
  | 'transfers'
  | 'backups'
  | 'apps'
  | 'remote'
  | 'console'
  | 'background';

interface PaneMeta {
  /** The fragment this pane answers to. Turkish, because the address bar is user-facing text. */
  slug: string;
  label: string;
  glyph: string;
  tone: Tone;
  /** Wide windows are the ones that are unusable at the default 780px: a terminal, a grid, a tree. */
  wide: boolean;
  /**
   * Hidden from a member entirely, rather than shown and refused. The console and the account list
   * are admin endpoints end to end — a member has nothing to read there, so an entry that only ever
   * produces a 403 is a button that lies about what the appliance can do for them.
   */
  adminOnly: boolean;
}

const PANES: Record<PaneId, PaneMeta> = {
  files: {
    slug: 'dosyalar',
    label: 'Dosyalar',
    glyph: '🗂',
    tone: 'iris',
    wide: true,
    adminOnly: false,
  },
  jobs: {
    // Admin-only, matching the endpoint. `GET /jobs/{jobId}` is safe for anybody because holding
    // the id IS the authorisation; a LISTING has no such property — it would show a member every
    // piece of work happening in the tenant.
    // NOT `isler`: the `tasks` pane below is already that, and it is a person's to-do list. These
    // are the queue's jobs — `permissions.apply`, `identity.sync` — and two docks entries reading
    // "İşler" would be two different things with one name.
    slug: 'sistem-isleri',
    label: 'Sistem işleri',
    glyph: '⚙',
    tone: 'warn',
    wide: false,
    adminOnly: true,
  },
  teams: {
    // NOT admin-only. Granting a permission means naming a principal, and a member with `manage`
    // on one folder has to be able to see which teams exist in order to name one — the same
    // reasoning `GET /teams` uses to serve every signed-in caller. Only the mutations are gated,
    // and they are gated inside the screen.
    slug: 'ekipler',
    label: 'Ekipler',
    glyph: '👥',
    tone: 'iris',
    wide: false,
    adminOnly: false,
  },
  shares: {
    // Reading the list is not an admin endpoint, and it should not be: the address is the thing an
    // ordinary member needs most and the one thing they cannot guess. Only republishing is gated.
    slug: 'paylasimlar',
    label: 'Paylaşımlar',
    glyph: '💽',
    tone: 'cool',
    wide: false,
    adminOnly: false,
  },
  disks: {
    // Admin-only, matching `GET /system/disks`. The endpoint reports every disk's model, serial
    // and what is stored on it; none of that is a member's business, and a dock entry that only
    // ever produces a 403 is a button that lies about what the appliance can do for them.
    slug: 'diskler',
    label: 'Diskler',
    glyph: '🖴',
    tone: 'cool',
    wide: false,
    adminOnly: true,
  },
  notes: {
    slug: 'notlar',
    label: 'Notlar',
    glyph: '📝',
    tone: 'warn',
    wide: false,
    adminOnly: false,
  },
  tasks: { slug: 'isler', label: 'İşler', glyph: '✓', tone: 'live', wide: false, adminOnly: false },
  transfers: {
    slug: 'aktarimlar',
    label: 'Aktarımlar',
    glyph: '⇅',
    tone: 'cool',
    wide: false,
    adminOnly: false,
  },
  backups: {
    // `BackupsController` carries `AdminGuard` on the class, so READING the list is refused for a
    // member exactly as taking a backup is. Offering the window and then showing the 403 empty
    // state is the lie this flag exists to prevent.
    slug: 'yedekleme',
    label: 'Yedekleme',
    glyph: '🛡',
    tone: 'live',
    wide: false,
    adminOnly: true,
  },
  apps: {
    slug: 'uygulamalar',
    label: 'Uygulamalar',
    glyph: '🧩',
    tone: 'iris',
    wide: true,
    adminOnly: false,
  },
  remote: {
    slug: 'uzak',
    label: 'Uzak erişim',
    glyph: '🌐',
    tone: 'cool',
    wide: false,
    adminOnly: false,
  },
  console: {
    slug: 'konsol',
    label: 'Konsol',
    glyph: '▮',
    tone: 'dim',
    wide: true,
    adminOnly: true,
  },
  users: {
    slug: 'kullanicilar',
    label: 'Kullanıcılar',
    glyph: '👥',
    tone: 'warn',
    wide: false,
    adminOnly: true,
  },
  account: {
    slug: 'hesap',
    label: 'Hesabım',
    glyph: '👤',
    tone: 'iris',
    wide: false,
    adminOnly: false,
  },
  background: {
    slug: 'arkaplan',
    label: 'Arka plan',
    glyph: '🎨',
    tone: 'iris',
    wide: false,
    adminOnly: false,
  },
};

/** Dock order. Deliberately not `Object.keys(PANES)`: this is the order they appear in the bar,
 *  and it is a design decision rather than whatever order the object literal happens to have. */
const DOCK_ORDER: PaneId[] = [
  'files',
  'shares',
  'disks',
  'notes',
  'tasks',
  'transfers',
  'backups',
  'apps',
  'remote',
  'console',
  'users',
  'teams',
  'jobs',
  'account',
  'background',
];

const PANE_IDS = Object.keys(PANES) as PaneId[];

export function paneHref(pane: PaneId): string {
  return `#/${PANES[pane].slug}`;
}

function paneFromHash(): PaneId | null {
  const slug = window.location.hash.replace(/^#\/?/, '');
  return PANE_IDS.find((id) => PANES[id].slug === slug) ?? null;
}

/* ─── shell chrome ──────────────────────────────────────────────────────────── */

/** The tint behind a dock or menu glyph. The stylesheet sizes `.g` per context but leaves the
 *  colour to the markup, exactly as the reference does. */
function tint(tone: Tone, alpha: number): string {
  const [r, g, b] = toneRgb(tone);
  return `rgba(${r},${g},${b},${alpha})`;
}

function greeting(hour: number): string {
  if (hour < 12) return 'İyi sabahlar';
  if (hour < 18) return 'İyi günler';
  return 'İyi akşamlar';
}

/**
 * The `Sky` props implied by a saved preference.
 *
 * A `solid` background with no preset and a `file` background with no file id are both refused by
 * the server, but an older document or a half-written one can still arrive here. Falling back to
 * the galaxy is the only option that leaves something on the screen; a black rectangle is
 * indistinguishable from a broken appliance.
 */
function skyProps(prefs: Prefs): {
  mode: 'sky' | 'solid' | 'file';
  preset?: string;
  fileId?: string;
} {
  const background = prefs.background;
  if (background === undefined) return { mode: 'sky' };
  if (background.kind === 'solid' && background.preset !== undefined) {
    return { mode: 'solid', preset: background.preset };
  }
  if (background.kind === 'file' && background.fileId !== undefined) {
    return { mode: 'file', fileId: background.fileId };
  }
  return { mode: 'sky' };
}

/**
 * One sentence about the appliance, built from what was actually measured.
 *
 * The reference hard-codes "Her şey yolunda"; a status line that says that while a pool is
 * degraded is worse than no status line, because it is the one place an operator looks before
 * deciding not to look any further.
 */
function statusLine(snapshot: Snapshot | null): string {
  if (snapshot === null) return 'Durum okunuyor…';
  if (snapshot.telemetryNote !== null) return snapshot.telemetryNote;

  const telemetry = snapshot.telemetry;
  if (telemetry === null) return 'Sistem durumu okunamadı.';

  const ailing = telemetry.pools.filter((pool) => pool.health !== 'ONLINE');
  if (ailing.length > 0) {
    return `${ailing.map((pool) => `${pool.name} · ${pool.health}`).join(', ')} — havuz dikkat istiyor`;
  }
  const sickDisks = (telemetry.disks ?? []).filter((disk) => !disk.healthy);
  if (sickDisks.length > 0) {
    return `${sickDisks.length} disk sağlıksız bildiriyor`;
  }
  if (telemetry.pools.length === 0) return 'Henüz havuz yok. Depolama kurulmayı bekliyor.';
  return `Her şey yolunda · ${telemetry.pools.length} havuz çevrimiçi`;
}

/**
 * Where a drive temperature stops being unremarkable.
 *
 * Spinning disks are specified to about 60 °C and the failure rate climbs well before that, so 45
 * is "watch it" and 55 is "it is too hot". These are the operator's thresholds, not the contract's
 * — the API reports the number and says nothing about what it means.
 */
function diskTone(celsius: number): Tone {
  if (celsius >= 55) return 'rose';
  if (celsius >= 45) return 'warn';
  return 'live';
}

/** Highest reported disk temperature, which is the only one worth a single pill. */
function hottestDisk(snapshot: Snapshot | null): number | null {
  const readings = (snapshot?.telemetry?.disks ?? [])
    .map((disk) => disk.temperatureCelsius)
    .filter((value): value is number => typeof value === 'number');
  return readings.length === 0 ? null : Math.max(...readings);
}

/* ─── pre-session screens ───────────────────────────────────────────────────── */

/**
 * The same glass card and the same sky the sign-in form uses, so the appliance does not change
 * character between "not reachable", "not claimed" and "signed in".
 *
 * `SignIn` and `SetupWizard` mount their own copies of this arrangement rather than being wrapped
 * in it — they were written that way and nesting a second `.centered` inside this one would give
 * the card two grids to be centred in.
 */
function AuthShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <Sky mode="sky" />
      <div className="vig" />
      <div className="centered">{children}</div>
    </>
  );
}

type Screen =
  | { name: 'loading' }
  | { name: 'unreachable' }
  | { name: 'setup' }
  | { name: 'sign-in'; note: string | null }
  | { name: 'signed-in' };

export function App(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>({ name: 'loading' });

  useEffect(() => {
    void (async () => {
      try {
        const { data } = await api.GET('/setup/status', {});
        if (data === undefined) {
          setScreen({ name: 'unreachable' });
          return;
        }
        if (data.setupRequired) {
          setScreen({ name: 'setup' });
          return;
        }
        // A live cookie means the app should come up signed in rather than at the login form.
        // Asking `/me` is what decides it, because the cookie is HttpOnly and this code cannot
        // read it.
        const me = await api.GET('/me', {});
        setScreen(me.data === undefined ? { name: 'sign-in', note: null } : { name: 'signed-in' });
      } catch {
        // Deliberately not "setup required". A server that cannot answer is a different problem
        // from a server that has not been claimed, and showing the wizard here would invite
        // someone to type a claim token into a form that cannot possibly work.
        setScreen({ name: 'unreachable' });
      }
    })();
  }, []);

  switch (screen.name) {
    case 'loading':
      return (
        <AuthShell>
          <p className="note">Yükleniyor…</p>
        </AuthShell>
      );

    case 'unreachable':
      return (
        <AuthShell>
          <main className="authcard">
            <BrandMark />
            <h1>Sunucuya ulaşılamıyor</h1>
            <p>DEPSIS API yanıt vermedi. Servisin çalıştığını doğrulayın:</p>
            <p className="val">systemctl status depsis-api</p>
            <div className="row">
              <button type="button" className="b pri" onClick={() => window.location.reload()}>
                Yeniden dene
              </button>
            </div>
          </main>
        </AuthShell>
      );

    case 'setup':
      return <SetupWizard onComplete={() => setScreen({ name: 'sign-in', note: null })} />;

    case 'sign-in':
      return <SignIn note={screen.note} onSignedIn={() => setScreen({ name: 'signed-in' })} />;

    case 'signed-in':
      return <Desktop onSignedOut={(note) => setScreen({ name: 'sign-in', note })} />;
  }
}

/* ─── the desktop ───────────────────────────────────────────────────────────── */

/**
 * The appliance, once there is a session: a sky, a status bar, the desk, and a dock behind the
 * brand mark.
 *
 * Still no routing library. `location.hash` gives every pane an address — a link to `#/konsol`
 * opens the console — and eleven modal panes need neither nested layouts nor code splitting.
 */
function Desktop({
  onSignedOut,
}: {
  onSignedOut: (note: string | null) => void;
}): React.JSX.Element {
  const [me, setMe] = useState<CurrentUser | null>(null);
  /** Bumped to re-read `/me`. Enrolling a second factor changes `mfaEnrolled` and the remaining
   *  recovery-code count, and a stale copy of those is a screen that lies about the account. */
  const [meKey, setMeKey] = useState(0);
  const [failed, setFailed] = useState(false);
  const [pane, setPane] = useState<PaneId | null>(paneFromHash);
  const [dockOpen, setDockOpen] = useState(false);
  const [powerOpen, setPowerOpen] = useState(false);
  const { toasts, push, dismiss } = useToasts();
  const { prefs, save, loaded: prefsLoaded } = usePrefs();

  const brandRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const powerRef = useRef<HTMLButtonElement>(null);
  const powerMenuRef = useRef<HTMLDivElement>(null);

  /**
   * A 401 anywhere means the session ended — expired, revoked, or the account disabled — and the
   * only correct response is to go back to the sign-in form and say why.
   *
   * This exists because an earlier version turned every `/me` failure into `null` and rendered an
   * unconditional "Loading…", so a session that ended while the tab was open left the product
   * apparently frozen with no error and no way forward.
   *
   * The optional `note` is how a half-finished batch survives the sign-out. Signing out unmounts
   * the whole desk, the toast stack with it, so a screen that lost its session at item 47 of 200
   * permanent deletes cannot report the 46 it already destroyed in a toast — nobody would ever see
   * it. The sign-in form is the only surface still standing, so the tally is carried to it.
   */
  const onUnauthenticated = useCallback(
    (note?: string) => {
      onSignedOut(note ?? 'Oturumunuz sona erdi. Lütfen tekrar giriş yapın.');
    },
    [onSignedOut],
  );

  useEffect(() => {
    void (async () => {
      try {
        const { data, response } = await api.GET('/me', {});
        if (response.status === 401) {
          onUnauthenticated();
          return;
        }
        if (data === undefined) {
          setFailed(true);
          return;
        }
        setMe(data);
      } catch {
        setFailed(true);
      }
    })();
  }, [onUnauthenticated, meKey]);

  useEffect(() => {
    const onHashChange = (): void => setPane(paneFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Escape closes whichever transient surface is open. The modal windows handle their own Escape
  // in `Win`; the dock and the power menu have no focus trap and would otherwise be dismissable
  // only by clicking, which on a touch screen means clicking exactly nothing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setDockOpen(false);
      setPowerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Clicking the desk closes the dock and the power menu. Both are anchored panels rather than
  // modals — nothing dims behind them — so leaving them open while the user works elsewhere makes
  // them look like part of the furniture until one is clicked by accident.
  useEffect(() => {
    if (!dockOpen && !powerOpen) return undefined;
    const onDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const inside = (node: Element | null): boolean => node !== null && node.contains(target);
      if (!inside(brandRef.current) && !inside(dockRef.current)) setDockOpen(false);
      if (!inside(powerRef.current) && !inside(powerMenuRef.current)) setPowerOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [dockOpen, powerOpen]);

  const isAdmin = me?.role === 'admin';
  const snapshot = useSnapshot({ isAdmin, onUnauthenticated });

  const openPane = useCallback((next: PaneId) => {
    sfx.open();
    window.location.hash = paneHref(next);
    setPane(next);
    setDockOpen(false);
    setPowerOpen(false);
  }, []);

  const closePane = useCallback(() => {
    sfx.close();
    window.location.hash = '#/';
    setPane(null);
  }, []);

  /** The dock and the power menu are anchored panels rather than windows, so they get the short
   *  click rather than the window chord. */
  const toggleDock = useCallback(() => {
    sfx.click();
    setDockOpen((open) => !open);
  }, []);

  // The stored preference is what the audio layer answers to, so a desk opened on a second device
  // is as quiet or as loud as the account left it — and a save the server refuses leaves the sound
  // exactly as it was, because this follows `prefs` rather than the click.
  const soundOn = prefs.sound === true;
  useEffect(() => {
    setSoundEnabled(prefsLoaded && soundOn);
  }, [prefsLoaded, soundOn]);

  const toggleSound = useCallback(() => {
    void (async () => {
      const next = prefs.sound !== true;
      const ok = await save({ ...prefs, sound: next });
      if (!ok) {
        push('error', 'Ses tercihi kaydedilemedi.');
        return;
      }
      // Enabled and sounded here rather than left to the effect above: the browser only lets an
      // AudioContext start inside a gesture, and this click is that gesture. Answering the switch
      // with a sound is also the only proof the user gets that it did anything.
      if (next) {
        setSoundEnabled(true);
        sfx.open();
      }
    })();
  }, [prefs, push, save]);

  if (failed) {
    return (
      <AuthShell>
        <main className="authcard">
          <h1>Hesabınız okunamadı</h1>
          <div className="notice error" role="alert">
            <span className="ic" aria-hidden>
              !
            </span>
            <span className="tx">
              Sunucu yanıt verdi ama hesap bilgisi gelmedi. Sayfayı yenilemek çoğu zaman yeter.
            </span>
          </div>
          <div className="row">
            <button type="button" className="b pri" onClick={() => window.location.reload()}>
              Yenile
            </button>
          </div>
        </main>
      </AuthShell>
    );
  }

  if (me === null) {
    return (
      <AuthShell>
        <p className="note">Yükleniyor…</p>
      </AuthShell>
    );
  }

  // A member reaching an admin pane by typing its address gets the desk, not a refusal: the pane
  // is not theirs to open and pretending it exists in order to deny it teaches nothing.
  const visiblePane = pane !== null && PANES[pane].adminOnly && !isAdmin ? null : pane;
  const dock = DOCK_ORDER.filter((id) => !PANES[id].adminOnly || isAdmin);

  const memory = snapshot?.telemetry?.memory;
  const load = snapshot?.telemetry?.cpu.loadAverage?.[0];
  const temperature = hottestDisk(snapshot);

  return (
    <div className="os">
      <Sky {...skyProps(prefs)} />
      <div className="vig" />

      <header className="top">
        <div className="who">
          <div className="n">
            {greeting(new Date().getHours())}, {me.username}
          </div>
          <div className="s">{statusLine(snapshot)}</div>
        </div>
        <div className="sp" />

        {/* The dot rides the FIRST pill, as it does in the reference: the header's whole job is
            that a glance at its left edge is a heartbeat. It is tinted by the hottest disk rather
            than painted green unconditionally — a fixed green dot beside a reading of 61 °C is a
            claim about health that the number on the far right contradicts. */}
        <div className="pill" title="İşlemci yükü (1 dk)">
          <i
            style={
              temperature === null ? undefined : { background: tint(diskTone(temperature), 1) }
            }
          />
          <span>{load === undefined ? '— yük' : `${load.toFixed(2).replace('.', ',')} yük`}</span>
        </div>
        <div className="pill" title="Bellek">
          <span>
            {memory?.usedBytes === undefined || memory.totalBytes === undefined
              ? '— bellek'
              : `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`}
          </span>
        </div>
        <div className="pill" title="En sıcak disk">
          <span>{temperature === null ? '— °C' : `${temperature} °C`}</span>
        </div>

        {/* Ses düğmesinin SOLUNDA ve güç düğmesinin solunda: sağdaki iki düğme her oturumda
            aynı yerde duran şeyler, ve zil onların arasına girseydi her yeni bildirimde
            değişmeyen bir düzende gözün aradığı yer kayardı. */}
        <Notifications onOpenPane={openPane} />

        <button
          type="button"
          className="tbtn"
          aria-pressed={soundOn}
          // Disabled until the stored preference is known: the click writes the WHOLE document,
          // and writing one built on placeholders would erase the desk this account arranged.
          disabled={!prefsLoaded}
          onClick={toggleSound}
        >
          <i />
          <span>{soundOn ? 'Ses açık' : 'Ses'}</span>
        </button>
        <button
          type="button"
          className="tbtn pw"
          aria-label="Güç"
          aria-expanded={powerOpen}
          ref={powerRef}
          onClick={() => {
            sfx.click();
            setPowerOpen((open) => !open);
          }}
        >
          ⏻
        </button>
      </header>

      <div className="main">
        {snapshot === null ? (
          <div className="left">
            <section className="card">
              <div className="cb">
                <p className="note">Cihaz durumu okunuyor…</p>
              </div>
            </section>
          </div>
        ) : (
          <>
            <div className="left">
              <Tiles snapshot={snapshot} onOpen={openPane} />
              {/* Not rendered until the saved layout has actually been read. The field commits
                  every arrangement with a PUT of the whole preferences document, so a desk drawn
                  from placeholders is one click away from overwriting the real one — and the
                  "Boş bir yere tıklayarak kısayol ekleyin" hint would meanwhile be asserting that
                  a desk nobody has read yet is empty. */}
              {prefsLoaded ? (
                <Shortcuts prefs={prefs} save={save} onOpen={openPane} notify={push} />
              ) : (
                <div className="shorts">
                  <span className="thint" style={{ position: 'absolute', left: 2, top: 4 }}>
                    Kısayollar okunuyor…
                  </span>
                </div>
              )}
            </div>
            <SidePanel snapshot={snapshot} onOpen={openPane} />
          </>
        )}
      </div>

      <div
        className="brandbox"
        role="button"
        tabIndex={0}
        aria-expanded={dockOpen}
        aria-label="Alt barı aç"
        ref={brandRef}
        onClick={toggleDock}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          toggleDock();
        }}
      >
        <span className="mark">D</span>
        <span className="nm">DEPSIS</span>
        <span className="ar" aria-hidden>
          <svg viewBox="0 0 12 12">
            <polyline points="2,7.5 6,3.5 10,7.5" />
          </svg>
        </span>
      </div>

      <nav className={dockOpen ? 'dock on' : 'dock'} aria-label="Uygulamalar" ref={dockRef}>
        {dock.map((id) => {
          const meta = PANES[id];
          return (
            <button key={id} type="button" className="dk" onClick={() => openPane(id)}>
              <span className="g" style={{ background: tint(meta.tone, 0.24) }} aria-hidden>
                {meta.glyph}
              </span>
              {meta.label}
            </button>
          );
        })}
      </nav>

      <div className={powerOpen ? 'pmenu top on' : 'pmenu top'} ref={powerMenuRef}>
        <div className="pmh">Oturum</div>
        <button
          type="button"
          className="pm"
          onClick={() => {
            setPowerOpen(false);
            window.location.reload();
          }}
        >
          <span className="g" style={{ background: tint('cool', 0.24) }} aria-hidden>
            ↻
          </span>
          Yenile
        </button>
        <button
          type="button"
          className="pm danger"
          onClick={() => {
            setPowerOpen(false);
            // The cookie is HttpOnly, so only the server can end the session. The sign-in form is
            // shown either way: a logout that failed must not leave the user looking at a desk
            // they believe they have left.
            void api
              .POST('/auth/logout', {})
              .catch(() => undefined)
              .finally(() => onSignedOut(null));
          }}
        >
          <span className="g" style={{ background: tint('rose', 0.24) }} aria-hidden>
            ⏻
          </span>
          Çıkış yap
        </button>
      </div>

      {visiblePane !== null && (
        <Win
          title={PANES[visiblePane].label}
          glyph={PANES[visiblePane].glyph}
          tone={PANES[visiblePane].tone}
          wide={PANES[visiblePane].wide}
          onClose={closePane}
        >
          <PaneBody
            onAccountChanged={() => setMeKey((k) => k + 1)}
            pane={visiblePane}
            me={me}
            isAdmin={isAdmin}
            snapshot={snapshot}
            prefs={prefs}
            prefsLoaded={prefsLoaded}
            save={save}
            notify={push}
            onUnauthenticated={onUnauthenticated}
          />
        </Win>
      )}

      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

/**
 * The contents of the open window.
 *
 * Kept out of `Desktop` so the switch stays exhaustive under the eye of the compiler: adding a
 * `PaneId` without giving it a screen is then a type error rather than an empty window.
 */
function PaneBody({
  pane,
  me,
  isAdmin,
  snapshot,
  prefs,
  prefsLoaded,
  save,
  onAccountChanged,
  notify,
  onUnauthenticated,
}: {
  pane: PaneId;
  me: CurrentUser;
  isAdmin: boolean;
  snapshot: Snapshot | null;
  prefs: Prefs;
  prefsLoaded: boolean;
  save: (next: Prefs) => Promise<boolean>;
  notify: Notify;
  /** `note` replaces the default sign-out sentence — see `onUnauthenticated` on the desk. */
  onUnauthenticated: (note?: string) => void;
  /** Ask the shell to re-read `/me`. See `meKey`. */
  onAccountChanged: () => void;
}): React.JSX.Element {
  switch (pane) {
    case 'files':
      return <Files notify={notify} isAdmin={isAdmin} onUnauthenticated={onUnauthenticated} />;
    case 'notes':
      return <Notes notify={notify} />;
    case 'tasks':
      return <Tasks notify={notify} me={me} users={snapshot?.users ?? null} />;
    case 'shares':
      return <Shares notify={notify} isAdmin={isAdmin} onUnauthenticated={onUnauthenticated} />;
    case 'users':
      return <Users currentUserId={me.id} notify={notify} onUnauthenticated={onUnauthenticated} />;
    case 'teams':
      return <Teams notify={notify} isAdmin={isAdmin} onUnauthenticated={onUnauthenticated} />;
    case 'jobs':
      return <Jobs onUnauthenticated={onUnauthenticated} />;
    case 'account':
      return <Account me={me} notify={notify} onChanged={onAccountChanged} />;
    case 'transfers':
      return <Transfers notify={notify} />;
    case 'backups':
      // Backups reads the pool figures it is about to write over, so it cannot render before the
      // first telemetry answer. Waiting is honest; a zeroed capacity next to a "start backup"
      // button is not.
      return snapshot === null ? (
        <p className="note">Cihaz durumu okunuyor…</p>
      ) : (
        <Backups notify={notify} snapshot={snapshot} />
      );
    case 'disks':
      // Waits for the first telemetry answer for the same reason Backups does — it joins SMART
      // health onto the inventory by id, and a table whose health column is empty for every row
      // reads as "no SMART data" rather than as "not asked yet".
      return snapshot === null ? (
        <p className="note">Cihaz durumu okunuyor…</p>
      ) : (
        <Disks notify={notify} snapshot={snapshot} />
      );
    case 'apps':
      return <Apps notify={notify} isAdmin={isAdmin} onUnauthenticated={onUnauthenticated} />;
    case 'remote':
      return <Remote notify={notify} isAdmin={isAdmin} />;
    case 'console':
      // The fallback is deliberately quiet. A spinner for a chunk that usually arrives in under a
      // second is a flash of loading state; one line of muted text is not.
      return (
        <Suspense fallback={<p className="note">Konsol yükleniyor…</p>}>
          <Console notify={notify} />
        </Suspense>
      );
    case 'background':
      // Same gate as the shortcut field: every swatch here writes the whole preferences document,
      // so until the stored one has been read there is nothing safe to write over it with.
      return prefsLoaded ? (
        <Background prefs={prefs} save={save} notify={notify} />
      ) : (
        <p className="note">Tercihler okunuyor…</p>
      );
  }
}
