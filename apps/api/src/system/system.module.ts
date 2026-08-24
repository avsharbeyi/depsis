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
import { PoolsController } from './pools.controller.js';
import { SystemController } from './system.controller.js';
import { SystemService } from './system.service.js';

@Module({
  imports: [AuthModule, IdempotencyModule, JobsModule],
  controllers: [SystemController, BackupsController, PoolsController],
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
  exports: [SystemService],
})
export class SystemModule {}
