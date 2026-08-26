import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { PERMISSIONS } from '@depsis/authz';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { AgentRefusedError, AgentUnavailableError } from '../agent/agent.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AdminGuard, SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { requireSession } from '../files/files.controller.js';
import {
  ShareNameTakenError,
  ShareStorageUnconfiguredError,
  ShareWithoutGrantsError,
  SharesService,
  UnknownGrantPrincipalError,
  UnpublishableShareError,
  type ShareView,
} from './shares.service.js';

type Schemas = OpenApi.components['schemas'];

/**
 * The share name, checked here as well as in the database and in the agent.
 *
 * Three copies of one rule, and each is load-bearing at a different moment. The database refuses
 * with an SQLSTATE and a constraint name, which is not a sentence for a client and arrives only
 * after a dataset has been created. The agent refuses at the privilege boundary, where it must,
 * because §2.2 says the agent does not trust the API. This one refuses before either side has
 * done any work, which is the only place a 422 with a readable message can come from.
 *
 * The pattern is the agent's `SafeComponent` exactly: no slash, no leading dot, and no leading
 * dash — a name beginning with a dash becomes a flag to `zfs`, which is the whole reason
 * `DatasetName` rejects it rather than trying to escape it.
 */
const nameSchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9_][A-Za-z0-9._-]{0,62}$/,
    'a share name may contain letters, digits, dot, dash and underscore, and may not begin with a dot or a dash',
  );

/** One initial grant. The same shape `PUT /files/{id}/permissions` accepts, and the same rule. */
const grantSchema = z
  .object({
    userId: z.string().uuid().nullish(),
    teamId: z.string().uuid().nullish(),
    // Accepted and ignored, as in `PermissionsController`: a client that reads a grant list and
    // posts it back should not be refused for echoing a response-only field.
    displayName: z.string().optional(),
    permissions: z.array(z.enum(PERMISSIONS)).min(1),
  })
  .refine((grant) => ((grant.userId ?? null) !== null) !== ((grant.teamId ?? null) !== null), {
    message: 'a grant names exactly one of userId or teamId',
  });

const createSchema = z.object({
  name: nameSchema,
  readOnly: z.boolean().optional(),
  // `.nullish()` and not `.optional()`: the contract types this `[integer, "null"]`, so an explicit
  // null is a client saying "no quota" and must not be an error.
  quotaBytes: z.number().int().positive().nullish(),
  // ABSENT and EMPTY are different requests and the service treats them differently: absent means
  // "you decide", which becomes the creating administrator; empty means "nobody", which is the
  // ungoverned share migration 0016 exists to abolish and is refused. `.min(1)` here would collapse
  // the two into one message that does not explain why an empty list is wrong.
  grants: z.array(grantSchema).optional(),
});

/**
 * The share list, the addresses that make a NAS a NAS, and the route that opens one.
 *
 * `GET` carries no `AdminGuard`. A member needs to know where their own files live, and the
 * answer — a share name and a UNC path — is something they can already read off the file tree they
 * have access to. The list is tenant-scoped by RLS rather than by role, which is the narrowing
 * that matters here.
 *
 * `POST` carries one. Creating a share creates a ZFS dataset on the operator's pool and writes the
 * grant that governs it; both are appliance-level acts, and ADR-0021 §5 puts the first grant of a
 * share in an administrator's hands specifically so that the permission model cannot open itself.
 */
@Controller('shares')
@UseGuards(SessionGuard)
export class SharesController {
  constructor(
    private readonly shares: SharesService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<Schemas['SharePage']> {
    const session = requireSession(request);
    const listing = await this.shares.list(session.organizationId);

    // `dataset` is optional in the contract and is shown to administrators only. `GET /backups`
    // restricts its whole listing on the grounds that a list of datasets is a map of the
    // appliance's storage layout that an ordinary member has no other endpoint to assemble; the
    // same column here would hand out that map anyway and make the other restriction decorative.
    // The rest of the row is what a member needs and can already infer from their own files.
    const withDataset = request.depsis?.role === 'admin';

    return {
      items: listing.items.map((row) => toShare(row, withDataset)),
      smbAvailable: listing.smbAvailable,
    };
  }

  @Post()
  @UseGuards(AdminGuard)
  @HttpCode(201)
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['ShareCreated']> {
    const session = requireSession(request);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException(
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      );
    }

    // One id per HTTP request, carried into the privileged call, so the agent's audit trail can be
    // read back to the request that caused it (§16).
    const correlationId = randomUUID();

    try {
      const result = await this.shares.create(
        session.organizationId,
        session.userId,
        {
          name: parsed.data.name,
          readOnly: parsed.data.readOnly ?? false,
          quotaBytes: parsed.data.quotaBytes ?? null,
          grants:
            parsed.data.grants === undefined
              ? null
              : parsed.data.grants.map((grant) => ({
                  userId: grant.userId ?? null,
                  teamId: grant.teamId ?? null,
                  permissions: grant.permissions,
                })),
        },
        correlationId,
      );
      await this.audit.record(session.organizationId, {
        actorId: session.userId,
        action: 'share.created',
        target: { kind: 'share', id: result.share.id, label: result.share.name },
        summary: `'${result.share.name}' paylaşımı açıldı${parsed.data.readOnly === true ? ' (salt okunur)' : ''}.`,
        correlationId,
      });
      return {
        // The dataset goes out here where the listing hides it from members, and the asymmetry is
        // not an oversight: only an administrator can reach this route at all, and the dataset is
        // the one field that tells them where on the pool the thing they just made actually is.
        share: toShare(result.share, true),
        applyingJobId: result.applyingJobId,
      };
    } catch (error) {
      throw translate(error);
    }
  }
}

function toShare(row: ShareView, withDataset: boolean): Schemas['Share'] {
  return {
    id: row.id,
    name: row.name,
    readOnly: row.read_only,
    published: row.published,
    uncPath: row.unc_path,
    // Spread rather than a `dataset: undefined`, because `exactOptionalPropertyTypes` makes
    // "absent" and "present and undefined" different types and only the first is the contract's
    // optional field.
    ...(withDataset ? { dataset: row.dataset } : {}),
  };
}

/**
 * The service's refusals, as HTTP.
 *
 * `ShareStorageUnconfiguredError` is a 503 and not a 500, which is the judgement worth writing
 * down: nothing is broken. The appliance simply has no pool yet, which is the ordinary state of a
 * box between being installed and having its storage made, and the message names the setting so an
 * operator can act on it instead of reading a stack trace.
 *
 * An unrecognised error is re-thrown rather than wrapped. A 500 with Nest's own message is more
 * honest than a translated one that implies this function understood what happened.
 */
function translate(error: unknown): unknown {
  if (error instanceof ShareStorageUnconfiguredError) {
    return new ServiceUnavailableException(
      'This appliance has no storage configured for new shares. Set DEPSIS_SHARE_PARENT_DATASET ' +
        'to the dataset mounted at the share root, then try again.',
    );
  }
  if (error instanceof AgentUnavailableError) {
    return new ServiceUnavailableException(
      'The privileged agent is not reachable, so no dataset could be created for the share.',
    );
  }
  if (error instanceof ShareNameTakenError) {
    return new ConflictException(
      error.where === 'database'
        ? `A share named '${error.shareName}' already exists. Names are compared without regard ` +
            'to case, because SMB clients cannot tell two such shares apart.'
        : `A dataset for '${error.shareName}' already exists on the pool, although DEPSIS has no ` +
            'share by that name. Nothing was changed; an operator can look at it with `zfs list`.',
    );
  }
  if (error instanceof ShareWithoutGrantsError) {
    return new UnprocessableEntityException(
      'A share must be created with at least one permission grant. Leave `grants` out entirely to ' +
        'give yourself full access, or name the users and teams that should have it.',
    );
  }
  if (error instanceof UnknownGrantPrincipalError) {
    return new UnprocessableEntityException(
      `No such user or team in this organisation: ${error.ids.join(', ')}`,
    );
  }
  if (error instanceof UnpublishableShareError) {
    return new UnprocessableEntityException(`${error.shareName}: ${error.why}`);
  }
  if (error instanceof AgentRefusedError) {
    return new UnprocessableEntityException(
      `The agent refused to create the dataset: ${error.message}`,
    );
  }
  return error;
}
