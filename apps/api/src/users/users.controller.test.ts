import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
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

/**
 * Gerçek uuid'ler, 'u-1' gibi kısa etiketler değil.
 *
 * Bu rotalar artık id'nin biçimini denetliyor: bozuk bir id PostgreSQL'e `uuid` olarak gidiyordu ve
 * 22P02 ile 500 üretiyordu — bozuk bir bağlantı için hata sayfası, ve ayrıca bozuk bir id'yi başka
 * kiracının satırını adlandıran geçerli bir id'den ayıran bir fark.
 */
const ADMIN = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';

function harness(options: { passwordOk?: boolean } = {}): {
  controller: UsersController;
  requirePassword: ReturnType<typeof vi.fn>;
  verify: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  clearMfa: ReturnType<typeof vi.fn>;
  revokeAllForUser: ReturnType<typeof vi.fn>;
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
  const create = vi.fn().mockResolvedValue({
    id: TARGET,
    username: 'yeni',
    email: null,
    role: 'member',
    disabled_at: null,
    created_at: new Date('2025-01-01T00:00:00Z'),
  });
  const clearMfa = vi.fn().mockResolvedValue(undefined);
  const revokeAllForUser = vi.fn().mockResolvedValue(0);

  const users = {
    find: () =>
      Promise.resolve({
        id: TARGET,
        username: 'hedef',
        email: null,
        role: 'member',
        disabled_at: null,
        created_at: new Date('2025-01-01T00:00:00Z'),
      }),
    remove,
    create,
    clearMfa,
  } as unknown as UsersService;

  const controller = new UsersController(
    users,
    { verify, hash: () => Promise.resolve('argon2') } as unknown as PasswordService,
    { require: requirePassword } as unknown as ReauthService,
    { revokeAllForUser } as unknown as SessionService,
    { open } as unknown as PasswordResetService,
    { record: () => Promise.resolve() } as unknown as AuditService,
  );
  return { controller, requirePassword, verify, open, remove, create, clearMfa, revokeAllForUser };
}

function request(): AuthenticatedRequest {
  return {
    headers: {},
    depsis: { userId: ADMIN, organizationId: 'o-1', sessionId: 's-1', role: 'admin' },
  } as unknown as AuthenticatedRequest;
}

describe('POST /users/{id}/password-reset', () => {
  it('asks the shared re-authentication, never the hasher', async () => {
    const h = harness();
    const ticket = await h.controller.openPasswordReset(request(), TARGET, { password: PASSWORD });
    expect(h.requirePassword).toHaveBeenCalledWith('o-1', ADMIN, PASSWORD, expect.anything());
    expect(h.verify).not.toHaveBeenCalled();
    expect(ticket.token).toBe('tek-kullanimlik');
  });

  it('opens no ticket when the password is wrong', async () => {
    const h = harness({ passwordOk: false });
    await expect(
      h.controller.openPasswordReset(request(), TARGET, { password: 'yanlis' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.open).not.toHaveBeenCalled();
  });
});

describe('DELETE /users/{id}', () => {
  it('asks the shared re-authentication, never the hasher', async () => {
    const h = harness();
    await h.controller.remove(request(), TARGET, { password: PASSWORD });
    expect(h.requirePassword).toHaveBeenCalledWith('o-1', ADMIN, PASSWORD, expect.anything());
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.remove).toHaveBeenCalled();
  });

  it('deletes nothing when the password is wrong', async () => {
    const h = harness({ passwordOk: false });
    await expect(
      h.controller.remove(request(), TARGET, { password: 'yanlis' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.remove).not.toHaveBeenCalled();
  });
});

describe('a malformed id on the account routes', () => {
  // 500 DEĞİL. Bozuk id doğrudan `WHERE id = $2` (uuid) sorgusuna gidiyordu ve PostgreSQL'in
  // 22P02'si eşlenmediği için hata sayfası oluyordu — üstelik geçerli ama başka kiracıya ait bir
  // id'den farklı cevap vererek, RLS'in silmek istediği ayrımı geri getiriyordu.
  it('is "no such account" rather than a fault, and nothing is written', async () => {
    const h = harness();
    await expect(
      h.controller.remove(request(), 'abc', { password: PASSWORD }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.controller.update(request(), 'abc', { disabled: true })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      h.controller.openPasswordReset(request(), 'abc', { password: PASSWORD }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled();
  });
});

describe('POST /users with a system account name', () => {
  /**
   * 'backup' adlı tek bir hesap, o kiracının BÜTÜN kimlik eşitlemesini kalıcı olarak düşürüyor:
   * ajan her koşuda `getent passwd backup` ile kutunun kendi hesabını buluyor, uid 34 DEPSIS'in
   * aralığında olmadığı için "bu login makineye ait" deyip eşitlemenin tamamını reddediyor. O
   * günden sonra açılan hiçbir hesap SMB'ye giremiyor, ve hesabı silmek de aynı kontrole takılıp
   * 503 dönüyor.
   */
  it('is refused before the row exists, with a sentence that says why', async () => {
    const h = harness();
    await expect(
      h.controller.create(request(), {
        username: 'backup',
        password: 'bu-parola-yeterince-uzun',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('still creates an ordinary account', async () => {
    const h = harness();
    const created = await h.controller.create(request(), {
      username: 'backupcu',
      password: 'bu-parola-yeterince-uzun',
    });
    expect(created.username).toBe('yeni');
    expect(h.create).toHaveBeenCalled();
  });
});

describe('DELETE /users/{id}/mfa', () => {
  it('clears the second factor and ends the target’s sessions', async () => {
    const h = harness();
    await h.controller.resetMfa(request(), TARGET, { password: PASSWORD });
    expect(h.requirePassword).toHaveBeenCalledWith('o-1', ADMIN, PASSWORD, expect.anything());
    expect(h.clearMfa).toHaveBeenCalledWith('o-1', TARGET);
    // Kaldırmanın sebebi çoğu zaman "o hesaba başkası ulaşmış olabilir" şüphesi; açık kalan bir
    // oturum tam o şüpheyi taşıyor.
    expect(h.revokeAllForUser).toHaveBeenCalledWith('o-1', TARGET);
  });

  it('clears nothing when the password is wrong', async () => {
    const h = harness({ passwordOk: false });
    await expect(
      h.controller.resetMfa(request(), TARGET, { password: 'yanlis' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.clearMfa).not.toHaveBeenCalled();
  });

  it('refuses the administrator’s own account, which /me/mfa handles', async () => {
    const h = harness();
    await expect(
      h.controller.resetMfa(request(), ADMIN, { password: PASSWORD }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.clearMfa).not.toHaveBeenCalled();
  });
});
