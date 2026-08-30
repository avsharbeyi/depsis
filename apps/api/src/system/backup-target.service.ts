import { Injectable, Logger } from '@nestjs/common';

import { AgentService, AgentUnavailableError, expectStatus } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';

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
      }>(
        `SELECT id::text AS id, pool, label, cadence_hours, retain_days,
                recovery_only, device_id, enabled
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
   * Ajana ulaşılamıyor mu — ekranın "disk kilitli" ile "ajan yok" arasındaki farkı söyleyebilmesi
   * için.
   */
  static unavailable(error: unknown): error is AgentUnavailableError {
    return error instanceof AgentUnavailableError;
  }
}
