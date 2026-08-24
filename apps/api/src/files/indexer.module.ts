import { Module } from '@nestjs/common';

import { CopyModule } from './copy.module.js';
import { IndexerService } from './indexer.service.js';

/**
 * The reconciliation walk, as a providers-only module.
 *
 * `CopyModule` supplies `FilesService` and `AgentModule` without the five controllers and the auth
 * flow `FilesModule` would drag into a process that has no requests (`worker-surface.ts`).
 */
@Module({
  imports: [CopyModule],
  providers: [IndexerService],
  exports: [IndexerService],
})
export class IndexerModule {}
