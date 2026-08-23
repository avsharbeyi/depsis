import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';
import { SearchController } from './search.controller.js';
import { TransfersController } from './transfers.controller.js';
import { TransfersService } from './transfers.service.js';
import { UploadsController } from './uploads.controller.js';

/**
 * The file tree, the resumable upload surface, name search, and the transfer list.
 *
 * `SearchController` lives here rather than in a module of its own because it searches this
 * module's table through this module's service — a `SearchModule` would exist only to import
 * `FilesModule` and re-export nothing. `TransfersController` is here for the same reason: it
 * reports on `upload_sessions`, the table `UploadsController` writes, and a transfer list kept
 * anywhere else would be a second opinion about an upload that this module owns.
 *
 * `AgentModule` and `DbModule` are global, so nothing is imported for them here; `AuthModule`
 * supplies `SessionGuard`, which every route in all four controllers sits behind.
 */
@Module({
  imports: [AuthModule, JobsModule],
  controllers: [FilesController, UploadsController, SearchController, TransfersController],
  providers: [FilesService, TransfersService],
  exports: [FilesService],
})
export class FilesModule {}
