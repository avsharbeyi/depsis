import type { OpenApi } from '@depsis/contracts';
import { useState } from 'react';

import { api, problemMessage } from './api.js';
import { Win } from './ui.js';

type CurrentUser = OpenApi.components['schemas']['CurrentUser'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

/**
 * Turning the second factor on, and off again.
 *
 * WHY THIS WAS THE GAP. Four operations have served TOTP enrolment for some time, and `SignIn.tsx`
 * has always handled the `mfa_required` branch — the code entry, the recovery-code path, all of
 * it. So the appliance could CHALLENGE a second factor and nobody could ever TURN ONE ON. A login
 * step nobody can reach is not a security feature, it is a dead branch.
 *
 * The secret is shown as text rather than as a QR image, and that is a decision rather than a
 * shortcut: rendering a QR needs a library, the artifact of it is a picture a person cannot check,
 * and every authenticator app accepts a typed key. The `otpauth://` URI is offered as a link for
 * the apps that take one.
 *
 * RECOVERY CODES ARE SHOWN EXACTLY ONCE. The API hashes them, so this dialog is the only moment
 * they exist in readable form — which is why confirming enrolment does not close it.
 */
export function Mfa({
  me,
  notify,
  onChanged,
}: {
  me: CurrentUser;
  notify: Notify;
  onChanged: () => void;
}): React.JSX.Element {
  /** `codes-request` asks for the password BEFORE regenerating; `codes` shows the result. */
  const [step, setStep] = useState<'idle' | 'enrolling' | 'codes' | 'codes-request' | 'removing'>(
    'idle',
  );
  const [enrolment, setEnrolment] = useState<{ otpauthUri: string; secretBase32: string } | null>(
    null,
  );
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function begin(): Promise<void> {
    setBusy(true);
    const { data, error } = await api.POST('/me/mfa/enrolment', {});
    setBusy(false);
    if (data === undefined) {
      notify('error', problemMessage(error, 'Kayıt başlatılamadı.'));
      return;
    }
    setEnrolment(data);
    setCode('');
    setPassword('');
    setStep('enrolling');
  }

  async function confirm(): Promise<void> {
    setBusy(true);
    // Parola, kodun yanında. Onaylama anına kadar sır etkisiz, ama onaylandığı anda hesabın
    // ikinci faktörü oluyor: çalınmış bir oturum bunu parolasız yapabilseydi, hesabın gerçek
    // sahibi doğru parolasıyla gelip üretemeyeceği bir kod istenerek dışarıda kalırdı ve
    // yöneticinin de onu geri açacak bir yolu yok.
    const { data, error } = await api.POST('/me/mfa/enrolment/confirm', {
      body: { code, password },
    });
    setBusy(false);
    setPassword('');
    if (data === undefined) {
      notify('error', problemMessage(error, 'Kod ya da parola kabul edilmedi.'));
      return;
    }
    // Straight to the codes rather than closing: these are hashed on the server, so this is the
    // only time they can be read. Closing on success would enrol somebody and hand them nothing.
    setCodes(data.codes);
    setStep('codes');
    onChanged();
  }

  async function regenerate(): Promise<void> {
    setBusy(true);
    const { data, error } = await api.POST('/me/mfa/recovery-codes', { body: { password } });
    setBusy(false);
    setPassword('');
    if (data === undefined) {
      notify('error', problemMessage(error, 'Kodlar yenilenemedi. Parolanız doğru mu?'));
      return;
    }
    setCodes(data.codes);
    setStep('codes');
    onChanged();
  }

  async function remove(): Promise<void> {
    setBusy(true);
    const { error, response } = await api.DELETE('/me/mfa', { body: { password } });
    setBusy(false);
    setPassword('');
    if (response.status >= 400) {
      notify('error', problemMessage(error, 'Kaldırılamadı. Parolanız doğru mu?'));
      return;
    }
    notify('ok', 'İki adımlı doğrulama kapatıldı.');
    setStep('idle');
    onChanged();
  }

  return (
    <>
      <div className="netrow">
        <span className="lbl">İki adımlı doğrulama</span>
        <span className={me.mfaEnrolled ? 'st2 up' : 'st2 dn'}>
          {me.mfaEnrolled ? 'açık' : 'kapalı'}
        </span>
        {me.mfaEnrolled && (
          <span className="val">{me.recoveryCodesRemaining} kurtarma kodu kaldı</span>
        )}
        {me.mfaEnrolled ? (
          <>
            <button type="button" className="b" onClick={() => setStep('codes-request')}>
              Kurtarma kodlarını yenile
            </button>
            <button type="button" className="b" onClick={() => setStep('removing')}>
              Kapat
            </button>
          </>
        ) : (
          <button type="button" className="b" disabled={busy} onClick={() => void begin()}>
            Aç
          </button>
        )}
      </div>

      {me.mfaEnrolled && me.recoveryCodesRemaining === 0 && (
        // Worth its own line rather than a number nobody reads: with no codes left, losing the
        // authenticator means losing the account, and an administrator cannot reset a password
        // either.
        <div className="warn" role="status">
          <span className="ic" aria-hidden>
            ⚠
          </span>
          <span className="tx">
            <b>Kurtarma kodunuz kalmadı</b>
            Doğrulayıcı uygulamanızı kaybederseniz hesabınıza giremezsiniz. Şimdi yenileyin.
          </span>
        </div>
      )}

      {step === 'enrolling' && enrolment !== null && (
        <Win
          title="İki adımlı doğrulamayı aç"
          glyph="🔐"
          tone="live"
          onClose={() => setStep('idle')}
        >
          <p className="note">
            Doğrulayıcı uygulamanıza aşağıdaki anahtarı girin, sonra uygulamanın gösterdiği altı
            haneli kodu yazın.
          </p>
          <p
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 15,
              wordBreak: 'break-all',
              userSelect: 'all',
            }}
          >
            {enrolment.secretBase32}
          </p>
          <p className="note">
            <a href={enrolment.otpauthUri}>Uygulamada aç</a> — bağlantıyı destekleyen uygulamalar
            anahtarı kendisi alır.
          </p>
          <label htmlFor="mfa-code">Uygulamanın gösterdiği kod</label>
          <input
            id="mfa-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <label htmlFor="mfa-enrol-password">Hesap parolanız</label>
          <input
            id="mfa-enrol-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <div className="row">
            <button
              type="button"
              className="no"
              onClick={() => {
                setPassword('');
                setStep('idle');
              }}
            >
              Vazgeç
            </button>
            <button
              type="submit"
              className="yes"
              disabled={busy || code.trim() === '' || password === ''}
              onClick={() => void confirm()}
            >
              {busy ? 'Doğrulanıyor…' : 'Doğrula ve aç'}
            </button>
          </div>
        </Win>
      )}

      {step === 'codes' && codes !== null && (
        <Win
          title="Kurtarma kodlarınız"
          glyph="🗝"
          tone="warn"
          onClose={() => {
            setCodes(null);
            setStep('idle');
          }}
        >
          <div className="warn" role="alert">
            <span className="ic" aria-hidden>
              ⚠
            </span>
            <span className="tx">
              <b>Bu kodlar bir daha gösterilmeyecek</b>
              Sunucu onları yalnız özet olarak saklıyor. Şimdi kopyalayın ve güvenli bir yere koyun;
              doğrulayıcınızı kaybederseniz hesabınıza girmenin tek yolu bunlar.
            </span>
          </div>
          <p style={{ fontFamily: 'var(--mono)', fontSize: 14, lineHeight: 2, userSelect: 'all' }}>
            {codes.join('  ')}
          </p>
          <div className="row">
            <button
              type="button"
              className="yes"
              onClick={() => {
                setCodes(null);
                setStep('idle');
              }}
            >
              Kaydettim
            </button>
          </div>
        </Win>
      )}

      {(step === 'removing' || step === 'codes-request') && (
        <Win
          title={step === 'removing' ? 'İki adımlı doğrulamayı kapat' : 'Kurtarma kodlarını yenile'}
          glyph="🔐"
          tone={step === 'removing' ? 'rose' : 'warn'}
          onClose={() => {
            setPassword('');
            setStep('idle');
          }}
        >
          <p className="note">
            {step === 'removing'
              ? 'Kapatınca girişte yalnız parolanız istenir. Onaylamak için parolanızı yazın.'
              : 'Eski kurtarma kodlarınız geçersiz olur. Onaylamak için parolanızı yazın.'}
          </p>
          <label htmlFor="mfa-password">Parolanız</label>
          <input
            id="mfa-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <div className="row">
            <button
              type="button"
              className="no"
              onClick={() => {
                setPassword('');
                setStep('idle');
              }}
            >
              Vazgeç
            </button>
            <button
              type="submit"
              className={step === 'removing' ? 'yes danger' : 'yes'}
              disabled={busy || password === ''}
              onClick={() => void (step === 'removing' ? remove() : regenerate())}
            >
              {step === 'removing' ? 'Kapat' : 'Yenile'}
            </button>
          </div>
        </Win>
      )}
    </>
  );
}
