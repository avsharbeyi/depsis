import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { PasswordResetController } from './password-reset.controller.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

/**
 * Account administration.
 *
 * `AuthModule` supplies the two guards, the password hasher and the session store; `DbModule` is
 * global. Nothing here is exported to other modules on purpose — an account is changed through
 * these endpoints or not at all, so a second caller inside the process would be a second place the
 * last-administrator rule has to hold.
 */
@Module({
  imports: [AuthModule],
  // `PasswordResetController` serves `/auth/password-reset` from here rather than from
  // `AuthModule`: redeeming a ticket sets a password, and the one place that reseals the SMB
  // credential in the same transaction is `UsersService`.
  controllers: [UsersController, PasswordResetController],
  providers: [UsersService],
})
export class UsersModule {}
