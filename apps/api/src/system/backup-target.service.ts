import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { AgentService, AgentUnavailableError, expectStatus } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';

/**
 * Geri getirmede bir çağrının taşıyacağı en fazla bayt.
 *
 * Kontrol soketi sıralı; dilim onu paylaşıyor. Sayı bir dosyanın ne kadar sürede geleceğini
 * değil, gelirken cihazın kullanılabilir kalıp kalmadığını belirliyor.
 */
const RESTORE_SLICE = 32 * 1024 * 1024;

/**
 * Diskin şifresiz yarısına konan düz Türkçe metin.
 *
 * ── BU METNİN VAR OLMA SEBEBİ ────────────────────────────────────────────────────────────────
 *
 * Cihazın sahibinin şartı: *"sistem diski ve depolama diski yansa bile yedek diski eğer şifre
 * biliniyorsa kullanılabilir olmalı."* Ürünün yolu terminalsiz ve dört tık; ama o yolun
 * çalışmasına bağlı OLMAYAN bir kaçış kapısı da olmalı — elinde hiç DEPSIS cihazı olmayan biri
 * için.
 *
 * Metin ŞİFRESİZ tarafta duruyor, yani diski herhangi bir bilgisayara takan herkes okuyor. Bu
 * yüzden içinde kullanıcı adı, kuruluş adı ya da paylaşım adı YOK: yalnız diskin ne olduğu ve
 * nasıl açılacağı.
 */
function okubeni(label: string): string {
  return [
    'BU BIR DEPSIS YEDEK DISKIDIR.',
    '',
    `Cihaz etiketi : ${label}`,
    '',
    'Dosyalariniz bu diskte SIFRELI bir ZFS veri kumesinde duruyor. Acmak icin sifreyi',
    'bilmeniz gerekiyor; DEPSIS onu hicbir yerde saklamiyor.',
    '',
    'EN KOLAY YOL',
    '  Diski bir DEPSIS cihazina takin, tarayicidan cihazin adresine gidin ve YEDEKLEME',
    '  ekraninda "Elimde bir yedek diski var" deyin. Ekran diski taniyacak, etiketini ve son',
    '  yedek tarihini gosterecek, sonra sifrenizi soracak. Terminale hic girmeniz gerekmiyor.',
    '',
    'DEPSIS CIHAZINIZ YOKSA',
    '  ZFS kurulu herhangi bir Linux bilgisayarda (ZFS 2.1 ve ustu):',
    '',
    '    sudo zpool import -f <havuz-adi>',
    '    sudo zfs load-key <havuz-adi>/veri',
    '    sudo zfs mount <havuz-adi>/veri',
    '',
    '  Havuz adini bu diskteki disk.json dosyasinda bulabilirsiniz. Ikinci komut sifrenizi',
    '  soracak.',
    '',
    'ICERIDE NE VAR',
    '  Dosyalar/<paylasim>/...              yedeklenen dosyalariniz',
    '  DEPSIS-YEDEK/silinenler/<tarih>/...  sildikleriniz, silindikleri gune gore',
    '  DEPSIS-YEDEK/gunluk/...              her yedekleme turunun ne yaptigi',
    '',
    'SIFRENIZI KAYBETTIYSENIZ bu diskteki hicbir dosya geri getirilemez. Bu bir kusur degil,',
    'diskin calinmasi durumunda dosyalarinizi koruyan seyin ta kendisi.',
    '',
  ].join('\n');
}

/** Yedek diski kurulmamış. */
export class NoBackupTargetError extends Error {
  constructor() {
    super('bu cihazda yedek diski kurulu değil');
    this.name = 'NoBackupTargetError';
  }
}

/** Ajanın söylediği sebep, kullanıcıya aynen gidiyor. */
export class BackupAgentRefusedError extends Error {
  constructor(readonly agentReason: string) {
    super(agentReason);
    this.name = 'BackupAgentRefusedError';
  }
}

export interface BackupTargetRow {
  id: string;
  pool: string;
  label: string;
  cadenceHours: number;
  retainDays: number;
  recoveryOnly: boolean;
  deviceId: string | null;
  enabled: boolean;
  /**
   * Son doğrulamanın sonucu — yedeğin gerçekten okunduğunun kaydı.
   *
   * `null`, HİÇ DOĞRULANMADI demek, "sağlam" demek değil. Ekranın bu ikisini ayırması gerekiyor:
   * yapılmamış bir ölçümü başarılı göstermek, doğrulamanın tamamını süse çevirir.
   */
  lastVerifiedAt: string | null;
  lastVerifyOk: boolean | null;
  /** Neyin ölçüldüğü: hangi dosya, ne kadarı okundu. "Doğrulandı" tek başına bir şey söylemiyor. */
  lastVerifyNote: string | null;
  lastScrubAt: string | null;
}

/** Hedef + diskin O ANKİ hâli, tek cevapta. */
export interface BackupTargetView extends BackupTargetRow {
  /** İki veri kümesi de yerinde mi. */
  prepared: boolean;
  /** Şifreli yarının anahtarı yüklü mü — yani disk açık mı. */
  unlocked: boolean;
  availableBytes: number;
  usedBytes: number;
}

/**
 * Yedek diski: kurulması, kilidi ve ayarları.
 *
 * ── DİSKİN DURUMU HER OKUMADA AJANA SORULUYOR ────────────────────────────────────────────────
 *
 * `unlocked` bir veritabanı sütunu DEĞİL, ve olmaması bilinçli. Parola hiçbir yere yazılmıyor,
 * yani cihaz her açıldığında disk kilitli oluyor; bir sütun tutmak, yeniden başlatmadan sonra
 * "açık" yazan ve kilitli olan bir kayıt üretirdi. Kilit ZFS'in bildiği bir şey, ve tek doğru
 * cevap ondan geliyor.
 *
 * Aynı sebeple `availableBytes` de saklanmıyor: yedek diskinin doluluğu her turda değişiyor, ve
 * eskimiş bir sayı "yeriniz var" diyen bir ekran demek.
 */
@Injectable()
export class BackupTargetService {
  private readonly logger = new Logger(BackupTargetService.name);

  constructor(
    private readonly db: DbService,
    private readonly agent: AgentService,
  ) {}

  /** Kurulu hedef, YOKSA null. Ajana sorulmuyor: satır yoksa sorulacak bir havuz da yok. */
  async row(organizationId: string): Promise<BackupTargetRow | null> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{
        id: string;
        pool: string;
        label: string;
        cadence_hours: number;
        retain_days: number;
        recovery_only: boolean;
        device_id: string | null;
        enabled: boolean;
        last_verified_at: Date | null;
        last_verify_ok: boolean | null;
        last_verify_note: string | null;
        last_scrub_at: Date | null;
      }>(
        `SELECT id::text AS id, pool, label, cadence_hours, retain_days,
                recovery_only, device_id, enabled,
                last_verified_at, last_verify_ok, last_verify_note, last_scrub_at
           FROM public.backup_targets`,
      ),
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      pool: row.pool,
      label: row.label,
      cadenceHours: row.cadence_hours,
      retainDays: row.retain_days,
      recoveryOnly: row.recovery_only,
      deviceId: row.device_id,
      enabled: row.enabled,
      lastVerifiedAt: row.last_verified_at?.toISOString() ?? null,
      lastVerifyOk: row.last_verify_ok,
      lastVerifyNote: row.last_verify_note,
      lastScrubAt: row.last_scrub_at?.toISOString() ?? null,
    };
  }

  /**
   * Hedef + diskin o anki hâli.
   *
   * AJANA ULAŞILAMAZSA HATA, sessiz bir varsayılan değil. "Disk kilitli" ile "ajana
   * ulaşamadım" farklı cümleler, ve ikincisini birincisi gibi göstermek kullanıcıya olmayan
   * bir parola ekranı açtırırdı.
   */
  async view(organizationId: string, correlationId: string): Promise<BackupTargetView | null> {
    const row = await this.row(organizationId);
    if (row === null) return null;

    const response = await this.agent.call(
      { op: 'backup_root_status', pool: row.pool },
      `yedek diskinin durumu (${row.pool})`,
      correlationId,
    );
    const status = expectStatus(response, 'backup_root');
    return {
      ...row,
      prepared: status.prepared,
      unlocked: status.key_loaded && status.mounted,
      availableBytes: Number(status.available_bytes),
      usedBytes: Number(status.used_bytes),
    };
  }

  /**
   * Var olan bir havuzu yedek diski hâline getirir.
   *
   * HAVUZU BU KURMUYOR. Diskleri silen tören (§8.1: analiz, adı yazarak onay, yeniden kimlik
   * doğrulama) havuz kurma akışında zaten var, ve onu ikinci kez burada yapmak töreni bir
   * formaliteye çevirirdi. Buraya gelen havuz, kullanıcının o töreni geçerek kurduğu havuz.
   *
   * SATIR AJANDAN SONRA YAZILIYOR. Tersi, diskte hiçbir şey yokken "yedek diskiniz hazır" diyen
   * bir satır bırakırdı — ve o satırı gören ekran, olmayan bir diske parola sorardı.
   */
  async prepare(
    organizationId: string,
    input: { pool: string; label: string; passphrase: string },
    correlationId: string,
  ): Promise<BackupTargetView> {
    const response = await this.agent.call(
      { op: 'prepare_backup_root', pool: input.pool, passphrase: input.passphrase },
      `yedek diski kuruluyor (${input.pool})`,
      correlationId,
    );
    if (response.status === 'refused') throw new BackupAgentRefusedError(response.reason);
    if (response.status === 'failed') throw new BackupAgentRefusedError(response.reason);
    const status = expectStatus(response, 'backup_root');

    await this.db.withTenant(organizationId, (q) =>
      q.query(
        `INSERT INTO public.backup_targets (organization_id, pool, label)
              VALUES ($1, $2, $3)
         ON CONFLICT (organization_id) DO UPDATE
            SET pool = EXCLUDED.pool, label = EXCLUDED.label, updated_at = now()`,
        [organizationId, input.pool, input.label],
      ),
    );
    this.logger.log(`yedek diski kuruldu: ${input.pool} (${input.label})`);
    // DİSKİN KENDİNİ ANLATAN YARISI, kurulumun parçası olarak. Sonraya bırakmak, ilk turdan
    // önce sökülen bir diskin hiçbir şey söyleyememesi demekti.
    await this.writeDiskDescription(organizationId, correlationId);

    const row = await this.row(organizationId);
    if (row === null) throw new Error('yedek hedefi yazıldı ama geri okunamadı');
    return {
      ...row,
      prepared: status.prepared,
      unlocked: status.key_loaded && status.mounted,
      availableBytes: Number(status.available_bytes),
      usedBytes: Number(status.used_bytes),
    };
  }

  /** Diskin kilidini açar. Parola hiçbir yere yazılmıyor — bu çağrıdan sonra kaybolur. */
  async unlock(
    organizationId: string,
    passphrase: string,
    correlationId: string,
  ): Promise<BackupTargetView> {
    const row = await this.row(organizationId);
    if (row === null) throw new NoBackupTargetError();

    const response = await this.agent.call(
      { op: 'load_backup_key', pool: row.pool, passphrase },
      `yedek diskinin kilidi açılıyor (${row.pool})`,
      correlationId,
    );
    if (response.status === 'refused' || response.status === 'failed') {
      // AJANIN CÜMLESİ AYNEN. Sahada bir yayım hatası "beklenmeyen hata" diye gösterildi ve
      // teşhis ancak cihaza SSH ile girilerek yapılabildi; aynı hatayı burada yapmıyoruz.
      throw new BackupAgentRefusedError(response.reason);
    }
    const status = expectStatus(response, 'backup_root');
    return {
      ...row,
      prepared: status.prepared,
      unlocked: status.key_loaded && status.mounted,
      availableBytes: Number(status.available_bytes),
      usedBytes: Number(status.used_bytes),
    };
  }

  /** Diski kilitler. Dosyalar okunamaz hâle gelir; yedekleme turu de duraklar. */
  async lock(organizationId: string, correlationId: string): Promise<BackupTargetView> {
    const row = await this.row(organizationId);
    if (row === null) throw new NoBackupTargetError();

    const response = await this.agent.call(
      { op: 'unload_backup_key', pool: row.pool },
      `yedek diski kilitleniyor (${row.pool})`,
      correlationId,
    );
    if (response.status === 'refused' || response.status === 'failed') {
      throw new BackupAgentRefusedError(response.reason);
    }
    const status = expectStatus(response, 'backup_root');
    return {
      ...row,
      prepared: status.prepared,
      unlocked: status.key_loaded && status.mounted,
      availableBytes: Number(status.available_bytes),
      usedBytes: Number(status.used_bytes),
    };
  }

  /**
   * Ritim ve saklama süresi — sahibinin değiştirebildiği iki sayı.
   *
   * SINIRLAR VERİTABANINDA, burada değil. `CHECK` kısıtları 0044'te yazılı ve orada olmaları
   * gerekiyor: burada bir kontrol, o kontrolü atlayan ikinci bir yazma yolunun açık kalması
   * demek. Buradaki iş yalnız hatayı kullanıcıya okunur bir cümleye çevirmek.
   */
  async update(
    organizationId: string,
    input: { cadenceHours?: number; retainDays?: number; label?: string; enabled?: boolean },
  ): Promise<BackupTargetRow> {
    const row = await this.row(organizationId);
    if (row === null) throw new NoBackupTargetError();

    await this.db.withTenant(organizationId, (q) =>
      q.query(
        `UPDATE public.backup_targets
            SET cadence_hours = COALESCE($2, cadence_hours),
                retain_days   = COALESCE($3, retain_days),
                label         = COALESCE($4, label),
                enabled       = COALESCE($5, enabled),
                updated_at    = now()
          -- RLS zaten kiracıya daraltıyor; bu satır o daraltmanın YERİNE değil, YANINDA.
          -- İkisinden birini kaldırmak, ötekini tek başına doğru olduğu için kaldırılabilir
          -- gösterir — ve bir gün ikisi birden gider.
          WHERE organization_id = $1`,
        [
          organizationId,
          input.cadenceHours ?? null,
          input.retainDays ?? null,
          input.label ?? null,
          input.enabled ?? null,
        ],
      ),
    );
    const updated = await this.row(organizationId);
    if (updated === null) throw new Error('yedek hedefi güncellendi ama geri okunamadı');
    return updated;
  }

  /**
   * Takılabilecek havuzlar — kurtarmanın ilk adımı.
   *
   * ── SAHİBİNİN ALTINCI ŞARTI ──────────────────────────────────────────────────────────────
   *
   * *"Sistem diski ve depolama diski yansa bile yedek diski eğer şifre biliniyorsa
   * kullanılabilir olmalı."* Bu, o cümlenin terminalsiz yarısı: yeni bir cihaza takılan diskte
   * ne olduğunu, hiçbir parola sorulmadan, ekranda göstermek.
   *
   * KURULUŞA BAĞLI DEĞİL, çünkü olamaz: takılan disk başka bir cihazın diski ve bu cihazın
   * veritabanında ona ait hiçbir satır yok. Yetki kontrolü denetleyicide, yönetici olma şartıyla.
   */
  async scanImportable(correlationId: string): Promise<{
    pools: { name: string; state: string; needsAdopt: boolean }[];
  }> {
    const response = await this.agent.call(
      { op: 'scan_importable_pools' },
      'takılabilecek havuzlar taranıyor',
      correlationId,
    );
    if (response.status === 'refused' || response.status === 'failed') {
      throw new BackupAgentRefusedError(response.reason);
    }
    const found = expectStatus(response, 'importable_pools');
    return {
      pools: found.pools.map((pool) => ({
        name: pool.name,
        state: pool.state,
        needsAdopt: pool.needs_adopt,
      })),
    };
  }

  /**
   * Başka bir cihazın yedek diskini bu cihaza tanıtır.
   *
   * ── PAROLA BURADA SORULMUYOR ─────────────────────────────────────────────────────────────
   *
   * Bu adım diski yalnız TANIYOR: havuzu hiçbir veri kümesini bağlamadan takıyor, DEPSIS yedek
   * diski olduğunu veri kümelerinin adlarından doğruluyor ve şifresiz yarısını okuyor. Dosyalar
   * hâlâ kilitli; onları açan şey bir sonraki adımda girilen parola.
   *
   * Ayrı iki adım olmasının sebebi kullanıcının gördüğü şey: parolayı sormadan önce ekranın
   * "bu, X etiketli cihazın 12 Ağustos'ta aldığı yedek" diyebilmesi gerekiyor. Yanlış diski
   * taktığını, parolasını yazdıktan sonra öğrenmemeli.
   *
   * ── SATIR KURTARMA KİPİNDE ───────────────────────────────────────────────────────────────
   *
   * `recovery_only`, ve bu bayrak bir ayar değil bir koruma: yedekleme turu bu diske YAZMIYOR.
   * Yazsaydı, başka bir cihazın yedeğini bu cihaza göre "düzeltir" — yani yeni cihazda henüz
   * olmayan her şeyi silinmiş sayıp silinenler klasörüne taşırdı, ki kurtarmaya gelen kişinin
   * geri almak istediği şey tam olarak o dosyalar.
   */
  async adopt(
    organizationId: string,
    input: { pool: string; adopt: boolean },
    correlationId: string,
  ): Promise<BackupTargetView & { lastBackupAt: string | null }> {
    // ZATEN BİR DİSK VARSA REDDEDİLİYOR. Ajan da reddediyor (iki havuzun bağlama noktaları
    // aynı), ama buradaki cümle kullanıcıya ne yapması gerektiğini söyleyen cümle.
    const existing = await this.row(organizationId);
    if (existing !== null) {
      throw new BackupAgentRefusedError(
        'bu cihazda zaten bir yedek diski kurulu; kurtarma için önce onu kaldırın',
      );
    }

    const response = await this.agent.call(
      { op: 'import_backup_pool', pool: input.pool, adopt: input.adopt },
      `yedek diski tanınıyor (${input.pool})`,
      correlationId,
    );
    if (response.status === 'refused' || response.status === 'failed') {
      throw new BackupAgentRefusedError(response.reason);
    }
    const status = expectStatus(response, 'backup_root');

    const described = await this.readDiskDescription(correlationId);
    const label = described?.etiket ?? input.pool;

    await this.db.withTenant(organizationId, (q) =>
      q.query(
        `INSERT INTO public.backup_targets
                (organization_id, pool, label, recovery_only, enabled, device_id)
              VALUES ($1, $2, $3, true, false, $4)`,
        [organizationId, input.pool, label, described?.cihazId ?? null],
      ),
    );
    this.logger.log(`kurtarma: ${input.pool} tanındı (${label})`);

    const row = await this.row(organizationId);
    if (row === null) throw new Error('kurtarma satırı yazıldı ama geri okunamadı');
    return {
      ...row,
      prepared: status.prepared,
      unlocked: status.key_loaded && status.mounted,
      availableBytes: Number(status.available_bytes),
      usedBytes: Number(status.used_bytes),
      lastBackupAt: described?.sonYedek ?? null,
    };
  }

  /**
   * Devralınan diski bırakır — fişini çekmeden önceki doğru adım.
   *
   * YALNIZ KURTARMA DİSKLERİ. Cihazın kendi yedek diskini bırakmak, ayarlarını da silmek olurdu;
   * onun karşılığı kilitlemek.
   */
  async release(organizationId: string, correlationId: string): Promise<void> {
    const row = await this.row(organizationId);
    if (row === null) throw new NoBackupTargetError();
    if (!row.recoveryOnly) {
      throw new BackupAgentRefusedError('bu cihazın kendi yedek diski; çıkarmak yerine kilitleyin');
    }

    const response = await this.agent.call(
      { op: 'export_backup_pool', pool: row.pool },
      `kurtarma diski bırakılıyor (${row.pool})`,
      correlationId,
    );
    if (response.status === 'refused' || response.status === 'failed') {
      throw new BackupAgentRefusedError(response.reason);
    }
    await this.db.withTenant(organizationId, (q) =>
      q.query(`DELETE FROM public.backup_targets WHERE id = $1::uuid`, [row.id]),
    );
    this.logger.log(`kurtarma diski bırakıldı: ${row.pool}`);
  }

  /**
   * Diskin şifresiz yarısındaki `disk.json`u okur.
   *
   * OKUNAMAMASI HATA DEĞİL. Dosya, diskin kendini anlatan yarısında ve orayı DEPSIS yazıyor —
   * ama v0.2.1'den önce kurulmuş bir diskte o yarı BOŞ. Böyle bir diski tanımayı reddetmek,
   * kurtarmayı tam da en çok gereken durumda çalışmaz kılardı; etiket yerine havuz adı gösterilip
   * devam ediliyor.
   */
  private async readDiskDescription(
    correlationId: string,
  ): Promise<{ etiket?: string; cihazId?: string; sonYedek?: string } | null> {
    try {
      const response = await this.agent.call(
        { op: 'backup_read_meta', name: 'disk.json' },
        'yedek diskinin açıklaması okunuyor',
        correlationId,
      );
      if (response.status === 'refused' || response.status === 'failed') return null;
      const file = expectStatus(response, 'meta_file');
      const parsed: unknown = JSON.parse(file.content);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      return {
        ...(typeof record['etiket'] === 'string' ? { etiket: record['etiket'] } : {}),
        ...(typeof record['cihazId'] === 'string' ? { cihazId: record['cihazId'] } : {}),
        ...(typeof record['sonYedek'] === 'string' ? { sonYedek: record['sonYedek'] } : {}),
      };
    } catch {
      // JSON bozuksa ya da ajan cevap vermediyse: etiketsiz devam. Diskin tanınması, açıklama
      // dosyasının sağlamlığına bağlı olmamalı.
      return null;
    }
  }

  /**
   * Diskin kendini anlatan yarısını yazar ya da tazeler.
   *
   * İKİ DOSYA, ve ikisi de PAROLA OLMADAN okunuyor:
   *
   *   `OKUBENI.txt`  düz Türkçe: bu disk nedir, nasıl açılır, içinde ne var.
   *   `disk.json`    etiket, havuz adı ve son yedek tarihi — kurulum sihirbazının okuduğu.
   *
   * İÇİNDE KİMLİK BİLGİSİ YOK. Kullanıcı adı, kuruluş adı, paylaşım adı yazılmıyor: bu dosyaları
   * diski eline geçiren herkes okuyor, ve sihirbazın parola sormadan gösterdiği kart da
   * buradan besleniyor.
   *
   * HER TURDAN SONRA TAZELENİYOR. "Son yedek" tarihi eskimiş bir diskte yanlış bir cümle olurdu,
   * ve yanmış bir cihazın diskini takan kişinin ekranda göreceği ilk şey o tarih.
   */
  async writeDiskDescription(
    organizationId: string,
    correlationId: string,
    lastBackupAt?: Date,
  ): Promise<void> {
    const row = await this.row(organizationId);
    if (row === null) return;

    const description = {
      depsis: 1,
      etiket: row.label,
      havuz: row.pool,
      cihazId: row.deviceId,
      sonYedek: (lastBackupAt ?? new Date()).toISOString(),
    };

    for (const [name, content] of [
      ['OKUBENI.txt', okubeni(row.label)],
      ['disk.json', `${JSON.stringify(description, null, 2)}\n`],
    ] as const) {
      const response = await this.agent.call(
        { op: 'backup_write_meta', name, content },
        `yedek diskinin açıklaması: ${name}`,
        correlationId,
      );
      // AÇIKLAMA YAZILAMAZSA TUR DÜŞMÜYOR. Yedeğin kendisi yazıldı; kendini anlatan yarının
      // eksik kalması ciddi ama yedeği geçersiz kılmıyor, ve bir turu bu yüzden başarısız
      // saymak kullanıcıya yedeği yokmuş gibi gösterirdi.
      if (response.status === 'refused' || response.status === 'failed') {
        this.logger.warn(`yedek diskinin açıklaması yazılamadı (${name}): ${response.reason}`);
        return;
      }
    }
  }

  /**
   * Yedek ağacında bir dizini listeler.
   *
   * ── NEDEN AYRI BİR GEZGİN ────────────────────────────────────────────────────────────────
   *
   * Sahibinin sözü: *"yedek diski tıpkı ana depolama gibi olmalı ama dosyalara yedekleme
   * kısmından erişilmeli."* Yedek bir arşiv değil, gezilebilen ikinci bir depolama — ve ona
   * paylaşımların gezgininden değil, YEDEKLEME ekranından giriliyor.
   *
   * Kök iki klasör gösteriyor ve ikisi de görünmeli: `Dosyalar/` gecikmeli ayna, `DEPSIS-YEDEK/`
   * ise defterin kendisi. Defteri gizlemek, silinme tarihlerini yalnız ürünün okuyabildiği bir
   * bilgiye çevirirdi — oysa onun diski başka bir bilgisayara takan insana da görünmesi, bu
   * tasarımın amacı.
   */
  async browse(
    organizationId: string,
    path: string[],
    correlationId: string,
  ): Promise<{ entries: unknown[]; truncated: boolean }> {
    const row = await this.row(organizationId);
    if (row === null) throw new NoBackupTargetError();

    const response = await this.agent.call(
      { op: 'backup_list_directory', path },
      `yedekte gezinme: ${path.join('/')}`,
      correlationId,
    );
    if (response.status === 'refused' || response.status === 'failed') {
      throw new BackupAgentRefusedError(response.reason);
    }
    if (response.status === 'not_found') return { entries: [], truncated: false };
    const listing = expectStatus(response, 'listing');
    return {
      entries: listing.entries.map((entry) => ({
        name: entry.name,
        directory: entry.directory,
        sizeBytes: Number(entry.size),
        modifiedAt: new Date(Number(entry.modified_unix) * 1000).toISOString(),
      })),
      truncated: listing.truncated,
    };
  }

  /**
   * Yedekteki bir dosyayı bir paylaşıma geri getirir.
   *
   * DİLİM DİLİM, ve döngü BURADA: ajanın bir çağrısı en fazla bir dilim taşıyor, çünkü kontrol
   * soketi sıralı ve elli gigabaytlık bir dosya o süre boyunca cihazdaki her şeyi durdururdu.
   *
   * HEDEFTE BİR DOSYA VARSA ÜSTÜNE YAZILMIYOR: ajan `Conflict` diyor ve o cümle kullanıcıya
   * aynen gidiyor. Kullanıcının hâlâ üzerinde çalıştığı bir dosyayı sessizce eskisiyle
   * değiştirmek, geri getirmenin çözmeye çalıştığı kaybın bir başkasını üretmek olurdu.
   */
  async restore(
    organizationId: string,
    input: { from: string[]; share: string; to: string[] },
    correlationId: string,
  ): Promise<{ restoredBytes: number }> {
    const row = await this.row(organizationId);
    if (row === null) throw new NoBackupTargetError();

    const staging = `geri-${randomUUID()}`;
    let offset = 0;
    for (;;) {
      const response = await this.agent.call(
        {
          op: 'restore_file_from_backup',
          from: input.from,
          share: input.share,
          to: input.to,
          staging_name: staging,
          offset,
          max_bytes: RESTORE_SLICE,
        },
        `yedekten geri getirme: ${input.from.join('/')}`,
        correlationId,
      );
      if (response.status === 'refused' || response.status === 'failed') {
        throw new BackupAgentRefusedError(response.reason);
      }
      if (response.status === 'not_found' || response.status === 'conflict') {
        throw new BackupAgentRefusedError(response.reason);
      }
      if (response.status === 'out_of_space') {
        throw new BackupAgentRefusedError(response.reason);
      }
      const copied = expectStatus(response, 'copied');
      offset = Number(copied.offset);
      if (copied.done) break;
    }
    return { restoredBytes: offset };
  }

  /**
   * Ajana ulaşılamıyor mu — ekranın "disk kilitli" ile "ajan yok" arasındaki farkı söyleyebilmesi
   * için.
   */
  static unavailable(error: unknown): error is AgentUnavailableError {
    return error instanceof AgentUnavailableError;
  }
}
