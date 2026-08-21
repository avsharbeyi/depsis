import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';

import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { JobsService } from './jobs.service.js';

type Schemas = OpenApi.components['schemas'];
type JobResponse = Schemas['Job'];

@Controller('jobs')
@UseGuards(SessionGuard)
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  /**
   * GET /jobs/:jobId — how a long-running operation is going.
   *
   * A job belonging to another tenant is a 404, identical to a job that does not exist. Row level
   * security already makes them the same query result, and they should be the same ANSWER too: a
   * 403 here would confirm that the id names something real, turning this endpoint into an oracle
   * for which job ids exist elsewhere.
   */
  @Get(':jobId')
  async find(
    @Req() request: AuthenticatedRequest,
    @Param('jobId') jobId: string,
  ): Promise<JobResponse> {
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();

    const job = await this.jobs.find(session.organizationId, jobId);
    if (job === null) throw new NotFoundException();

    return {
      id: job.id,
      kind: job.kind,
      status: job.status,
      progress: job.progress,
      createdAt: job.createdAt.toISOString(),
      // `error` is present only when there is one. The queue stores a single string, so it is
      // carried as the title; inventing a `type`, `status` and `code` for a failure that happened
      // inside a worker would be dressing a message up as a classified problem it never was.
      ...(job.lastError === null
        ? {}
        : {
            error: {
              type: 'about:blank',
              title: job.lastError,
              status: 500,
              code: 'job_failed',
              correlationId: job.id,
            },
          }),
    };
  }
}
