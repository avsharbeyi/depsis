import { Module } from '@nestjs/common';

import { AgentModule } from '../agent/agent.module.js';
import { BackupRunService } from './backup-run.service.js';
import { BackupTargetService } from './backup-target.service.js';

/**
 * `BackupRunService` ve ihtiyaç duyduğu iki iş ortağı, HİÇBİR DENETLEYİCİ olmadan.
 *
 * `SystemModule` worker tarafından içeri alınamıyor: beş denetleyici bildiriyor ve `AuthModule`'ü
 * içeri alıyor, yani onu almak isteği olmayan bir süreçte oturum muhafızını ve bütün kimlik
 * doğrulama akışını ayağa kaldırırdı — `worker-surface.ts`'in bilerek dışarıda tuttuğu şey.
 * `BackupSchedulesModule` aynı sebeple var ve aynı cümleyi yazıyor.
 */
@Module({
  imports: [AgentModule],
  providers: [BackupTargetService, BackupRunService],
  exports: [BackupRunService],
})
export class BackupRunModule {}
