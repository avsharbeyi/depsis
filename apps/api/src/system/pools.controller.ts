import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { z } from 'zod';

import { PasswordService } from '../auth/password.service.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { DbService } from '../db/db.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import { SystemService } from './system.service.js';

type Schemas = OpenApi.components['schemas'];

/**
 * The job kind, declared HERE and re-exported by the handler through `worker-surface`.
 *
 * One declaration rather than the same string written on both sides: a queue whose producer and
 * consumer can disagree about a kind is a job that is enqueued and never picked up, which looks
 * exactly like a worker that is down.
 */
export const CREATE_POOL_KIND = 'storage.pool.create';

/**
 * The request, validated here rather than trusted from the generated types.
 *
 * `name` must start with a letter, which is stricter than ZFS and deliberately so: `zpool` reads a
 * leading `-` as an option (P0-E measured that every tool in this product parses its own argv), and
 * a name that is all digits is a pool somebody will later confuse with a number.
 */
const bodySchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,62}$/, 'a pool name must start with a letter'),
  topology: z.enum(['single', 'mirror', 'raidz1', 'raidz2']),
  disks: z
    .array(z.object({ byId: z.string().min(1).max(255), wwn: z.string().min(1).max(255) }))
    .min(1)
    .max(24),
  confirm: z.string(),
  password: z.string().min(1).max(1024),
});

interface UserRow {
  password_hash: string | null;
}

/**
 * Pool creation — the one route in this API that destroys data.
 *
 * §8.1's sequence is: analysis, plan, the serial/WWN list of the affected disks, written
 * confirmation, re-authentication, job. `GET /system/disks` is the analysis; the client builds the
 * plan and shows the list; this route takes the confirmation and the password and enqueues the job.
 *
 * WHAT THIS ROUTE DOES NOT CHECK, and why that is right: it does not verify that the disks are
 * blank, that they exist, or that none of them is the system disk. The agent does, against an
 * inventory it reads for itself at the moment of creation — and a check here would be a check
 * against a list this process was handed, which proves only that the client copied its own screen
 * correctly. Duplicating it would also invite the belief that the agent's copy is the redundant
 * one.
 */
@Controller('storage/pools')
@UseGuards(SessionGuard)
export class PoolsController {
  constructor(
    private readonly system: SystemService,
    private readonly jobs: JobsService,
    private readonly db: DbService,
    private readonly passwords: PasswordService,
  ) {}

  @Post()
  @HttpCode(202)
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['JobAccepted']> {
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();

    // The same gate as the inventory, and for a heavier reason. Not `AdminGuard`: `system/` uses
    // the founding administrator throughout, and the two concepts still want reconciling as one
    // decision (see `SystemService.isSystemAdministrator`) — making this route the exception would
    // settle that question by accident, in the direction of a wider gate on the riskier operation.
    if (!(await this.system.isSystemAdministrator(session.userId))) throw new ForbiddenException();

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid request');
    }
    const plan = parsed.data;

    // Before the password, so somebody who mistyped the confirmation is not asked to hand over
    // their password to find that out.
    if (plan.confirm !== plan.name) {
      throw new BadRequestException(
        `type the pool name '${plan.name}' to confirm; this operation erases the disks named`,
      );
    }

    await this.reauthenticate(session.organizationId, session.userId, plan.password);

    // A pool this box already has. Checked here because the answer is a 409 the operator can act
    // on, and because the alternative is a job that fails with `zpool`'s own words two seconds
    // later on a screen that is no longer open. The agent refuses it too — this is the courteous
    // half, not the enforcing one.
    if (await this.exists(plan.name)) {
      throw new ConflictException(`a pool called '${plan.name}' already exists on this machine`);
    }

    // The PASSWORD IS NOT IN THE PAYLOAD. It proved the person at the keyboard and its job is
    // finished; a job row is jsonb in a table that survives the request, gets read by
    // `GET /jobs`, and ends up in `job_history`.
    const jobId = await this.jobs.enqueue(
      session.organizationId,
      CREATE_POOL_KIND,
      {
        name: plan.name,
        topology: plan.topology,
        disks: plan.disks,
        requestedBy: session.userId,
      },
      // ONE attempt. Every other job kind in this product is safe to retry; this one runs `zpool
      // create` against real disks, and a retry after an ambiguous failure is the request nobody
      // wants made twice on their behalf. A pool that did not get created is a thing the operator
      // asks for again, having looked.
      { maxAttempts: 1 },
    );

    return { jobId };
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

  /**
   * Does this box already have a pool by that name?
   *
   * A refusal from the agent counts as "no such pool" — that is what `pool_status` answers for a
   * name it cannot find — and an agent that cannot be reached counts as "we do not know", which
   * lets the job run and be refused by the agent with a better sentence than this one could give.
   */
  private async exists(name: string): Promise<boolean> {
    try {
      return await this.system.poolExists(name);
    } catch {
      return false;
    }
  }
}
