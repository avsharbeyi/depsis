import { describe, expect, it } from 'vitest';

import { telemetryNoteFor } from './snapshot.js';

/**
 * Masanın altındaki teşhis cümlesi.
 *
 * BU TESTİN VAR OLMA NEDENİ: `api.ts` düşen bir bağlantıyı fırlatmıyor, taşıma işaretli bir
 * cevaba çeviriyor — yani yoklamanın `catch` dalı hiç çalışmıyordu ve "son bilinen durum
 * gösteriliyor" sözü bir kez bile tutulmamıştı. API beş saniye yeniden başlarken Depolama ve
 * Sistem kartları "Sistem durumu okunamadı." uyarısına dönüyor, halka ve havuz satırları
 * siliniyordu; oysa on saniye önceki gerçek rakamlar elde duruyor.
 */
describe('telemetryNoteFor', () => {
  const dropped = { status: 504, transportFailure: true, read: false };

  it('says the server cannot be reached, not that the reading failed', () => {
    expect(telemetryNoteFor({ ...dropped, hadPrevious: true })).toBe(
      'Sunucuya ulaşılamıyor; son bilinen durum gösteriliyor.',
    );
  });

  it('does not promise a last known state on the very first poll', () => {
    // Gösterilmeyen bir şeyi gösteriyorum demek, ekranın söyleyebileceği en gereksiz yalan.
    expect(telemetryNoteFor({ ...dropped, hadPrevious: false })).toBe('Sunucuya ulaşılamıyor.');
  });

  it('keeps the two answered refusals apart from a lost connection', () => {
    expect(
      telemetryNoteFor({ status: 403, transportFailure: false, read: false, hadPrevious: true }),
    ).toBe('Sistem ayrıntıları yalnız cihazı kuran hesaba açık.');
    expect(
      telemetryNoteFor({ status: 503, transportFailure: false, read: false, hadPrevious: true }),
    ).toBe('Depolama ajanı yanıt vermiyor. Havuz henüz kurulmadıysa bu beklenen.');
  });

  it('still has a sentence for a server that answered something unreadable', () => {
    expect(
      telemetryNoteFor({ status: 500, transportFailure: false, read: false, hadPrevious: true }),
    ).toBe('Sistem durumu okunamadı.');
  });

  it('says nothing at all when the reading came through', () => {
    expect(
      telemetryNoteFor({ status: 200, transportFailure: false, read: true, hadPrevious: false }),
    ).toBeNull();
  });
});
