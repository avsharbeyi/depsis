import { Logger } from '@nestjs/common';
import {
  BACKUP_TICK_KIND,
  TICK_INTERVAL_MS,
  type BackupSchedulesService,
} from '@depsis/api/worker-surface';

import type { JobHandler } from '../worker.service.js';

export { BACKUP_TICK_KIND };

/**
 * Zamanlanmış yedeklerin turu: vakti gelmişleri bul ve koştur.
 *
 * ZİNCİRİN KENDİSİ: her tur bir sonrakini kuyruğa alıyor. `setInterval` DEĞİL — yalnız o süreç
 * ayaktayken çalışan ve yeniden başlatmada kaybolan bir zamanlayıcı, bir yedekleme sisteminin
 * sessizce durmasının yolu, ve durduğunu kimse fark etmiyor çünkü eksik olan şey bir yedeğin
 * YOKLUĞU — o da ancak ihtiyaç duyulduğu gün aranıyor.
 *
 * ARDIL ÖNCE, iş sonra. Ters sırada, tarama sırasında ölen bir worker zinciri koparırdı: iş
 * `failed` olur, hiçbir ardıl kuyrukta olmaz, ve bir daha hiç yedek alınmaz. Bu sırada en kötü
 * olan, bir turun atlanması — bir sonraki beş dakika sonra aynı vakti gelmişleri buluyor, çünkü
 * `next_run_at` geçmişte kalmaya devam ediyor.
 *
 * `tasks.overdue-sweep` ile aynı kalıp ve aynı gerekçe.
 */
export function backupTickHandler(schedules: BackupSchedulesService): JobHandler {
  const logger = new Logger('BackupTickHandler');

  return async ({ job, report }) => {
    const organizationId = job.organizationId;
    if (organizationId === null) {
      throw new Error('a storage.backup-tick job must belong to an organisation');
    }
    if (!(await report(0.1))) return;

    await schedules.scheduleTick(organizationId, new Date(Date.now() + TICK_INTERVAL_MS));

    const { ran, failed } = await schedules.runDue(organizationId, new Date());

    // BİR YEDEĞİN ALINMASI, GERİ YÜKLENEBİLMESİ DEMEK DEĞİL. `runDue` yalnız `zfs snapshot`'ın
    // hata vermediğini biliyor; bu, en yeni görüntünün havuzda durduğunu ve açılabildiğini
    // kontrol ediyor. Tur başına bir zamanlama, en eski doğrulanmış olandan başlayarak.
    const verified = await schedules.verifyOne(organizationId, new Date());
    // Sessiz bir tur normal ve çoğunluk: vakti gelmiş bir zamanlama yoksa yazacak bir şey yok. Her
    // beş dakikada bir "0 koştu" satırı, günlüğü okunmaz yapan şeyin ta kendisi.
    if (ran > 0 || failed > 0) {
      logger.log(`${ran} scheduled backup(s) ran, ${failed} failed, for job ${job.id}`);
    }
    if (verified !== null) {
      logger.log(`backup verification: ${verified}`);
    }

    await report(1);
  };
}
