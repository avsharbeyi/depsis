import { Module } from '@nestjs/common';

import { CopyModule } from './copy.module.js';
import { TrashRetentionService } from './trash-retention.service.js';

/**
 * The bin's expiry, as a providers-only module.
 *
 * Imports `CopyModule` for its `FilesService` and nothing else: `FilesModule` declares five
 * controllers and imports `AuthModule`, so a worker importing it would instantiate the session
 * guard and the whole auth flow in a process with no requests — the thing `worker-surface.ts`
 * calls deliberately absent.
 */
@Module({
  imports: [CopyModule],
  providers: [TrashRetentionService],
  exports: [TrashRetentionService],
})
export class TrashRetentionModule {}
