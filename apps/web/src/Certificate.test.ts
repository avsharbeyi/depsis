import { describe, expect, it } from 'vitest';

import { certificateBadge } from './Certificate.js';

/**
 * Sertifika rozetinin ne dediği.
 *
 * BU TESTİN VAR OLMA NEDENİ tek bir dal: okuma BAŞARISIZ olduğunda rozet "okunuyor…" demiyor.
 * Panel bir zamanlar ikisini de `status === null` ile çiziyordu, ve ajan çalışmayan bir kutuda
 * ekran sonsuza dek yükleniyor görünüyordu — parmak izini karşılaştırmaya gelen kişi neyin
 * yanlış olduğunu hiçbir yerde göremiyordu.
 */
describe('certificateBadge', () => {
  it('says it could not read rather than still reading, once the read has failed', () => {
    expect(certificateBadge(null, false, 'depolama ajanına ulaşılamıyor')).toBe('okunamadı');
  });

  it('keeps saying "okunamadı" even if a stale status is still on screen', () => {
    // Hata, elde kalan eski cevabı geçersiz kılar: ekranda duran parmak izinin hâlâ doğru
    // olduğunu söyleyen bir rozet, karşılaştırmayı yanlış yaptırırdı.
    const stale = { fingerprint: 'AA:BB', selfSigned: false };
    expect(certificateBadge(stale, false, 'okunamadı')).toBe('okunamadı');
  });

  it('is loading only while the first read is still out', () => {
    expect(certificateBadge(null, true, null)).toBe('okunuyor');
  });

  it('separates a box with no readable certificate from a box that was never asked', () => {
    expect(certificateBadge({ fingerprint: '', selfSigned: false }, false, null)).toBe(
      'sertifika yok',
    );
  });

  it('tells a self-signed certificate from one a real authority signed', () => {
    expect(certificateBadge({ fingerprint: 'AA:BB', selfSigned: true }, false, null)).toBe(
      'kendinden',
    );
    expect(certificateBadge({ fingerprint: 'AA:BB', selfSigned: false }, false, null)).toBe(
      'güvenli',
    );
  });
});
