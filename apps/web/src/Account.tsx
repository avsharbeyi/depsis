import type { OpenApi } from '@depsis/contracts';
import { useState } from 'react';

import { api, problemMessage } from './api.js';

type CurrentUser = OpenApi.components['schemas']['CurrentUser'];

interface Props {
  me: CurrentUser;
  notify: (kind: 'ok' | 'error', text: string) => void;
}

/**
 * The account, and the one thing a person does to it.
 *
 * The screen this replaces was a two-factor enrolment panel — a QR code, ten recovery codes and a
 * turn-off button — on an appliance whose owner does not use two-factor. The endpoints are still
 * there and still tested, because §6.3 asks for the capability and deleting working code to tidy a
 * screen is the wrong trade; what changed is that the interface no longer leads with something
 * nobody asked for.
 */
export function Account({ me, notify }: Props): React.JSX.Element {
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
    if (error !== undefined || data === undefined) {
      notify('error', problemMessage(error, 'Parola değiştirilemedi. Mevcut parolanız doğru mu?'));
      return;
    }
    setCurrent('');
    setNext('');
    setAgain('');
    notify(
      'ok',
      data.otherSessionsRevoked > 0
        ? `Parola değişti. Diğer ${data.otherSessionsRevoked} oturum kapatıldı.`
        : 'Parola değişti.',
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Hesabım</h1>
          <p className="muted">
            {me.username}
            {me.role === 'admin' ? ' · yönetici' : ''}
          </p>
        </div>
      </div>

      <div className="panel" style={{ maxWidth: '32rem' }}>
        <h2>Parolayı değiştir</h2>
        <p className="muted">
          Mevcut parolanız, oturumunuz açık olsa bile isteniyor: bir oturum, birinin açık bırakılmış
          bilgisayarını ödünç aldığında sahip olduğu şeydir. Değişiklikten sonra diğer bütün
          oturumlarınız kapatılır; bu sekme açık kalır.
        </p>

        <form onSubmit={(e) => void submit(e)}>
          <label>
            Mevcut parola
            <input
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
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
              onChange={(e) => setNext(e.target.value)}
            />
            <span className="muted">En az 12 karakter.</span>
          </label>
          <label>
            Yeni parola (tekrar)
            <input
              type="password"
              autoComplete="new-password"
              required
              value={again}
              onChange={(e) => setAgain(e.target.value)}
            />
            {mismatch && <span className="error">İki parola aynı değil.</span>}
          </label>
          <button type="submit" className="primary" disabled={busy || mismatch}>
            {busy ? 'Değiştiriliyor…' : 'Parolayı değiştir'}
          </button>
        </form>
      </div>
    </>
  );
}
