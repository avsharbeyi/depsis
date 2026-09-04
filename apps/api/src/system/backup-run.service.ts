import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { AgentService, expectStatus } from '../agent/agent.service.js';
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
 * Her paylaşım için önce bir anlık görüntü alınıyor ve tur onun üstünde çalışıyor. Tur saatler
 * sürebilir; canlı ağacı okuyan bir tur, kendi çalışırken değişen dosyaları yarım kopyalar ve
 * hangi anı yedeklediğini söyleyemez.
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
      await this.record(organizationId, target.id, trigger, {
        state: 'kilitli',
        copiedFiles: 0,
        copiedBytes: 0,
        movedFiles: 0,
      });
      return { state: 'kilitli', copiedFiles: 0, copiedBytes: 0, movedFiles: 0 };
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
        total.state = outOfSpace ? 'yer-yok' : 'dustu';
        total.error = reason;
        this.logger.warn(`yedek turu '${share.name}' üzerinde düştü: ${reason}`);
        // ARIZALI PAYLAŞIM SIRADAKİLERİ YEDEKSİZ BIRAKMIYOR. Paylaşımlar ada göre sıralı geliyor,
        // yani buradaki `break` 'Fotograflar' bozulduğunda 'Videolar'ı da her turda sıraya
        // sokmuyordu — ve düzelene kadar o paylaşımın hiçbir dosyası yedeğe girmiyordu.
        //
        // 'yer yok' ayrı ve turu gerçekten bitiriyor: dolu bir diske sıradaki paylaşımı yazmayı
        // denemek, yarım dosyalar park etmekten başka bir şey yapmaz.
        if (outOfSpace) break;
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
    await this.ensureDirs(to.slice(0, -1), correlationId);

    // Aynı ada sahip DEĞİŞMİŞ bir dosya: hedefte eskisi duruyor ve ajan üstüne yazmıyor. Eski
    // sürümü silinenlere taşımak yerine kaldırmak, "değişen dosyanın eski hâli" ile "silinen
    // dosya" arasındaki farkı korumuyor — ama saklama sayacını da yanlış başlatmıyor.
    await this.agent.call(
      { op: 'backup_remove_entry', path: to, directory: false },
      `yedek turu: eski sürüm kaldırılıyor`,
      correlationId,
    );

    const staging = `yedek-${randomUUID()}`;
    let offset = 0;
    for (;;) {
      const response = await this.agent.call(
        {
          op: 'copy_file_to_backup',
          share: shareName,
          from: parts,
          to,
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
      purged += await this.removeTree([LEDGER, DELETED, day.name], correlationId);
    }
    if (purged > 0) {
      this.logger.log(`temizlik: ${purged} dosya kalıcı olarak silindi`);
    }
    return purged;
  }

  /** Bir ağacı yaprakları önce silerek kaldırır. Silinen DOSYA sayısını döndürür. */
  private async removeTree(path: string[], correlationId: string): Promise<number> {
    const listed = await this.agent.call(
      { op: 'backup_list_directory', path },
      'temizlik: dizin',
      correlationId,
    );
    if (listed.status === 'not_found') return 0;
    const listing = expectStatus(listed, 'listing');
    if (listing.truncated) {
      // Kesilmiş bir listeleme: dizinin tamamı silinemez, ve YARIM SİLMEK yerine hiç dokunmamak
      // doğru. Bir sonraki temizlik turu aynı dizini yeniden deniyor.
      this.logger.warn(`temizlik: '${path.join('/')}' tek listelemeye sığmadı, atlandı`);
      return 0;
    }

    let removed = 0;
    for (const entry of listing.entries) {
      const child = [...path, entry.name];
      if (entry.directory) {
        removed += await this.removeTree(child, correlationId);
      } else {
        await this.agent.call(
          { op: 'backup_remove_entry', path: child, directory: false },
          'temizlik: dosya',
          correlationId,
        );
        removed += 1;
      }
    }
    await this.agent.call(
      { op: 'backup_remove_entry', path, directory: true },
      'temizlik: dizin',
      correlationId,
    );
    return removed;
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
      return { ok: false, note: 'disk kilitli; doğrulama yapılamadı' };
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
    const note = result.identical
      ? `${name} okundu; ${howMuch} aslıyla aynı`
      : `${name} yedekte aslından FARKLI (asıl ${result.live_bytes} bayt, yedek ${result.backup_bytes} bayt)`;
    await this.recordVerification(organizationId, target.id, result.identical, note);
    if (!result.identical) this.logger.error(`yedek doğrulaması düştü: ${note}`);
    return { ok: result.identical, note };
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
