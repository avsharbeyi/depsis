import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { z } from 'zod';

import { AgentService, AgentUnavailableError } from '../agent/agent.service.js';
import { AuditService } from '../audit/audit.service.js';
import { requireSameOrigin } from '../auth/origin.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { SystemService } from './system.service.js';

type Schemas = OpenApi.components['schemas'];

const bodySchema = z.object({
  pool: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,62}$/u, 'havuz adı bir harfle başlamalı'),
});

/**
 * `POST /storage/share-tree` — var olan bir havuzun üstünde paylaşım ağacını kurar.
 *
 * NEDEN AYRI BİR UÇ. Havuz sihirbazı bu işi zaten yapıyor (`prepareShareRoot`), ama yalnızca havuzu
 * O kurduğunda. Havuzu başka bir yoldan gelmiş bir kutu — daha eski bir DEPSIS, elle kurulmuş bir
 * havuz, ya da sihirbazın ikinci yarısının düştüğü bir kurulum — havuza sahip ama paylaşım
 * açamayan bir cihaz oluyordu, ve arayüzün oradaki tavsiyesi bir KABUK KOMUTUYDU:
 * `zfs create -o mountpoint=… `.
 *
 * Bu, ürünün kabul ölçütüne aykırıydı. Cihazın sahibi olağan hiçbir iş için terminale girmemeli, ve
 * "depolamanın yapılandırılması uçtan uca sihirbazda bitmeli" — havuz kurulduktan sonra elle
 * yapılandırma yaptırmak, özelliğin eksik olması demek.
 *
 * YIKICI DEĞİL, o yüzden §8.1'in töreni yok: `prepare_share_root` bir veri kümesi OLUŞTURUR. Ajan
 * üstünde bir şey varken reddediyor — kökte bağlı bir veri kümesi ya da boş olmayan bir dizin —
 * yani var olan bir şeyin üstüne yazma yolu bu uçta hiç yok. Parola sorulmamasının sebebi bu;
 * kurucu yönetici kapısı ise duruyor.
 */
@Controller('storage/share-tree')
@UseGuards(SessionGuard)
export class ShareTreeController {
  constructor(
    private readonly system: SystemService,
    private readonly agent: AgentService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @HttpCode(200)
  async prepare(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['ShareTreeResult']> {
    requireSameOrigin(request);
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();
    if (!(await this.system.isSystemAdministrator(session.userId))) throw new ForbiddenException();

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'havuz adı gerekli');
    }

    const correlationId = randomUUID();

    // ZATEN VARSA 409. Ajan da reddederdi, ama onun cümlesi "kökte bir veri kümesi bağlı" — doğru
    // ve teknik. Operatörün burada duyması gereken şey, istediği durumun ZATEN sağlandığı.
    const setup = await this.system.storageSetup(correlationId);
    if (setup.parentDataset !== undefined) {
      throw new ConflictException(
        `paylaşım ağacı zaten kurulu: ${setup.parentDataset}. Yeni paylaşımlar onun altında açılıyor.`,
      );
    }
    // Kutuda olmayan bir havuz adı: ajanın "no such pool"undan önce, anlaşılır biçimde.
    if (!setup.pools.includes(parsed.data.pool)) {
      throw new BadRequestException(`bu kutuda '${parsed.data.pool}' adlı bir havuz yok`);
    }

    // `dataset` NULL DA OLABILIR: ajanin yanit birlesiminde ayni ad, bazi varyantlarda
    // null tasiyor. Dar bir tip burada derlemeyi gecerdi ama yanlis varyanti sessizce kabul
    // ederdi — asagidaki kontrol de tam bu yuzden `undefined` degil `== null` bakiyor.
    let response: { status: string; reason?: string | null; dataset?: string | null };
    try {
      response = await this.agent.call(
        { op: 'prepare_share_root', pool: parsed.data.pool },
        `preparing the share tree on '${parsed.data.pool}'`,
        correlationId,
      );
    } catch (error) {
      if (error instanceof AgentUnavailableError) {
        throw new ServiceUnavailableException('depolama ajanına ulaşılamıyor');
      }
      throw error;
    }

    if (response.status === 'refused') {
      // Ajanın cümlesi aynen: "kök boş değil", "zaten bir veri kümesi bağlı" — ikisi de operatörün
      // üzerine gidebileceği olgular.
      throw new BadRequestException(response.reason ?? 'paylaşım ağacı kurulamadı');
    }
    if (response.status !== 'share_root_prepared' || response.dataset == null) {
      throw new ServiceUnavailableException('paylaşım ağacı kurulamadı: beklenmeyen ajan yanıtı');
    }

    await this.audit.record(session.organizationId, {
      actorId: session.userId,
      action: 'storage.share-tree-prepared',
      target: { kind: 'pool', id: parsed.data.pool, label: parsed.data.pool },
      summary: `'${parsed.data.pool}' havuzunda paylaşım ağacı kuruldu: ${response.dataset}.`,
      correlationId,
    });

    return { dataset: response.dataset };
  }
}
