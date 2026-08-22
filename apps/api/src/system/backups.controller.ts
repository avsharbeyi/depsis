import {
  Body,
  ConflictException,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { AgentRefusedError, AgentUnavailableError } from '../agent/agent.service.js';
import { AdminGuard, SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import {
  BackupsService,
  InvalidSnapshotNameError,
  SnapshotNameTakenError,
  UnknownDatasetError,
  defaultSnapshotName,
  type SnapshotRow,
} from './backups.service.js';

type Schemas = OpenApi.components['schemas'];

/**
 * The same pattern as `snapshots_name_format` in migration 0012 and as the agent's `SafeComponent`.
 *
 * Written out here rather than left to the database because of what the sequence costs: the agent
 * is called BEFORE the row is written, so a name only the database would refuse means a snapshot
 * taken on the pool that DEPSIS then cannot record. Validating first makes that impossible instead
 * of merely rare.
 */
const SNAPSHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,62}$/;

const createSchema = z.object({
  dataset: z.string().trim().min(1).max(255),
  name: z.string().trim().max(63).regex(SNAPSHOT_NAME).optional(),
});

/**
 * Backups: the snapshots DEPSIS itself took.
 *
 * Administrators only, on both routes. Reading is restricted as well as writing, and that is not
 * caution for its own sake — the list names every dataset the organisation has, which is a map of
 * the appliance's storage layout that an ordinary member has no endpoint to assemble otherwise.
 *
 * 403 rather than 404 for a non-administrator, because these paths are in the published contract:
 * hiding them conceals nothing and makes a legitimate administrator's misconfiguration harder to
 * diagnose. The tenant-scoped refusals below are the opposite case and answer 404.
 */
@Controller('backups')
@UseGuards(SessionGuard, AdminGuard)
export class BackupsController {
  constructor(private readonly backups: BackupsService) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<Schemas['SnapshotPage']> {
    const session = requireSession(request);
    const rows = await this.backups.list(session.organizationId);
    return {
      items: rows.map(toSnapshot),
      // Always false, and it is a fact rather than a placeholder. The agent has no "list snapshots"
      // operation, so this is DEPSIS's record of what it took and NOT the pool's inventory — a
      // snapshot made from a shell on the box is missing from it. The client is required to tell
      // the user that, and the contract is where it learns it has to.
      complete: false,
    };
  }

  @Post()
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['Snapshot']> {
    const session = requireSession(request);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException(
        'a dataset is required, and a name — if given — may only contain letters, digits, ' +
          '_, ., - and must not start with . or -',
      );
    }

    // One id per HTTP request, carried into the privileged call, so the agent's audit trail can be
    // read back to the request that caused it (§16).
    const correlationId = randomUUID();
    const name = parsed.data.name ?? defaultSnapshotName();

    try {
      const row = await this.backups.create(
        session.organizationId,
        session.userId,
        parsed.data.dataset,
        name,
        correlationId,
      );
      return toSnapshot(row);
    } catch (error) {
      throw translate(error, correlationId);
    }
  }
}

function toSnapshot(row: SnapshotRow): Schemas['Snapshot'] {
  return {
    id: row.id,
    dataset: row.dataset,
    name: row.name,
    fullName: row.full_name,
    createdBy: row.created_by_username,
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

/**
 * Not a class member because `translate` is not one either, and both want the same name in a log
 * line. Nest's Logger is safe to construct outside the injector; only the context string differs
 * from an injected one.
 */
const logger = new Logger(BackupsController.name);

function translate(error: unknown, correlationId: string): Error {
  // 404 rather than 403: a dataset this tenant has no share on may still exist on the box, and
  // saying "forbidden" would confirm it. The same answer covers "there is no such dataset at all",
  // which is what makes the two indistinguishable from outside.
  if (error instanceof UnknownDatasetError) return new NotFoundException('no such dataset');

  if (error instanceof SnapshotNameTakenError) return new ConflictException(error.message);
  if (error instanceof InvalidSnapshotNameError) {
    return new UnprocessableEntityException(error.message);
  }

  // The agent was reached and said no. 409, because the request is well formed and would be legal
  // at another moment — what refuses it is the state of the pool.
  if (error instanceof AgentRefusedError) {
    return new ConflictException(
      `the snapshot was not taken: ${explain(error.agentReason, correlationId)}`,
    );
  }

  // Nothing was necessarily done, and the client should try again rather than change the request.
  if (error instanceof AgentUnavailableError) {
    return new ServiceUnavailableException(
      'Backups are unavailable: the system agent could not be reached.',
    );
  }

  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The shape `SeamError::Command` serialises to, and the one agent reason that must not be repeated.
 *
 * `services/system-agent/src/mod.rs` formats it as
 * `command {program} failed with status {status}: {stderr}` and
 * `services/system-agent/src/dispatch.rs` turns any execution error into `Response::Failed`, which
 * `expectStatus` cannot tell apart from a deliberate `Response::Refused`. So the split has to be
 * made here, on the only thing that distinguishes them from this side: the prefix.
 */
const COMMAND_FAILURE = /^command \S+ failed with status -?\d+:/u;

/**
 * Make the agent's rationale fit in a Problem Details document — or withhold it.
 *
 * A REFUSAL has to reach the user: "the pool is read-only" and "the dataset is busy" are things
 * only the agent knows and only the user can act on. A command FAILURE is a different animal. It
 * carries the absolute path of the binary the privileged agent ran and raw `zfs` stderr, which
 * names the full dataset path — the appliance's on-disk layout and the agent's command surface,
 * learned from an HTTP response rather than from the journal. AdminGuard narrows who can read that
 * but does not make it something an API response should teach.
 *
 * The original is logged with the correlation id, so the operator who needs it can still find it
 * next to the agent's own audit entry for the same request (§16).
 *
 * What is passed through is still one line and still capped: an unbounded multi-line dump turns an
 * error card into a wall of text, and on a long enough message is a way to push arbitrary content
 * into somebody else's screen.
 */
export function explain(reason: string, correlationId: string): string {
  const oneLine = reason.replace(/\s+/gu, ' ').trim();
  if (oneLine === '') return 'the system agent gave no reason';
  if (COMMAND_FAILURE.test(oneLine)) {
    logger.error(`snapshot command failed [${correlationId}]: ${oneLine}`);
    return 'the snapshot command failed; see the system log for this request';
  }
  return oneLine.length > 200 ? `${oneLine.slice(0, 199)}…` : oneLine;
}
