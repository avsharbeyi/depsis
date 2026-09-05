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

function controller(options: { view?: unknown; runs?: unknown[] } = {}): {
  controller: BackupTargetController;
  browse: ReturnType<typeof vi.fn>;
} {
  const browse = vi.fn().mockResolvedValue({ entries: [], truncated: false });
  const targets = {
    browse,
    view: () => Promise.resolve(options.view ?? null),
  } as unknown as BackupTargetService;
  const system = {
    isSystemAdministrator: () => Promise.resolve(true),
  } as unknown as SystemService;
  const runs = { recent: () => Promise.resolve(options.runs ?? []) } as unknown as BackupRunService;
  return {
    controller: new BackupTargetController(targets, runs, system, {} as unknown as AuditService),
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

/**
 * TUR GEÇMİŞİNİN OKUYUCUSU.
 *
 * `backup_runs` her turda yazılıyordu ve hiçbir uç okumuyordu. Yedek diski dolduğunda tur
 * 'yer-yok' ile düşüyor, satır tabloya giriyor, ama ekran diski "Açık" gösteriyor ve doğrulama
 * son KOPYALANAN dosyayı — o tur hiç kopyalamadığından eskisini — okuyup "Okundu" diyordu.
 * Sahibi haftalarca yedek aldığını sanıyor, arızanın tek izi worker günlüğünde duruyordu.
 */
describe('GET /backups/target', () => {
  const RUN = {
    trigger: 'zamanli' as const,
    state: 'yer-yok' as const,
    copiedFiles: 0,
    copiedBytes: 0,
    movedFiles: 0,
    purgedFiles: 0,
    error: 'yedek diskinde yer yok',
    startedAt: '2026-09-04T03:00:00.000Z',
    finishedAt: '2026-09-04T03:00:04.000Z',
  };

  it('düşen turu cevabın içinde taşıyor', async () => {
    const { controller: c } = controller({
      view: { pool: 'yedek', label: 'Kirmizi disk', unlocked: true },
      runs: [RUN],
    });

    const answer = (await c.read(request())) as {
      configured: boolean;
      target: { lastRun: typeof RUN | null; runs: (typeof RUN)[] };
    };

    expect(answer.configured).toBe(true);
    expect(answer.target.lastRun).toEqual(RUN);
    expect(answer.target.runs).toHaveLength(1);
  });

  it('hiç tur koşmamış cihazda kartı yine çiziyor', async () => {
    const { controller: c } = controller({ view: { pool: 'yedek' }, runs: [] });

    const answer = (await c.read(request())) as { target: { lastRun: unknown } };

    expect(answer.target.lastRun).toBeNull();
  });

  it('disk kurulu değilken tur geçmişini hiç sormuyor', async () => {
    const { controller: c } = controller();

    const answer = (await c.read(request())) as { configured: boolean; target: unknown };

    expect(answer).toEqual({ configured: false, target: null });
  });
});
