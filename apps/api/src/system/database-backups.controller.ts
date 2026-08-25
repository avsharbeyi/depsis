import { randomUUID } from 'node:crypto';
import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';

import { AgentService, type AgentRequest } from '../agent/agent.service.js';
import { requireSameOrigin } from '../auth/origin.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { DUMP_KEEP } from './backup-schedules.service.js';
import { SystemService } from './system.service.js';

type Schemas = OpenApi.components['schemas'];

/**
 * Cihazın KENDİ verisi: hesaplar, paylaşımlar, izinler, dosya dizini.
 *
 * ZFS anlık görüntüleri kullanıcının DOSYALARINI koruyor. Korumadığı şey o dosyaların kime ait
 * olduğu — hepsi PostgreSQL'de, ve PostgreSQL sistem diskinde. Sistem diski ölürse havuzdaki her
 * bayt duruyor ve onlara kimin erişebileceğini söyleyen hiçbir şey kalmıyor: ne hesaplar, ne
 * paylaşım tanımları, ne klasör izinleri.
 *
 * `docs/operations/03-yedekleme.md` bunun için elle bir `pg_dump` tarif ediyordu, ve elle
 * başlatılan bir yedek alınmayan bir yedektir. Artık günde bir alınıyor; bu uçlar onu görünür
 * kılıyor ve elle de aldırabiliyor.
 *
 * DURUM DOSYA SİSTEMİNDE, veritabanında değil. "En son ne zaman" sorusunun cevabı dizindeki en
 * yeni dosyanın tarihi; bir kolonda tutulsaydı, kabuktan silinmiş bir dökümden sonra o kolon yalan
 * söylerdi — yedek listesinin havuzdan okunmasıyla aynı gerekçe.
 */
@Controller('storage/database-backups')
@UseGuards(SessionGuard)
export class DatabaseBackupsController {
  constructor(
    private readonly system: SystemService,
    private readonly agent: AgentService,
  ) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<Schemas['DatabaseBackupPage']> {
    await this.requireSystemAdmin(request);
    return this.ask({ op: 'list_database_dumps' }, 'listing the database dumps');
  }

  @Post()
  @HttpCode(201)
  async dump(@Req() request: AuthenticatedRequest): Promise<Schemas['DatabaseBackupPage']> {
    requireSameOrigin(request);
    await this.requireSystemAdmin(request);

    const now = new Date();
    // `SafeComponent`: no colon, no slash. The same shape scheduled snapshots use.
    const name = `depsis-${now
      .toISOString()
      .replace(/[-:]/gu, '')
      .replace(/\.\d+Z$/u, 'Z')}`;
    return this.ask(
      { op: 'dump_database', name, keep: DUMP_KEEP },
      'an on-demand dump of the appliance database',
    );
  }

  private async ask(request: AgentRequest, reason: string): Promise<Schemas['DatabaseBackupPage']> {
    const response = await this.agent.call(request, reason, randomUUID());
    if (response.status === 'refused' || response.status === 'failed') {
      // Almost always "the connection string is not configured", and that sentence is exactly
      // what the administrator needs — a generic 500 would send them looking at the database.
      throw new ServiceUnavailableException(response.reason);
    }
    if (response.status !== 'database_dumps') {
      throw new ServiceUnavailableException(
        `ajan bir döküm listesi yerine '${response.status}' cevabı verdi`,
      );
    }
    return {
      directory: response.directory,
      items: response.dumps.map((dump) => ({
        name: dump.name,
        sizeBytes: dump.size_bytes,
        createdAt: new Date(dump.created_unix * 1000).toISOString(),
      })),
    };
  }

  private async requireSystemAdmin(request: AuthenticatedRequest): Promise<void> {
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();
    if (!(await this.system.isSystemAdministrator(session.userId))) throw new ForbiddenException();
  }
}
