import { Module } from '@nestjs/common';

import { NotificationsService } from './notifications.service.js';

/**
 * Bildirimler, kendi modülünde.
 *
 * `DeskModule`'ün içinde DEĞİL, çünkü onu worker da kullanıyor ve masanın modülü `AuthModule` ile
 * `FilesModule`'ü — yani oturum kapısını ve HTTP katmanının yarısını — içeri alıyor. Bir arka plan
 * sürecinin kimliğini doğrulayacağı bir istek yok, ve `worker-surface.ts`'in tarif ettiği dar yüzey
 * tam olarak bunun için var.
 *
 * `DbModule` global; bu modülün başka bağımlılığı yok, ve olmaması da bilerek: bir bildirim yazmak
 * bildirdiği şeyi bilmek zorunda değil, yalnız bir cümle ve bir alıcı.
 */
@Module({
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
