import { Injectable } from '@nestjs/common';

import { DbService } from '../db/db.service.js';
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

/**
 * Accounts inside one organisation.
 *
 * Every method takes the organisation from the caller's session and never from a request field
 * (ADR-0015 §6), and RLS makes that structural rather than a convention: a query with the wrong
 * tenant context returns nothing at all.
 */
@Injectable()
export class UsersService {
  constructor(private readonly db: DbService) {}

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
   * Create an account.
   *
   * `passwordHash`, never a password: hashing belongs to `PasswordService` and a plaintext
   * parameter here is a plaintext value in a stack trace, a slow-query log and an error report.
   */
  async create(
    organizationId: string,
    username: string,
    role: UserRole,
    passwordHash: string,
  ): Promise<UserRow> {
    try {
      const rows = await this.db.withTenant(organizationId, (db) =>
        db.query<UserRow>(
          `INSERT INTO public.users (organization_id, username, role, password_hash)
           VALUES ($1, $2, $3, $4)
           RETURNING id::text AS id, username, email, role, disabled_at, created_at`,
          [organizationId, username, role, passwordHash],
        ),
      );
      const row = rows[0];
      if (!row) throw new Error('the user row was not returned');
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

  /** Replace a user's own password hash. */
  async setPasswordHash(organizationId: string, id: string, hash: string): Promise<void> {
    await this.db.withTenant(organizationId, (db) =>
      db.query(
        `UPDATE public.users SET password_hash = $3 WHERE organization_id = $1 AND id = $2`,
        [organizationId, id, hash],
      ),
    );
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
