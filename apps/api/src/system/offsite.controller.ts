import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Body,
  ConflictException,
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
import { z } from 'zod';

import { AgentService } from '../agent/agent.service.js';
import { requireSameOrigin } from '../auth/origin.js';
import { ReauthService } from '../auth/reauth.service.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { JobsService } from '../jobs/jobs.service.js';
import { BackupsService } from './backups.service.js';
import { SystemService } from './system.service.js';

type Schemas = OpenApi.components['schemas'];

/** İş kuyruğundaki tür. Üretici ve tüketici aynı sabiti okuyor. */
export const OFFSITE_KIND = 'storage.replicate-offsite';

const DATASET = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,254}$/;
const SNAPSHOT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,62}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const USER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

const destination = {
  host: z.string().regex(HOST, 'a destination host is required'),
  port: z.number().int().min(1).max(65535).default(22),
};

const scanSchema = z.object(destination);

const trustSchema = z.object({
  ...destination,
  line: z.string().min(3).max(2048),
});

const replicateSchema = z.object({
  ...destination,
  user: z.string().regex(USER, 'a destination account is required'),
  source: z.string().regex(DATASET, 'a dataset name is required'),
  snapshot: z.string().regex(SNAPSHOT, 'a snapshot name is required'),
  target: z.string().regex(DATASET, 'a target dataset name is required'),
  base: z.string().regex(SNAPSHOT).nullable().optional(),
  confirm: z.string(),
  password: z.string().min(1).max(1024),
});

/**
 * Başka bir makineye yedekleme — yangının, hırsızlığın ve fidye yazılımının hesaba katıldığı yer.
 *
 * `POST /storage/replication` ikinci bir HAVUZA kopyalıyor, ve o bir diskin ölmesini atlatıyor.
 * Atlatmadığı şey kutunun çalınması, evin yanması, ya da fidye yazılımının bağlı her veri kümesine
 * ulaşması — ki insanlar "yedek" derken çoğunlukla bunu kastediyor.
 *
 * ÖZEL ANAHTAR BURADAN OKUNAMIYOR, ve bu bir uç noktanın eksikliği değil bir karar. Anahtar
 * ayrıcalıklı tarafta üretiliyor ve orada kalıyor; bu denetleyicinin öğrenebildiği tek şey AÇIK
 * yarısı — kullanıcının karşı tarafın `authorized_keys` dosyasına yapıştıracağı şey. ADR-0016
 * cihazı, veritabanına erişimin tek başına yetmeyeceği şekilde bölüyor; bir HTTP ucundan okunabilen
 * özel anahtar, o bölmeyi başka bir makineye ulaşan tek kimlik bilgisi için ortadan kaldırırdı.
 *
 * İLK KULLANIMDA GÜVEN YOK. `POST /storage/offsite/scan` karşı tarafın anahtarını SORUYOR ve
 * hiçbir şeye güvenmiyor; `POST /storage/offsite/trust` kullanıcının GÖRDÜĞÜ ve parmak izini
 * karşılaştırdığı satırı yazıyor. İkisini tek bir uçta birleştirmek — "bağlan ve ne çıkarsa kabul
 * et" — bir replikasyonda saldırganın bu cihazdaki her dosyanın kopyasını alması demek.
 *
 * ÇOĞALTMANIN KENDİSİ §8.1'in dizisini izliyor, yereldeki kardeşiyle birebir: analiz, plan, yazılı
 * onay, yeniden kimlik doğrulama, iş. Karşı taraf `zfs recv -F` çalıştırıyor — yani yok edilen şey
 * ORADA, ve onay metni de o yüzden `kullanıcı@makine:veri-kümesi`: aynı ada sahip yerel bir veri
 * kümesi olabilir, ve onaylanan şeyin hangisi olduğu tartışmaya açık kalmamalı.
 */
@Controller('storage/offsite')
@UseGuards(SessionGuard)
export class OffsiteController {
  constructor(
    private readonly system: SystemService,
    private readonly agent: AgentService,
    private readonly jobs: JobsService,
    private readonly reauth: ReauthService,
    private readonly backups: BackupsService,
  ) {}

  @Get()
  async status(@Req() request: AuthenticatedRequest): Promise<Schemas['OffsiteStatus']> {
    await this.requireSystemAdmin(request);

    const response = await this.agent.call(
      { op: 'offsite_status' },
      'reading the off-site identity',
      randomUUID(),
    );
    if (response.status !== 'offsite') {
      throw new ServiceUnavailableException(
        `ajan bir durum yerine '${response.status}' cevabı verdi`,
      );
    }
    return {
      hasIdentity: response.has_identity,
      publicKey: response.public_key ?? null,
      fingerprint: response.fingerprint ?? null,
      trusted: response.trusted,
    };
  }

  @Post('identity')
  @HttpCode(201)
  async createIdentity(@Req() request: AuthenticatedRequest): Promise<Schemas['OffsiteStatus']> {
    requireSameOrigin(request);
    await this.requireSystemAdmin(request);

    const response = await this.agent.call(
      { op: 'offsite_create_identity' },
      'generating the off-site identity',
      randomUUID(),
    );
    // 409 ve 500 değil: anahtar zaten var, ve bu bir arıza değil bir durum. Üzerine yazmak asla
    // doğru cevap değil — karşı tarafın `authorized_keys` dosyası ESKİ anahtarın açık yarısını
    // tutuyor, yani sessiz bir yenileme her gelecekteki çoğaltmayı saatler sonra, karşı tarafta,
    // sebebi burada hiç görünmeyen bir izin hatasına çevirirdi.
    if (response.status === 'refused') throw new ConflictException(response.reason);
    if (response.status !== 'offsite') {
      throw new ServiceUnavailableException(
        `ajan bir durum yerine '${response.status}' cevabı verdi`,
      );
    }
    return {
      hasIdentity: response.has_identity,
      publicKey: response.public_key ?? null,
      fingerprint: response.fingerprint ?? null,
      trusted: response.trusted,
    };
  }

  @Post('scan')
  @HttpCode(200)
  async scan(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['OffsiteHostKeyPage']> {
    requireSameOrigin(request);
    await this.requireSystemAdmin(request);

    const parsed = scanSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid request');
    }
    const { host, port } = parsed.data;

    const response = await this.agent.call(
      { op: 'offsite_scan_host', host, port },
      `scanning the host key of ${host}:${String(port)}`,
      randomUUID(),
    );
    // Ulaşılamayan bir makine bu cihazın arızası DEĞİL: kapalı, güvenlik duvarının arkasında, ya da
    // SSH çalışmıyor. 503 ve sebep, çünkü kullanıcının yapacağı şey karşı tarafa bakmak.
    if (response.status === 'refused') throw new ServiceUnavailableException(response.reason);
    if (response.status !== 'offsite_host_keys') {
      throw new ServiceUnavailableException(
        `ajan bir anahtar listesi yerine '${response.status}' cevabı verdi`,
      );
    }
    return {
      items: response.keys.map((key) => ({
        kind: key.kind,
        line: key.line,
        fingerprint: key.fingerprint,
      })),
    };
  }

  @Post('trust')
  @HttpCode(200)
  async trust(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['OffsiteStatus']> {
    requireSameOrigin(request);
    await this.requireSystemAdmin(request);

    const parsed = trustSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid request');
    }
    const { host, port, line } = parsed.data;

    const response = await this.agent.call(
      { op: 'offsite_trust_host', host, port, line },
      `trusting the host key of ${host}:${String(port)}`,
      randomUUID(),
    );
    // Satır bu makine ve bu port için değilse ajan reddediyor. 422, çünkü gövde ayrıştı ve her
    // alan doğru türde; yanlış olan şey satırın BAŞKA bir makineyi adlandırması — parmak izini
    // kontrol etme ayininin engellemek için var olduğu tam olarak o değiştirme.
    if (response.status === 'refused') throw new BadRequestException(response.reason);
    if (response.status !== 'offsite') {
      throw new ServiceUnavailableException(
        `ajan bir durum yerine '${response.status}' cevabı verdi`,
      );
    }
    return {
      hasIdentity: response.has_identity,
      publicKey: response.public_key ?? null,
      fingerprint: response.fingerprint ?? null,
      trusted: response.trusted,
    };
  }

  @Post('replicate')
  @HttpCode(202)
  async replicate(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['JobAccepted']> {
    requireSameOrigin(request);
    const session = await this.requireSystemAdmin(request);

    const parsed = replicateSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid request');
    }
    const plan = parsed.data;
    const named = `${plan.user}@${plan.host}:${plan.target}`;

    // Paroladan ÖNCE: onayı yanlış yazan biri, bunu öğrenmek için parolasını vermek zorunda
    // kalmasın. Yereldeki kardeşiyle aynı sıra ve aynı gerekçe.
    if (plan.confirm !== named) {
      throw new BadRequestException(
        `onaylamak için hedefin tam adını yazın: '${named}'. Bu işlem KARŞI TARAFTAKİ veriyi yok eder`,
      );
    }

    await this.reauth.require(session.organizationId, session.userId, plan.password, request);

    // KAYNAK ANLIK GÖRÜNTÜSÜ GERÇEKTEN VAR MI. Nazik yarı; ajan zaten reddediyor. Ama burada
    // sorulduğunda cevap operatörün ekranı hâlâ açıkken geliyor.
    const onSource = await this.backups.inventory(
      [plan.source],
      `POST /storage/offsite/replicate: checking ${plan.source}@${plan.snapshot}`,
    );
    if (onSource !== null && !onSource.some((s) => s.name === plan.snapshot)) {
      throw new ConflictException(
        `'${plan.source}' üzerinde '${plan.snapshot}' adında bir anlık görüntü yok`,
      );
    }

    const jobId = await this.jobs.enqueue(
      session.organizationId,
      OFFSITE_KIND,
      {
        source: plan.source,
        snapshot: plan.snapshot,
        base: plan.base ?? null,
        host: plan.host,
        port: plan.port,
        user: plan.user,
        target: plan.target,
        requestedBy: session.userId,
      },
      // TEK deneme, yereldeki kardeşiyle aynı gerekçeyle: `zfs recv -F` yeniden çalıştırılabilir
      // GÖRÜNÜYOR, ama belirsiz bir hatadan sonraki yeniden deneme, karşı tarafta ne olduğunu
      // bilmeden orayı bir daha yok etmek demek. Ağ üzerinden bu daha da geçerli — bir kopan
      // bağlantı, tam olarak "ne kadarı gitti" sorusunu cevapsız bırakan hata.
      { maxAttempts: 1 },
    );
    return { jobId };
  }

  /**
   * Kurucu yönetici, `system/` boyunca olduğu gibi.
   *
   * Bu rotayı istisna yapmak, "riskli işlemde geniş kapı" sorusunu kazara cevaplamak olurdu — ve
   * burada risk, cihazdaki her dosyanın bir kopyasının başka bir makineye gitmesi.
   */
  private async requireSystemAdmin(
    request: AuthenticatedRequest,
  ): Promise<{ organizationId: string; userId: string }> {
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();
    if (!(await this.system.isSystemAdministrator(session.userId))) throw new ForbiddenException();
    return { organizationId: session.organizationId, userId: session.userId };
  }
}
