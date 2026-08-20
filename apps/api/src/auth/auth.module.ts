import { Module } from '@nestjs/common';

import { OrganizationsModule } from '../organizations/organizations.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { MfaService } from './mfa.service.js';
import { PasswordService } from './password.service.js';
import { PendingLoginService } from './pending-login.service.js';
import { SessionGuard } from './session.guard.js';
import { SessionService } from './session.service.js';

@Module({
  imports: [OrganizationsModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    SessionService,
    LoginThrottleService,
    MfaService,
    PendingLoginService,
    SessionGuard,
  ],
  // SessionService and the guard are exported because every other feature module will need them;
  // AuthService is not, because the login flow has exactly one caller and widening that would make
  // it possible to authenticate from somewhere that skips the controller's origin check.
  exports: [SessionService, SessionGuard, MfaService],
})
export class AuthModule {}
