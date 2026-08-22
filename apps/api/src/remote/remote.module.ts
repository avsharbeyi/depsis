import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { RemoteController } from './remote.controller.js';
import { RemoteService } from './remote.service.js';

/**
 * Remote access over ZeroTier (ADR-0020).
 *
 * An ordinary provider, unlike `SystemService` and `AppsService` next door: nothing about this
 * feature comes from deployment configuration. The local API's address is fixed at compile time
 * inside the agent — deliberately, because a configurable one would be a way to make the
 * privileged process issue requests to an arbitrary address — and the token is read by the agent
 * from a path it owns. There is nothing here for a setting to name.
 *
 * `AgentService` and `DbService` arrive from their global modules, so neither is imported.
 * `AuthModule` is, because the two guards must be THESE instances: a locally declared `AdminGuard`
 * is a guard nobody updates when the rule changes.
 *
 * Nothing is exported. ZeroTier is reached through these endpoints or not at all.
 *
 * The contract used to give `GET /remote` both a 503 and an `available` flag, which cannot both be
 * true — a caller cannot read a field on a body it will not receive. It was reported from here and
 * the document picked a side: the read ALWAYS answers 200, and a missing daemon arrives as
 * `available: false` with an empty `networks`. The mutating routes still answer 503, because there
 * a real piece of work genuinely cannot be done.
 */
@Module({
  imports: [AuthModule],
  controllers: [RemoteController],
  providers: [RemoteService],
})
export class RemoteModule {}
