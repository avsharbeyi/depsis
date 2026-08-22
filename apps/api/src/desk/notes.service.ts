import { Injectable } from '@nestjs/common';

import { DbService } from '../db/db.service.js';

export interface NoteRow {
  id: string;
  title: string;
  body: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * No such note — or it belongs to another tenant, or to another person in this tenant.
 *
 * Deliberately one error for all three. Splitting them would let a caller ask "does note X exist"
 * and get a different answer for "no" than for "not yours", and the list of what notes exist is
 * exactly what a private notepad must not hand out.
 */
export class NoteNotFoundError extends Error {
  constructor() {
    super('no such note');
    this.name = 'NoteNotFoundError';
  }
}

/**
 * The database refused the row on a CHECK — an empty title, or a body past 64 KiB.
 *
 * Raised from SQLSTATE 23514 rather than inferred from the message: migration 0012 owns those
 * bounds, and a copy of them here that drifted would turn a refusal into a 500.
 */
export class NoteRejectedError extends Error {
  constructor() {
    super('a note needs a title of at most 200 characters and a body of at most 65536');
    this.name = 'NoteRejectedError';
  }
}

const COLUMNS = `id::text AS id, title, body, created_at, updated_at`;

/**
 * Notes, which are private to the person who wrote them.
 *
 * RLS separates tenants and does nothing else here: migration 0012's policy on `public.notes`
 * tests `organization_id` only, so INSIDE one organisation every note is visible to every query
 * the policy admits. What separates one household member from another is the `author_id = $2`
 * predicate carried by every statement below — and if it is ever dropped from one of them, that
 * statement shows (or edits, or deletes) everybody's notes without failing anywhere. That is why
 * the author id is a required parameter of every method rather than an optional filter.
 *
 * The tenant still comes from the session and never from a request field (ADR-0015 §6), so both
 * halves hold at once: the policy is the wall between tenants, this predicate is the wall inside
 * one.
 */
@Injectable()
export class NotesService {
  constructor(private readonly db: DbService) {}

  /** One author's notes, most recently edited first — the order the sidebar reads them in. */
  async list(organizationId: string, authorId: string): Promise<NoteRow[]> {
    return this.db.withTenant(organizationId, (db) =>
      db.query<NoteRow>(
        `SELECT ${COLUMNS}
           FROM public.notes
          WHERE organization_id = $1 AND author_id = $2
          ORDER BY updated_at DESC`,
        [organizationId, authorId],
      ),
    );
  }

  async create(
    organizationId: string,
    authorId: string,
    title: string,
    body: string,
  ): Promise<NoteRow> {
    try {
      const rows = await this.db.withTenant(organizationId, (db) =>
        db.query<NoteRow>(
          `INSERT INTO public.notes (organization_id, author_id, title, body)
           VALUES ($1, $2, $3, $4)
           RETURNING ${COLUMNS}`,
          [organizationId, authorId, title, body],
        ),
      );
      const row = rows[0];
      if (!row) throw new Error('the note row was not returned');
      return row;
    } catch (error) {
      throw translateDbError(error);
    }
  }

  /**
   * Edit a note the caller wrote.
   *
   * `updated_at` is left to the `notes_set_updated_at` trigger rather than set here, so that a
   * second writer path added later cannot forget it and quietly break the list ordering.
   */
  async update(
    organizationId: string,
    authorId: string,
    id: string,
    // `| undefined` on each field because `exactOptionalPropertyTypes` distinguishes "absent" from
    // "present and undefined", and zod's `.optional()` produces the second.
    changes: { title?: string | undefined; body?: string | undefined },
  ): Promise<NoteRow> {
    const sets: string[] = [];
    const params: unknown[] = [organizationId, authorId, id];

    if (changes.title !== undefined) {
      params.push(changes.title);
      sets.push(`title = $${params.length}`);
    }
    if (changes.body !== undefined) {
      params.push(changes.body);
      sets.push(`body = $${params.length}`);
    }
    // The controller's schema already refuses an empty patch; this is the branch that keeps the
    // SQL below from being built with an empty SET list if a second caller ever appears.
    if (sets.length === 0) return this.find(organizationId, authorId, id);

    try {
      const rows = await this.db.withTenant(organizationId, (db) =>
        db.query<NoteRow>(
          `UPDATE public.notes SET ${sets.join(', ')}
            WHERE organization_id = $1 AND author_id = $2 AND id = $3
            RETURNING ${COLUMNS}`,
          params,
        ),
      );
      const row = rows[0];
      if (!row) throw new NoteNotFoundError();
      return row;
    } catch (error) {
      throw translateDbError(error);
    }
  }

  async find(organizationId: string, authorId: string, id: string): Promise<NoteRow> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<NoteRow>(
        `SELECT ${COLUMNS}
           FROM public.notes
          WHERE organization_id = $1 AND author_id = $2 AND id = $3`,
        [organizationId, authorId, id],
      ),
    );
    const row = rows[0];
    if (!row) throw new NoteNotFoundError();
    return row;
  }

  /**
   * Permanent. A note has no trash: the entry in `files` points at bytes worth recovering, a note
   * is only its own text, and a deleted-notes table nobody can see is a place private text lives
   * on after somebody asked for it to be gone.
   */
  async remove(organizationId: string, authorId: string, id: string): Promise<void> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ id: string }>(
        `DELETE FROM public.notes
          WHERE organization_id = $1 AND author_id = $2 AND id = $3
          RETURNING id::text AS id`,
        [organizationId, authorId, id],
      ),
    );
    if (rows.length === 0) throw new NoteNotFoundError();
  }
}

/**
 * PostgreSQL's SQLSTATE, not its message.
 *
 * The text carries the constraint name and is localised by the server's `lc_messages`, so a box
 * installed in Turkish would stop producing 422s and start producing 500s with nothing in this
 * repository noticing.
 */
function translateDbError(error: unknown): Error {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if ((error as { code?: string }).code === '23514') return new NoteRejectedError();
  }
  return error instanceof Error ? error : new Error(String(error));
}
