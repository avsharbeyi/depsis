import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { z } from 'zod';

import { requireSameOrigin } from '../auth/origin.js';
import { PasswordService } from '../auth/password.service.js';
import { AdminGuard, SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { SessionService } from '../auth/session.service.js';
import {
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
  username: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  displayName: z.string().trim().min(1).max(200),
  role: z.enum(['admin', 'member']).default('member'),
  password: z.string().min(MIN_PASSWORD).max(MAX_PASSWORD),
});

const updateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
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
  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
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
        `username, displayName and a password of at least ${MIN_PASSWORD} characters are required`,
      );
    }

    const hash = await this.passwords.hash(parsed.data.password);
    try {
      const row = await this.users.create(
        session.organizationId,
        parsed.data.username,
        parsed.data.displayName,
        parsed.data.role,
        hash,
      );
      return toUser(row);
    } catch (error) {
      throw translate(error);
    }
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

      // A disabled account's sessions have to stop working NOW. `resolve_session` already refuses
      // them — it joins `users` and checks `disabled_at` — so this is not what closes the hole; it
      // is what makes the rows say what happened, so an audit does not have to infer a revocation
      // from a column on another table.
      if (parsed.data.disabled === true) {
        await this.sessions.revokeAllForUser(session.organizationId, id);
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
    displayName: row.display_name,
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
  return error instanceof Error ? error : new Error(String(error));
}
