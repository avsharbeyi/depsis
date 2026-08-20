import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { API_PREFIX, loadConfig } from './config.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  // The prefix the contract declares in `servers`, not a preference. Without it the API serves
  // /setup/status while every generated client asks for /api/v1/setup/status, and the whole
  // surface 404s — which is exactly what happened until the end-to-end flow was actually run.
  // `contract.test.ts` now strips this prefix before comparing, so the two cannot drift apart.
  app.setGlobalPrefix(API_PREFIX);

  // Nest installs SIGTERM/SIGINT handlers only when asked, and without them a container stop kills
  // the process before the pool drains — leaving transactions to be rolled back by the server's
  // idle timeout instead of closing cleanly.
  app.enableShutdownHooks();

  await app.listen(config.port);
  new Logger('bootstrap').log(`listening on ${config.port} (${config.nodeEnv})`);
}

// A failure here must be loud and must not leave a half-started process behind. In particular the
// role gate in DbService throws from onModuleInit, and that has to end the process rather than
// produce an API that is up but reading every tenant's rows.
bootstrap().catch((error: unknown) => {
  new Logger('bootstrap').error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
