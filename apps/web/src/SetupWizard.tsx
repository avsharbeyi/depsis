import { useState, type FormEvent } from 'react';

import { api, problemMessage } from './api.js';

interface Props {
  onComplete: () => void;
}

/**
 * The one-time claim, as a form.
 *
 * The token is asked for first and explained, because a person who has just installed DEPSIS has
 * no reason to know a token exists. The instruction names the exact command that shows it — an
 * instruction that says "check the logs" is an instruction that generates a support question.
 */
export function SetupWizard({ onComplete }: Props): React.JSX.Element {
  const [token, setToken] = useState('');
  const [organizationSlug, setSlug] = useState('');
  const [organizationName, setOrgName] = useState('');
  const [adminEmail, setEmail] = useState('');
  const [adminDisplayName, setDisplayName] = useState('');
  const [adminPassword, setPassword] = useState('');
  const [confirmPassword, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);

    // Checked here as well as on the server, and the two are not redundant: the server cannot tell
    // a mistyped confirmation from a deliberate password, because it never sees the confirmation.
    if (adminPassword !== confirmPassword) {
      setError('The two passwords do not match.');
      return;
    }

    setBusy(true);
    const { error: failure } = await api.POST('/setup/claim', {
      body: {
        token,
        organizationSlug,
        organizationName,
        adminEmail,
        adminDisplayName,
        adminPassword,
      },
    });
    setBusy(false);

    if (failure !== undefined) {
      setError(problemMessage(failure, 'Setup failed. Check the token and try again.'));
      return;
    }
    onComplete();
  }

  return (
    <main className="card">
      <h1>Set up DEPSIS</h1>
      <p>
        This server has not been claimed yet. To prove you are the person who installed it, enter
        the one-time token it printed when it started:
      </p>
      <pre>journalctl -u depsis-api | grep -A4 &apos;not set up&apos;</pre>
      <p className="muted">
        The token changes every time the service restarts, so use the one from the current run.
      </p>

      <form onSubmit={(e) => void submit(e)}>
        <label>
          Setup token
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
        </label>

        <h2>Your organisation</h2>
        <label>
          Name
          <input value={organizationName} onChange={(e) => setOrgName(e.target.value)} required />
        </label>
        <label>
          Short name
          <input
            value={organizationSlug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"
            placeholder="acme"
            required
          />
          <small>
            Lowercase letters, digits and hyphens. You will type this when signing in, so keep it
            short.
          </small>
        </label>

        <h2>Your account</h2>
        <label>
          Your name
          <input
            value={adminDisplayName}
            onChange={(e) => setDisplayName(e.target.value)}
            autoComplete="name"
            required
          />
        </label>
        <label>
          Email
          <input
            type="email"
            value={adminEmail}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={adminPassword}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={12}
            required
          />
          <small>
            At least 12 characters. Length is what matters — there is no rule about symbols, because
            those shrink the search space more often than they grow it.
          </small>
        </label>
        <label>
          Password again
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>

        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" disabled={busy}>
          {busy ? 'Setting up…' : 'Claim this server'}
        </button>
      </form>
    </main>
  );
}
