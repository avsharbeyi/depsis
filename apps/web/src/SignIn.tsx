import { useState, type FormEvent } from 'react';

// Only `api` — deliberately not `problemMessage`. The login endpoints give the same refusal for a
// wrong password, an unknown address and an unknown organisation, so there is no detail to surface
// and echoing whatever the server happened to say would risk inventing one.
import { api } from './api.js';

interface Props {
  onSignedIn: (note: string | null) => void;
  /** Why the caller was sent back here — an expired session, say. Shown once, above the form. */
  note?: string | null;
}

type Step = 'password' | 'second-factor';

/**
 * Sign in, in the two steps the API actually has.
 *
 * The second step carries no identifier. The challenge lives in an HttpOnly cookie the server set,
 * so this form has nothing to remember and nothing to leak — which is also why there is no way for
 * a user to "resume" a half-finished login in another tab, and that is the intended behaviour
 * rather than an oversight.
 */
export function SignIn({ onSignedIn, note = null }: Props): React.JSX.Element {
  const [step, setStep] = useState<Step>('password');
  const [organizationSlug, setSlug] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitPassword(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const {
      data,
      error: failure,
      response,
    } = await api.POST('/auth/login', {
      body: { organizationSlug, email, password },
    });
    setBusy(false);

    if (failure !== undefined || data === undefined) {
      // 429 is the one refusal worth distinguishing. Everything else gets the same sentence,
      // because the server deliberately gives the same answer to a wrong password, an unknown
      // address and an unknown organisation — repeating that here rather than guessing.
      setError(
        response.status === 429
          ? 'Too many attempts from this address. Wait a minute and try again.'
          : 'Those details were not accepted.',
      );
      return;
    }

    if (data.status === 'mfa_required') {
      setStep('second-factor');
      // The password is not kept. If the second step fails the user starts again — which costs a
      // retype and removes any window in which a plaintext password sits in a component's state.
      setPassword('');
      return;
    }
    onSignedIn(null);
  }

  async function submitSecondFactor(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const { data, error: failure } = await api.POST('/auth/mfa/verify', { body: { code } });
    setBusy(false);

    if (failure !== undefined || data === undefined) {
      setError('That code was not accepted.');
      setCode('');
      return;
    }
    onSignedIn(
      data.usedRecoveryCode
        ? 'You signed in with a recovery code. It has been used up — generate a new set from your account settings.'
        : null,
    );
  }

  if (step === 'second-factor') {
    return (
      <main className="card">
        <h1>One more step</h1>
        <p>Enter the six-digit code from your authenticator app, or one of your recovery codes.</p>
        <form onSubmit={(e) => void submitSecondFactor(e)}>
          <label>
            Code
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              inputMode="text"
              autoFocus
              required
            />
            <small>
              If you have just set up your authenticator, the code on screen right now was already
              used to confirm it. Wait for the next one.
            </small>
          </label>

          {error !== null && (
            <p className="error" role="alert">
              {error}
            </p>
          )}

          <button type="submit" disabled={busy}>
            {busy ? 'Checking…' : 'Continue'}
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="card">
      <h1>Sign in to DEPSIS</h1>
      {note !== null && (
        <p className="warning" role="alert">
          {note}
        </p>
      )}
      <form onSubmit={(e) => void submitPassword(e)}>
        <label>
          Organisation
          <input
            value={organizationSlug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            autoComplete="organization"
            placeholder="acme"
            required
          />
        </label>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
