import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AgentModule } from './agent/agent.module.js';
import { ConfigModule } from './config.module.js';
import { AuthModule } from './auth/auth.module.js';
import { SameOriginGuard } from './auth/same-origin.guard.js';
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
  // Global, so a controller added next month is covered without anyone remembering. The
  // per-controller `requireSameOrigin` calls stay where they are: they run first, they agree with
  // this, and a route that states its own defence is a route whose test can fail on its own.
  providers: [{ provide: APP_GUARD, useClass: SameOriginGuard }],
})
export class AppModule {}
