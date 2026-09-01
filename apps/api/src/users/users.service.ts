import { Injectable } from '@nestjs/common';

import { AgentService } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import { IdentitySyncService } from '../identity/identity-sync.service.js';
import { PosixIdentityService } from '../identity/posix.service.js';
import type { UserRole } from '../auth/session.service.js';

export interface UserRow {
  id: string;
  username: string;
  email: string | null;
  role: string;
  disabled_at: Date | null;
  created_at: Date;
}

/** The username is already taken inside this organisation. */
export class UsernameTakenError extends Error {
  constructor() {
    super('that username is already in use here');
    this.name = 'UsernameTakenError';
  }
}

/** No such account, or it belongs to another tenant — deliberately one answer. */
export class UserNotFoundError extends Error {
  constructor() {
    super('no such user');
    this.name = 'UserNotFoundError';
  }
}

/**
 * The change would leave the organisation with no usable administrator.
 *
 * Raised from the database's own trigger rather than from a count taken here. Two administrators
 * demoting each other at the same moment both read "there are two of us" and both proceed; the
 * trigger runs inside the writing transaction, so the second one sees the first.
 */
export class LastAdminError extends Error {
  constructor() {
    super('an organization must keep at least one enabled administrator');
    this.name = 'LastAdminError';
  }
}

/** Silinmek istenen hesap, isteği yapan hesabın kendisi. */
export class CannotDeleteSelfError extends Error {
  constructor() {
    super('bir yönetici kendi hesabını silemez');
    this.name = 'CannotDeleteSelfError';
  }
}

/**
 * Hesabın kutudaki Unix/Samba karşılığı kaldırılamadı, o yüzden satır da silinmedi.
 *
 * SIRA BURADA BİR TASARIM: önce kutu, sonra veritabanı. Tersi olsaydı ve ajan cevap veremeseydi,
 * DEPSIS'te var olmayan bir kullanıcının SMB parolası çalışmaya devam ederdi — ve bunu kimse
 * göremezdi, çünkü kullanıcı listesinde o hesap artık yok.
 */
export class IdentityStillOnBoxError extends Error {
  constructor(readonly detail: string) {
    super(`hesabın sistem üzerindeki karşılığı kaldırılamadı: ${detail}`);
    this.name = 'IdentityStillOnBoxError';
  }
}

/**
 * Accounts inside one organisation.
 *
 * Every method takes the organisation from the caller's session and never from a request field
 * (ADR-0015 §6), and RLS makes that structural rather than a convention: a query with the wrong
 * tenant context returns nothing at all.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly db: DbService,
    /**
     * For the SMB credential, and only that.
     *
     * `UsersService` owns the moment a password is set, and that is the only instant the plaintext
     * exists — Argon2 is one-way, so an NT hash not captured here can never be recovered. The seal
     * happens inside this service's transaction rather than in a caller afterwards, so the web
     * password and the SMB password cannot end up describing different secrets.
     */
    private readonly identity: IdentitySyncService,
    /**
     * Silme için, ve yalnızca onun için.
     *
     * Hesap oluşturma ve parola değiştirme eşitlemeyi KUYRUĞA veriyor: işçi kendi ajan bağlantısıyla
     * ve kendi yeniden denemeleriyle koşuyor, ve geciken bir Unix hesabı kimseyi tehlikeye atmıyor.
     * Silme öyle değil — geciken bir silme, DEPSIS'ten kaldırılmış bir kullanıcının SMB parolasının
     * çalışmaya devam etmesi demek. O yüzden bu tek işlem isteğin içinde koşuyor ve başarısız
     * olursa satır da silinmiyor.
     */
    private readonly agent: AgentService,
  ) {}

  async list(organizationId: string): Promise<UserRow[]> {
    return this.db.withTenant(organizationId, (db) =>
      db.query<UserRow>(
        `SELECT id::text AS id, username, email, role, disabled_at, created_at
           FROM public.users
          WHERE organization_id = $1
          ORDER BY created_at`,
        [organizationId],
      ),
    );
  }

  /**
   * Adlar ve kimlikler, izin verilecek kişiyi seçebilmek için.
   *
   * `list`'in daraltılmış hâli DEĞİL, ayrı bir sorgu: `list` yöneticinin gördüğü her sütunu
   * seçiyor ve buradan çağrılsaydı rolü de e-postayı da okuyup sonra atmış olurduk. Bir sütun
   * sorulmuyorsa yanlışlıkla da dönemez.
   */
  async directory(organizationId: string): Promise<Array<{ id: string; username: string }>> {
    return this.db.withTenant(organizationId, (db) =>
      db.query<{ id: string; username: string }>(
        `SELECT id::text AS id, username
           FROM public.users
          WHERE organization_id = $1
          ORDER BY username`,
        [organizationId],
      ),
    );
  }

  async find(organizationId: string, id: string): Promise<UserRow> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<UserRow>(
        `SELECT id::text AS id, username, email, role, disabled_at, created_at
           FROM public.users
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, id],
      ),
    );
    const row = rows[0];
    if (!row) throw new UserNotFoundError();
    return row;
  }

  /**
   * One account, with the hash a confirmation check needs.
   *
   * Separate from `find` rather than a column added to it: `UserRow` is what `toUser` turns into an
   * API response, and a password hash on that type is one careless spread away from being served.
   * The two callers that need the hash ask for it by name.
   */
  async findWithHash(
    organizationId: string,
    id: string,
  ): Promise<(UserRow & { password_hash: string | null }) | null> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<UserRow & { password_hash: string | null }>(
        `SELECT id::text AS id, username, email, role, disabled_at, created_at, password_hash
           FROM public.users
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, id],
      ),
    );
    return rows[0] ?? null;
  }

  /**
   * Create an account.
   *
   * `passwordHash`, never a password: hashing belongs to `PasswordService` and a plaintext
   * parameter here is a plaintext value in a stack trace, a slow-query log and an error report.
   *
   * The POSIX uid is allocated HERE, in the transaction that writes the row, so that an account
   * that exists always has one. `PosixIdentityService` can still allocate lazily and has to —
   * every account created before migration 0015 has a null `posix_uid` — but "allocated at
   * creation" is the rule that keeps the lazy path off the hot path of an upload, and it is the
   * only ordering in which the id and the account cannot be committed apart. The allocation takes
   * a device-wide advisory lock; see the constant in `posix.service.ts` for why `MAX + 1` is not
   * safe on its own.
   */
  async create(
    organizationId: string,
    username: string,
    role: UserRole,
    passwordHash: string,
    /**
     * The plaintext, for the SMB credential only.
     *
     * OPTIONAL, and the asymmetry with `passwordHash` is deliberate rather than sloppy: Argon2 is
     * one-way, so the NT hash Samba needs can only be computed at the instant the password exists.
     * A caller that has it should pass it; one that does not — a fixture, a future import path —
     * creates an account that works everywhere except SMB, which is honest rather than broken.
     *
     * It is sealed in the SAME TRANSACTION as the row. Two transactions would let a commit store
     * one password and lose the other, leaving a user whose web and SMB passwords disagree with
     * nothing recording which is which.
     */
    password?: string,
  ): Promise<UserRow> {
    try {
      const rows = await this.db.withTenant(organizationId, async (db) => {
        const posixUid = await PosixIdentityService.allocateWithin(db, 'user');
        const created = await db.query<UserRow>(
          `INSERT INTO public.users (organization_id, username, role, password_hash, posix_uid)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id::text AS id, username, email, role, disabled_at, created_at`,
          [organizationId, username, role, passwordHash, posixUid],
        );
        const row = created[0];
        if (row !== undefined && password !== undefined) {
          await this.identity.rememberPassword(db, organizationId, row.id, password);
        }
        // 'Herkes' taraması, hesabın doğduğu anda ve aynı işlemde. Fonksiyon bütün kullanıcıları
        // üye yapar ama yalnız ÇAĞRILDIĞINDA — ve ilk saha bunun eksiğini ölçtü: paylaşım
        // kurulduktan SONRA açılan hesap hiçbir çağrının kapsamına girmedi, takımsız kaldı, ve
        // "herkes görür" diye açılmış paylaşımı ne SMB'den ne arayüzden görebildi.
        await db.query(`SELECT public.everyone_team($1)`, [organizationId]);
        return created;
      });
      const row = rows[0];
      if (!row) throw new Error('the user row was not returned');
      // After the transaction, never inside it: `JobsService.enqueue` opens its own tenant
      // transaction. The same ordering every other enqueue in this codebase uses.
      await this.identity.enqueue(organizationId, `creating the account '${username}'`);
      return row;
    } catch (error) {
      throw translateDbError(error);
    }
  }

  /**
   * Change what an administrator is allowed to change about somebody else.
   *
   * Deliberately NOT the password and NOT the email. A password set by an administrator is a
   * password the administrator knows, which turns every account into one they can impersonate
   * without leaving a trace an audit can distinguish from the user's own sign-in; and changing an
   * address silently moves where a password reset would be sent. Both need a flow of their own.
   */
  async update(
    organizationId: string,
    id: string,
    // `| undefined` on every field, because `exactOptionalPropertyTypes` distinguishes "absent"
    // from "present and undefined" — and zod's `.optional()` produces the second.
    changes: {
      role?: UserRole | undefined;
      disabled?: boolean | undefined;
    },
  ): Promise<UserRow> {
    const sets: string[] = [];
    const params: unknown[] = [organizationId, id];

    if (changes.role !== undefined) {
      params.push(changes.role);
      sets.push(`role = $${params.length}`);
    }
    if (changes.disabled !== undefined) {
      // `now()` or NULL rather than a boolean column: WHEN an account was disabled is the question
      // an audit asks, and a boolean cannot answer it.
      sets.push(changes.disabled ? `disabled_at = now()` : `disabled_at = NULL`);
    }
    if (sets.length === 0) return this.find(organizationId, id);

    try {
      const rows = await this.db.withTenant(organizationId, (db) =>
        db.query<UserRow>(
          `UPDATE public.users SET ${sets.join(', ')}
            WHERE organization_id = $1 AND id = $2
            RETURNING id::text AS id, email, role, disabled_at, created_at`,
          params,
        ),
      );
      const row = rows[0];
      if (!row) throw new UserNotFoundError();
      return row;
    } catch (error) {
      throw translateDbError(error);
    }
  }

  /**
   * Bir hesabı tamamen kaldırır.
   *
   * ── SIRA ────────────────────────────────────────────────────────────────────────────────────
   *
   * 1. Yarım yüklemelerin ara dosyaları atılıyor (elden geldiğince).
   * 2. Kutudaki Unix hesabı ve Samba kaydı kaldırılıyor — BAŞARISIZ OLURSA HİÇBİR ŞEY SİLİNMİYOR.
   * 3. Satır siliniyor, ve aynı işlemde POSIX numarası emekli ediliyor.
   *
   * İkinci adımın önce gelmesi bu fonksiyonun en önemli kararı. Tersi olsaydı ve ajan o an cevap
   * veremeseydi, DEPSIS'te artık var olmayan bir kullanıcının SMB parolası çalışmaya devam eder,
   * ve bunu kimse fark edemezdi: kullanıcı listesinde o hesap yok.
   *
   * Üçüncü adım başarısız olursa kutuda hesabı olmayan bir satır kalıyor — ve bu, tersinin aksine,
   * kendi kendini onaran bir durum: bir sonraki kimlik eşitlemesi hesabı yeniden kuruyor.
   *
   * ── EMEKLİ NUMARA ───────────────────────────────────────────────────────────────────────────
   *
   * Silme ile aynı işlemde. `allocate_posix_id` bir sonraki numarayı `MAX + 1` ile buluyor, yani
   * satır gidince numara serbest kalıyor — ve silinen kullanıcının dosyaları diskte hâlâ o
   * numarayla damgalı. İki yazma arasında bir hesap açılabilseydi, o hesap hiç görmediği
   * dosyaların sahibi olurdu.
   */
  async remove(
    organizationId: string,
    id: string,
    reason: string,
  ): Promise<{ username: string; posixUid: number | null }> {
    const doomed = await this.find(organizationId, id);
    const posix = await this.db.withTenant(organizationId, (db) =>
      db.query<{ posix_uid: number | null }>(
        `SELECT posix_uid FROM public.users WHERE organization_id = $1 AND id = $2`,
        [organizationId, id],
      ),
    );
    const posixUid = posix[0]?.posix_uid ?? null;

    await this.discardStagedUploads(organizationId, id, reason);

    if (posixUid !== null) {
      const response = await this.agent
        .call({ op: 'remove_posix_identity', uid: posixUid, login: doomed.username }, reason)
        .catch((error: unknown) => {
          throw new IdentityStillOnBoxError(error instanceof Error ? error.message : String(error));
        });
      // `smb_unavailable` de bir RET burada, ve `sync`teki gibi bir 503 değil: Samba kurulu
      // değilse silinecek bir kimlik bilgisi de yoktur, ama bunu ajanın kendisi söylüyor ve
      // Unix hesabının gidip gitmediğini söylemiyor. Emin olunmayan tek durum bu.
      if (response.status !== 'posix_identity_removed') {
        throw new IdentityStillOnBoxError(
          'reason' in response && typeof response.reason === 'string'
            ? response.reason
            : response.status,
        );
      }
    }

    try {
      await this.db.withTenant(organizationId, async (db) => {
        // Kurucu kaydı BAŞKA BİR YÖNETİCİYE devrediliyor. `system_setup.admin_user_id` yalnızca
        // "kutuyu kim kurdu" diye tarihsel bir not değil, `isSystemAdministrator`in tek ölçütü:
        // NULL kalsaydı konsola kimse giremezdi. Kimin devralacağı, kalan en eski açık yönetici —
        // ve bir tane olduğu garanti, çünkü son yöneticiyi silmeyi tetikleyici zaten reddediyor.
        await db.query(
          `UPDATE public.system_setup
              SET admin_user_id = (
                    SELECT u.id FROM public.users u
                     WHERE u.organization_id = $1 AND u.role = 'admin'
                       AND u.disabled_at IS NULL AND u.id <> $2
                     ORDER BY u.created_at
                     LIMIT 1)
            WHERE admin_user_id = $2`,
          [organizationId, id],
        );
        await db.query(`DELETE FROM public.users WHERE organization_id = $1 AND id = $2`, [
          organizationId,
          id,
        ]);
        if (posixUid !== null) {
          await db.query(
            `INSERT INTO public.retired_posix_ids (id_value, note)
                  VALUES ($1, $2)
             ON CONFLICT (id_value) DO NOTHING`,
            [posixUid, 'silinen hesap'],
          );
        }
      });
    } catch (error) {
      throw translateDbError(error);
    }

    return { username: doomed.username, posixUid };
  }

  /**
   * Silinecek hesabın yarım yüklemelerinin ara dosyalarını attırır.
   *
   * ELDEN GELDİĞİNCE, ve bu bilerek: satırları göç 0049'un CASCADE'i zaten götürüyor, geriye
   * kalabilecek şey ara alandaki bir `.part`. Bir baytlık çöp için silme isteğini reddetmek,
   * kullanıcıya çözemeyeceği bir engel çıkarmak olurdu — ajan o an cevap vermiyorsa bile hesabın
   * gitmesi gerekiyor.
   */
  private async discardStagedUploads(
    organizationId: string,
    id: string,
    reason: string,
  ): Promise<void> {
    const staged = await this.db.withTenant(organizationId, (db) =>
      db.query<{ share: string; staging_name: string }>(
        `SELECT s.name AS share, u.staging_name
           FROM public.upload_sessions u
           JOIN public.shares s ON s.id = u.share_id
          WHERE u.organization_id = $1 AND u.created_by = $2 AND u.completed_at IS NULL`,
        [organizationId, id],
      ),
    );
    for (const row of staged) {
      await this.agent
        .call({ op: 'discard_transfer', share: row.share, staging_name: row.staging_name }, reason)
        .catch(() => undefined);
    }
  }

  /**
   * Replace a user's password hash, and the SMB credential that goes with it.
   *
   * `password` is optional for the reason it is on `create`: only a caller holding the plaintext
   * can produce an NT hash, and one that cannot should still be able to set the web password. Both
   * writes are in ONE transaction so the two can never disagree.
   */
  async setPasswordHash(
    organizationId: string,
    id: string,
    hash: string,
    password?: string,
  ): Promise<void> {
    await this.db.withTenant(organizationId, async (db) => {
      await db.query(
        `UPDATE public.users SET password_hash = $3 WHERE organization_id = $1 AND id = $2`,
        [organizationId, id, hash],
      );
      if (password !== undefined) {
        await this.identity.rememberPassword(db, organizationId, id, password);
      }
    });
    // Only when a plaintext was supplied: without one the SMB credential did not change, so there
    // is nothing for the agent to install and a job would be pure noise.
    if (password !== undefined) {
      await this.identity.enqueue(organizationId, `resetting the password for ${id}`);
    }
  }
}

/**
 * PostgreSQL's SQLSTATE, not its message.
 *
 * The message carries the constraint name and is localised by the server's `lc_messages`: a box
 * installed in Turkish would stop producing 409s and start producing 500s, and nothing in this
 * repository would notice until somebody tried it.
 */
function translateDbError(error: unknown): Error {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: string }).code;
    if (code === '23505') return new UsernameTakenError();
    // `restrict_violation`, raised by the `users_keep_one_admin` trigger in migration 0009.
    if (code === '23001') return new LastAdminError();
  }
  return error instanceof Error ? error : new Error(String(error));
}
