import { describe, expect, it } from 'vitest';

import type {
  AclApplyService,
  AgentService,
  BackupSchedulesService,
  CopyService,
  IdentitySyncService,
  IndexerService,
  JobsService,
  NotificationsService,
  TrashRetentionService,
} from '@depsis/api/worker-surface';

import { registerHandlers } from './registry.js';
import { WorkerService } from '../worker.service.js';

/**
 * The kinds this worker will actually claim.
 *
 * A list rather than a behaviour, and it earns its place because of how the gap showed up:
 * `PermissionsService` had been enqueuing `permissions.apply` since §6.2's endpoints were served,
 * every one of those rows was unclaimable because no handler was registered, and nothing failed.
 * The API's own test asserted a row landed on the queue; nothing asserted anybody would ever take
 * it off. Adding an enqueue without adding the consumer has to break something, and this is it.
 */
describe('the worker consumes every kind the API enqueues', () => {
  it('registers a handler for each one', () => {
    const worker = new WorkerService({ workerId: 'test' } as unknown as JobsService);
    registerHandlers(worker, {
      agent: {} as unknown as AgentService,
      acl: {} as unknown as AclApplyService,
      jobs: {} as unknown as JobsService,
      identity: {} as unknown as IdentitySyncService,
      copies: {} as unknown as CopyService,
      retention: {} as unknown as TrashRetentionService,
      indexer: {} as unknown as IndexerService,
      notifications: {} as unknown as NotificationsService,
      backupRuns: {} as never,
      schedules: {} as unknown as BackupSchedulesService,
      remote: {} as never,
    });
    expect(worker.kinds.sort()).toEqual([
      'files.copy',
      'files.index-drain',
      'files.reconcile',
      'files.restore-snapshot',
      'files.trash.purge',
      'identity.sync',
      'permissions.apply',
      // Aga katilan cihazlarin kendiliginden yetkilendirilmesi. Yirmi saniyede bir zincirleniyor;
      // bir okumanin yan etkisi olarak yetki vermek, uye listesini acan herkesin agin uyeligini
      // degistirmesi demek olurdu.
      'remote.authorize',
      'storage.backup-tick',
      // Yedek diski turu ve elle baslatilan tur. IKI AYRI TUR, ve ayri olmalari zorunlu:
      // zincirin tekilligini koruyan kismi indeks — ayni anda yalniz bir zamanlanmis tur
      // kuyrukta olabilir — tek tur olsaydi kullanicinin "Simdi yedek al" dugmesini de
      // engellerdi, ve dugme hicbir zaman is kuyruga koyamazdi.
      'storage.backup.purge',
      'storage.backup.run',
      'storage.backup.run.now',
      // Gunluk dogrulama. Tur kac dosya kopyaladigini SAYIYOR ama diskteki baytlara bakmiyor;
      // bu is gercekten bir dosya okuyup asliyla karsilastiriyor. Ayri bir tur olmasinin sebebi
      // ritmi: yedek alti saatte bir, dogrulama gunde bir -- daha siki olmasi ayni dosyayi ayni
      // sonucla tekrar okumak olurdu.
      'storage.backup.verify',
      'storage.pool.create',
      'storage.replicate',
      'storage.replicate-offsite',
      'storage.snapshot',
      'tasks.overdue-sweep',
    ]);
  });
});
