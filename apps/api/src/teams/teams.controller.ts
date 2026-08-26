import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import type { Response } from 'express';
import { z } from 'zod';

import { requireSameOrigin } from '../auth/origin.js';
import { isDryRun } from '../permissions/permissions.controller.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import type { UserRole } from '../auth/session.service.js';
import {
  LastGrantInShareError,
  TeamMemberNotFoundError,
  TeamNameTakenError,
  TeamNotFoundError,
  TeamsService,
  type ImpactSummary,
  type TeamMemberRow,
  type TeamRow,
} from './teams.service.js';

type Schemas = OpenApi.components['schemas'];

const nameSchema = z.object({ name: z.string().trim().min(1).max(64) });

const membershipSchema = z.object({
  userId: z.string().uuid(),
  teamAdmin: z.boolean().default(false),
});

/**
 * Teams and their rosters.
 *
 * `SessionGuard` is on the class and `AdminGuard` is deliberately NOT, because the authority these
 * endpoints need is not one thing. §6.1 has two administrators: the organisation's, whose scope is
 * everything, and the team's, whose scope is one team. Renaming a team and changing who is in it
 * are open to both; creating and deleting a team are open only to the first, because a team
 * administrator deleting the team they administer would be a role that can dissolve its own scope.
 * Reading is open to everyone — a permission has to be granted to a target somebody can name.
 *
 * Mounting `AdminGuard` on the class and exempting routes was the alternative and is worse: an
 * exemption is invisible at the route, so the day a route is added the reader has to know which
 * list it is on. Asking for the authority inside each handler puts the answer next to the work.
 */
@Controller('teams')
@UseGuards(SessionGuard)
export class TeamsController {
  constructor(
    private readonly teams: TeamsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<Schemas['TeamPage']> {
    const session = requireSession(request);
    const rows = await this.teams.list(session.organizationId);
    return { items: rows.map(toTeam) };
  }

  @Post()
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['Team']> {
    requireSameOrigin(request);
    const session = requireOrganizationAdmin(request);
    const parsed = nameSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('a name of 1 to 64 characters is required');

    try {
      const team = await this.teams.create(session.organizationId, parsed.data.name);
      await this.audit.record(session.organizationId, {
        actorId: session.userId,
        action: 'team.created',
        target: { kind: 'team', id: team.id, label: team.name },
        summary: `'${team.name}' ekibi kuruldu.`,
      });
      return toTeam(team);
    } catch (error) {
      throw translate(error);
    }
  }

  @Patch(':id')
  async rename(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Schemas['Team']> {
    requireSameOrigin(request);
    const session = requireSession(request);
    requireUuid(id);
    const parsed = nameSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('a name of 1 to 64 characters is required');

    await this.requireTeamAuthority(session, id);
    try {
      return toTeam(await this.teams.rename(session.organizationId, id, parsed.data.name));
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * Delete a team — organisation administrators only, and with a preview on request.
   *
   * Two statuses from one handler, which is what the contract asks for: 200 carrying the impact
   * when `dryRun=true`, 204 when the deletion happened. The alternative shapes were a separate
   * preview endpoint (a second URL that has to be kept in step with the first) and a 200 that
   * always carries the impact (which makes "did this delete anything" a property of a query
   * parameter the caller has to remember it sent).
   */
  @Delete(':id')
  async remove(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
    @Query('dryRun') dryRun?: string,
  ): Promise<Schemas['PermissionImpact'] | undefined> {
    requireSameOrigin(request);
    const session = requireOrganizationAdmin(request);
    requireUuid(id);

    const preview = isDryRun(dryRun);
    try {
      const impact = await this.teams.remove(session.organizationId, id, { dryRun: preview });
      if (!preview) {
        // Silinen ekibin adı artık okunamaz; kimlik ve ETKİ kalır. Bir ekip silmek, üyelerinin o
        // ekip üzerinden aldığı her izni birden kaldırmaktır — kaydedilecek şey tam da bu.
        await this.audit.record(session.organizationId, {
          actorId: session.userId,
          action: 'team.deleted',
          target: { kind: 'team', id },
          // Adlar sınırlı, izin özetiyle aynı gerekçeyle: büyük bir ekibi silmek herkesi
          // etkileyebilir ve tam liste 500 karakterlik özet sınırına çarpardı.
          summary:
            impact.usersLosing.length > 0
              ? `Ekip silindi; erişimi kalkan ${impact.usersLosing.length} kişi: ${impact.usersLosing
                  .slice(0, 3)
                  .map((u) => u.username)
                  .join(', ')}${impact.usersLosing.length > 3 ? ' ve diğerleri' : ''}.`
              : 'Ekip silindi; kimsenin erişimi değişmedi.',
        });
        response.status(204);
        return undefined;
      }
      return toImpact(impact);
    } catch (error) {
      throw translate(error);
    }
  }

  @Get(':id/members')
  async members(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<Schemas['TeamMemberPage']> {
    const session = requireSession(request);
    requireUuid(id);
    try {
      const rows = await this.teams.members(session.organizationId, id);
      return { items: rows.map(toMember) };
    } catch (error) {
      throw translate(error);
    }
  }

  @Put(':id/members')
  async putMember(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Schemas['TeamMember']> {
    requireSameOrigin(request);
    const session = requireSession(request);
    requireUuid(id);
    const parsed = membershipSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('userId must be a UUID');

    await this.requireTeamAuthority(session, id);
    try {
      const row = await this.teams.putMember(
        session.organizationId,
        id,
        parsed.data.userId,
        parsed.data.teamAdmin,
      );
      // Bir ekibe üye eklemek erişim VEREN işlemdir: ekibin her klasör izni o kişiye de işler.
      await this.audit.record(session.organizationId, {
        actorId: session.userId,
        action: 'team.member-added',
        target: { kind: 'user', id: parsed.data.userId, label: row.username },
        summary: `'${row.username}' ekibe eklendi${parsed.data.teamAdmin ? ' (ekip yöneticisi olarak)' : ''}.`,
      });
      return toMember(row);
    } catch (error) {
      throw translate(error);
    }
  }

  @Delete(':id/members/:userId')
  async removeMember(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Query('dryRun') dryRun?: string,
  ): Promise<Schemas['PermissionImpact'] | undefined> {
    requireSameOrigin(request);
    const session = requireSession(request);
    requireUuid(id);
    requireUuid(userId);

    await this.requireTeamAuthority(session, id);
    const preview = isDryRun(dryRun);
    try {
      const impact = await this.teams.removeMember(session.organizationId, id, userId, {
        dryRun: preview,
      });
      if (!preview) {
        await this.audit.record(session.organizationId, {
          actorId: session.userId,
          action: 'team.member-removed',
          target: { kind: 'user', id: userId },
          summary:
            impact.usersLosing.length > 0
              ? `Üye ekipten çıkarıldı; ${impact.foldersAffected} klasöre erişimi değişti.`
              : 'Üye ekipten çıkarıldı; erişimi değişmedi.',
        });
        response.status(204);
        return undefined;
      }
      return toImpact(impact);
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * Either authority will do here: the organisation's administrator, or this team's.
   *
   * A team that does not exist in this tenant answers 404 BEFORE the authority is weighed, and that
   * ordering leaks nothing that `GET /teams` does not already publish to every member. Weighing
   * authority first would answer 403 for a team id that is not there, which tells a caller probing
   * ids that some of them name real teams.
   */
  private async requireTeamAuthority(session: Caller, teamId: string): Promise<void> {
    await this.teams.find(session.organizationId, teamId).catch((error: unknown) => {
      throw translate(error);
    });
    if (session.role === 'admin') return;
    if (await this.teams.isTeamAdmin(session.organizationId, teamId, session.userId)) return;
    throw new ForbiddenException('this endpoint is for administrators of this team');
  }
}

export function toTeam(row: TeamRow): Schemas['Team'] {
  return {
    id: row.id,
    name: row.name,
    memberCount: row.member_count,
    // Reported even when null, because null is information: the team exists in DEPSIS and does not
    // exist on the filesystem, so a permission granted to it is visible on the web and absent over
    // SMB. Hiding the field would make the interface unable to say so (migration 0015, ADR-0021).
    posixGid: row.posix_gid,
    createdAt: row.created_at.toISOString(),
  };
}

export function toMember(row: TeamMemberRow): Schemas['TeamMember'] {
  return {
    userId: row.user_id,
    username: row.username,
    teamAdmin: row.team_admin,
    addedAt: row.added_at.toISOString(),
  };
}

function toImpact(impact: ImpactSummary): Schemas['PermissionImpact'] {
  return {
    foldersAffected: impact.foldersAffected,
    usersGaining: impact.usersGaining.map((user) => ({
      userId: user.userId,
      username: user.username,
      before: [...user.before],
      after: [...user.after],
    })),
    usersLosing: impact.usersLosing.map((user) => ({
      userId: user.userId,
      username: user.username,
      before: [...user.before],
      after: [...user.after],
    })),
  };
}

interface Caller {
  organizationId: string;
  userId: string;
  role: UserRole;
}

function requireSession(request: AuthenticatedRequest): Caller {
  const session = request.depsis;
  if (session === undefined) throw new UnauthorizedException();
  return {
    organizationId: session.organizationId,
    userId: session.userId,
    role: session.role,
  };
}

/**
 * The organisation's administrator, checked in the handler rather than by `AdminGuard`.
 *
 * Same refusal and same reasoning as the guard — 403, because these routes leak nothing by
 * admitting they exist — but reachable from a controller whose other routes need a different
 * authority. The guard stays the right tool for a controller where every route wants it.
 */
function requireOrganizationAdmin(request: AuthenticatedRequest): Caller {
  const session = requireSession(request);
  if (session.role !== 'admin') {
    throw new ForbiddenException('this endpoint is for administrators');
  }
  return session;
}

/**
 * An id that is not a UUID is "no such team", not a fault.
 *
 * Every id here reaches PostgreSQL as a `uuid`, so a mistyped one comes back as SQLSTATE 22P02 and,
 * with nothing mapping it, surfaces as a 500 — an error page for a bad link. It would also
 * distinguish a malformed id from a well-formed one naming another tenant's row, which is the
 * distinction RLS exists to erase.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(id: string): void {
  if (!UUID.test(id)) throw new NotFoundException();
}

function translate(error: unknown): Error {
  if (error instanceof TeamNotFoundError) return new NotFoundException();
  if (error instanceof TeamMemberNotFoundError) return new NotFoundException();
  if (error instanceof TeamNameTakenError) return new ConflictException(error.message);
  // 409, and the contract does not list it for this route — see the notes. The state of the tenant
  // is what refuses the delete, and the sentence says which write clears it, so a status the
  // caller can act on is worth more here than one the document already blesses.
  if (error instanceof LastGrantInShareError) return new ConflictException(error.message);
  return error instanceof Error ? error : new Error(String(error));
}
