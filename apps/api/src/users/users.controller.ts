import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service.js';
import { requireSameOrigin } from '../auth/origin.js';
import { PasswordResetService } from '../auth/password-reset.service.js';
import { PasswordService } from '../auth/password.service.js';
import { AdminGuard, SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { SessionService } from '../auth/session.service.js';
import {
  CannotDeleteSelfError,
  IdentityStillOnBoxError,
  UsernameTakenError,
  LastAdminError,
  UserNotFoundError,
  UsersService,
  type UserRow,
} from './users.service.js';

type Schemas = OpenApi.components['schemas'];

/**
 * The password floor.
 *
 * A length rule and nothing else. A composition rule ("one digit, one symbol") measurably pushes
 * people towards `Passw0rd!` and buys less than four more characters would; the master prompt's
 * §13 asks for strength, not for theatre.
 */
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 1024;

const createSchema = z.object({
  username: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  role: z.enum(['admin', 'member']).default('member'),
  password: z.string().min(MIN_PASSWORD).max(MAX_PASSWORD),
});

/** The caller's own password, asked for before anything dangerous. */
const confirmSchema = z.object({ password: z.string().min(1).max(MAX_PASSWORD) });

const updateSchema = z
  .object({
    role: z.enum(['admin', 'member']).optional(),
    disabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to change' });

/**
 * Accounts, for administrators.
 *
 * `AdminGuard` sits behind `SessionGuard` on every route: one place turns a cookie into an
 * identity, and a second decides whether that identity may be here. Splitting them is what lets
 * the second one be added to an endpoint without touching how sessions work.
 */
@Controller('users')
@UseGuards(SessionGuard, AdminGuard)
export class UsersController {
  private readonly logger = new Logger(UsersController.name);

  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly resets: PasswordResetService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<{ items: Schemas['User'][] }> {
    const session = requireSession(request);
    const rows = await this.users.list(session.organizationId);
    return { items: rows.map(toUser) };
  }

  @Post()
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['User']> {
    requireSameOrigin(request);
    const session = requireSession(request);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        `username and a password of at least ${MIN_PASSWORD} characters are required`,
      );
    }

    const hash = await this.passwords.hash(parsed.data.password);
    try {
      const row = await this.users.create(
        session.organizationId,
        parsed.data.username,
        parsed.data.role,
        hash,
        // The plaintext, for the SMB credential. This is the only moment it exists — Argon2 is
        // one-way — and it is sealed inside the same transaction as the row.
        parsed.data.password,
      );
      await this.audit.record(session.organizationId, {
        actorId: session.userId,
        action: 'user.created',
        target: { kind: 'user', id: row.id, label: row.username },
        summary: `'${row.username}' hesabı ${parsed.data.role === 'admin' ? 'YÖNETİCİ' : 'üye'} rolüyle açıldı.`,
      });
      return toUser(row);
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * Open a password reset for somebody who cannot sign in.
   *
   * THE ADMINISTRATOR DOES NOT CHOOSE THE PASSWORD, and `PATCH /users/{id}` says why it must not:
   * "a password the administrator sets is a password the administrator knows — it makes every
   * account impersonable in a way indistinguishable in the audit." What comes back here is a
   * one-time value to hand over; the user chooses the password themselves.
   *
   * THE ADMINISTRATOR'S OWN PASSWORD IS REQUIRED. A session is what somebody has when they borrow
   * an unlocked laptop, and this endpoint is the single most useful thing to find on a borrowed
   * one — it opens a door into any account on the box. `/me/password` and `DELETE /me/mfa` already
   * ask for the same reason.
   *
   * The token is shown ONCE. It is stored as a SHA-256 digest, so this response is the only place
   * the value exists; there is no second endpoint that can read it back.
   */
  @Post(':id/password-reset')
  @HttpCode(201)
  async openPasswordReset(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Schemas['PasswordResetTicket']> {
    requireSameOrigin(request);
    const session = requireSession(request);
    const parsed = confirmSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('your own password is required');

    const me = await this.users.findWithHash(session.organizationId, session.userId);
    if (me === null || !(await this.passwords.verify(me.password_hash, parsed.data.password))) {
      throw new UnauthorizedException('your password is wrong');
    }

    // Refused for oneself, and not as a safety rail: `/me/password` already does this properly,
    // asking for the current password and LEAVING the current session alive. Redeeming a ticket
    // revokes every session of the target, so an administrator resetting themselves this way would
    // sign themselves out mid-way through the thing they were doing.
    if (id === session.userId) {
      throw new ConflictException('use /me/password to change your own password');
    }

    // Proves the account exists and belongs to this tenant before a row is written. Without it a
    // reset could be opened against a uuid from another organisation and the foreign key would be
    // the only thing that noticed — as a 500.
    const target = await this.users.find(session.organizationId, id).catch((error: unknown) => {
      throw translate(error);
    });

    const issued = await this.resets.open(session.organizationId, id, session.userId);
    // Jetonun KENDİSİ değil, açıldığı gerçeği. §16: denetimde sır olmaz — ve bu satırın işi tam
    // olarak "birinin hesabına giden bir kapı açıldı" demek, kapının anahtarını saklamak değil.
    await this.audit.record(session.organizationId, {
      actorId: session.userId,
      action: 'user.password-reset-issued',
      target: { kind: 'user', id, label: target.username },
      summary: `'${target.username}' için tek kullanımlık parola sıfırlama bileti açıldı.`,
    });
    this.logger.warn(
      `password reset opened for '${target.username}' by '${session.userId}'; ` +
        `it expires at ${issued.expiresAt.toISOString()}`,
    );
    return { token: issued.token, expiresAt: issued.expiresAt.toISOString() };
  }

  /**
   * Hesabı tamamen kaldırır.
   *
   * ── NEDEN VAR ───────────────────────────────────────────────────────────────────────────────
   *
   * Cihazın sahibinin cümlesi: *"kullanıcılar kısmında kullanıcı sadece devredışı bırakılabiliniyor
   * silinebilmeli."* Ekranda gerçekten yalnız kapatma vardı, çünkü şemada `users` satırına RESTRICT
   * ile bağlı üç yabancı anahtar duruyordu. Göç 0049 üçünü de kaldırdı.
   *
   * ── PAROLA YENİDEN İSTENİYOR ────────────────────────────────────────────────────────────────
   *
   * `DELETE /me/mfa` ile aynı §0.5 gerekçesi: geri dönüşü olmayan bir işlem sessizce yapılmaz.
   * Açık bırakılmış bir yönetici oturumunun başına oturan biri, tek tıkla hesap silememeli.
   *
   * ── KENDİ HESABI OLMAZ ──────────────────────────────────────────────────────────────────────
   *
   * Silen kişi kendini silemiyor, ve bu son yönetici kuralından ayrı bir kural: iki yönetici varken
   * bile kendi hesabını silen biri, isteğin ortasında oturumunu kaybediyor ve geri dönemiyor.
   *
   * ── NE SİLİNİYOR ────────────────────────────────────────────────────────────────────────────
   *
   * Hesap, oturumları, ikinci faktörü, ekip üyelikleri, klasör hibeleri, yarım yüklemeleri — ve
   * kutudaki Unix hesabı ile Samba kaydı. DOSYALARI DEĞİL: bir hesabı silmek, o hesabın yüklediği
   * dosyaları silmek değil, ve öyle olsaydı bir kullanıcıyı çıkarmanın bedeli şirketin verisi
   * olurdu. Dosyalar yerinde kalıyor; sahiplerinin numarası ise bir daha dağıtılmıyor.
   */
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<void> {
    requireSameOrigin(request);
    const session = requireSession(request);
    const parsed = confirmSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('your own password is required');

    const me = await this.users.findWithHash(session.organizationId, session.userId);
    if (me === null || !(await this.passwords.verify(me.password_hash, parsed.data.password))) {
      throw new UnauthorizedException('your password is wrong');
    }
    if (id === session.userId) throw translate(new CannotDeleteSelfError());

    const removed = await this.users
      .remove(session.organizationId, id, `DELETE /users/${id}`)
      .catch((error: unknown) => {
        throw translate(error);
      });

    // Kayıt İŞTEN SONRA, ve hedefin kimliği artık yalnız burada: satır gitti, yani denetimin
    // taşıdığı ad silinen hesabın son adı. `target.id` yine de yazılıyor — o kimlikle açılmış
    // eski kayıtlarla aynı iple bağlanabilsin diye.
    await this.audit.record(session.organizationId, {
      actorId: session.userId,
      action: 'user.deleted',
      target: { kind: 'user', id, label: removed.username },
      summary:
        `'${removed.username}' hesabı KALICI olarak silindi; oturumları, SMB erişimi ve ` +
        `sistem hesabı kaldırıldı. Dosyaları yerinde duruyor.`,
    });
    this.logger.warn(`user '${removed.username}' deleted by '${session.userId}'`);
  }

  @Patch(':id')
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Schemas['User']> {
    requireSameOrigin(request);
    const session = requireSession(request);
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('nothing to change');

    // Refused here rather than left to the database's trigger, because the trigger cannot tell
    // this case from the general one and its message would not explain it. An administrator who
    // disables their own account is signed out by the next request with no way back in — and if
    // they are the only administrator the box is unrecoverable, which the trigger does catch.
    if (id === session.userId && parsed.data.disabled === true) {
      throw new ForbiddenException('an administrator cannot disable their own account');
    }

    try {
      const row = await this.users.update(session.organizationId, id, parsed.data);

      if (parsed.data.role !== undefined) {
        await this.audit.record(session.organizationId, {
          actorId: session.userId,
          action: 'user.role-changed',
          target: { kind: 'user', id: row.id, label: row.username },
          summary:
            parsed.data.role === 'admin'
              ? `'${row.username}' YÖNETİCİ yapıldı.`
              : `'${row.username}' üye rolüne indirildi.`,
        });
      }
      // A disabled account's sessions have to stop working NOW. `resolve_session` already refuses
      // them — it joins `users` and checks `disabled_at` — so this is not what closes the hole; it
      // is what makes the rows say what happened, so an audit does not have to infer a revocation
      // from a column on another table.
      if (parsed.data.disabled === true) {
        await this.sessions.revokeAllForUser(session.organizationId, id);
      }
      // Kayıt iptalden SONRA: özet "oturumları sonlandırıldı" diyor, ve bunu ancak olduktan
      // sonra diyebilir.
      if (parsed.data.disabled !== undefined) {
        await this.audit.record(session.organizationId, {
          actorId: session.userId,
          action: parsed.data.disabled ? 'user.disabled' : 'user.enabled',
          target: { kind: 'user', id: row.id, label: row.username },
          summary: parsed.data.disabled
            ? `'${row.username}' hesabı kapatıldı; oturumları sonlandırıldı.`
            : `'${row.username}' hesabı yeniden açıldı.`,
        });
      }
      return toUser(row);
    } catch (error) {
      throw translate(error);
    }
  }
}

export function toUser(row: UserRow): Schemas['User'] {
  return {
    id: row.id,
    username: row.username,
    role: row.role === 'admin' ? 'admin' : 'member',
    disabled: row.disabled_at !== null,
    createdAt: row.created_at.toISOString(),
  };
}

function requireSession(request: AuthenticatedRequest): {
  organizationId: string;
  userId: string;
} {
  const session = request.depsis;
  if (session === undefined) throw new UnauthorizedException();
  return { organizationId: session.organizationId, userId: session.userId };
}

function translate(error: unknown): Error {
  if (error instanceof UserNotFoundError) return new NotFoundException();
  if (error instanceof UsernameTakenError) return new ConflictException(error.message);
  // 409, not 400: the request is well formed and would be legal at almost any other moment. What
  // refuses it is the state of the organisation.
  if (error instanceof LastAdminError) return new ConflictException(error.message);
  if (error instanceof CannotDeleteSelfError) return new ForbiddenException(error.message);
  // 503 ve 500 DEĞİL: silme başarısız oldu çünkü kutuya ulaşılamadı, ve bu geçici bir durum —
  // çağıranın yapması gereken şey yeniden denemek. Hesap olduğu gibi duruyor.
  if (error instanceof IdentityStillOnBoxError) {
    return new ServiceUnavailableException(error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}
