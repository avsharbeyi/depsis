import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
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
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
