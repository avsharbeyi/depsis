import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';
import { UploadsController } from './uploads.controller.js';

/**
 * The file tree and the resumable upload surface.
 *
 * `AgentModule` and `DbModule` are global, so nothing is imported for them here; `AuthModule`
 * supplies `SessionGuard`, which every route in both controllers sits behind.
 */
@Module({
  imports: [AuthModule],
  controllers: [FilesController, UploadsController],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
