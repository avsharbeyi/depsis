import { Module } from '@nestjs/common';

import { AgentService } from '../agent/agent.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { IdempotencyModule } from '../common/idempotency.module.js';
import { APP_CONFIG } from '../config.module.js';
import type { AppConfig } from '../config.js';
import { DbService } from '../db/db.service.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { BackupsController } from './backups.controller.js';
import { BackupsService } from './backups.service.js';
import { BackupSchedulesController } from './backup-schedules.controller.js';
import { BackupSchedulesModule } from './backup-schedules.module.js';
import { DatabaseBackupsController } from './database-backups.controller.js';
import { OffsiteController } from './offsite.controller.js';
import { PoolsController } from './pools.controller.js';
import { ReplicationController } from './replication.controller.js';
import { DiskWipeController } from './disk-wipe.controller.js';
import { ProcessesController } from './processes.controller.js';
import { SystemController } from './system.controller.js';
import { SystemService } from './system.service.js';
import { UpdateController } from './update.controller.js';

@Module({
  imports: [AuthModule, IdempotencyModule, JobsModule, BackupSchedulesModule],
  controllers: [
    SystemController,
    BackupsController,
    PoolsController,
    ReplicationController,
    OffsiteController,
    BackupSchedulesController,
    DatabaseBackupsController,
    DiskWipeController,
    ProcessesController,
    UpdateController,
  ],
  providers: [
    {
      provide: SystemService,
      inject: [AgentService, DbService, APP_CONFIG],
      // Which POOLS comes from configuration: the agent's closed operation set has no "list
      // pools", so there is nothing to discover from. Which DISKS no longer has to —
      // `ListDisks` closed that half — and `config.smartDisks` is now a narrowing rather than
      // the only source; empty means ask the box (see `SystemService.smartTargets`).
      useFactory: (agent: AgentService, db: DbService, config: AppConfig) =>
        new SystemService(
          agent,
          db,
          config.zfsPools,
          config.smartDisks,
          config.shareParentDataset ?? null,
        ),
    },
    // An ordinary provider, unlike SystemService, because nothing about it comes from
    // configuration — which datasets may be snapshotted is read from the tenant's own shares
    // rather than from a deployment setting, and a setting would be the wrong shape for it: the
    // answer differs per organisation and changes whenever a share is created.
    BackupsService,
  ],
  // `SystemService` is exported for `SharesModule`, which asks it where new datasets go. That used
  // to be a string fixed at construction from `DEPSIS_SHARE_PARENT_DATASET`, so the only way to
  // change it was to edit a file and restart — the last shell step in the flow the pool wizard
  // exists to remove.
  // `BackupsService` as well as `SystemService`: `FilesModule`'s snapshot browser asks the pool
  // what snapshots a share's dataset actually holds, and the rule that makes that answer
  // trustworthy — null when the agent could not be asked, never an empty list — has one
  // implementation here rather than a second one beside the file tree.
  exports: [SystemService, BackupsService],
})
export class SystemModule {}
