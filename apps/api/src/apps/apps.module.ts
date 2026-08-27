import { Logger, Module } from '@nestjs/common';

import { AgentService } from '../agent/agent.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { loadSecretBox } from '../auth/secret-box.js';
import { APP_CONFIG } from '../config.module.js';
import { PODMAN_SOCKET_DEFAULT, type AppConfig } from '../config.js';
import { DbService } from '../db/db.service.js';
import { AppsController } from './apps.controller.js';
import { AppsService } from './apps.service.js';
import { PodmanClient } from './podman.client.js';

/**
 * The application catalogue (ADR-0019).
 *
 * `PodmanClient` is a provider rather than something `AppsService` constructs, for the reason every
 * external dependency in this codebase is: the service's tests need to be able to hand it a client
 * that answers without a container runtime, and a `new` inside the constructor would make that a
 * module-graph problem instead of an argument.
 *
 * Nothing here is exported. Podman is reached through these endpoints or not at all — a second
 * caller inside the process would be a second place ADR-0019's rules (catalogue only, 127.0.0.1
 * only, volumes never removed) would have to hold, and they would not.
 */
@Module({
  imports: [AuthModule],
  controllers: [AppsController],
  providers: [
    {
      provide: PodmanClient,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new PodmanClient(config.podmanSocket ?? PODMAN_SOCKET_DEFAULT),
    },
    {
      provide: AppsService,
      inject: [DbService, PodmanClient, APP_CONFIG, AgentService],
      // The share root comes from configuration and never from a request: it is the only thing
      // that turns a share id into a host path, and a request that could name it could name any
      // directory on the appliance.
      useFactory: (db: DbService, podman: PodmanClient, config: AppConfig, agent: AgentService) =>
        // `?? false` and not `?? true`: the permission to run containers as root has to be
        // written down somewhere, and an absent setting is not somewhere.
        new AppsService(
          db,
          podman,
          config.sharesRoot ?? null,
          config.podmanAllowRootful ?? false,
          // The same key TOTP secrets and SMB credentials are sealed with, used here to DERIVE
          // rather than to seal: a multi-container application needs its server and its database
          // to agree on a password, and deriving one is the only way to have it without storing
          // it. Null on a box with no key file, and installing something that needs one then
          // refuses with a sentence saying how to fix it.
          loadSecretBox(config.secretKeyFile ?? null, new Logger('AppsModule')),
          agent,
        ),
    },
  ],
})
export class AppsModule {}
