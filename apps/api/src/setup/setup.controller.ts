import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Post } from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { z } from 'zod';

/** See the note in auth.controller.ts: the contract owns these shapes, not this file. */
type Paths = OpenApi.paths;
type SetupStatusBody =
  Paths['/setup/status']['get']['responses']['200']['content']['application/json'];
type SetupClaimBody =
  Paths['/setup/claim']['post']['responses']['200']['content']['application/json'];

import { SetupService } from './setup.service.js';

const claimSchema = z.object({
  token: z.string().min(1).max(128),
  organizationSlug: z.string().min(1).max(63),
  organizationName: z.string().min(1).max(200),
  adminUsername: z.string().trim().min(1).max(64),
  adminDisplayName: z.string().min(1).max(200),
  adminPassword: z.string().min(1).max(1024),
});

/**
 * The setup endpoints, which stop answering the moment setup is done.
 *
 * `410 Gone` rather than `404`: the resource genuinely existed and genuinely will not come back,
 * and a wizard that got 404 would look like a routing problem to whoever is debugging it.
 */
@Controller('setup')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  /**
   * Unauthenticated on purpose — the web interface has to know which screen to show before anyone
   * can log in. It answers a boolean and nothing else: no organization name, no admin address, no
   * hint about what exists.
   */
  @Get('status')
  async status(): Promise<SetupStatusBody> {
    return { setupRequired: !(await this.setup.isComplete()) };
  }

  @Post('claim')
  @HttpCode(200)
  async claim(@Body() body: unknown): Promise<SetupClaimBody> {
    const parsed = claimSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        { message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
        HttpStatus.BAD_REQUEST,
      );
    }

    const result = await this.setup.claim(parsed.data);

    switch (result.outcome) {
      case 'ok':
        return { status: 'ok', organizationSlug: parsed.data.organizationSlug };
      case 'already-complete':
        throw new HttpException('setup has already been completed', HttpStatus.GONE);
      case 'bad-token':
        // No detail, and no distinction between "wrong token" and "no token is outstanding". Either
        // answer would tell someone probing the endpoint whether guessing is worth continuing.
        throw new HttpException('invalid setup token', HttpStatus.UNAUTHORIZED);
      case 'invalid':
        // Reasons ARE given here, unlike everywhere else: the caller is the machine's owner filling
        // in a form once, not an attacker probing for which field exists.
        throw new HttpException({ message: result.reason }, HttpStatus.BAD_REQUEST);
    }
  }
}
