import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module.js';
import { API_PREFIX, loadConfig } from './config.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  // Typed as the Express application so `set('trust proxy', …)` below is a call the compiler
  // checks rather than a cast. Nest's platform is Express here and has been from the start.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });

  // The prefix the contract declares in `servers`, not a preference. Without it the API serves
  // /setup/status while every generated client asks for /api/v1/setup/status, and the whole
  // surface 404s — which is exactly what happened until the end-to-end flow was actually run.
  // `contract.test.ts` now strips this prefix before comparing, so the two cannot drift apart.
  app.setGlobalPrefix(API_PREFIX);

  // Behind the TLS reverse proxy (deploy/nginx/depsis.conf.in), and it must be told so.
  //
  // `req.secure` is what decides whether the session cookie carries `Secure` and what
  // `requireSameOrigin` compares the browser's `Origin` against. Without this, an appliance served
  // over https answers 403 to every write — the browser says `https://box`, the API believes it is
  // `http://box`, and the two never agree. `loopback` by default, so the forwarded headers count
  // only when the connection came from 127.0.0.1: nginx can say it, the network cannot.
  const trustProxy = config.trustProxy ?? 'loopback';
  app.set('trust proxy', trustProxy === 'false' ? false : trustProxy);

  // Nest installs SIGTERM/SIGINT handlers only when asked, and without them a container stop kills
  // the process before the pool drains — leaving transactions to be rolled back by the server's
  // idle timeout instead of closing cleanly.
  app.enableShutdownHooks();

  // The interface, said out loud. In production this is loopback and the proxy is the only way
  // in; anything else is a deliberate choice somebody made, and the log is where they can see that
  // it took effect.
  const bind = config.bind ?? '127.0.0.1';
  await app.listen(config.port, bind);
  new Logger('bootstrap').log(
    `listening on ${bind}:${config.port} (${config.nodeEnv}, trust proxy: ${trustProxy})`,
  );
}

// A failure here must be loud and must not leave a half-started process behind. In particular the
// role gate in DbService throws from onModuleInit, and that has to end the process rather than
// produce an API that is up but reading every tenant's rows.
bootstrap().catch((error: unknown) => {
  new Logger('bootstrap').error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
