import { Logger, Module } from '@nestjs/common';

import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../config.module.js';
import { DbService } from '../db/db.service.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { MfaService } from './mfa.service.js';
import { PasswordService } from './password.service.js';
import { PendingLoginService } from './pending-login.service.js';
import { readKeyFile, SecretBox } from './secret-box.js';
import { SessionGuard } from './session.guard.js';
import { SessionService } from './session.service.js';

/**
 * Load the key that seals TOTP secrets, or say why there is none.
 *
 * A bad key path is a startup ERROR rather than a thrown exception, deliberately. Refusing to boot
 * would lock out every user — including the ones with no second factor, and including the recovery
 * codes that are the way back in when the key is the thing that broke. Enrolment refuses, sealed
 * secrets stop verifying, recovery codes keep working, and the log says so in one line.
 */
function loadSecretBox(config: AppConfig): SecretBox | null {
  const logger = new Logger('SecretBox');
  if (config.secretKeyFile === null) {
    logger.warn(
      'DEPSIS_SECRET_KEY_FILE is not set: TOTP secrets cannot be sealed, so enrolling a second ' +
        'factor will be refused. Generate one with `openssl rand -base64 32` (ADR-0016).',
    );
    return null;
  }
  try {
    const box = new SecretBox(readKeyFile(config.secretKeyFile));
    logger.log(`TOTP secrets are sealed with the key at ${config.secretKeyFile}`);
    return box;
  } catch (error) {
    logger.error(
      `${error instanceof Error ? error.message : String(error)}. ` +
        'Enrolment will be refused and existing sealed secrets will not verify; recovery codes ' +
        'still work.',
    );
    return null;
  }
}

@Module({
  imports: [OrganizationsModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    SessionService,
    LoginThrottleService,
    {
      provide: MfaService,
      inject: [DbService, APP_CONFIG],
      useFactory: (db: DbService, config: AppConfig) => new MfaService(db, loadSecretBox(config)),
    },
    PendingLoginService,
    SessionGuard,
  ],
  // SessionService and the guard are exported because every other feature module will need them;
  // AuthService is not, because the login flow has exactly one caller and widening that would make
  // it possible to authenticate from somewhere that skips the controller's origin check.
  exports: [SessionService, SessionGuard, MfaService],
})
export class AuthModule {}
