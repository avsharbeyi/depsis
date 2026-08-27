import { useState, type FormEvent } from 'react';

import { api, problemMessage } from './api.js';
import { BrandMark } from './SignIn.js';
import { Sky } from './sky.js';

interface Props {
  onComplete: () => void;
}

/**
 * The one-time claim, as a form.
 *
 * TOKENSIZ. İlk tasarım günlüğe basılan tek kullanımlık bir anahtar istiyordu; anahtarı okumanın
 * tek yolu terminaldi ve sahibi bunu üç kere yaşadı. Kilit artık formun kendisi değil, arkadaki
 * tek atımlık veritabanı kaydı: ilk kuran kazanır, kapı sonsuza dek kapanır. Kalan küçük risk —
 * aynı ağdaki bir başkasının senden önce sahiplenmesi — alttaki uyarı cümlesiyle ve denetim
 * kaydına düşen ilk satırla karşılanıyor.
 *
 * Two sections on one page, not two steps: the whole form is one `POST /setup/claim` that either
 * succeeds or does not.
 */
export function SetupWizard({ onComplete }: Props): React.JSX.Element {
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
      body: { organizationSlug, organizationName, adminUsername, adminPassword },
    });
    setBusy(false);

    if (failure !== undefined) {
      // Unlike the login path, this endpoint names the field it rejected — the contract says so
      // explicitly, on the grounds that the person on the other side owns the machine and is
      // filling the form once. So the server's own sentence is worth more than a generic one.
      setError(problemMessage(failure, 'Kurulum tamamlanamadı.'));
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
            Bu sunucu henüz sahiplenilmemiş. Aşağıda kuracağınız ilk hesap cihazın yöneticisi olur
            ve bu ekran bir daha açılmaz. Bu cihazı siz kurmadıysanız devam etmeyin: fişini çekin ve
            yeniden kurun.
          </p>

          <form onSubmit={(e) => void submit(e)}>
            <h2>Cihaz</h2>
            <label>
              Cihaz adı
              <input
                value={organizationName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="Ev"
                maxLength={200}
                autoFocus
                required
              />
            </label>
            <label>
              Kısa ad
              <input
                value={organizationSlug}
                onChange={(e) => setSlug(e.target.value.toLowerCase().trim())}
                // The dash is ESCAPED, and it has to be. HTML compiles `pattern` with the `v`
                // flag, where a bare trailing `-` in a character class is reserved for set
                // operations and raises "Invalid character class" — and a pattern that does not
                // compile is IGNORED rather than reported, so this field silently had no
                // client-side constraint at all. Measured: with `ge cer siz!!` typed in,
                // `validity.patternMismatch` was false. The username field two labels down
                // escapes it correctly; this was one miss in a pair, and the e2e suite is what
                // noticed, because there is nothing to see when a constraint quietly stops
                // existing.
                pattern="[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?"
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
