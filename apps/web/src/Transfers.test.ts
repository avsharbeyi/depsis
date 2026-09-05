import type { OpenApi } from '@depsis/contracts';
import { describe, expect, it } from 'vitest';

import { awaitingAnswer } from './Transfers.js';

type Transfer = OpenApi.components['schemas']['Transfer'];

const row = (over: Partial<Transfer>): Transfer => ({
  id: '01a0712b-8bc9-734c-8419-e57b1b57423d',
  filename: 'IMG_7451.jpeg',
  lengthBytes: 1000,
  offsetBytes: 1000,
  state: 'stalled',
  createdAt: '2026-09-05T13:00:00.000Z',
  updatedAt: '2026-09-05T13:00:00.000Z',
  ...over,
});

/**
 * "Baytlar tam, yayımlanmadı" ayrımı.
 *
 * Bu ayrım olmadan aktarım listesi o satıra yalnız "durdu" diyordu, ve sahada 20 dosya tam bu
 * hâlde asılı kaldı: baytların hepsi sunucudaydı, tek eksik kullanıcının cevabıydı, ve cevabı
 * soracak pencere sekmeyle birlikte kapanmıştı. Ayrım `completed_at`ten geliyor — ofset ile
 * yayım AYNI şey değil.
 */
describe('cevap bekleyen yükleme', () => {
  it('baytlar tam ama yayımlanmamışsa bekliyor', () => {
    expect(awaitingAnswer(row({ state: 'stalled', offsetBytes: 1000 }))).toBe(true);
    expect(awaitingAnswer(row({ state: 'active', offsetBytes: 1000 }))).toBe(true);
  });

  it('yayımlanmışsa beklemiyor', () => {
    expect(awaitingAnswer(row({ state: 'completed', offsetBytes: 1000 }))).toBe(false);
  });

  it('baytlar eksikse beklemiyor — o sadece yarım kalmış bir yükleme', () => {
    expect(awaitingAnswer(row({ state: 'stalled', offsetBytes: 400 }))).toBe(false);
    expect(awaitingAnswer(row({ state: 'stalled', offsetBytes: 0 }))).toBe(false);
  });

  it('boyutu bilinmeyen bir satırı bekliyor saymıyor', () => {
    expect(awaitingAnswer(row({ lengthBytes: 0, offsetBytes: 0 }))).toBe(false);
  });
});
