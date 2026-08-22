import { useState, type FormEvent } from 'react';

// Only `api` — deliberately not `problemMessage`. The login endpoints give the same refusal for a
// wrong password, an unknown account and an unknown organisation, so there is no detail to surface
// and echoing whatever the server happened to say would risk inventing one.
import { api } from './api.js';
import { Sky } from './sky.js';

interface Props {
  onSignedIn: (note: string | null) => void;
  /** Why the caller was sent back here — an expired session, say. Shown once, above the form. */
  note?: string | null;
}

type Step = 'password' | 'second-factor';

/**
 * The brand mark that sits at the top of both first-run screens.
 *
 * It is the reference's `.brandbox` — gradient square, letter-spaced wordmark — and not the drawn
 * `IconLogo`, because `.authcard .brandbox` is the rule the stylesheet actually carries for this
 * position. An SVG dropped in here has no sizing rule at all and renders at whatever width the
 * flex row gives it.
 *
 * It lives here rather than in `ui.tsx` because the two first-run screens are its only callers;
 * the signed-in desktop mounts the real `.brandbox`, which is a menu button and not this.
 */
export function BrandMark(): React.JSX.Element {
  return (
    <div className="brandbox">
      <span className="mark" aria-hidden>
        D
      </span>
      <span className="nm">DEPSIS</span>
    </div>
  );
}

/**
 * Sign in.
 *
 * Two fields. There is no organisation box: with one organisation on the box the server resolves
 * it itself, and asking for a slug that must be typed exactly turned an invisible trailing space
 * into "wrong password" — which is how it actually failed the first time someone tried to log in.
 *
 * The galaxy runs behind this screen as well as behind the desktop. The appliance is the same
 * machine before and after a session exists, and a login form on a flat background followed by a
 * drawn sky reads as two different products.
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
      data.usedRecoveryCode ? 'Kurtarma koduyla girdiniz. O kod artık kullanılamaz.' : null,
    );
  }

  if (step === 'second-factor') {
    return (
      <>
        <Sky mode="sky" />
        <div className="centered">
          <main className="authcard">
            <BrandMark />
            <h1>Bir adım daha</h1>
            <p>
              Doğrulayıcı uygulamanızdaki altı haneli kodu ya da kurtarma kodlarınızdan birini
              girin.
            </p>

            <form onSubmit={(e) => void submitSecondFactor(e)}>
              <label>
                Kod
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.trim())}
                  autoComplete="one-time-code"
                  inputMode="text"
                  maxLength={64}
                  autoFocus
                  required
                />
              </label>

              {error !== null && (
                <div className="notice error" role="alert">
                  <span className="ic" aria-hidden>
                    !
                  </span>
                  <span className="tx">{error}</span>
                </div>
              )}

              <button type="submit" className="b pri wide" disabled={busy}>
                {busy ? 'Kontrol ediliyor…' : 'Devam'}
              </button>
            </form>
          </main>
        </div>
      </>
    );
  }

  return (
    <>
      <Sky mode="sky" />
      <div className="centered">
        <main className="authcard">
          <BrandMark />
          <h1>Giriş yap</h1>

          {note !== null && (
            <div className="notice" role="alert">
              <span className="ic" aria-hidden>
                ⚠
              </span>
              <span className="tx">{note}</span>
            </div>
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
                maxLength={64}
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
                maxLength={1024}
                required
              />
            </label>

            {error !== null && (
              <div className="notice error" role="alert">
                <span className="ic" aria-hidden>
                  !
                </span>
                <span className="tx">{error}</span>
              </div>
            )}

            <button type="submit" className="b pri wide" disabled={busy}>
              {busy ? 'Giriş yapılıyor…' : 'Giriş yap'}
            </button>
          </form>
        </main>
      </div>
    </>
  );
}
