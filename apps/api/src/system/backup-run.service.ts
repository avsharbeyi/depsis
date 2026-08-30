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

    for (const share of shares) {
      if (total.copiedFiles >= MAX_FILES_PER_RUN) {
        // BİTMEDİ, DEVAM EDECEK. Ardılı kuyruğa alan taraf işleyici; burada söylenen tek şey
        // turun kapanmadığı.
        total.state = 'devam';
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
        if (!done) total.state = 'devam';
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // YER YOK, kendi durumu: kullanıcının yapacağı şey farklı (disk değiştirmek ya da
        // saklama süresini kısaltmak) ve yeniden denemek dolu diske yarım dosyalar park etmekten
        // başka bir şey yapmaz.
        const outOfSpace = reason.includes('yer yok') || reason.includes('yer kalmadı');
        total.state = outOfSpace ? 'yer-yok' : 'dustu';
        total.error = reason;
        this.logger.warn(`yedek turu '${share.name}' üzerinde düştü: ${reason}`);
        break;
      }
    }

    await this.record(organizationId, target.id, trigger, total);
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
    const snapshot = `depsis-yedek-${Date.now()}`;
    expectStatus(
      await this.agent.call(
        { op: 'create_snapshot', dataset: share.dataset, name: snapshot },
        `yedek turu: '${share.name}' için an dondu`,
        correlationId,
      ),
      'snapshot',
    );

    const base = await this.baseOf(organizationId, share.id);
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
      this.logger.warn(`'${share.name}' değişiklik listesi kesildi; sonraki tur baştan yürüyecek`);
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
    return true;
  }

  /**
   * İlk tur: paylaşımın ağacını yürüyüp her dosyayı kopyalar.
   *
   * ÖZYİNELEME BURADA, AJANDA DEĞİL. Ajanın işlem kümesinde özyinelemeli hiçbir şey yok ve
   * olmamalı: kök yetkiyle koşan bir süreçte ağacın ne kadarına dokunulacağını çağıran taraf
   * seçemez. Ağacı yürüyen taraf, ağacı zaten bilen taraf.
   *
   * KESİLMİŞ BİR LİSTELEME ATLANMIYOR, hata veriyor: eksik olan her satır yedeklenmeyen bir
   * dosya, ve ilk turda o dosyaların bir daha sorulacağı yer yok — taban yazıldıktan sonra
   * yalnız DEĞİŞENLER geliyor, ve hiç kopyalanmamış bir dosya bir daha değişmeyebilir.
   */
  private async walkAndCopy(
    shareName: string,
    path: string[],
    total: RunOutcome,
    correlationId: string,
  ): Promise<void> {
    const response = await this.agent.call(
      { op: 'list_directory', share: shareName, path },
      `ilk yedek turu: ${shareName}/${path.join('/')}`,
      correlationId,
    );
    // Bu arada silinmiş bir dizin: olağan, ve atlanıyor.
    if (response.status === 'not_found') return;
    const listing = expectStatus(response, 'listing');
    if (listing.truncated) {
      throw new Error(
        `'${shareName}/${path.join('/')}' dizini tek listelemeye sığmadı; ilk yedek eksik kalırdı`,
      );
    }

    for (const entry of listing.entries) {
      const child = [...path, entry.name];
      if (entry.directory) {
        await this.walkAndCopy(shareName, child, total, correlationId);
      } else {
        await this.copyOne(shareName, child, total, correlationId);
      }
    }
  }

  /** Bir dosyayı yedeğe kopyalar, gerekirse üst dizinleri açarak. */
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
  async onModuleInit(): Promise<void> {
    try {
      const rows = await this.db.withoutTenant('migration-status', (q) =>
        q.query<{ id: string }>(
          `SELECT organization_id::text AS id FROM public.backup_targets WHERE enabled`,
        ),
      );
      for (const row of rows) {
        await this.scheduleNext(row.id, new Date());
        await this.schedulePurge(row.id, new Date());
      }
      if (rows.length > 0) {
        this.logger.log(`yedek turu ${rows.length} kiracı için tohumlandı`);
      }
    } catch (error) {
      this.logger.error(
        `yedek turu zinciri tohumlanamadı: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
