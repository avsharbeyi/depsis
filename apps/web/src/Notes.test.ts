import { describe, expect, it } from 'vitest';

import { afterFailedSave, type Pending } from './Notes.js';

const paragraph: Pending = { id: 'note-1', title: 'Toplantı', body: 'Uzun bir paragraf.' };

/**
 * Otomatik kaydın başarısız turu.
 *
 * BU TESTİN VAR OLMA NEDENİ: `flush` bekleyen metni istekten önce alıp kuyruğu boşaltıyor, ve hata
 * dalı onu bir zamanlar geri koymuyordu. API yeniden başlarken yazılan paragraf tek bir toast'la
 * geçiştiriliyor, kullanıcı başka bir nota tıkladığı anda ekrandan da siliniyordu — yeniden
 * denenecek hiçbir şey kalmadığı için.
 */
describe('afterFailedSave', () => {
  it('puts the unsaved text back so the next flush has something to send', () => {
    expect(afterFailedSave(paragraph, null)).toEqual(paragraph);
  });

  it('does not overwrite letters typed while the failed request was still out', () => {
    // Kuyruktaki metin daha yeni ve notun TAM hâlini taşıyor; eskisini üstüne yazmak, kullanıcının
    // bu arada yazdığı harfleri geri almak olurdu.
    const newer: Pending = { ...paragraph, body: 'Uzun bir paragraf. Ve bir cümle daha.' };
    expect(afterFailedSave(paragraph, newer)).toBe(newer);
  });
});
