import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';

import { api } from './api.js';

interface Props {
  mfaEnrolled: boolean;
  recoveryCodesRemaining: number;
  onChanged: () => void;
}

type Stage =
  | { name: 'idle' }
  | { name: 'scanning'; otpauthUri: string; secretBase32: string; qr: string | null }
  | { name: 'codes'; codes: string[] };

/**
 * Enrol, confirm, and remove the second factor.
 *
 * The recovery codes appear exactly once, on the `codes` stage, because that is the only moment
 * they exist in readable form — the server keeps their hashes. The screen says so plainly rather
 * than assuming the user knows, and the only way out of that stage is a button that acknowledges
 * it.
 */
export function Security({
  mfaEnrolled,
  recoveryCodesRemaining,
  onChanged,
}: Props): React.JSX.Element {
  const [stage, setStage] = useState<Stage>({ name: 'idle' });
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The QR is rendered from the otpauth URI rather than fetched: the URI contains the shared
  // secret, and sending it to a QR service would be sending the second factor to a third party.
  useEffect(() => {
    if (stage.name !== 'scanning' || stage.qr !== null) return;
    let cancelled = false;
    void QRCode.toDataURL(stage.otpauthUri, { margin: 1, width: 220 }).then((dataUrl) => {
      if (!cancelled) setStage((s) => (s.name === 'scanning' ? { ...s, qr: dataUrl } : s));
    });
    return () => {
      cancelled = true;
    };
  }, [stage]);

  async function begin(): Promise<void> {
    setError(null);
    setBusy(true);
    const { data, error: failure } = await api.POST('/me/mfa/enrolment', {});
    setBusy(false);
    if (failure !== undefined || data === undefined) {
      setError('Could not start enrolment.');
      return;
    }
    setStage({
      name: 'scanning',
      otpauthUri: data.otpauthUri,
      secretBase32: data.secretBase32,
      qr: null,
    });
  }

  async function confirm(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const { data, error: failure } = await api.POST('/me/mfa/enrolment/confirm', {
      body: { code },
    });
    setBusy(false);
    setCode('');
    if (failure !== undefined || data === undefined) {
      setError('That code was not accepted. Wait for the next one and try again.');
      return;
    }
    setStage({ name: 'codes', codes: data.codes });
    onChanged();
  }

  async function remove(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const { error: failure } = await api.DELETE('/me/mfa', { body: { password } });
    setBusy(false);
    setPassword('');
    if (failure !== undefined) {
      setError('That password was not accepted.');
      return;
    }
    setStage({ name: 'idle' });
    onChanged();
  }

  async function regenerate(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const { data, error: failure } = await api.POST('/me/mfa/recovery-codes', {
      body: { password },
    });
    setBusy(false);
    setPassword('');
    if (failure !== undefined || data === undefined) {
      setError('That password was not accepted.');
      return;
    }
    setStage({ name: 'codes', codes: data.codes });
    onChanged();
  }

  if (stage.name === 'codes') {
    return (
      <section>
        <h2>Recovery codes</h2>
        <p className="warning">
          Save these now. They are shown once and the server only keeps their hashes — there is no
          way to see them again, only to replace them with a new set.
        </p>
        <ul className="codes">
          {stage.codes.map((c) => (
            <li key={c}>{(c.match(/.{1,5}/g) ?? [c]).join('-')}</li>
          ))}
        </ul>
        <p className="muted">Each one works once. Keep them somewhere other than your phone.</p>
        <button type="button" onClick={() => setStage({ name: 'idle' })}>
          I have saved them
        </button>
      </section>
    );
  }

  if (stage.name === 'scanning') {
    return (
      <section>
        <h2>Scan this with your authenticator</h2>
        {stage.qr !== null ? (
          <img src={stage.qr} alt="Authenticator setup QR code" width={220} height={220} />
        ) : (
          <p className="muted">Drawing the code…</p>
        )}
        <p className="muted">Cannot scan? Enter this key by hand:</p>
        <pre>{stage.secretBase32}</pre>

        <form onSubmit={(e) => void confirm(e)}>
          <label>
            Enter the six-digit code it shows
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              pattern="[0-9]{6}"
              autoComplete="one-time-code"
              autoFocus
              required
            />
          </label>
          {error !== null && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy}>
            {busy ? 'Checking…' : 'Confirm'}
          </button>
        </form>
      </section>
    );
  }

  return (
    <section>
      <h2>Two-factor authentication</h2>
      {mfaEnrolled ? (
        <>
          <p>
            Enabled. You have <strong>{recoveryCodesRemaining}</strong> unused recovery code
            {recoveryCodesRemaining === 1 ? '' : 's'}.
            {recoveryCodesRemaining <= 2 && (
              <span className="warning"> That is nearly none — generate a new set.</span>
            )}
          </p>
          <form onSubmit={(e) => void remove(e)}>
            <label>
              Your password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              <small>
                Asked again because both actions below can lock you out, and a stolen session should
                not be able to take your second factor away.
              </small>
            </label>
            {error !== null && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="row">
              <button type="submit" disabled={busy}>
                Turn off
              </button>
              <button type="button" disabled={busy} onClick={(e) => void regenerate(e)}>
                New recovery codes
              </button>
            </div>
          </form>
          <p className="muted">Turning it off also signs out your other devices.</p>
        </>
      ) : (
        <>
          <p>
            Not set up. With it on, signing in needs a code from your phone as well as your
            password.
          </p>
          {error !== null && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="button" onClick={() => void begin()} disabled={busy}>
            {busy ? 'Starting…' : 'Set up two-factor authentication'}
          </button>
        </>
      )}
    </section>
  );
}
