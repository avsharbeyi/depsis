import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { CONSOLE_SOCKET_DEFAULT, type AppConfig } from '../config.js';
import { APP_CONFIG } from '../config.module.js';
import { DbService } from '../db/db.service.js';
import { ConsoleController } from './console.controller.js';
import { ConsoleService } from './console.service.js';

/**
 * The administrator console (ADR-0018).
 *
 * The socket path comes from configuration and is handed to the service as an argument, so a
 * deployment that moves the socket is a unit-file change rather than a code change — and so a test
 * can point the service at a socket it created itself.
 *
 * Nothing is exported. There is one way into a shell on this appliance and it is these endpoints,
 * behind `AdminGuard` and a password; a second caller inside the process would be a second place
 * that gate would have to exist.
 */
@Module({
  imports: [AuthModule],
  controllers: [ConsoleController],
  providers: [
    {
      provide: ConsoleService,
      inject: [DbService, APP_CONFIG],
      useFactory: (db: DbService, config: AppConfig) =>
        new ConsoleService(db, config.consoleSocket ?? CONSOLE_SOCKET_DEFAULT),
    },
  ],
})
export class ConsoleModule {}
