import type { OpenApi } from '@depsis/contracts';
import { useEffect, useState } from 'react';

import { api } from './api.js';

/** Straight from the contract, so a field renamed in the YAML breaks this file. */
type CurrentUser = OpenApi.components['schemas']['CurrentUser'];
import { SetupWizard } from './SetupWizard.js';
import { Security } from './Security.js';
import { SignIn } from './SignIn.js';

type Screen =
  | { name: 'loading' }
  | { name: 'unreachable' }
  | { name: 'setup' }
  | { name: 'sign-in' }
  | { name: 'signed-in'; note: string | null };

/**
 * Three screens and no router.
 *
 * A routing library would be a dependency carrying URL history, nested layouts and code splitting —
 * none of which three screens need, and all of which would have to be pinned and justified. When
 * the file browser arrives it will need real routing and that will be a decision with an ADR
 * behind it; until then a discriminated union is the honest size of the problem.
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
      // Written as two literals rather than one with a ternary inside: the union is discriminated
      // on `name`, and a computed `name` widens to `'setup' | 'sign-in'` which TypeScript cannot
      // match against either member.
      setScreen(data.setupRequired ? { name: 'setup' } : { name: 'sign-in' });
    })();
  }, []);

  switch (screen.name) {
    case 'loading':
      return <main className="card">Loading…</main>;

    case 'unreachable':
      return (
        <main className="card">
          <h1>Cannot reach the server</h1>
          <p>The DEPSIS API did not answer. Check that the service is running:</p>
          <pre>systemctl status depsis-api</pre>
        </main>
      );

    case 'setup':
      return <SetupWizard onComplete={() => setScreen({ name: 'sign-in' })} />;

    case 'sign-in':
      return <SignIn onSignedIn={(note) => setScreen({ name: 'signed-in', note })} />;

    case 'signed-in':
      return <SignedIn note={screen.note} onSignedOut={() => setScreen({ name: 'sign-in' })} />;
  }
}

interface SignedInProps {
  note: string | null;
  onSignedOut: () => void;
}

/**
 * The landing page, such as it is.
 *
 * It reads `/me` rather than carrying anything over from the sign-in screen: the session is the
 * cookie, and the server is the only thing that knows what it means. Passing a user object down
 * from the login form would mean the page believed something the server had not been asked about.
 */
function SignedIn({ note, onSignedOut }: SignedInProps): React.JSX.Element {
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    void loadMe().then(setMe);
  }, [reloadKey]);

  if (me === null) return <main className="card">Loading…</main>;

  return (
    <main className="card">
      <h1>Signed in as {me.displayName}</h1>
      <p className="muted">
        {me.email} · {me.organizationSlug}
      </p>
      {note !== null && (
        <p className="warning" role="alert">
          {note}
        </p>
      )}

      <Security
        mfaEnrolled={me.mfaEnrolled}
        recoveryCodesRemaining={me.recoveryCodesRemaining}
        onChanged={() => setReloadKey((k) => k + 1)}
      />

      <hr />
      <p className="muted">
        Files, shares and search are not built yet. This page says so rather than pretending to be a
        dashboard.
      </p>
      <button
        type="button"
        onClick={() => {
          void api.POST('/auth/logout', {}).then(onSignedOut);
        }}
      >
        Sign out
      </button>
    </main>
  );
}

async function loadMe(): Promise<CurrentUser | null> {
  const { data } = await api.GET('/me', {});
  return data ?? null;
}
