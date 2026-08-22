import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { PermissionsController } from './permissions.controller.js';
import { PermissionsService } from './permissions.service.js';

/**
 * §6.2's folder permissions: the grant walk, the dry-run, and the write.
 *
 * A module of its own rather than a pair of routes inside `FilesModule`, because the same walk
 * answers for a share root — a row in `shares`, not in `file_entries` — and because this is the
 * one place that decides what anybody may do. A permission model living inside the module whose
 * access it governs is a model that will be reached around the first time it is inconvenient.
 *
 * `JobsModule` for the POSIX re-application, which ADR-0021 makes a queued job rather than a
 * trigger: the agent's `ApplyFolderAcl` is deliberately not recursive, so a change to one node is a
 * walk over its subtree and that does not belong in a request. `AuthModule` supplies
 * `SessionGuard`; `DbModule` and `AgentModule` are global.
 */
@Module({
  imports: [AuthModule, JobsModule],
  controllers: [PermissionsController],
  providers: [PermissionsService],
  exports: [PermissionsService],
})
export class PermissionsModule {}
