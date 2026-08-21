import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  AgentModule,
  AgentService,
  DbModule,
  JobsModule,
  JobsService,
} from '@depsis/api/worker-surface';

import { snapshotHandler, SNAPSHOT_KIND } from './handlers/snapshot.handler.js';
import { WorkerService } from './worker.service.js';

/**
 * The worker process.
 *
 * A Nest application with NO HTTP adapter: `createApplicationContext` gives dependency injection
 * and lifecycle hooks without opening a port. A background process that listens on nothing cannot
 * be reached by anything, which is one fewer surface to reason about — and its systemd unit says
 * the same thing with `RestrictAddressFamilies=AF_UNIX AF_INET` for PostgreSQL and the agent only.
 */
@Module({ imports: [DbModule, AgentModule, JobsModule] })
class WorkerAppModule {}

async function bootstrap(): Promise<void> {
  const logger = new Logger('Worker');
  const app = await NestFactory.createApplicationContext(WorkerAppModule, {
    // So SIGTERM reaches onApplicationShutdown and the job in hand is finished rather than
    // abandoned to its lease.
    abortOnError: false,
  });
  app.enableShutdownHooks();

  const worker = new WorkerService(app.get(JobsService));
  worker.register(SNAPSHOT_KIND, snapshotHandler(app.get(AgentService)));
  worker.start();

  const shutdown = (signal: string): void => {
    logger.log(`${signal}: finishing the job in hand, then stopping`);
    void worker
      .stop()
      .then(() => app.close())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void bootstrap();
