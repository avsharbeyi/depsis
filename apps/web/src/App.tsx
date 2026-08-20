import { useEffect, useState } from 'react';

import { api } from './api.js';
import { SetupWizard } from './SetupWizard.js';
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
      return (
        <main className="card">
          <h1>Signed in</h1>
          {screen.note !== null && (
            <p className="warning" role="alert">
              {screen.note}
            </p>
          )}
          <p>
            There is nothing here yet. Files, shares and search are Phase 1 work that has not been
            built — this page exists so the sign-in flow has somewhere to land, and it says so
            rather than pretending to be a dashboard.
          </p>
          <button
            type="button"
            onClick={() => {
              void api.POST('/auth/logout', {}).then(() => setScreen({ name: 'sign-in' }));
            }}
          >
            Sign out
          </button>
        </main>
      );
  }
}
