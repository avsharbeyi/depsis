import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { PasswordService } from '../auth/password.service.js';
import { MeController } from './me.controller.js';

@Module({
  imports: [AuthModule],
  controllers: [MeController],
  providers: [PasswordService],
})
export class MeModule {}
