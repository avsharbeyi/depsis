import { Module } from '@nestjs/common';

import { AgentService } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import { PosixIdentityService } from '../identity/posix.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import { SystemService } from '../system/system.service.js';

import { AuthModule } from '../auth/auth.module.js';
import { IdempotencyModule } from '../common/idempotency.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { SystemModule } from '../system/system.module.js';
import { CopyModule } from './copy.module.js';
import { FileOperationsController } from './file-operations.controller.js';
import { FilesController } from './files.controller.js';
import { TrashPolicyController } from './trash-policy.controller.js';
import { TrashRetentionModule } from './trash-retention.module.js';
import { ThumbnailsService } from './thumbnails.service.js';
import { FilesService } from './files.service.js';
import { SearchController } from './search.controller.js';
import { SnapshotBrowseController } from './snapshots.controller.js';
import { TransfersController } from './transfers.controller.js';
import { TransfersService } from './transfers.service.js';
import { UploadsController } from './uploads.controller.js';

/**
 * The file tree, the resumable upload surface, name search, and the transfer list.
 *
 * `SearchController` lives here rather than in a module of its own because it searches this
 * module's table through this module's service — a `SearchModule` would exist only to import
 * `FilesModule` and re-export nothing. `TransfersController` is here for the same reason: it
 * reports on `upload_sessions`, the table `UploadsController` writes, and a transfer list kept
 * anywhere else would be a second opinion about an upload that this module owns.
 *
 * `AgentModule` and `DbModule` are global, so nothing is imported for them here; `AuthModule`
 * supplies `SessionGuard`, which every route in all four controllers sits behind.
 */
@Module({
  imports: [
    AuthModule,
    JobsModule,
    IdempotencyModule,
    CopyModule,
    TrashRetentionModule,
    // For `BackupsService` alone — the snapshot browser needs the pool's own inventory, and
    // asking the agent a second time from here would be a second answer to "which snapshots
    // exist", one of which would eventually be wrong.
    SystemModule,
  ],
  controllers: [
    FilesController,
    FileOperationsController,
    TrashPolicyController,
    UploadsController,
    SearchController,
    TransfersController,
    SnapshotBrowseController,
  ],
  providers: [
    {
      provide: FilesService,
      inject: [DbService, AgentService, PosixIdentityService, JobsService, SystemService],
      // The parent-dataset resolver is a FUNCTION, wired here exactly as shares.module wires it:
      // the default share may only claim a dataset the agent actually made, and only the system
      // service knows what new datasets are created under.
      useFactory: (
        db: DbService,
        agent: AgentService,
        posix: PosixIdentityService,
        jobs: JobsService,
        system: SystemService,
      ) =>
        new FilesService(db, agent, posix, jobs, (correlationId) =>
          system.parentDataset(correlationId),
        ),
    },
    TransfersService,
    ThumbnailsService,
  ],
  exports: [FilesService],
})
export class FilesModule {}
