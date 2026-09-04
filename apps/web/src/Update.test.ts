import { describe, expect, it } from 'vitest';

import { readFailure } from './Update.js';

/**
 * Cevapsız kalan bir okumanın teşhisi.
 *
 * BU TESTİN VAR OLMA NEDENİ 503. Panel bir zamanlar 403 dışındaki HER başarısız okumayı "Cihaz
 * yeniden başlıyor…" diye gösteriyor ve üç saniyede bir yeniden soruyordu; ajanı çökmüş bir
 * kutuda API ayakta olmasına rağmen ekran saatlerce yeniden başlamayı bekliyordu. Sahibi cihazın
 * kendini toparlamasını bekleyip terminale inmekten başka bir yol bulamıyordu.
 */
describe('readFailure', () => {
  it('does not call an answered refusal a restart', () => {
    // 503: "depolama ajanına ulaşılamıyor". API cevap verdi — cihaz yeniden başlamıyor.
    expect(readFailure(503, false)).toBe('refused');
    expect(readFailure(500, false)).toBe('refused');
  });

  it('calls a dropped connection a restart, which is what an update looks like', () => {
    expect(readFailure(504, true)).toBe('unreachable');
    expect(readFailure(502, false)).toBe('unreachable');
  });

  it('leaves an expired session to the sign-in path instead of claiming a restart', () => {
    // 401 iken "Cihaz yeniden başlıyor…" demek, oturumu kapanmış kullanıcıya var olmayan bir
    // arıza anlatmak ve kapanmış oturumu üç saniyede bir yeniden sormaktı.
    expect(readFailure(401, false)).toBe('signed-out');
  });

  it('trusts the transport marker over the bare status, so a proxy 504 is not a restart', () => {
    expect(readFailure(504, false)).toBe('refused');
  });
});
