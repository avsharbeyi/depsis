import type { OpenApi } from '@depsis/contracts';
import { describe, expect, it } from 'vitest';

import { dueLabel, subtaskCounts, tasksDueOn, weekDays, weekStart } from './Tasks.js';

type Task = OpenApi.components['schemas']['Task'];

/** Son tarih her zaman yerel 23:59:59'a sabitleniyor — formun kendi yaptığı şey. */
function endOfDay(year: number, month: number, day: number): string {
  return new Date(year, month - 1, day, 23, 59, 59).toISOString();
}

/**
 * Son tarih rozetinin ne dediği.
 *
 * BU TESTİN VAR OLMA NEDENİ yuvarlama. Fark mutlak zamandan `Math.round` ile okunuyordu ve son
 * tarih hiçbir zaman tam gün uzakta değil: bugün biten iş sabah "yarın" diyordu, dün biten iş ise
 * öğlene kadar "bugün" ve GECİKMEMİŞ görünüyordu — kırmızı rozet ve "gecikmişler en üstte" sırası
 * yarım gün geç geliyordu, yani hata yalnız günün belli saatlerinde kendini gösteriyordu.
 */
describe('dueLabel', () => {
  it('says "bugün" for a task due today, at nine in the morning', () => {
    const label = dueLabel(endOfDay(2026, 3, 12), new Date(2026, 2, 12, 9, 0, 0));
    expect(label).toEqual({ text: 'bugün', late: false });
  });

  it('calls yesterday late from the first minute of the new day, not from noon', () => {
    const label = dueLabel(endOfDay(2026, 3, 11), new Date(2026, 2, 12, 9, 0, 0));
    expect(label).toEqual({ text: '1 gün geçti', late: true });
  });

  it('still says "yarın" for tomorrow', () => {
    const label = dueLabel(endOfDay(2026, 3, 13), new Date(2026, 2, 12, 9, 0, 0));
    expect(label).toEqual({ text: 'yarın', late: false });
  });

  it('counts calendar days across a month boundary', () => {
    const label = dueLabel(endOfDay(2026, 3, 1), new Date(2026, 1, 26, 22, 0, 0));
    expect(label).toEqual({ text: '3 gün', late: false });
  });

  it('marks a deadline that has already passed within today', () => {
    // Son tarihi bugün 09:00 olan bir iş, saat 18:00'de: takvimde bugün, ama saat geçti.
    const at = new Date(2026, 2, 12, 9, 0, 0).toISOString();
    expect(dueLabel(at, new Date(2026, 2, 12, 18, 0, 0))).toEqual({ text: 'bugün', late: true });
  });

  it('draws nothing for a task with no deadline or an unreadable one', () => {
    expect(dueLabel(null)).toBeNull();
    expect(dueLabel(undefined)).toBeNull();
    expect(dueLabel('bir tarih değil')).toBeNull();
  });
});

/** Yalnız bu kararın okuduğu alanlar. */
function task(id: string, parentId: string | null, status: Task['status']): Task {
  return { id, parentId, status } as Task;
}

/**
 * Parça sayacı.
 *
 * BU TESTİN VAR OLMA NEDENİ: sayılar sunucudan yalnız `GET /tasks` ile geliyordu ve pano her
 * değişiklikte yeniden okunmuyor. Tek parçası silinen iş "⑂ 0/1" göstermeye devam ediyor, sonra o
 * işi silmek isteyene "1 parçası da silinecek" diye var olmayan bir parça için onay soruluyordu.
 */
describe('subtaskCounts', () => {
  it('counts the parts that are actually still on the board', () => {
    const rows = [
      task('parent', null, 'in_progress'),
      task('a', 'parent', 'in_progress'),
      task('b', 'parent', 'done'),
    ];
    expect(subtaskCounts(rows, 'parent')).toEqual({ done: 1, total: 2 });
  });

  it('drops to zero when the last part is deleted', () => {
    // Silinen parça listeden düşüyor; sayaç bayat kalırsa onay kutusu olmayan bir parçayı sayar.
    const rows = [task('parent', null, 'in_progress')];
    expect(subtaskCounts(rows, 'parent')).toEqual({ done: 0, total: 0 });
  });

  it('counts a cancelled part as closed, the way the board does everywhere else', () => {
    const rows = [task('parent', null, 'in_progress'), task('a', 'parent', 'cancelled')];
    expect(subtaskCounts(rows, 'parent')).toEqual({ done: 1, total: 1 });
  });

  it('does not count another task’s parts', () => {
    const rows = [task('a', 'başka', 'in_progress')];
    expect(subtaskCounts(rows, 'parent')).toEqual({ done: 0, total: 0 });
  });
});

/**
 * Takvim görünümünün haftası ve günleri.
 *
 * BU TESTİN VAR OLMA NEDENİ: §7 takvim görünümü istiyordu ve hiçbir ekran son tarihleri güne göre
 * dizmiyordu. Hafta pazartesiden başlıyor (`getDay()` pazarı 0 sayar) ve günler saat çıkarılarak
 * değil takvimden üretiliyor — yaz saatine geçilen hafta 23 saatlik bir gün taşır.
 */
describe('weekStart', () => {
  it('walks back to Monday from any day of the week', () => {
    // 2026-03-12 bir perşembe; haftanın pazartesisi 2026-03-09.
    expect(weekStart(new Date(2026, 2, 12, 15, 30)).getTime()).toBe(new Date(2026, 2, 9).getTime());
  });

  it('treats Sunday as the END of its week, not the start of the next one', () => {
    // 2026-03-15 pazar: pazartesi hâlâ 2026-03-09.
    expect(weekStart(new Date(2026, 2, 15, 23, 0)).getTime()).toBe(new Date(2026, 2, 9).getTime());
  });

  it('is already Monday when the day is Monday', () => {
    expect(weekStart(new Date(2026, 2, 9, 0, 1)).getTime()).toBe(new Date(2026, 2, 9).getTime());
  });
});

describe('weekDays', () => {
  it('gives seven consecutive local midnights and crosses the month boundary', () => {
    const days = weekDays(new Date(2026, 2, 30));
    expect(days).toHaveLength(7);
    expect(days[0]?.getTime()).toBe(new Date(2026, 2, 30).getTime());
    expect(days[6]?.getTime()).toBe(new Date(2026, 3, 5).getTime());
    for (const day of days) expect([day.getHours(), day.getMinutes()]).toEqual([0, 0]);
  });
});

/** Yalnız bu kararın okuduğu alanlar. */
function due(id: string, dueAt: string | null, status: Task['status']): Task {
  return { id, dueAt, status } as Task;
}

describe('tasksDueOn', () => {
  it('matches on the calendar day, not on the timestamp', () => {
    const rows = [due('a', endOfDay(2026, 3, 12), 'assigned')];
    expect(tasksDueOn(rows, new Date(2026, 2, 12, 9, 0)).map((task) => task.id)).toEqual(['a']);
    expect(tasksDueOn(rows, new Date(2026, 2, 13, 9, 0))).toEqual([]);
  });

  it('leaves out finished and cancelled work — a closed task has no deadline left', () => {
    const rows = [
      due('done', endOfDay(2026, 3, 12), 'done'),
      due('cancelled', endOfDay(2026, 3, 12), 'cancelled'),
      due('live', endOfDay(2026, 3, 12), 'in_progress'),
    ];
    expect(tasksDueOn(rows, new Date(2026, 2, 12)).map((task) => task.id)).toEqual(['live']);
  });

  it('ignores a task with no deadline or an unreadable one', () => {
    const rows = [due('none', null, 'assigned'), due('junk', 'bir tarih değil', 'assigned')];
    expect(tasksDueOn(rows, new Date(2026, 2, 12))).toEqual([]);
  });
});
