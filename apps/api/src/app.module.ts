import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AgentModule } from './agent/agent.module.js';
import { AppsModule } from './apps/apps.module.js';
import { ConfigModule } from './config.module.js';
import { ConsoleModule } from './console/console.module.js';
import { AuthModule } from './auth/auth.module.js';
import { SameOriginGuard } from './auth/same-origin.guard.js';
import { DbModule } from './db/db.module.js';
import { DeskModule } from './desk/desk.module.js';
import { FilesModule } from './files/files.module.js';
import { HealthModule } from './health/health.module.js';
import { PosixIdentityModule } from './identity/posix.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { MeModule } from './me/me.module.js';
import { OrganizationsModule } from './organizations/organizations.module.js';
import { RemoteModule } from './remote/remote.module.js';
import { SetupModule } from './setup/setup.module.js';
import { SharesModule } from './shares/shares.module.js';
import { SystemModule } from './system/system.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule,
    ConsoleModule,
    DbModule,
    DeskModule,
    FilesModule,
    AgentModule,
    AppsModule,
    AuthModule,
    HealthModule,
    JobsModule,
    PosixIdentityModule,
    MeModule,
    OrganizationsModule,
    RemoteModule,
    SetupModule,
    SharesModule,
    SystemModule,
    UsersModule,
  ],
  // Global, so a controller added next month is covered without anyone remembering. The
  // per-controller `requireSameOrigin` calls stay where they are: they run first, they agree with
  // this, and a route that states its own defence is a route whose test can fail on its own.
  providers: [{ provide: APP_GUARD, useClass: SameOriginGuard }],
})
export class AppModule {}
