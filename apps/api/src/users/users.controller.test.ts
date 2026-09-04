import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit/audit.service.js';
import type { PasswordResetService } from '../auth/password-reset.service.js';
import type { PasswordService } from '../auth/password.service.js';
import type { ReauthService } from '../auth/reauth.service.js';
import type { AuthenticatedRequest } from '../auth/session.guard.js';
import type { SessionService } from '../auth/session.service.js';
import { UsersController } from './users.controller.js';
import type { UsersService } from './users.service.js';

/**
 * Yöneticinin kendi parolasını SORAN iki uç: sıfırlama bileti ve hesap silme.
 *
 * İkisi de parolayı kendi elleriyle `passwords.verify` ile deniyordu, yani giriş kısıtlamasının
 * dışındaydı: çalınmış bir yönetici çerezi ile parola sınırsız kez, gecikmesiz ve
 * `login_attempts`'e tek satır iz bırakmadan tahmin edilebiliyordu — ve doğru tahminin ödülü
 * cihazdaki HERHANGİ bir hesaba açılan bir bilet. Kısıtlamanın kendisi `reauth.service.test.ts`te
 * ölçülüyor; burada ölçülen şey o servise gerçekten uğranıldığı.
 */

const PASSWORD = 'yoneticinin-parolasi';

function harness(options: { passwordOk?: boolean } = {}): {
  controller: UsersController;
  requirePassword: ReturnType<typeof vi.fn>;
  verify: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
} {
  const requirePassword = vi.fn();
  requirePassword.mockImplementation((_org: string, _user: string, given: string) =>
    (options.passwordOk ?? true) && given === PASSWORD
      ? Promise.resolve()
      : Promise.reject(new UnauthorizedException('the password is wrong')),
  );
  // Çağrılmamalı: doğrulamanın tamamı `reauth`ta. Hesap açmak için hâlâ gerekli olan `hash`
  // duruyor, ölçülen şey `verify`ın bir daha buradan çağrılmaması.
  const verify = vi.fn().mockResolvedValue(true);
  const open = vi
    .fn()
    .mockResolvedValue({ token: 'tek-kullanimlik', expiresAt: new Date('2026-01-01T00:00:00Z') });
  const remove = vi.fn().mockResolvedValue({ username: 'silinen', posixUid: 300007 });

  const users = {
    find: () =>
      Promise.resolve({
        id: 'u-2',
        username: 'hedef',
        email: null,
        role: 'member',
        disabled_at: null,
        created_at: new Date('2025-01-01T00:00:00Z'),
      }),
    remove,
  } as unknown as UsersService;

  const controller = new UsersController(
    users,
    { verify, hash: () => Promise.resolve('argon2') } as unknown as PasswordService,
    { require: requirePassword } as unknown as ReauthService,
    { revokeAllForUser: () => Promise.resolve(0) } as unknown as SessionService,
    { open } as unknown as PasswordResetService,
    { record: () => Promise.resolve() } as unknown as AuditService,
  );
  return { controller, requirePassword, verify, open, remove };
}

function request(): AuthenticatedRequest {
  return {
    headers: {},
    depsis: { userId: 'u-1', organizationId: 'o-1', sessionId: 's-1', role: 'admin' },
  } as unknown as AuthenticatedRequest;
}

describe('POST /users/{id}/password-reset', () => {
  it('asks the shared re-authentication, never the hasher', async () => {
    const h = harness();
    const ticket = await h.controller.openPasswordReset(request(), 'u-2', { password: PASSWORD });
    expect(h.requirePassword).toHaveBeenCalledWith('o-1', 'u-1', PASSWORD, expect.anything());
    expect(h.verify).not.toHaveBeenCalled();
    expect(ticket.token).toBe('tek-kullanimlik');
  });

  it('opens no ticket when the password is wrong', async () => {
    const h = harness({ passwordOk: false });
    await expect(
      h.controller.openPasswordReset(request(), 'u-2', { password: 'yanlis' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.open).not.toHaveBeenCalled();
  });
});

describe('DELETE /users/{id}', () => {
  it('asks the shared re-authentication, never the hasher', async () => {
    const h = harness();
    await h.controller.remove(request(), 'u-2', { password: PASSWORD });
    expect(h.requirePassword).toHaveBeenCalledWith('o-1', 'u-1', PASSWORD, expect.anything());
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.remove).toHaveBeenCalled();
  });

  it('deletes nothing when the password is wrong', async () => {
    const h = harness({ passwordOk: false });
    await expect(
      h.controller.remove(request(), 'u-2', { password: 'yanlis' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.remove).not.toHaveBeenCalled();
  });
});
