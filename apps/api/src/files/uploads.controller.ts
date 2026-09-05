import {
  Body,
  BadRequestException,
  ConflictException,
  Controller,
  Head,
  Headers,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';

import { AgentService, expectStatus } from '../agent/agent.service.js';
import { AgentDataService, AgentOutOfSpaceError } from '../agent/agent-data.service.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { ProblemException } from '../common/problem.filter.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { DbService } from '../db/db.service.js';
import { PosixIdentityService } from '../identity/posix.service.js';
import { CopyService } from './copy.service.js';
import { formatBytes } from './file-operations.controller.js';
import {
  assertValidName,
  FilesService,
  StagedBytesGoneError,
  type ShareRow,
} from './files.service.js';
import {
  requirePermission,
  requireSession,
  requireUuid,
  requireWritableShare,
  toEntry,
  translate,
} from './files.controller.js';

/**
 * Ad çakışmasının iki çıkışı.
 *
 * "Üzerine yaz" YOK ve olmaması bilinçli: ADR-0008 `RENAME_NOREPLACE` ile bir yayımlamanın
 * kullanıcının sahip olduğu bir dosyayı asla sessizce yok etmemesini garanti ediyor. `replace`
 * eskisini çöpe atıyor — kullanıcının istediği "yeni dosya bu adı alsın", "eskisi geri
 * getirilemez olsun" değil.
 */
const resolveSchema = z.object({ policy: z.enum(['keep-both', 'replace']) });

interface SessionRow {
  id: string;
  share_id: string;
  parent_id: string | null;
  filename: string;
  staging_name: string;
  length_bytes: string;
  offset_bytes: string;
  file_id: string | null;
}

/**
 * Resumable upload, the tus subset DEPSIS needs (ADR-0008).
 *
 * The bytes do not pass through this process's memory: the request stream is piped straight into
 * the agent's data socket. That matters for more than efficiency — buffering a chunk would make an
 * upload's peak memory a function of what a client chooses to send.
 *
 * The offsets have two sources and only one authority. `upload_sessions.offset_bytes` is a cache
 * that makes HEAD cheap; the agent seeks the staging file on every `open_transfer` and refuses a
 * mismatch, so a stale cache produces a refusal the client corrects with a HEAD — never a
 * duplicated or missing region.
 */
@Controller('uploads')
@UseGuards(SessionGuard)
export class UploadsController {
  private readonly logger = new Logger(UploadsController.name);

  constructor(
    private readonly db: DbService,
    private readonly files: FilesService,
    private readonly agent: AgentService,
    private readonly data: AgentDataService,
    private readonly posix: PosixIdentityService,
    // Yalnız `freeName` için: "ad (2).uzantı" üretmenin tek yeri, ve ikinci bir kopyası
    // ikinci bir adlandırma kuralı demek olurdu.
    private readonly copies: CopyService,
  ) {}

  /**
   * POST /uploads/{id}/resolve — ad çakışmasını kullanıcının kararıyla bitirir.
   *
   * ── BAYTLAR ZATEN YÜKLENDİ ───────────────────────────────────────────────────────────────
   *
   * Çakışma yayımlama anında, yani son parçadan SONRA ortaya çıkıyor: dosya bütünüyle ara alanda
   * duruyor. Bu yüzden çözüm "yeniden yükle" değil "yayımlamayı tekrar dene" — kullanıcı bir
   * gigabaytı ikinci kez göndermiyor. Süpürücü ara alandaki dosyaya yirmi dört saat dokunmuyor,
   * yani kararı vermek için zaman da var.
   *
   * ── İKİ KARAR, İKİSİ DE VERİ KAYBETMİYOR ─────────────────────────────────────────────────
   *
   * `keep-both`: yeni dosya "ad (2).uzantı" ile iniyor. Kopyalama yolunun kullandığı adlandırma
   * kuralının aynısı — kullanıcının başka bir yerde gördüğü biçim.
   *
   * `replace`: ESKİSİ ÇÖPE GİDİYOR, silinmiyor. Üstüne yazmak ürünün hiçbir katmanında yok ve
   * olmaması bilinçli (ADR-0008, `RENAME_NOREPLACE`); ama "değiştir" diyen kullanıcının istediği
   * şey yeni dosyanın o adı alması, eskisinin yok olması değil. Eski satır önce boş bir ada
   * taşınıyor — çöp diskte bir şey taşımıyor, yani ad ancak böyle serbest kalıyor — sonra çöpe
   * atılıyor. Kullanıcı yanlış karar verdiyse çöp kutusundan geri alabiliyor.
   *
   * ── PARK GERİ ALINIYOR ───────────────────────────────────────────────────────────────────
   *
   * Park etmek ile yayımlamak iki ayrı adım, ve ikincisi düşebiliyor: ara dosyayı süpürücü yirmi
   * dört saat sonra siliyor, ajan kapanmış olabiliyor, ya da adı ağ sürücüsünden yazılmış bir
   * dosya tutuyor olabiliyor. Eskiden bu durumda klasörde NE eski NE yeni dosya kalıyordu — eski
   * dosya çöp kutusunda, üstelik `rapor (2).pdf` gibi kullanıcının hiç koymadığı bir adla. Yayım
   * düşerse park GERİ ALINIYOR: satır çöpten çıkarılıp eski adına döndürülüyor, ve kullanıcının
   * gördüğü cümle yalnız yayımın neden düştüğü.
   */
  @Post(':uploadId/resolve')
  @HttpCode(200)
  async resolve(
    @Req() request: AuthenticatedRequest,
    @Param('uploadId') id: string,
    @Body() body: unknown,
  ): Promise<ReturnType<typeof toEntry>> {
    const session = requireSession(request);
    requireUuid(id);
    const uploadId = id;
    const parsed = resolveSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('policy: keep-both ya da replace');

    const upload = await this.loadSession(session.organizationId, session.userId, uploadId);
    if (upload.file_id !== null) {
      // Zaten yayımlanmış: ikinci bir çözüm ikinci bir dosya üretirdi.
      throw new ProblemException('conflict', 'bu yükleme zaten tamamlandı');
    }
    if (Number(upload.offset_bytes) !== Number(upload.length_bytes)) {
      throw new ProblemException('conflict', 'yükleme henüz tamamlanmadı');
    }

    // OTURUMUN KENDİ PAYLAŞIMI, hedef klasörden türetilen değil. Ara dosya `share_id`nin altında
    // açıldı; kökteki bir yükleme için `parent_id` null olduğundan yeniden türetmek kiracının
    // VARSAYILAN paylaşımını verirdi ve yayımlama başka bir ağaçta ara dosya arardı.
    const share = await this.files
      .shareFor(session.organizationId, upload.share_id)
      .catch((error: unknown) => {
        throw translate(error);
      });
    // Aynı kapı, aynı gerekçe: yükleme oluşturulurken sorulan izin burada TEKRAR soruluyor,
    // çünkü çakışmanın çözülmesi ile yüklemenin başlaması arasında bir hak geri alınmış olabilir.
    requirePermission(
      await this.files.effectiveAt(session, share.id, upload.parent_id),
      'create',
      upload.parent_id !== null,
    );
    // Paylaşım yükleme başladıktan sonra salt okunura çevrilmiş olabilir; çakışmayı çözmek de
    // yayımlamak demek.
    requireWritableShare(share);

    const correlationId = randomUUID();
    const parentComponents =
      upload.parent_id === null
        ? []
        : await this.files.componentsOf(session.organizationId, upload.parent_id);

    // KİMLİK PARKTAN ÖNCE. Sırası önemli: `posixUidFor` de düşebilen bir adım, ve park edilmiş bir
    // dosyayı geri almak zorunda kalmamanın en ucuz yolu, düşebilecek her şeyi parktan önce
    // bitirmek.
    const uid = await this.posix
      .posixUidFor(session.organizationId, session.userId)
      .catch((error: unknown) => {
        throw translate(error);
      });

    let name = upload.filename;
    let parked: string | null = null;
    if (parsed.data.policy === 'keep-both') {
      name = await this.copies.freeName(
        session.organizationId,
        upload.share_id,
        upload.parent_id,
        upload.filename,
      );
    } else {
      parked = await this.moveExistingToTrash(session, upload, share, correlationId);
    }

    const bytes = await this.files
      .publish(
        share.name,
        upload.staging_name,
        [...parentComponents, name],
        Number(upload.length_bytes),
        uid,
        uid,
        correlationId,
        `resolving the name clash on ${upload.filename}`,
      )
      .catch(async (error: unknown) => {
        // Yayım düştü ve "değiştir" seçilmişti: eski dosya şu anda çöpte, üstelik başka bir adla.
        // Geri alınmazsa kullanıcının klasöründe hiçbir şey kalmıyor.
        await this.unpark(session, upload, share, parked, correlationId);
        // ── ÇIKIŞI OLMAYAN SATIR SİLİNİYOR ────────────────────────────────────────────────
        // Baytlar ara alanda yoksa bu oturum için yapılabilecek hiçbir şey kalmamış demektir.
        // Satırı bırakmak, kullanıcıya sonsuza kadar "cevabınızı bekliyor" diyen ve her cevabı
        // "yayımlanamadı" ile karşılayan bir liste bırakmak olurdu — sahada 12 dosya tam olarak
        // öyle duruyordu. Silinen şey yalnız oturum kaydı; silinecek bir bayt zaten yok.
        if (error instanceof StagedBytesGoneError) {
          await this.db.withTenant(session.organizationId, (db) =>
            db.query(`DELETE FROM public.upload_sessions WHERE organization_id = $1 AND id = $2`, [
              session.organizationId,
              upload.id,
            ]),
          );
          this.logger.warn(
            `yükleme ${upload.id} kapatıldı: ara alandaki baytlar yok (${upload.filename})`,
          );
        }
        throw translate(error);
      });

    const entry = await this.files
      .recordPublishedFile(
        session.organizationId,
        upload.share_id,
        upload.parent_id,
        name,
        bytes,
        null,
        // YEDİNCİ ARGÜMAN `copiedFromEntryId`, VE BURADA HİÇBİR ŞEY. Bir süre burada
        // `session.userId` duruyordu: sütun `file_entries(id)`e yabancı anahtar, yani her
        // çakışma çözümü 23503 ile düşüyordu — üstelik dosya ajan tarafından paylaşıma
        // YAYIMLANDIKTAN sonra. Kullanıcı hata görüyordu, yeni dosya diskteydi, "değiştir"
        // seçildiyse eskisi çöpteydi, ve DEPSIS'in dizininde ikisi de yoktu.
        //
        // Bu satır bir kopya DEĞİL: çakışmayı çözen bir yükleme, kullanıcının gönderdiği yeni
        // bir dosya. `null` alanın söylediği şey bu.
        null,
      )
      .catch((error: unknown) => {
        throw translate(error);
      });

    await this.db.withTenant(session.organizationId, (db) =>
      db.query(
        `UPDATE public.upload_sessions
            SET file_id = $3, completed_at = now()
          WHERE organization_id = $1 AND id = $2`,
        [session.organizationId, upload.id, entry.id],
      ),
    );
    return toEntry(entry, await this.files.effectiveAt(session, share.id, entry.id));
  }

  /**
   * "Değiştir"in ilk yarısı: adı tutan dosyayı boş bir ada taşıyıp çöpe atar.
   *
   * İKİ ADIM, ve sırası önemli. Çöpe atmak diskte hiçbir şeyi taşımıyor — yalnız satıra bir
   * damga yazıyor — yani ad çöpe atıldıktan sonra da dolu kalır ve yayımlama yine reddedilirdi.
   * Önce taşımak, adı gerçekten serbest bırakan tek adım.
   *
   * Park edilen satırın kimliğini döndürüyor: yayım düşerse `unpark` onu geri getiriyor.
   */
  private async moveExistingToTrash(
    session: { organizationId: string; userId: string },
    upload: SessionRow,
    share: { id: string; name: string },
    correlationId: string,
  ): Promise<string | null> {
    const existing = await this.copies.entryNamed(
      session.organizationId,
      share.id,
      upload.parent_id,
      upload.filename,
    );
    // ADI TUTAN SATIR YOKSA YAPACAK BİR ŞEY DE YOK: ad diskte SMB'den açılmış bir dosyanın
    // elinde olabilir, ve o durumda yayımlama yine reddediliyor — ama kullanıcıya söylenen cümle
    // "böyle bir dosya var" olmaya devam ediyor, sessiz bir başarı değil.
    if (existing === null) return null;

    const parked = await this.copies.freeName(
      session.organizationId,
      upload.share_id,
      upload.parent_id,
      upload.filename,
    );
    await this.files
      .rename(
        session.organizationId,
        existing.id,
        parked,
        share,
        session.userId,
        correlationId,
        existing.trashed
          ? `parking the binned ${upload.filename} so the name is free`
          : `parking the replaced ${upload.filename}`,
        // Çöpteki bir satırı park etmek için: dosya diskte adı tutuyor ve onu bırakmasının tek
        // yolu yeniden adlandırmak. Çöpten çıkmıyor, kurtarılabilir kalıyor.
        existing.trashed,
      )
      .catch((error: unknown) => {
        throw translate(error);
      });
    // ZATEN ÇÖPTEYSE İKİNCİ KEZ ÇÖPE ATILMIYOR: `trash` çöpteki bir satırı bulamaz ve bulsa da
    // atacağı yer aynı yer. Kullanıcı onu zaten silmişti; burada değişen tek şey adı.
    if (!existing.trashed) {
      await this.files.trash(session.organizationId, existing.id, session.userId);
    }
    return existing.id;
  }

  /**
   * Parkı geri alır: satır çöpten çıkıyor ve eski adına dönüyor.
   *
   * SESSİZ, ve bilerek. Bu yol yalnız yayım zaten düşmüşken koşuyor, ve çağıranın kullanıcıya
   * söyleyeceği cümle yayımın kendi hatası. Geri alma da düşerse — adı bu arada ağ sürücüsünden
   * başka bir dosya kapmış olabilir — dosya çöpte, park adıyla, geri alınabilir hâlde duruyor;
   * kaybolmuş değil. Kaydedilen satır, bunu elle çözecek kişinin ihtiyacı olan şey.
   */
  private async unpark(
    session: { organizationId: string; userId: string },
    upload: SessionRow,
    share: { id: string; name: string },
    parkedId: string | null,
    correlationId: string,
  ): Promise<void> {
    if (parkedId === null) return;
    try {
      // Çöpten önce çıkıyor: `rename` çöpteki bir satırı bulunamamış sayıyor.
      await this.files.restore(session.organizationId, parkedId);
      await this.files.rename(
        session.organizationId,
        parkedId,
        upload.filename,
        share,
        session.userId,
        correlationId,
        `restoring ${upload.filename} after a failed replace`,
      );
    } catch (error) {
      this.logger.error(
        `could not put '${upload.filename}' back after a failed replace in ${share.name}: ` +
          `${error instanceof Error ? error.message : String(error)}. The file is in the bin ` +
          'under its parked name.',
      );
    }
  }

  // §8's `Idempotency-Key`, on the route the contract declares it on. Without a key the request
  // behaves exactly as before; with one, a client that lost the response and retried gets the
  // first answer back instead of a second upload session.
  @UseInterceptors(IdempotencyInterceptor)
  @Post()
  @HttpCode(201)
  async create(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Headers('upload-length') uploadLength?: string,
    @Headers('upload-metadata') uploadMetadata?: string,
  ): Promise<void> {
    const session = requireSession(request);
    this.requireAgent();

    const length = Number.parseInt(uploadLength ?? '', 10);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new BadRequestException('Upload-Length must be a non-negative integer');
    }
    const metadata = parseUploadMetadata(uploadMetadata ?? '');
    const filename = metadata.get('filename');
    if (filename === undefined) {
      throw new BadRequestException('Upload-Metadata must carry a filename');
    }
    try {
      assertValidName(filename);
    } catch (error) {
      throw translate(error);
    }

    const parentId = metadata.get('parentId') ?? null;
    // The tus metadata header is caller-supplied text, so this id gets the same treatment every
    // path parameter gets. Without it a `parentId` that is not a uuid reaches `id = $2` against a
    // `uuid` column, comes back as SQLSTATE 22P02 that nothing maps, and surfaces as a 500 — an
    // answer that also distinguishes a malformed id from a well-formed one naming another tenant's
    // folder, which is the distinction RLS exists to erase.
    if (parentId !== null) requireUuid(parentId);
    // ── KÖKE YÜKLEMEDE PAYLAŞIM ──────────────────────────────────────────────────────────────
    //
    // Bir üst klasör varsa paylaşımı O belirliyor; kökte belirleyen hiçbir şey yoktu ve burası
    // kiracının VARSAYILAN — yani ilk oluşturulan — paylaşımını seçiyordu. Ekranda "Arşiv" seçili
    // olsa bile kökte bırakılan dosyanın bütün baytları başka bir paylaşıma iniyor, yükleme çubuğu
    // %100 oluyor ve dosya açık olan listede hiç görünmüyordu. `POST /files/folders` `shareId`i
    // zaten alıyor (`files.controller.ts`); eksik olan tek yol yüklemeydi.
    const shareId = metadata.get('shareId') ?? null;
    if (shareId !== null) requireUuid(shareId);
    const share = await this.shareFor(session.organizationId, parentId, shareId).catch(
      (e: unknown) => {
        throw translate(e);
      },
    );
    if (parentId !== null) {
      const parent = await this.files.find(session.organizationId, parentId).catch((e: unknown) => {
        throw translate(e);
      });
      if (parent.kind !== 'folder' || parent.trashed_at !== null) throw new NotFoundException();
    }

    // §6.2 is checked HERE and not on each chunk. This is where the destination is chosen and
    // where nothing has been transferred yet, so a refusal costs the client one request; a check
    // on the final PATCH would kill an upload after its last byte had already crossed the wire.
    // What that trades away is the case of a grant revoked mid-upload, which lands the file and
    // leaves it to be removed afterwards — the same window every long-running write has.
    requirePermission(
      await this.files.effectiveAt(session, share.id, parentId),
      'create',
      parentId !== null,
    );
    requireWritableShare(share);

    // ── YER VAR MI, DAHA İLK İSTEKTE ─────────────────────────────────────────────────────────
    //
    // §5.4: sunucu kotayı ve boş alanı BAŞLAMADAN denetler. Buraya kadar tek denetim yazma
    // sırasındaydı: 40 GB'lık bir dosyayı 6 GB boşu kalmış bir paylaşıma sürükleyen kullanıcı
    // yükleme çubuğunun ilerlediğini görüyor, saatler sonra %15'te 507 alıyor ve yarım dosya yirmi
    // dört saat ara alanda yer kaplıyordu.
    //
    // BİR NEZAKET, GARANTİ DEĞİL — kopyalama yolundaki ölçümün aynısı (`CopyService.available
    // Bytes`): başka bir yükleme cevapla yazma arasında yeri alabilir, ajan da dolu havuzu kendi
    // cevabıyla sınıflandırmaya devam ediyor. `null`, ajanın söyleyemediği durum: o zaman eski
    // davranış sürüyor.
    const available = await this.copies.availableBytes(
      share.dataset,
      `space check before staging ${length} bytes`,
    );
    if (available !== null && length > available) {
      throw new ProblemException(
        'insufficient-storage',
        `Bu dosya ${formatBytes(length)} yer istiyor; havuzda ${formatBytes(available)} boş.`,
      );
    }

    // The staging name comes from a fresh uuid, not from the filename. Two people uploading
    // `report.pdf` into different folders share one staging directory, and a name collision there
    // would make the agent refuse the second upload for a reason the user could not act on.
    const stagingName = `${randomUUID()}.part`;

    const rows = await this.db.withTenant(session.organizationId, (db) =>
      db.query<{ id: string }>(
        `INSERT INTO public.upload_sessions
           (organization_id, share_id, parent_id, created_by, filename, staging_name, length_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [session.organizationId, share.id, parentId, session.userId, filename, stagingName, length],
      ),
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('the upload session was not created');

    // ── SIFIR BAYTLIK DOSYA BURADA BİTİYOR ───────────────────────────────────────────────────
    //
    // Yayımlama son PATCH'in içinde tetikleniyor, ve sıfır uzunluklu bir oturuma hiç PATCH
    // giremiyor: `sendChunk` sıfır uzunluklu bir parçayı reddediyor, tarayıcı da `offset < size`
    // döngüsüne hiç girmiyor. Sonuç, boş bir `notlar.txt` ya da `.gitkeep` sürükleyen kullanıcının
    // %100 ve hatasız bir yükleme görmesi, klasörde ise hiçbir şey olmamasıydı — oturum da
    // yirmi dört saat "takılmış" olarak aktarım listesinde duruyordu.
    if (length === 0) {
      await this.publishEmpty(session, id, share, parentId, filename, stagingName);
    }

    response.setHeader('Location', `/api/v1/uploads/${id}`);
    response.setHeader('Upload-Offset', '0');
  }

  /**
   * Sıfır baytlık bir yüklemeyi tek istekte bitirir.
   *
   * ÜÇ ADIM, ve üçü de gerekli. `open_transfer` ara dosyayı yaratıyor — yayımlamanın taşıyacağı
   * bir dosya olmadan `publish_transfer` "bulunamadı" diyor. Sonra jeton SIFIR baytlık bir veri
   * bağlantısıyla tüketiliyor: ajan açık her jetonu `TRANSFER_TTL` boyunca tutuyor ve o süre
   * boyunca `publish_transfer` aynı ara dosya için "hâlâ açık" diye reddediyor, yani jetonu
   * bırakmadan yayımlamak mümkün değil. En sonda olağan yayımlama ve satır.
   */
  private async publishEmpty(
    session: { organizationId: string; userId: string },
    uploadId: string,
    share: { id: string; name: string },
    parentId: string | null,
    filename: string,
    stagingName: string,
  ): Promise<void> {
    const correlationId = randomUUID();
    const opened = await this.openTransfer(
      share.name,
      stagingName,
      `staging the empty ${filename}`,
      correlationId,
    );
    await this.data
      .send(opened.token, opened.offset, 0, Readable.from([]))
      .catch((error: unknown) => {
        throw translate(error);
      });

    const uid = await this.posix
      .posixUidFor(session.organizationId, session.userId)
      .catch((error: unknown) => {
        throw translate(error);
      });
    const destination =
      parentId === null
        ? [filename]
        : [...(await this.files.componentsOf(session.organizationId, parentId)), filename];

    const bytes = await this.files
      .publish(
        share.name,
        stagingName,
        destination,
        0,
        uid,
        uid,
        correlationId,
        `publishing the empty ${filename}`,
      )
      .catch((error: unknown) => {
        throw translate(error);
      });

    const entry = await this.files
      .recordPublishedFile(session.organizationId, share.id, parentId, filename, bytes, null)
      .catch((error: unknown) => {
        throw translate(error);
      });

    await this.db.withTenant(session.organizationId, (db) =>
      db.query(
        `UPDATE public.upload_sessions
            SET file_id = $3, completed_at = now()
          WHERE organization_id = $1 AND id = $2`,
        [session.organizationId, uploadId, entry.id],
      ),
    );
  }

  @Head(':uploadId')
  @HttpCode(200)
  async status(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Param('uploadId') uploadId: string,
  ): Promise<void> {
    const session = requireSession(request);
    const upload = await this.loadSession(session.organizationId, session.userId, uploadId);
    response.setHeader('Upload-Offset', upload.offset_bytes);
    response.setHeader('Upload-Length', upload.length_bytes);
    // tus requires this on every response, and a client that does not see it falls back to a
    // non-resumable POST — silently turning a resumable upload into one that restarts from zero.
    response.setHeader('Tus-Resumable', '1.0.0');
  }

  @Patch(':uploadId')
  @HttpCode(204)
  async sendChunk(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Param('uploadId') uploadId: string,
    @Headers('upload-offset') uploadOffset?: string,
    @Headers('content-length') contentLength?: string,
    @Headers('upload-checksum') uploadChecksum?: string,
  ): Promise<void> {
    const session = requireSession(request);
    this.requireAgent();
    const upload = await this.loadSession(session.organizationId, session.userId, uploadId);
    if (upload.file_id !== null) throw new ConflictException('this upload is already complete');

    const offset = Number.parseInt(uploadOffset ?? '', 10);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new BadRequestException('Upload-Offset must be a non-negative integer');
    }
    if (offset !== Number(upload.offset_bytes)) {
      // 409 is what tus specifies for a mismatch, and the current offset goes with it so the
      // client can resume without a second round trip.
      response.setHeader('Upload-Offset', upload.offset_bytes);
      throw new ConflictException(
        `the upload is at ${upload.offset_bytes}, the request declared ${offset}`,
      );
    }

    // A declared length, not "whatever arrives". The agent reads exactly this many bytes; a
    // request without Content-Length cannot be framed and is refused rather than guessed at.
    const chunkLength = Number.parseInt(contentLength ?? '', 10);
    if (!Number.isSafeInteger(chunkLength) || chunkLength <= 0) {
      throw new BadRequestException('Content-Length is required and must be positive');
    }
    if (offset + chunkLength > Number(upload.length_bytes)) {
      throw new BadRequestException(
        `this chunk would take the upload past the declared ${upload.length_bytes} bytes`,
      );
    }

    // The share the SESSION was opened against, and read from the session's OWN column rather than
    // re-derived from the destination folder: a chunk has to be staged in the same tree its
    // `OpenTransfer` resolved, or the publish at the end has nothing to move. Re-deriving gives the
    // tenant's default share for a root-level upload, which is a different tree the moment the
    // caller named a share at `POST /uploads`.
    const share = await this.files
      .shareFor(session.organizationId, upload.share_id)
      .catch((e: unknown) => {
        throw translate(e);
      });
    // İkinci kapı: paylaşım yükleme başladıktan sonra salt okunura çevrilmiş olabilir, ve bir
    // sonraki parça yine de diske yazılırdı.
    requireWritableShare(share);
    const correlationId = randomUUID();

    // Two connections, in this order. The control call resolves the staging file under
    // openat2(RESOLVE_BENEATH) and hands back a one-time token; the data connection presents that
    // token and streams. Nothing on the data socket names a path, so it cannot reach anything the
    // control call did not already confine (ADR-0017).
    const opened = await this.openTransfer(
      share.name,
      upload.staging_name,
      `tus PATCH for ${upload.filename}`,
      correlationId,
    );

    if (opened.offset !== offset) {
      // The FILE disagreed with the cache. The agent is right; correct the cache and make the
      // client retry rather than writing at an offset nobody agrees on.
      await this.setOffset(session.organizationId, upload.id, opened.offset);
      response.setHeader('Upload-Offset', String(opened.offset));
      throw new ConflictException(
        `the staged file is at ${opened.offset}, not ${offset}; resume from there`,
      );
    }

    // Parsed BEFORE a byte is forwarded. A malformed header discovered after the chunk is on
    // disk would mean refusing an upload for a client mistake that cost the appliance the write.
    const expected = parseChecksum(uploadChecksum);
    const digest = expected === null ? undefined : createHash('sha256');

    let stored: number;
    try {
      stored = await this.data.send(opened.token, opened.offset, chunkLength, request, digest);
    } catch (error) {
      if (error instanceof AgentOutOfSpaceError) {
        // 507, not 500. ADR-0008: a full dataset is a permanent condition the client must not
        // retry, and a 500 is exactly what a client retries.
        throw new InsufficientStorageException(error.agentReason);
      }
      // Geri kalanı `translate`den geçiyor: veri soketi hiç açılamadıysa `AgentUnavailableError`
      // bir `HttpException` olmadığı için 500'e düşüyordu — "beklenmeyen bir hata", oysa söylenecek
      // şey ajanın ulaşılamaz olduğu.
      throw translate(error);
    }

    if (expected !== null && digest !== undefined) {
      const actual = digest.digest();
      if (!timingSafeEqualBuffers(actual, expected)) {
        // ── BOZUK PARÇA ARA DOSYADAN ATILIYOR ───────────────────────────────────────────────
        //
        // Eskiden burada yalnız kaydedilen ofset ilerletilmiyordu, ve yanındaki yorum bunu
        // "parça üzerine yazılarak atılıyor" diye anlatıyordu. Öyle değil: ajan ara dosyayı
        // `Append` açıyor ve veri kanalı `start != preamble.offset` olan her bağlantıyı
        // reddediyor, yani bir bölgenin üzerine yazmak MÜMKÜN DEĞİL. Baytlar diske yazılıp
        // `fsync` edilmiş oluyor; bir sonraki PATCH'te `open_transfer` dosyayı `seek(End)` ile
        // ölçüyor, aşağıdaki 409 istemciye bozuk parçanın SONRASINDAN devam etmesini söylüyor ve
        // yükleme, ortasında bozuk bir bölgeyle, hatasız "tamamlanıyordu".
        //
        // Ajanın kesme (truncate) işlemi yok — `DiscardTransfer`in kendi belgesi de "her başarısız
        // sağlama" için yazıldığını söylüyor — o yüzden tek doğru cevap ara dosyayı atıp oturumu
        // sıfırdan başlatmak. Pahalı: on gigabaytlık bir yükleme baştan gidiyor. Ama alternatifi
        // sessizce bozulmuş bir dosya, ve sessiz bozulma her zaman daha pahalı.
        const discarded = await this.agent
          .call(
            { op: 'discard_transfer', share: share.name, staging_name: upload.staging_name },
            `discarding ${upload.filename} after a checksum mismatch`,
            correlationId,
          )
          .catch(() => ({ status: 'unreachable' }) as const);
        if (discarded.status !== 'discarded') {
          this.logger.error(
            `could not discard '${upload.staging_name}' after a checksum mismatch: ` +
              `${discarded.status}. The staged file still holds the corrupt region.`,
          );
          throw new ProblemException(
            'dependency-unavailable',
            'Gönderilen parçanın sha256 özeti uyuşmadı ve bozuk parça ara dosyadan ' +
              'temizlenemedi. Bu yüklemeyi iptal edip yeniden başlatın.',
          );
        }
        await this.setOffset(session.organizationId, upload.id, 0);
        response.setHeader('Upload-Offset', '0');
        response.setHeader('Tus-Resumable', '1.0.0');
        throw new ProblemException(
          'checksum-mismatch',
          'Gönderilen parçanın sha256 özeti Upload-Checksum ile uyuşmadı. Bozuk parça diskten ' +
            'silindi; yüklemeye baştan devam edin.',
        );
      }
    }

    const next = offset + stored;
    await this.setOffset(session.organizationId, upload.id, next);
    response.setHeader('Upload-Offset', String(next));
    response.setHeader('Tus-Resumable', '1.0.0');

    if (next < Number(upload.length_bytes)) return;

    // Complete. Publish moves the staging file into the tree with RENAME_NOREPLACE and fsyncs the
    // destination directory (ADR-0008 steps 4 and 5), and the agent checks the size itself rather
    // than trusting this process's belief that the upload finished.
    // The parent's components, then the name. An earlier version published `[filename]` alone,
    // which put every upload at the share root no matter which folder the user chose — and the
    // probe missed it because its check fell back to the root path with a `||`. The file landed,
    // the listing looked right, and the download 404'd.
    const destination =
      upload.parent_id === null
        ? [upload.filename]
        : [
            ...(await this.files.componentsOf(session.organizationId, upload.parent_id)),
            upload.filename,
          ];

    // The uploader's own POSIX identity, not this process's. Until now every published file was
    // owned by the API's service account, which is the state the agent's refusal of uid 0 was
    // written to make impossible and the mode bits could not fix: a share is a tenant's, and a
    // file inside it that the tenant does not own is one they cannot chmod, cannot delete over
    // SMB, and cannot be given a quota for. `PosixIdentityService` allocates on first need, so an
    // account created before migration 0015 gets its uid here.
    //
    // The gid is the same number. See `FilesService.createFolder`: uids and team gids come from
    // one counter, so a user's own id is a group nothing else holds, and ADR-0004 gives team
    // access through the POSIX ACL rather than through the owning group.
    const uid = await this.posix
      .posixUidFor(session.organizationId, session.userId)
      .catch((error: unknown) => {
        throw translate(error);
      });

    // ── ÇEVRİLİYOR, ve bu bir incelik değil ────────────────────────────────────────────────
    //
    // Ajan aynı adda bir dosya bulduğunda `RENAME_NOREPLACE` ile reddediyor — doğru davranış,
    // ADR-0008. Ama bu çağrı, hemen üstündeki `posixUidFor` ve hemen altındaki
    // `recordPublishedFile`ın aksine `translate` ile sarılı DEĞİLDİ: ret bir HttpException
    // olmadığı için 500'e dönüşüyordu. Kullanıcının gördüğü şey, bütün baytları yükledikten
    // sonra "beklenmeyen bir hata"ydı ve ne olduğunu söyleyen hiçbir cümle yoktu.
    const bytes = await this.files
      .publish(
        share.name,
        upload.staging_name,
        destination,
        Number(upload.length_bytes),
        uid,
        uid,
        correlationId,
        `publishing ${upload.filename}`,
      )
      .catch((error: unknown) => {
        throw translate(error);
      });

    const entry = await this.files
      .recordPublishedFile(
        session.organizationId,
        upload.share_id,
        upload.parent_id,
        upload.filename,
        bytes,
        null,
      )
      .catch((error: unknown) => {
        throw translate(error);
      });

    await this.db.withTenant(session.organizationId, (db) =>
      db.query(
        `UPDATE public.upload_sessions
            SET file_id = $3, completed_at = now(), offset_bytes = $4
          WHERE organization_id = $1 AND id = $2`,
        [session.organizationId, upload.id, entry.id, next],
      ),
    );
  }

  private async setOffset(organizationId: string, id: string, offset: number): Promise<void> {
    await this.db.withTenant(organizationId, (db) =>
      db.query(
        // `updated_at` moves with the offset. It is what the event stream's watermark compares
        // against, so without it a chunk arriving would advance the upload and tell nobody — the
        // transfers panel would sit at whatever it last polled.
        `UPDATE public.upload_sessions SET offset_bytes = $3, updated_at = now()
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, id, offset],
      ),
    );
  }

  /**
   * One upload session, belonging to THIS caller.
   *
   * `created_by` is in the predicate, and that is the authorization for both routes that take an
   * upload id. §6.2 is resolved once, at POST, against the folder the session names — a trade the
   * comment on `create` explains — and that trade only holds if the account driving the chunks is
   * the account the check was made for. Without this clause any member of the tenant holding an
   * upload id could finish somebody else's transfer: `sendChunk` publishes into `upload.parent_id`,
   * a folder they may have no `create` on, and stamps the file with THEIR posix uid. The ids are
   * uuidv7 and not guessable, but `GET /transfers` hands an organisation administrator every
   * session in the tenant, so "unguessable" was never the whole answer.
   *
   * A session belonging to someone else is therefore 404 rather than 403 — the same answer as one
   * that does not exist, because an upload id is not something one member should be able to
   * confirm about another.
   */
  private async loadSession(
    organizationId: string,
    userId: string,
    id: string,
  ): Promise<SessionRow> {
    // The same validator every other id path uses, rather than a hand-rolled shape test. The old
    // one accepted thirty-six hyphens and passed them to the same `uuid` cast.
    requireUuid(id);
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<SessionRow>(
        `SELECT id, share_id, parent_id, filename, staging_name, length_bytes, offset_bytes, file_id
           FROM public.upload_sessions
          WHERE organization_id = $1 AND id = $2 AND created_by = $3`,
        [organizationId, id, userId],
      ),
    );
    const row = rows[0];
    if (!row) throw new NotFoundException();
    return row;
  }

  /**
   * The share an upload lands in.
   *
   * From the DESTINATION FOLDER when there is one, and the tenant's default only for an upload
   * aimed at a share root. Resolving the default unconditionally is what made every share created
   * after the first one unwritable: the parent lived in share B and the staging file was opened
   * under share A, so the publish either failed or landed in the wrong tree.
   */
  private async shareFor(
    organizationId: string,
    parentId: string | null,
    shareId: string | null = null,
    // Tam SATIR: `read_only` ve `dataset` de gerekiyor — biri yazma kapısı, öteki boş alan
    // ölçümü için.
  ): Promise<ShareRow> {
    if (parentId !== null) {
      const parent = await this.files.find(organizationId, parentId);
      return this.files.shareFor(organizationId, parent.share_id);
    }
    // Kökteki bir yükleme için paylaşımı çağıran söylüyor. Söylemediyse varsayılan — tek
    // paylaşımlı bir cihazda ve `shareId` göndermeyen eski bir istemcide davranış değişmiyor.
    if (shareId !== null) return this.files.shareFor(organizationId, shareId);
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ slug: string }>(`SELECT slug FROM public.organizations WHERE id = $1`, [
        organizationId,
      ]),
    );
    const slug = rows[0]?.slug;
    if (slug === undefined) throw new NotFoundException();
    return this.files.defaultShare(organizationId, slug);
  }

  /**
   * Veri soketi YAPILANDIRILMIŞ mı — ajan şu anda ayakta mı DEĞİL.
   *
   * `agent.isAvailable()` buradan kalktı ve gerekçesi, kod tabanının aynı tuzağı üç yerde daha
   * kaldırırken yazdığı gerekçenin aynısı (`shares.service.ts`, `permissions.service.ts`,
   * `teams.service.ts`): o bayrak yalnız `onModuleInit`te bir kez `true` oluyor ve bir daha
   * DEĞERLENDİRİLMİYOR. Açılışta ajan geç yetişirse — havuz içe aktarması el sıkışma bütçesini
   * aşarsa — bayrak kalıcı olarak `false` kalıyor ve ajan bir dakika sonra tamamen sağlıklı hâle
   * gelse bile cihaza web'den hiçbir dosya yüklenemiyordu; tek çıkış API'yi yeniden başlatmaktı.
   *
   * Ajan gerçekten ulaşılamazsa cevap yine 503: `open_transfer` çağrısı `AgentUnavailableError`
   * fırlatıyor ve `translate` onu 503'e çeviriyor — bu yüzden o çağrı artık `translate` ile sarılı.
   */
  private requireAgent(): void {
    if (!this.data.isAvailable()) {
      throw new ServiceUnavailableException(
        'the system agent is not reachable; uploads are unavailable',
      );
    }
  }

  /**
   * Ara dosyayı açar ve jetonu döndürür — hatası kullanıcının görebileceği bir cevaba çevrilmiş
   * olarak.
   *
   * `translate` olmadan `AgentUnavailableError` bir `HttpException` olmadığı için 500'e düşüyordu:
   * ajanın kapalı olduğunu söyleyen 503 yerine "beklenmeyen bir hata". Ajanın reddi de aynı yoldan
   * 409 oluyor.
   */
  private async openTransfer(
    shareName: string,
    stagingName: string,
    reason: string,
    correlationId: string,
  ): Promise<{ token: string; offset: number }> {
    try {
      const response = await this.agent.call(
        { op: 'open_transfer', share: shareName, staging_name: stagingName },
        reason,
        correlationId,
      );
      return expectStatus(response, 'transfer');
    } catch (error) {
      throw translate(error);
    }
  }
}

/** 507, which Nest has no built-in exception for. */
class InsufficientStorageException extends ConflictException {
  constructor(reason: string) {
    super(reason);
    this.name = 'InsufficientStorageException';
    Object.defineProperty(this, 'status', { value: 507 });
  }
  override getStatus(): number {
    return 507;
  }
}

/**
 * tus `Upload-Metadata`: comma-separated `key base64value` pairs.
 *
 * A key with no value is legal in tus and means the empty string; a key that is not valid base64
 * is not, and is dropped rather than half-decoded — `Buffer.from` is lenient and would otherwise
 * turn a corrupt filename into a plausible one.
 */
export function parseUploadMetadata(header: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of header.split(',')) {
    const trimmed = pair.trim();
    if (trimmed === '') continue;
    const space = trimmed.indexOf(' ');
    if (space < 0) {
      out.set(trimmed, '');
      continue;
    }
    const key = trimmed.slice(0, space);
    const encoded = trimmed.slice(space + 1).trim();
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) continue;
    out.set(key, decoded.toString('utf8'));
  }
  return out;
}

/**
 * `Upload-Checksum: sha256 <base64>`, or nothing.
 *
 * The tus checksum extension's format: an algorithm name, a space, and the digest in base64. Only
 * sha256 is accepted, and the contract says why — a browser's SubtleCrypto offers the SHA family
 * and nothing else, so an algorithm no client can compute would be a parameter nobody could use.
 *
 * A HEADER THAT CANNOT BE UNDERSTOOD IS REFUSED, not ignored. Ignoring it would mean a client that
 * misspelled the algorithm believes its uploads are being checked and they are not — the same
 * failure this whole change exists to end, one level down.
 */
export function parseChecksum(raw: string | undefined): Buffer | null {
  if (raw === undefined || raw.trim() === '') return null;

  const [algorithm, ...rest] = raw.trim().split(/\s+/);
  if (algorithm?.toLowerCase() !== 'sha256') {
    throw new ProblemException(
      'bad-request',
      'Upload-Checksum yalnız sha256 kabul ediyor: `sha256 <base64>`.',
    );
  }

  const encoded = rest.join('');
  const decoded = Buffer.from(encoded, 'base64');
  // `Buffer.from(..., 'base64')` never throws — it stops at the first character it cannot read —
  // so the length is what says the value was a digest rather than a typo.
  if (decoded.length !== 32) {
    throw new ProblemException(
      'bad-request',
      'Upload-Checksum bir sha256 özeti olmalı: 32 baytın base64 hâli.',
    );
  }
  return decoded;
}

/**
 * Constant-time comparison, for a value that is not a secret.
 *
 * Deliberate anyway: `timingSafeEqual` throws on a length mismatch, so the guard has to come
 * first, and using it everywhere a digest is compared means nobody has to decide case by case
 * which digests are secret.
 */
function timingSafeEqualBuffers(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
