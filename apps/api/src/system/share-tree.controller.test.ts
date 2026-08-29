import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AgentService } from '../agent/agent.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedRequest } from '../auth/session.guard.js';
import { ShareTreeController } from './share-tree.controller.js';
import type { SystemService } from './system.service.js';

/**
 * `POST /storage/share-tree` — havuzu olan ama paylaşım açamayan bir kutuyu düzelten uç.
 *
 * Bu uç, arayüzde duran bir KABUK KOMUTUNUN yerine geçti: ekran, havuz var ama ağaç yokken
 * `zfs create -o mountpoint=…` yazdırıyordu. Cihazın sahibi olağan hiçbir iş için terminale
 * girmemeli, ve depolamanın yapılandırılması uçtan uca arayüzde bitmeli.
 *
 * BURADA ÖLÇÜLEN ŞEY KAPILAR, ajanın işi değil. Ağacı gerçekten kuran taraf ajan, ve onun
 * reddetmesi gereken durumlar (kökte bağlı bir veri kümesi, boş olmayan bir dizin) orada, kendi
 * testleriyle duruyor. Buradaki soru: kim çağırabilir, hangi durumda çağrı ajana hiç gitmez, ve
 * ajanın reddi operatöre nasıl ulaşır.
 */

function request(): AuthenticatedRequest {
  return {
    depsis: { userId: 'u-1', organizationId: 'o-1', role: 'admin' },
    headers: {},
    method: 'POST',
  } as unknown as AuthenticatedRequest;
}

function controller(options: {
  admin?: boolean;
  pools?: string[];
  parentDataset?: string | undefined;
  agentCall?: ReturnType<typeof vi.fn>;
}): {
  controller: ShareTreeController;
  agentCall: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
} {
  const agentCall =
    options.agentCall ??
    vi.fn().mockResolvedValue({ status: 'share_root_prepared', dataset: 'tank/depsis' });
  const system = {
    isSystemAdministrator: () => Promise.resolve(options.admin ?? true),
    storageSetup: () =>
      Promise.resolve({
        pools: options.pools ?? ['tank'],
        shareRoot: { path: '/srv/depsis', empty: true },
        ...(options.parentDataset === undefined ? {} : { parentDataset: options.parentDataset }),
      }),
  } as unknown as SystemService;
  const agent = { call: agentCall } as unknown as AgentService;
  const record = vi.fn().mockResolvedValue(undefined);
  const audit = { record } as unknown as AuditService;
  return { controller: new ShareTreeController(system, agent, audit), agentCall, record };
}

describe('POST /storage/share-tree', () => {
  it('kurucu yönetici olmayanı reddeder ve ajana hiç gitmez', async () => {
    const { controller: c, agentCall } = controller({ admin: false });
    await expect(c.prepare(request(), { pool: 'tank' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(agentCall).not.toHaveBeenCalled();
  });

  it('ağaç zaten kuruluysa 409 verir, ve ikinci bir tane kurmaya çalışmaz', async () => {
    // Ajan da reddederdi, ama onun cümlesi "kökte bir veri kümesi bağlı" — doğru ve teknik.
    // Operatörün burada duyması gereken şey, istediği durumun ZATEN sağlandığı.
    const { controller: c, agentCall } = controller({ parentDataset: 'tank/depsis' });
    await expect(c.prepare(request(), { pool: 'tank' })).rejects.toBeInstanceOf(ConflictException);
    expect(agentCall).not.toHaveBeenCalled();
  });

  it('kutuda olmayan bir havuz adını ajana sormadan reddeder', async () => {
    const { controller: c, agentCall } = controller({ pools: ['tank'] });
    await expect(c.prepare(request(), { pool: 'baska' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(agentCall).not.toHaveBeenCalled();
  });

  it('havuz adını doğrular: bir bayrak ya da yol asla ajana ulaşmaz', async () => {
    // `zpool` kendi argümanlarını ayrıştırıyor ve `-` ile başlayan bir ad onun için bir seçenek.
    const { controller: c, agentCall } = controller({});
    await expect(c.prepare(request(), { pool: '-f' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.prepare(request(), { pool: 'tank/depsis' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(agentCall).not.toHaveBeenCalled();
  });

  it('ağacı kurar, veri kümesini döndürür ve denetim kaydına yazar', async () => {
    const { controller: c, agentCall, record } = controller({});
    const answer = await c.prepare(request(), { pool: 'tank' });

    expect(answer).toEqual({ dataset: 'tank/depsis' });
    expect(agentCall).toHaveBeenCalledTimes(1);
    const [operation] = agentCall.mock.calls[0] as [Record<string, unknown>];
    expect(operation).toEqual({ op: 'prepare_share_root', pool: 'tank' });

    // Kök yetkiyle bir veri kümesi oluşturuldu; kimin istediği kayıtta durmalı.
    expect(record).toHaveBeenCalledTimes(1);
    const [, entry] = record.mock.calls[0] as [string, { action: string; summary: string }];
    expect(entry.action).toBe('storage.share-tree-prepared');
    expect(entry.summary).toContain('tank/depsis');
  });

  it('ajanın reddini operatöre AJANIN CÜMLESİYLE ulaştırır', async () => {
    // "Kök boş değil" üzerine gidilebilecek bir olgu; "paylaşım ağacı kurulamadı" değil.
    const agentCall = vi
      .fn()
      .mockResolvedValue({ status: 'refused', reason: 'share root is not empty' });
    const { controller: c, record } = controller({ agentCall });
    await expect(c.prepare(request(), { pool: 'tank' })).rejects.toMatchObject({
      message: 'share root is not empty',
    });
    expect(record).not.toHaveBeenCalled();
  });

  it('beklenmeyen bir yanıtı BAŞARI saymaz', async () => {
    // Bu ekranın en kötü hâli, ağaç kurulmamışken "kuruldu" demek olurdu: sahibi paylaşım
    // açmayı dener, olmaz, ve ekran ona her şeyin yolunda olduğunu söylemiştir.
    const agentCall = vi.fn().mockResolvedValue({ status: 'ok' });
    const { controller: c, record } = controller({ agentCall });
    await expect(c.prepare(request(), { pool: 'tank' })).rejects.toThrow();
    expect(record).not.toHaveBeenCalled();
  });
});
