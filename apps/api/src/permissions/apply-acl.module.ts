import { Module } from '@nestjs/common';

import { AclApplyService } from './apply-acl.service.js';

/**
 * The POSIX application, on its own so the worker can have it without the HTTP surface.
 *
 * `PermissionsModule` brings a controller, a session guard and the whole auth chain with it, none
 * of which a background process has any use for — `worker-surface.ts` says why that boundary is
 * narrow on purpose. `DbModule`, `AgentModule` and `PosixIdentityModule` are global, so nothing is
 * imported here.
 */
@Module({
  providers: [AclApplyService],
  exports: [AclApplyService],
})
export class AclApplyModule {}
