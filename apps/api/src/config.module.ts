import { Global, Module } from '@nestjs/common';

import { loadConfig, type AppConfig } from './config.js';

/**
 * The environment, read once, as an injectable value.
 *
 * Each feature module used to call `loadConfig()` inside its own factory. That works in production
 * and is a slow leak in tests: a factory runs when the module is compiled, so any test booting
 * AppModule had to override every service whose factory touched the environment — even one it had
 * no interest in, purely to stop `loadConfig()` throwing over a database URL the test does not use.
 * The list grew with each module, and a growing list of unrelated stubs is how a drift test stops
 * being worth adding modules to.
 *
 * With the config behind a token there is one thing to override, and it is the thing the test
 * actually wants to change.
 */
export const APP_CONFIG = Symbol('APP_CONFIG');

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig() }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
