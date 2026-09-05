import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AgentResponse, AgentService } from '../agent/agent.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { ReauthService } from '../auth/reauth.service.js';
import type { AuthenticatedRequest } from '../auth/session.guard.js';
import type { SystemService, Telemetry } from './system.service.js';
import { UpdateController } from './update.controller.js';

/**
 * §12'nin ÖN KONTROLÜ, ve neden parolanın önünde duruyor.
 *
 * `POST /system/update/apply` yalnız yönetici olduğunu ve parolayı doğruluyor, sonra derlemeyi
 * başlatıyordu. %95 dolu bir sistem diskinde bunun sonucu, yarıda düşen ve geri de alınamayan bir
 * güncelleme: `update.sh` eski ağacı saklayıp geri koyuyor, yani geri alma yolu da yer istiyor.
 * Degraded bir havuzda ise güncelleme, kutunun zaten bir diski eksikken yeniden başlatılması
 * demek.
 *
 * ÖLÇÜLEMEYEN ŞEY ENGELLEMİYOR: boş alan okunamadığında ya da havuz sağlığı `UNKNOWN` olduğunda
 * güncelleme koşuyor. Bir ölçüm boşluğunu "hayır" diye okumak, cihazı bir güvenlik
 * düzeltmesinden mahrum bırakmanın en kolay yolu.
 */

const ENOUGH = 40 * 1024 * 1024 * 1024;
const NOT_ENOUGH = 512 * 1024 * 1024;

function request(): AuthenticatedRequest {
  return {
    depsis: { userId: 'u-1', organizationId: 'o-1', role: 'admin' },
    headers: {},
  } as unknown as AuthenticatedRequest;
}

function pool(name: string, health: string): Telemetry['pools'][number] {
  return { name, health, used: 1, available: 1 } as Telemetry['pools'][number];
}

/** Boş alanı testin söylediği kadar gören bir denetleyici. */
class Probed extends UpdateController {
  constructor(
    system: SystemService,
    agent: AgentService,
    reauth: ReauthService,
    audit: AuditService,
    private readonly free: number | null,
  ) {
    super(system, agent, reauth, audit);
  }

  protected override freeBytes(): Promise<number | null> {
    return Promise.resolve(this.free);
  }
}

function controller(options: { free: number | null; pools?: Telemetry['pools'] }): {
  controller: UpdateController;
  reauth: ReturnType<typeof vi.fn>;
  agent: ReturnType<typeof vi.fn>;
  telemetry: ReturnType<typeof vi.fn>;
  audit: ReturnType<typeof vi.fn>;
} {
  const telemetry = vi.fn((_correlationId: string, _organizationId: string) =>
    Promise.resolve({
      pools: options.pools ?? [pool('tank', 'ONLINE')],
      disks: [],
      cpu: {},
      memory: {},
    } as unknown as Telemetry),
  );
  const system = {
    isSystemAdministrator: () => Promise.resolve(true),
    telemetry,
  } as unknown as SystemService;

  const agent = vi.fn(() =>
    Promise.resolve({
      status: 'update',
      installed: 'abc1234',
      available: null,
      phase: 'idle',
      in_progress: false,
      up_to_date: true,
      log_tail: [],
    } as unknown as AgentResponse),
  );
  const reauth = vi.fn().mockResolvedValue(undefined);
  const audit = vi.fn().mockResolvedValue(undefined);

  return {
    controller: new Probed(
      system,
      { call: agent } as unknown as AgentService,
      { require: reauth } as unknown as ReauthService,
      { record: audit } as unknown as AuditService,
      options.free,
    ),
    reauth,
    agent,
    telemetry,
    audit,
  };
}

const BODY = { password: 'the-right-one' };

describe('POST /system/update/apply, ön kontrol', () => {
  it('sistem diskinde yer yokken güncellemeyi başlatmıyor', async () => {
    const { controller: c, agent } = controller({ free: NOT_ENOUGH });

    await expect(c.apply(request(), BODY)).rejects.toBeInstanceOf(ConflictException);
    expect(agent).not.toHaveBeenCalled();
  });

  it('ve bunu PAROLADAN ÖNCE söylüyor', async () => {
    // Havuz sihirbazındaki kalıbın aynısı: güncellemenin zaten başlayamayacağını öğrenecek kişi,
    // bunu öğrenmek için parolasını vermek zorunda kalmasın.
    const { controller: c, reauth } = controller({ free: NOT_ENOUGH });

    await expect(c.apply(request(), BODY)).rejects.toBeInstanceOf(ConflictException);
    expect(reauth).not.toHaveBeenCalled();
  });

  it('cümlesi kaç GB olduğunu ve kaç GB gerektiğini söylüyor', async () => {
    // "Yetersiz alan" diyen bir hata, sahibine ne kadar yer açacağını söylemiyor.
    const { controller: c } = controller({ free: NOT_ENOUGH });

    await expect(c.apply(request(), BODY)).rejects.toThrow(/0\.5 GB/u);
    await expect(c.apply(request(), BODY)).rejects.toThrow(/4\.0 GB/u);
  });

  it('arızalı bir havuz varken güncellemeyi başlatmıyor', async () => {
    const { controller: c, agent } = controller({
      free: ENOUGH,
      pools: [pool('tank', 'ONLINE'), pool('yedek', 'DEGRADED')],
    });

    await expect(c.apply(request(), BODY)).rejects.toThrow(/yedek/u);
    expect(agent).not.toHaveBeenCalled();
  });

  it('sağlığı BİLİNMEYEN bir havuz engel değil', async () => {
    // Bir telemetri boşluğunu "hayır" diye okumak, kutuyu onarılamaz yapardı.
    const { controller: c, agent } = controller({
      free: ENOUGH,
      pools: [pool('tank', 'UNKNOWN')],
    });

    await c.apply(request(), BODY);
    expect(agent).toHaveBeenCalledTimes(1);
  });

  it('boş alan ÖLÇÜLEMEDİĞİNDE de engellemiyor', async () => {
    const { controller: c, agent } = controller({ free: null });

    await c.apply(request(), BODY);
    expect(agent).toHaveBeenCalledTimes(1);
  });

  it('her şey yolundayken güncellemeyi başlatıyor', async () => {
    const { controller: c, agent, reauth } = controller({ free: ENOUGH });

    const answer = await c.apply(request(), BODY);

    expect(reauth).toHaveBeenCalledTimes(1);
    expect(agent).toHaveBeenCalledTimes(1);
    expect(answer.installed).toBe('abc1234');
  });

  it('ön kontrol, ajan çağrısı ve denetim kaydı TEK bir kimlik taşıyor', async () => {
    // İki ayrı `randomUUID()` üretiliyordu: ön kontrolün havuz sağlığı sorgusu bir kimlikle,
    // güncellemeyi başlatan çağrı bambaşka bir kimlikle gidiyordu. §16'nın vaadi, ajanın denetim
    // izinden isteğe geri okunabilmek — iki kimlik o izi ortadan ikiye bölüyor.
    const { controller: c, agent, telemetry, audit } = controller({ free: ENOUGH });

    await c.apply(request(), BODY);

    const [precheckId] = telemetry.mock.calls[0] as [string, string];
    const [, , applyId] = agent.mock.calls[0] as [unknown, string, string];
    const [, entry] = audit.mock.calls[0] as [string, { correlationId: string }];

    expect(precheckId).toBe(applyId);
    expect(entry.correlationId).toBe(applyId);
  });
});
