import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedRequest } from '../auth/session.guard.js';
import { ProblemException } from '../common/problem.filter.js';
import { TrashPolicyController } from './trash-policy.controller.js';
import type { TrashRetentionService } from './trash-retention.service.js';

/**
 * Çöp kutusu politikasının FİYATLANDIRMA ucu.
 *
 * Burada ölçülen şey `days`in nereye gittiği: doğrudan `impact` sorgusuna, yani
 * `now() - make_interval(days => $2::int)` ifadesine. Postgres orada iki ayrı yerde patlıyor —
 * `int` taşması ve "timestamp out of range" — ve ikisi de eşlenmemiş bir veritabanı hatası olarak
 * 500 dönüyordu. Bir yöneticinin yazdığı sayının çok büyük olduğunu söylemek, ucun kendi işi;
 * sayı sorguya HİÇ ULAŞMAMALI.
 */

function request(): AuthenticatedRequest {
  return {
    depsis: { userId: 'u-1', organizationId: 'o-1', role: 'admin' },
    headers: {},
  } as unknown as AuthenticatedRequest;
}

function controller(): {
  route: TrashPolicyController;
  impact: ReturnType<typeof vi.fn>;
} {
  const impact = vi.fn(() =>
    Promise.resolve({ entries: 0, files: 0, bytes: 0, oldestTrashedAt: null }),
  );
  const retention = {
    policy: () => Promise.resolve({ retentionDays: 30, updatedAt: null }),
    impact,
  } as unknown as TrashRetentionService;
  const audit = { record: () => Promise.resolve() } as unknown as AuditService;
  return { route: new TrashPolicyController(retention, audit), impact };
}

describe('GET /system/trash-policy?days=', () => {
  it('prices a day count inside the range', async () => {
    const { route, impact } = controller();

    await route.read(request(), '3650');

    expect(impact).toHaveBeenCalledWith('o-1', 3650);
  });

  it('refuses a day count above the ceiling instead of letting the interval overflow', async () => {
    // `2147483648` `int`i taşırıyor, `99999999` ise `now()`a eklenince zaman damgasının aralığını
    // aşıyor. İkisi de kullanıcının yazabileceği sayılar, ve ikisi de bugün 500 üretiyordu.
    for (const days of ['3651', '99999999', '2147483648']) {
      const { route, impact } = controller();

      await expect(route.read(request(), days)).rejects.toBeInstanceOf(ProblemException);
      expect(impact).not.toHaveBeenCalled();
    }
  });

  it('still refuses zero and a value that is not a number', async () => {
    for (const days of ['0', '-5', 'abc']) {
      const { route, impact } = controller();

      await expect(route.read(request(), days)).rejects.toBeInstanceOf(ProblemException);
      expect(impact).not.toHaveBeenCalled();
    }
  });
});
