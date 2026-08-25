import { Module } from '@nestjs/common';

import { AgentModule } from '../agent/agent.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { BackupSchedulesService } from './backup-schedules.service.js';

/**
 * `BackupSchedulesService` and the two collaborators it needs, with NO controllers.
 *
 * `SystemModule` cannot be imported by the worker: it declares five controllers and imports
 * `AuthModule`, so importing it would instantiate the session guard and the whole auth flow in a
 * process that has no requests — the thing `worker-surface.ts` calls deliberately absent.
 * `CopyModule` exists for exactly this reason and says so in the same words.
 */
@Module({
  imports: [AgentModule, JobsModule],
  providers: [BackupSchedulesService],
  exports: [BackupSchedulesService],
})
export class BackupSchedulesModule {}
