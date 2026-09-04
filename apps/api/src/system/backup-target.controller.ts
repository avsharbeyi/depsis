import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Logger,
  Query,
  Patch,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { AgentUnavailableError } from '../agent/agent.service.js';
import { AuditService } from '../audit/audit.service.js';
import { requireSameOrigin } from '../auth/origin.js';
import type { ResolvedSession } from '../auth/session.service.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { BackupRunService } from './backup-run.service.js';
import {
  BackupAgentRefusedError,
  BackupTargetService,
  NoBackupTargetError,
} from './backup-target.service.js';
import { SystemService } from './system.service.js';

/**
 * Havuz adı — `SafeComponent`in kabul ettiğiyle aynı biçim, ve burada da reddediliyor.
 *
 * Ajan zaten reddediyor; buradaki kopya, kullanıcının hatayı FORM AÇIKKEN görmesi için. Bir
 * eğik çizgi bir VERİ KÜMESİ adı olurdu, `-` ile başlayan bir ad `zpool`un bir bayrağı.
 */
const POOL = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,62}$/u, 'havuz adı bir harfle başlamalı');

const prepareBody = z.object({
  pool: POOL,
  label: z.string().trim().min(1).max(64),
  // ZFS'in kendi alt sınırı sekiz bayt. Ajan da reddediyor; buradaki kopya, kullanıcının
  // hatayı diski kurmadan ÖNCE görmesi için.
  passphrase: z.string().min(8).max(512),
});

const unlockBody = z.object({ passphrase: z.string().min(8).max(512) });

const adoptBody = z.object({
  pool: POOL,
  // DEVRALMA AYRI BİR ONAY. Ölen bir cihazdan çıkan disk hiçbir zaman düzgün bırakılmamış olur,
  // yani kurtarmada neredeyse her zaman gerekiyor — ama aynı disk hâlâ çalışan başka bir cihazda
  // takılıysa devralmak havuzu bozar, ve o karar kullanıcının gördüğü bir uyarının arkasında
  // olmalı.
  adopt: z.boolean(),
});

/**
 * Yol bileseni — ajanin `SafeComponent`iyle ayni bicim.
 *
 * Egik cizgi, `..` ve NUL burada da reddediliyor. Ajan zaten reddediyor; buradaki kopya, hatanin
 * kullaniciya bir 400 olarak ve anlasilir bir cumleyle donmesi icin.
 */
const COMPONENT = z
  .string()
  .min(1)
  .max(255)
  .refine((v) => !v.includes('/') && v !== '.' && v !== '..' && !v.includes('\0'), {
    message: 'yol bileseni bir egik cizgi ya da nokta-nokta olamaz',
  });

const restoreBody = z.object({
  from: z.array(COMPONENT).min(1),
  share: COMPONENT,
  to: z.array(COMPONENT).min(1),
});

const patchBody = z
  .object({
    label: z.string().trim().min(1).max(64).optional(),
    cadenceHours: z.number().int().min(1).max(168).optional(),
    // SIFIR YOK. Silinen dosyanın aynı turda yedekten de gitmesi demek — yani yanlışlıkla
    // silmeye karşı hiçbir koruma bırakmayan bir ayna. Bunu bir ayar olarak sunmak,
    // kullanıcıya kendi korumasını kapatmanın kolay yolunu vermek olurdu.
    retainDays: z.number().int().min(1).max(3650).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'değiştirilecek bir alan verin' });

/**
 * Yedek diski — kurulması, kilidi ve iki ayarı.
 *
 * ── PAROLA HİÇBİR YERE YAZILMIYOR ────────────────────────────────────────────────────────────
 *
 * Ne veritabanına, ne bir iş satırına, ne denetim kaydına. Bu isteklerin gövdesinde geliyor,
 * ajana stdin'den veriliyor ve orada bitiyor. Sonucu: cihaz her açıldığında disk KİLİTLİ oluyor
 * ve sahibinin bir kez parola girmesi gerekiyor.
 *
 * Bu bir eksiklik değil, sahibinin şartının kendisi: *"sistem diski ve depolama diski yansa bile
 * yedek diski eğer şifre biliniyorsa kullanılabilir olmalı."* Parolayı cihazda saklasaydık,
 * çalınan bir cihazın içindeki yedek diski de çalınmış olurdu ve şifreleme gerçek tehditlerin
 * çoğuna karşı hiçbir şey yapmazdı.
 *
 * ── HAVUZU BU UÇ KURMUYOR ────────────────────────────────────────────────────────────────────
 *
 * Diskleri silen tören (§8.1) havuz kurma akışında zaten var. Buraya gelen havuz, kullanıcının o
 * töreni geçerek kurduğu havuz; töreni ikinci kez burada yapmak onu bir formaliteye çevirirdi.
 */
@Controller('backups/target')
@UseGuards(SessionGuard)
export class BackupTargetController {
  private readonly logger = new Logger(BackupTargetController.name);

  constructor(
    private readonly targets: BackupTargetService,
    private readonly runs: BackupRunService,
    private readonly system: SystemService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async read(@Req() request: AuthenticatedRequest): Promise<unknown> {
    const session = await this.requireAdmin(request);
    try {
      const view = await this.targets.view(session.organizationId, randomUUID());
      // KURULU DEĞİL bir hata değil: cihazın olağan ilk hâli. Ekranın diyeceği cümle "yedek
      // diski kurun", ve 404 o cümleyi kurdurmaz — bir yokluk bildirir.
      return { configured: view !== null, target: view };
    } catch (error) {
      throw this.translate(error);
    }
  }

  @Post()
  async prepare(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<unknown> {
    const session = await this.requireAdmin(request);
    requireSameOrigin(request);
    const parsed = prepareBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);

    let view;
    try {
      view = await this.targets.prepare(session.organizationId, parsed.data, randomUUID());
    } catch (error) {
      throw this.translate(error);
    }

    // ── ZİNCİRLERİ KURULDUĞU ANDA TOHUMLA ─────────────────────────────────────────────────
    //
    // Tur, budama ve doğrulama zincirleri YALNIZ `BackupRunService.onModuleInit`te
    // tohumlanıyordu, yani var olan satırlar için API her açıldığında. Yedek diskini kuran
    // kullanıcı için bunun anlamı şuydu: sihirbaz bitiyor, ekran "6 saatte bir" diyor, ve API
    // yeniden başlayana kadar TEK BİR YEDEK ALINMIYOR. Sahibinin göreceği hâliyle "kurdum ama
    // hiçbir şey olmuyor".
    //
    // `ON CONFLICT DO NOTHING` üçünde de var, yani açılıştaki tohumla çakışmıyor: hangisi önce
    // gelirse zincir ondan başlıyor.
    //
    // HATA YUTULUYOR ama SESSİZ DEĞİL. Hedef kuruldu ve satırı yazıldı; kuyruğa yazamamak onu
    // geri almak için sebep değil, ve bir sonraki açılış zaten tohumluyor. Kaydedilmemesi
    // gereken tek şey, sessizce hiç denenmemiş olması.
    await this.runs.seedChains(session.organizationId).catch((error: unknown) => {
      this.logger.error(
        `yedek zincirleri tohumlanamadı: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    // DENETİM KAYDINDA PAROLA YOK — yalnız hangi havuzun yedek diski yapıldığı.
    await this.audit.record(session.organizationId, {
      actorId: session.userId,
      action: 'backup.target-prepared',
      target: { kind: 'pool', id: parsed.data.pool, label: parsed.data.label },
      summary: `'${parsed.data.pool}' havuzu şifreli yedek diski olarak kuruldu.`,
    });
    return view;
  }

  @Post('unlock')
  @HttpCode(200)
  async unlock(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<unknown> {
    const session = await this.requireAdmin(request);
    requireSameOrigin(request);
    const parsed = unlockBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    try {
      return await this.targets.unlock(
        session.organizationId,
        parsed.data.passphrase,
        randomUUID(),
      );
    } catch (error) {
      throw this.translate(error);
    }
  }

  @Post('lock')
  @HttpCode(200)
  async lock(@Req() request: AuthenticatedRequest): Promise<unknown> {
    const session = await this.requireAdmin(request);
    requireSameOrigin(request);
    let view;
    try {
      view = await this.targets.lock(session.organizationId, randomUUID());
    } catch (error) {
      throw this.translate(error);
    }
    await this.audit.record(session.organizationId, {
      actorId: session.userId,
      action: 'backup.target-locked',
      target: { kind: 'pool', id: view.pool, label: view.label },
      summary: `Yedek diski kilitlendi; açılana kadar yedekleme duruyor.`,
    });
    return view;
  }

  /**
   * "Simdi yedek al" — kullanicinin bastigi dugme.
   *
   * IS KUYRUGA KONUYOR, burada kosturulmuyor. Bir tur saatler surebilir ve bir HTTP istegi o
   * kadar beklemez; beklese bile tarayici vazgectiginde tur yarim kalirdi. Cevap "kuyruga
   * alindi"; ne oldugunu tur gecmisi soyluyor.
   */
  @Post('run')
  @HttpCode(202)
  async run(@Req() request: AuthenticatedRequest): Promise<{ queued: true }> {
    const session = await this.requireAdmin(request);
    requireSameOrigin(request);
    const target = await this.targets.row(session.organizationId);
    if (target === null) throw new BadRequestException('bu cihazda yedek diski kurulu degil');
    await this.runs.runNow(session.organizationId);
    return { queued: true };
  }

  /**
   * Yedek agacinda gezinme.
   *
   * Sahibinin sozu: "yedek diski tipki ana depolama gibi olmali ama dosyalara yedekleme
   * kismindan erisilmeli." Kok iki klasor gosteriyor ve ikisi de gorunuyor: `Dosyalar/`
   * gecikmeli ayna, `DEPSIS-YEDEK/` defterin kendisi.
   */
  @Get('entries')
  async entries(
    @Req() request: AuthenticatedRequest,
    @Query('path') rawPath?: string,
  ): Promise<unknown> {
    const session = await this.requireAdmin(request);
    // Bos ya da eksik `path` KOKUN kendisi, ve bu bir hata degil: gezgin oradan basliyor.
    const parts = (rawPath ?? '')
      .split('/')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    const parsed = z.array(COMPONENT).safeParse(parts);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    try {
      return await this.targets.browse(session.organizationId, parsed.data, randomUUID());
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * Yedekteki bir dosyayi bir paylasima geri getirir.
   *
   * ISTEK BEKLIYOR, kuyruga alinmiyor: tek bir dosyanin geri getirilmesi saniyeler suruyor ve
   * kullanici sonucu HEMEN gormek istiyor — "kuyruga alindi" diyen bir cevap, dosyanin gelip
   * gelmedigini baska bir ekranda aratirdi. Buyuk bir agacin tamaminin geri getirilmesi ayri bir
   * istek ve o gelene kadar dosya dosya calisiyor.
   */
  @Post('restore')
  @HttpCode(200)
  async restore(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<unknown> {
    const session = await this.requireAdmin(request);
    requireSameOrigin(request);
    const parsed = restoreBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);

    let result;
    try {
      // Geri getiren hesap, dosyanın sahibi oluyor. Ajanın `restore_file_from_backup` işlemi artık
      // sahip istiyor: eskiden dosya `root:root` iniyordu ve sahibi onu ağ sürücüsünden hiç
      // açamıyordu — yani "geri getirildi" diyen bir düğme, ulaşılamayan bir dosya bırakıyordu.
      result = await this.targets.restore(
        session.organizationId,
        { ...parsed.data, actorId: session.userId },
        randomUUID(),
      );
    } catch (error) {
      throw this.translate(error);
    }
    await this.audit.record(session.organizationId, {
      actorId: session.userId,
      action: 'backup.file-restored',
      target: {
        kind: 'share',
        id: parsed.data.share,
        label: parsed.data.to.join('/'),
      },
      summary: `'${parsed.data.from.join('/')}' yedekten '${parsed.data.share}/${parsed.data.to.join('/')}' konumuna geri getirildi.`,
    });
    return result;
  }

  /**
   * Takilabilecek havuzlari sayar — kurtarmanin ilk adimi.
   *
   * PAROLA SORULMUYOR ve sorulamaz: bu, diskin SIFRESIZ yarisindan okunan bilgi. Sahibinin
   * sarti *"sistem diski ve depolama diski yansa bile yedek diski eger sifre biliniyorsa
   * kullanilabilir olmali"* — ve o yolun ilk adimi, elinde disk olan kisinin ekranda ne
   * oldugunu gormesi.
   */
  @Get('recovery/scan')
  async scan(@Req() request: AuthenticatedRequest): Promise<unknown> {
    await this.requireAdmin(request);
    try {
      return await this.targets.scanImportable(randomUUID());
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * Baska bir cihazin yedek diskini bu cihaza tanitir.
   *
   * DOSYALAR HALA KILITLI. Bu adim yalniz taniyor: havuzu hicbir veri kumesini baglamadan
   * takiyor ve sifresiz yarisini okuyor. Acan sey, bundan sonra `POST unlock`a girilen parola.
   */
  @Post('recovery/adopt')
  @HttpCode(200)
  async adopt(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<unknown> {
    const session = await this.requireAdmin(request);
    requireSameOrigin(request);
    const parsed = adoptBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);

    let view;
    try {
      view = await this.targets.adopt(session.organizationId, parsed.data, randomUUID());
    } catch (error) {
      throw this.translate(error);
    }
    await this.audit.record(session.organizationId, {
      actorId: session.userId,
      action: 'backup.recovery-adopted',
      target: { kind: 'pool', id: parsed.data.pool, label: view.label },
      summary: `'${parsed.data.pool}' havuzu kurtarma diski olarak tanindi.`,
    });
    return view;
  }

  /** Devralinan diski birakir — fisini cekmeden onceki dogru adim. */
  @Post('recovery/release')
  @HttpCode(204)
  async release(@Req() request: AuthenticatedRequest): Promise<void> {
    const session = await this.requireAdmin(request);
    requireSameOrigin(request);
    const target = await this.targets.row(session.organizationId);
    try {
      await this.targets.release(session.organizationId, randomUUID());
    } catch (error) {
      throw this.translate(error);
    }
    await this.audit.record(session.organizationId, {
      actorId: session.userId,
      action: 'backup.recovery-released',
      target: { kind: 'pool', id: target?.pool ?? '', label: target?.label ?? '' },
      summary: `Kurtarma diski birakildi; fisi cekilebilir.`,
    });
  }

  @Patch()
  async update(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<unknown> {
    const session = await this.requireAdmin(request);
    requireSameOrigin(request);
    const parsed = patchBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    try {
      // `exactOptionalPropertyTypes` altında `{ a: undefined }` ile `{}` ayrı şeyler, ve
      // ayrımı korumak doğru: "bu alanı değiştirme" ile "bu alanı undefined yap" aynı istek
      // değil. Yalnız GERÇEKTEN verilen alanlar geçiyor.
      const patch: Parameters<BackupTargetService['update']>[1] = {};
      if (parsed.data.label !== undefined) patch.label = parsed.data.label;
      if (parsed.data.cadenceHours !== undefined) patch.cadenceHours = parsed.data.cadenceHours;
      if (parsed.data.retainDays !== undefined) patch.retainDays = parsed.data.retainDays;
      if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled;
      return await this.targets.update(session.organizationId, patch);
    } catch (error) {
      throw this.translate(error);
    }
  }

  private async requireAdmin(request: AuthenticatedRequest): Promise<ResolvedSession> {
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();
    if (!(await this.system.isSystemAdministrator(session.userId))) {
      throw new ForbiddenException('yedek diski yalnız yöneticiler tarafından yönetilir');
    }
    return session;
  }

  /**
   * Ajanın cümlesi KULLANICIYA ULAŞIYOR.
   *
   * Sahada bir yayım hatası "beklenmeyen bir hata oluştu" diye gösterildi ve teşhis ancak cihaza
   * SSH ile girilip denetim günlüğü okunarak yapılabildi — oysa ajanın söylediği cümle ekranda
   * gösterilebilecek kadar somuttu. Aynı hatayı burada yapmıyoruz.
   */
  private translate(error: unknown): Error {
    if (error instanceof NoBackupTargetError) {
      return new BadRequestException('bu cihazda yedek diski kurulu değil');
    }
    if (error instanceof BackupAgentRefusedError) {
      return new BadRequestException(error.agentReason);
    }
    if (error instanceof AgentUnavailableError) {
      return new ServiceUnavailableException('depolama ajanına ulaşılamıyor');
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}
