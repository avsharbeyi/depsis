import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { NotesController } from './notes.controller.js';
import { NotesService } from './notes.service.js';
import { TasksController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';

/**
 * The things on the desk: the private notepad and the shared job board.
 *
 * One module rather than two because they are one decision, the same way migration 0012 is one
 * migration: DEPSIS keeps a small amount of per-tenant state that is not a file. They also differ
 * in the one way that matters — a note is its author's, a job is the organisation's — and keeping
 * that contrast in a single module is what stops the next person from copying the wrong half.
 *
 * `AuthModule` supplies `SessionGuard`, which both controllers sit behind; `DbModule` is global.
 * Nothing is exported: a note or a job is changed through these endpoints or not at all.
 */
@Module({
  imports: [AuthModule],
  controllers: [NotesController, TasksController],
  providers: [NotesService, TasksService],
})
export class DeskModule {}
