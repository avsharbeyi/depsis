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
import {
  SystemService,
  type DiskInventory,
  type StorageSetup,
  type Telemetry,
} from './system.service.js';

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
  /**
   * GET /system/storage — is this box's storage set up, and with what?
   *
   * The same gate as the rest of `system/`. It reports pool names and a dataset path, which are
   * facts about the appliance rather than about anybody's files, but they are still the shape of
   * thing an operator is shown and a member is not.
   */
  @Get('storage')
  async storage(@Req() request: AuthenticatedRequest): Promise<StorageSetup> {
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();
    if (!(await this.system.isSystemAdministrator(session.userId))) {
      throw new ForbiddenException();
    }

    try {
      return await this.system.storageSetup(randomUUID());
    } catch (error) {
      if (error instanceof AgentUnavailableError) {
        // Not a 200 with everything absent. "Nothing is set up" is what a fresh appliance looks
        // like and is the state the wizard acts on; "we could not ask" must not render as it, or
        // the wizard offers to prepare a share root that already exists.
        throw new ServiceUnavailableException(
          'Depolama durumu okunamadı: sistem ajanına ulaşılamıyor.',
        );
      }
      throw error;
    }
  }

  /**
   * GET /system/disks — what is physically in the box.
   *
   * The same gate as telemetry, and for a stronger reason: this reports the model and serial of
   * every disk, and — through `holds` — what is on them. Neither is a user's business.
   */
  @Get('disks')
  async disks(@Req() request: AuthenticatedRequest): Promise<DiskInventory> {
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();
    if (!(await this.system.isSystemAdministrator(session.userId))) {
      throw new ForbiddenException();
    }

    try {
      return await this.system.inventory(randomUUID());
    } catch (error) {
      if (error instanceof AgentUnavailableError) {
        // Not a 200 with an empty list, for the same reason telemetry refuses one: the caller of
        // this endpoint is choosing disks to overwrite, and "there are none" is the most
        // dangerous wrong answer it could be given.
        throw new ServiceUnavailableException(
          'Disk envanteri okunamadı: sistem ajanına ulaşılamıyor.',
        );
      }
      throw error;
    }
  }

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
