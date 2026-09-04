import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedRequest } from '../auth/session.guard.js';
import { BackupTargetController } from './backup-target.controller.js';
import type { BackupRunService } from './backup-run.service.js';
import type { BackupTargetService } from './backup-target.service.js';
import type { SystemService } from './system.service.js';

/**
 * Yedek gezgininin YOLU nasıl ayrıştırdığı.
 *
 * Ajanın `SafeComponent`i boşluğa karışmıyor: SMB'den 'Taslaklar ' (sonda boşluk) adlı bir klasör
 * yaratmak serbest, ve yedekte o adla duruyor. Bileşenleri kırpan bir ayrıştırıcı onu 'Taslaklar'
 * diye arıyor, ajan `not_found` diyor, ve gezgin BOŞ BİR LİSTE çiziyor — kullanıcı dosyalarının
 * yedekte olmadığını sanıyor. Aynı ayrıştırma geri getirme gövdesinde kırpılmıyordu, yani iki uç
 * birbirini yalanlıyordu.
 */

function request(): AuthenticatedRequest {
  return {
    depsis: { userId: 'u-1', organizationId: 'o-1', role: 'admin' },
    headers: {},
  } as unknown as AuthenticatedRequest;
}

function controller(): {
  controller: BackupTargetController;
  browse: ReturnType<typeof vi.fn>;
} {
  const browse = vi.fn().mockResolvedValue({ entries: [], truncated: false });
  const targets = { browse } as unknown as BackupTargetService;
  const system = {
    isSystemAdministrator: () => Promise.resolve(true),
  } as unknown as SystemService;
  return {
    controller: new BackupTargetController(
      targets,
      {} as unknown as BackupRunService,
      system,
      {} as unknown as AuditService,
    ),
    browse,
  };
}

describe('GET /backups/target/entries', () => {
  it('adın başındaki ve sonundaki boşluğu KORUYOR', async () => {
    // ASIL ÖLÇÜM. Kırpma, yedekte gerçekten var olan bir klasörü aranamaz hâle getiriyordu.
    const { controller: c, browse } = controller();

    await c.entries(request(), 'Dosyalar/Taslaklar ');

    expect(browse).toHaveBeenCalledTimes(1);
    expect(browse.mock.calls[0]?.[1]).toEqual(['Dosyalar', 'Taslaklar ']);
  });

  it('boş bileşenleri atıyor — çift eğik çizgi ve baştaki eğik çizgi', async () => {
    const { controller: c, browse } = controller();

    await c.entries(request(), '/Dosyalar//Belgeler/');

    expect(browse.mock.calls[0]?.[1]).toEqual(['Dosyalar', 'Belgeler']);
  });

  it('yol verilmediğinde KÖKÜ listeliyor', async () => {
    const { controller: c, browse } = controller();

    await c.entries(request());

    expect(browse.mock.calls[0]?.[1]).toEqual([]);
  });
});
