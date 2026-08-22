import {
  Body,
  Controller,
  Get,
  Put,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';

import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { PreferencesRejectedError, PreferencesService } from './preferences.service.js';

type Schemas = OpenApi.components['schemas'];

/**
 * One person's interface preferences.
 *
 * Behind `SessionGuard`, so both the tenant and the user come from the session (ADR-0015 §6).
 * Neither route takes a user id and neither should ever grow one: an endpoint that accepted one
 * would be an endpoint that eventually writes somebody else's desk.
 *
 * Same-origin is the global `SameOriginGuard`, so the PUT is not repeated here.
 */
@Controller('me/preferences')
@UseGuards(SessionGuard)
export class PreferencesController {
  constructor(private readonly preferences: PreferencesService) {}

  @Get()
  async read(@Req() request: AuthenticatedRequest): Promise<Schemas['Preferences']> {
    const session = requireSession(request);
    return this.preferences.read(session.organizationId, session.userId);
  }

  @Put()
  async write(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['Preferences']> {
    const session = requireSession(request);
    try {
      return await this.preferences.write(session.organizationId, session.userId, body);
    } catch (error) {
      throw translate(error);
    }
  }
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
 * 422 rather than 400 for every refusal here, which the contract fixes and which is also right:
 * the body parsed as JSON and the request was understood. What failed is the document — an
 * unrecognised field, a shortcut off the grid, a background naming a file that is not there.
 */
function translate(error: unknown): Error {
  if (error instanceof PreferencesRejectedError) {
    return new UnprocessableEntityException(error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}
