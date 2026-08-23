import { Global, Logger, Module } from '@nestjs/common';

import { AgentService } from '../agent/agent.service.js';
import { loadSecretBox } from '../auth/secret-box.js';
import { APP_CONFIG } from '../config.module.js';
import type { AppConfig } from '../config.js';
import { DbService } from '../db/db.service.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { JobsService } from '../jobs/jobs.service.js';
import { IdentitySyncService } from './identity-sync.service.js';
import { PosixIdentityService } from './posix.service.js';

/**
 * The mapping from a DEPSIS account onto a numeric filesystem identity.
 *
 * Global, and for the same reason `AgentModule` and `DbModule` are: every side of the product that
 * writes to a share needs the answer — uploads stamp an owner on a published file, folder creation
 * stamps one on a directory, and account creation reserves one — and a second copy of "who is this
 * user on disk" is the kind of duplication that survives long enough to disagree with itself. A
 * global provider also keeps the module graph honest: `UsersModule` deliberately exports nothing,
 * so `FilesModule` importing it to reach a uid would have inverted that on the way past.
 *
 * `DbModule` is global, so nothing is imported here.
 */
@Global()
@Module({
  imports: [JobsModule],
  providers: [
    PosixIdentityService,
    {
      // A factory, because one value comes from the environment — the same shape `MfaService` has
      // and for the same reason. The key is READ ONCE here rather than per call: a file that
      // changes under a running process would otherwise silently seal some rows with one key and
      // some with another, and neither would open afterwards.
      provide: IdentitySyncService,
      inject: [DbService, AgentService, APP_CONFIG, JobsService],
      useFactory: (db: DbService, agent: AgentService, config: AppConfig, jobs: JobsService) => {
        const logger = new Logger('SmbCredential');
        return new IdentitySyncService(
          db,
          agent,
          loadSecretBox(config.secretKeyFile ?? null, {
            log: (m) => logger.log(m),
            warn: (m) => logger.warn(m),
            error: (m) => logger.error(m),
          }),
          jobs,
        );
      },
    },
  ],
  exports: [PosixIdentityService, IdentitySyncService],
})
export class PosixIdentityModule {}
