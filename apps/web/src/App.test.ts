import { describe, expect, it } from 'vitest';

import { rebootRefused } from './App.js';

/** `api.ts`'in düşen bir bağlantı için ürettiği gövde — burada yalnız "dolu" olması önemli. */
const dropped = { title: 'Sunucuya ulaşılamadı', code: 'transport-failure' };

/**
 * Yeniden başlatma düğmesinin ne zaman hata yazacağı.
 *
 * BU TESTİN VAR OLMA NEDENİ tek bir dal: cevapsız kalan bir istek başarısızlık değil. Ajan
 * `systemctl reboot`'u bırakıp dönüyor ve systemd nginx'i cevap tarayıcıya varmadan
 * durdurabiliyor; ekran bir zamanlar bunu "Cihaz yeniden başlatılamadı" diye yazıyordu — tam da
 * kapanmakta olan bir cihaz için, ve sahibi düğmeye ikinci kez basmaya çalışıyordu.
 */
describe('rebootRefused', () => {
  it('does not call a dropped connection a failed reboot', () => {
    expect(rebootRefused(dropped, true)).toBe(false);
  });

  it('still reports a refusal the server actually answered with', () => {
    // 403 ya da 503: cevap geldi, ve hiçbir şey başlamadı. Bunu sessizce "başlıyor" göstermek,
    // çalışmayan bir düğmeyi çalışıyor gibi göstermek olurdu.
    expect(rebootRefused({ title: 'Yetkiniz yok' }, false)).toBe(true);
  });

  it('says nothing went wrong when the server accepted the request', () => {
    expect(rebootRefused(undefined, false)).toBe(false);
  });
});
