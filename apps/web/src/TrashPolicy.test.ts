import { describe, expect, it } from 'vitest';

import { trashSaveAction, type SaveAction } from './TrashPolicy.js';

type Priced = { days: number | null; entries: number } | null;

/** Değişmiş, kaydedilmemiş bir seçim — testlerin tamamının ortak başlangıcı. */
function chose(considering: number | null, priced: Priced): SaveAction {
  return trashSaveAction({ busy: false, changed: true, considering, priced });
}

/**
 * Kaydet düğmesinin kararı.
 *
 * BU TESTİN VAR OLMA NEDENİ tek bir dal: fiyatı olmayan bir seçim kaydedilemez. Düğme eskiden
 * seçim değişir değişmez açılıyor, önizleme ise 200 ms sonra geliyordu; aradaki boşlukta ekranda
 * "Süresiz"in sıfırı duruyor ve Kaydet, onay kutusunu ATLAYARAK kalıcı silmeyi başlatıyordu.
 * Sunucu politikayı alır almaz süpürücüyü çalıştırdığı için sonuç geri alınamıyor.
 */
describe('trashSaveAction', () => {
  it('refuses to save a period nobody has priced yet', () => {
    expect(chose(7, null)).toBe('blocked');
  });

  it('refuses while the number on screen belongs to the PREVIOUS choice', () => {
    // "Süresiz"in sıfırı ekranda dururken 7 güne geçen biri: eski fiyat 0 olduğu için onay
    // kutusu çıkmıyor, ve çöpteki her şey tek tuşla gidiyordu.
    expect(chose(7, { days: null, entries: 0 })).toBe('blocked');
    expect(chose(7, { days: 30, entries: 4 })).toBe('blocked');
  });

  it('asks for confirmation when the priced choice really would delete something', () => {
    expect(chose(7, { days: 7, entries: 12 })).toBe('confirm');
  });

  it('saves without a confirmation box when nothing would go', () => {
    expect(chose(7, { days: 7, entries: 0 })).toBe('save');
    // "Süresiz"e dönmek hiçbir şey silmiyor; onay istemek, tehlikesiz olanı tehlikeli göstermek
    // ve onay kutusunu değersizleştirmek olurdu.
    expect(chose(null, { days: null, entries: 9 })).toBe('save');
  });

  it('stays blocked while nothing changed or a save is already out', () => {
    const priced = { days: 7, entries: 12 };
    const unchanged = trashSaveAction({ busy: false, changed: false, considering: 7, priced });
    const saving = trashSaveAction({ busy: true, changed: true, considering: 7, priced });
    expect(unchanged).toBe('blocked');
    expect(saving).toBe('blocked');
  });
});
