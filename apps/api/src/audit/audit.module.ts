import { Global, Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { AuditController } from './audit.controller.js';
import { AuditService } from './audit.service.js';

/**
 * Denetim kaydı.
 *
 * `@Global`, ve bu ayrıcalığın gerekçesi `DbModule`'unkiyle aynı türden: denetim, veritabanı gibi
 * her modülün işi. Kaydedilecek olaylar on ayrı modüle dağılmış durumda — kimlik doğrulama,
 * hesaplar, izinler, paylaşımlar, depolama, konsol, uzaktan erişim — ve her birine bir import
 * satırı eklemek, gelecek ay eklenen modülün o satırı unutması demek. Denetime ulaşmanın ucuz
 * olması, denetlemeyi olağanlaştıran şeydir.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
