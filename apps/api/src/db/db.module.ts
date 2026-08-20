import { Global, Module } from '@nestjs/common';

import { loadConfig } from '../config.js';
import { DbService } from './db.service.js';

/**
 * Global so that no feature module has to import it — and, more to the point, so that there is
 * exactly one `DbService` and therefore exactly one pool in the process. A second pool created by a
 * module that "just needed a connection" would be a second path to the database that ADR-0015's
 * guarantees do not cover.
 */
@Global()
@Module({
  providers: [
    {
      provide: DbService,
      useFactory: () => new DbService(loadConfig().databaseUrl),
    },
  ],
  exports: [DbService],
})
export class DbModule {}
