import { Global, Module } from '@nestjs/common';

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
  providers: [PosixIdentityService],
  exports: [PosixIdentityService],
})
export class PosixIdentityModule {}
