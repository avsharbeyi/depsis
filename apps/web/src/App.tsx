import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api } from './api.js';
import { Files } from './Files.js';
import { Dashboard } from './Dashboard.js';
import { SetupWizard } from './SetupWizard.js';
import { Security } from './Security.js';
import { SignIn } from './SignIn.js';
import { Users } from './Users.js';

/** Straight from the contract, so a field renamed in the YAML breaks this file. */
type CurrentUser = OpenApi.components['schemas']['CurrentUser'];

type Screen =
  | { name: 'loading' }
  | { name: 'unreachable' }
  | { name: 'setup' }
  | { name: 'sign-in'; note: string | null }
  | { name: 'signed-in'; note: string | null };

/**
 * Four panes and a hash router.
 *
 * Still no routing library. What changed since there were three screens is that the panes are now
 * addressable — a file browser that cannot be linked to, reloaded or navigated back through is not
 * a file browser — and `location.hash` gives that for nothing. A library would bring URL history,
 * nested layouts and code splitting, none of which this needs and all of which would have to be
 * pinned and justified.
 */
export function App(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>({ name: 'loading' });

  useEffect(() => {
    void (async () => {
      const { data, error } = await api.GET('/setup/status', {});
      if (error !== undefined || data === undefined) {
        // Deliberately not "setup required". A server that cannot answer is a different problem
        // from a server that has not been claimed, and showing the wizard here would invite
        // someone to type a token into a form that cannot possibly work.
        setScreen({ name: 'unreachable' });
        return;
      }
      if (data.setupRequired) {
        setScreen({ name: 'setup' });
        return;
      }
      // A live cookie means the app should come up signed in rather than at the login form. Asking
      // `/me` is what decides it, because the cookie is HttpOnly and this code cannot read it.
      const me = await api.GET('/me', {});
      setScreen(
        me.data === undefined ? { name: 'sign-in', note: null } : { name: 'signed-in', note: null },
      );
    })();
  }, []);

  switch (screen.name) {
    case 'loading':
      return <main className="card">Yükleniyor…</main>;

    case 'unreachable':
      return (
        <main className="card">
          <h1>Sunucuya ulaşılamıyor</h1>
          <p>DEPSIS API yanıt vermedi. Servisin çalıştığını doğrulayın:</p>
          <pre>systemctl status depsis-api</pre>
        </main>
      );

    case 'setup':
      return <SetupWizard onComplete={() => setScreen({ name: 'sign-in', note: null })} />;

    case 'sign-in':
      return (
        <SignIn note={screen.note} onSignedIn={(note) => setScreen({ name: 'signed-in', note })} />
      );

    case 'signed-in':
      return (
        <SignedIn note={screen.note} onSignedOut={(note) => setScreen({ name: 'sign-in', note })} />
      );
  }
}

type Pane = 'dashboard' | 'files' | 'security' | 'users';

const PANES: ReadonlyArray<{ id: Pane; label: string; adminOnly: boolean }> = [
  { id: 'dashboard', label: 'Panel', adminOnly: false },
  { id: 'files', label: 'Dosyalar', adminOnly: false },
  { id: 'security', label: 'Güvenlik', adminOnly: false },
  { id: 'users', label: 'Kullanıcılar', adminOnly: true },
];

function paneFromHash(): Pane {
  const raw = window.location.hash.replace(/^#\/?/, '');
  return PANES.some((p) => p.id === raw) ? (raw as Pane) : 'dashboard';
}

interface SignedInProps {
  note: string | null;
  onSignedOut: (note: string | null) => void;
}

/**
 * The application, once there is a session.
 *
 * It reads `/me` rather than carrying anything over from the sign-in screen: the session is the
 * cookie, and the server is the only thing that knows what it means.
 */
function SignedIn({ note, onSignedOut }: SignedInProps): React.JSX.Element {
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [failed, setFailed] = useState(false);
  const [pane, setPane] = useState<Pane>(paneFromHash);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const onHashChange = (): void => setPane(paneFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  /**
   * A 401 anywhere means the session ended — expired, revoked, or the account disabled — and the
   * only correct response is to go back to the sign-in form and say why.
   *
   * This exists because the previous version turned every `/me` failure into `null` and rendered
   * an unconditional "Loading…", so a session that ended while the tab was open left the product
   * apparently frozen with no error and no way forward.
   */
  const onUnauthenticated = useCallback(() => {
    onSignedOut('Oturumunuz sona erdi. Lütfen tekrar giriş yapın.');
  }, [onSignedOut]);

  useEffect(() => {
    void (async () => {
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
    })();
  }, [reloadKey, onUnauthenticated]);

  if (failed) {
    return (
      <main className="card">
        <h1>Hesabınız okunamadı</h1>
        <p className="error" role="alert">
          Sunucu yanıt verdi ama hesap bilgisi gelmedi. Sayfayı yenilemek çoğu zaman yeter.
        </p>
        <button type="button" onClick={() => window.location.reload()}>
          Yenile
        </button>
      </main>
    );
  }
  if (me === null) return <main className="card">Yükleniyor…</main>;

  const visible = PANES.filter((p) => !p.adminOnly || me.role === 'admin');

  return (
    <div className="shell">
      <header className="shell-bar">
        <span className="brand">DEPSIS</span>
        <nav aria-label="Ana gezinme">
          {visible.map((p) => (
            <a
              key={p.id}
              href={`#/${p.id}`}
              className={p.id === pane ? 'nav-item current' : 'nav-item'}
              aria-current={p.id === pane ? 'page' : undefined}
            >
              {p.label}
            </a>
          ))}
        </nav>
        <div className="shell-who">
          <span className="muted">
            {me.displayName} · {me.organizationSlug}
          </span>
          <button
            type="button"
            onClick={() => {
              void api.POST('/auth/logout', {}).then(() => onSignedOut(null));
            }}
          >
            Çıkış
          </button>
        </div>
      </header>

      <main className="shell-main">
        {note !== null && (
          <p className="warning" role="alert">
            {note}
          </p>
        )}

        {pane === 'dashboard' && (
          <Dashboard onUnauthenticated={onUnauthenticated} isAdmin={me.role === 'admin'} />
        )}
        {pane === 'files' && <Files onUnauthenticated={onUnauthenticated} />}
        {pane === 'security' && (
          <section className="card">
            <h1>Güvenlik</h1>
            <p className="muted">
              {me.username} · {me.organizationSlug}
            </p>
            <Security
              mfaEnrolled={me.mfaEnrolled}
              recoveryCodesRemaining={me.recoveryCodesRemaining}
              onChanged={() => setReloadKey((k) => k + 1)}
            />
          </section>
        )}
        {pane === 'users' && me.role === 'admin' && (
          <Users currentUserId={me.id} onUnauthenticated={onUnauthenticated} />
        )}
      </main>
    </div>
  );
}
