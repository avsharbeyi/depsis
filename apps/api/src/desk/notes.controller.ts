import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { z } from 'zod';

import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import {
  NoteNotFoundError,
  NoteRejectedError,
  NotesService,
  type NoteRow,
} from './notes.service.js';

type Schemas = OpenApi.components['schemas'];

// The bounds are migration 0012's, restated here so a bad request is refused before it reaches the
// database rather than after. The CHECK constraints remain the last line of defence, not the first
// one: this schema can drift, a constraint cannot be bypassed.
const MAX_TITLE = 200;
const MAX_BODY = 65_536;

// `.trim()` rather than a bare `.min(1)`: the constraint the database enforces is
// `btrim(title) <> ''`, so a title of three spaces would pass a length check here and then be
// refused there — a 422 for a request the interface believed it had validated.
const titleSchema = z.string().trim().min(1).max(MAX_TITLE);
// The body is NOT trimmed. Leading whitespace in a note is the author's, and a notepad that
// silently reflows what was typed into it is a notepad people stop trusting.
const bodySchema = z.string().max(MAX_BODY);

const createSchema = z.object({
  title: titleSchema,
  body: bodySchema.default(''),
});

const updateSchema = z
  .object({
    title: titleSchema.optional(),
    body: bodySchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to change' });

/**
 * The notepad.
 *
 * `SessionGuard` and no `AdminGuard`: these are everybody's own notes, and an administrator has no
 * more business reading them than anyone else — which is why the author id handed to the service
 * on every call comes from the resolved session and can never be supplied by the caller.
 */
@Controller('notes')
@UseGuards(SessionGuard)
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<Schemas['NotePage']> {
    const session = requireSession(request);
    const rows = await this.notes.list(session.organizationId, session.userId);
    return { items: rows.map(toNote) };
  }

  @Post()
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['Note']> {
    const session = requireSession(request);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException(
        `a note needs a title of 1 to ${MAX_TITLE} characters and a body of at most ${MAX_BODY}`,
      );
    }

    try {
      const row = await this.notes.create(
        session.organizationId,
        session.userId,
        parsed.data.title,
        parsed.data.body,
      );
      return toNote(row);
    } catch (error) {
      throw translate(error);
    }
  }

  @Patch(':id')
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Schemas['Note']> {
    const session = requireSession(request);
    requireUuid(id);
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      // Two different refusals share this branch by design: an empty patch is a client bug and a
      // 201-character title is a user's paste, but telling them apart in the message costs a
      // sentence and telling them apart in the status code would need a code for `minProperties`
      // that the contract does not publish.
      //
      // 422 and not 400. An earlier version answered 400 here on the grounds that `minProperties`
      // has no published code, which got the conclusion backwards: the contract publishes 200, 404
      // and 422 for this operation and nothing else, so 400 is the status a generated client has no
      // branch for. It also made the same rejected value — a 201-character title — answer 422 from
      // POST /notes and 400 from here, which is one resource giving two answers to one question.
      throw new UnprocessableEntityException(
        `title or body, within ${MAX_TITLE} and ${MAX_BODY} characters`,
      );
    }

    try {
      const row = await this.notes.update(session.organizationId, session.userId, id, parsed.data);
      return toNote(row);
    } catch (error) {
      throw translate(error);
    }
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() request: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
    const session = requireSession(request);
    requireUuid(id);
    try {
      await this.notes.remove(session.organizationId, session.userId, id);
    } catch (error) {
      throw translate(error);
    }
  }
}

function toNote(row: NoteRow): Schemas['Note'] {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
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

/**
 * A path segment that is not a UUID is "no such note", not a fault.
 *
 * Without this the value reaches PostgreSQL and comes back as SQLSTATE 22P02, which nothing maps
 * and which therefore surfaces as a 500 — an error page for a mistyped URL, and a way to tell a
 * malformed id from a well-formed one that names somebody else's note.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireUuid(id: string): void {
  if (!UUID.test(id)) throw new NotFoundException();
}

function translate(error: unknown): Error {
  // 404 and not 403, even though the row exists and the caller is in the right tenant: a 403 would
  // confirm that a note with this id belongs to somebody, which is the one fact a private notepad
  // must not answer.
  if (error instanceof NoteNotFoundError) return new NotFoundException();
  if (error instanceof NoteRejectedError) return new UnprocessableEntityException(error.message);
  return error instanceof Error ? error : new Error(String(error));
}
