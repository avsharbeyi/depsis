import { Logger } from '@nestjs/common';
import {
  OVERDUE_SWEEP_KIND,
  SWEEP_INTERVAL_MS,
  type NotificationsService,
} from '@depsis/api/worker-surface';

import type { JobHandler } from '../worker.service.js';

export { OVERDUE_SWEEP_KIND };

/**
 * Gecikmiş ve yaklaşan işleri bulup sahiplerine bildir (§7).
 *
 * ZİNCİRİN KENDİSİ: her koşu bir sonrakini kuyruğa alıyor. `setInterval` DEĞİL — yalnız o süreç
 * ayaktayken çalışan ve yeniden başlatmada kaybolan bir zamanlayıcı, bir hatırlatma sisteminin
 * sessizce durmasının yolu, ve durduğunu kimse fark etmiyor çünkü eksik olan şey bir bildirimin
 * YOKLUĞU.
 *
 * ARDIL ÖNCE, iş sonra. Ters sırada, tarama sırasında ölen bir worker zinciri koparırdı: iş
 * `failed` olur, hiçbir ardıl kuyrukta olmaz, ve hatırlatmalar bir daha hiç düşmez. Bu sırada en
 * kötü olan, bir taramanın atlanması — bir sonraki on beş dakika sonra aynı işleri buluyor, çünkü
 * gecikmiş bir iş gecikmiş kalıyor.
 *
 * `files.reconcile` ve `files.index-drain` ile aynı kalıp, ve aynı sebeple.
 */
export function overdueSweepHandler(notifications: NotificationsService): JobHandler {
  const logger = new Logger('OverdueSweepHandler');

  return async ({ job, report }) => {
    const organizationId = job.organizationId;
    if (organizationId === null) {
      throw new Error('a tasks.overdue-sweep job must belong to an organisation');
    }
    if (!(await report(0.1))) return;

    await notifications.scheduleSweep(organizationId, new Date(Date.now() + SWEEP_INTERVAL_MS));

    const { overdue, due } = await notifications.sweepOverdue(organizationId);
    // Sessiz bir tur normal ve çoğunluk: son tarihi olan ve yaklaşan iş yoksa yazacak bir şey yok.
    // O yüzden yalnız bir şey bulunduğunda log'a düşüyor — her on beş dakikada bir "0 bulundu"
    // satırı, günlüğü okunmaz yapan şeyin ta kendisi.
    if (overdue > 0 || due > 0) {
      logger.log(`${overdue} overdue and ${due} upcoming task(s) announced for job ${job.id}`);
    }

    await report(1);
  };
}
