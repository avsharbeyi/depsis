import type { OpenApi } from '@depsis/contracts';
import { useState } from 'react';

import { api, problemMessage } from './api.js';
import { Mfa } from './Mfa.js';

type CurrentUser = OpenApi.components['schemas']['CurrentUser'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

/** The same role tints the user list uses, so one person is one colour across the desktop. */
const AVATAR: Record<CurrentUser['role'], React.CSSProperties> = {
  admin: { background: 'rgba(143,166,255,.24)', color: '#8FA6FF' },
  member: { background: 'rgba(91,200,245,.24)', color: '#5BC8F5' },
};

/**
 * The account: a password change, and the second factor.
 *
 * THE MFA PANEL USED TO BE ABSENT ON PURPOSE, and the reasoning here said so — a household
 * appliance should not open its account screen with a QR code and ten recovery codes. That was a
 * defensible call about EMPHASIS and it produced an indefensible outcome: `SignIn.tsx` has always
 * handled the `mfa_required` branch, so the appliance could challenge a second factor that nobody
 * had any way to turn on. A login step nobody can reach is a dead branch, not a decision.
 *
 * So it is here, and it is placed BELOW the password form rather than above it: the emphasis
 * argument was right, only the omission was wrong.
 */
export function Account({
  me,
  notify,
  onChanged,
}: {
  me: CurrentUser;
  notify: Notify;
  /** Re-read `/me`, so the enrolled state and the remaining-code count stop being stale. */
  onChanged: () => void;
}): React.JSX.Element {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);

  const mismatch = again !== '' && next !== again;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (mismatch) return;
    setBusy(true);
    const { data, error } = await api.POST('/me/password', {
      body: { currentPassword: current, newPassword: next },
    });
    setBusy(false);
    if (data === undefined) {
      notify('error', problemMessage(error, 'Parola değiştirilemedi. Mevcut parolanız doğru mu?'));
      return;
    }
    setCurrent('');
    setNext('');
    setAgain('');
    // The revoked-session count is the only proof the user gets that the change reached every
    // device they were signed in on — the whole reason a password change revokes anything.
    notify(
      'ok',
      data.otherSessionsRevoked > 0
        ? `Parola değişti. Diğer ${data.otherSessionsRevoked} oturum kapatıldı.`
        : 'Parola değişti. Başka açık oturumunuz yoktu.',
    );
  }

  return (
    <>
      <div className="urow">
        <span className="av" style={AVATAR[me.role]} aria-hidden>
          {me.username.slice(0, 1).toLocaleUpperCase('tr')}
        </span>
        <span className="i">
          <b>{me.username}</b>
          <span>{me.organizationSlug}</span>
        </span>
        <span className={me.role === 'admin' ? 'st2 up' : 'st2 dn'}>
          {me.role === 'admin' ? 'yönetici' : 'üye'}
        </span>
      </div>

      <form
        onSubmit={(event) => void submit(event)}
        style={{ display: 'flex', flexDirection: 'column', gap: 9 }}
      >
        <div className="lbl">Parolayı değiştir</div>
        <label>
          Mevcut parola
          <input
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
        </label>
        <label>
          Yeni parola
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
          <small>En az 12 karakter.</small>
        </label>
        <label>
          Yeni parola (tekrar)
          <input
            type="password"
            autoComplete="new-password"
            required
            value={again}
            onChange={(event) => setAgain(event.target.value)}
          />
          {mismatch && <small style={{ color: '#FF7E8A' }}>İki parola aynı değil.</small>}
        </label>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="submit" className="b pri" disabled={busy || mismatch}>
            {busy ? 'Değiştiriliyor…' : 'Parolayı değiştir'}
          </button>
        </div>
      </form>

      <div className="note">
        Oturumunuz açıkken bile mevcut parola isteniyor, çünkü açık bırakılmış bir bilgisayarı ödünç
        alan biri oturuma sahiptir ama parolaya sahip değildir. Değişiklikten sonra diğer bütün
        oturumlarınız kapanır; bu sekme açık kalır.
      </div>

      <Mfa me={me} notify={notify} onChanged={onChanged} />
    </>
  );
}
