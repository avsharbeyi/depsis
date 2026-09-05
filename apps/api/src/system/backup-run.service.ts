import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { AgentService, AgentUnavailableError, expectStatus } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import { BackupTargetService } from './backup-target.service.js';

/** Yedek ağacındaki iki üst dizin. Ajanda sabit olan düzenin API tarafındaki karşılığı. */
const FILES = 'Dosyalar';
const LEDGER = 'DEPSIS-YEDEK';
const DELETED = 'silinenler';

/** Ajanın bir çağrıda taşıyacağı en fazla bayt. Kontrol soketi sıralı; dilim onu paylaşıyor. */
const SLICE = 32 * 1024 * 1024;

/**
 * Bir turun kaç dosyayla uğraşacağı üst sınırı.
 *
 * Tur, ardılını kuyruğa alarak devam ediyor: sınıra takılan bir tur bitmiş sayılmıyor, hemen bir
 * ardıl kuyruğa alınıyor. Sınır olmadan, seksen bin dosyalık ilk tur worker'ı saatlerce tek bir
 * işte tutar ve o süre boyunca başka hiçbir iş koşamaz.
 */
const MAX_FILES_PER_RUN = 2_000;

/**
 * Bir dizin listelemesinin kaç sayfada bitmesinin beklendiği.
 *
 * Ajan tek yanıtta en çok 5.000 girdi veriyor ve gerisini `after` imleciyle sunuyor; kırk sayfa,
 * iki yüz bin girdilik bir dizin demek. Tavan, adı sürekli değişen bir dizinde sonsuz döngüye
 * girmemek için var — ve tavana çarpıldığında SUSULMUYOR, hata veriliyor: ilk turda atlanan bir
 * dosyanın bir daha sorulacağı yer yok.
 */
const MAX_LISTING_PAGES = 40;

/** Turun aldığı görüntülerin ön eki. Bu ön eki taşımayan hiçbir görüntüye tur dokunmuyor. */
const RUN_SNAPSHOT_PREFIX = 'depsis-yedek-';

/**
 * Silinenler ağacının kaç sil-ve-yeniden-listele turunda bitmesinin beklendiği.
 *
 * `backup_list_directory`nin sayfalama imleci YOK: tek yanıtta en çok 5.000 girdi veriyor ve
 * gerisini söylemiyor. Bir dizini boşaltmak için sıraya da ihtiyaç yok — silinen girdiler bir
 * daha listelenmiyor — yani listelemeyi yineleyerek ilerlemek yeterli. Tavan, adı sürekli
 * yeniden dolan bir dizinde sonsuz döngüye girmemek için: iki yüz tur, bir milyon girdi.
 */
const MAX_PURGE_PASSES = 200;

/**
 * Yeni kopyanın YAYIMLANDIĞI geçici adın ön eki.
 *
 * Ajanın `copy_file_to_backup`u son diliminde ara dosyayı hedefe TAŞIYARAK bitiriyor, yani
 * "yaz" ile "yayımla" API tarafından ayrılamıyor; hedefte bir dosya varsa da üstüne yazmıyor,
 * `conflict` diyor. Yeni sürüm bu yüzden önce yanındaki bu ada yayımlanıyor, eski kopya ancak
 * ondan SONRA kaldırılıyor ve son adım bir yeniden adlandırma oluyor.
 */
const TEMP_PREFIX = '.depsis-yeni-';

/**
 * Diskin neden okunamadığı — "takılı değil" ile "kilitli" AYRI iki cümle.
 *
 * Havuz içe alınmamışsa (USB'si çekilmiş bir disk, ya da açılışta takılmamış bir havuz) ajan
 * `prepared:false` diyor. Bunu "kilitli" diye kaydeden bir tur, sahibini parola girmeye
 * gönderiyordu: doğru parola da `dataset does not exist` ile düşüyor ve arızanın adı hiçbir
 * yerde "disk takılı değil" diye geçmiyordu.
 */
function whyUnavailable(status: { prepared: boolean; key_loaded: boolean }): string {
  if (!status.prepared) {
    return 'yedek havuzu bulunamadı: disk takılı değil ya da havuzu içe alınmamış';
  }
  if (!status.key_loaded) return 'yedek diski kilitli; açmak için parolanız gerekiyor';
  return 'yedek diski bağlı değil';
}

/**
 * Bir turun gerekçe metninin en fazla kaç karakter olabileceği.
 *
 * `backup_runs.error` tek bir `text` sütunu ve ekranda tek bir cümle olarak okunuyor. Tavan, tek
 * bir arızanın binlerce satırlık çıktısının kaydı okunamaz hâle getirmemesi için.
 */
const MAX_ERROR_CHARS = 2_000;

/**
 * Düşen paylaşımların gerekçelerini tek bir cümleye toplar.
 *
 * ÜZERİNE YAZMIYOR. Her arızada `total.error`ı değiştiren bir tur, üç paylaşımın bozulduğu bir
 * günde yalnız SONUNCUSUNU anlatıyordu — ve sahibinin ekranda gördüğü tek cümle o oluyordu, yani
 * ilk iki arıza hiçbir yerde yoktu.
 */
function joinFailures(failures: string[]): string {
  const joined = failures.join('; ');
  return joined.length <= MAX_ERROR_CHARS ? joined : `${joined.slice(0, MAX_ERROR_CHARS - 1)}…`;
}

/**
 * Bir turun ekrana giden özeti.
 *
 * `backup_runs` yazılıyor ama HİÇBİR YER OKUMUYORDU. Sonucu şuydu: yedek diski dolduğunda tur
 * 'yer-yok' ile düşüyor, satır tabloya giriyor, ve ekran hâlâ "Açık" ile son doğrulamanın dünkü
 * cümlesini gösteriyordu — arızanın tek izi worker günlüğü, yani sahibinin hiç bakmayacağı yer.
 * 0044'ün tabloyu açarken yazdığı gerekçe ("ekranın son tur ne yaptı cümlesi") ancak bir okuyucu
 * varsa duruyor.
 */
export interface BackupRunSummary {
  trigger: 'zamanli' | 'elle';
  state: 'calisiyor' | 'bitti' | 'dustu' | 'kilitli' | 'yer-yok';
  copiedFiles: number;
  copiedBytes: number;
  movedFiles: number;
  purgedFiles: number;
  /** Ajanın ya da turun kendi cümlesi — kullanıcıya AYNEN gösteriliyor. */
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface RunOutcome {
  state: 'bitti' | 'kilitli' | 'yer-yok' | 'dustu' | 'devam';
  copiedFiles: number;
  copiedBytes: number;
  movedFiles: number;
  error?: string;
}

interface ShareRow {
  id: string;
  name: string;
  dataset: string;
}

/**
 * Altı saatlik tur: değişeni kopyala, sileni tarih klasörüne taşı.
 *
 * ── TUR CANLI AĞACI DEĞİL, BİR ANI OKUYOR ────────────────────────────────────────────────────
 *
 * Her paylaşım için önce bir anlık görüntü alınıyor ve NEYİN değiştiği ondan okunuyor. Tur
 * saatler sürebilir; canlı ağacı okuyan bir tur, kendi çalışırken değişen dosyaları yarım
 * kopyalar ve hangi anı yedeklediğini söyleyemez.
 *
 * BAYTLAR HÂLÂ CANLI AĞAÇTAN OKUNUYOR, ve bu bilinen bir eksik: `copy_file_to_backup` ajanın
 * paylaşım kökünden okuyor, `.zfs/snapshot/<ad>` altından değil. Kopyalanırken değişen bir dosya
 * bu yüzden görüntüdeki hâliyle yedeklenmiyor. Bunu kapatmak ajanın işlem kümesinde bir
 * değişiklik istiyor (görüntüden okuyan bir kopyalama ve karşılaştırma), yani burada tek başına
 * düzeltilemiyor. Günlük doğrulamanın aynı sebeple ürettiği YANLIŞ ALARM ise kapatıldı:
 * `verifyOnce` boyutu tutmayan bir farkı "bozuk" değil "ölçülemedi" sayıyor.
 *
 * ── DEĞİŞİKLİK LİSTESİ, DİZİN YÜRÜYÜŞÜ DEĞİL ─────────────────────────────────────────────────
 *
 * Bir önceki turun görüntüsüyle karşılaştırma tek çağrıda geliyor. Bir milyon dosyalı bir ağaçta
 * bile hiçbir dizin yürünmüyor — altı saatlik ritmin ucuz olmasının tek sebebi bu.
 *
 * Liste KESİLDİYSE taban düşürülüyor ve bir sonraki tur baştan yürüyor. Kesilmiş bir değişiklik
 * listesini kullanmak, yedeklenmeyen dosyalar demek.
 *
 * ── TABAN BAŞARISIZLIKTA DÜŞÜRÜLMÜYOR ────────────────────────────────────────────────────────
 *
 * Eski çoğaltma kodu tam bunu yapıyordu: bir tur düştüğünde tabanı boşaltıyor, ertesi tur her
 * şeyi baştan gönderiyor, o da düşüyor, ve döngü hiçbir zaman yedek üretmiyordu. Düşen bir tur,
 * bir önceki turun bıraktığı sağlam tabanı bozmuyor.
 */
@Injectable()
export class BackupRunService {
  private readonly logger = new Logger(BackupRunService.name);

  constructor(
    private readonly db: DbService,
    private readonly agent: AgentService,
    private readonly targets: BackupTargetService,
  ) {}

  /**
   * Bir tur.
   *
   * DİSK KİLİTLİYSE TUR KOŞMUYOR ve bu bir hata değil: parola hiçbir yere yazılmıyor, yani cihaz
   * her açıldığında disk kilitli oluyor. `kilitli` kendi durumu, çünkü kullanıcının yapacağı şey
   * farklı — bir parola girmek — ve "düştü" demek onu bir arıza aramaya gönderirdi.
   */
  async runOnce(organizationId: string, trigger: 'zamanli' | 'elle'): Promise<RunOutcome> {
    const correlationId = randomUUID();
    const target = await this.targets.row(organizationId);
    if (target === null || !target.enabled) {
      return { state: 'bitti', copiedFiles: 0, copiedBytes: 0, movedFiles: 0 };
    }

    const status = expectStatus(
      await this.agent.call(
        { op: 'backup_root_status', pool: target.pool },
        `yedek turu: diskin durumu (${target.pool})`,
        correlationId,
      ),
      'backup_root',
    );
    if (!status.prepared || !status.key_loaded || !status.mounted) {
      // DURUM 'kilitli' KALIYOR ama SEBEP YAZILIYOR. Yeni bir durum eklemek kaydı okuyan hiçbir
      // şeyi değiştirmezdi; eksik olan, sahibinin okuyacağı cümlenin "parolanızı girin" yerine
      // "disk takılı değil" diyebilmesiydi.
      const outcome: RunOutcome = {
        state: 'kilitli',
        copiedFiles: 0,
        copiedBytes: 0,
        movedFiles: 0,
        error: whyUnavailable(status),
      };
      // ── AYNI CÜMLE İKİNCİ KEZ YAZILMIYOR ───────────────────────────────────────────────────
      //
      // Sahibin kuralı: yedekleme yalnız yedek diski varsa çalışır. Fişi çekilmiş bir diskte tur
      // yine de üç saatte bir koşuyor ve her turda AYNI satırı yazıyordu: sahada dört günde
      // birbirinin kopyası otuz iki satır, ve tur geçmişi ekranı bunlarla doluyordu — yani
      // yedekleme "çalışıyor" gibi görünüyordu, hem de hiçbir dosya kopyalamadan.
      //
      // İlki YAZILIYOR: sahibinin diskin ne zaman ve neden düştüğünü görmesi gerekiyor. Sonra
      // sebep değişene ya da tur gerçekten koşana kadar sessizlik. Elle başlatılan tur bunun
      // dışında: düğmeye basan biri her seferinde bir cevap hak ediyor.
      const quiet =
        trigger === 'zamanli' &&
        (await this.lastRunSaidTheSame(organizationId, target.id, outcome));
      if (!quiet) await this.record(organizationId, target.id, trigger, outcome);
      return outcome;
    }
    // KURTARMA KİPİ: disk başka bir cihazın yedeği. Yazmak, o cihazın yedeğini bu cihaza göre
    // "düzeltmek" olurdu — yani yeni cihazda henüz olmayan her şeyi silinmiş saymak.
    if (target.recoveryOnly) {
      return { state: 'bitti', copiedFiles: 0, copiedBytes: 0, movedFiles: 0 };
    }

    // Paylaşım kökü DOĞRUDAN ajandan soruluyor, `SystemService` üzerinden değil. O servis
    // `SystemModule`de yaşıyor ve o modül beş denetleyici bildiriyor; worker'ın kökü onu alamaz
    // (`worker-surface.ts` HTTP katmanını bilerek dışarıda tutuyor). Tek bir çağrı için bütün
    // bir kimlik doğrulama akışını worker'a taşımak yanlış takas olurdu.
    const rootStatus = expectStatus(
      await this.agent.call(
        { op: 'share_root_status' },
        'yedek turu: paylaşımlar nerede',
        correlationId,
      ),
      'share_root',
    );
    if (rootStatus.path === null) {
      return { state: 'bitti', copiedFiles: 0, copiedBytes: 0, movedFiles: 0 };
    }

    const shares = await this.db.withTenant(organizationId, (q) =>
      q.query<ShareRow>(`SELECT id::text AS id, name, dataset FROM public.shares ORDER BY name`),
    );

    const total: RunOutcome = { state: 'bitti', copiedFiles: 0, copiedBytes: 0, movedFiles: 0 };
    const today = new Date().toISOString().slice(0, 10);

    // BİR PAYLAŞIMIN DÜŞMESİ, TURUN DÜŞMESİ. Bu işaret döngüden sonra hâlâ okunuyor: arızayı
    // izleyen paylaşımlardan biri "devam edecek" dediğinde turun durumu ona dönüp arızanın üstünü
    // örtmesin diye.
    let failure: string | null = null;
    /** Düşen her paylaşımın gerekçesi, ADIYLA birlikte. Kayda hepsi birden giriyor. */
    const failures: string[] = [];

    for (const share of shares) {
      if (total.copiedFiles >= MAX_FILES_PER_RUN) {
        // BİTMEDİ, DEVAM EDECEK. Ardılı kuyruğa alan taraf işleyici; burada söylenen tek şey
        // turun kapanmadığı.
        if (failure === null) total.state = 'devam';
        break;
      }
      try {
        const done = await this.runShare(
          organizationId,
          share,
          `${rootStatus.path}/${share.name}`,
          today,
          total,
          correlationId,
        );
        if (!done && failure === null) total.state = 'devam';
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // YER YOK, kendi durumu: kullanıcının yapacağı şey farklı (disk değiştirmek ya da
        // saklama süresini kısaltmak) ve yeniden denemek dolu diske yarım dosyalar park etmekten
        // başka bir şey yapmaz.
        const outOfSpace = reason.includes('yer yok') || reason.includes('yer kalmadı');
        failure = reason;
        failures.push(`${share.name}: ${reason}`);
        total.state = outOfSpace ? 'yer-yok' : 'dustu';
        total.error = joinFailures(failures);
        this.logger.warn(`yedek turu '${share.name}' üzerinde düştü: ${reason}`);
        // ARIZALI PAYLAŞIM SIRADAKİLERİ YEDEKSİZ BIRAKMIYOR. Paylaşımlar ada göre sıralı geliyor,
        // yani buradaki `break` 'Fotograflar' bozulduğunda 'Videolar'ı da her turda sıraya
        // sokmuyordu — ve düzelene kadar o paylaşımın hiçbir dosyası yedeğe girmiyordu.
        //
        // 'yer yok' ayrı ve turu gerçekten bitiriyor: dolu bir diske sıradaki paylaşımı yazmayı
        // denemek, yarım dosyalar park etmekten başka bir şey yapmaz.
        if (outOfSpace) break;
        // AJANIN SUSMASI DA TURU BİTİRİYOR, ve bu paylaşıma özgü bir arıza değil: soket
        // gittiyse sıradaki paylaşım da aynı yerde düşecek. Devam etmek, kayda aynı cümlenin
        // paylaşım sayısı kadar kopyasını yazmaktan başka bir şey yapmaz.
        if (error instanceof AgentUnavailableError) break;
      }
    }

    // EN SON KOPYALANAN DOSYA satıra yazılıyor — günlük doğrulamanın okuyacağı dosya. Tur
    // sonunda bir kez: her dosyada bir UPDATE, doğrulamanın maliyetini yedeklemenin kendisine
    // yüklerdi. Bu turda hiç dosya kopyalanmadıysa eskisi olduğu gibi kalıyor, çünkü o dosya hâlâ
    // yedekte duruyor ve hâlâ okunabilir olmalı.
    if (this.lastCopied !== null) {
      const copied = this.lastCopied;
      this.lastCopied = null;
      await this.db.withTenant(organizationId, (q) =>
        q.query(
          `UPDATE public.backup_targets
              SET last_copied_share = $2, last_copied_path = $3
            WHERE id = $1::uuid`,
          [target.id, copied.share, copied.path],
        ),
      );
    }

    await this.record(organizationId, target.id, trigger, total);
    // DİSKİN "SON YEDEK" TARİHİ TAZELENİYOR. O tarih diskin ŞİFRESİZ yarısında duruyor ve yanmış
    // bir cihazın diskini takan kişinin ekranda göreceği ilk şey o — eskimiş bir tarih, yedeğin
    // ne kadar güncel olduğu konusunda yanlış bir cümle olurdu.
    if (total.state === 'bitti' || total.state === 'devam') {
      await this.targets.writeDiskDescription(organizationId, correlationId, new Date());
    }
    return total;
  }

  /**
   * Tek bir paylaşımın turu. `true` döndürürse bu paylaşım bitti.
   */
  private async runShare(
    organizationId: string,
    share: ShareRow,
    mountpoint: string,
    today: string,
    total: RunOutcome,
    correlationId: string,
  ): Promise<boolean> {
    const snapshot = `${RUN_SNAPSHOT_PREFIX}${Date.now()}`;
    expectStatus(
      await this.agent.call(
        { op: 'create_snapshot', dataset: share.dataset, name: snapshot },
        `yedek turu: '${share.name}' için an dondu`,
        correlationId,
      ),
      'snapshot',
    );

    const base = await this.baseOf(organizationId, share.id);

    // TABAN İLERLEMEZSE BU TURUN GÖRÜNTÜSÜ ÇÖP. Aşağıdaki her erken çıkış — kesilmiş değişiklik
    // listesi, dosya sınırı, kopyalamanın fırlattığı hata — tabanı olduğu yerde bırakıyor; o
    // görüntüye bir daha kimse bakmayacak, ama havuzda tuttuğu bloklar duruyor.
    let advanced = false;
    try {
      // GEÇMİŞ TURLARIN GÖRÜNTÜLERİ TURUN BAŞINDA SÜPÜRÜLÜYOR, sonunda değil: silinecek olan bir
      // ÖNCEKİ turun tabanı, ve o taban ancak yerine yenisi yazıldıktan sonra gereksiz. Başta
      // olması, sahada zaten birikmiş görüntülerin de ilk turda temizlenmesi demek.
      await this.sweepRunSnapshots(organizationId, share, snapshot, correlationId);

      if (base === null) {
        // İLK TUR: karşılaştırılacak bir taban yok, o yüzden ağacın TAMAMI yürünüyor.
        //
        // Bu turun kısa sürmesi beklenmiyor ve kısaltılmıyor. Yalnız tabanı yazıp geçmek —
        // yani ilk turu bir "başlangıç noktası" saymak — mevcut dosyaların HİÇBİRİNİ
        // yedeklememek demekti, ve ekranda "yedeğiniz var" yazarken diskte hiçbir şey olmayacaktı.
        // Bir yedeğin en tehlikeli hâli, olduğu sanılan ve olmayan yedektir.
        //
        // DOSYA SAYISI SINIRI BU TURDA UYGULANMIYOR. Sınır, ardılı kuyruğa alınabilen artımlı
        // turlar için var; ilk tur yarıda bırakılıp taban yazılmadan tekrarlansaydı, her seferinde
        // baştan başlayan ve hiç bitmeyen bir döngü olurdu.
        await this.walkAndCopy(share.name, [], total, correlationId);
        await this.setBase(organizationId, share.id, snapshot);
        advanced = true;
        return true;
      }

      const diff = await this.agent.call(
        { op: 'diff_snapshots', dataset: share.dataset, from: base, to: snapshot },
        `yedek turu: '${share.name}' neyi değişti`,
        correlationId,
      );
      if (diff.status === 'refused' || diff.status === 'failed') {
        // Taban görüntüsü havuzdan gitmiş olabilir. Tabanı düşürüp bir sonraki turun baştan
        // başlamasını sağlamak, buradaki tek doğru davranış.
        await this.setBase(organizationId, share.id, null);
        throw new Error(diff.reason);
      }
      const changes = expectStatus(diff, 'diff');
      if (changes.truncated) {
        // KESİLMİŞ BİR LİSTE KULLANILAMAZ: eksik olan her satır yedeklenmeyen bir dosya.
        await this.setBase(organizationId, share.id, null);
        this.logger.warn(
          `'${share.name}' değişiklik listesi kesildi; sonraki tur baştan yürüyecek`,
        );
        return false;
      }

      const prefix = `${mountpoint}/`;
      for (const entry of changes.entries) {
        if (total.copiedFiles >= MAX_FILES_PER_RUN) return false;
        const relative = entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : null;
        // Bağlama noktasının DIŞINDA bir yol — olmaması gerekir, ve olduğunda yedeğe yazmak yerine
        // atlamak doğru: yedek ağacında nereye konacağı bilinmeyen bir dosya.
        if (relative === null || relative === '') continue;
        const parts = relative.split('/');

        if (entry.change === 'removed') {
          await this.moveToDeleted(share.name, parts, today, total, correlationId);
          continue;
        }

        // ── YENİDEN ADLANDIRMA, `kind` KONTROLÜNDEN ÖNCE ────────────────────────────────────
        //
        // `zfs diff` bir klasörün yeniden adlandırılmasını TEK bir `R` satırı olarak veriyor;
        // çocukları listelemiyor. Bu dal aşağıdaki `kind !== 'file'` kontrolünün ardında
        // olsaydı klasör yeniden adlandırmaları yine düşerdi — ve düşüyordu: yedekte klasör
        // eski adıyla kalıyor, yeni ad hiç oluşmuyor, ve eski kopya silinme defterine hiç
        // girmediği için saklama süresi ona hiç bakmıyordu. Yedek diski her adlandırmada
        // büyüyor ve canlı ağaçtan sessizce ayrışıyordu.
        if (entry.change === 'renamed') {
          const done = await this.renameInBackup(share.name, entry.old_path ?? null, prefix, {
            parts,
            kind: entry.kind,
            total,
            correlationId,
          });
          if (done) continue;
          // Taşıma uygulanamadı. Eski ağaç OLDUĞU YERDE bırakılıyor — hedefi silip üstüne
          // taşımak, kullanıcının yedekte aradığı dosyaları yok etmek olurdu — ve taban
          // düşürülüyor: bir sonraki tur ağacın tamamını yürüyüp yeni adı yazacak.
          await this.setBase(organizationId, share.id, null);
          this.logger.warn(
            `'${share.name}' içindeki bir yeniden adlandırma yedeğe uygulanamadı;` +
              ` sonraki tur baştan yürüyecek`,
          );
          return false;
        }

        if (entry.kind !== 'file') continue;
        await this.copyOne(share.name, parts, total, correlationId);
      }

      await this.setBase(organizationId, share.id, snapshot);
      advanced = true;
      return true;
    } finally {
      if (!advanced) await this.destroySnapshot(share, snapshot, correlationId);
    }
  }

  /**
   * Yeniden adlandırılan bir düğümü yedekte de yeniden adlandırır. `false` ise uygulanamadı.
   *
   * ── NEDEN TAŞIMA, KOPYALAMA DEĞİL ────────────────────────────────────────────────────────
   *
   * `zfs diff` kırk bin fotoğraflık bir klasörün yeniden adlandırılmasını TEK bir satır olarak
   * veriyor ve çocuklarını hiç listelemiyor. Bu satırı görmezden gelen tur ne yeni adı
   * oluşturuyor ne eskisini kaldırıyordu: yedek, canlı ağaçla uyuşmayan adlar taşıyor ve eski
   * kopya silinme defterine hiç girmediği için sonsuza kadar duruyordu. Ajanın `publish`i
   * dizinleri de taşıyor (`renameat2`), yani kırk bin dosyanın yeniden kopyalanması gerekmiyor.
   *
   * ── UYGULANAMADIĞINDA YEDEK BOZULMUYOR ───────────────────────────────────────────────────
   *
   * Hedefte bir düğüm varsa (`conflict`) o düğüm silinmiyor: `zfs diff` satırlarının sırası
   * garanti değil, yani orada duran şey bu turda yeni ada yazılmış gerçek bir dosya olabilir.
   * Çağıran tarafın yapacağı şey tabanı düşürmek — bir sonraki tur ağacın tamamını yürür.
   */
  private async renameInBackup(
    shareName: string,
    oldPath: string | null,
    prefix: string,
    entry: {
      parts: string[];
      kind: 'file' | 'directory' | 'other';
      total: RunOutcome;
      correlationId: string;
    },
  ): Promise<boolean> {
    const relative =
      oldPath !== null && oldPath.startsWith(prefix) ? oldPath.slice(prefix.length) : null;
    // Eski yolu olmayan ya da bağlama noktasının dışını gösteren bir `R` satırı: neyin taşınacağı
    // bilinmiyor, ve yanlış bir düğümü taşımaktansa tam yürüyüşe düşmek doğru.
    if (relative === null || relative === '') return false;

    const from = [FILES, shareName, ...relative.split('/')];
    const to = [FILES, shareName, ...entry.parts];
    const moved = await this.agent.call(
      { op: 'backup_move_entry', from, to },
      `yedek turu: '${relative}' artık '${entry.parts.join('/')}'`,
      entry.correlationId,
    );

    if (moved.status === 'moved') {
      // TAŞIMA BAYT KOPYALAMIYOR, o yüzden `copiedFiles`e sayılmıyor: turun dosya sınırını
      // taşımalarla doldurmak, gerçek kopyaları sebepsiz yere sonraki tura ertelerdi.
      entry.total.movedFiles += 1;
      return true;
    }
    if (moved.status === 'not_found') {
      // Eski ad yedekte yoktu. Bir DOSYA ise yeni adıyla kopyalamak doğru cevap. Bir DİZİN ise
      // altında ne olduğunu bu satır söylemiyor — çocukları `zfs diff` hiç listelemedi — yani
      // tam yürüyüşten başka bir yol yok.
      if (entry.kind !== 'file') return false;
      await this.copyOne(shareName, entry.parts, entry.total, entry.correlationId);
      return true;
    }
    this.logger.warn(
      `'${shareName}': '${relative}' → '${entry.parts.join('/')}' taşınamadı;` +
        ` ajan '${moved.status}' dedi`,
    );
    return false;
  }

  /**
   * Bu paylaşımın datasetinde ARTIK KİMSENİN BAKMADIĞI tur görüntülerini yok eder.
   *
   * Tur her koştuğunda bir `depsis-yedek-*` görüntüsü alıyor, ama bunlardan yalnız ikisi işe
   * yarıyor: bir sonraki turun karşılaştıracağı taban, ve az önce alınan. Gerisi ölü ağırlık —
   * kullanıcının sildiği her blok o görüntülerde asılı kalıyor. Altı saatlik ritimde beş paylaşım
   * ayda altı yüz görüntü demek, ve havuz dolduğunda duran şey SMB yazmaları oluyor.
   *
   * ÖN EKİ OLMAYANA DOKUNULMUYOR. Zamanlanmış yedeklerin (`depsis-daily-…`) ve kullanıcının bir
   * yükseltmeden önce elle aldığı görüntülerin ne zaman silineceğine bu tur karar veremez;
   * `prunable()`in tek cümlelik kuralı burada da geçerli.
   *
   * KAYITLI HİÇBİR TABAN SİLİNMİYOR — yalnız bu paylaşımınki değil, kiracının tamamınınki. İki
   * paylaşımın aynı dataseti göstermesini engelleyen bir kısıt yok, ve başka bir paylaşımın
   * tabanını silmek o paylaşımın turunu baştan yürümeye zorlardı.
   *
   * BİR GÖRÜNTÜ SİLİNEMEZSE TUR DÜŞMÜYOR: klonu ya da tutamağı olabilir, ve bu turun işi değil.
   */
  private async sweepRunSnapshots(
    organizationId: string,
    share: ShareRow,
    keep: string,
    correlationId: string,
  ): Promise<void> {
    const listed = await this.agent.call(
      { op: 'list_snapshots', dataset: share.dataset },
      `yedek turu: '${share.name}' görüntü envanteri`,
      correlationId,
    );
    if (listed.status !== 'snapshots') return;

    const bases = await this.db.withTenant(organizationId, (q) =>
      q.query<{ base_snapshot: string }>(
        `SELECT base_snapshot FROM public.backup_bases WHERE base_snapshot IS NOT NULL`,
      ),
    );
    const inUse = new Set(bases.map((row) => row.base_snapshot));
    inUse.add(keep);

    for (const snapshot of listed.snapshots) {
      if (!snapshot.name.startsWith(RUN_SNAPSHOT_PREFIX)) continue;
      if (inUse.has(snapshot.name)) continue;
      await this.destroySnapshot(share, snapshot.name, correlationId);
    }
  }

  /**
   * Bir tur görüntüsünü yok eder.
   *
   * HİÇBİR KOŞULDA FIRLATMIYOR, ve bu bir kolaylık değil: çağıranlardan biri `finally` içinde ve
   * orada atılan bir hata, turun asıl hatasının — 'yer yok' gibi, kendi durumu olan bir hatanın —
   * üstünü örterdi.
   */
  private async destroySnapshot(
    share: ShareRow,
    snapshot: string,
    correlationId: string,
  ): Promise<void> {
    try {
      const gone = await this.agent.call(
        { op: 'destroy_snapshot', dataset: share.dataset, snapshot },
        `yedek turu: '${share.name}' görüntüsü siliniyor (${snapshot})`,
        correlationId,
      );
      // Silinemeyen bir görüntünün klonu ya da tutamağı olabilir, ve o bir kullanıcı kararı. Ama
      // sessizce geçilmiyor — havuz doluyorsa sebebi günlükte olsun.
      if (gone.status !== 'snapshot_destroyed') {
        this.logger.warn(`${share.dataset}@${snapshot} silinemedi; ajan '${gone.status}' dedi`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`${share.dataset}@${snapshot} silinemedi: ${reason}`);
    }
  }

  /**
   * İlk tur: paylaşımın ağacını yürüyüp her dosyayı kopyalar.
   *
   * ÖZYİNELEME BURADA, AJANDA DEĞİL. Ajanın işlem kümesinde özyinelemeli hiçbir şey yok ve
   * olmamalı: kök yetkiyle koşan bir süreçte ağacın ne kadarına dokunulacağını çağıran taraf
   * seçemez. Ağacı yürüyen taraf, ağacı zaten bilen taraf.
   *
   * DİZİN SAYFA SAYFA OKUNUYOR. Ajanın tek bir yanıtı 5.000 girdide kesiliyor ve gerisini `after`
   * imleciyle veriyor — imleç bir AD, ofset değil, yani sayfalar arasında bir dosya eklenirse sıra
   * kaymıyor. Sayfalama olmadan, içinde 5.000'den fazla girdi bulunan tek bir klasör paylaşımın
   * İLK turunu her seferinde aynı yerden düşürüyordu: taban hiç yazılmadığı için sonraki tur baştan
   * başlıyor, aynı klasöre çarpıyor, ve o paylaşımın hiçbir dosyası yedeğe girmiyordu.
   *
   * TAVAN AŞILIRSA HÂLÂ HATA VERİLİYOR: eksik olan her satır yedeklenmeyen bir dosya, ve ilk turda
   * o dosyaların bir daha sorulacağı yer yok — taban yazıldıktan sonra yalnız DEĞİŞENLER geliyor,
   * ve hiç kopyalanmamış bir dosya bir daha değişmeyebilir.
   */
  private async walkAndCopy(
    shareName: string,
    path: string[],
    total: RunOutcome,
    correlationId: string,
  ): Promise<void> {
    let after: string | undefined;

    for (let page = 0; page < MAX_LISTING_PAGES; page += 1) {
      const response = await this.agent.call(
        {
          op: 'list_directory',
          share: shareName,
          path,
          ...(after === undefined ? {} : { after }),
        },
        `ilk yedek turu: ${shareName}/${path.join('/')}`,
        correlationId,
      );
      // Bu arada silinmiş bir dizin: olağan, ve atlanıyor. Sonraki sayfalarda aynı yanıt "dizin
      // okunurken silindi" demek; o zamana kadar kopyalananlar yerinde kalıyor ve yürüyüş biter.
      if (response.status === 'not_found') return;
      const listing = expectStatus(response, 'listing');

      // SAYFA GELDİĞİ ANDA İŞLENİYOR, biriktirilmiyor: iki yüz bin girdilik bir dizinin tamamını
      // bellekte tutmanın hiçbir karşılığı yok, ve imleç bir ad olduğu için sayfalar arasında
      // geçen süre güvenli.
      for (const entry of listing.entries) {
        const child = [...path, entry.name];
        if (entry.directory) {
          await this.walkAndCopy(shareName, child, total, correlationId);
        } else {
          await this.copyOne(shareName, child, total, correlationId);
        }
      }

      if (!listing.truncated) return;
      const last = listing.entries[listing.entries.length - 1];
      // Kesildi ama girdi yok: ilerletecek bir imleç kalmadı, ve aynı sayfayı yeniden istemek
      // sonsuz döngü olurdu.
      if (last === undefined) break;
      after = last.name;
    }

    throw new Error(
      `'${shareName}/${path.join('/')}' dizini ${MAX_LISTING_PAGES} listeleme sayfasında bitmedi;` +
        ` ilk yedek eksik kalırdı`,
    );
  }

  /** Bir dosyayı yedeğe kopyalar, gerekirse üst dizinleri açarak. */
  /**
   * Bu turda en son kopyalanan dosya, tur bitince satıra yazılmak üzere.
   *
   * Her dosyada bir UPDATE atmak yerine burada tutuluyor: bir tur binlerce dosya kopyalayabilir
   * ve bunların her biri için veritabanına yazmak, doğrulamanın maliyetini yedeklemenin kendisine
   * yüklerdi.
   */
  private lastCopied: { share: string; path: string[] } | null = null;

  private async copyOne(
    shareName: string,
    parts: string[],
    total: RunOutcome,
    correlationId: string,
  ): Promise<void> {
    const to = [FILES, shareName, ...parts];
    const directory = to.slice(0, -1);
    await this.ensureDirs(directory, correlationId);

    // ── ÖNCE YAZ, SONRA KALDIR ───────────────────────────────────────────────────────────────
    //
    // Eski sürüm burada, tek bayt yazılmadan ÖNCE kaldırılıyordu. Kırk gigabaytlık bir dosya
    // değiştiğinde ve yedek diskinde on gigabayt kaldığında olan şuydu: yedekteki SAĞLAM kopya
    // siliniyor, kopyalama `out_of_space` ile düşüyor, ve o dosyanın yedekte ne eski ne yeni
    // sürümü kalıyordu. Taban da ilerlemediği için sonraki turlar aynı yerde düşüyor, yani
    // boşluk kendiliğinden kapanmıyordu — sistem diski o gün yansa dosya tamamen kaybolurdu.
    //
    // Ajanın `copy_file_to_backup`u son diliminde ara dosyayı hedefe TAŞIYARAK bitiriyor, yani
    // "hepsini yaz" ile "yayımla" API tarafından ayrılamıyor. Bu yüzden yeni sürüm önce aynı
    // dizindeki geçici bir ada yayımlanıyor; eski kopya ancak ondan sonra kaldırılıyor ve son
    // adım bir yeniden adlandırma. Geçici adın UUID taşıması, yarıda kalmış bir turun bıraktığı
    // dosyayla çakışmamak için — çakışsaydı kopyalama `conflict` ile düşerdi.
    const temp = [...directory, `${TEMP_PREFIX}${randomUUID()}`];

    const staging = `yedek-${randomUUID()}`;
    let offset = 0;
    for (;;) {
      const response = await this.agent.call(
        {
          op: 'copy_file_to_backup',
          share: shareName,
          from: parts,
          to: temp,
          staging_name: staging,
          offset,
          max_bytes: SLICE,
        },
        `yedek turu: ${parts.join('/')}`,
        correlationId,
      );
      if (response.status === 'not_found') return; // kaynak bu arada silinmiş: olağan
      if (response.status === 'out_of_space') throw new Error(response.reason);
      const copied = expectStatus(response, 'copied');
      total.copiedBytes += Number(copied.offset) - offset;
      offset = Number(copied.offset);
      if (copied.done) break;
    }

    // Yeni sürüm artık diskte ve tam. Eski kopyayı kaldırmak buradan sonrası: aradaki pencere
    // iki çağrı, ve o pencerede kesilen bir tur yedekte geçici adı bırakır — kaybolmuş bir dosya
    // değil, adı garip bir dosya.
    //
    // Eski sürümü silinenlere TAŞIMAK yerine kaldırmak, "değişen dosyanın eski hâli" ile
    // "silinen dosya" arasındaki farkı korumuyor — ama her değişen dosyanın bir kopyasını
    // saklama süresi boyunca tutup diski doldurmuyor da.
    await this.agent.call(
      { op: 'backup_remove_entry', path: to, directory: false },
      `yedek turu: eski sürüm kaldırılıyor`,
      correlationId,
    );
    const published = await this.agent.call(
      { op: 'backup_move_entry', from: temp, to },
      `yedek turu: yeni sürüm yerine konuyor (${parts.join('/')})`,
      correlationId,
    );
    if (published.status !== 'moved') {
      // Yeni sürüm yazıldı ama yerine oturmadı. Susmak, yedekte geçici adlı bir dosya ve eski
      // adında hiçbir şey bırakırdı; turun düşmesi doğru cevap — taban ilerlemiyor, yani bir
      // sonraki tur aynı dosyayı yeniden deniyor.
      throw new Error(
        `${parts.join('/')} yedekte yerine konamadı; ajan '${published.status}' dedi`,
      );
    }
    total.copiedFiles += 1;

    // EN SON KOPYALANAN DOSYA, günlük doğrulamanın okuyacağı dosya. Rastgele bir dosya seçmek
    // yerine bu: yeni yazılmış bir kopya, kopyalama yolunun bozulduğunu en çabuk gösteren şey, ve
    // aylar önce yazılmış bir dosyayı doğrulamak bugünün turu hakkında hiçbir şey söylemez.
    this.lastCopied = { share: shareName, path: parts };
  }

  /**
   * Silinen dosyayı bugünün tarihini taşıyan klasöre TAŞIR.
   *
   * Gecikmeli silmenin defteri budur — bir veritabanı değil, dizinin ADI. Sistem diski yandığında
   * o bilgi diskle birlikte duruyor, ve diski başka bir bilgisayara takan insan tarihleri dosya
   * gezgininde okuyor.
   */
  private async moveToDeleted(
    shareName: string,
    parts: string[],
    today: string,
    total: RunOutcome,
    correlationId: string,
  ): Promise<void> {
    const from = [FILES, shareName, ...parts];
    const to = [LEDGER, DELETED, today, shareName, ...parts];
    await this.ensureDirs(to.slice(0, -1), correlationId);

    const response = await this.agent.call(
      { op: 'backup_move_entry', from, to },
      `yedek turu: silinen ${parts.join('/')}`,
      correlationId,
    );
    // `not_found` — yedekte zaten yoktu (hiç kopyalanmamış bir dosya silinmiş). Hata değil.
    // `conflict` — aynı gün aynı adla ikinci kez silinmiş; ilk sürüm yerinde kalıyor ve bu
    // doğru: üstüne yazmak, kullanıcının yedekte aradığı dosyayı yok etmek olurdu.
    if (response.status === 'moved') total.movedFiles += 1;
  }

  /** Yedek ağacında bir yolun üst dizinlerini açar. Var olanları `conflict` ile geçiyor. */
  private async ensureDirs(path: string[], correlationId: string): Promise<void> {
    for (let depth = 1; depth <= path.length; depth += 1) {
      await this.agent.call(
        { op: 'backup_create_directory', path: path.slice(0, depth) },
        `yedek turu: dizin`,
        correlationId,
      );
    }
  }

  /**
   * Süresi dolan gün klasörlerini kalıcı olarak siler.
   *
   * ── SİLME KARARINI DİZİNİN ADI VERİYOR, BU TABLO DEĞİL ───────────────────────────────────
   *
   * `silinenler/2026-08-30/` — dizinin adı silinme tarihi, ve saklama süresi o addan
   * hesaplanıyor. Veritabanındaki satırlar bir ÖNBELLEK; otorite diskin üstünde. Sistem diski
   * yandığında bile hangi klasörün ne zaman silineceği diskle birlikte duruyor.
   *
   * ── ÖZYİNELEME BURADA, AJANDA DEĞİL ──────────────────────────────────────────────────────
   *
   * Ajanın silme işlemi tek bir düğüm siliyor ve dolu bir dizini reddediyor. Kök yetkiyle koşan
   * bir süreçte `rm -r`nin karşılığı olan bir işlem, tek bir yanlış operandla bütün yedeği
   * silerdi. Ağacı yürüyen taraf, ne sildiğini bilen taraf.
   *
   * ── ADI TARİH OLMAYAN KLASÖRE DOKUNULMUYOR ───────────────────────────────────────────────
   *
   * Elle konmuş, yarıda kalmış ya da başka bir sürümün bıraktığı bir klasörün ne zaman
   * silineceği bilinmiyor. Bilinmeyen bir tarihi "çok eski" saymak, silinmemesi gerekeni
   * silmenin en kolay yolu.
   */
  async purgeExpired(organizationId: string): Promise<number> {
    const correlationId = randomUUID();
    const target = await this.targets.row(organizationId);
    if (target === null || !target.enabled || target.recoveryOnly) return 0;

    const status = expectStatus(
      await this.agent.call(
        { op: 'backup_root_status', pool: target.pool },
        'temizlik: diskin durumu',
        correlationId,
      ),
      'backup_root',
    );
    if (!status.prepared || !status.key_loaded || !status.mounted) return 0;

    const listed = await this.agent.call(
      { op: 'backup_list_directory', path: [LEDGER, DELETED] },
      'temizlik: silinenler klasörü',
      correlationId,
    );
    // Hiç silinmiş dosya olmamış: dizin de yok. Olağan.
    if (listed.status === 'not_found' || listed.status === 'refused') return 0;
    const days = expectStatus(listed, 'listing');

    const cutoff = new Date(Date.now() - target.retainDays * 86_400_000).toISOString().slice(0, 10);

    let purged = 0;
    for (const day of days.entries) {
      if (!day.directory) continue;
      // YYYY-AA-GG, ve başka hiçbir şey. Sözlük sırası tarih sırasıyla aynı olduğu için
      // karşılaştırma metin üzerinde yapılabiliyor.
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(day.name)) continue;
      if (day.name >= cutoff) continue;
      purged += (await this.removeTree([LEDGER, DELETED, day.name], correlationId)).removed;
    }
    if (purged > 0) {
      this.logger.log(`temizlik: ${purged} dosya kalıcı olarak silindi`);
    }
    return purged;
  }

  /**
   * Bir ağacı yaprakları önce silerek kaldırır.
   *
   * ── KESİLMİŞ LİSTELEME ARTIK ATLANMIYOR ──────────────────────────────────────────────────
   *
   * `backup_list_directory` tek yanıtta en çok 5.000 girdi veriyor ve — kardeşi `list_directory`
   * gibi bir `after` imleci taşımadığı için — gerisini sunacak bir yolu yok. Kesilmiş bir
   * listelemede hiç dokunmamak, 8.000 fotoğrafın silindiği bir gün klasörünün ASLA
   * temizlenmemesi demekti: her saat aynı uyarı, üst dizin dolu kaldığı için o da silinemiyor,
   * ve o bloklar saklama süresi ne olursa olsun diskte kalıyordu — sonunda "yer yok" ile duran
   * turlar.
   *
   * SİL-VE-YENİDEN-LİSTELE sıraya ihtiyaç duymuyor, ve bu şans değil kuralın kendisi: silinen
   * bir girdi bir daha listelenmiyor, yani her tur listelemeyi ilerletiyor. `after` imleci
   * gerekmiyor — ajanın girdileri sıralamadığı bu yolda zaten yoktu.
   *
   * İLERLEME ÖLÇÜLÜYOR. Bir turda hiçbir girdi kaldırılamadıysa (hepsi `conflict` ya da
   * `refused` dönüyorsa) döngü aynı listeyi sonsuza kadar isterdi; o hâlde dizin bırakılıyor ve
   * gerekçe günlüğe yazılıyor.
   */
  private async removeTree(
    path: string[],
    correlationId: string,
  ): Promise<{ removed: number; cleared: boolean }> {
    let removed = 0;

    for (let pass = 0; pass < MAX_PURGE_PASSES; pass += 1) {
      const listed = await this.agent.call(
        { op: 'backup_list_directory', path },
        'temizlik: dizin',
        correlationId,
      );
      // Dizin bu arada gitmiş: istenen sonuç zaten bu.
      if (listed.status === 'not_found') return { removed, cleared: true };
      const listing = expectStatus(listed, 'listing');

      let progressed = false;
      for (const entry of listing.entries) {
        const child = [...path, entry.name];
        if (entry.directory) {
          const inner = await this.removeTree(child, correlationId);
          removed += inner.removed;
          if (inner.cleared) progressed = true;
        } else {
          const gone = await this.agent.call(
            { op: 'backup_remove_entry', path: child, directory: false },
            'temizlik: dosya',
            correlationId,
          );
          if (gone.status === 'removed') {
            removed += 1;
            progressed = true;
          }
        }
      }

      // Liste kesilmediyse dizinin tamamı görüldü; bir sayfa daha istemenin anlamı yok.
      if (!listing.truncated || listing.entries.length === 0) break;
      if (!progressed) {
        this.logger.warn(
          `temizlik: '${path.join('/')}' içinde hiçbir girdi kaldırılamadı; dizin bırakıldı`,
        );
        return { removed, cleared: false };
      }
    }

    const gone = await this.agent.call(
      { op: 'backup_remove_entry', path, directory: true },
      'temizlik: dizin',
      correlationId,
    );
    // DOLU BİR DİZİN `conflict` DÖNÜYOR ve bu sessizce geçiliyordu: üst klasör diskte kalırken
    // temizlik "bitti" diyordu. Bir sonraki tur yeniden deniyor, ama sebebin günlükte durması
    // gerekiyor.
    if (gone.status !== 'removed') {
      this.logger.warn(`temizlik: '${path.join('/')}' kaldırılamadı; ajan '${gone.status}' dedi`);
      return { removed, cleared: false };
    }
    return { removed, cleared: true };
  }

  /** Temizlik turunu kuyruğa alır — saatte bir. */
  async schedulePurge(organizationId: string, runAfter: Date): Promise<void> {
    await this.db.withTenant(organizationId, (q) =>
      q.query(
        `INSERT INTO public.job_queue (organization_id, kind, payload, run_after, max_attempts)
         VALUES ($1, 'storage.backup.purge', '{}'::jsonb, $2, 3)
         ON CONFLICT DO NOTHING`,
        [organizationId, runAfter],
      ),
    );
  }

  /**
   * Zinciri tohumla — açılışta bir kez, yedek diski olan her kiracı için.
   *
   * `setInterval` DEĞİL. Yalnız o süreç ayaktayken çalışan ve yeniden başlatmada kaybolan bir
   * zamanlayıcı, bir yedekleme sisteminin sessizce durmasının yolu — ve durduğunu kimse fark
   * etmiyor, çünkü eksik olan şey bir yedeğin YOKLUĞU ve o ancak ihtiyaç duyulduğu gün aranıyor.
   *
   * `ON CONFLICT DO NOTHING`: zaten bekleyen bir tur varken hiçbir şey yapmıyor. Tohum olmasaydı,
   * zincirin bir kez kopması onu kalıcı olarak durdururdu.
   */
  /**
   * Bir kiracının üç zincirini birden başlatır: tur, budama, doğrulama.
   *
   * AÇILIŞTAN AYRI BİR ÇAĞIRAN VAR, ve olması gerekiyordu: hedefi kuran uç. Yalnız açılışta
   * tohumlandığı sürece, yedek diskini yeni kuran kullanıcı API yeniden başlayana kadar hiç
   * yedek almıyordu — ekran "6 saatte bir" derken.
   *
   * Üçü de `ON CONFLICT DO NOTHING`, yani iki çağıranın çakışması diye bir şey yok: hangisi önce
   * gelirse zincir ondan başlıyor.
   */
  async seedChains(organizationId: string): Promise<void> {
    await this.scheduleNext(organizationId, new Date());
    await this.schedulePurge(organizationId, new Date());
    await this.scheduleVerify(organizationId, new Date());
  }

  async onModuleInit(): Promise<void> {
    try {
      // KİRACILAR `tenantIds()` İLE, sonra her biri KENDİ bağlamında sorgulanıyor.
      //
      // Eskiden `backup_targets` doğrudan `withoutTenant` ile okunuyordu ve tablo kiracıya ait:
      // RLS bağlamsız sorguya sıfır satır döndürüyordu, hata vermiyordu, ve yedek zincirleri
      // gerçek bir cihazda açılışta hiç kurulmuyordu. Gerekçenin tamamı `DbService.tenantIds`de.
      let seeded = 0;
      for (const organizationId of await this.db.tenantIds()) {
        const rows = await this.db.withTenant(organizationId, (q) =>
          q.query<{ id: string }>(
            `SELECT organization_id::text AS id FROM public.backup_targets WHERE enabled`,
          ),
        );
        if (rows.length === 0) continue;
        await this.seedChains(organizationId);
        seeded += 1;
      }
      if (seeded > 0) {
        this.logger.log(`yedek turu ${seeded} kiracı için tohumlandı`);
      }
    } catch (error) {
      this.logger.error(
        `yedek turu zinciri tohumlanamadı: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Yedeğin gerçekten okunabildiğini ÖLÇER — günde bir.
   *
   * ── SAYMAK ÖLÇMEK DEĞİL ──────────────────────────────────────────────────────────────────
   *
   * Tur kaç dosya kopyaladığını sayıyor, ama saydığı şey kendi yaptığı çağrılar. Kopyanın boş,
   * yarım ya da başka bir dosya olduğu bir kusur sayıları hiç bozmadan aylarca sürebilir — ve
   * yalnız kurtarma gününde, yani düzeltmenin artık mümkün olmadığı gün, ortaya çıkar.
   *
   * Burada gerçekten bir dosya okunuyor ve aslıyla karşılaştırılıyor.
   *
   * ── HANGİ DOSYA ──────────────────────────────────────────────────────────────────────────
   *
   * Turun EN SON kopyaladığı dosya. Yeni yazılmış bir kopya, kopyalama yolunun bozulduğunu en
   * çabuk gösteren şey; aylar önce yazılmış bir dosyayı doğrulamak bugünün turu hakkında hiçbir
   * şey söylemez.
   *
   * Hiç dosya kopyalanmadıysa ölçüm YAPILMIYOR ve sonuç "başarılı" diye yazılmıyor. Yapılmamış
   * bir ölçümü başarılı saymak, doğrulamanın tamamını süse çevirirdi.
   *
   * ── HAFTADA BİR DE TARAMA ────────────────────────────────────────────────────────────────
   *
   * `scrub`, ZFS'in her bloğun sağlamasını okuyup doğrulaması: diskin sessizce çürümesine karşı
   * olan ölçüm. Karşılaştırmanın yerine geçmiyor, ikisi ayrı şeyleri ölçüyor — scrub "disk doğru
   * okuyor" diyor, karşılaştırma "yazdığımız şey doğruydu" diyor.
   */
  async verifyOnce(organizationId: string): Promise<{ ok: boolean; note: string }> {
    const correlationId = randomUUID();
    const target = await this.targets.row(organizationId);
    if (target === null) return { ok: false, note: 'yedek diski kurulu değil' };

    // KURTARMA DİSKİ DOĞRULANMIYOR: bu cihaz ona hiçbir şey yazmadı, yani orada karşılaştırılacak
    // bir "asıl" yok. Başka bir cihazın dosyalarını bu cihazın paylaşımlarıyla karşılaştırmak,
    // her seferinde "bozuk" derdi.
    if (target.recoveryOnly) return { ok: true, note: 'kurtarma diski; doğrulama yapılmıyor' };

    const status = expectStatus(
      await this.agent.call(
        { op: 'backup_root_status', pool: target.pool },
        `doğrulama: diskin durumu (${target.pool})`,
        correlationId,
      ),
      'backup_root',
    );
    if (!status.prepared || !status.key_loaded || !status.mounted) {
      return { ok: false, note: `${whyUnavailable(status)}; doğrulama yapılamadı` };
    }

    await this.scrubIfDue(organizationId, target.pool, correlationId);

    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ share: string | null; path: string[] | null }>(
        `SELECT last_copied_share AS share, last_copied_path AS path
           FROM public.backup_targets WHERE id = $1::uuid`,
        [target.id],
      ),
    );
    const last = rows[0];
    if (last?.share == null || last.path == null || last.path.length === 0) {
      const note = 'henüz doğrulanacak bir dosya yok';
      await this.recordVerification(organizationId, target.id, null, note);
      return { ok: false, note };
    }

    const response = await this.agent.call(
      {
        op: 'compare_backup_copy',
        share: last.share,
        live: last.path,
        backup: [FILES, last.share, ...last.path],
      },
      `doğrulama: ${last.share}/${last.path.join('/')}`,
      correlationId,
    );

    const name = `${last.share}/${last.path.join('/')}`;
    if (response.status === 'not_found') {
      // ASIL SİLİNMİŞ. Bir kusur değil ve "bozuk" da değil: ölçülecek bir şey kalmamış.
      const note = `${name} artık yok; doğrulanacak bir şey kalmadı`;
      await this.recordVerification(organizationId, target.id, null, note);
      return { ok: false, note };
    }
    if (response.status === 'refused' || response.status === 'failed') {
      await this.recordVerification(organizationId, target.id, false, response.reason);
      return { ok: false, note: response.reason };
    }

    const result = expectStatus(response, 'comparison');
    const howMuch = result.partial
      ? `ilk ${Math.round(Number(result.compared_bytes) / (1024 * 1024))} MB`
      : 'tamamı';
    if (result.identical) {
      const note = `${name} okundu; ${howMuch} aslıyla aynı`;
      await this.recordVerification(organizationId, target.id, true, note);
      return { ok: true, note };
    }

    const live = Number(result.live_bytes);
    const backup = Number(result.backup_bytes);
    // ── BOYUT FARKI TEK BAŞINA "YEDEK BOZUK" DEĞİL ───────────────────────────────────────────
    //
    // Karşılaştırma yedeği CANLI dosyayla ölçüyor (`compare_backup_copy` paylaşım kökünden
    // okuyor, anlık görüntüden değil). Tur 06:00'da kopyalıyor, doğrulama 14:00'te bakıyor: o
    // gün üzerinde çalışılan bir tablo dosyası her seferinde "FARKLI" çıkıyordu ve ekran
    // "yedeğinizi doğrulayamadık, diski kontrol edin" diyordu — yani her gün kullanılan her
    // dosya, arızası olmayan bir cihazda kırmızı bir kart üretiyordu. Gerçek bozulmayı bu
    // gürültünün içinden ayırmanın yolu yoktu.
    //
    // BOYUTLAR EŞİTKEN İÇERİK FARKLIYSA hâlâ arıza, ve öyle kalıyor: canlı dosya turdan sonra
    // aynı uzunlukta kalacak şekilde değişmiş olabilir ama olağan olan bu değil, ve sessiz
    // çürüme tam bu şekilde görünüyor.
    //
    // BOŞ BİR YEDEK KOPYASI da arıza ve ölçülemedi sayılmıyor: dolu bir dosyanın yedekte sıfır
    // bayt olması, canlı tarafta yapılan bir düzenlemenin üretebileceği bir şey değil.
    if (live !== backup && backup > 0) {
      const note =
        `${name} turdan SONRA değişmiş görünüyor (asıl ${live} bayt,` +
        ` yedekteki kopya ${backup} bayt); bu dosyayla ölçüm yapılamadı`;
      // `null` — YAPILMAMIŞ bir ölçüm. `false` yazmak, bir kusuru olmayan cihazda arıza kartı
      // açardı; `true` yazmak, yapılmamış bir ölçümü başarılı göstererek doğrulamanın tamamını
      // süse çevirirdi.
      await this.recordVerification(organizationId, target.id, null, note);
      this.logger.warn(`yedek doğrulaması ölçülemedi: ${note}`);
      return { ok: false, note };
    }

    const note = `${name} yedekte aslından FARKLI (asıl ${live} bayt, yedek ${backup} bayt)`;
    await this.recordVerification(organizationId, target.id, false, note);
    this.logger.error(`yedek doğrulaması düştü: ${note}`);
    return { ok: false, note };
  }

  /**
   * Haftada bir tarama başlatır.
   *
   * BAŞLATIYOR, beklemiyor: bir scrub saatler sürüyor ve sonucunu `scrub_status` söylüyor. Bunu
   * beklemek, doğrulama işini bir gün boyunca kuyrukta tutmak olurdu.
   */
  private async scrubIfDue(
    organizationId: string,
    pool: string,
    correlationId: string,
  ): Promise<void> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ due: boolean }>(
        `SELECT (last_scrub_at IS NULL OR last_scrub_at < now() - interval '7 days') AS due
           FROM public.backup_targets`,
      ),
    );
    if (rows[0]?.due !== true) return;

    const response = await this.agent.call(
      { op: 'start_scrub', pool },
      `doğrulama: yedek havuzu taranıyor (${pool})`,
      correlationId,
    );
    if (response.status === 'refused' || response.status === 'failed') {
      // ZATEN KOŞAN BİR TARAMA hata değil: bir sonraki hafta yine denenecek.
      this.logger.warn(`yedek havuzu taraması başlatılamadı: ${response.reason}`);
      return;
    }
    await this.db.withTenant(organizationId, (q) =>
      q.query(`UPDATE public.backup_targets SET last_scrub_at = now()`),
    );
  }

  private async recordVerification(
    organizationId: string,
    targetId: string,
    ok: boolean | null,
    note: string,
  ): Promise<void> {
    await this.db.withTenant(organizationId, (q) =>
      q.query(
        `UPDATE public.backup_targets
            SET last_verified_at = now(), last_verify_ok = $2, last_verify_note = $3
          WHERE id = $1::uuid`,
        [targetId, ok, note],
      ),
    );
  }

  /** Doğrulama zincirinin bir sonraki halkası. */
  async scheduleVerify(organizationId: string, runAfter: Date): Promise<void> {
    await this.db.withTenant(organizationId, (q) =>
      q.query(
        `INSERT INTO public.job_queue (organization_id, kind, payload, run_after, max_attempts)
         VALUES ($1, 'storage.backup.verify', '{}'::jsonb, $2, 3)
         ON CONFLICT DO NOTHING`,
        [organizationId, runAfter],
      ),
    );
  }

  /** Bir sonraki turu kuyruğa alır. Zincirin kendisi. */
  async scheduleNext(organizationId: string, runAfter: Date): Promise<void> {
    await this.db.withTenant(organizationId, (q) =>
      q.query(
        `INSERT INTO public.job_queue (organization_id, kind, payload, run_after, max_attempts)
         VALUES ($1, 'storage.backup.run', '{}'::jsonb, $2, 3)
         ON CONFLICT DO NOTHING`,
        [organizationId, runAfter],
      ),
    );
  }

  /**
   * "Şimdi yedek al" — kullanıcının bastığı düğme.
   *
   * AYRI BİR İŞ TÜRÜ, ve ayrı olması bir tuzağı kapatıyor. Zincirin tekilliğini koruyan kısmi
   * indeks — aynı anda yalnız bir `storage.backup.run` kuyrukta olabilir — elle başlatılan turu
   * da engellerdi: zincir gereği her zaman tam olarak bir bekleyen satır var, yani düğme hiçbir
   * zaman iş kuyruğa koyamazdı.
   */
  async runNow(organizationId: string): Promise<void> {
    await this.db.withTenant(organizationId, (q) =>
      q.query(
        `INSERT INTO public.job_queue (organization_id, kind, payload, run_after, max_attempts)
         VALUES ($1, 'storage.backup.run.now', '{}'::jsonb, now(), 1)
         ON CONFLICT DO NOTHING`,
        [organizationId],
      ),
    );
  }

  /** Kaç saatte bir tur döneceği — zincirin bir sonraki halkasını buradan hesaplıyor. */
  async cadenceHours(organizationId: string): Promise<number> {
    const target = await this.targets.row(organizationId);
    return target?.cadenceHours ?? 6;
  }

  private async baseOf(organizationId: string, shareId: string): Promise<string | null> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ base_snapshot: string | null }>(
        `SELECT base_snapshot FROM public.backup_bases WHERE share_id = $1::uuid`,
        [shareId],
      ),
    );
    return rows[0]?.base_snapshot ?? null;
  }

  private async setBase(
    organizationId: string,
    shareId: string,
    snapshot: string | null,
  ): Promise<void> {
    await this.db.withTenant(organizationId, (q) =>
      q.query(
        `INSERT INTO public.backup_bases
                (organization_id, share_id, base_snapshot, last_success_at, updated_at)
         VALUES ($1, $2::uuid, $3, CASE WHEN $3 IS NULL THEN NULL ELSE now() END, now())
         ON CONFLICT (organization_id, share_id) DO UPDATE
            SET base_snapshot   = EXCLUDED.base_snapshot,
                last_success_at = COALESCE(EXCLUDED.last_success_at,
                                           public.backup_bases.last_success_at),
                updated_at      = now()`,
        [organizationId, shareId, snapshot],
      ),
    );
  }

  /**
   * Son turlar, yenisi başta.
   *
   * ── NEDEN BEŞ SATIR ──────────────────────────────────────────────────────────────────────
   *
   * Ekranın söylemesi gereken iki cümle var: "son tur ne yaptı" ve "bu bir kerelik mi, yoksa
   * her turda mı oluyor". Birincisi için bir satır yeter, ikincisi için birkaç satır gerekiyor
   * — altı saatlik ritimde beş satır son bir günü kapsıyor.
   *
   * ── KİRACI BAĞLAMI, VE YANINDA AÇIK BİR FİLTRE ───────────────────────────────────────────
   *
   * `backup_runs` RLS'li (0044); bağlamsız bir okuma sıfır satır döndürür ve bunu HATA olarak da
   * söylemez — yani ekran sessizce "hiç tur olmamış" derdi. `WHERE organization_id` o
   * daraltmanın YERİNE değil YANINDA: ikisinden birini kaldırmak, ötekini tek başına doğru
   * olduğu için kaldırılabilir gösterir.
   */
  async recent(organizationId: string, limit = 5): Promise<BackupRunSummary[]> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{
        trigger: BackupRunSummary['trigger'];
        state: BackupRunSummary['state'];
        copied_files: number;
        copied_bytes: string | number;
        moved_files: number;
        purged_files: number;
        error: string | null;
        started_at: Date;
        finished_at: Date | null;
      }>(
        `SELECT trigger, state, copied_files, copied_bytes, moved_files, purged_files,
                error, started_at, finished_at
           FROM public.backup_runs
          WHERE organization_id = $1
          ORDER BY started_at DESC
          LIMIT $2`,
        [organizationId, limit],
      ),
    );
    return rows.map((row) => ({
      trigger: row.trigger,
      state: row.state,
      copiedFiles: row.copied_files,
      // `bigint` sürücüden metin olarak geliyor: sayıya çevirmeyen bir alan ekranda tırnak
      // içinde bir bayt sayısı gösterir.
      copiedBytes: Number(row.copied_bytes),
      movedFiles: row.moved_files,
      purgedFiles: row.purged_files,
      error: row.error,
      startedAt: row.started_at.toISOString(),
      finishedAt: row.finished_at?.toISOString() ?? null,
    }));
  }

  /**
   * Son tur da AYNI durumu ve AYNI sebebi mi kaydetmişti?
   *
   * Yalnız kaydı sessizleştirmek için: turun kendisi yine koşuyor, zincir yine kendini
   * zamanlıyor, ve disk geri takıldığı anda bir sonraki tur onu görüyor.
   */
  private async lastRunSaidTheSame(
    organizationId: string,
    targetId: string,
    outcome: RunOutcome,
  ): Promise<boolean> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ state: string; error: string | null }>(
        `SELECT state, error
           FROM public.backup_runs
          WHERE organization_id = $1 AND target_id = $2::uuid
          ORDER BY started_at DESC
          LIMIT 1`,
        [organizationId, targetId],
      ),
    );
    const last = rows[0];
    if (last === undefined) return false;
    return last.state === outcome.state && last.error === (outcome.error ?? null);
  }

  private async record(
    organizationId: string,
    targetId: string,
    trigger: 'zamanli' | 'elle',
    outcome: RunOutcome,
  ): Promise<void> {
    await this.db.withTenant(organizationId, (q) =>
      q.query(
        `INSERT INTO public.backup_runs
                (organization_id, target_id, trigger, state,
                 copied_files, copied_bytes, moved_files, error, finished_at)
         VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, now())`,
        [
          organizationId,
          targetId,
          trigger,
          // `devam` bir tur DURUMU değil, bir akış işareti: kayda `bitti` olarak giriyor çünkü
          // bu turda yapılanlar gerçekten yapıldı, ve devamı ayrı bir satır olacak.
          outcome.state === 'devam' ? 'bitti' : outcome.state,
          outcome.copiedFiles,
          outcome.copiedBytes,
          outcome.movedFiles,
          outcome.error ?? null,
        ],
      ),
    );
  }
}
