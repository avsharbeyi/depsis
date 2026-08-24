import { Module } from '@nestjs/common';

import { DbModule } from '../db/db.module.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import { IdempotencyService } from './idempotency.service.js';

/**
 * The `Idempotency-Key` machinery, importable by the modules whose routes declare the header.
 *
 * Exported as a module rather than provided globally for the reason the interceptor's own comment
 * gives: replaying a stored response is only correct where the side effect was also prevented, and
 * that is a claim about a specific route rather than about POSTs in general.
 */
@Module({
  imports: [DbModule],
  providers: [IdempotencyService, IdempotencyInterceptor],
  exports: [IdempotencyService, IdempotencyInterceptor],
})
export class IdempotencyModule {}
