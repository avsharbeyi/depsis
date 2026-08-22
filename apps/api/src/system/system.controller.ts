import {
  Controller,
  ForbiddenException,
  Get,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { AgentUnavailableError } from '../agent/agent.service.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { SystemService, type Telemetry } from './system.service.js';

@Controller('system')
@UseGuards(SessionGuard)
export class SystemController {
  constructor(private readonly system: SystemService) {}

  /**
   * GET /system/telemetry — hardware and storage status.
   *
   * Administrator only. The contract says the response narrows by role; nothing here narrows a
   * payload, so this implements the half that can be implemented honestly — a non-administrator is
   * refused outright rather than shown a payload trimmed by rules nobody has written down. Showing
   * ordinary users a narrowed view is a change to make with those rules written down, not one to
   * improvise here.
   *
   * Which administrator: the ONE account in `system_setup`, not everyone with `role = 'admin'`.
   * That is deliberately noted rather than assumed, because `POST /backups` next door uses
   * `AdminGuard` and therefore admits a wider set for a more privileged operation. See the note on
   * `SystemService.isSystemAdministrator` — the two want reconciling as one decision.
   */
  @Get('telemetry')
  async telemetry(@Req() request: AuthenticatedRequest): Promise<Telemetry> {
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();

    if (!(await this.system.isSystemAdministrator(session.userId))) {
      // 403, not 404. The endpoint's existence is in the published contract, so hiding it would
      // conceal nothing while making a legitimate administrator's misconfiguration harder to
      // diagnose. What is withheld is the system detail, not the fact that it exists.
      throw new ForbiddenException();
    }

    // One id per HTTP request, carried into every privileged call the request makes, so the agent's
    // audit trail can be read back to the request that caused it (§16).
    const correlationId = randomUUID();

    try {
      return await this.system.telemetry(correlationId);
    } catch (error) {
      if (error instanceof AgentUnavailableError) {
        // Deliberately not a 200 with an empty `pools`. "There are no pools" and "we could not find
        // out" are the two answers an operator most needs to tell apart, and the second one is the
        // one that means something is wrong right now.
        throw new ServiceUnavailableException(
          'Storage status is unavailable: the system agent could not be reached.',
        );
      }
      throw error;
    }
  }
}
