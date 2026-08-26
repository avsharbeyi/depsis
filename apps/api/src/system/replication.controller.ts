import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { z } from 'zod';

import { ReauthService } from '../auth/reauth.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { JobsService } from '../jobs/jobs.service.js';
import { BackupsService } from './backups.service.js';
import { SystemService } from './system.service.js';

type Schemas = OpenApi.components['schemas'];

/** İş kuyruğundaki tür. Üretici ve tüketici aynı sabiti okuyor. */
export const REPLICATE_KIND = 'storage.replicate';

const DATASET = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,254}$/;
const SNAPSHOT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,62}$/;

const bodySchema = z.object({
  source: z.string().regex(DATASET, 'a dataset name is required'),
  snapshot: z.string().regex(SNAPSHOT, 'a snapshot name is required'),
  target: z.string().regex(DATASET, 'a target dataset name is required'),
  /**
   * Artımlı gönderim için ortak taban. Verilmezse TAM gönderim.
   *
   * İstemci seçiyor, sunucu tahmin etmiyor: hedefin neyi tuttuğunu bilen taraf, hedefi listeleyen
   * ekran. Ve bir terabaytı taşımak, sunucunun kendi inisiyatifiyle başlatacağı bir şey değil.
   */
  base: z.string().regex(SNAPSHOT).nullable().optional(),
  confirm: z.string(),
  password: z.string().min(1).max(1024),
});

/**
 * Çoğaltma — bu API'nin veri yok eden İKİNCİ yolu.
 *
 * `zfs recv -F` hedefteki her şeyi ve ortak tabandan yeni her anlık görüntüyü YOK EDİYOR. Havuz
 * oluşturmayla aynı sınıfta, ve önünde §8.1'in aynı dizisi duruyor: analiz (`GET /backups` ve
 * hedefin listesi), plan, yazılı onay, yeniden kimlik doğrulama, iş.
 *
 * ONAY METNİ HEDEFİN ADI. Kaynağın değil: yok edilen şey hedef, ve bir onay kutusuna yazılacak şey
 * kaybedilecek olanın adı olmalı. Havuz oluşturmada da aynı kural — orada da silinen şeyin adı
 * yazılıyor.
 *
 * AJANIN REDLERİ BURADA TEKRARLANMIYOR. Ajan hedefin paylaşım kökü olup olmadığını KENDİ okuduğu
 * bir listeye karşı kontrol ediyor; buradaki bir kopya, bu sürecin eline verilmiş bir listeye karşı
 * kontrol olurdu, ve yalnızca istemcinin kendi ekranını doğru kopyaladığını kanıtlardı. Havuz
 * oluşturma rotası aynı gerekçeyi aynı sözlerle yazıyor.
 */
@Controller('storage/replication')
@UseGuards(SessionGuard)
export class ReplicationController {
  constructor(
    private readonly system: SystemService,
    private readonly jobs: JobsService,
    private readonly reauth: ReauthService,
    private readonly backups: BackupsService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @HttpCode(202)
  async replicate(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['JobAccepted']> {
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();
    // Havuz oluşturmayla aynı kapı ve aynı gerekçeyle: `system/` boyunca kurucu yönetici
    // kullanılıyor, ve bu rotayı istisna yapmak o soruyu kazara — riskli işlemde geniş kapı
    // yönünde — cevaplamak olurdu.
    if (!(await this.system.isSystemAdministrator(session.userId))) throw new ForbiddenException();

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid request');
    }
    const plan = parsed.data;

    // Paroladan ÖNCE: onayı yanlış yazan biri, bunu öğrenmek için parolasını vermek zorunda
    // kalmasın.
    if (plan.confirm !== plan.target) {
      throw new BadRequestException(
        `onaylamak için hedefin adını yazın: '${plan.target}'. Bu işlem hedefteki veriyi yok eder`,
      );
    }

    await this.reauth.require(session.organizationId, session.userId, plan.password, request);

    // KAYNAK ANLIK GÖRÜNTÜSÜ GERÇEKTEN VAR MI. Nazik yarı, zorlayan yarı değil: ajan zaten
    // reddediyor. Ama burada sorulduğunda cevap operatörün ekranı hâlâ açıkken geliyor, iki saniye
    // sonra kapanmış bir ekrana `zfs`'in kendi sözleriyle düşen bir iş hatası olarak değil.
    const onSource = await this.backups.inventory(
      [plan.source],
      `POST /storage/replication: checking ${plan.source}@${plan.snapshot}`,
    );
    if (onSource !== null && !onSource.some((s) => s.name === plan.snapshot)) {
      throw new ConflictException(
        `'${plan.source}' üzerinde '${plan.snapshot}' adında bir anlık görüntü yok`,
      );
    }

    // PAROLA YÜKTE DEĞİL. Klavyedeki kişiyi kanıtladı ve işi bitti; bir iş satırı isteği aşan bir
    // tabloda jsonb, `GET /jobs` ile okunuyor ve `job_history`'ye geçiyor.
    const jobId = await this.jobs.enqueue(
      session.organizationId,
      REPLICATE_KIND,
      {
        source: plan.source,
        snapshot: plan.snapshot,
        target: plan.target,
        base: plan.base ?? null,
        requestedBy: session.userId,
      },
      // TEK deneme. `zfs recv -F` yeniden çalıştırılabilir görünüyor — aynı akış yeniden
      // uygulanır — ama belirsiz bir hatadan sonraki yeniden deneme, hedefte ne olduğunu bilmeden
      // onu bir daha yok etmek demek. Havuz oluşturmadaki karar, aynı gerekçeyle.
      { maxAttempts: 1 },
    );
    await this.audit.record(session.organizationId, {
      actorId: session.userId,
      action: 'storage.replicate-requested',
      target: { kind: 'dataset', id: plan.target, label: plan.target },
      summary: `'${plan.source}@${plan.snapshot}' anlık görüntüsünün '${plan.target}' hedefine gönderilmesi istendi; hedefteki veri YOK EDİLECEK.`,
    });
    return { jobId };
  }
}
