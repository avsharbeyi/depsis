import type { OpenApi } from '@depsis/contracts';
import { useEffect, useState } from 'react';

import { api, problemMessage } from './api.js';
import { TagBar, type Tag } from './TagBar.js';
import { TaskThread } from './TaskThread.js';
import type { Tone } from './ui.js';
import { Empty, Glyph } from './ui.js';
import { downloadXlsx } from './xlsx.js';

type Task = OpenApi.components['schemas']['Task'];
type Status = Task['status'];
type Priority = Task['priority'];
type LogEntry = OpenApi.components['schemas']['TaskLogEntry'];

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

/** Yerel gün başlangıcı. Gün farkını buradan ölçmek yaz saatini de (23 ya da 25 saatlik gün) taşır. */
function midnight(when: Date): number {
  return new Date(when.getFullYear(), when.getMonth(), when.getDate()).getTime();
}

/**
 * Son tarih, okunabilir ve GEÇMİŞSE söyleyerek.
 *
 * Gecikmiş bir işi normal bir tarih gibi göstermek, son tarihin var olma sebebini boşa çıkarır —
 * ve "3 gün geçti" bir tarihten daha hızlı okunuyor.
 *
 * GÜN FARKI TAKVİMDEN OKUNUYOR, mutlak zamanın yuvarlanmasından değil. Son tarih her zaman yerel
 * 23:59:59'a sabitlendiği için aradaki fark hiçbir zaman tam gün değil: `Math.round` bugün biten
 * bir işi sabah 09:00'da "yarın", dün biten bir işi de öğlene kadar "bugün" ve gecikmemiş
 * gösteriyordu — kırmızı rozet ve "gecikmişler en üstte" sırası yarım gün geç geliyordu.
 */
export function dueLabel(
  dueAt: string | null | undefined,
  now: Date = new Date(),
): { text: string; late: boolean } | null {
  if (dueAt === null || dueAt === undefined) return null;
  const at = new Date(dueAt);
  if (Number.isNaN(at.getTime())) return null;
  const days = Math.round((midnight(at) - midnight(now)) / 86_400_000);
  // "Geçti" bir takvim sorusu değil bir saat sorusu: son tarih o günün sonuna kadar geçmemiştir.
  const late = at.getTime() < now.getTime();
  if (days < 0) return { text: `${-days} gün geçti`, late: true };
  if (days === 0) return { text: 'bugün', late };
  if (days === 1) return { text: 'yarın', late: false };
  if (days <= 7) return { text: `${days} gün`, late: false };
  return { text: at.toLocaleDateString('tr-TR'), late: false };
}
/**
 * Bir tarihi içeren haftanın PAZARTESİsi, yerel gece yarısında.
 *
 * Pazartesi çünkü ürün Türkçe ve hafta burada pazartesi başlıyor; `getDay()` pazarı 0 saydığı için
 * kaydırma elle yapılıyor. Gün başlangıcı `midnight` ile okunuyor, saat çıkarılarak değil: yaz
 * saatine geçilen hafta 23 saatlik bir gün taşır ve "24 saat geri" o haftada yanlış güne düşer.
 */
export function weekStart(when: Date): Date {
  const day = new Date(when.getFullYear(), when.getMonth(), when.getDate());
  const shift = (day.getDay() + 6) % 7;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - shift);
}

/** `start`'tan başlayan yedi günün yerel gece yarıları. */
export function weekDays(start: Date): Date[] {
  return Array.from(
    { length: 7 },
    (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index),
  );
}

/**
 * O GÜN son tarihi dolan, henüz kapanmamış işler.
 *
 * Karşılaştırma TAKVİM GÜNÜ üzerinden: son tarih formda her zaman yerel 23:59:59'a sabitleniyor,
 * ve iki damgayı doğrudan karşılaştırmak aynı günü farklı saatlerde farklı günler sayardı.
 * Kapanmış işler dışarıda — takvimin cevapladığı soru "bu hafta neyin süresi doluyor", ve biten
 * işin süresi dolmuyor.
 */
export function tasksDueOn(tasks: Task[], day: Date): Task[] {
  const at = midnight(day);
  return tasks.filter((task) => {
    if (closed(task)) return false;
    if (task.dueAt === null || task.dueAt === undefined) return false;
    const due = new Date(task.dueAt);
    return !Number.isNaN(due.getTime()) && midnight(due) === at;
  });
}

type Account = OpenApi.components['schemas']['DirectoryEntry'];
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

/** Günlük satırındaki alan adlarının insan tarafı. */
const FIELD_LABEL: Record<string, string> = {
  status: 'durumu',
  priority: 'önceliği',
  due_at: 'son tarihi',
  assignee_id: 'atananı',
  body: 'metni',
  description: 'açıklaması',
  file_link: 'dosya bağı',
  comment: 'yorumu (silindi)',
  parent_id: 'üst işi',
  checklist: 'kontrol listesi',
  tag: 'etiketi',
};

/** Günlükteki ham değerin okunur hâli: durum/öncelik sözlüklerinden geçir, tarihi kısalt. */
function logValue(field: string, value: string | null): string {
  if (value === null || value === '') return '—';
  if (field === 'status') return STATUS_LABEL[value as Status] ?? value;
  if (field === 'priority') return PRIORITY_LABEL[value as Priority] ?? value;
  if (field === 'due_at') {
    const at = new Date(value);
    if (!Number.isNaN(at.getTime())) return at.toLocaleDateString('tr-TR');
  }
  return value.length <= 48 ? value : `${value.slice(0, 47)}…`;
}

/**
 * Arşivi gerçek bir .xlsx olarak indirt.
 *
 * İlk sürüm BOM'lu CSV'ydi ve sahibi sonucu gördü: sütunlar taşıyor, hücre içi satır sonları
 * satırları kaydırıyor, "yazılar iç içe". CSV'nin nasıl açılacağı Excel'in yerel ayarına kalıyor;
 * .xlsx'te hücre hücredir ve sütun genişliği dosyanın içinde yazar. Yazıcı `xlsx.ts`'te.
 */
function excelExport(rows: Task[]): void {
  downloadXlsx(
    `is-arsivi-${new Date().toISOString().slice(0, 10)}.xlsx`,
    'İş arşivi',
    ['İş', 'Açıklama', 'Durum', 'Öncelik', 'Atanan', 'Bitirilme', 'Son tarih', 'Etiketler'],
    rows.map((task) => [
      task.body,
      task.description ?? '',
      STATUS_LABEL[task.status],
      PRIORITY_LABEL[task.priority],
      task.assigneeUsername ?? 'Atanmamış',
      task.doneAt === null ? '' : new Date(task.doneAt).toLocaleString('tr-TR'),
      task.dueAt === null || task.dueAt === undefined
        ? ''
        : new Date(task.dueAt).toLocaleDateString('tr-TR'),
      (task.tags ?? []).map((tag) => tag.name).join(', '),
    ]),
    [42, 48, 13, 10, 14, 17, 12, 20],
  );
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
 * where a task for that person is added.
 *
 * `users` is `null` only until the first poll answers. It used to also be `null` for every
 * ordinary member, because the names came from the administrators-only `/users`: a member saw a
 * board with exactly one column they could add to — their own — and a colleague appeared only
 * after somebody else had already assigned them something. `/directory/users` is open to any
 * session and returns a name and an id, which is what a picker needs and all it needs.
 *
 * Someone who appears ONLY as an assignee still gets a column without an input: an account that
 * has since been removed can still own rows on the board, and the board says so rather than
 * hiding the work.
 */
function people(tasks: Task[], me: CurrentUser, users: Account[] | null): Person[] {
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

/**
 * Bir işin parça sayacı, PANONUN KENDİSİNDEN türetilerek.
 *
 * Sayılar sunucudan yalnız `GET /tasks` ile geliyordu ve pano her değişiklikte yeniden
 * okunmuyor: tek parçası silinen iş "⑂ 0/1" göstermeye devam ediyor, sonra o işi silmek isteyen
 * kişiye "1 parçası da silinecek" diye VAR OLMAYAN bir parça için onay soruluyordu. Bir parça ✓
 * ile kapandığında da üstün sayacı değişmiyordu.
 *
 * Kaynak `tasks`, ekrandaki süzülmüş liste değil: etiket süzgeci parçaları gizleyebilir ve gizli
 * bir parça yok olmuş bir parça değildir. `list()` bütün kiracı işlerini sınırsız döndürdüğü için
 * parçalar her zaman bu dizinin içinde.
 */
export function subtaskCounts(tasks: Task[], parentId: string): { done: number; total: number } {
  const parts = tasks.filter((task) => task.parentId === parentId);
  return { done: parts.filter(closed).length, total: parts.length };
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
  users: Account[] | null;
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
  /** Pano, takvim, arşiv ya da günlük. Arşiv: kapanmış işler panodan buraya taşınır. */
  const [view, setView] = useState<'board' | 'calendar' | 'archive' | 'log'>('board');
  /** Takvimde bakılan haftanın pazartesisi. Bugünün haftasıyla açılıyor. */
  const [week, setWeek] = useState(() => weekStart(new Date()));
  const [log, setLog] = useState<LogEntry[] | null>(null);
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
      description?: string | null;
    },
    failure: string,
    /** Sunucu kabul etti mi — reddedilen bir düzenlemeyi ekrandan geri alabilmek için. */
  ): Promise<boolean> {
    setBusy(true);
    const { data, error } = await api.PATCH('/tasks/{id}', {
      params: { path: { id: task.id } },
      body: patch,
    });
    setBusy(false);
    if (error !== undefined || data === undefined) {
      notify('error', problemMessage(error, failure));
      return false;
    }
    const saved = data;
    setTasks((current) =>
      current === null ? current : current.map((item) => (item.id === saved.id ? saved : item)),
    );
    return true;
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

  // Günlük yalnız açıldığında okunuyor: 300 satırlık bir listeyi panoya her girişte çekmek,
  // kimsenin bakmadığı bir sekme için istek demek.
  useEffect(() => {
    if (view !== 'log') return;
    let alive = true;
    void (async () => {
      const { data } = await api.GET('/tasks/log', {});
      if (!alive) return;
      if (data === undefined) {
        notify('error', 'Günlük okunamadı.');
        return;
      }
      setLog(data.items);
    })();
    return () => {
      alive = false;
    };
  }, [view, reloadKey, notify]);

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
    // Üstün rozeti burada elle artırılmıyor: sayaç artık `subtaskCounts` ile listenin kendisinden
    // türetiliyor, ve yeni parça bu listeye giriyor. Elle artırmak yalnız EKLEMEYİ sayıyordu —
    // silme ve kapanma sayacı olduğu yerde bırakıyordu.
    setTasks((current) => (current === null ? [created] : [...current, created]));
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
    // Sayı ekrandaki listeden okunuyor: `task.subtaskTotal` sunucunun son `GET /tasks`teki hâli
    // ve tek parçası silinmiş bir iş için hâlâ 1 diyor — var olmayan bir parça için onay sormak,
    // onay kutusunu değersizleştiriyor.
    const parts = tasks === null ? 0 : subtaskCounts(tasks, task.id).total;
    if (parts > 0 && !window.confirm(`Bu işin ${parts} parçası da silinecek. Devam edilsin mi?`)) {
      return;
    }
    setBusy(true);
    const { error, response } = await api.DELETE('/tasks/{id}', {
      params: { path: { id: task.id } },
    });
    setBusy(false);
    if (error !== undefined) {
      // 403 TÜRKÇE SÖYLENİYOR. Sunucu silmeyi işi açana, atanana ve yöneticiye açıyor; reddi
      // olduğu gibi geçirmek Türkçe bir ürüne "only the person who created a task, its assignee,
      // or an administrator may delete it" cümlesini basmak demekti. Düğmenin kime çizileceğini
      // istemci bilemiyor: sözleşmedeki `Task` şemasında işi kimin açtığı yok.
      notify(
        'error',
        response.status === 403
          ? 'Bir işi yalnız onu açan kişi, işin atandığı kişi ya da bir yönetici silebilir.'
          : problemMessage(error, 'İş silinemedi.'),
      );
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
  // KAPANMIŞ İŞLER PANODA DEĞİL, ARŞİVDE. Eskiden sütunun dibinde duruyorlardı; sahibi arşiv
  // istedi ve haklıydı: biten iş panonun konusu değil, geçmişin konusu. Sayı yine başlıkta —
  // "bugün neyi bitirdik" sorusunun cevabı bir sekme ötede ve kaç olduğu buradan okunuyor.
  const archived = order(shown.filter(closed)).sort((a, b) =>
    (b.doneAt ?? b.updatedAt).localeCompare(a.doneAt ?? a.updatedAt),
  );
  const groups: Group[] = [
    ...persons,
    // Always last, and always present: "birinin yapması lazım" is a state the board has to be
    // able to express, and the endpoint accepts a null assignee for exactly that.
    { id: null, name: 'Atanmamış', canAdd: true },
  ].map((person) => {
    const items = order(shown.filter((task) => task.assigneeId === person.id && !closed(task)));
    return {
      ...person,
      key: person.id ?? NOBODY,
      tone: person.id === null ? 'dim' : toneFor(person.name),
      items,
      done: shown.filter((task) => task.assigneeId === person.id && closed(task)).length,
    };
  });

  // Options for the per-task assignee picker. A member cannot list accounts, so the only moves
  // offered are onto their own name or off it — anything else would be a select full of names
  // this client had to invent.
  const assignable: Person[] =
    users === null
      ? [{ id: me.id, name: me.username, canAdd: true }]
      : users.map((user) => ({ id: user.id, name: user.username, canAdd: true }));

  // ŞERİT ARŞİVDE DE ÇİZİLİYOR. Aynı `filter` iki listeyi birden daraltıyor ama şerit yalnız
  // panoda duruyordu: "acil"i seçip Arşiv'e geçen kullanıcı, kırk bitmiş işin neden görünmediğini
  // hiçbir yerden okuyamıyor ve süzgeci kaldıramıyordu — sekme sayacı, "Arşiv boş" cümlesi ve
  // Excel düğmesinin kapalılığı da o süzülmüş listeden geliyor. Süzgeci arşivde YOK SAYMAK ise
  // Excel çıktısını sessizce süzgeçsizleştirirdi.
  const tagBar = (
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
  );

  return (
    <>
      <div className="jviews" role="tablist" aria-label="Pano görünümü">
        <button
          type="button"
          className={view === 'board' ? 'mk on' : 'mk'}
          role="tab"
          aria-selected={view === 'board'}
          onClick={() => setView('board')}
        >
          Pano
        </button>
        {/* §7'nin istediği takvim görünümü. Son tarihler yalnız tek tek kartların üstünde
            yazıyordu: "bu hafta hangi işlerin süresi doluyor" sorusunu hiçbir ekran güne göre
            dizmiyordu. Yeni bir uç gerekmiyor — pano bütün işleri zaten tek çağrıda getiriyor. */}
        <button
          type="button"
          className={view === 'calendar' ? 'mk on' : 'mk'}
          role="tab"
          aria-selected={view === 'calendar'}
          onClick={() => setView('calendar')}
        >
          Takvim
        </button>
        <button
          type="button"
          className={view === 'archive' ? 'mk on' : 'mk'}
          role="tab"
          aria-selected={view === 'archive'}
          onClick={() => setView('archive')}
        >
          Arşiv{archived.length > 0 ? ` (${archived.length})` : ''}
        </button>
        <button
          type="button"
          className={view === 'log' ? 'mk on' : 'mk'}
          role="tab"
          aria-selected={view === 'log'}
          onClick={() => setView('log')}
        >
          Günlük
        </button>
      </div>

      {view === 'log' && (
        <>
          <div className="note">
            Panonun bütün izi: kim, neyi, ne zaman değiştirdi. Son 300 kayıt.
          </div>
          {log === null && <p className="note">Günlük okunuyor…</p>}
          {log !== null && log.length === 0 && <Empty glyph="📜" text="Henüz kayıt yok." />}
          {(log ?? []).map((entry) => (
            <div className="lgrow" key={entry.id}>
              <span className="s">{new Date(entry.at).toLocaleString('tr-TR')}</span>
              <b>{entry.actorUsername ?? 'Silinmiş hesap'}</b>
              <span className="tx">
                “{entry.taskBody.length <= 60 ? entry.taskBody : `${entry.taskBody.slice(0, 59)}…`}”
                işinin {FIELD_LABEL[entry.field] ?? entry.field}
                {entry.field === 'tag' || entry.field === 'checklist' || entry.field === 'file_link'
                  ? ` değişti: ${logValue(entry.field, entry.newValue ?? entry.oldValue ?? null)}`
                  : `: ${logValue(entry.field, entry.oldValue ?? null)} → ${logValue(entry.field, entry.newValue ?? null)}`}
              </span>
            </div>
          ))}
        </>
      )}

      {view === 'calendar' && (
        <>
          {tagBar}
          <div className="netrow">
            <button
              type="button"
              className="b"
              aria-label="Önceki hafta"
              onClick={() =>
                setWeek((at) => new Date(at.getFullYear(), at.getMonth(), at.getDate() - 7))
              }
            >
              ‹
            </button>
            <span className="lbl">
              {weekDays(week)[0]?.toLocaleDateString('tr-TR')} –{' '}
              {weekDays(week)[6]?.toLocaleDateString('tr-TR')}
            </span>
            <button
              type="button"
              className="b"
              onClick={() => setWeek(weekStart(new Date()))}
              disabled={week.getTime() === weekStart(new Date()).getTime()}
            >
              Bu hafta
            </button>
            <button
              type="button"
              className="b"
              aria-label="Sonraki hafta"
              onClick={() =>
                setWeek((at) => new Date(at.getFullYear(), at.getMonth(), at.getDate() + 7))
              }
            >
              ›
            </button>
          </div>

          {/* GECİKMİŞLER HAFTADAN BAĞIMSIZ. Son tarihi geçmiş bir iş, hangi haftaya bakılıyor
              olursa olsun bugünün sorunudur; onu kendi haftasının hücresinde bırakmak, takvimi
              açan kişinin görmesi gereken tek şeyi geçmişe gömerdi. */}
          {shown.filter(overdue).length > 0 && (
            <div className="notice error" role="status">
              <span className="ic" aria-hidden>
                !
              </span>
              <span className="tx">
                <b>Gecikmiş {shown.filter(overdue).length} iş</b>
                {shown
                  .filter(overdue)
                  .map((task) => task.body)
                  .join(' · ')}
              </span>
            </div>
          )}

          <div className="cal">
            {weekDays(week).map((day) => {
              const items = tasksDueOn(shown, day);
              const today = midnight(day) === midnight(new Date());
              return (
                <div className={today ? 'calday now' : 'calday'} key={day.getTime()}>
                  <div className="calhd">
                    <b>{day.toLocaleDateString('tr-TR', { weekday: 'short' })}</b>
                    <span className="s">{day.getDate()}</span>
                  </div>
                  {items.length === 0 ? (
                    <span className="calnone">—</span>
                  ) : (
                    items.map((task) => (
                      <div className="calit" key={task.id} title={task.body}>
                        <span className="tx">{task.body}</span>
                        <span className="s">{task.assigneeUsername ?? 'Atanmamış'}</span>
                        {PRIORITY_TONE[task.priority] !== undefined && (
                          <span className={PRIORITY_TONE[task.priority]}>
                            {PRIORITY_LABEL[task.priority]}
                          </span>
                        )}
                      </div>
                    ))
                  )}
                </div>
              );
            })}
          </div>

          <div className="note">
            Yalnız son tarihi olan ve henüz kapanmamış işler. Bir işi buradan değiştirmek için
            <b> Pano</b>ya geçin.
          </div>
        </>
      )}

      {view === 'archive' && (
        <>
          {tagBar}
          {filter.length > 0 && (
            <div className="note">
              Bu liste {filter.length} etiketle süzülü — süzgeci yukarıdaki şeritten kaldırın.
            </div>
          )}
          <div className="jviews" style={{ justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="b"
              disabled={archived.length === 0}
              onClick={() => excelExport(archived)}
            >
              Excel&apos;e aktar
            </button>
          </div>
          {archived.length === 0 && <Empty glyph="🗄" text="Arşiv boş — henüz bitmiş iş yok." />}
          {archived.map((task) => (
            <div className="jitem done arch" key={task.id}>
              <span className="tx">{task.body}</span>
              {/* Durum kutusu ARŞİVDE DE var, ve olmaması bir eksiklikti: durum makinesinin iki
                  yasaklı geçişi de KAPALI bir durumdan başlıyor (`done → cancelled`,
                  `cancelled → in_progress`). Kapanan iş panodan arşive taşınınca o geçişleri
                  deneyecek bir kontrol hiçbir ekranda kalmamıştı — yani kural yerinde duruyor
                  ama kimse ona dokunamıyor, ve reddin kullanıcıya ulaştığı da bir daha
                  ölçülemiyordu. Yanlışlıkla iptal edilmiş bir işi düzeltmenin yeri de burası. */}
              <select
                value={task.status}
                disabled={busy}
                aria-label="Durum"
                style={{ fontSize: 11, padding: '3px 6px', borderRadius: 7 }}
                onChange={(event) => {
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
              <span className="pill dim">{task.assigneeUsername ?? 'Atanmamış'}</span>
              {task.doneAt !== null && (
                <span className="pill dim">
                  {new Date(task.doneAt).toLocaleDateString('tr-TR')}
                </span>
              )}
              <button
                type="button"
                className="b"
                disabled={busy}
                title="İşi panoya geri al"
                onClick={() => void update(task, { done: false }, 'İş geri alınamadı.')}
              >
                Geri al
              </button>
              <button
                type="button"
                className="del"
                disabled={busy}
                aria-label={`"${task.body}" işini sil`}
                onClick={() => void remove(task)}
              >
                ✕
              </button>
            </div>
          ))}
        </>
      )}

      {view === 'board' && (
        <>
          <div className="note">
            Bu pano herkese açıktır: bir iş birine atanır ve göremediği bir iş atanmış sayılmaz.
            Bitenler Arşiv sekmesine taşınır.
          </div>

          {tagBar}

          <div className="jobs">
            {groups.map((group) => (
              <div className="jper" key={group.key}>
                <div className="jhead">
                  <Glyph tone={group.tone} size={26}>
                    {group.name.slice(0, 1).toUpperCase()}
                  </Glyph>
                  <b>{group.name}</b>
                  <span className="cnt">
                    {group.items.length} açık{group.done > 0 ? ` · ${group.done} arşivde` : ''}
                  </span>
                </div>

                {group.items.map((task) => {
                  const done = task.doneAt !== null;
                  const due = dueLabel(task.dueAt);
                  const parts = subtaskCounts(tasks, task.id);
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
                            // Düğüm yerel bir değişkende: `currentTarget` olay işlendikten sonra
                            // boşalıyor ve aşağıdaki dal yanıtı bekliyor.
                            const node = event.currentTarget;
                            const next = (node.textContent ?? '').trim();
                            if (next === task.body) return;
                            if (next === '') {
                              // Emptying the text is not how a task is deleted; the ✕ is.
                              node.textContent = task.body;
                              return;
                            }
                            void (async () => {
                              const saved = await update(
                                task,
                                { body: next },
                                'İş metni kaydedilemedi.',
                              );
                              // REDDEDİLEN METNİ EKRANDAN GERİ AL. Yukarıdaki `key` yalnız sunucu
                              // yeni bir `updatedAt` verdiğinde değişiyor; hata yolunda `tasks`
                              // değişmediği için React bu contenteditable düğüme hiç dokunmuyor
                              // ve 422 alan 2001 karakterlik metin ekranda kaydedilmiş gibi
                              // duruyordu — toast söndükten sonra bunu söyleyen hiçbir şey yok.
                              if (!saved) node.textContent = task.body;
                            })();
                          }}
                        >
                          {task.body}
                        </span>

                        <select
                          value={task.assigneeId ?? ''}
                          disabled={busy}
                          aria-label="Atanan kişi"
                          style={{
                            fontSize: 11,
                            padding: '3px 6px',
                            borderRadius: 7,
                            maxWidth: 130,
                          }}
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
                                  dueAt:
                                    day === '' ? null : new Date(`${day}T23:59:59`).toISOString(),
                                },
                                'Son tarih değiştirilemedi.',
                              );
                            }}
                            style={{
                              fontSize: 11,
                              padding: '2px 4px',
                              borderRadius: 6,
                              width: 122,
                            }}
                          />
                          {due !== null && (
                            <span className={due.late ? 'pill bad' : 'pill dim'}>{due.text}</span>
                          )}
                        </label>

                        {/* Parça ve madde ilerlemesi. İkisi de yalnız VARSA çiziliyor: her satırda
                      "0/0" duran bir rozet, göz için hiçbir şey söylemeyen bir şey. */}
                        {parts.total > 0 && (
                          <span className="pill dim" title="Parçalar">
                            ⑂ {parts.done}/{parts.total}
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
                          description={task.description}
                          onDescription={(text) =>
                            void update(task, { description: text }, 'Açıklama kaydedilemedi.')
                          }
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
                    {/* Mobil klavyelerin çoğu Enter'ı form gönderimi olarak vermiyor; sahada işler
                    telefondan hiç eklenemedi. Düğme her zaman var, Enter da çalışmaya devam
                    ediyor. */}
                    <button
                      type="button"
                      className="b"
                      aria-label="İşi ekle"
                      onClick={() => void add(group)}
                    >
                      Ekle
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
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
