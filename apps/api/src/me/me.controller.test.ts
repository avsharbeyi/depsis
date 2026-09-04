import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit/audit.service.js';
import type { MfaService } from '../auth/mfa.service.js';
import type { PasswordService } from '../auth/password.service.js';
import type { ReauthService } from '../auth/reauth.service.js';
import type { AuthenticatedRequest } from '../auth/session.guard.js';
import type { SessionService } from '../auth/session.service.js';
import type { DbService } from '../db/db.service.js';
import type { IdentitySyncService } from '../identity/identity-sync.service.js';
import { MeController } from './me.controller.js';

/**
 * Parolayı SORAN ve parolayı DOĞRULAYAN ayrımı.
 *
 * Bu dosyadaki her uç parolayı kendi eliyle deniyordu, yani giriş kısıtlamasının dışındaydı:
 * çalınmış bir çerezle sınırsız, gecikmesiz ve `login_attempts`'e iz düşmeyen tahmin. Kısıtlamanın
 * kendisi `reauth.service.test.ts`te ölçülüyor; burada ölçülen şey ÇAĞRININ YAPILIYOR OLMASI —
 * yani kontrolün o servisin dışına bir daha yazılmaması.
 *
 * İkinci ölçüm MFA kaydının onayı. Parolasız hâlinde ele geçirilmiş bir oturum hesaba kendi
 * authenticator'ını takabiliyordu ve gerçek sahip bir daha giremiyordu.
 */

const PASSWORD = 'dogru-parola';

interface Harness {
  controller: MeController;
  requirePassword: ReturnType<typeof vi.fn>;
  verify: ReturnType<typeof vi.fn>;
  confirmEnrolment: ReturnType<typeof vi.fn>;
  revokeAllForUser: ReturnType<typeof vi.fn>;
  queries: string[];
}

function harness(options: { passwordOk?: boolean } = {}): Harness {
  const queries: string[] = [];
  const requirePassword = vi.fn();
  requirePassword.mockImplementation((_org: string, _user: string, given: string) =>
    (options.passwordOk ?? true) && given === PASSWORD
      ? Promise.resolve()
      : Promise.reject(new UnauthorizedException('the password is wrong')),
  );
  // Bir daha çağrılmamalı: doğrulamanın tamamı `reauth`ta. Sessiz bir stub yerine "çağrıldı mı"
  // diye bakılabilen bir casus, çünkü ölçülen şey tam olarak bu.
  const verify = vi.fn().mockResolvedValue(true);
  const confirmEnrolment = vi.fn().mockResolvedValue(['kod-1', 'kod-2']);
  const revokeAllForUser = vi.fn().mockResolvedValue(3);

  const db = {
    withTenant: (_org: string, fn: (q: unknown) => Promise<unknown>) =>
      fn({
        query: (text: string) => {
          queries.push(text);
          return Promise.resolve([]);
        },
      }),
  } as unknown as DbService;

  const mfa = {
    confirmEnrolment,
    isEnrolled: () => Promise.resolve(false),
    regenerateRecoveryCodes: () => Promise.resolve(['yeni-1']),
  } as unknown as MfaService;

  const passwords = {
    verify,
    hash: () => Promise.resolve('argon2-yeni'),
  } as unknown as PasswordService;
  const sessions = { revokeAllForUser } as unknown as SessionService;
  const identity = {
    rememberPassword: () => Promise.resolve(),
    enqueue: () => Promise.resolve(),
  } as unknown as IdentitySyncService;
  const audit = { record: () => Promise.resolve() } as unknown as AuditService;

  return {
    controller: new MeController(
      db,
      mfa,
      passwords,
      { require: requirePassword } as unknown as ReauthService,
      sessions,
      identity,
      audit,
    ),
    requirePassword,
    verify,
    confirmEnrolment,
    revokeAllForUser,
    queries,
  };
}

function request(): AuthenticatedRequest {
  return {
    headers: {},
    depsis: { userId: 'u-1', organizationId: 'o-1', sessionId: 's-1', role: 'member' },
  } as unknown as AuthenticatedRequest;
}

describe('POST /me/mfa/enrolment/confirm', () => {
  it('refuses a body with no password, and does not spend the code', async () => {
    // Kod `confirmEnrolment` içinde tüketiliyor. Parolasız bir istek oraya hiç ulaşmamalı, yoksa
    // ret bile kullanıcının tek seferlik kodunu yakmış olurdu.
    const h = harness();
    await expect(
      h.controller.confirmEnrolment(request(), { code: '123456' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.confirmEnrolment).not.toHaveBeenCalled();
  });

  it('re-authenticates BEFORE the code is spent', async () => {
    const h = harness({ passwordOk: false });
    await expect(
      h.controller.confirmEnrolment(request(), { code: '123456', password: 'yanlis' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.requirePassword).toHaveBeenCalledWith('o-1', 'u-1', 'yanlis', expect.anything());
    expect(h.confirmEnrolment).not.toHaveBeenCalled();
  });

  it('enrols when the password is right', async () => {
    const h = harness();
    const answer = await h.controller.confirmEnrolment(request(), {
      code: '123456',
      password: PASSWORD,
    });
    expect(answer).toEqual({ codes: ['kod-1', 'kod-2'] });
    expect(h.confirmEnrolment).toHaveBeenCalledWith('o-1', 'u-1', '123456');
  });
});

describe('the password checks on /me', () => {
  it('DELETE /me/mfa asks the shared re-authentication, never the hasher', async () => {
    // `passwords.verify` burada çağrılırsa kısıtlama atlanmış demektir — kapı yeniden açılmış olur.
    const h = harness();
    await h.controller.removeMfa(request(), { password: PASSWORD });
    expect(h.requirePassword).toHaveBeenCalledWith('o-1', 'u-1', PASSWORD, expect.anything());
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.revokeAllForUser).toHaveBeenCalledWith('o-1', 'u-1');
  });

  it('DELETE /me/mfa keeps the secret when the password is wrong', async () => {
    const h = harness({ passwordOk: false });
    await expect(h.controller.removeMfa(request(), { password: 'yanlis' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(h.queries.some((q) => q.includes('user_totp_secrets'))).toBe(false);
  });

  it('POST /me/mfa/recovery-codes asks the shared re-authentication', async () => {
    const h = harness();
    // `isEnrolled` false döndüğü için 409 bekleniyor — ölçülen şey o değil, paroladan GEÇİLDİĞİ.
    await expect(
      h.controller.regenerateCodes(request(), { password: PASSWORD }),
    ).rejects.toThrowError();
    expect(h.requirePassword).toHaveBeenCalledWith('o-1', 'u-1', PASSWORD, expect.anything());
    expect(h.verify).not.toHaveBeenCalled();
  });

  it('POST /me/password asks the shared re-authentication, never the hasher', async () => {
    const h = harness();
    const answer = await h.controller.changePassword(request(), {
      currentPassword: PASSWORD,
      newPassword: 'yeterince-uzun-bir-parola',
    });
    expect(h.requirePassword).toHaveBeenCalledWith('o-1', 'u-1', PASSWORD, expect.anything());
    expect(h.verify).not.toHaveBeenCalled();
    expect(answer).toEqual({ status: 'ok', otherSessionsRevoked: 2 });
  });

  it('POST /me/password writes nothing when the current password is wrong', async () => {
    const h = harness({ passwordOk: false });
    await expect(
      h.controller.changePassword(request(), {
        currentPassword: 'yanlis',
        newPassword: 'yeterince-uzun-bir-parola',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.queries).toEqual([]);
    expect(h.revokeAllForUser).not.toHaveBeenCalled();
  });
});
