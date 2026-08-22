import { useState, type FormEvent } from 'react';

// Only `api` — deliberately not `problemMessage`. The login endpoints give the same refusal for a
// wrong password, an unknown account and an unknown organisation, so there is no detail to surface
// and echoing whatever the server happened to say would risk inventing one.
import { api } from './api.js';
import { IconLogo } from './ui.js';

interface Props {
  onSignedIn: (note: string | null) => void;
  /** Why the caller was sent back here — an expired session, say. Shown once, above the form. */
  note?: string | null;
}

type Step = 'password' | 'second-factor';

/**
 * Sign in.
 *
 * Two fields. There is no organisation box: with one organisation on the box the server resolves it
 * itself, and asking for a slug that must be typed exactly turned an invisible trailing space into
 * "wrong password" — which is how it actually failed the first time someone tried to log in.
 *
 * The second-factor step is still here even though nothing in the interface can turn two-factor ON
 * any more. It costs one branch, and removing it would strand an account that had already enrolled
 * with no way to sign in at all.
 */
export function SignIn({ onSignedIn, note = null }: Props): React.JSX.Element {
  const [step, setStep] = useState<Step>('password');
  const [username, setUsername] = useState('');
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
    } = await api.POST('/auth/login', { body: { username, password } });
    setBusy(false);

    if (failure !== undefined || data === undefined) {
      // 429 is the one refusal worth distinguishing. Everything else gets the same sentence,
      // because the server deliberately gives the same answer to a wrong password, an unknown
      // account and an unknown organisation — repeating that here rather than guessing.
      setError(
        response.status === 429
          ? 'Bu adresten çok fazla deneme yapıldı. Bir dakika bekleyip tekrar deneyin.'
          : 'Kullanıcı adı veya parola hatalı.',
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
      setError('Kod kabul edilmedi.');
      setCode('');
      return;
    }
    onSignedIn(
      data.usedRecoveryCode
        ? 'Kurtarma koduyla girdiniz. O kod artık kullanılamaz.'
        : null,
    );
  }

  if (step === 'second-factor') {
    return (
      <div className="centered">
        <main className="card">
          <div className="brand-mark">
            <IconLogo />
            <span>DEPSIS</span>
          </div>
          <h1>Bir adım daha</h1>
          <p className="muted">
            Doğrulayıcı uygulamanızdaki altı haneli kodu ya da kurtarma kodlarınızdan birini girin.
          </p>
          <form onSubmit={(e) => void submitSecondFactor(e)}>
            <label>
              Kod
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.trim())}
                autoComplete="one-time-code"
                inputMode="text"
                autoFocus
                required
              />
            </label>

            {error !== null && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}

            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Kontrol ediliyor…' : 'Devam'}
            </button>
          </form>
        </main>
      </div>
    );
  }

  return (
    <div className="centered">
      <main className="card">
        <div className="brand-mark">
          <IconLogo />
          <span>DEPSIS</span>
        </div>
        <h1>Giriş yap</h1>

        {note !== null && (
          <p className="notice warning" role="alert">
            {note}
          </p>
        )}

        <form onSubmit={(e) => void submitPassword(e)}>
          <label>
            Kullanıcı adı
            <input
              value={username}
              // Trimmed. A name with a trailing space fails the server's format check and comes
              // back as the same refusal as a wrong password — measured on a real sign-in, where
              // the invisible character cost three rounds of instrumentation to find.
              onChange={(e) => setUsername(e.target.value.trim())}
              autoComplete="username"
              autoFocus
              required
            />
          </label>
          <label>
            Parola
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>

          {error !== null && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}

          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Giriş yapılıyor…' : 'Giriş yap'}
          </button>
        </form>
      </main>
    </div>
  );
}
