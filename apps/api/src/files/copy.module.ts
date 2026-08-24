import { Module } from '@nestjs/common';

import { AgentModule } from '../agent/agent.module.js';
import { PosixIdentityModule } from '../identity/posix.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { CopyService } from './copy.service.js';
import { FilesService } from './files.service.js';

/**
 * `CopyService` and the one collaborator it needs, with NO controllers.
 *
 * `FilesModule` cannot be imported by the worker: it declares four controllers and imports
 * `AuthModule`, so importing it would instantiate the session guard and the whole auth flow in a
 * process that has no requests — the thing `worker-surface.ts` calls deliberately absent. This
 * module provides the same `FilesService` from the same file, without any of that.
 *
 * `PosixIdentityModule` is `@Global()` and the worker already imports it, so it is listed here for
 * the API process rather than re-provided: a second `PosixIdentityService` would be a second
 * allocator handing out uids beside the first.
 */
@Module({
  imports: [AgentModule, JobsModule, PosixIdentityModule],
  providers: [CopyService, FilesService],
  exports: [CopyService, FilesService],
})
export class CopyModule {}
