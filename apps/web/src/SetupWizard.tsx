import { useState, type FormEvent } from 'react';

import { api, problemMessage } from './api.js';
import { BrandMark } from './SignIn.js';
import { Sky } from './sky.js';

interface Props {
  onComplete: () => void;
}

/**
 * The command block that shows where the setup token comes from.
 *
 * Styled here rather than in the stylesheet: `styles.css` is the ported v5 sheet and has no `pre`
 * rule, and this is the only `<pre>` in the product. The values are the reference's own field
 * vocabulary — the recessed near-black well and hairline edge that `input` uses — so the block
 * cannot be told apart from the port.
 */
const COMMAND_BLOCK: React.CSSProperties = {
  margin: 0,
  background: 'rgba(0, 0, 0, 0.26)',
  border: '1px solid var(--edge)',
  borderRadius: 9,
  padding: '10px 12px',
  fontFamily: 'var(--mono)',
  fontSize: 11.5,
  lineHeight: 1.6,
  color: 'var(--ink2)',
  overflowX: 'auto',
};

/**
 * The one-time claim, as a form.
 *
 * The token is asked for first and explained, because a person who has just installed DEPSIS has
 * no reason to know a token exists. The instruction names the exact command that shows it — an
 * instruction that says "check the logs" is an instruction that generates a support question.
 *
 * Two sections on one page, not two steps. Splitting six fields across a wizard would mean the
 * device name could be accepted before the token is known to be valid, and the whole form is one
 * `POST /setup/claim` that either succeeds or does not.
 *
 * Five fields, down from six. The account used to want a username AND a display name, which on a
 * box whose owner creates three accounts by hand is one question too many for no benefit; and the
 * username field used to be labelled "E-posta", which made people type an address that the login
 * form would then refuse.
 */
export function SetupWizard({ onComplete }: Props): React.JSX.Element {
  const [token, setToken] = useState('');
  const [organizationName, setOrgName] = useState('');
  const [organizationSlug, setSlug] = useState('');
  const [adminUsername, setUsername] = useState('');
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
      setError('İki parola aynı değil.');
      return;
    }

    setBusy(true);
    const { error: failure } = await api.POST('/setup/claim', {
      body: { token, organizationSlug, organizationName, adminUsername, adminPassword },
    });
    setBusy(false);

    if (failure !== undefined) {
      // Unlike the login path, this endpoint names the field it rejected — the contract says so
      // explicitly, on the grounds that the person on the other side owns the machine and is
      // filling the form once. So the server's own sentence is worth more than a generic one.
      setError(
        problemMessage(failure, 'Kurulum tamamlanamadı. Anahtarı kontrol edip tekrar deneyin.'),
      );
      return;
    }
    onComplete();
  }

  return (
    <>
      <Sky mode="sky" />
      <div className="centered">
        <main className="authcard">
          <BrandMark />

          <h1>Cihazı kur</h1>
          <p>
            Bu sunucu henüz sahiplenilmemiş. Kuran kişi olduğunuzu göstermek için, servis başlarken
            yazdırdığı tek kullanımlık anahtarı girin:
          </p>
          <pre style={COMMAND_BLOCK}>
            journalctl -u depsis-api | grep -A4 &apos;not set up&apos;
          </pre>

          <form onSubmit={(e) => void submit(e)}>
            <label>
              Kurulum anahtarı
              <input
                value={token}
                onChange={(e) => setToken(e.target.value.trim())}
                autoComplete="off"
                spellCheck={false}
                maxLength={128}
                autoFocus
                required
              />
              <span className="sub">
                Anahtar her yeniden başlatmada değişir; şu anki çalışmanınkini kullanın.
              </span>
            </label>

            <h2>Cihaz</h2>
            <label>
              Cihaz adı
              <input
                value={organizationName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="Ev"
                maxLength={200}
                required
              />
            </label>
            <label>
              Kısa ad
              <input
                value={organizationSlug}
                onChange={(e) => setSlug(e.target.value.toLowerCase().trim())}
                pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"
                placeholder="ev"
                maxLength={63}
                required
              />
              <span className="sub">
                Küçük harf, rakam ve tire. Tek cihaz varsa girişte bunu yazmanız gerekmez.
              </span>
            </label>

            <h2>Yönetici hesabı</h2>
            <label>
              Kullanıcı adı
              <input
                value={adminUsername}
                onChange={(e) => setUsername(e.target.value.trim())}
                autoComplete="username"
                pattern="[A-Za-z0-9][A-Za-z0-9._\-]*"
                placeholder="serkan"
                maxLength={64}
                required
              />
              <span className="sub">Girişte yazacağınız ad. E-posta değil.</span>
            </label>
            <label>
              Parola
              <input
                type="password"
                value={adminPassword}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                minLength={12}
                maxLength={1024}
                required
              />
              <span className="sub">
                En az 12 karakter. Önemli olan uzunluk; simge zorunluluğu yok, çünkü çoğu zaman
                arama uzayını genişletmek yerine daraltır.
              </span>
            </label>
            <label>
              Parola (tekrar)
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
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
              {busy ? 'Kuruluyor…' : 'Cihazı sahiplen'}
            </button>
          </form>
        </main>
      </div>
    </>
  );
}
