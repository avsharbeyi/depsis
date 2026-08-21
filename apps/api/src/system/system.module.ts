import { Module } from '@nestjs/common';

import { AgentService } from '../agent/agent.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { APP_CONFIG } from '../config.module.js';
import type { AppConfig } from '../config.js';
import { DbService } from '../db/db.service.js';
import { SystemController } from './system.controller.js';
import { SystemService } from './system.service.js';

@Module({
  imports: [AuthModule],
  controllers: [SystemController],
  providers: [
    {
      provide: SystemService,
      inject: [AgentService, DbService, APP_CONFIG],
      useFactory: (agent: AgentService, db: DbService, config: AppConfig) =>
        new SystemService(agent, db, config.zfsPools),
    },
  ],
})
export class SystemModule {}
