import type { JobsService } from '@depsis/api/worker-surface';
import { describe, expect, it } from 'vitest';

import { WorkerService } from './worker.service.js';

/**
 * Döngünün kendisi, veritabanı olmadan.
 *
 * `worker.integration.test.ts` gerçek kuyrukla ölçüyor ve ölçmesi gereken şeylerin çoğu orada:
 * kiralama, yeniden deneme, kiranın elden alınması. Burada ölçülen tek şey, gerçek bir kuyruğun
 * ÜRETEMEDİĞİ hâl — her `finish` çağrısının düştüğü, yani sonucun hiç yazılamadığı bir tur.
 */
describe('the loop under a database that refuses every result', () => {
  it('waits between failed turns instead of spinning through the queue', async () => {
    // SIKI DÖNGÜ RİSKİ: `finish` düştüğünde iş `running` kalıyor ve döngü hemen bir sonrakini
    // talep ediyor. Bekleme olmazsa bu, saniyede yüzlerce turdur — kuyruktaki her satır sırayla
    // kiralanır, hiçbiri bitmez, ve işlemci veritabanı geri gelene kadar boşuna yanar.
    //
    // Ölçülen mekanizma: `execute` sonucun YAZILAMADIĞINI söylüyor, ve döngü o zaman boştaki
    // ritmini bekliyor. İşin kendisi kaybolmuyor — kirası dolunca yeniden alınabilir hâle geliyor.
    let claims = 0;
    const jobs = {
      workerId: 'test',
      claim: () => {
        claims += 1;
        return Promise.resolve({
          id: `j${claims}`,
          organizationId: 'org',
          kind: 'w.bad',
          payload: {},
          attempt: 1,
          maxAttempts: 1,
        });
      },
      heartbeat: () => Promise.resolve(true),
      finish: () => Promise.reject(new Error('duplicate key value violates unique constraint')),
    } as unknown as JobsService;

    const worker = new WorkerService(jobs, { leaseSeconds: 5, idleMs: 50 });
    worker.register('w.bad', () => Promise.reject(new Error('the handler said no')));

    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await worker.stop();

    // Döngü DURMUYOR — bir hata bütün kuyruğu bırakamaz, bu da döngünün sözleşmesi.
    expect(claims).toBeGreaterThan(0);
    // Ama 250 ms'de 50 ms'lik beklemelerle bir avuç tur dönüyor; beklemesiz hâli binlerceydi.
    expect(claims).toBeLessThan(20);
  });
});
