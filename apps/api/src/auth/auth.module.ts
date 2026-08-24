import { Logger, Module } from '@nestjs/common';

import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../config.module.js';
import { DbService } from '../db/db.service.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { MfaService } from './mfa.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { PasswordService } from './password.service.js';
import { PendingLoginService } from './pending-login.service.js';
import { ReauthService } from './reauth.service.js';
import { loadSecretBox, type SecretBox } from './secret-box.js';
import { AdminGuard, SessionGuard } from './session.guard.js';
import { SessionService } from './session.service.js';

/** See `loadSecretBox` in `secret-box.ts`; the reading is shared with the SMB credential. */
function secretBoxFor(config: AppConfig): SecretBox | null {
  const logger = new Logger('SecretBox');
  return loadSecretBox(config.secretKeyFile ?? null, {
    log: (m) => logger.log(m),
    warn: (m) => logger.warn(m),
    error: (m) => logger.error(m),
  });
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
      useFactory: (db: DbService, config: AppConfig) => new MfaService(db, secretBoxFor(config)),
    },
    PendingLoginService,
    PasswordResetService,
    ReauthService,
    SessionGuard,
    AdminGuard,
  ],
  // SessionService and the guard are exported because every other feature module will need them;
  // AuthService is not, because the login flow has exactly one caller and widening that would make
  // it possible to authenticate from somewhere that skips the controller's origin check.
  // `AdminGuard` and `PasswordService` are exported for the same reason the other three are: a
  // module that needs to decide who may call it, or to hash a password, must use THESE instances.
  // A second `PasswordService` would be a second set of Argon2 parameters, and a locally-declared
  // guard is a guard nobody updates when the rule changes.
  // `PasswordResetService` is exported for the same reason: the two halves of a reset live in
  // `UsersModule` — the administrator's half needs the session store and the hasher, the user's
  // half needs to write a password — and putting them the other way round would make the two
  // modules import each other.
  // `ReauthService` is exported for the same reason `PasswordService` is, and after the same
  // mistake in a smaller form: two controllers had each written their own re-authentication, and
  // neither of the two went through the login throttle. A shared instance is the only version of
  // that check nobody can accidentally write a weaker copy of.
  exports: [
    SessionService,
    SessionGuard,
    AdminGuard,
    MfaService,
    PasswordService,
    PasswordResetService,
    ReauthService,
  ],
})
export class AuthModule {}
