import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { PasswordService } from '../auth/password.service.js';
import { IdentitySyncService } from '../identity/identity-sync.service.js';
import { DbService } from '../db/db.service.js';

export interface ClaimRequest {
  organizationSlug: string;
  organizationName: string;
  adminUsername: string;
  adminPassword: string;
}

export type ClaimResult =
  | { outcome: 'ok'; organizationId: string; userId: string }
  | { outcome: 'already-complete' }
  | { outcome: 'invalid'; reason: string };

/**
 * The one-time claim that turns a freshly installed box into somebody's box.
 *
 * TOKENLESS, and that is a decision with a date on it. The first design required a one-time token
 * printed to the journal, on ADR-0009's argument that a fresh NAS on a LAN is first-come-first-
 * served. The first real owner then hit the other edge of that argument three times: the only way
 * to READ the token is a terminal, and this is a product whose owner must never need one. The
 * window the token defended — the minutes between the installer finishing and the owner opening a
 * browser on their own home network — did not justify making every single installation start with
 * an SSH session.
 *
 * What still holds, and is the real lock: the claim is SINGLE-SHOT. `claim_system_setup` is a
 * database singleton — the first claim wins, every later one gets `already-complete`, and nothing
 * reopens it. The residual risk is honest and small: someone else on the same LAN claiming the
 * box in that window. The wizard says what to do about it ("bu cihazı siz kurmadıysanız fişini
 * çekin ve yeniden kurun"), and the claim lands in the audit trail as the box's first entry.
 */
@Injectable()
export class SetupService implements OnModuleInit {
  private readonly logger = new Logger(SetupService.name);

  constructor(
    private readonly db: DbService,
    private readonly passwords: PasswordService,
    private readonly identity: IdentitySyncService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (await this.isComplete()) {
      this.logger.log('setup is complete; setup endpoints are closed');
      return;
    }
    // Loud on purpose, secret-free by design: whoever reads the journal learns only what the
    // browser would also tell them.
    this.logger.warn(
      'DEPSIS is not set up yet. Open the web interface: the first account created there ' +
        'becomes the administrator, once, and then setup closes forever.',
    );
  }

  /** Whether the setup endpoints should still answer. */
  async isComplete(): Promise<boolean> {
    const rows = await this.db.withoutTenant('setup-status', (q) =>
      q.query<{ done: boolean }>('SELECT public.is_setup_complete() AS done'),
    );
    return rows[0]?.done === true;
  }

  async claim(request: ClaimRequest): Promise<ClaimResult> {
    if (await this.isComplete()) return { outcome: 'already-complete' };

    const invalid = validate(request);
    if (invalid !== null) return { outcome: 'invalid', reason: invalid };

    const hash = await this.passwords.hash(request.adminPassword);

    try {
      const rows = await this.db.withoutTenant('setup-status', (q) =>
        q.query<{ organization_id: string; user_id: string }>(
          `SELECT organization_id::text AS organization_id, user_id::text AS user_id
             FROM public.claim_system_setup($1, $2, $3, $4)`,
          [request.organizationSlug, request.organizationName, request.adminUsername, hash],
        ),
      );

      const row = rows[0];
      if (row === undefined) return { outcome: 'already-complete' };

      // SMB KİMLİĞİ DE BURADA, ve olmaması bir hataydı.
      //
      // NT hash'i parola AYARLANIRKEN türetiliyor — düz metin yalnız o an elde. `users.service`
      // hesap oluştururken ve parola sıfırlarken bunu yapıyordu; kurucu yönetici, yani her
      // cihazın İLK hesabı, atlanmıştı. Sonucu sessizdi: hesap her yerde çalışıyor, yalnız
      // Windows hiçbir zaman kabul etmeyeceği bir kimlik penceresi gösteriyor, ve sebebi hiçbir
      // ekranda yazmıyordu.
      //
      // `CurrentUser.smbReady` bunu ortaya çıkardı: kurulum sihirbazının açtığı hesapta false
      // dönüyordu.
      //
      // Kendi işleminde ve YUTULARAK: SMB kimliği yazılamaması, cihazın sahiplenilmemesine yol
      // açmamalı — kurulum bir kez çalışıyor ve yarıda kalması onu geri alınamaz biçimde bozardı.
      // Kaybedilen şey SMB erişimi, ve onu geri getirmenin yolu parolayı bir kez değiştirmek.
      try {
        await this.db.withTenant(row.organization_id, (q) =>
          this.identity.rememberPassword(
            q,
            row.organization_id,
            row.user_id,
            request.adminPassword,
          ),
        );
      } catch (error) {
        this.logger.warn(
          `the founding administrator has no SMB credential yet: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      // ── VE EŞİTLEME KUYRUĞA ALINIYOR ────────────────────────────────────────────────────
      //
      // Bir öncekinin yarısı eksikti ve sahada bedeli şu oldu: NT özeti veritabanına yazıldı,
      // ama onu Samba'ya taşıyacak iş HİÇ kuyruğa girmedi. Sonuç, kutuda tek bir Samba hesabı
      // olmaması — `pdbedit -L` bomboş — ve Windows'un ağ sürücüsü bağlarken "belirtilen ağ
      // parolası geçersiz (86)" demesi. Parola doğruydu; karşılığı olan hesap yoktu.
      //
      // Kullanıcı oluşturma ve parola değiştirme yolları bunu zaten yapıyordu; kurucu yönetici,
      // yani her cihazın İLK ve çoğu zaman TEK hesabı, yine atlanmıştı.
      //
      // PAROLA ADIMI DÜŞSE BİLE ÇALIŞIYOR, ve bu yüzden `try` bloğunun dışında: Unix hesabı ile
      // gruplar, SMB kimliğinden bağımsız olarak var olmalı — izinleri diske yazan ACL'ler o
      // numaraları adlandırıyor.
      await this.identity.enqueue(row.organization_id, 'the founding administrator');

      this.logger.warn(`setup completed: organization ${row.organization_id}`);

      return { outcome: 'ok', organizationId: row.organization_id, userId: row.user_id };
    } catch (error) {
      // `object_not_in_prerequisite_state` is what `claim_system_setup` raises when it finds the
      // singleton already present — a race lost, not a failure worth a 500.
      if (isAlreadyComplete(error)) return { outcome: 'already-complete' };
      throw error;
    }
  }
}

function isAlreadyComplete(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    // 55000 object_not_in_prerequisite_state, or 23505 if two claims race past the check and
    // collide on the singleton primary key. Both mean the same thing to a caller.
    (error.code === '55000' || error.code === '23505')
  );
}

/**
 * Validation with reasons, unlike the login path.
 *
 * Login refuses everything identically so a caller cannot learn which half they got right. Setup is
 * the opposite: the person on the other end is the machine's owner, typing carefully into a form
 * once, and a bare "invalid" would leave them guessing which of five fields the server disliked.
 */
function validate(request: ClaimRequest): string | null {
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(request.organizationSlug)) {
    return 'organizationSlug must be lowercase letters, digits and hyphens, and cannot start or end with a hyphen';
  }
  if (request.organizationName.trim().length === 0) return 'organizationName is required';
  // The same shape the database enforces (migration 0010): letters, digits, dot, dash and
  // underscore, and no '@'. A username that looks like an address is one a person or a future
  // parser can mistake for one.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(request.adminUsername)) {
    return 'adminUsername may contain letters, digits, dot, dash and underscore only';
  }

  // A length floor and nothing else. A composition rule ("one uppercase, one digit, one symbol")
  // shrinks the search space more often than it grows it, and NIST SP 800-63B dropped the advice
  // for that reason. Length is what buys entropy from a human.
  if (request.adminPassword.length < 12) {
    return 'adminPassword must be at least 12 characters';
  }
  if (request.adminPassword.length > 1024) return 'adminPassword is too long';
  return null;
}
