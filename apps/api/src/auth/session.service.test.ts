import { describe, expect, it } from 'vitest';

import type { DbService } from '../db/db.service.js';
import { SessionService } from './session.service.js';

/**
 * Oturumun ömrü, sayının kendisi olarak ölçülüyor.
 *
 * Sabitin adı bir şey ispat etmiyor: `LIFETIME_HOURS` özel, ve onu `24 * 7` yazmakla satıra
 * gerçekten bir hafta sonrasının yazılması ayrı iki şey. Sahibi "1 hafta falan" dedi ve bunun
 * sessizce on iki saate geri dönmesi, ancak bir sabah yeniden parola sorulduğunda anlaşılırdı.
 */
describe('oturumun ömrü', () => {
  it('bir hafta sonrasına yazıyor', async () => {
    let written: Date | null = null;
    const db = {
      withTenant: <T>(_organizationId: string, fn: (q: { query: typeof query }) => Promise<T>) =>
        fn({ query }),
    } as unknown as DbService;

    function query(_text: string, params?: readonly unknown[]): Promise<unknown[]> {
      // `expires_at` INSERT'ün altıncı parametresi; satırın kendisi de kimliği geri veriyor.
      const candidate = params?.[5];
      if (candidate instanceof Date) written = candidate;
      return Promise.resolve([{ id: '01a05922-662e-791f-835d-6fab720d9e5f' }]);
    }

    const before = Date.now();
    const issued = await new SessionService(db).issue('org', 'user', {
      userAgent: null,
      ip: null,
    });
    const after = Date.now();

    const week = 7 * 24 * 3_600_000;
    expect(written).not.toBeNull();
    expect(issued.expiresAt.getTime()).toBeGreaterThanOrEqual(before + week);
    expect(issued.expiresAt.getTime()).toBeLessThanOrEqual(after + week);
    // Satıra yazılan ile çağırana dönen aynı an: ikisi ayrışırsa çerez, satırın söylediğinden
    // başka bir gün ölür.
    expect(written === null ? null : (written as Date).getTime()).toBe(issued.expiresAt.getTime());
  });
});
