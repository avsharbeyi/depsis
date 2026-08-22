import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api, problemMessage } from './api.js';
import { formatWhen } from './Dashboard.js';
import { ConfirmDialog, IconUsers } from './ui.js';

type User = OpenApi.components['schemas']['User'];

interface Props {
  currentUserId: string;
  onUnauthenticated: () => void;
  notify: (kind: 'ok' | 'error', text: string) => void;
}

type Modal = { kind: 'none' } | { kind: 'disable'; user: User };

/**
 * Account administration.
 *
 * Rendered only for administrators, and that is a CONVENIENCE rather than a control: every one of
 * these endpoints is behind `AdminGuard` on the server, which is what actually refuses a member.
 * Hiding the tab keeps someone from clicking a button that would 403; it is not what stops them.
 */
export function Users({ currentUserId, onUnauthenticated, notify }: Props): React.JSX.Element {
  const [users, setUsers] = useState<User[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<Modal>({ kind: 'none' });
  const [reloadKey, setReloadKey] = useState(0);
  const [form, setForm] = useState({ username: '', password: '', role: 'member' });

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
        notify('error', 'Kullanıcılar okunamadı.');
        setUsers([]);
        return;
      }
      setUsers(data.items);
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey, onUnauthenticated, notify]);

  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    const { error } = await api.POST('/users', {
      body: {
        username: form.username,
        password: form.password,
        role: form.role === 'admin' ? 'admin' : 'member',
      },
    });
    setBusy(false);
    if (error !== undefined) {
      notify('error', problemMessage(error, 'Hesap oluşturulamadı.'));
      return;
    }
    notify('ok', `"${form.username}" oluşturuldu.`);
    // Cleared on success only. A failed submission that wipes the form makes the person retype a
    // name they had already got right.
    setForm({ username: '', password: '', role: 'member' });
    reload();
  }

  async function change(user: User, body: Record<string, unknown>): Promise<void> {
    setModal({ kind: 'none' });
    setBusy(true);
    const { error } = await api.PATCH('/users/{id}', {
      params: { path: { id: user.id } },
      body: body as never,
    });
    setBusy(false);
    if (error !== undefined) {
      notify('error', problemMessage(error, 'Değişiklik uygulanamadı.'));
      return;
    }
    reload();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Kullanıcılar</h1>
          <p className="muted">Bu cihazda hesabı olan herkes.</p>
        </div>
      </div>

      <div className="panel">
        {users === null ? (
          <p className="muted">Yükleniyor…</p>
        ) : users.length === 0 ? (
          <div className="empty">
            <IconUsers />
            <p>Hiç hesap yok.</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Kullanıcı adı</th>
                  <th>Rol</th>
                  <th>Durum</th>
                  <th className="hide-narrow">Oluşturulma</th>
                  <th className="shrink" aria-label="İşlemler" />
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className={user.disabled ? 'dimmed' : undefined}>
                    <td>
                      {user.username}
                      {user.id === currentUserId && <span className="muted"> (siz)</span>}
                    </td>
                    <td>
                      <span className={user.role === 'admin' ? 'pill ok' : 'pill neutral'}>
                        {user.role === 'admin' ? 'Yönetici' : 'Üye'}
                      </span>
                    </td>
                    <td>
                      <span className={user.disabled ? 'pill bad' : 'pill neutral'}>
                        {user.disabled ? 'Devre dışı' : 'Etkin'}
                      </span>
                    </td>
                    <td className="hide-narrow">{formatWhen(user.createdAt)}</td>
                    <td className="shrink">
                      <div className="row-actions">
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
                          onClick={() =>
                            user.disabled
                              ? void change(user, { disabled: false })
                              : setModal({ kind: 'disable', user })
                          }
                        >
                          {user.disabled ? 'Etkinleştir' : 'Devre dışı bırak'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel" style={{ maxWidth: '32rem' }}>
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
            <span className="muted">Harf, rakam, nokta, tire ve alt çizgi. &apos;@&apos; olamaz.</span>
          </label>
          <label>
            Parola
            <input
              type="password"
              autoComplete="new-password"
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
          <button type="submit" className="primary" disabled={busy}>
            Oluştur
          </button>
        </form>
      </div>

      {modal.kind === 'disable' && (
        <ConfirmDialog
          title="Hesabı devre dışı bırak"
          body={`"${modal.user.username}" giriş yapamayacak ve açık oturumları hemen kapanacak. Hesap silinmiyor; istediğinizde geri açabilirsiniz.`}
          confirmLabel="Devre dışı bırak"
          danger
          onConfirm={() => void change(modal.user, { disabled: true })}
          onCancel={() => setModal({ kind: 'none' })}
        />
      )}
    </>
  );
}
