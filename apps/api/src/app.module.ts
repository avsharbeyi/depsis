import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { AgentModule } from './agent/agent.module.js';
import { AppsModule } from './apps/apps.module.js';
import { ConfigModule } from './config.module.js';
import { AuditModule } from './audit/audit.module.js';
import { ConsoleModule } from './console/console.module.js';
import { AuthModule } from './auth/auth.module.js';
import { SameOriginGuard } from './auth/same-origin.guard.js';
import { correlationMiddleware } from './common/correlation.js';
import { ProblemFilter } from './common/problem.filter.js';
import { DbModule } from './db/db.module.js';
import { DeskModule } from './desk/desk.module.js';
import { EventsModule } from './events/events.module.js';
import { FilesModule } from './files/files.module.js';
import { HealthModule } from './health/health.module.js';
import { PosixIdentityModule } from './identity/posix.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { MeModule } from './me/me.module.js';
import { OrganizationsModule } from './organizations/organizations.module.js';
import { PermissionsModule } from './permissions/permissions.module.js';
import { RemoteModule } from './remote/remote.module.js';
import { SetupModule } from './setup/setup.module.js';
import { SharesModule } from './shares/shares.module.js';
import { SystemModule } from './system/system.module.js';
import { TeamsModule } from './teams/teams.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    AuditModule,
    ConfigModule,
    ConsoleModule,
    DbModule,
    DeskModule,
    EventsModule,
    FilesModule,
    AgentModule,
    AppsModule,
    AuthModule,
    HealthModule,
    JobsModule,
    PosixIdentityModule,
    MeModule,
    OrganizationsModule,
    PermissionsModule,
    RemoteModule,
    SetupModule,
    SharesModule,
    SystemModule,
    TeamsModule,
    UsersModule,
  ],
  // Global, so a controller added next month is covered without anyone remembering. The
  // per-controller `requireSameOrigin` calls stay where they are: they run first, they agree with
  // this, and a route that states its own defence is a route whose test can fail on its own.
  providers: [
    { provide: APP_GUARD, useClass: SameOriginGuard },
    // RFC 9457 on every error the API produces. Registered here rather than in `main()` because
    // every integration suite builds its own Nest app and none of them call `main()` — a filter
    // installed at the bootstrap would be a filter no test ever runs, which is the same reason
    // the same-origin guard is a provider and not a line in `main()`.
    { provide: APP_FILTER, useClass: ProblemFilter },
  ],
})
export class AppModule implements NestModule {
  /**
   * The correlation id, on every request before any route sees it.
   *
   * Middleware rather than an interceptor: an interceptor runs inside the routing layer, so a
   * request that matches no route never reaches one — and a 404 from the router is exactly the
   * response somebody will be trying to trace.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(correlationMiddleware).forRoutes('*');
  }
}
