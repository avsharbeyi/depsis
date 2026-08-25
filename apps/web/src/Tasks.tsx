import type { OpenApi } from '@depsis/contracts';
import { useEffect, useState } from 'react';

import { api, problemMessage } from './api.js';
import { TagBar, type Tag } from './TagBar.js';
import { TaskThread } from './TaskThread.js';
import type { Tone } from './ui.js';
import { Empty, Glyph } from './ui.js';

type Task = OpenApi.components['schemas']['Task'];
type Status = Task['status'];
type Priority = Task['priority'];

/**
 * Durumların insan tarafı.
 *
 * Sunucudaki makine yalnız iki geçişi yasaklıyor (bkz. `TRANSITIONS`), o yüzden burada bir liste
 * kutusu yeterli: reddedilen bir seçim 422 ile geri geliyor ve mesajı iki durumu da adlandırıyor.
 * Seçenekleri istemcide filtrelemek, sunucunun kuralını ikinci kez — ve zamanla farklı biçimde —
 * yazmak olurdu.
 */
const STATUS_LABEL: Record<Status, string> = {
  draft: 'Taslak',
  assigned: 'Atandı',
  in_progress: 'Devam ediyor',
  in_review: 'İncelemede',
  done: 'Tamamlandı',
  cancelled: 'İptal',
};

const PRIORITY_LABEL: Record<Priority, string> = {
  low: 'Düşük',
  normal: 'Normal',
  high: 'Yüksek',
  urgent: 'Acil',
};

/** Yalnız yükseltilmiş öncelikler işaretleniyor: her satırda bir rozet, hiçbirinde yok demektir. */
const PRIORITY_TONE: Partial<Record<Priority, string>> = {
  high: 'pill warn',
  urgent: 'pill bad',
};

/**
 * Son tarih, okunabilir ve GEÇMİŞSE söyleyerek.
 *
 * Gecikmiş bir işi normal bir tarih gibi göstermek, son tarihin var olma sebebini boşa çıkarır —
 * ve "3 gün geçti" bir tarihten daha hızlı okunuyor.
 */
function dueLabel(dueAt: string | null | undefined): { text: string; late: boolean } | null {
  if (dueAt === null || dueAt === undefined) return null;
  const at = new Date(dueAt);
  if (Number.isNaN(at.getTime())) return null;
  const days = Math.round((at.getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { text: `${-days} gün geçti`, late: true };
  if (days === 0) return { text: 'bugün', late: false };
  if (days === 1) return { text: 'yarın', late: false };
  if (days <= 7) return { text: `${days} gün`, late: false };
  return { text: at.toLocaleDateString('tr-TR'), late: false };
}
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
/**
 * Kapanmış işler aşağı, gecikmişler yukarı.
 *
 * `cancelled` de `done` gibi aşağıda: ikisi de "buna bakmana gerek yok" demek, ve iptal edilmiş
 * bir işi açık işlerin arasında tutmak listeyi okunmaz yapardı. Aralarında ise iptal önce gelmiyor
 * — sıralamayı `doneAt` belirliyor ve iptalin öyle bir damgası yok, o yüzden yaşına düşüyor.
 *
 * GECİKMİŞLER en üstte, ve bu tek gerçek sıralama kararı: son tarihi geçmiş bir iş, elle
 * sürüklenmiş bir sıradan daha acil bir bilgi.
 */
function closed(task: Task): boolean {
  return task.status === 'done' || task.status === 'cancelled';
}

function overdue(task: Task): boolean {
  return !closed(task) && dueLabel(task.dueAt)?.late === true;
}

function order(items: Task[]): Task[] {
  return [...items].sort((a, b) => {
    if (closed(a) !== closed(b)) return closed(a) ? 1 : -1;
    if (a.doneAt !== null && b.doneAt !== null) return b.doneAt.localeCompare(a.doneAt);
    if (overdue(a) !== overdue(b)) return overdue(a) ? -1 : 1;
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
  // Aynı anda TEK tartışma açık. İkisi birden açıkken pano bir listeden çok bir yığına dönüşüyor,
  // ve zaten okunan şey her seferinde tek bir işin konuşması.
  const [open, setOpen] = useState<string | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  /** Seçili etiketler. Boşsa süzme yok — panonun varsayılanı her şeyi göstermek. */
  const [filter, setFilter] = useState<string[]>([]);

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
    patch: {
      body?: string;
      assigneeId?: string | null;
      done?: boolean;
      status?: Status;
      priority?: Priority;
      dueAt?: string | null;
    },
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

  // Etiket sözlüğü, panoyla birlikte. Ayrı bir efekt çünkü ayrı bir uç — ve `reloadKey`'e bağlı,
  // yani bir etiket yeniden adlandırıldığında ikisi de tazeleniyor.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data } = await api.GET('/tags', {});
      if (!alive || data === undefined) return;
      setTags(data.items);
    })();
    return () => {
      alive = false;
    };
  }, [reloadKey]);

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

  /**
   * Bir işe parça ekle.
   *
   * `add`'den ayrı, çünkü o `drafts` sözlüğünden okuyor ve kişi sütunlarına ait. Bir parçanın
   * kutusu tartışma panelinde ve kendi durumunu orada tutuyor; ikisini tek fonksiyona sıkıştırmak,
   * hangi kutunun hangi metni sahiplendiğini okunmaz yapardı.
   *
   * ATANMAMIŞ doğuyor. Üst işin atananını devralmak makul görünüyor ama yanlış: bir işi parçalara
   * ayırmanın sebebi çoğu zaman onları BAŞKALARINA dağıtmak, ve sessizce atanmış bir parça o
   * kişinin panosunda istemediği bir satır olarak beliriyor.
   */
  async function addSubtask(parentId: string, body: string): Promise<void> {
    const text = body.trim();
    if (text === '') return;
    const { data, error } = await api.POST('/tasks', {
      body: { body: text, assigneeId: null, parentId },
    });
    if (error !== undefined || data === undefined) {
      notify('error', problemMessage(error, 'Parça eklenemedi.'));
      return;
    }
    const created = data;
    setTasks((current) =>
      current === null
        ? [created]
        : [
            ...current.map((it) =>
              // Üstün rozetini burada artırıyor: sayıyı sunucu `GET /tasks` ile veriyor ve o çağrı
              // yapılmadan rozet olduğu yerde kalırdı. Kesin bir artış — yeni parça atanmamış ve
              // açık doğuyor, yani toplam bir artıyor ve kapananlar değişmiyor.
              it.id === parentId ? { ...it, subtaskTotal: (it.subtaskTotal ?? 0) + 1 } : it,
            ),
            created,
          ],
    );
  }

  /**
   * Bir işin madde sayacını panoda güncelle.
   *
   * `useCallback` DEĞİL ve olmasına gerek yok: `TaskThread` onu bir efektin bağımlılığı olarak
   * kullanmıyor, yalnız olay anında çağırıyor.
   */
  function setChecklistCount(taskId: string, done: number, total: number): void {
    setTasks((current) => {
      if (current === null) return current;
      const at = current.find((it) => it.id === taskId);
      // AYNI SAYILARSA AYNI DİZİ. Yeni bir dizi döndürmek React'i her seferinde yeniden çizdiriyor,
      // ve panel her okumasında bu fonksiyonu çağırdığı için o çizim yeni bir `onCounts` üretip
      // paneldeki efekti yeniden tetikliyordu — kendi kendini besleyen bir okuma döngüsü. Bail-out
      // onun bir ucu; ötekisi `TaskThread`'in `onCounts`'u bir ref'te tutması.
      if (at === undefined || (at.checklistDone === done && at.checklistTotal === total)) {
        return current;
      }
      return current.map((it) =>
        it.id === taskId ? { ...it, checklistDone: done, checklistTotal: total } : it,
      );
    });
  }

  async function remove(task: Task): Promise<void> {
    // KASKAT ÖNCE SÖYLENİYOR. Bir üst işi silmek parçalarını da siliyor, ve bunu sessizce yapmak
    // veri kaybının en sık biçimi: kullanıcı bir satır sildiğini sanıyor, dört satır gidiyor.
    // Onay yalnız parçası olan işlerde soruluyor — her silmede bir kutu, okunmayan bir kutu.
    if (
      task.subtaskTotal !== undefined &&
      task.subtaskTotal > 0 &&
      !window.confirm(`Bu işin ${task.subtaskTotal} parçası da silinecek. Devam edilsin mi?`)
    ) {
      return;
    }
    setBusy(true);
    const { error } = await api.DELETE('/tasks/{id}', { params: { path: { id: task.id } } });
    setBusy(false);
    if (error !== undefined) {
      notify('error', problemMessage(error, 'İş silinemedi.'));
      return;
    }
    // Parçaları da listeden düşüyor: sunucu onları sildi, ve ekranda bırakmak bir sonraki
    // tıklamada 404 üretirdi.
    setTasks((current) =>
      current === null
        ? current
        : current.filter((it) => it.id !== task.id && it.parentId !== task.id),
    );
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
  // SÜZME İSTEMCİDE. Pano zaten bütün işleri tek çağrıda getiriyor ve etiketler her satırda
  // geliyor; sunucuya bir sorgu parametresi eklemek, elde olan bir cevabı ikinci kez sormak olurdu.
  // Bir iş SEÇİLİ ETİKETLERİN HEPSİNİ taşımak zorunda: iki etiket seçmek daraltıyor, genişletmiyor
  // — "acil VE depolama" sorulabilir bir soru, "acil ya da depolama" ise seçimin kendisi.
  const shown =
    filter.length === 0
      ? tasks
      : tasks.filter((task) =>
          filter.every((id) => (task.tags ?? []).some((tag) => tag.id === id)),
        );
  const groups: Group[] = [
    ...persons,
    // Always last, and always present: "birinin yapması lazım" is a state the board has to be
    // able to express, and the endpoint accepts a null assignee for exactly that.
    { id: null, name: 'Atanmamış', canAdd: true },
  ].map((person) => {
    const items = order(shown.filter((task) => task.assigneeId === person.id));
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

      <TagBar
        tags={tags}
        selected={filter}
        isAdmin={me.role === 'admin'}
        onToggle={(id) =>
          setFilter((current) =>
            current.includes(id) ? current.filter((it) => it !== id) : [...current, id],
          )
        }
        // Sözlük değişti: hem şeridi hem PANOYU yeniden okuyor. Bir etiketin adı değiştiğinde
        // satırlardaki çipler de değişiyor, ve yalnız şeridi tazelemek onları eski adla bırakırdı.
        onChanged={() => setReloadKey((key) => key + 1)}
        onError={(text) => notify('error', text)}
      />

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
              const due = dueLabel(task.dueAt);
              const shut = closed(task);
              const talking = open === task.id;
              return (
                <div className={talking ? 'jwrap on' : 'jwrap'} key={task.id}>
                  <div className={shut ? 'jitem done' : 'jitem'}>
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

                    <select
                      value={task.status}
                      disabled={busy}
                      aria-label="Durum"
                      style={{ fontSize: 11, padding: '3px 6px', borderRadius: 7 }}
                      onChange={(event) => {
                        // Seçenekler FİLTRELENMİYOR. Sunucudaki makine yalnız iki geçişi yasaklıyor
                        // ve reddi 422 ile iki durumu da adlandırarak geliyor; burada ikinci bir
                        // kopya tutmak, zamanla ayrışacak iki kural demek olurdu.
                        void update(
                          task,
                          { status: event.target.value as Status },
                          'Durum değiştirilemedi.',
                        );
                      }}
                    >
                      {(Object.keys(STATUS_LABEL) as Status[]).map((value) => (
                        <option key={value} value={value}>
                          {STATUS_LABEL[value]}
                        </option>
                      ))}
                    </select>

                    <select
                      value={task.priority}
                      disabled={busy}
                      aria-label="Öncelik"
                      className={PRIORITY_TONE[task.priority]}
                      style={{ fontSize: 11, padding: '3px 6px', borderRadius: 7 }}
                      onChange={(event) => {
                        void update(
                          task,
                          { priority: event.target.value as Priority },
                          'Öncelik değiştirilemedi.',
                        );
                      }}
                    >
                      {(Object.keys(PRIORITY_LABEL) as Priority[]).map((value) => (
                        <option key={value} value={value}>
                          {PRIORITY_LABEL[value]}
                        </option>
                      ))}
                    </select>

                    <label
                      className="m"
                      style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}
                    >
                      <input
                        type="date"
                        disabled={busy}
                        aria-label="Son tarih"
                        // `<input type=date>` yerel bir GÜN veriyor, sunucu ise bir AN istiyor —
                        // "yarın" bir zaman diliminde yarın, başkasında bugün. Günün sonuna
                        // sabitleniyor: bir son tarih, o günün bitmesiyle geçiyor.
                        value={
                          task.dueAt === null || task.dueAt === undefined
                            ? ''
                            : task.dueAt.slice(0, 10)
                        }
                        onChange={(event) => {
                          const day = event.target.value;
                          void update(
                            task,
                            {
                              dueAt: day === '' ? null : new Date(`${day}T23:59:59`).toISOString(),
                            },
                            'Son tarih değiştirilemedi.',
                          );
                        }}
                        style={{ fontSize: 11, padding: '2px 4px', borderRadius: 6, width: 122 }}
                      />
                      {due !== null && (
                        <span className={due.late ? 'pill bad' : 'pill dim'}>{due.text}</span>
                      )}
                    </label>

                    {/* Parça ve madde ilerlemesi. İkisi de yalnız VARSA çiziliyor: her satırda
                      "0/0" duran bir rozet, göz için hiçbir şey söylemeyen bir şey. */}
                    {task.subtaskTotal !== undefined && task.subtaskTotal > 0 && (
                      <span className="pill dim" title="Parçalar">
                        ⑂ {task.subtaskDone ?? 0}/{task.subtaskTotal}
                      </span>
                    )}
                    {task.checklistTotal !== undefined && task.checklistTotal > 0 && (
                      <span className="pill dim" title="Kontrol listesi">
                        ☑ {task.checklistDone ?? 0}/{task.checklistTotal}
                      </span>
                    )}
                    {/* Parçası olduğu iş. Pano KİŞİYE göre gruplanıyor, o yüzden bir alt görev
                      atananının sütununda duruyor — orada gizlemek, o kişiye verilmiş işi
                      panodan kaldırmak olurdu. Neyin parçası olduğu ise ancak burada okunabilir. */}
                    {task.parentId !== null && task.parentId !== undefined && (
                      <span className="pill dim" title="Şunun parçası">
                        ⤷ {parentBody(tasks, task.parentId)}
                      </span>
                    )}

                    {(task.tags ?? []).map((tag) => (
                      <span className={`tg c-${tag.color} sm`} key={tag.id}>
                        {tag.name}
                      </span>
                    ))}

                    {task.linkedFileCount !== undefined && task.linkedFileCount > 0 && (
                      // Sayı ÇAĞIRANIN GÖREBİLDİKLERİ. Toplamı göstermek, göremediği dosyaların
                      // varlığını söylerdi — §7'nin yasakladığı şeyin sayı hâli.
                      <span className="pill dim" title="Bağlı dosya">
                        🗂 {task.linkedFileCount}
                      </span>
                    )}

                    {/* Tartışmayı açan düğme. Yorum SAYISI YOK, ve bu bir eksiklik değil: sayıyı
                      göstermek, pano her yüklendiğinde her iş için bir sorgu demek — otuz işlik
                      bir panoda otuz sorgu, kimsenin bakmadığı bir sayı için. Açan görüyor. */}
                    <button
                      type="button"
                      className={talking ? 'jtalk on' : 'jtalk'}
                      aria-expanded={talking}
                      aria-label={`"${task.body}" işinin yorumları`}
                      title="Yorumlar ve izleyiciler"
                      onClick={() => setOpen(talking ? null : task.id)}
                    >
                      💬
                    </button>

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
                  {talking && (
                    <TaskThread
                      subtasks={tasks.filter((it) => it.parentId === task.id)}
                      canHaveSubtasks={task.parentId === null || task.parentId === undefined}
                      onSubtask={(body) => void addSubtask(task.id, body)}
                      onCounts={(done, total) => setChecklistCount(task.id, done, total)}
                      tags={tags}
                      taskTags={task.tags ?? []}
                      onTags={() => setReloadKey((key) => key + 1)}
                      taskId={task.id}
                      me={me.username}
                      isAdmin={me.role === 'admin'}
                      onError={(text) => notify('error', text)}
                    />
                  )}
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

/**
 * Bir parçanın üst işinin metni, panodan.
 *
 * Sunucuya sorulmuyor: üst iş zaten aynı listede — pano bütün işleri tek çağrıda getiriyor — ve
 * bunun için ikinci bir alan eklemek her satırda tekrar eden bir metin taşımak olurdu. Bulunamazsa
 * boş dönmüyor: "bir şeyin parçası" bilgisi, neyin parçası olduğundan bağımsız olarak doğru.
 */
function parentBody(tasks: Task[], parentId: string): string {
  const parent = tasks.find((task) => task.id === parentId);
  if (parent === undefined) return 'üst iş';
  return parent.body.length <= 24 ? parent.body : `${parent.body.slice(0, 23)}…`;
}
