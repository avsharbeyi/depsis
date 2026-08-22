import { useState, type FormEvent } from 'react';

import { api, problemMessage } from './api.js';
import { IconLogo } from './ui.js';

interface Props {
  onComplete: () => void;
}

/**
 * The one-time claim, as a form.
 *
 * The token is asked for first and explained, because a person who has just installed DEPSIS has
 * no reason to know a token exists. The instruction names the exact command that shows it — an
 * instruction that says "check the logs" is an instruction that generates a support question.
 *
 * Four fields, down from six. The account used to want a username AND a display name, which on a
 * box whose owner creates three accounts by hand is one question too many for no benefit; and the
 * username field used to be labelled "Email", which made people type an address that the login
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
      setError(problemMessage(failure, 'Kurulum tamamlanamadı. Anahtarı kontrol edip tekrar deneyin.'));
      return;
    }
    onComplete();
  }

  return (
    <div className="centered">
      <main className="card">
        <div className="brand-mark">
          <IconLogo />
          <span>DEPSIS</span>
        </div>

        <h1>Cihazı kur</h1>
        <p className="muted">
          Bu sunucu henüz sahiplenilmemiş. Kuran kişi olduğunuzu göstermek için, servis başlarken
          yazdırdığı tek kullanımlık anahtarı girin:
        </p>
        <pre>journalctl -u depsis-api | grep -A4 &apos;not set up&apos;</pre>
        <p className="faint">
          Anahtar her yeniden başlatmada değişir; şu anki çalışmanınkini kullanın.
        </p>

        <form onSubmit={(e) => void submit(e)}>
          <label>
            Kurulum anahtarı
            <input
              value={token}
              onChange={(e) => setToken(e.target.value.trim())}
              autoComplete="off"
              spellCheck={false}
              required
            />
          </label>

          <h2>Cihaz</h2>
          <label>
            Ad
            <input
              value={organizationName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="Ev"
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
              required
            />
            <span className="muted">
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
              required
            />
            <span className="muted">Girişte yazacağınız ad. E-posta değil.</span>
          </label>
          <label>
            Parola
            <input
              type="password"
              value={adminPassword}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={12}
              required
            />
            <span className="muted">
              En az 12 karakter. Önemli olan uzunluk; simge zorunluluğu yok, çünkü çoğu zaman arama
              uzayını genişletmek yerine daraltır.
            </span>
          </label>
          <label>
            Parola (tekrar)
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          </label>

          {error !== null && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}

          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Kuruluyor…' : 'Cihazı sahiplen'}
          </button>
        </form>
      </main>
    </div>
  );
}
