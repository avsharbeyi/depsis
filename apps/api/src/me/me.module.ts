import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { FilesModule } from '../files/files.module.js';
import { PasswordService } from '../auth/password.service.js';
import { MeController } from './me.controller.js';
import { PreferencesController } from './preferences.controller.js';
import { PreferencesService } from './preferences.service.js';

/**
 * `FilesModule` is imported for its `FilesService`, which is how a chosen background is checked
 * against a file the caller can actually read. Reaching into `file_entries` with a query of our
 * own here would be a second place that decides what "an accessible, untrashed file" means.
 */
@Module({
  imports: [AuthModule, FilesModule],
  controllers: [MeController, PreferencesController],
  providers: [PasswordService, PreferencesService],
})
export class MeModule {}
