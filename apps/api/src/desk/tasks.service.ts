import { Injectable } from '@nestjs/common';

import { DbService, type TenantQuery } from '../db/db.service.js';

export interface TaskRow {
  id: string;
  body: string;
  assignee_id: string | null;
  assignee_username: string | null;
  done_at: Date | null;
  position: number;
  created_at: Date;
  updated_at: Date;
}

/** No such job, or it belongs to another tenant — deliberately one answer, as RLS makes it. */
export class TaskNotFoundError extends Error {
  constructor() {
    super('no such task');
    this.name = 'TaskNotFoundError';
  }
}

/**
 * The person the job was to be assigned to is not in this organisation.
 *
 * Its own error rather than a generic "not found" because the two are different repairs: one
 * means the job is gone, the other means the name in the picker is stale.
 */
export class AssigneeNotFoundError extends Error {
  constructor() {
    super('no such user in this organization');
    this.name = 'AssigneeNotFoundError';
  }
}

/** SQLSTATE 23514 from `tasks_body_present`: an empty body, or one past 2000 characters. */
export class TaskRejectedError extends Error {
  constructor() {
    super('a task needs a body of between 1 and 2000 characters');
    this.name = 'TaskRejectedError';
  }
}

/**
 * The board's shape, assembled the same way everywhere it is returned.
 *
 * `assignee_username` comes from a LEFT JOIN rather than a second round trip: an unassigned job is
 * a real state, so the join has to survive a NULL, and an inner join would silently drop exactly
 * the rows the board most needs to show.
 */
const SELECT_COLUMNS = `t.id::text          AS id,
          t.body,
          t.assignee_id::text AS assignee_id,
          u.username          AS assignee_username,
          t.done_at,
          t.position,
          t.created_at,
          t.updated_at`;

/**
 * The shared job board.
 *
 * Unlike notes there is no per-user predicate here, and that is the decision rather than an
 * omission: migration 0012 groups jobs BY PERSON, and a job assigned to somebody who cannot see it
 * has not been assigned. Everyone in the organisation reads and edits the whole board; RLS is what
 * keeps that "everyone" inside one tenant.
 */
@Injectable()
export class TasksService {
  constructor(private readonly db: DbService) {}

  /**
   * The whole board, completed jobs included.
   *
   * Ordered by assignee, then by the manual position, then by age — the same tuple as the
   * `tasks_board` index, so the sort is read off the index rather than performed. Unassigned jobs
   * sort last because PostgreSQL puts NULLs last in an ascending order, which is also where the
   * "somebody should do this" column belongs on screen.
   */
  async list(organizationId: string): Promise<TaskRow[]> {
    return this.db.withTenant(organizationId, (db) =>
      db.query<TaskRow>(
        `SELECT ${SELECT_COLUMNS}
           FROM public.tasks t
           LEFT JOIN public.users u ON u.id = t.assignee_id
          WHERE t.organization_id = $1
          ORDER BY t.assignee_id, t.position, t.created_at`,
        [organizationId],
      ),
    );
  }

  async create(
    organizationId: string,
    createdBy: string,
    body: string,
    assigneeId: string | null,
  ): Promise<TaskRow> {
    try {
      const rows = await this.db.withTenant(organizationId, async (db) => {
        // Checked inside the SAME transaction as the insert, and checked at all because RLS would
        // not catch it: the row's own `organization_id` is correct, so the policy is satisfied
        // whatever `assignee_id` holds. Without this the appliance happily assigns work to an
        // account in another household — a foreign key to `public.users` says the person exists,
        // not that they are one of us.
        await assertAssignee(db, organizationId, assigneeId);

        return db.query<TaskRow>(
          `WITH inserted AS (
             INSERT INTO public.tasks (organization_id, created_by, body, assignee_id)
             VALUES ($1, $2, $3, $4)
             RETURNING *
           )
           SELECT ${SELECT_COLUMNS}
             FROM inserted t
             LEFT JOIN public.users u ON u.id = t.assignee_id`,
          [organizationId, createdBy, body, assigneeId],
        );
      });
      const row = rows[0];
      if (!row) throw new Error('the task row was not returned');
      return row;
    } catch (error) {
      throw translateDbError(error);
    }
  }

  async update(
    organizationId: string,
    id: string,
    changes: {
      body?: string | undefined;
      // `string | null` and `undefined` mean different things and both are reachable: null clears
      // the assignment, absent leaves it alone. Collapsing them would make "unassign" impossible
      // to express.
      assigneeId?: string | null | undefined;
      done?: boolean | undefined;
      position?: number | undefined;
    },
  ): Promise<TaskRow> {
    const sets: string[] = [];
    const params: unknown[] = [organizationId, id];

    if (changes.body !== undefined) {
      params.push(changes.body);
      sets.push(`body = $${params.length}`);
    }
    if (changes.assigneeId !== undefined) {
      params.push(changes.assigneeId);
      sets.push(`assignee_id = $${params.length}::uuid`);
    }
    if (changes.done !== undefined) {
      // `COALESCE`, not `now()`. Ticking a box that is already ticked must not move the completion
      // time: the interface re-sends the whole row on every edit, and an idempotent write that
      // silently rewrites history would make "what did we finish yesterday" answer today.
      sets.push(changes.done ? `done_at = COALESCE(done_at, now())` : `done_at = NULL`);
    }
    if (changes.position !== undefined) {
      params.push(changes.position);
      sets.push(`position = $${params.length}`);
    }
    if (sets.length === 0) return this.find(organizationId, id);

    try {
      const rows = await this.db.withTenant(organizationId, async (db) => {
        if (changes.assigneeId !== undefined) {
          await assertAssignee(db, organizationId, changes.assigneeId);
        }

        return db.query<TaskRow>(
          `WITH updated AS (
             UPDATE public.tasks SET ${sets.join(', ')}
              WHERE organization_id = $1 AND id = $2
              RETURNING *
           )
           SELECT ${SELECT_COLUMNS}
             FROM updated t
             LEFT JOIN public.users u ON u.id = t.assignee_id`,
          params,
        );
      });
      const row = rows[0];
      if (!row) throw new TaskNotFoundError();
      return row;
    } catch (error) {
      throw translateDbError(error);
    }
  }

  async find(organizationId: string, id: string): Promise<TaskRow> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<TaskRow>(
        `SELECT ${SELECT_COLUMNS}
           FROM public.tasks t
           LEFT JOIN public.users u ON u.id = t.assignee_id
          WHERE t.organization_id = $1 AND t.id = $2`,
        [organizationId, id],
      ),
    );
    const row = rows[0];
    if (!row) throw new TaskNotFoundError();
    return row;
  }

  async remove(organizationId: string, id: string): Promise<void> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ id: string }>(
        `DELETE FROM public.tasks
          WHERE organization_id = $1 AND id = $2
          RETURNING id::text AS id`,
        [organizationId, id],
      ),
    );
    if (rows.length === 0) throw new TaskNotFoundError();
  }
}

/**
 * Refuse an assignee who is not a member of this organisation.
 *
 * Runs on the tenant-scoped connection, so the lookup itself is behind the same policy as the
 * write it guards — an id from another tenant returns no row here for the same reason it would
 * return no row anywhere else, rather than because this function compared two strings.
 */
async function assertAssignee(
  db: TenantQuery,
  organizationId: string,
  assigneeId: string | null,
): Promise<void> {
  if (assigneeId === null) return;
  const rows = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM public.users WHERE organization_id = $1 AND id = $2`,
    [organizationId, assigneeId],
  );
  if (rows.length === 0) throw new AssigneeNotFoundError();
}

/** SQLSTATE, not message text — see the note on the same function in `notes.service.ts`. */
function translateDbError(error: unknown): Error {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: string }).code;
    if (code === '23514') return new TaskRejectedError();
    // The assignee vanished between the check above and the write. Rare, but it is a stale picker
    // rather than a fault, so it gets the same answer as the check that normally catches it.
    if (code === '23503') return new AssigneeNotFoundError();
  }
  return error instanceof Error ? error : new Error(String(error));
}
