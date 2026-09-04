import { UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedRequest } from '../auth/session.guard.js';
import { NotificationsController } from './notifications.controller.js';
import type { NotificationsService } from './notifications.service.js';

/**
 * "Okundu işaretle" ucunun gövde doğrulaması.
 *
 * Veritabanına inmiyor: ölçülen şey satırların ne olduğu değil, HANGİ metodun çağrıldığı.
 * Ayrıştırma başarısız olduğunda `ids` undefined kalıyordu ve o hâl "hepsi" demek — yani tek bir
 * satırı işaretlemek isteyen bozuk bir istek, kullanıcının bütün gelen kutusunu okundu yapıyordu.
 * Okunmamışlık geri alınamıyor.
 */

function harness(): {
  controller: NotificationsController;
  markRead: ReturnType<typeof vi.fn>;
  markAllRead: ReturnType<typeof vi.fn>;
} {
  const markRead = vi.fn().mockResolvedValue(1);
  const markAllRead = vi.fn().mockResolvedValue(40);
  const notifications = {
    markRead,
    markAllRead,
    unreadCount: () => Promise.resolve(0),
  } as unknown as NotificationsService;
  return { controller: new NotificationsController(notifications), markRead, markAllRead };
}

function signedIn(): AuthenticatedRequest {
  return {
    depsis: {
      organizationId: '00000000-0000-4000-8000-000000000001',
      userId: '00000000-0000-4000-8000-000000000002',
      role: 'member',
    },
  } as unknown as AuthenticatedRequest;
}

const UUID = '00000000-0000-4000-8000-0000000000ff';

describe('POST /notifications/read', () => {
  it('refuses a malformed body instead of marking the whole inbox read', async () => {
    const h = harness();
    await expect(h.controller.markRead(signedIn(), { ids: ['abc'] })).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(h.markAllRead).not.toHaveBeenCalled();
    expect(h.markRead).not.toHaveBeenCalled();
  });

  it('still treats an empty body and a missing body as "all"', async () => {
    // Bu davranış BOZULMUYOR, ve gerekçesi denetleyicinin kendi yorumunda: `{}` ile gövdesizliği
    // ayırmak istemciye anlamı olmayan bir seçim dayatırdı.
    const h = harness();
    expect((await h.controller.markRead(signedIn(), {})).marked).toBe(40);
    expect((await h.controller.markRead(signedIn(), undefined)).marked).toBe(40);
    expect(h.markAllRead).toHaveBeenCalledTimes(2);
  });

  it('marks exactly the ids it was given', async () => {
    const h = harness();
    expect((await h.controller.markRead(signedIn(), { ids: [UUID] })).marked).toBe(1);
    expect(h.markRead).toHaveBeenCalledWith(expect.any(String), expect.any(String), [UUID]);
    expect(h.markAllRead).not.toHaveBeenCalled();
  });
});
