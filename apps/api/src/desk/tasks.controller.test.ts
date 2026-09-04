import { describe, expect, it } from 'vitest';

import type { AuthenticatedRequest } from '../auth/session.guard.js';
import type { TaskChecklistService } from './task-checklist.service.js';
import type { TaskCommentsService } from './task-comments.service.js';
import type { TaskFilesService } from './task-files.service.js';
import type { TaskTagsService } from './task-tags.service.js';
import type { TaskWatchersService } from './task-watchers.service.js';
import { TasksController } from './tasks.controller.js';
import type { ActivityRow, LogRow, TasksService } from './tasks.service.js';

/**
 * Denetim akışının akrandan SAKLADIĞI iki alan.
 *
 * Veritabanına inmiyor, ve inmesi gerekmiyor: ölçülen şey satırın nasıl doğduğu değil, kimin
 * gördüğü. `linkFile` denetime dosyanın TAM YOLUNU yazıyor ve bu doğru — altı ay sonra bir uuid
 * hiçbir şeye çözülmüyor — ama `TaskFilesService.list` aynı bağı, dosyayı göremeyen üyeden özenle
 * gizliyor. İki uç çelişiyordu: bağ listesi yolu saklarken, aynı işin etkinlik akışı ve panonun
 * tamamını döken `GET /tasks/log` onu her üyeye basıyordu.
 */

const ORG = '00000000-0000-4000-8000-000000000001';
const TASK = '00000000-0000-4000-8000-0000000000ff';
const AT = new Date('2026-01-01T10:00:00Z');

const ACTIVITY: ActivityRow[] = [
  {
    id: '00000000-0000-4000-8000-00000000000a',
    actor_username: 'muhasebeci',
    field: 'file_link',
    old_value: null,
    new_value: 'Finans/maaslar-2026.xlsx',
    created_at: AT,
  },
  {
    id: '00000000-0000-4000-8000-00000000000b',
    actor_username: 'muhasebeci',
    field: 'comment',
    old_value: 'silinen yorumun gövdesi',
    new_value: null,
    created_at: AT,
  },
  {
    id: '00000000-0000-4000-8000-00000000000c',
    actor_username: 'muhasebeci',
    field: 'status',
    old_value: 'assigned',
    new_value: 'in_progress',
    created_at: AT,
  },
];

const LOG: LogRow[] = ACTIVITY.map((row) => ({ ...row, task_id: TASK, task_body: 'Fatura' }));

function controller(): TasksController {
  const tasks = {
    activity: () => Promise.resolve(ACTIVITY),
    log: () => Promise.resolve(LOG),
  } as unknown as TasksService;
  return new TasksController(
    tasks,
    {} as unknown as TaskFilesService,
    {} as unknown as TaskCommentsService,
    {} as unknown as TaskWatchersService,
    {} as unknown as TaskChecklistService,
    {} as unknown as TaskTagsService,
  );
}

function signedIn(role: 'admin' | 'member'): AuthenticatedRequest {
  return {
    depsis: {
      organizationId: ORG,
      userId: '00000000-0000-4000-8000-000000000002',
      role,
    },
  } as unknown as AuthenticatedRequest;
}

describe('the task activity feed', () => {
  it('hides a linked file’s path from a peer, on the task feed and on the whole board log', async () => {
    const { items } = await controller().activity(signedIn('member'), TASK);
    const link = items.find((row) => row.field === 'file_link');
    expect(link?.newValue).toBeNull();
    expect(link?.oldValue).toBeNull();

    // Panonun tamamını döken uç aynı kuralı uyguluyor: dar olan kapı, geniş olanı açık bıraktığı
    // sürece kapı değil.
    const log = await controller().log(signedIn('member'));
    expect(log.items.find((row) => row.field === 'file_link')?.newValue).toBeNull();
  });

  it('still hides a deleted comment’s body from a peer, and leaves ordinary fields alone', async () => {
    const { items } = await controller().activity(signedIn('member'), TASK);
    expect(items.find((row) => row.field === 'comment')?.oldValue).toBeNull();
    const status = items.find((row) => row.field === 'status');
    expect(status?.oldValue).toBe('assigned');
    expect(status?.newValue).toBe('in_progress');
  });

  it('gives an administrator the whole record, which is what the record is for', async () => {
    const { items } = await controller().activity(signedIn('admin'), TASK);
    expect(items.find((row) => row.field === 'file_link')?.newValue).toBe(
      'Finans/maaslar-2026.xlsx',
    );
    expect(items.find((row) => row.field === 'comment')?.oldValue).toBe('silinen yorumun gövdesi');
  });
});
