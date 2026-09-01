import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { type RemoteService } from '@depsis/api/worker-surface';

import type { JobHandler } from '../worker.service.js';

export const REMOTE_AUTHORIZE_KIND = 'remote.authorize';

/**
 * Yeni katılan cihaz kaç saniye içinde çalışır hâle gelsin.
 *
 * Yirmi saniye, bir insanın telefonunda "katıl"a bastıktan sonra beklemeye razı olduğu süre.
 * Daha uzun olması, kullanıcının bir şeyin bozuk olduğunu düşünüp aynı işi tekrar yapmasına yol
 * açıyor; daha kısa olması, hiç kimse ağa katılmadığı saatlerde de aynı sıklıkta iş üretiyor ve
 * kazandırdığı şey ölçülmüyor.
 */
const INTERVAL_MS = 20_000;

/**
 * Ağa katılan cihazları kendiliğinden yetkilendirir.
 *
 * ── NEDEN BİR İŞ, NEDEN OKUMA YOLUNDA DEĞİL ──────────────────────────────────────────────────
 *
 * En kolay yer üye listesinin okunduğu an gibi görünüyor — ekran açıldığında yetkilendir. Ama o,
 * bir OKUMANIN yan etkisi olarak yetki vermek demek: listeyi açan herkes, yalnız baktığı için,
 * ağın üyeliğini değiştirmiş olur. Ve daha kötüsü, kimse o ekranı açmadıkça hiçbir cihaz
 * çalışmaz — yani sahibin kurtulmak istediği elle adım, gizlenmiş hâliyle geri gelir.
 *
 * ── ARDIL ÖNCE, İŞ SONRA ─────────────────────────────────────────────────────────────────────
 *
 * Zincirin diğer halkalarıyla aynı kalıp: bir tur ortasında ölen worker zinciri koparırsa
 * yetkilendirme sessizce durur, ve duran bir yetkilendirmenin belirtisi yalnız "yeni telefonum
 * bağlanmıyor" olur — kullanıcının nedenini asla bulamayacağı bir arıza.
 */
export function remoteAuthorizeHandler(remote: RemoteService): JobHandler {
  const logger = new Logger('RemoteAuthorizeHandler');

  return async ({ job, report }) => {
    const organizationId = job.organizationId;
    if (organizationId === null) {
      throw new Error('bir remote.authorize işi bir kuruluşa ait olmalı');
    }
    if (!(await report(0.05))) return;

    await remote.scheduleAuthorize(organizationId, new Date(Date.now() + INTERVAL_MS));

    try {
      const authorized = await remote.authorizeNewMembers(organizationId, randomUUID());
      // SESSİZ TUR OLAĞAN VE ÇOĞUNLUK: yirmi saniyede bir "0 cihaz" satırı, günlüğü okunmaz
      // yapan şeyin ta kendisi.
      if (authorized > 0) {
        logger.log(`${authorized} cihaz kendiliğinden yetkilendirildi`);
      }
    } catch (error) {
      // ZeroTier kurulu değilse ya da denetleyici cevap vermiyorsa bu bir arıza değil: uzak
      // erişimi hiç açmamış bir kutuda olağan hâl. İşi düşürmek, zinciri her yirmi saniyede bir
      // kırmızıya boyardı.
      logger.debug(
        `yetkilendirme turu atlandı: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await report(1);
  };
}
