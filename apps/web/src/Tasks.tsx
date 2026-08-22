import type { OpenApi } from '@depsis/contracts';
import { useEffect, useState } from 'react';

import { api, problemMessage } from './api.js';
import type { Tone } from './ui.js';
import { Empty, Glyph } from './ui.js';

type Task = OpenApi.components['schemas']['Task'];
type User = OpenApi.components['schemas']['User'];
type CurrentUser = OpenApi.components['schemas']['CurrentUser'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

/** The key the unassigned column is stored under; `null` cannot index a record. */
const NOBODY = 'nobody';

interface Person {
  /** `null` is the real "nobody has picked this up yet" state the contract models. */
  id: string | null;
  name: string;
  /** False for a person we only know from a task's `assigneeUsername` — see `people()`. */
  canAdd: boolean;
}

interface Group extends Person {
  key: string;
  tone: Tone;
  items: Task[];
  done: number;
}

const AVATAR_TONES: readonly Tone[] = ['cool', 'iris', 'warn', 'live', 'rose'];

/**
 * A stable colour per person.
 *
 * The reference hard-codes one tint per name in its demo data, which cannot survive real accounts.
 * Hashing the username keeps the useful half of that idea: the same person is the same colour on
 * every screen and after every reload, so the board can be read by shape before it is read by name.
 */
function toneFor(name: string): Tone {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) % 9973;
  return AVATAR_TONES[hash % AVATAR_TONES.length] ?? 'cool';
}

/**
 * Who gets a column.
 *
 * Everyone the client can name gets one even with nothing assigned, because an empty column is
 * where a task for that person is added. Someone who only appears as an assignee — which is what
 * a member sees, since `/users` is admin-only — gets a column without an input: the board can
 * show their work honestly, but this client cannot offer to create work for an account it cannot
 * enumerate.
 */
function people(tasks: Task[], me: CurrentUser, users: User[] | null): Person[] {
  const known = new Map<string, Person>();
  if (users === null) {
    known.set(me.id, { id: me.id, name: me.username, canAdd: true });
  } else {
    for (const user of users)
      known.set(user.id, { id: user.id, name: user.username, canAdd: true });
  }
  for (const task of tasks) {
    if (task.assigneeId === null || known.has(task.assigneeId)) continue;
    known.set(task.assigneeId, {
      id: task.assigneeId,
      name: task.assigneeUsername ?? 'Bilinmeyen hesap',
      canAdd: false,
    });
  }

  return [...known.values()].sort((a, b) => {
    // Own column first. A shared board is read to find one's own work before anyone else's.
    if (a.id === me.id) return -1;
    if (b.id === me.id) return 1;
    return a.name.localeCompare(b.name, 'tr');
  });
}

/**
 * Unfinished work first, in the order the board carries; finished work after it.
 *
 * Completed tasks stay on the board on purpose — "bugün neyi bitirdik" is one of the questions it
 * exists to answer — but they stay at the bottom, newest first, so they never push a live task
 * out of view.
 */
function order(items: Task[]): Task[] {
  return [...items].sort((a, b) => {
    if ((a.doneAt === null) !== (b.doneAt === null)) return a.doneAt === null ? -1 : 1;
    if (a.doneAt !== null && b.doneAt !== null) return b.doneAt.localeCompare(a.doneAt);
    if (a.position !== b.position) return a.position - b.position;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/**
 * The shared task board — GET/POST /tasks, PATCH/DELETE /tasks/{id}.
 *
 * Shared, unlike notes, and that is not an inconsistency: a task is assigned to somebody, and work
 * nobody can see has not been assigned to anyone.
 */
export function Tasks({
  notify,
  me,
  users,
}: {
  notify: Notify;
  me: CurrentUser;
  users: User[] | null;
}): React.JSX.Element {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  /** Told apart from "no tasks": an empty board is a fact, a read that never answered is not. */
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void (async () => {
      const { data } = await api.GET('/tasks', {});
      if (cancelled) return;
      if (data === undefined) {
        // Not `setTasks([])`. An empty board is a claim that nobody has anything to do, and a
        // failed read is not evidence for it.
        notify('error', 'İşler okunamadı.');
        setFailed(true);
        return;
      }
      setTasks(data.items);
    })();
    return () => {
      cancelled = true;
    };
  }, [notify, reloadKey]);

  async function update(
    task: Task,
    patch: { body?: string; assigneeId?: string | null; done?: boolean },
    failure: string,
  ): Promise<void> {
    setBusy(true);
    const { data, error } = await api.PATCH('/tasks/{id}', {
      params: { path: { id: task.id } },
      body: patch,
    });
    setBusy(false);
    if (error !== undefined || data === undefined) {
      notify('error', problemMessage(error, failure));
      return;
    }
    const saved = data;
    setTasks((current) =>
      current === null ? current : current.map((item) => (item.id === saved.id ? saved : item)),
    );
  }

  async function add(person: Person): Promise<void> {
    const key = person.id ?? NOBODY;
    const text = (drafts[key] ?? '').trim();
    if (text === '') return;
    setBusy(true);
    const { data, error } = await api.POST('/tasks', {
      body: { body: text, assigneeId: person.id },
    });
    setBusy(false);
    if (error !== undefined || data === undefined) {
      notify('error', problemMessage(error, 'İş eklenemedi.'));
      return;
    }
    const created = data;
    setTasks((current) => [...(current ?? []), created]);
    // Cleared only on success, so a rejected task is still in the field to retry or fix.
    setDrafts((current) => ({ ...current, [key]: '' }));
  }

  async function remove(task: Task): Promise<void> {
    setBusy(true);
    const { error } = await api.DELETE('/tasks/{id}', { params: { path: { id: task.id } } });
    setBusy(false);
    if (error !== undefined) {
      notify('error', problemMessage(error, 'İş silinemedi.'));
      return;
    }
    setTasks((current) => (current === null ? current : current.filter((it) => it.id !== task.id)));
  }

  if (failed) {
    return (
      <Empty
        glyph="⚠"
        text="İşler okunamadı."
        action={
          <button type="button" className="b" onClick={() => setReloadKey((key) => key + 1)}>
            Yeniden dene
          </button>
        }
      />
    );
  }

  if (tasks === null) {
    return <div className="note">İşler yükleniyor…</div>;
  }

  const persons = people(tasks, me, users);
  const groups: Group[] = [
    ...persons,
    // Always last, and always present: "birinin yapması lazım" is a state the board has to be
    // able to express, and the endpoint accepts a null assignee for exactly that.
    { id: null, name: 'Atanmamış', canAdd: true },
  ].map((person) => {
    const items = order(tasks.filter((task) => task.assigneeId === person.id));
    return {
      ...person,
      key: person.id ?? NOBODY,
      tone: person.id === null ? 'dim' : toneFor(person.name),
      items,
      done: items.filter((task) => task.doneAt !== null).length,
    };
  });

  // Options for the per-task assignee picker. A member cannot list accounts, so the only moves
  // offered are onto their own name or off it — anything else would be a select full of names
  // this client had to invent.
  const assignable: Person[] =
    users === null
      ? [{ id: me.id, name: me.username, canAdd: true }]
      : users.map((user) => ({ id: user.id, name: user.username, canAdd: true }));

  return (
    <>
      <div className="note">
        Bu pano herkese açıktır: bir iş birine atanır ve göremediği bir iş atanmış sayılmaz.
        Tamamlananlar listenin sonunda durur.
      </div>

      <div className="jobs">
        {groups.map((group) => (
          <div className="jper" key={group.key}>
            <div className="jhead">
              <Glyph tone={group.tone} size={26}>
                {group.name.slice(0, 1).toUpperCase()}
              </Glyph>
              <b>{group.name}</b>
              <span className="cnt">
                {group.done}/{group.items.length} tamam
              </span>
            </div>

            {group.items.map((task) => {
              const done = task.doneAt !== null;
              return (
                <div className={done ? 'jitem done' : 'jitem'} key={task.id}>
                  <button
                    type="button"
                    className={done ? 'jck on' : 'jck'}
                    disabled={busy}
                    aria-pressed={done}
                    aria-label={
                      done ? 'Tamamlanmadı olarak işaretle' : 'Tamamlandı olarak işaretle'
                    }
                    onClick={() => void update(task, { done: !done }, 'İş güncellenemedi.')}
                  >
                    ✓
                  </button>

                  {/* Keyed by the server's own timestamp so a value the API normalised replaces
                      what is in the DOM. A contenteditable node React never re-renders keeps
                      whatever the browser left in it, which is how a rejected edit stays on
                      screen looking accepted. */}
                  <span
                    key={task.updatedAt}
                    className="tx"
                    contentEditable
                    suppressContentEditableWarning
                    role="textbox"
                    tabIndex={0}
                    aria-label="İş metni"
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        // A task is one line. Enter commits it instead of growing the row.
                        event.preventDefault();
                        event.currentTarget.blur();
                        return;
                      }
                      if (event.key !== 'Escape') return;
                      event.currentTarget.textContent = task.body;
                      event.currentTarget.blur();
                    }}
                    onBlur={(event) => {
                      const next = (event.currentTarget.textContent ?? '').trim();
                      if (next === task.body) return;
                      if (next === '') {
                        // Emptying the text is not how a task is deleted; the ✕ is.
                        event.currentTarget.textContent = task.body;
                        return;
                      }
                      void update(task, { body: next }, 'İş metni kaydedilemedi.');
                    }}
                  >
                    {task.body}
                  </span>

                  <select
                    value={task.assigneeId ?? ''}
                    disabled={busy}
                    aria-label="Atanan kişi"
                    style={{ fontSize: 11, padding: '3px 6px', borderRadius: 7, maxWidth: 130 }}
                    onChange={(event) => {
                      const chosen = event.target.value;
                      void update(
                        task,
                        { assigneeId: chosen === '' ? null : chosen },
                        'Atama değiştirilemedi.',
                      );
                    }}
                  >
                    <option value="">Atanmamış</option>
                    {assignable.map((person) => (
                      <option key={person.id ?? NOBODY} value={person.id ?? ''}>
                        {person.name}
                      </option>
                    ))}
                    {/* The current assignee may be someone this client cannot enumerate. Without
                        this the select would silently show the wrong name. */}
                    {task.assigneeId !== null &&
                      !assignable.some((person) => person.id === task.assigneeId) && (
                        <option value={task.assigneeId}>
                          {task.assigneeUsername ?? 'Bilinmeyen hesap'}
                        </option>
                      )}
                  </select>

                  <button
                    type="button"
                    className="del"
                    disabled={busy}
                    aria-label={`"${task.body}" işini sil`}
                    title="İşi sil"
                    onClick={() => void remove(task)}
                  >
                    ✕
                  </button>
                </div>
              );
            })}

            {group.canAdd && (
              <div className="jadd">
                <input
                  value={drafts[group.key] ?? ''}
                  /* Deliberately never disabled: adding several tasks in a row means typing the
                     next one while the previous request is still open, and a field that greys out
                     mid-sentence drops both the keystrokes and the focus. */
                  aria-label={`${group.name} için iş ekle`}
                  placeholder={
                    group.id === null
                      ? 'Kimseye atanmamış iş ekle — Enter'
                      : `${group.name} için iş ekle — Enter`
                  }
                  onChange={(event) => {
                    const text = event.target.value;
                    setDrafts((current) => ({ ...current, [group.key]: text }));
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    void add(group);
                  }}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
