import { Module } from '@nestjs/common';

import { AgentModule } from './agent/agent.module.js';
import { ConfigModule } from './config.module.js';
import { AuthModule } from './auth/auth.module.js';
import { DbModule } from './db/db.module.js';
import { FilesModule } from './files/files.module.js';
import { HealthModule } from './health/health.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { MeModule } from './me/me.module.js';
import { OrganizationsModule } from './organizations/organizations.module.js';
import { SetupModule } from './setup/setup.module.js';
import { SystemModule } from './system/system.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule,
    DbModule,
    FilesModule,
    AgentModule,
    AuthModule,
    HealthModule,
    JobsModule,
    MeModule,
    OrganizationsModule,
    SetupModule,
    SystemModule,
    UsersModule,
  ],
})
export class AppModule {}
