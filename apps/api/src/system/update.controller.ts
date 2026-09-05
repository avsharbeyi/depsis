import { randomUUID } from 'node:crypto';
import { statfs } from 'node:fs/promises';

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { z } from 'zod';

import { AgentService, AgentUnavailableError, type AgentRequest } from '../agent/agent.service.js';
import { AuditService } from '../audit/audit.service.js';
import { requireSameOrigin } from '../auth/origin.js';
import { ReauthService } from '../auth/reauth.service.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { SystemService, type Telemetry } from './system.service.js';

type Schemas = OpenApi.components['schemas'];

const applySchema = z.object({ password: z.string().min(1).max(1024) });

/**
 * Güncellemenin derlendiği ağaç. `tools/install/update.sh` içindeki `SRC_TREE` ile aynı yol.
 *
 * Boş alan ORADAN ölçülüyor, `/`den değil: bir kutuda ikisi ayrı dosya sistemi olabilir, ve
 * derlemenin dolduracağı disk bu.
 */
const UPDATE_TREE = '/opt/depsis';

/**
 * Kaynaktan derleme için sistem diskinde bulunması gereken en az boş alan.
 *
 * `pnpm install` ile `cargo build --release` birlikte gigabaytlarca yer istiyor, ve GERİ ALMA
 * YOLU DA YER İSTİYOR: `update.sh` eski ağacı saklayıp geri koyuyor. Dolu bir diskte yarıda
 * düşen bir güncelleme, geri de dönemeyen bir güncellemedir.
 */
const MIN_FREE_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Havuzun BİLİNEN-KÖTÜ hâlleri.
 *
 * `UNKNOWN` burada YOK ve bu bilinçli: sağlığı okunamayan bir havuz yüzünden güncellemeyi
 * kapatmak, bir telemetri boşluğunu onarılamayan bir kutuya çevirirdi. Engellenen şey, kutunun
 * gerçekten söylediği arıza.
 */
const UNHEALTHY = new Set(['DEGRADED', 'FAULTED', 'OFFLINE', 'REMOVED', 'UNAVAIL', 'SUSPENDED']);

/** Bayt → GB, tek ondalık. Kullanıcıya gösterilen sayı bayt olamaz. */
function gigabytes(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(1);
}

/** Ajanın `update` yanıtı — alan adları ajanın yazdığı gibi, dönüştürme aşağıda tek yerde. */
interface AgentUpdate {
  status: string;
  reason?: string;
  installed?: string | null;
  available?: { commit: string; subject?: string | null; committed_at?: string | null } | null;
  phase?: string;
  in_progress?: boolean;
  up_to_date?: boolean;
  checked_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  error?: string | null;
  log_tail?: string[];
  signed?: boolean;
}

/**
 * `/system/update` — cihazın kendini güncellemesi.
 *
 * Cihaz sahibinin ilkesinden doğdu, disk temizleme gibi: depoda düzelen bir şey sahadaki kutuya
 * ancak ISO yeniden üretilip yeniden kurularak ya da kutuda bir kabuk açılarak gidiyordu. Bir
 * güvenlik düzeltmesinin kullanıcıya ulaşamaması, düzeltmenin kendisinden büyük bir kusurdur.
 *
 * BU KATMAN İNDİRME YAPMAZ. Ajan da yapmaz — birimi `IPAddressDeny=any` taşır. İndiren ve kuran
 * taraf ayrı bir systemd birimidir; buradan ajana giden şey yalnızca "o birimi başlat"tır.
 *
 * KURULACAK SÜRÜMÜ BU İSTEK SEÇMEZ. Uygulama isteğinin gövdesinde parola dışında hiçbir alan yok:
 * kurulacak şey son DENETİMİN bulduğu sürümdür. Ekranda gördüğü sürümü onaylayan yönetici tam onu
 * kurmuş olur — havuz sihirbazının WWN yeniden doğrulamasıyla aynı kalıp.
 */
@Controller('system/update')
@UseGuards(SessionGuard)
export class UpdateController {
  private readonly logger = new Logger(UpdateController.name);

  constructor(
    private readonly system: SystemService,
    private readonly agent: AgentService,
    private readonly reauth: ReauthService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async status(@Req() request: AuthenticatedRequest): Promise<Schemas['UpdateStatus']> {
    await this.requireAdministrator(request, false);
    const correlationId = randomUUID();
    return this.present(
      await this.callAgent({ op: 'update_status' }, 'reading update status', correlationId),
    );
  }

  @Post('check')
  @HttpCode(200)
  async check(@Req() request: AuthenticatedRequest): Promise<Schemas['UpdateStatus']> {
    const session = await this.requireAdministrator(request, true);
    const correlationId = randomUUID();
    const response = await this.callAgent(
      { op: 'check_update' },
      'checking for a new version',
      correlationId,
    );
    // Denetim ağa çıkıyor, yani kutunun dışına bir bağlantı. Bunu denetim kaydına yazmak, "bu
    // cihaz kendiliğinden dışarıya bağlanıyor mu" sorusunun cevabını bırakır: hayır, ve her
    // bağlantının kim tarafından başlatıldığı burada durur.
    await this.audit.record(session.organizationId, {
      actorId: session.userId,
      action: 'system.update-checked',
      target: { kind: 'system', id: 'update' },
      summary: 'Yeni sürüm var mı diye bakıldı.',
      correlationId,
    });
    return this.present(response);
  }

  @Post('apply')
  @HttpCode(200)
  async apply(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['UpdateStatus']> {
    const session = await this.requireAdministrator(request, true);
    const parsed = applySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('parola gerekli');

    // İSTEK BAŞINA TEK KİMLİK, ve ön kontrolün ajana sorduğu havuz sağlığı da bu kimliği taşıyor:
    // ajanın denetim izi, güncellemeyi başlatan isteğe geri okunabilsin (§16).
    const correlationId = randomUUID();

    // ── ÖN KONTROL, PAROLADAN ÖNCE (§12) ────────────────────────────────────────────────────
    //
    // Havuz sihirbazındaki kalıbın aynısı: güncellemenin ZATEN başlayamayacağını öğrenecek olan
    // kişi, bunu öğrenmek için parolasını vermek zorunda kalmasın. Kontrol edilen iki şey de
    // güncellemeyi YARIDA bırakan türden — ve yarıda kalan bir güncelleme, geri alma yolu da
    // aynı diski kullandığı için kendini geri de alamıyor.
    await this.precheck(session.organizationId, correlationId);

    await this.reauth.require(
      session.organizationId,
      session.userId,
      parsed.data.password,
      request,
    );

    const response = await this.callAgent(
      { op: 'apply_update' },
      'applying the update',
      correlationId,
    );

    await this.audit.record(session.organizationId, {
      actorId: session.userId,
      action: 'system.update-applied',
      target: { kind: 'system', id: response.available?.commit ?? 'update' },
      summary:
        response.available?.commit === undefined || response.available === null
          ? 'Güncelleme başlatıldı.'
          : `Güncelleme başlatıldı: ${response.available.commit}.`,
      correlationId,
    });

    return this.present(response);
  }

  /**
   * `system/` boyunca aynı kapı: kurucu yönetici.
   *
   * `sameOrigin` yalnız yazan uçlar için — okuma isteğinde CSRF diye bir şey yok, ve durumu
   * arayüzün her iki saniyede bir yoklaması gerekiyor.
   */
  private async requireAdministrator(
    request: AuthenticatedRequest,
    write: boolean,
  ): Promise<{ organizationId: string; userId: string }> {
    if (write) requireSameOrigin(request);
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();
    if (!(await this.system.isSystemAdministrator(session.userId))) throw new ForbiddenException();
    return { organizationId: session.organizationId, userId: session.userId };
  }

  /**
   * §12'nin ön kontrolü: boş alan ve havuz sağlığı.
   *
   * ── NEDEN BURADA ─────────────────────────────────────────────────────────────────────────
   *
   * Bu iki şeyi hiç kimse denetlemiyordu. %95 dolu bir sistem diskinde "Güncelle"ye basan
   * sahibinin gördüğü şey, derleme yarıda düştükten sonra geri alma da yer bulamadığında ortaya
   * çıkan bir kutuydu — ve terminalsiz bir çıkışı yoktu.
   *
   * ── ÖLÇÜLEMEYEN ŞEY ENGELLEMİYOR ─────────────────────────────────────────────────────────
   *
   * Boş alan okunamıyorsa ya da ajana ulaşılamıyorsa güncelleme durdurulmuyor: bir ölçüm
   * boşluğunu "hayır" diye okumak, cihazı bir güvenlik düzeltmesinden mahrum bırakmanın en
   * kolay yolu. Sebep günlüğe yazılıyor.
   *
   * SÜREN İŞ ve GERİ ALMA burada değil, ve olmamalı: ikinci bir güncellemeyi ajanın kendisi
   * reddediyor, geri alma da `update.sh`in içinde. İkinci bir kopya, ilkinin güncelliğini
   * kimsenin denetlemediği bir yerde tutmak olurdu.
   */
  private async precheck(organizationId: string, correlationId: string): Promise<void> {
    const free = await this.freeBytes();
    if (free === null) {
      this.logger.warn(`${UPDATE_TREE} üzerindeki boş alan okunamadı; ön kontrol atlandı`);
    } else if (free < MIN_FREE_BYTES) {
      throw new ConflictException(
        `Güncelleme başlatılmadı: sistem diskinde ${gigabytes(free)} GB boş yer var,` +
          ` kaynaktan derleme ve geri alma için en az ${gigabytes(MIN_FREE_BYTES)} GB gerekiyor.` +
          ` Yer açtıktan sonra yeniden deneyin.`,
      );
    }

    let pools: Telemetry['pools'];
    try {
      pools = (await this.system.telemetry(correlationId, organizationId)).pools;
    } catch (error) {
      if (!(error instanceof AgentUnavailableError)) throw error;
      // Ajan yoksa `apply_update` zaten 503 diyecek; buradan bir cümle daha eklemek gereksiz.
      return;
    }
    const sick = pools.find((pool) => UNHEALTHY.has(pool.health));
    if (sick !== undefined) {
      throw new ConflictException(
        `Güncelleme başlatılmadı: '${sick.name}' havuzu ${sick.health} durumda.` +
          ` Önce havuzu onarın — güncelleme sırasında düşen bir kutuda geri alma da aynı` +
          ` disklere yazıyor.`,
      );
    }
  }

  /**
   * Güncellemenin derleneceği dosya sisteminde kalan boş alan, bayt. `null` — ölçülemedi.
   *
   * `protected`, çünkü bu ölçüm cihazın dosya sistemine bağlı: testin dolu bir diski taklit
   * edebilmesi için üzerine yazılabilir olması gerekiyor.
   */
  protected async freeBytes(): Promise<number | null> {
    try {
      const stats = await statfs(UPDATE_TREE);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      return null;
    }
  }

  private async callAgent(
    operation: AgentRequest,
    reason: string,
    correlationId: string,
  ): Promise<AgentUpdate> {
    let response: AgentUpdate;
    try {
      response = await this.agent.call(operation, reason, correlationId);
    } catch (error) {
      if (error instanceof AgentUnavailableError) {
        throw new ServiceUnavailableException('depolama ajanına ulaşılamıyor');
      }
      throw error;
    }
    // Ajanın reddi bir HATA değil bir CEVAPTIR, ve cümlesi operatörün üzerine gidebileceği bir
    // olgudur: "bir güncelleme zaten sürüyor", "önce denetim çalıştırın".
    if (response.status === 'refused') {
      throw new BadRequestException(response.reason ?? 'güncelleme işlemi reddedildi');
    }
    if (response.status !== 'update') {
      throw new ServiceUnavailableException('güncelleme durumu okunamadı: beklenmeyen ajan yanıtı');
    }
    return response;
  }

  /**
   * Ajanın snake_case yanıtından API'nin camelCase şeması.
   *
   * Varsayılanlar EKSİK ALAN İÇİN DEĞİL, ESKİ AJAN İÇİN: şema sürümü el sıkışmada denetleniyor, ama
   * bir alan bir gün isteğe bağlı hâle gelirse arayüzün "bilinmiyor" ile "hayır"ı karıştırmaması
   * gerekiyor. `inProgress` bu yüzden `true`ya düşüyor — bilinmezlikte doğru davranış, ikinci bir
   * güncellemeye izin vermemek.
   */
  private present(response: AgentUpdate): Schemas['UpdateStatus'] {
    const available = response.available ?? null;
    return {
      installed: response.installed ?? null,
      available:
        available === null
          ? null
          : {
              commit: available.commit,
              subject: available.subject ?? null,
              committedAt: available.committed_at ?? null,
            },
      phase: response.phase ?? 'idle',
      inProgress: response.in_progress ?? true,
      upToDate: response.up_to_date ?? false,
      checkedAt: response.checked_at ?? null,
      startedAt: response.started_at ?? null,
      finishedAt: response.finished_at ?? null,
      error: response.error ?? null,
      logTail: response.log_tail ?? [],
      signed: response.signed ?? false,
    };
  }
}
