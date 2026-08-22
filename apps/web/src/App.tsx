import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { Account } from './Account.js';
import { api } from './api.js';
import { Dashboard } from './Dashboard.js';
import { Files } from './Files.js';
import { SetupWizard } from './SetupWizard.js';
import { SignIn } from './SignIn.js';
import {
  IconAccount,
  IconDashboard,
  IconFiles,
  IconLogo,
  IconUsers,
  Toasts,
  useToasts,
} from './ui.js';
import { Users } from './Users.js';

/** Straight from the contract, so a field renamed in the YAML breaks this file. */
type CurrentUser = OpenApi.components['schemas']['CurrentUser'];

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
      setScreen(me.data === undefined ? { name: 'sign-in', note: null } : { name: 'signed-in' });
    })();
  }, []);

  switch (screen.name) {
    case 'loading':
      return (
        <div className="centered">
          <p className="muted">Yükleniyor…</p>
        </div>
      );

    case 'unreachable':
      return (
        <div className="centered">
          <main className="card">
            <div className="brand-mark">
              <IconLogo />
              <span>DEPSIS</span>
            </div>
            <h1>Sunucuya ulaşılamıyor</h1>
            <p className="muted">DEPSIS API yanıt vermedi. Servisin çalıştığını doğrulayın:</p>
            <pre>systemctl status depsis-api</pre>
          </main>
        </div>
      );

    case 'setup':
      return <SetupWizard onComplete={() => setScreen({ name: 'sign-in', note: null })} />;

    case 'sign-in':
      return <SignIn note={screen.note} onSignedIn={() => setScreen({ name: 'signed-in' })} />;

    case 'signed-in':
      return <SignedIn onSignedOut={(note) => setScreen({ name: 'sign-in', note })} />;
  }
}

type Pane = 'dashboard' | 'files' | 'users' | 'account';

const PANES: ReadonlyArray<{
  id: Pane;
  label: string;
  adminOnly: boolean;
  Icon: (p: { className?: string }) => React.JSX.Element;
}> = [
  { id: 'dashboard', label: 'Panel', adminOnly: false, Icon: IconDashboard },
  { id: 'files', label: 'Dosyalar', adminOnly: false, Icon: IconFiles },
  { id: 'users', label: 'Kullanıcılar', adminOnly: true, Icon: IconUsers },
  { id: 'account', label: 'Hesabım', adminOnly: false, Icon: IconAccount },
];

function paneFromHash(): Pane {
  const raw = window.location.hash.replace(/^#\/?/, '');
  return PANES.some((p) => p.id === raw) ? (raw as Pane) : 'dashboard';
}

/**
 * The application, once there is a session.
 *
 * Still no routing library — `location.hash` gives addressable panes for nothing, and four panes
 * need neither nested layouts nor code splitting.
 */
function SignedIn({
  onSignedOut,
}: {
  onSignedOut: (note: string | null) => void;
}): React.JSX.Element {
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [failed, setFailed] = useState(false);
  const [pane, setPane] = useState<Pane>(paneFromHash);
  const { toasts, push, dismiss } = useToasts();

  useEffect(() => {
    const onHashChange = (): void => setPane(paneFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  /**
   * A 401 anywhere means the session ended — expired, revoked, or the account disabled — and the
   * only correct response is to go back to the sign-in form and say why.
   *
   * This exists because an earlier version turned every `/me` failure into `null` and rendered an
   * unconditional "Loading…", so a session that ended while the tab was open left the product
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
  }, [onUnauthenticated]);

  if (failed) {
    return (
      <div className="centered">
        <main className="card">
          <h1>Hesabınız okunamadı</h1>
          <p className="notice error" role="alert">
            Sunucu yanıt verdi ama hesap bilgisi gelmedi. Sayfayı yenilemek çoğu zaman yeter.
          </p>
          <button type="button" className="primary" onClick={() => window.location.reload()}>
            Yenile
          </button>
        </main>
      </div>
    );
  }
  if (me === null) {
    return (
      <div className="centered">
        <p className="muted">Yükleniyor…</p>
      </div>
    );
  }

  const isAdmin = me.role === 'admin';
  const visible = PANES.filter((p) => !p.adminOnly || isAdmin);

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Ana gezinme">
        <div className="brand-mark">
          <IconLogo />
          <span>DEPSIS</span>
        </div>

        {visible.map(({ id, label, Icon }) => (
          <a
            key={id}
            href={`#/${id}`}
            className={id === pane ? 'nav-item current' : 'nav-item'}
            aria-current={id === pane ? 'page' : undefined}
          >
            <Icon />
            <span>{label}</span>
          </a>
        ))}

        <div className="sidebar-foot">
          <span className="who" title={me.username}>
            {me.username}
          </span>
          <button
            type="button"
            className="quiet"
            onClick={() => {
              void api.POST('/auth/logout', {}).then(() => onSignedOut(null));
            }}
          >
            Çıkış yap
          </button>
        </div>
      </nav>

      <main className="main">
        {pane === 'dashboard' && (
          <Dashboard onUnauthenticated={onUnauthenticated} isAdmin={isAdmin} />
        )}
        {pane === 'files' && <Files onUnauthenticated={onUnauthenticated} notify={push} />}
        {pane === 'users' && isAdmin && (
          <Users currentUserId={me.id} onUnauthenticated={onUnauthenticated} notify={push} />
        )}
        {pane === 'account' && <Account me={me} notify={push} />}
      </main>

      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  );
}
