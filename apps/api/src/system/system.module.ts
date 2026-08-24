import { Module } from '@nestjs/common';

import { AgentService } from '../agent/agent.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { IdempotencyModule } from '../common/idempotency.module.js';
import { APP_CONFIG } from '../config.module.js';
import type { AppConfig } from '../config.js';
import { DbService } from '../db/db.service.js';
import { BackupsController } from './backups.controller.js';
import { BackupsService } from './backups.service.js';
import { SystemController } from './system.controller.js';
import { SystemService } from './system.service.js';

@Module({
  imports: [AuthModule, IdempotencyModule],
  controllers: [SystemController, BackupsController],
  providers: [
    {
      provide: SystemService,
      inject: [AgentService, DbService, APP_CONFIG],
      // Which pools and which disks come from configuration, not from discovery: the agent's
      // operation set is closed and has neither a "list pools" nor a "list disks" (ADR-0006).
      useFactory: (agent: AgentService, db: DbService, config: AppConfig) =>
        new SystemService(agent, db, config.zfsPools, config.smartDisks),
    },
    // An ordinary provider, unlike SystemService, because nothing about it comes from
    // configuration — which datasets may be snapshotted is read from the tenant's own shares
    // rather than from a deployment setting, and a setting would be the wrong shape for it: the
    // answer differs per organisation and changes whenever a share is created.
    BackupsService,
  ],
})
export class SystemModule {}
