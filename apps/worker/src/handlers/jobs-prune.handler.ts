import { Logger } from '@nestjs/common';
// Servis bir DEĞER olarak alınıyor, yalnız tip olarak değil: saklama süreleri ve parti boyu onun
// üzerinde duruyor, ve buraya ikinci bir kopyasını yazmak yanlış olacak ikinci bir sayı demek.
import { JobsService } from '@depsis/api/worker-surface';

import type { JobHandler } from '../worker.service.js';

export const JOBS_PRUNE_KIND = JobsService.PRUNE_KIND;

/**
 * `job_history`'nin saklama süresi, uygulanmış hâli.
 *
 * `finish_job` biten HER işi oraya yazıyor ve hiçbir şey oradan silmiyordu. Aynı anda
 * `files.index-drain` zinciri kendini beş saniyede bir yeniden kuyruğa alıyor: kiracı başına günde
 * ~17.300 satır. Bir yıl açık kalan bir cihazda İşler ekranı ve olay akışı milyonlarca satırı
 * indekssiz taramaya başlıyor, disk sürekli büyüyor, ve hiçbir ekran bunu söylemiyor.
 *
 * KENDİNİ ZAMANLAYAN ZİNCİR, çöp budaması ve dizin turu gibi: `job_queue.run_after` bu ürünün
 * sahip olduğu tek kalıcı zamanlayıcı. Bir `setInterval` yalnız süreç ayaktayken koşar ve yeniden
 * başlatmadan sonra yok olur.
 *
 * ARDIL ÖNCE, İŞ SONRA — 0054'te sahada ödenen ders. Zincir yalnız BAŞARILI bir turdan sonra
 * devam ederse, birkaç saniyede tükenen üç deneme zinciri sonsuza kadar koparır; ve budamanın
 * kopması hiçbir belirti vermez, çünkü eksik olan şey bir SİLME.
 *
 * PARÇALI SİLİYOR. Sahadaki bir cihazda birikmiş milyonlarca satırı tek bir DELETE ile silmek
 * ADR-0003'ün uzun transaction yasağını çiğner ve İşler ekranının okuduğu tabloyu dakikalarca
 * kilitler. Tur bir tavana kadar parti siliyor; tavan dolduysa bir sonraki turu öne çekiyor.
 */
export function jobsPruneHandler(jobs: JobsService): JobHandler {
  const logger = new Logger('JobsPruneHandler');

  return async ({ job, report }) => {
    const organizationId = job.organizationId;
    if (organizationId === null) {
      throw new Error('a jobs.prune job must belong to an organisation');
    }

    await jobs.schedulePrune(organizationId, new Date(Date.now() + JobsService.PRUNE_INTERVAL_MS));

    let removed = 0;
    let more = false;
    for (let round = 0; round < JobsService.PRUNE_BATCHES_PER_ROUND; round += 1) {
      if (!(await report(round / JobsService.PRUNE_BATCHES_PER_ROUND))) {
        // Kirayı kaybettik: başka bir işçi bu işi devraldı ve aynı satırları siliyor olabilir.
        logger.warn('lost the lease part-way through a job history sweep; stopping');
        return;
      }
      const deleted = await jobs.pruneHistory(organizationId);
      removed += deleted;
      more = deleted >= JobsService.PRUNE_BATCH;
      if (!more) break;
    }

    if (removed > 0) {
      logger.log(`pruned ${removed} expired job history row(s)`);
    }
    if (more) {
      // Tavan doldu ve hâlâ silinecek satır var — birikmiş bir cihazın ilk turları böyle. Bir gün
      // beklemek yerine sıradaki tur hemen; `ON CONFLICT DO NOTHING` eklemeyi değil GÜNCELLEMEYİ
      // engellediği için ayrı bir yol gerekiyor.
      await jobs.hurryUpPrune(organizationId);
    }
    await report(1);
  };
}
