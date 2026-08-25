import { Module } from '@nestjs/common';

import { PosixIdentityModule } from '../identity/posix.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { PasswordService } from '../auth/password.service.js';
import { SetupController } from './setup.controller.js';
import { SetupService } from './setup.service.js';

@Module({
  imports: [AuthModule, PosixIdentityModule],
  controllers: [SetupController],
  // PasswordService is provided here rather than exported from AuthModule: hashing is a pure
  // function of its input and a second instance costs one lazily-computed decoy hash. Exporting it
  // would widen AuthModule's surface for no benefit.
  providers: [SetupService, PasswordService],
  exports: [SetupService],
})
export class SetupModule {}
