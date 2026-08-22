import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  GoneException,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  Sse,
  UnauthorizedException,
  UseGuards,
  type MessageEvent,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { map, type Observable } from 'rxjs';
import { z } from 'zod';

import { PasswordService } from '../auth/password.service.js';
import { AdminGuard, SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { DbService } from '../db/db.service.js';
import {
  ConsoleRefusedError,
  ConsoleUnavailableError,
  InvalidConsoleValueError,
  MAX_COLS,
  MAX_INPUT_BASE64,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
} from './console.client.js';
import {
  ConsoleService,
  ConsoleSessionClosedError,
  ConsoleSessionNotFoundError,
  type ConsoleEvent,
} from './console.service.js';

type Schemas = OpenApi.components['schemas'];

const geometry = {
  cols: z.number().int().min(MIN_COLS).max(MAX_COLS),
  rows: z.number().int().min(MIN_ROWS).max(MAX_ROWS),
};

const openSchema = z.object({
  password: z.string().min(1).max(1024),
  cols: geometry.cols.default(80),
  rows: geometry.rows.default(24),
});

const inputSchema = z.object({ data: z.string().max(MAX_INPUT_BASE64) });
const resizeSchema = z.object(geometry);
const idSchema = z.uuid();

interface UserRow {
  password_hash: string | null;
}

/**
 * The administrator console (ADR-0018).
 *
 * `AdminGuard` on the class, and not one route without it: everything here is a shell on the
 * appliance, and the closest thing to a read-only operation — the session list — still says who is
 * logged into the box right now.
 *
 * The console does NOT run in the privileged agent. It is a separate service with its own systemd
 * unit, running unprivileged by default, and this controller reaches it over a socket. §2.2 — the
 * agent accepts no free-form command — is untouched, because the agent is nowhere in this path.
 */
@Controller('console')
@UseGuards(SessionGuard, AdminGuard)
export class ConsoleController {
  constructor(
    private readonly console: ConsoleService,
    private readonly db: DbService,
    private readonly passwords: PasswordService,
  ) {}

  /**
   * Open a shell, after the password.
   *
   * The session already proves who this is; the password proves they are still at the keyboard.
   * A borrowed unlocked laptop is exactly a valid session, and what it would buy here is not an
   * account but the whole device. `me.controller.ts` asks the same question before a password
   * change, through the same `PasswordService`, for the same reason.
   */
  @Post()
  @HttpCode(201)
  async open(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['ConsoleSession']> {
    const session = requireSession(request);
    const parsed = openSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        `password is required; cols must be ${MIN_COLS}-${MAX_COLS} and rows ${MIN_ROWS}-${MAX_ROWS}`,
      );
    }

    await this.reauthenticate(session.organizationId, session.userId, parsed.data.password);

    try {
      return await this.console.open(
        session.organizationId,
        session.userId,
        parsed.data.cols,
        parsed.data.rows,
      );
    } catch (error) {
      throw translate(error);
    }
  }

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<Schemas['ConsoleSessionPage']> {
    const session = requireSession(request);
    try {
      return await this.console.list(session.organizationId);
    } catch (error) {
      throw translate(error);
    }
  }

  @Delete(':id')
  @HttpCode(204)
  async close(@Req() request: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
    const session = requireSession(request);
    try {
      await this.console.close(session.organizationId, requireId(id));
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * Keystrokes, base64, raw bytes rather than lines.
   *
   * A terminal works a character at a time: Ctrl-C, tab completion and the arrow keys are all byte
   * sequences, and a line-oriented endpoint would not be a terminal. The audit trail is collected
   * separately, by the console service, when it sees a complete line.
   */
  @Post(':id/input')
  @HttpCode(204)
  async input(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<void> {
    const session = requireSession(request);
    const parsed = inputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('data must be base64');

    try {
      await this.console.input(
        session.organizationId,
        session.userId,
        requireId(id),
        parsed.data.data,
      );
    } catch (error) {
      throw translate(error);
    }
  }

  @Post(':id/resize')
  @HttpCode(204)
  async resize(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<void> {
    const session = requireSession(request);
    const parsed = resizeSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        `cols must be ${MIN_COLS}-${MAX_COLS} and rows ${MIN_ROWS}-${MAX_ROWS}`,
      );
    }

    try {
      await this.console.resize(
        session.organizationId,
        session.userId,
        requireId(id),
        parsed.data.cols,
        parsed.data.rows,
      );
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * Terminal output, as Server-Sent Events.
   *
   * Deliberately synchronous: the observable comes out of the session's own subject, so a browser
   * that navigates away unsubscribes and nothing else happens — the socket and the pty belong to
   * the session, not to this response, and a closed tab must not kill a running command. The
   * reverse leak is handled where sessions end: `exit`, `DELETE`, and the console service's idle
   * timer all complete the subject, which ends this stream.
   *
   * Each event's data is base64, because terminal output is raw bytes that can split a UTF-8
   * boundary mid-sequence and SSE carries text.
   */
  @Sse(':id/stream')
  stream(@Req() request: AuthenticatedRequest, @Param('id') id: string): Observable<MessageEvent> {
    const session = requireSession(request);
    try {
      return this.console
        .stream(session.organizationId, session.userId, requireId(id))
        .pipe(map(toMessageEvent));
    } catch (error) {
      throw translate(error);
    }
  }

  /** §0.5: an operation carrying this much risk is not performed on the strength of a cookie. */
  private async reauthenticate(
    organizationId: string,
    userId: string,
    password: string,
  ): Promise<void> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<UserRow>(`SELECT password_hash FROM users WHERE id = $1`, [userId]),
    );
    const user = rows[0];
    // The guard resolved this session a moment ago, so a missing row means the account went away
    // in between. A dead session, not a server error.
    if (user === undefined) throw new UnauthorizedException();
    if (!(await this.passwords.verify(user.password_hash, password))) {
      throw new UnauthorizedException('the password is wrong');
    }
  }
}

function toMessageEvent(event: ConsoleEvent): MessageEvent {
  switch (event.kind) {
    case 'out':
      // The default event type, because output is the overwhelming majority and a browser's
      // `onmessage` should be the terminal's write path with nothing to unwrap.
      return { data: event.data };
    case 'exit':
      return { type: 'exit', data: { code: event.code } };
    case 'error':
      return { type: 'error', data: { message: event.message } };
  }
}

function requireId(id: string): string {
  const parsed = idSchema.safeParse(id);
  // Not a 400: an id that is not an id names no session, and this endpoint answers the same way
  // for a session that does not exist as for one belonging to somebody else.
  if (!parsed.success) throw new NotFoundException();
  return parsed.data;
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
 * One place where a failure becomes a status code.
 *
 * The distinction that matters most here is 503 versus 500. `systemctl disable depsis-console`
 * turns this feature off completely, and an operator who did that should see "switched off", not
 * "the appliance is broken". A refusal from the console service — all eight sessions in use — is
 * the same shape of answer: the service is fine, it cannot serve this now.
 */
function translate(error: unknown): Error {
  if (error instanceof ConsoleUnavailableError || error instanceof ConsoleRefusedError) {
    return new ServiceUnavailableException(error.message);
  }
  if (error instanceof ConsoleSessionClosedError) {
    return new GoneException(error.message);
  }
  if (error instanceof ConsoleSessionNotFoundError) {
    return new NotFoundException();
  }
  if (error instanceof InvalidConsoleValueError) {
    return new BadRequestException(error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}
