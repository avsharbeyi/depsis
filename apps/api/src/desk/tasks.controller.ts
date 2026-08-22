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
  AssigneeNotFoundError,
  TaskNotFoundError,
  TaskRejectedError,
  TasksService,
  type TaskRow,
} from './tasks.service.js';

type Schemas = OpenApi.components['schemas'];

const MAX_BODY = 2000;

// Trimmed for the same reason a note's title is: `tasks_body_present` tests `btrim(body) <> ''`,
// so a body of spaces would clear a bare length check here and be refused by the database.
const bodySchema = z.string().trim().min(1).max(MAX_BODY);
const assigneeSchema = z.string().uuid().nullable();
// `position` is a float so that dragging a job between two others is one UPDATE instead of
// renumbering the column. A non-finite value would be stored by `double precision` without
// complaint and would then sort unpredictably, so it is refused here — the database has no CHECK
// for it and this is the only place it can be caught.
const positionSchema = z.number().refine((v) => Number.isFinite(v), { message: 'not a number' });

const createSchema = z.object({
  body: bodySchema,
  assigneeId: assigneeSchema.optional(),
});

const updateSchema = z
  .object({
    body: bodySchema.optional(),
    assigneeId: assigneeSchema.optional(),
    done: z.boolean().optional(),
    position: positionSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to change' });

/**
 * The shared job board.
 *
 * `SessionGuard` only, and no ownership predicate anywhere below: the board belongs to the
 * organisation rather than to the person who typed the job in. That is the opposite of
 * `NotesController` next door, and the difference is the whole reason the two live in one module —
 * putting them side by side makes the asymmetry a decision somebody reads rather than an accident
 * somebody inherits.
 */
@Controller('tasks')
@UseGuards(SessionGuard)
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<Schemas['TaskPage']> {
    const session = requireSession(request);
    const rows = await this.tasks.list(session.organizationId);
    return { items: rows.map(toTask) };
  }

  @Post()
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['Task']> {
    const session = requireSession(request);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException(
        `a task needs a body of 1 to ${MAX_BODY} characters, and assigneeId must be a uuid or null`,
      );
    }

    try {
      const row = await this.tasks.create(
        session.organizationId,
        session.userId,
        parsed.data.body,
        parsed.data.assigneeId ?? null,
      );
      return toTask(row);
    } catch (error) {
      throw translate(error);
    }
  }

  @Patch(':id')
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Schemas['Task']> {
    const session = requireSession(request);
    requireUuid(id);
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      // 422, the same code POST /tasks answers for the same class of refusal and the only error
      // code besides 404 that the contract publishes for this operation. See the longer note on the
      // matching branch in `notes.controller.ts`: a 2001-character body must not get one status
      // from the create route and another from the update route.
      throw new UnprocessableEntityException(
        `one of body, assigneeId, done or position is required, and body must be 1 to ${MAX_BODY} characters`,
      );
    }

    try {
      const row = await this.tasks.update(session.organizationId, id, parsed.data);
      return toTask(row);
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
      await this.tasks.remove(session.organizationId, id);
    } catch (error) {
      throw translate(error);
    }
  }
}

function toTask(row: TaskRow): Schemas['Task'] {
  return {
    id: row.id,
    body: row.body,
    assigneeId: row.assignee_id,
    // Always present, and `null` when nobody holds the job. Omitting the key for an unassigned job
    // would make the client distinguish "unassigned" from "the server did not say", which is one
    // more state than the board has.
    assigneeUsername: row.assignee_username,
    doneAt: row.done_at === null ? null : row.done_at.toISOString(),
    position: row.position,
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

/** A malformed id is "no such task"; see the note on the same guard in `notes.controller.ts`. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireUuid(id: string): void {
  if (!UUID.test(id)) throw new NotFoundException();
}

function translate(error: unknown): Error {
  if (error instanceof TaskNotFoundError) return new NotFoundException();
  // 404 as well, and it is the assignee that is missing rather than the job. The contract publishes
  // 404 on both write routes for exactly this: naming somebody outside the organisation must read
  // as "no such person here", never as a confirmation that the id belongs to an account elsewhere.
  if (error instanceof AssigneeNotFoundError) return new NotFoundException(error.message);
  if (error instanceof TaskRejectedError) return new UnprocessableEntityException(error.message);
  return error instanceof Error ? error : new Error(String(error));
}
