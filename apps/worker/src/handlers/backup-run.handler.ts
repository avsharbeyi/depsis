import { Logger } from '@nestjs/common';
import { type BackupRunService } from '@depsis/api/worker-surface';

import type { JobHandler } from '../worker.service.js';

export const BACKUP_RUN_KIND = 'storage.backup.run';
export const BACKUP_RUN_NOW_KIND = 'storage.backup.run.now';

/**
 * Altı saatlik yedekleme turu.
 *
 * ── ARDIL ÖNCE, İŞ SONRA ─────────────────────────────────────────────────────────────────────
 *
 * Ters sırada, tur sırasında ölen bir worker zinciri koparırdı: iş `failed` olur, hiçbir ardıl
 * kuyrukta olmaz, ve bir daha hiç yedek alınmaz. Bu sırada en kötü olan bir turun atlanması —
 * bir sonraki ritim geldiğinde aynı işi yapıyor.
 *
 * Duran bir yedekleme hiçbir alarm üretmez, çünkü eksik olan şey bir yedeğin YOKLUĞU, ve o ancak
 * ihtiyaç duyulduğu gün aranıyor. `tasks.overdue-sweep` ve `storage.backup-tick` ile aynı kalıp.
 *
 * ── TUR BİTMEDİYSE ARDIL HEMEN ───────────────────────────────────────────────────────────────
 *
 * Büyük bir değişiklik yığını tek turda bitmiyor: servis `devam` diyor ve buradaki ardıl ritmi
 * beklemeden kuyruğa giriyor. Altı saat beklemek, yarım kalmış bir yedeği altı saat yarım
 * bırakmak olurdu.
 */
export function backupRunHandler(runs: BackupRunService): JobHandler {
  const logger = new Logger('BackupRunHandler');

  return async ({ job, report }) => {
    const organizationId = job.organizationId;
    if (organizationId === null) {
      throw new Error('bir storage.backup.run işi bir kuruluşa ait olmalı');
    }
    if (!(await report(0.05))) return;

    const hours = await runs.cadenceHours(organizationId);
    await runs.scheduleNext(organizationId, new Date(Date.now() + hours * 3_600_000));

    const outcome = await runs.runOnce(organizationId, 'zamanli');

    if (outcome.state === 'devam') {
      // Yarım kalan tur ritmi beklemiyor.
      await runs.scheduleNext(organizationId, new Date());
    }
    if (outcome.copiedFiles > 0 || outcome.movedFiles > 0 || outcome.state !== 'bitti') {
      logger.log(
        `yedek turu (${outcome.state}): ${outcome.copiedFiles} dosya kopyalandı, ` +
          `${outcome.movedFiles} dosya silinenlere taşındı`,
      );
    }
    await report(1);
  };
}

/**
 * "Şimdi yedek al" — kullanıcının bastığı düğme.
 *
 * AYRI BİR İŞ TÜRÜ, ve ayrı olması bir tuzağı kapatıyor. Zincirin tekilliğini koruyan kısmi
 * indeks — aynı anda yalnız bir `storage.backup.run` kuyrukta olabilir — elle başlatılan turu da
 * engellerdi: zincir gereği her zaman tam olarak bir bekleyen satır var, yani düğme hiçbir zaman
 * iş kuyruğa koyamazdı.
 *
 * ARDIL KUYRUĞA ALMIYOR: zincir kendi ritmiyle dönmeye devam ediyor, ve elle bir tur onu ne
 * hızlandırıyor ne durduruyor.
 */
export function backupRunNowHandler(runs: BackupRunService): JobHandler {
  const logger = new Logger('BackupRunNowHandler');

  return async ({ job, report }) => {
    const organizationId = job.organizationId;
    if (organizationId === null) {
      throw new Error('bir storage.backup.run.now işi bir kuruluşa ait olmalı');
    }
    if (!(await report(0.05))) return;

    const outcome = await runs.runOnce(organizationId, 'elle');
    logger.log(
      `elle yedek turu (${outcome.state}): ${outcome.copiedFiles} dosya kopyalandı, ` +
        `${outcome.movedFiles} dosya silinenlere taşındı`,
    );
    await report(1);
  };
}
