import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  AclApplyModule,
  AclApplyService,
  AgentModule,
  AgentService,
  IdentitySyncService,
  ConfigModule,
  DbModule,
  JobsModule,
  JobsService,
  PosixIdentityModule,
  CopyModule,
  CopyService,
  TrashRetentionModule,
  TrashRetentionService,
  IndexerModule,
  IndexerService,
  OrganizationsModule,
  OrganizationsService,
} from '@depsis/api/worker-surface';

import { registerHandlers } from './handlers/registry.js';
import { SmbAuditReader } from './smb-audit.reader.js';
import { WorkerService } from './worker.service.js';

/**
 * The worker process.
 *
 * A Nest application with NO HTTP adapter: `createApplicationContext` gives dependency injection
 * and lifecycle hooks without opening a port. A background process that listens on nothing cannot
 * be reached by anything, which is one fewer surface to reason about — and its systemd unit says
 * the same thing with `RestrictAddressFamilies=AF_UNIX AF_INET` for PostgreSQL and the agent only.
 */
// `ConfigModule` FIRST and not optional: `DbModule`'s provider factory injects `APP_CONFIG`, so
// without it Nest cannot construct `DbService` and this process exits on boot with a dependency
// error. It was missing, which meant the worker did not run at all — and a queue whose consumer
// never starts looks exactly like a queue whose handler was never registered.
@Module({
  imports: [
    ConfigModule,
    DbModule,
    AgentModule,
    JobsModule,
    PosixIdentityModule,
    AclApplyModule,
    CopyModule,
    TrashRetentionModule,
    IndexerModule,
    OrganizationsModule,
  ],
})
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
  // Registration is not bookkeeping: `WorkerService.claim` only ever asks for the kinds registered
  // there, so a kind the API enqueues and the registry omits is a job nobody will ever run. It is
  // a separate module so a test can assert the list without booting this process.
  registerHandlers(worker, {
    agent: app.get(AgentService),
    acl: app.get(AclApplyService),
    jobs: app.get(JobsService),
    identity: app.get(IdentitySyncService),
    copies: app.get(CopyService),
    retention: app.get(TrashRetentionService),
    indexer: app.get(IndexerService),
  });
  // ADR-0011 Layer 1. Started after the handlers so an event that arrives immediately has a
  // consumer registered; the reader only writes to `index_queue`, so the ordering is a courtesy
  // rather than a correctness requirement.
  const audit = new SmbAuditReader(
    process.env['DEPSIS_SMB_AUDIT_LOG'] ?? '/var/log/depsis/smb-audit.log',
    app.get(IndexerService),
    app.get(OrganizationsService),
  );
  audit.start();

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
