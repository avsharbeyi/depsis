import { Module } from '@nestjs/common';

import { AgentModule } from './agent/agent.module.js';
import { ConfigModule } from './config.module.js';
import { AuthModule } from './auth/auth.module.js';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { MeModule } from './me/me.module.js';
import { OrganizationsModule } from './organizations/organizations.module.js';
import { SetupModule } from './setup/setup.module.js';
import { SystemModule } from './system/system.module.js';

@Module({
  imports: [
    ConfigModule,
    DbModule,
    AgentModule,
    AuthModule,
    HealthModule,
    JobsModule,
    MeModule,
    OrganizationsModule,
    SetupModule,
    SystemModule,
  ],
})
export class AppModule {}
