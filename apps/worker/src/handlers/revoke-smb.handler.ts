import { Logger } from '@nestjs/common';
import { REVOKE_SMB_KIND, type IdentitySyncService } from '@depsis/api/worker-surface';

import type { JobHandler } from '../worker.service.js';

export { REVOKE_SMB_KIND };

/**
 * Kapatılan bir hesabın SMB kimlik bilgisini düşürür.
 *
 * ── NEDEN BİR İŞ VAR ────────────────────────────────────────────────────────────────────────
 *
 * Asıl deneme isteğin İÇİNDE: bir hesabı kapatmanın sebebi çoğu zaman aciliyet, ve "birazdan
 * kesilecek" bir erişim kesilmemiş erişimdir. Bu iş yalnız o denemenin başarısız olduğu durumda
 * yazılıyor — ajan o an düşükse, ya da güncelleme sırasında yeniden başlıyorsa.
 *
 * Alternatifi ölçüldü ve kötüydü: kesme yalnız istekte denenseydi, ajana ulaşılamadığında istek
 * 503 dönerdi ve yönetici bir hesabı kapatamazdı. Kapatma, kutunun sağlığından bağımsız olarak
 * her zaman yapılabilmeli — kuyruk, kesmenin ER GEÇ olmasını garanti eden şey.
 *
 * ── İDEMPOTENT ─────────────────────────────────────────────────────────────────────────────
 *
 * At-least-once bir kuyruk bunu gerektiriyor (§17). Zaten düşürülmüş bir kimlik bilgisinde
 * `pdbedit -x` sıfırdan farklı dönüyor ve ajan onu başarı sayıyor: istenen şey hesabın SMB'ye
 * girememesi, ve giremiyor.
 *
 * ── HESAP GERİ AÇILMIŞSA ───────────────────────────────────────────────────────────────────
 *
 * İş, hesabın hâlâ kapalı olup olmadığını SORMUYOR, ve bu bilinçli. Geri açmak kimlik eşitlemesini
 * kuyruğa veriyor, o da mühürlü özeti yeniden içe aktarıyor — yani geç kalmış bir düşürme, geri
 * açmayı geçici olarak geri alsa bile bir sonraki eşitleme onu onarıyor. Buradan bir durum sorgusu
 * eklemek, iki iş arasındaki sırayı okuyan üçüncü bir varsayım yaratırdı.
 */
export function revokeSmbHandler(identity: IdentitySyncService): JobHandler {
  const logger = new Logger('RevokeSmbHandler');

  return async ({ job }) => {
    // Payload'dan, ve yalnız buradan: bu iş tek bir hesap hakkında ve hangisi olduğunu iş
    // satırından başka söyleyecek bir şey yok. Kiracı ise KUYRUK SATIRINDAN — payload'daki bir
    // kiracı alanı, işi yazan tarafın seçebildiği bir sınır olurdu.
    const username = (job.payload as { username?: unknown }).username;
    if (typeof username !== 'string' || username === '') {
      // Payload'sız bir satır yeniden denenerek düzelmez: hata değil, atlanacak bir kayıt.
      logger.warn(`job ${job.id}: no username in the payload; nothing to revoke`);
      return;
    }

    await identity.revokeSmbNow(username, `queued SMB revocation for '${username}'`);
    logger.log(`SMB credential revoked for '${username}'`);
  };
}
