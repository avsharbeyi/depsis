import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { EventsController } from './events.controller.js';
import { EventsService } from './events.service.js';

/**
 * §14's event stream.
 *
 * Nothing is exported. The service holds a timer and a subscriber map — one instance per process
 * is the whole design, and a second caller inside the process would be a second poller.
 */
@Module({
  imports: [AuthModule],
  controllers: [EventsController],
  providers: [EventsService],
})
export class EventsModule {}
