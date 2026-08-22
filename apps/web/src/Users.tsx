import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api, problemMessage } from './api.js';

type User = OpenApi.components['schemas']['User'];

interface Props {
  currentUserId: string;
  onUnauthenticated: () => void;
}

/**
 * Account administration.
 *
 * Rendered only for administrators, and that is a CONVENIENCE rather than a control: every one of
 * these endpoints is behind `AdminGuard` on the server, which is what actually refuses a member.
 * Hiding the tab keeps someone from clicking a button that would 403; it is not what stops them.
 */
export function Users({ currentUserId, onUnauthenticated }: Props): React.JSX.Element {
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [form, setForm] = useState({ username: '', displayName: '', password: '', role: 'member' });

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, response } = await api.GET('/users', {});
      if (cancelled) return;
      if (response.status === 401) {
        onUnauthenticated();
        return;
      }
      if (data === undefined) {
        setError('Kullanıcılar okunamadı.');
        setUsers([]);
        return;
      }
      setUsers(data.items);
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey, onUnauthenticated]);

  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: problem } = await api.POST('/users', {
      body: {
        username: form.username,
        displayName: form.displayName,
        password: form.password,
        role: form.role === 'admin' ? 'admin' : 'member',
      },
    });
    setBusy(false);
    if (problem !== undefined) {
      setError(problemMessage(problem, 'Hesap oluşturulamadı.'));
      return;
    }
    // Cleared on success only. A failed submission that wipes the form makes the person retype an
    // address they had already got right.
    setForm({ username: '', displayName: '', password: '', role: 'member' });
    reload();
  }

  async function change(user: User, body: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    const { error: problem } = await api.PATCH('/users/{id}', {
      params: { path: { id: user.id } },
      body: body as never,
    });
    setBusy(false);
    if (problem !== undefined) {
      setError(problemMessage(problem, 'Değişiklik uygulanamadı.'));
      return;
    }
    reload();
  }

  return (
    <section className="card wide">
      <h1>Kullanıcılar</h1>

      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {users === null ? (
        <p className="muted">Yükleniyor…</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Ad</th>
                <th>Kullanıcı adı</th>
                <th>Rol</th>
                <th>Durum</th>
                <th aria-label="İşlemler" />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className={user.disabled ? 'dimmed' : undefined}>
                  <td>{user.displayName}</td>
                  <td className="hide-narrow">{user.username}</td>
                  <td>{user.role === 'admin' ? 'Yönetici' : 'Üye'}</td>
                  <td>
                    <span className={user.disabled ? 'bad' : 'ok'}>
                      {user.disabled ? 'Devre dışı' : 'Etkin'}
                    </span>
                  </td>
                  <td className="actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void change(user, { role: user.role === 'admin' ? 'member' : 'admin' })
                      }
                    >
                      {user.role === 'admin' ? 'Üye yap' : 'Yönetici yap'}
                    </button>
                    {/* The server refuses this too — an administrator disabling themselves is
                        signed out by the next request with no way back — but a disabled button
                        explains it before the click rather than after. */}
                    <button
                      type="button"
                      disabled={busy || user.id === currentUserId}
                      title={
                        user.id === currentUserId
                          ? 'Kendi hesabınızı devre dışı bırakamazsınız'
                          : undefined
                      }
                      onClick={() => void change(user, { disabled: !user.disabled })}
                    >
                      {user.disabled ? 'Etkinleştir' : 'Devre dışı bırak'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Yeni hesap</h2>
      <form onSubmit={(e) => void create(e)}>
        <label>
          Kullanıcı adı
          <input
            required
            pattern="[A-Za-z0-9][A-Za-z0-9._\-]*"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value.trim() })}
          />
          <span className="muted">Harf, rakam, nokta, tire ve alt çizgi. '@' olamaz.</span>
        </label>
        <label>
          Görünen ad
          <input
            required
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          />
        </label>
        <label>
          Parola
          <input
            type="password"
            required
            minLength={12}
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          <span className="muted">En az 12 karakter.</span>
        </label>
        <label>
          Rol
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="member">Üye</option>
            <option value="admin">Yönetici</option>
          </select>
        </label>
        <button type="submit" disabled={busy}>
          Oluştur
        </button>
      </form>
    </section>
  );
}
