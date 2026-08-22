import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { TeamsController } from './teams.controller.js';
import { TeamsService } from './teams.service.js';

/**
 * Teams and membership — §6.2's "izinler kullanıcı veya gruba atanır" half that names the group.
 *
 * `AuthModule` supplies `SessionGuard`; `DbModule` and `PosixIdentityModule` are global, which is
 * why the POSIX allocator is reachable without importing anything (`PosixIdentityModule` says why
 * it is global: a second copy of "who is this on disk" is the kind of duplication that survives
 * long enough to disagree with itself).
 *
 * `TeamsService` is exported. The grant endpoints have to ask which teams a user belongs to before
 * they can resolve anything, and the alternative — each of them querying `team_members` directly —
 * is how "a user's principals" ends up meaning two different things in two files.
 *
 * `JobsModule` because deleting a team or a membership is a bulk permission change: the grants it
 * drops have to be re-applied to the filesystem, and ADR-0021 makes that a queued job rather than
 * a trigger. Without it these two operations changed Postgres and left SMB untouched.
 */
@Module({
  imports: [AuthModule, JobsModule],
  controllers: [TeamsController],
  providers: [TeamsService],
  exports: [TeamsService],
})
export class TeamsModule {}
