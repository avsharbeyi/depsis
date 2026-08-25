import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { FilesModule } from '../files/files.module.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsModule } from './notifications.module.js';
import { TaskCommentsService } from './task-comments.service.js';
import { TaskFilesService } from './task-files.service.js';
import { TaskWatchersService } from './task-watchers.service.js';
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
 *
 * `FilesModule` §7'nin bir cümlesi yüzünden burada: "görev erişimi gizli dosya erişimi
 * vermemelidir". Bir görevin dosya bağı, dosyanın KENDİ izinlerini çözmek zorunda, ve o çözümü
 * yapan kod `FilesService`'te. Kopyalamak, iki farklı yetki yürüyüşü — yani zamanla iki farklı
 * cevap — demek olurdu.
 */
@Module({
  imports: [AuthModule, FilesModule, NotificationsModule],
  controllers: [NotesController, TasksController, NotificationsController],
  providers: [
    NotesService,
    TasksService,
    TaskFilesService,
    TaskCommentsService,
    TaskWatchersService,
  ],
})
export class DeskModule {}
