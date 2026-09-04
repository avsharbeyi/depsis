import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { AgentUnavailableError } from '../agent/agent.service.js';
import type { AuthenticatedRequest } from '../auth/session.guard.js';
import type { AgentResponse, AgentService } from '../agent/agent.service.js';
import type { AuditService } from '../audit/audit.service.js';
import { SystemController } from './system.controller.js';
import type { DiskInventory, SystemService, Telemetry } from './system.service.js';

/**
 * The gate in front of `system/`, and what it answers when the agent is not there.
 *
 * Both routes read hardware detail — `GET /system/disks` more of it than telemetry: the model and
 * serial of every disk in the box and, through `holds`, what is stored on them. The guard is one
 * `if` in each handler, which is exactly the kind of thing a refactor drops without a test
 * noticing.
 */

const SESSION = {
  userId: 'u-1',
  organizationId: 'o-1',
  role: 'member',
} as const;

function request(): AuthenticatedRequest {
  return { depsis: { ...SESSION } } as unknown as AuthenticatedRequest;
}

function controller(options: {
  admin: boolean;
  inventory?: () => Promise<DiskInventory>;
  telemetry?: () => Promise<Telemetry>;
  /** Ajanın `reboot_system` cevabı — yalnız yeniden başlatma süiti veriyor. */
  reboot?: () => Promise<AgentResponse>;
  audit?: ReturnType<typeof vi.fn>;
}): SystemController {
  const system = {
    isSystemAdministrator: () => Promise.resolve(options.admin),
    inventory: options.inventory ?? (() => Promise.resolve({ disks: [], complete: true })),
    telemetry:
      options.telemetry ??
      (() =>
        Promise.resolve({ pools: [], disks: [], cpu: {}, memory: { total: 1, available: 1 } })),
  } as unknown as SystemService;
  const agent = {
    call: options.reboot ?? (() => Promise.reject(new Error('bu süit ajanı sürmüyor'))),
  } as unknown as AgentService;
  const audit = {
    record: options.audit ?? (() => Promise.resolve()),
  } as unknown as AuditService;
  return new SystemController(system, agent, audit);
}

/**
 * Yazan bir uca giden istek.
 *
 * Başlıklar BOŞ: `requireSameOrigin` köken bildirmeyen bir isteği geçiriyor (tarayıcı olmayan
 * istemci CSRF'in konusu değil), yani bu süit ölçtüğü şeyi ölçebiliyor.
 */
function writeRequest(): AuthenticatedRequest {
  return { depsis: { ...SESSION }, headers: {} } as unknown as AuthenticatedRequest;
}

describe('GET /system/disks', () => {
  it('refuses somebody who is not the system administrator', async () => {
    await expect(controller({ admin: false }).disks(request())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('serves the inventory to the system administrator', async () => {
    const inventory: DiskInventory = {
      complete: true,
      disks: [
        {
          byId: 'ata-X',
          kname: 'sda',
          sizeBytes: 1_000,
          rotational: true,
          removable: false,
          holds: [],
          mounted: false,
          holdsSystem: false,
        },
      ],
    };
    const answer = await controller({
      admin: true,
      inventory: () => Promise.resolve(inventory),
    }).disks(request());

    expect(answer).toEqual(inventory);
  });

  it('answers 503 rather than an empty box when the agent cannot be reached', async () => {
    // The most dangerous wrong answer this endpoint could give. Its caller is picking disks to
    // overwrite, and an empty list reads as a finished inventory of a machine with nothing on it.
    const call = controller({
      admin: true,
      inventory: () => Promise.reject(new AgentUnavailableError('socket is gone')),
    }).disks(request());

    await expect(call).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('does not repeat the agent’s own words to the caller', async () => {
    // `AgentUnavailableError` carries whatever the transport said, which on a failed exec is the
    // absolute path of a privileged binary. The 503 body is a fixed sentence for the same reason
    // `backups.controller.explain` withholds one.
    const call = controller({
      admin: true,
      inventory: () =>
        Promise.reject(new AgentUnavailableError('connect ENOENT /run/depsis/agent.sock')),
    }).disks(request());

    await expect(call).rejects.toThrow(/ajanına ulaşılamıyor/);
    await expect(call).rejects.not.toThrow(/run\/depsis/);
  });

  it('lets a fault that is not the agent through unchanged', async () => {
    // A programming error must not be dressed up as "the agent is down"; that is the one message
    // guaranteed to send an operator to look at the wrong component.
    const boom = new TypeError('disks.map is not a function');
    const call = controller({ admin: true, inventory: () => Promise.reject(boom) }).disks(
      request(),
    );

    await expect(call).rejects.toBe(boom);
  });
});

describe('POST /system/power/reboot', () => {
  it('ajan işi REDDETTİĞİNDE 202 dönmüyor', async () => {
    // Bu uç ajanın cevabını hiç okumuyordu. `systemctl reboot` bir polkit/dbus arızasıyla
    // sıfırdan farklı çıktığında ajan `failed` diyor; 202 dönen bir uç o hâlde ekrana "yeniden
    // başlatılıyor" yazdırıyor, kutu hiç kapanmıyor ve sahibi nedenini hiçbir yerde göremiyor.
    const call = controller({
      admin: true,
      reboot: () =>
        Promise.resolve<AgentResponse>({
          status: 'failed',
          reason: 'command /usr/bin/systemctl failed with status 1: polkit denied',
        }),
    }).reboot(writeRequest());

    await expect(call).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('ajanın kendi cümlesini kullanıcıya taşımıyor', async () => {
    // `failed`in gerekçesi ayrıcalıklı ikilinin mutlak yolunu ve ham stderr'i taşıyor.
    const call = controller({
      admin: true,
      reboot: () =>
        Promise.resolve<AgentResponse>({
          status: 'failed',
          reason: 'command /usr/bin/systemctl failed with status 1: polkit denied',
        }),
    }).reboot(writeRequest());

    await expect(call).rejects.toThrow(/yeniden başlatılamadı/u);
    await expect(call).rejects.not.toThrow(/systemctl/u);
  });

  it('ajan reddettiğinde de aynı cevabı veriyor', async () => {
    const call = controller({
      admin: true,
      reboot: () => Promise.resolve<AgentResponse>({ status: 'refused', reason: 'bakım kipi' }),
    }).reboot(writeRequest());

    await expect(call).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('ajan işi aldığında sessizce dönüyor', async () => {
    const call = controller({
      admin: true,
      reboot: () => Promise.resolve<AgentResponse>({ status: 'reboot_scheduled' }),
    }).reboot(writeRequest());

    await expect(call).resolves.toBeUndefined();
  });

  it('ajana ULAŞILAMAMASI hâlâ bir hata değil', async () => {
    // Kapanma başladıysa soket zaten gidiyor: "yeniden başlatılamadı" demek, olan bitenin tam
    // tersini söylemek olurdu. Ayrım bu testin tamamı — "sustu" ile "hayır dedi" aynı şey değil.
    const call = controller({
      admin: true,
      reboot: () =>
        Promise.reject(new AgentUnavailableError('connect ENOENT /run/depsis/agent.sock')),
    }).reboot(writeRequest());

    await expect(call).resolves.toBeUndefined();
  });

  it('denetim kaydı bir OLGU değil bir İSTEK bildiriyor', async () => {
    // Kayıt çağrıdan önce yazılıyor ve öyle kalmalı: başarılı bir yeniden başlatmada systemd
    // kutuyu kapatırken satır artık yazılamayabilir. O yüzden cümlesi "başlatıldı" diyemez.
    const audit = vi.fn().mockResolvedValue(undefined);
    await controller({
      admin: true,
      audit,
      reboot: () => Promise.resolve<AgentResponse>({ status: 'reboot_scheduled' }),
    }).reboot(writeRequest());

    expect(audit).toHaveBeenCalledTimes(1);
    const [, entry] = audit.mock.calls[0] as [string, { summary: string }];
    expect(entry.summary).toMatch(/istendi/u);
  });

  it('kurucu yönetici olmayanı reddediyor ve ajana hiç gitmiyor', async () => {
    const reboot = vi.fn(() => Promise.resolve<AgentResponse>({ status: 'reboot_scheduled' }));
    await expect(
      controller({ admin: false, reboot }).reboot(writeRequest()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(reboot).not.toHaveBeenCalled();
  });
});
