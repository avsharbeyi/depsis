import { useState, type FormEvent } from 'react';

// `api` for the login endpoints, which give the same refusal for a wrong password, an unknown
// account and an unknown organisation — there is no detail to surface there and echoing whatever
// the server happened to say would risk inventing one.
//
// `problemMessage` is used on ONE path: redeeming a reset ticket. Its 422 is about the shape of
// the request and is decided before the token is looked at, so it says nothing about whether the
// token exists — and it is the one message on this screen a person can act on.
import { api, problemMessage } from './api.js';
import { Sky } from './sky.js';

interface Props {
  onSignedIn: (note: string | null) => void;
  /** Why the caller was sent back here — an expired session, say. Shown once, above the form. */
  note?: string | null;
}

type Step = 'password' | 'second-factor' | 'reset';

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
      <span className="mark" aria-hidden />
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
 * The second-factor step matches `Mfa.tsx` under Hesabım, which is where an account turns it on.
 *
 * "Parolamı unuttum" is not a mail flow — this appliance sends no mail. An administrator opens a
 * one-time ticket under Kullanıcılar and hands the key over; this screen is where it is spent.
 */
export function SignIn({ onSignedIn, note = null }: Props): React.JSX.Element {
  const [step, setStep] = useState<Step>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The reset screen's own fields. Separate from `password`, which is the sign-in one. */
  const [ticket, setTicket] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordAgain, setNewPasswordAgain] = useState('');
  const [done, setDone] = useState(false);

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

  /**
   * Spend a reset ticket.
   *
   * The two password boxes are compared HERE and the request is not sent when they differ. A
   * mismatch caught by the server would burn the ticket — it is single-use — and leave the person
   * locked out with a key that no longer works, which is the worst outcome this screen has.
   *
   * The code box is always shown. Hiding it for accounts without a second factor would mean asking
   * the server whether this ticket's account is enrolled, and answering that question for anybody
   * holding a stolen key is exactly what the endpoint refuses to do.
   */
  async function submitReset(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (newPassword !== newPasswordAgain) {
      setError('İki parola aynı değil.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: failure, response } = await api.POST('/auth/password-reset', {
      body: {
        token: ticket.trim(),
        password: newPassword,
        ...(code.trim() === '' ? {} : { code: code.trim() }),
      },
    });
    setBusy(false);
    if (response.status >= 400) {
      setError(
        problemMessage(
          failure,
          'Anahtar kabul edilmedi. Süresi dolmuş ya da kullanılmış olabilir; iki adımlı ' +
            'doğrulama açıksa kodu da yazmanız gerekir.',
        ),
      );
      return;
    }
    setTicket('');
    setNewPassword('');
    setNewPasswordAgain('');
    setCode('');
    setDone(true);
    setStep('password');
  }

  if (step === 'reset') {
    return (
      <>
        <Sky mode="sky" />
        <div className="centered">
          <main className="authcard">
            <BrandMark />
            <h1>Yeni parola</h1>
            <p>
              Yöneticinizin verdiği tek kullanımlık anahtarı ve yeni parolanızı girin. Anahtar bir
              kez kullanılabilir.
            </p>

            <form onSubmit={(e) => void submitReset(e)}>
              <label>
                Anahtar
                <input
                  value={ticket}
                  onChange={(e) => setTicket(e.target.value.trim())}
                  autoComplete="off"
                  maxLength={512}
                  autoFocus
                  required
                />
              </label>
              <label>
                Yeni parola
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={1024}
                  required
                />
              </label>
              <label>
                Yeni parola (tekrar)
                <input
                  type="password"
                  value={newPasswordAgain}
                  onChange={(e) => setNewPasswordAgain(e.target.value)}
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={1024}
                  required
                />
              </label>
              <label>
                Doğrulayıcı kodu
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.trim())}
                  autoComplete="one-time-code"
                  maxLength={64}
                />
              </label>
              <p className="note">
                Kod alanı yalnız hesabınızda iki adımlı doğrulama açıksa gerekli. Açık değilse boş
                bırakın.
              </p>

              {error !== null && (
                <div className="notice error" role="alert">
                  <span className="ic" aria-hidden>
                    !
                  </span>
                  <span className="tx">{error}</span>
                </div>
              )}

              <button type="submit" className="b pri wide" disabled={busy}>
                {busy ? 'Ayarlanıyor…' : 'Parolayı belirle'}
              </button>
              <button
                type="button"
                className="b wide"
                onClick={() => {
                  setError(null);
                  setStep('password');
                }}
              >
                Girişe dön
              </button>
            </form>
          </main>
        </div>
      </>
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

          {done && (
            <div className="notice" role="status">
              <span className="ic" aria-hidden>
                ✓
              </span>
              <span className="tx">
                Parolanız değişti. Diğer bütün oturumlarınız kapatıldı; yeni parolanızla girin.
              </span>
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

          {/* Not a mail flow: this appliance sends no mail. A person who cannot sign in asks an
              administrator, who opens a one-time ticket under Kullanıcılar. */}
          <p className="note">
            <button
              type="button"
              className="linky"
              onClick={() => {
                setError(null);
                setDone(false);
                setStep('reset');
              }}
            >
              Parolamı unuttum
            </button>{' '}
            — yöneticinizden tek kullanımlık bir anahtar isteyin.
          </p>
        </main>
      </div>
    </>
  );
}
