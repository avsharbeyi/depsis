import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { JobsController } from './jobs.controller.js';
import { JobsService } from './jobs.service.js';

/**
 * Exported, because the queue is infrastructure: uploads, file operations and administrative work
 * all enqueue through it (ADR-0003). The worker process, when it exists, uses the same service.
 */
@Module({
  imports: [AuthModule],
  controllers: [JobsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
