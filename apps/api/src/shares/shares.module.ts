import { Module } from '@nestjs/common';

import { AgentService } from '../agent/agent.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { APP_CONFIG } from '../config.module.js';
import { SMB_HOST_DEFAULT, type AppConfig } from '../config.js';
import { DbService } from '../db/db.service.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { JobsService } from '../jobs/jobs.service.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { SharesController } from './shares.controller.js';
import { SmbController } from './smb.controller.js';
import { SharesService } from './shares.service.js';

/**
 * Shares and the SMB publish.
 *
 * `SmbController` lives here rather than in `SystemModule` even though it serves a `/system/` path:
 * publishing writes the cache that `GET /shares` reads, and a cache written in one module and read
 * in another is a cache that will one day be two.
 *
 * `SharesService` is a factory provider for the same reason `SystemService` is — one value comes
 * from the environment. It is also the reason this module has exactly one instance of the service:
 * the publish cache is per-process state, and a second instance would answer `published` from a
 * set nobody had filled in.
 *
 * `AgentModule` and `DbModule` are global; `AuthModule` supplies the guards, and
 * `OrganizationsModule` supplies the one question `publish` has to ask about the whole device.
 */
@Module({
  imports: [AuthModule, OrganizationsModule, JobsModule],
  controllers: [SharesController, SmbController],
  providers: [
    {
      provide: SharesService,
      inject: [DbService, AgentService, OrganizationsService, APP_CONFIG, JobsService],
      useFactory: (
        db: DbService,
        agent: AgentService,
        organizations: OrganizationsService,
        config: AppConfig,
        jobs: JobsService,
      ) =>
        new SharesService(
          db,
          agent,
          organizations,
          config.smbHost ?? SMB_HOST_DEFAULT,
          // `?? null` rather than a default: there is no sensible pool name to guess, and a wrong
          // one produces datasets nothing serves. Absent means `POST /shares` answers 503.
          config.shareParentDataset ?? null,
          jobs,
        ),
    },
  ],
  exports: [SharesService],
})
export class SharesModule {}
