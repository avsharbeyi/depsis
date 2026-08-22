import { Global, Module } from '@nestjs/common';

import { APP_CONFIG } from '../config.module.js';
import type { AppConfig } from '../config.js';
import { AgentDataService } from './agent-data.service.js';
import { AgentService } from './agent.service.js';

/**
 * Global for the same reason DbModule is: exactly one `AgentService` in the process, and therefore
 * exactly one queue in front of the agent. A second instance created by a module that "just needed
 * to run one operation" would be a second, unserialised path to a socket that accepts one
 * connection at a time — which is how the queue that exists to prevent ECONNREFUSED starts causing
 * it.
 */
@Global()
@Module({
  providers: [
    {
      provide: AgentService,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new AgentService(config.agentSocket),
    },
    {
      // Deliberately NOT behind the same queue. `AgentService` serialises every call because the
      // agent's control loop serves one connection at a time; the data socket is served from a
      // fixed worker pool, and putting uploads on the control queue would mean a ten-gigabyte
      // transfer blocking every `pool_status` behind it — the exact coupling the second socket
      // exists to break (ADR-0017).
      provide: AgentDataService,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new AgentDataService(config.agentDataSocket),
    },
  ],
  exports: [AgentService, AgentDataService],
})
export class AgentModule {}
