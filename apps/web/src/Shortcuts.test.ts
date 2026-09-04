import { describe, expect, it } from 'vitest';

import { nextFreeCell, visiblePlacement } from './Shortcuts.js';

/** Televizyon: on sütun, üç satır. Telefon: üç sütun, iki satır. */
const tv = { cols: 10, rows: 3 };
const phone = { cols: 3, rows: 2 };

/**
 * Kaydedilmiş düzenin ekrandaki ızgaraya katlanması.
 *
 * BU TESTİN VAR OLMA NEDENİ dar ekran. Düzen sunucuda hücre indeksi olarak duruyor ve ızgara
 * ekrana göre ölçülüyor; televizyonda 25. hücreye konan bir kısayol telefonda alanın yüzlerce
 * piksel altına düşüyor, kaydırılınca Depolama ve Sistem kartlarının üstünde çiziliyordu.
 */
describe('visiblePlacement', () => {
  it('leaves a layout that fits exactly where it was put', () => {
    // Televizyonda hiçbir şey değişmiyor: 25. hücre 25. hücrede kalıyor.
    const shown = visiblePlacement([{ id: 'files', cell: 25 }], tv);
    expect(shown.get('files')).toBe(25);
  });

  it('folds a cell that would be drawn outside the field into the grid', () => {
    const shown = visiblePlacement([{ id: 'files', cell: 25 }], phone);
    const cell = shown.get('files');
    expect(cell).not.toBeUndefined();
    // Izgaranın içinde: üç sütun, iki satır — altı hücre.
    expect(cell).toBeLessThan(phone.cols * phone.rows);
  });

  it('does not move the icons that already fit in order to make room', () => {
    const shown = visiblePlacement(
      [
        { id: 'files', cell: 0 },
        { id: 'tasks', cell: 25 },
      ],
      phone,
    );
    expect(shown.get('files')).toBe(0);
    // Taşan simge ilk BOŞ hücreye gidiyor, dolu olanı itmiyor.
    expect(shown.get('tasks')).toBe(1);
  });

  it('keeps the saved order among the icons it had to fold', () => {
    const shown = visiblePlacement(
      [
        { id: 'tasks', cell: 29 },
        { id: 'files', cell: 25 },
      ],
      phone,
    );
    expect(shown.get('files')).toBe(0);
    expect(shown.get('tasks')).toBe(1);
  });

  it('separates two icons saved onto the same cell instead of stacking them', () => {
    // Üst üste binmiş iki simgenin alttakine ulaşmanın yolu yok.
    const shown = visiblePlacement(
      [
        { id: 'files', cell: 4 },
        { id: 'tasks', cell: 4 },
      ],
      tv,
    );
    expect(shown.get('files')).toBe(4);
    expect(shown.get('tasks')).toBe(0);
  });
});

/**
 * Yeni bir kısayolun hangi hücreye yazılacağı.
 *
 * BU TESTİN VAR OLMA NEDENİ: arama ileri doğru sınırsız yürüyordu ve ızgaranın dışına bir hücre
 * KAYDEDİYORDU — kaydedilen şey kalıcı, ve o hücre bir daha hiçbir ekranda görünmüyordu.
 */
describe('nextFreeCell', () => {
  it('uses the clicked cell when it is free', () => {
    expect(nextFreeCell(new Set(), 4, 6)).toBe(4);
  });

  it('wraps inside the grid rather than walking off the bottom of it', () => {
    expect(nextFreeCell(new Set([4, 5]), 4, 6)).toBe(0);
  });

  it('only leaves the grid when there is genuinely no cell left in it', () => {
    // Alan `flex: 1` ile büyüyor, yani bu satır bir sonraki ölçümde ızgaranın içine giriyor;
    // hiçbir şey eklememek ise sessizce çalışmayan bir menü olurdu.
    expect(nextFreeCell(new Set([0, 1, 2, 3, 4, 5]), 2, 6)).toBe(6);
  });
});
