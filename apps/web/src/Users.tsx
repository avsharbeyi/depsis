import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api, problemMessage } from './api.js';
import { formatWhen } from './Dashboard.js';
import { ConfirmBox, Empty } from './ui.js';

type User = OpenApi.components['schemas']['User'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

/**
 * The avatar tint carries the role, so a list of twenty accounts can be scanned for
 * administrators without reading a single pill. Iris for admin, cyan for member — the same two
 * tones the rest of the desktop uses for "privileged" and "ordinary".
 */
const AVATAR: Record<User['role'], React.CSSProperties> = {
  admin: { background: 'rgba(143,166,255,.24)', color: '#8FA6FF' },
  member: { background: 'rgba(91,200,245,.24)', color: '#5BC8F5' },
};

/** The contract's `CreateUserRequest.username` pattern, so the field refuses what the server would. */
const USERNAME = '[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}';

interface Props {
  currentUserId: string;
  notify: Notify;
  onUnauthenticated: () => void;
}

/**
 * Account administration — GET/POST /users, PATCH /users/{id}.
 *
 * The desktop only offers this window to an administrator, and that is a CONVENIENCE rather than
 * a control: every route here sits behind `AdminGuard` on the server, which is what actually
 * refuses a member. Hiding the entry point keeps someone from pressing a button that would 403;
 * it is not what stops them, and nothing in this file should be written as though it were.
 */
export function Users({ currentUserId, notify, onUnauthenticated }: Props): React.JSX.Element {
  const [users, setUsers] = useState<User[] | null>(null);
  /** Told apart from "no accounts": there is always at least one, so an empty list is a lie. */
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<User | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<User['role']>('member');

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    void (async () => {
      const { data, response } = await api.GET('/users', {});
      if (!alive) return;
      if (response.status === 401) {
        onUnauthenticated();
        return;
      }
      if (data === undefined) {
        // Not `setUsers([])`. "Hiç hesap yok" is impossible — the reader is signed in as one of
        // them — so an empty list here reads as a broken appliance rather than a failed read.
        notify('error', 'Hesaplar okunamadı.');
        setFailed(true);
        return;
      }
      setUsers(data.items);
    })();
    return () => {
      alive = false;
    };
  }, [reloadKey, notify, onUnauthenticated]);

  async function patch(
    user: User,
    body: OpenApi.components['schemas']['UpdateUserRequest'],
    done: string,
  ): Promise<void> {
    setConfirming(null);
    setBusy(true);
    const { error, response } = await api.PATCH('/users/{id}', {
      params: { path: { id: user.id } },
      body,
    });
    setBusy(false);
    if (response.status === 401) {
      onUnauthenticated();
      return;
    }
    if (!response.ok) {
      notify('error', problemMessage(error, 'Değişiklik uygulanamadı.'));
      return;
    }
    notify('ok', done);
    reload();
  }

  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    const { error, response } = await api.POST('/users', {
      body: { username, password, role },
    });
    setBusy(false);
    if (response.status === 401) {
      onUnauthenticated();
      return;
    }
    if (!response.ok) {
      // The form keeps everything it was given. A refusal that empties the fields makes the person
      // retype a name they had already got right in order to fix a password they had not.
      notify('error', problemMessage(error, 'Hesap oluşturulamadı.'));
      return;
    }
    notify('ok', `"${username}" oluşturuldu.`);
    setUsername('');
    setPassword('');
    setRole('member');
    reload();
  }

  return (
    <>
      {failed ? (
        <Empty
          glyph="⚠"
          text="Hesaplar okunamadı."
          action={
            <button type="button" className="b" onClick={reload}>
              Yeniden dene
            </button>
          }
        />
      ) : users === null ? (
        <p className="note">Yükleniyor…</p>
      ) : users.length === 0 ? (
        <Empty glyph="👥" text="Hiç hesap yok." />
      ) : (
        <div>
          {users.map((user) => {
            const self = user.id === currentUserId;
            return (
              <div className="urow" key={user.id}>
                <span className="av" style={AVATAR[user.role]} aria-hidden>
                  {user.username.slice(0, 1).toLocaleUpperCase('tr')}
                </span>
                <span className="i">
                  <b>
                    {user.username}
                    {self ? ' (siz)' : ''}
                  </b>
                  <span>oluşturuldu · {formatWhen(user.createdAt)}</span>
                </span>
                <span className={user.role === 'admin' ? 'st2 up' : 'st2 dn'}>
                  {user.role === 'admin' ? 'yönetici' : 'üye'}
                </span>
                <span className={user.disabled ? 'st2 er' : 'st2 dn'}>
                  {user.disabled ? 'devre dışı' : 'etkin'}
                </span>
                <button
                  type="button"
                  className="b"
                  disabled={busy}
                  onClick={() =>
                    void patch(
                      user,
                      { role: user.role === 'admin' ? 'member' : 'admin' },
                      user.role === 'admin'
                        ? `"${user.username}" artık üye.`
                        : `"${user.username}" artık yönetici.`,
                    )
                  }
                >
                  {user.role === 'admin' ? 'Üye yap' : 'Yönetici yap'}
                </button>
                {/* The server refuses this too — an administrator who disables themselves is signed
                    out by the next request with no way back in — but a button that explains itself
                    before the click is worth more than a 422 after it. */}
                <button
                  type="button"
                  className={user.disabled ? 'revoke back' : 'revoke'}
                  disabled={busy || self}
                  title={self ? 'Kendi hesabınızı devre dışı bırakamazsınız' : undefined}
                  onClick={() =>
                    user.disabled
                      ? void patch(user, { disabled: false }, `"${user.username}" yeniden etkin.`)
                      : setConfirming(user)
                  }
                >
                  {user.disabled ? 'Yeniden etkinleştir' : 'Devre dışı bırak'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      <form
        onSubmit={(event) => void create(event)}
        style={{ display: 'flex', flexDirection: 'column', gap: 9 }}
      >
        <div className="lbl">Yeni hesap</div>
        <label>
          Kullanıcı adı
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value.trim())}
            required
            pattern={USERNAME}
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            placeholder="ör. ayse"
          />
          <small>Harf, rakam, nokta, tire, alt çizgi. &apos;@&apos; olamaz.</small>
        </label>
        <label>
          Parola
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={12}
            autoComplete="new-password"
          />
          <small>En az 12 karakter. Karışım kuralı yok; uzunluk yeterli.</small>
        </label>
        <label>
          Rol
          <select
            value={role}
            onChange={(event) => setRole(event.target.value === 'admin' ? 'admin' : 'member')}
          >
            <option value="member">Üye</option>
            <option value="admin">Yönetici</option>
          </select>
        </label>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="submit" className="b pri" disabled={busy}>
            Oluştur
          </button>
        </div>
      </form>

      <div className="note">
        Devre dışı bırakılan hesap silinmez: oturumları kapanır, giriş yapamaz, istendiğinde geri
        açılır. Yönetici yetkisi verilen hesap diskleri, uygulamaları ve diğer hesapları
        değiştirebilir.
      </div>

      {confirming !== null && (
        <ConfirmBox
          title="Hesabı devre dışı bırak"
          body={`"${confirming.username}" giriş yapamayacak ve açık oturumları hemen kapanacak. Hesap silinmiyor.`}
          yesLabel="Devre dışı bırak"
          danger
          onYes={() =>
            void patch(confirming, { disabled: true }, `"${confirming.username}" devre dışı.`)
          }
          onNo={() => setConfirming(null)}
        />
      )}
    </>
  );
}
