import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { PERMISSIONS, type Permission } from '@depsis/authz';
import { z } from 'zod';

import { requireSameOrigin } from '../auth/origin.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { requireUuid } from '../files/files.controller.js';
import {
  DuplicatePrincipalError,
  LastGrantError,
  NodeNotFoundError,
  NotAFolderError,
  NotManageableError,
  PermissionsService,
  UnknownPrincipalError,
  type Actor,
  type FolderPermissionsView,
  type GrantInput,
  type WriteResultView,
} from './permissions.service.js';

type Schemas = OpenApi.components['schemas'];

/**
 * One grant row, checked before the database sees it.
 *
 * `userId` XOR `teamId` is also a CHECK constraint in migration 0015, and it is written twice on
 * purpose: the constraint answers with SQLSTATE 23514 and a constraint name, which is not a
 * sentence for a client, and it answers only after the statement has been attempted. The contract
 * says the same thing a third time so a generated client can know it without asking.
 *
 * An empty permission set is refused here for the reason the schema gives: "nothing at all" and
 * "no rule here" are different states, and collapsing them would make removal ambiguous. Removing
 * a principal means leaving its row OUT of the body.
 */
const grantSchema = z
  .object({
    userId: z.string().uuid().nullish(),
    teamId: z.string().uuid().nullish(),
    // Accepted and ignored. The contract marks it response-only; refusing a body that echoes back
    // what a GET just returned would make the obvious client flow — read, edit, write — fail.
    displayName: z.string().optional(),
    permissions: z.array(z.enum(PERMISSIONS)).min(1),
  })
  .refine(
    (grant) => {
      const namesUser = (grant.userId ?? null) !== null;
      const namesTeam = (grant.teamId ?? null) !== null;
      return namesUser !== namesTeam;
    },
    { message: 'a grant names exactly one of userId or teamId' },
  );

const writeSchema = z.object({ grants: z.array(grantSchema) });

/**
 * §6.2's permission surface, for a folder and for a share root.
 *
 * Both live in one controller because they are one operation over one table: `folder_grants`
 * carries a NULL `entry_id` for the share root and ADR-0021 keeps them together so the inheritance
 * walk is written once. They stay two ROUTES because the ids come from different tables — an
 * endpoint that accepted either kind of id could not say which of the two it failed to find.
 *
 * No `AdminGuard`. Authority here is `manage` on the node, which an administrator has everywhere
 * and an ordinary member can be given on one folder; requiring the organisation role instead would
 * make the per-folder `manage` permission decorative, and delegating a single folder is the reason
 * §6.2 separates `manage` from `modify` at all.
 */
@Controller()
@UseGuards(SessionGuard)
export class PermissionsController {
  constructor(private readonly permissions: PermissionsService) {}

  @Get('files/:id/permissions')
  async readFolder(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<Schemas['FolderPermissions']> {
    requireUuid(id);
    const actor = requireActor(request);
    try {
      return toFolderPermissions(
        await this.permissions.read(actor.organizationId, actor, { kind: 'entry', id }),
      );
    } catch (error) {
      throw translate(error);
    }
  }

  @Put('files/:id/permissions')
  async writeFolder(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('dryRun') dryRun: string | undefined,
    @Body() body: unknown,
  ): Promise<Schemas['PermissionWriteResult']> {
    requireUuid(id);
    return this.applyWrite(request, { kind: 'entry', id }, dryRun, body);
  }

  @Get('shares/:id/permissions')
  async readShare(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<Schemas['FolderPermissions']> {
    requireUuid(id);
    const actor = requireActor(request);
    try {
      return toFolderPermissions(
        await this.permissions.read(actor.organizationId, actor, { kind: 'share', id }),
      );
    } catch (error) {
      throw translate(error);
    }
  }

  @Put('shares/:id/permissions')
  async writeShare(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('dryRun') dryRun: string | undefined,
    @Body() body: unknown,
  ): Promise<Schemas['PermissionWriteResult']> {
    requireUuid(id);
    return this.applyWrite(request, { kind: 'share', id }, dryRun, body);
  }

  private async applyWrite(
    request: AuthenticatedRequest,
    ref: { kind: 'entry' | 'share'; id: string },
    dryRun: string | undefined,
    body: unknown,
  ): Promise<Schemas['PermissionWriteResult']> {
    requireSameOrigin(request);
    const actor = requireActor(request);
    // Before the body, because getting this one wrong is what turns a preview into a write.
    const preview = isDryRun(dryRun);

    const parsed = writeSchema.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException(
        parsed.error.issues[0]?.message ??
          'each grant names exactly one of userId or teamId and at least one permission',
      );
    }

    const grants = parsed.data.grants.map((grant): GrantInput => ({
      userId: grant.userId ?? null,
      teamId: grant.teamId ?? null,
      // Deduplicated, because `['read','read']` and `['read']` are the same grant and storing
      // the first would make two equal requests produce two different rows.
      permissions: [...new Set<Permission>(grant.permissions)],
    }));
    assertOnePerPrincipal(grants);

    try {
      const result = await this.permissions.write(
        actor.organizationId,
        actor,
        ref.kind === 'entry' ? { kind: 'entry', id: ref.id } : { kind: 'share', id: ref.id },
        grants,
        preview,
      );
      return toWriteResult(result);
    } catch (error) {
      throw translate(error);
    }
  }
}

/**
 * `?dryRun=` is read strictly, and the strictness is the safety property.
 *
 * Treating an unrecognised value as false would mean a client that sent `dryRun=1` expecting a
 * preview got a WRITE instead — the one direction in which being lenient destroys something. So
 * only the two values the contract's boolean can take are accepted, and anything else is a 400
 * before the body is even looked at.
 *
 * Exported because `TeamsController` needs the SAME parser. It had its own, which accepted `1` as
 * well and treated everything else as "really delete", so one client sending `dryRun=1` got a
 * preview from a team deletion and a 400 from a grant write. Two spellings of one query parameter
 * inside one feature is a difference somebody discovers by deleting a team they meant to price.
 */
export function isDryRun(raw: string | undefined): boolean {
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new BadRequestException("dryRun must be 'true' or 'false'");
}

/**
 * One row per principal, checked before the write starts.
 *
 * Migration 0015's partial unique indexes refuse the second row, but by then the first has been
 * inserted and the transaction is being rolled back over a message naming an index. This says
 * which principal appears twice, which is the only part the caller can act on.
 */
function assertOnePerPrincipal(grants: readonly GrantInput[]): void {
  const seen = new Set<string>();
  for (const grant of grants) {
    const key = grant.userId === null ? `team:${grant.teamId ?? ''}` : `user:${grant.userId}`;
    if (seen.has(key)) throw translate(new DuplicatePrincipalError(key));
    seen.add(key);
  }
}

function toFolderPermissions(view: FolderPermissionsView): Schemas['FolderPermissions'] {
  return {
    effective: view.effective,
    inheritedFrom: view.inheritedFrom,
    grants: view.grants.map((grant) => ({
      userId: grant.userId,
      teamId: grant.teamId,
      displayName: grant.displayName,
      permissions: grant.permissions,
    })),
    canManage: view.canManage,
  };
}

function toWriteResult(view: WriteResultView): Schemas['PermissionWriteResult'] {
  return {
    applied: view.applied,
    impact: view.impact,
    // Always present, including as null. The interface has to be able to tell "queued" from "the
    // agent was down and the filesystem is behind", and an absent field reads as neither.
    applyingJobId: view.applyingJobId,
  };
}

/**
 * The session, plus the one fact the grant walk deliberately does not model.
 *
 * `packages/authz` answers only what the GRANTS say; §6.1's organisation administrator reaching
 * everything is a fact about the session and is applied on top, here and in the service. Written
 * out rather than reusing `files.controller`'s helper because that one drops the role, and this is
 * the endpoint where the role decides the answer.
 */
function requireActor(request: AuthenticatedRequest): Actor & { organizationId: string } {
  const session = request.depsis;
  if (session === undefined) throw new UnauthorizedException();
  return {
    organizationId: session.organizationId,
    userId: session.userId,
    isAdmin: session.role === 'admin',
  };
}

function translate(error: unknown): Error {
  if (error instanceof NodeNotFoundError) return new NotFoundException();
  if (error instanceof NotManageableError) return new ForbiddenException(error.message);
  if (error instanceof NotAFolderError) return new UnprocessableEntityException(error.message);
  if (error instanceof UnknownPrincipalError) {
    return new UnprocessableEntityException(error.message);
  }
  if (error instanceof DuplicatePrincipalError) {
    return new UnprocessableEntityException(error.message);
  }
  // 422 rather than 409: the body is well-formed and the node is in the state it claims to be in.
  // What cannot be processed is what the body ASKS for — an empty grant list on the last node that
  // has one — and the message names the way to get the outcome the caller wanted.
  if (error instanceof LastGrantError) return new UnprocessableEntityException(error.message);
  return error instanceof Error ? error : new Error(String(error));
}
