import { Global, Module } from '@nestjs/common';

import { APP_CONFIG } from '../config.module.js';
import type { AppConfig } from '../config.js';
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
  ],
  exports: [AgentService],
})
export class AgentModule {}
