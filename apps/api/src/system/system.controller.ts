import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { AgentService, AgentUnavailableError, type AgentResponse } from '../agent/agent.service.js';
import { AuditService } from '../audit/audit.service.js';
import { requireSameOrigin } from '../auth/origin.js';
import { z } from 'zod';

/** Ad: kırpılmış hâli boşsa adı kaldırır, yoksa 64 karakter. */
const labelSchema = z.object({ label: z.string().max(64) });
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import {
  SystemService,
  type DiskInventory,
  type StorageSetup,
  type Telemetry,
} from './system.service.js';

@Controller('system')
@UseGuards(SessionGuard)
export class SystemController {
  constructor(
    private readonly system: SystemService,
    private readonly agent: AgentService,
    private readonly audit: AuditService,
  ) {}

  /**
   * POST /system/power/reboot — cihazı yeniden başlat.
   *
   * ── NEDEN VAR ────────────────────────────────────────────────────────────────────────────
   *
   * Güç menüsünde "Yenile" yazan bir düğme vardı ve yalnızca TARAYICI SAYFASINI tazeliyordu.
   * Cihazın sahibinin oradan beklediği şey cihazın kendisinin yeniden başlaması; bir güç
   * simgesinin altında "yenile" yazması, yapmadığı bir şeyi vaat etmekti.
   *
   * ── YÖNETİCİ, VE AYNI KÖKEN ──────────────────────────────────────────────────────────────
   *
   * Kurucu yönetici dışında kimse çağıramıyor — kutuyu kapatmak, o kutudaki herkesin işini
   * kesiyor. `requireSameOrigin`, oturum çerezini taşıyan başka bir sekmenin sessizce cihazı
   * yeniden başlatamaması için: bu, gövdesi olmayan ve tek çağrıyla etki eden bir işlem, yani
   * siteler arası bir isteğin en sevdiği şekil.
   *
   * PAROLA İSTENMİYOR, güncelleme uygulamaktan farklı olarak. Yeniden başlatmak veri
   * kaybettirmiyor ve geri alınabilir bir şey; ekrandaki onay kutusu buna yetiyor. Diski silmek
   * ya da sürüm değiştirmek gibi geri alınamaz işlemlerde parola istenmeye devam ediyor.
   *
   * ── CEVAP DÖNÜYOR, SONRA KUTU GİDİYOR ────────────────────────────────────────────────────
   *
   * `systemctl reboot` isteği systemd'ye bırakıp çıkıyor, yani 202 gerçekten dönüyor. Ajanın
   * ulaşılamaz olması da bu tek işlemde bir hata değil: kapanma başlamışsa olacak olan şey zaten
   * bu, ve kullanıcıya "yeniden başlatılamadı" demek yanlış olurdu.
   *
   * AMA "AJAN SUSTU" İLE "AJAN HAYIR DEDİ" AYRI ŞEYLER. `refused` ve `failed` bu telde olağan
   * cevaplar, istisna değil (`agent.service.ts`); `systemctl reboot` bir polkit/dbus arızasıyla
   * sıfırdan farklı çıktığında ajan `failed` diyor. Cevabı hiç okumayan bu uç o hâlde de 202
   * dönüyordu: ekran "yeniden başlatılıyor" yazıyor, kutu hiç kapanmıyor, ve sahibi neden
   * olmadığını hiçbir yerde göremiyordu.
   */
  @Post('power/reboot')
  @HttpCode(202)
  async reboot(@Req() request: AuthenticatedRequest): Promise<void> {
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();
    requireSameOrigin(request);
    if (!(await this.system.isSystemAdministrator(session.userId))) {
      throw new ForbiddenException();
    }

    const correlationId = randomUUID();
    await this.audit.record(session.organizationId, {
      actorId: session.userId,
      action: 'system.reboot',
      target: { kind: 'system', id: 'reboot' },
      // KAYIT ÇAĞRIDAN ÖNCE, ve öyle kalıyor: başarılı bir yeniden başlatmada systemd kutuyu
      // kapatırken bu satır artık yazılamayabilir. Cümlesi bu yüzden bir olgu değil bir İSTEK
      // bildiriyor — ajanın kendi kalıbı da (dispatch.rs) işten önce yazmak.
      summary: 'Cihazın yeniden başlatılması istendi.',
      correlationId,
    });

    let response: AgentResponse;
    try {
      response = await this.agent.call(
        { op: 'reboot_system' },
        'rebooting the appliance',
        correlationId,
      );
    } catch (error) {
      // AJANIN SUSMASI BURADA BİR HATA DEĞİL. Kapanma başladıysa soket zaten gidiyor, ve
      // kullanıcıya "yeniden başlatılamadı" demek, olan bitenin tam tersini söylemek olurdu.
      if (!(error instanceof AgentUnavailableError)) throw error;
      return;
    }
    if (response.status === 'refused' || response.status === 'failed') {
      // AJANIN KENDİ CÜMLESİ GERİ VERİLMİYOR: `failed` bir komut hatasında ayrıcalıklı ikilinin
      // mutlak yolunu ve ham stderr'i taşıyor (`backups.controller.explain` aynı ayrımı yapıyor).
      // Kullanıcıya gereken cümle, kutunun kapanmadığı.
      throw new ServiceUnavailableException(
        'Cihaz yeniden başlatılamadı: sistem ajanı isteği yerine getiremedi.',
      );
    }
  }

  /**
   * GET /system/telemetry — hardware and storage status.
   *
   * Administrator only. The contract says the response narrows by role; nothing here narrows a
   * payload, so this implements the half that can be implemented honestly — a non-administrator is
   * refused outright rather than shown a payload trimmed by rules nobody has written down. Showing
   * ordinary users a narrowed view is a change to make with those rules written down, not one to
   * improvise here.
   *
   * Which administrator: the ONE account in `system_setup`, not everyone with `role = 'admin'`.
   * That is deliberately noted rather than assumed, because `POST /backups` next door uses
   * `AdminGuard` and therefore admits a wider set for a more privileged operation. See the note on
   * `SystemService.isSystemAdministrator` — the two want reconciling as one decision.
   */
  /**
   * GET /system/storage — is this box's storage set up, and with what?
   *
   * The same gate as the rest of `system/`. It reports pool names and a dataset path, which are
   * facts about the appliance rather than about anybody's files, but they are still the shape of
   * thing an operator is shown and a member is not.
   */
  @Get('storage')
  async storage(@Req() request: AuthenticatedRequest): Promise<StorageSetup> {
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();
    if (!(await this.system.isSystemAdministrator(session.userId))) {
      throw new ForbiddenException();
    }

    try {
      return await this.system.storageSetup(randomUUID());
    } catch (error) {
      if (error instanceof AgentUnavailableError) {
        // Not a 200 with everything absent. "Nothing is set up" is what a fresh appliance looks
        // like and is the state the wizard acts on; "we could not ask" must not render as it, or
        // the wizard offers to prepare a share root that already exists.
        throw new ServiceUnavailableException(
          'Depolama durumu okunamadı: sistem ajanına ulaşılamıyor.',
        );
      }
      throw error;
    }
  }

  /**
   * GET /system/disks — what is physically in the box.
   *
   * The same gate as telemetry, and for a stronger reason: this reports the model and serial of
   * every disk, and — through `holds` — what is on them. Neither is a user's business.
   */
  @Get('disks')
  async disks(@Req() request: AuthenticatedRequest): Promise<DiskInventory> {
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();
    if (!(await this.system.isSystemAdministrator(session.userId))) {
      throw new ForbiddenException();
    }

    try {
      // Kuruluş bağlamı geçiliyor: envanterin kendisi durumsuz, ama kullanıcının disklere
      // verdiği adlar bir kiracıya ait ve yalnız onun ekranında görünmeli.
      return await this.system.inventory(randomUUID(), session.organizationId);
    } catch (error) {
      if (error instanceof AgentUnavailableError) {
        // Not a 200 with an empty list, for the same reason telemetry refuses one: the caller of
        // this endpoint is choosing disks to overwrite, and "there are none" is the most
        // dangerous wrong answer it could be given.
        throw new ServiceUnavailableException(
          'Disk envanteri okunamadı: sistem ajanına ulaşılamıyor.',
        );
      }
      throw error;
    }
  }

  /**
   * PUT /system/disks/{diskId}/label — diske insan adı ver.
   *
   * ANAHTAR `by-id`, `kname` DEĞİL. `/dev/sda` bir slot değil bir sıra: aynı disk yeniden
   * başlatmadan sonra `sdb` olabilir ve ad o zaman yanlış diski adlandırır — risk R1'in ta
   * kendisi, ve havuz kurmanın WWN doğrulamasının var olma sebebi.
   *
   * Boş ad, adı KALDIRIYOR. "Adı yok" ile "adı boş" farklı iki şey.
   */
  @Put('disks/:diskId/label')
  @HttpCode(204)
  async setDiskLabel(
    @Req() request: AuthenticatedRequest,
    @Param('diskId') diskId: string,
    @Body() body: unknown,
  ): Promise<void> {
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();
    requireSameOrigin(request);
    if (!(await this.system.isSystemAdministrator(session.userId))) {
      throw new ForbiddenException();
    }
    const parsed = labelSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('label: en fazla 64 karakter');
    if (diskId.length === 0 || diskId.length > 255) {
      throw new BadRequestException('diskId: 1-255 karakter');
    }
    await this.system.setDiskLabel(session.organizationId, diskId, parsed.data.label);
  }

  @Get('telemetry')
  async telemetry(@Req() request: AuthenticatedRequest): Promise<Telemetry> {
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();

    if (!(await this.system.isSystemAdministrator(session.userId))) {
      // 403, not 404. The endpoint's existence is in the published contract, so hiding it would
      // conceal nothing while making a legitimate administrator's misconfiguration harder to
      // diagnose. What is withheld is the system detail, not the fact that it exists.
      throw new ForbiddenException();
    }

    // One id per HTTP request, carried into every privileged call the request makes, so the agent's
    // audit trail can be read back to the request that caused it (§16).
    const correlationId = randomUUID();

    try {
      return await this.system.telemetry(correlationId, session.organizationId);
    } catch (error) {
      if (error instanceof AgentUnavailableError) {
        // Deliberately not a 200 with an empty `pools`. "There are no pools" and "we could not find
        // out" are the two answers an operator most needs to tell apart, and the second one is the
        // one that means something is wrong right now.
        throw new ServiceUnavailableException(
          'Storage status is unavailable: the system agent could not be reached.',
        );
      }
      throw error;
    }
  }
}
