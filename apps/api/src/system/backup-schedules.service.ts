import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';

import { AgentService } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import { JobsService } from '../jobs/jobs.service.js';

/** İş kuyruğundaki tür. Üretici ve tüketici aynı sabiti okuyor. */
export const BACKUP_TICK_KIND = 'storage.backup-tick';

/**
 * Turlar arası aralık.
 *
 * Beş dakika, ve iki yönden de savunulabilir olması gerekiyordu. Daha sık olsaydı boş dönen bir
 * sorgu günde binlerce kez koşardı; daha seyrek olsaydı "03:00'te" diyen bir zamanlama 03:14'te
 * koşabilirdi, ve bir insan için o ikisi aynı şey değil.
 */
export const TICK_INTERVAL_MS = 5 * 60_000;

/**
 * Bir doğrulamanın ne kadar eskiyebileceği.
 *
 * Yirmi dört saat, ve daha sık olması bir şey kazandırmıyordu: doğrulanan şey en yeni görüntü, ve
 * en yeni görüntü günde bir kez değişiyor (saatlik bir zamanlamada daha sık, ama o durumda da
 * arızanın türü aynı kalıyor — bir görüntü açılamıyorsa bir sonraki de açılamaz).
 */
export const VERIFY_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * Veritabanı dökümleri arası aralık, ve kaç tane saklanacağı.
 *
 * Günde bir, ve on dört tane: iki hafta geriye gitmek, bir yapılandırma hatasının fark edilmesi
 * için gereken süreden uzun. Döküm sıkıştırılmış ve bir ev NAS'ının veritabanı megabaytlar
 * mertebesinde, yani on dört tanesi disk sorunu değil.
 */
export const DUMP_INTERVAL_MS = 24 * 60 * 60_000;
export const DUMP_KEEP = 14;

export type Cadence = 'hourly' | 'daily' | 'weekly';

export interface ScheduleRow {
  id: string;
  dataset: string;
  label: string;
  cadence: Cadence;
  at_hour: number | null;
  at_minute: number;
  weekday: number | null;
  keep: number;
  replicate_target: string | null;
  offsite_host: string | null;
  offsite_port: number | null;
  offsite_user: string | null;
  enabled: boolean;
  next_run_at: Date;
  last_run_at: Date | null;
  last_result: string | null;
  /** Artımlı gönderimin tabanı: en son BAŞARIYLA çoğaltılmış görüntü. */
  last_replicated_snapshot: string | null;
  last_verified_at: Date | null;
  last_verify_result: string | null;
}

export interface ScheduleInput {
  dataset: string;
  label: string;
  cadence: Cadence;
  atHour: number | null;
  atMinute: number;
  weekday: number | null;
  keep: number;
  replicateTarget: string | null;
  offsite: { host: string; port: number; user: string } | null;
  enabled: boolean;
}

/**
 * Bir zamanlamanın aldığı görüntülerin ön eki.
 *
 * BUDAMANIN GÜVENLİK ÖZELLİĞİ BU. Saklama politikası yalnız bu ön ekle başlayan görüntülere
 * dokunuyor, yani elle alınmış bir görüntü, başka bir aracın aldığı, ya da başka bir ritmin aldığı
 * asla silinmiyor. Ön eki ritim taşıyor çünkü aynı veri kümesinde saatlik ve günlük iki zamanlama
 * olabilir, ve birinin saklama sayısı ötekinin görüntülerini saymamalı.
 */
export function prefixFor(cadence: Cadence): string {
  return `depsis-${cadence}-`;
}

/** `depsis-daily-20260826T030000Z`. Bir `SafeComponent`: iki nokta üst üste yok. */
export function snapshotNameFor(cadence: Cadence, when: Date): string {
  const iso = when
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d+Z$/u, 'Z');
  return `${prefixFor(cadence)}${iso}`;
}

/**
 * Hangi görüntüler silinecek: bu zamanlamanın, en yenisi hariç `keep` tanesi hariç.
 *
 * SAF, ve saf olması ölçülebilmesi için. Silinen şey geri gelmiyor, ve bu fonksiyonun tek işi
 * "hangileri" sorusuna cevap vermek — bir ajan çağrısıyla iç içe yazılsaydı, doğruluğu ancak
 * gerçek bir havuza karşı ölçülebilirdi.
 *
 * ÖN EKİ OLMAYAN HİÇBİR ŞEY DÖNMÜYOR, ve bu tek cümlelik kural bu dosyanın en önemli satırı.
 * Elle alınmış bir görüntüyü silen bir budama, veri kaybının fark edilmeyen biçimi olurdu:
 * kullanıcı onu ancak ihtiyaç duyduğu gün arar.
 */
export function prunable(
  snapshots: readonly { name: string; createdAt: Date }[],
  cadence: Cadence,
  keep: number,
): string[] {
  const prefix = prefixFor(cadence);
  const mine = snapshots.filter((snapshot) => snapshot.name.startsWith(prefix));
  // En yeniden en eskiye. Eşit zaman damgalarında ada göre — iki görüntü aynı saniyede alınmış
  // olabilir, ve tanımsız bir sıra "hangisi silinecek" sorusunu çalıştırmaya bırakır.
  const ordered = [...mine].sort((a, b) => {
    const byTime = b.createdAt.getTime() - a.createdAt.getTime();
    return byTime !== 0 ? byTime : b.name.localeCompare(a.name);
  });
  // En eskiden başlayarak silinsin: bir budama yarıda kalırsa, kalan şey en yeniler olsun.
  return ordered
    .slice(keep)
    .map((snapshot) => snapshot.name)
    .reverse();
}

/**
 * Bir sonraki koşu zamanı, `from`'dan KESİN OLARAK SONRA.
 *
 * Kesinlik önemli: eşitliğe izin verilseydi, tam zamanında koşan bir tur kendi zamanını yeniden
 * hesaplayıp aynı anı bulur, ve zamanlama sonsuza kadar aynı dakikada koşardı.
 *
 * YEREL SAAT, UTC değil. "Gece üçte" diyen kullanıcı cihazın saatini kastediyor; UTC'de hesaplamak
 * yazın ve kışın farklı saatlerde koşan bir zamanlama üretirdi.
 */
export function nextRun(
  cadence: Cadence,
  atHour: number | null,
  atMinute: number,
  weekday: number | null,
  from: Date,
): Date {
  const at = new Date(from);
  at.setSeconds(0, 0);

  if (cadence === 'hourly') {
    at.setMinutes(atMinute);
    if (at <= from) at.setTime(at.getTime() + 60 * 60_000);
    return at;
  }

  at.setHours(atHour ?? 0, atMinute);
  if (cadence === 'daily') {
    if (at <= from) at.setDate(at.getDate() + 1);
    return at;
  }

  // Haftalık: doğru güne ilerle, sonra gerekiyorsa bir hafta daha.
  const wanted = weekday ?? 0;
  const shift = (wanted - at.getDay() + 7) % 7;
  at.setDate(at.getDate() + shift);
  if (at <= from) at.setDate(at.getDate() + 7);
  return at;
}

/**
 * Zamanlanmış yedekler: alınmayan yedeğin çaresi.
 *
 * Bir NAS'ın verisini kaybetme yolu bozuk bir yedekleme değil, ALINMAMIŞ bir yedek — ve alınmamış
 * olmasının sebebi neredeyse her zaman birinin bir düğmeye basmayı unutması. Görüntü Faz 1'den,
 * çoğaltma Faz 2'den beri var; üçünün de ortak eksiği kendiliğinden koşmamalarıydı.
 *
 * ZİNCİR, `setInterval` DEĞİL. Her tur bir sonrakini kuyruğa alıyor, `job_queue.run_after` ile —
 * bu üründeki tek dayanıklı zamanlayıcı. Bir `setInterval` yalnız o süreç ayaktayken çalışır ve
 * yeniden başlatmada kaybolur; kaybolduğunu kimse fark etmez, çünkü eksik olan şey bir yedeğin
 * YOKLUĞU, ve o ancak ihtiyaç duyulduğu gün aranır.
 */
@Injectable()
export class BackupSchedulesService {
  private readonly logger = new Logger(BackupSchedulesService.name);

  constructor(
    private readonly db: DbService,
    private readonly agent: AgentService,
    private readonly jobs: JobsService,
  ) {}

  /**
   * Açılışta her kiracı için bir tur tohumla.
   *
   * `ON CONFLICT DO NOTHING` ile: zaten bekleyen bir tur varken hiçbir şey yapmıyor, yani her
   * açılışta boşa dönen bir INSERT. Tohum olmasaydı, zincirin bir kez kopması onu kalıcı olarak
   * durdururdu — ve duran bir yedekleme zamanlaması hiçbir alarm üretmez.
   */
  async onModuleInit(): Promise<void> {
    try {
      const organizations = await this.organizationsWithSchedules();
      for (const organizationId of organizations) {
        await this.scheduleTick(organizationId, new Date());
      }
      if (organizations.length > 0) {
        this.logger.log(`backup tick scheduled for ${organizations.length} organisation(s)`);
      }
    } catch (error) {
      this.logger.error(
        `could not seed the backup schedule tick: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Etkin zamanlaması olan kiracılar.
   *
   * KİRACILAR ÖNCE, sonra her biri KENDİ bağlamında. Eskiden tablo doğrudan `withoutTenant` ile
   * okunuyordu ve kiracıya ait: RLS bağlamsız sorguya sıfır satır döndürüyor, hata vermiyor, ve
   * bu zincir gerçek bir cihazda hiç kurulmuyordu. Bkz. `DbService.tenantIds`.
   */
  private async organizationsWithSchedules(): Promise<string[]> {
    const found: string[] = [];
    for (const organizationId of await this.db.tenantIds()) {
      const rows = await this.db.withTenant(organizationId, (q) =>
        q.query<{ id: string }>(
          `SELECT 1::text AS id FROM public.backup_schedules WHERE enabled LIMIT 1`,
        ),
      );
      if (rows.length > 0) found.push(organizationId);
    }
    return found;
  }

  async scheduleTick(organizationId: string, runAfter: Date): Promise<void> {
    await this.db.withTenant(organizationId, (db) =>
      db.query(
        `INSERT INTO public.job_queue (organization_id, kind, payload, run_after, max_attempts)
         VALUES ($1, $2, '{}'::jsonb, $3, 3)
         ON CONFLICT DO NOTHING`,
        [organizationId, BACKUP_TICK_KIND, runAfter],
      ),
    );
  }

  /**
   * Bir çoğaltmanın sonucunu zamanlamaya yaz — artımlı gönderimin tabanı bu.
   *
   * BAŞARIDA görüntünün adı, BAŞARISIZLIKTA `null`. İkincisi bilerek kaba: kopmuş bir gönderimden
   * sonra hedefin ne tuttuğu bu taraftan bilinmiyor, ve olmayan bir tabana dayanan artımlı bir
   * akış reddedilir — yani bir sonraki tur da başarısız olurdu, ve sonraki de. Bir fazladan tam
   * gönderim, sessizce hiç çoğaltmayan bir zamanlamadan ucuz.
   *
   * İşleyiciden çağrılıyor, buradan değil: çoğaltma bir İŞ, ve saatler sonra bitiyor.
   */
  async recordReplicated(
    organizationId: string,
    scheduleId: string,
    snapshot: string | null,
  ): Promise<void> {
    await this.db.withTenant(organizationId, (db) =>
      db.query(
        `UPDATE public.backup_schedules
            SET last_replicated_snapshot = $3, updated_at = now()
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, scheduleId, snapshot],
      ),
    );
  }

  async list(organizationId: string): Promise<ScheduleRow[]> {
    return this.db.withTenant(organizationId, (db) =>
      db.query<ScheduleRow>(
        `SELECT id::text AS id, dataset, label, cadence, at_hour, at_minute, weekday, keep,
                replicate_target, offsite_host, offsite_port, offsite_user, enabled,
                next_run_at, last_run_at, last_result, last_replicated_snapshot,
                last_verified_at, last_verify_result
           FROM public.backup_schedules
          ORDER BY label`,
      ),
    );
  }

  async create(organizationId: string, userId: string, input: ScheduleInput): Promise<ScheduleRow> {
    const next = nextRun(input.cadence, input.atHour, input.atMinute, input.weekday, new Date());
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<ScheduleRow>(
        `INSERT INTO public.backup_schedules
                (organization_id, dataset, label, cadence, at_hour, at_minute, weekday, keep,
                 replicate_target, offsite_host, offsite_port, offsite_user, enabled,
                 next_run_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id::text AS id, dataset, label, cadence, at_hour, at_minute, weekday, keep,
                   replicate_target, offsite_host, offsite_port, offsite_user, enabled,
                   next_run_at, last_run_at, last_result, last_replicated_snapshot,
                last_verified_at, last_verify_result`,
        [
          organizationId,
          input.dataset,
          input.label,
          input.cadence,
          input.atHour,
          input.atMinute,
          input.weekday,
          input.keep,
          input.replicateTarget,
          input.offsite?.host ?? null,
          input.offsite?.port ?? null,
          input.offsite?.user ?? null,
          input.enabled,
          next,
          userId,
        ],
      ),
    );
    const created = rows[0];
    if (created === undefined) throw new Error('the schedule was not written');
    // İlk turu HEMEN tohumla: yeni bir zamanlama ekleyen biri, zincirin çoktan durmuş olduğu bir
    // kutuda onun hiç koşmadığını ancak yedek gerektiğinde öğrenirdi.
    await this.scheduleTick(organizationId, new Date());
    return created;
  }

  async update(
    organizationId: string,
    id: string,
    input: ScheduleInput,
  ): Promise<ScheduleRow | null> {
    const next = nextRun(input.cadence, input.atHour, input.atMinute, input.weekday, new Date());
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<ScheduleRow>(
        `UPDATE public.backup_schedules
            SET dataset = $3, label = $4, cadence = $5, at_hour = $6, at_minute = $7,
                weekday = $8, keep = $9, replicate_target = $10, offsite_host = $11,
                offsite_port = $12, offsite_user = $13, enabled = $14, next_run_at = $15,
                updated_at = now()
          WHERE organization_id = $1 AND id = $2
         RETURNING id::text AS id, dataset, label, cadence, at_hour, at_minute, weekday, keep,
                   replicate_target, offsite_host, offsite_port, offsite_user, enabled,
                   next_run_at, last_run_at, last_result, last_replicated_snapshot,
                last_verified_at, last_verify_result`,
        [
          organizationId,
          id,
          input.dataset,
          input.label,
          input.cadence,
          input.atHour,
          input.atMinute,
          input.weekday,
          input.keep,
          input.replicateTarget,
          input.offsite?.host ?? null,
          input.offsite?.port ?? null,
          input.offsite?.user ?? null,
          input.enabled,
          next,
        ],
      ),
    );
    return rows[0] ?? null;
  }

  async remove(organizationId: string, id: string): Promise<boolean> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ id: string }>(
        `DELETE FROM public.backup_schedules
          WHERE organization_id = $1 AND id = $2
         RETURNING id::text AS id`,
        [organizationId, id],
      ),
    );
    // Silmek, ALDIĞI GÖRÜNTÜLERİ SİLMİYOR. Bir zamanlamayı kapatmak "artık yenisini alma" demek,
    // "elimdekileri at" demek değil — ve iki anlamı birbirine karıştıran bir silme düğmesi, bir
    // kullanıcının bütün yedek geçmişini bir tıkla götürürdü.
    return rows.length > 0;
  }

  /**
   * Vakti gelmiş her zamanlamayı koştur.
   *
   * SIRA HER SATIRDA AYNI: görüntü al, çoğaltmayı kuyruğa al, buda, zamanı ilerlet. Budama
   * görüntüden SONRA, çünkü yeni görüntü sayıya dahil — önce budasaydık `keep` her turda bir fazla
   * tutardı.
   *
   * ZAMAN HER DURUMDA İLERLİYOR, başarısızlıkta da. İlerlemeseydi, kalıcı olarak başarısız olan bir
   * zamanlama (silinmiş bir veri kümesi, dolu bir havuz) her turda yeniden denenirdi ve turun
   * kendisi hiç bitmezdi. Ne olduğu `last_result`'a yazılıyor, ve ekranın "en son ne oldu"
   * sorusunun cevabı orası.
   */
  async runDue(organizationId: string, now: Date): Promise<{ ran: number; failed: number }> {
    const due = await this.db.withTenant(organizationId, (db) =>
      db.query<ScheduleRow>(
        `SELECT id::text AS id, dataset, label, cadence, at_hour, at_minute, weekday, keep,
                replicate_target, offsite_host, offsite_port, offsite_user, enabled,
                next_run_at, last_run_at, last_result, last_replicated_snapshot,
                last_verified_at, last_verify_result
           FROM public.backup_schedules
          WHERE organization_id = $1 AND enabled AND next_run_at <= $2
          ORDER BY next_run_at
          LIMIT 50`,
        [organizationId, now],
      ),
    );

    let ran = 0;
    let failed = 0;
    for (const schedule of due) {
      let result = 'ok';
      try {
        await this.runOne(organizationId, schedule, now);
        ran += 1;
      } catch (error) {
        failed += 1;
        result = error instanceof Error ? error.message.slice(0, 500) : 'bilinmeyen hata';
        this.logger.warn(`schedule ${schedule.label} failed: ${result}`);
      }
      await this.advance(organizationId, schedule, now, result);
    }
    return { ran, failed };
  }

  /**
   * Yedekleri DOĞRULA: en yeni görüntü duruyor mu, açılıyor mu, boş mu.
   *
   * HİÇ GERİ YÜKLENMEMİŞ BİR YEDEK, YEDEK DEĞİLDİR. `last_result` bir tek şeyi söylüyor —
   * `zfs snapshot` komutunun hata vermediğini. Söylemediği şey o görüntünün AÇILABİLİR olduğu, ve
   * bir yedeğin sessizce işe yaramaz olmasının yolları tam olarak orada: kabuktan silinmiş bir
   * görüntü, mount edilemeyen bir görüntü, ve boş bir görüntü. Üçü de "yedeğim var" diyen birini,
   * olmadığını ihtiyaç duyduğu gün öğrenen birine çeviriyor.
   *
   * NE KANITLADIĞI, VE NE KANITLAMADIĞI — ikisi de yazılmalı, çünkü "doğrulandı" diyen ama yalnız
   * satır sayan bir alan, kapalı görünüp hiçbir şey tutmayan bir kapı olur. Bu kontrol görüntünün
   * havuzda DURDUĞUNU, açılıp LİSTELENEBİLDİĞİNİ ve BOŞ OLMADIĞINI gösteriyor. Baytların sağlam
   * olduğunu göstermiyor; onu ZFS'in sağlama toplamları ve `zpool scrub` yapıyor.
   *
   * İKİ SEVİYE, ve hangisinin koştuğu cümlede yazıyor. Veri kümesi bir PAYLAŞIMIN kümesiyse
   * görüntünün kökü gerçekten listeleniyor — ajanın `.zfs/snapshot/<ad>` yürüyüşü, yani mount
   * sınırının geçilebildiğinin kanıtı. Değilse yalnız havuzun envanterine bakılıyor: paylaşım
   * olmayan bir veri kümesinin içine bakmanın yolu yok, ve varmış gibi yapmak yanlış olurdu.
   *
   * TUR BAŞINA BİR TANE. Doğrulama bir mount tetikliyor ve her turda her zamanlama için koşması
   * gereksiz; en eski doğrulanmış olan sıraya giriyor.
   */
  async verifyOne(organizationId: string, now: Date): Promise<string | null> {
    const stale = new Date(now.getTime() - VERIFY_INTERVAL_MS);
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<ScheduleRow>(
        `SELECT id::text AS id, dataset, label, cadence, at_hour, at_minute, weekday, keep,
                replicate_target, offsite_host, offsite_port, offsite_user, enabled,
                next_run_at, last_run_at, last_result, last_replicated_snapshot,
                last_verified_at, last_verify_result
           FROM public.backup_schedules
          WHERE organization_id = $1
            AND enabled
            AND (last_verified_at IS NULL OR last_verified_at < $2)
          ORDER BY last_verified_at NULLS FIRST
          LIMIT 1`,
        [organizationId, stale],
      ),
    );
    const schedule = rows[0];
    if (schedule === undefined) return null;

    let result: string;
    try {
      result = await this.verify(organizationId, schedule);
    } catch (error) {
      result = error instanceof Error ? error.message.slice(0, 500) : 'bilinmeyen hata';
    }

    await this.db.withTenant(organizationId, (db) =>
      db.query(
        `UPDATE public.backup_schedules
            SET last_verified_at = $3, last_verify_result = $4, updated_at = now()
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, schedule.id, now, result],
      ),
    );
    return result;
  }

  private async verify(organizationId: string, schedule: ScheduleRow): Promise<string> {
    const correlationId = randomUUID();

    const listed = await this.agent.call(
      { op: 'list_snapshots', dataset: schedule.dataset },
      `verifying ${schedule.label}`,
      correlationId,
    );
    if (listed.status !== 'snapshots') {
      return `havuz sorulamadı: ajan '${listed.status}' cevabı verdi`;
    }
    if (listed.missing) {
      // THE FAILURE THIS EXISTS FOR. `last_result` still says the last run succeeded, and the
      // dataset it wrote into is gone.
      return `${schedule.dataset} artık yok — bu zamanlamanın yedeği kalmadı`;
    }

    const prefix = prefixFor(schedule.cadence);
    const mine = listed.snapshots
      .filter((snapshot) => snapshot.name.startsWith(prefix))
      .sort((a, b) => b.created_at - a.created_at);
    const newest = mine[0];
    if (newest === undefined) {
      return `havuzda bu zamanlamanın hiçbir görüntüsü yok`;
    }

    // Paylaşım mı? Öyleyse görüntünün İÇİNE bakılabiliyor.
    const shares = await this.db.withTenant(organizationId, (db) =>
      db.query<{ name: string }>(
        `SELECT name FROM public.shares WHERE organization_id = $1 AND dataset = $2 LIMIT 1`,
        [organizationId, schedule.dataset],
      ),
    );
    const share = shares[0]?.name;
    if (share === undefined) {
      return `${newest.name} havuzda duruyor (içine bakılmadı: bu veri kümesi bir paylaşım değil)`;
    }

    const entries = await this.agent.call(
      { op: 'snapshot_entries', share, snapshot: newest.name, path: [] },
      `verifying ${schedule.label}: opening ${newest.name}`,
      correlationId,
    );
    if (entries.status === 'refused' || entries.status === 'not_found') {
      const reason = 'reason' in entries ? entries.reason : 'bilinmiyor';
      return `${newest.name} AÇILAMADI: ${reason}`;
    }
    if (entries.status !== 'listing') {
      return `${newest.name} açılamadı: ajan '${entries.status}' cevabı verdi`;
    }
    if (entries.entries.length === 0) {
      // Bir görüntü boş olabilir ve bu bazen doğrudur — ama bir YEDEK için neredeyse hiçbir zaman
      // değil, ve sessizce "başarılı" demek yedeği olduğunu sanan birini o hâlde bırakmak olurdu.
      return `${newest.name} açıldı ama BOŞ — bu veri kümesinde yedeklenecek bir şey var mı?`;
    }
    return `${newest.name} açıldı, ${entries.entries.length} öğe okundu`;
  }

  /**
   * Cihazın KENDİ verisini yedekle: hesaplar, paylaşımlar, izinler, dosya dizini.
   *
   * ZFS anlık görüntüleri kullanıcının DOSYALARINI koruyor. Korumadığı şey, o dosyaların kime ait
   * olduğu — hepsi PostgreSQL'de, ve PostgreSQL sistem diskinde. Sistem diski ölürse havuzdaki her
   * bayt duruyor ve onlara kimin erişebileceğini söyleyen hiçbir şey kalmıyor.
   *
   * `docs/operations/03-yedekleme.md` bunun için elle bir `pg_dump` tarif ediyordu, ve elle
   * başlatılan bir yedek alınmayan bir yedektir.
   *
   * DURUM DOSYA SİSTEMİNDE, veritabanında değil. "En son ne zaman döküm alındı" sorusunun cevabı
   * dizindeki en yeni dosyanın tarihi; bir kolonda tutulsaydı, kabuktan silinmiş bir dökümden
   * sonra o kolon yalan söylerdi. Aynı gerekçe yedek listesinin havuzdan okunmasında da geçerli.
   *
   * `null` dönüyor: vakti gelmediyse, ya da ajan bu kutuda döküm alamıyorsa (bağlantı dizesi
   * yapılandırılmamış). İkincisi sessiz DEĞİL — `GET /storage/database-backups` onu söylüyor, ve
   * ekran hiç döküm yokken bunu yüksek sesle gösteriyor.
   */
  async dumpDatabaseIfDue(now: Date): Promise<string | null> {
    const correlationId = randomUUID();
    const listed = await this.agent.call(
      { op: 'list_database_dumps' },
      'checking when the database was last dumped',
      correlationId,
    );
    if (listed.status !== 'database_dumps') return null;

    const newest = listed.dumps[0];
    if (newest !== undefined && now.getTime() - newest.created_unix * 1000 < DUMP_INTERVAL_MS) {
      return null;
    }

    // `SafeComponent`: iki nokta üst üste yok, bölü yok. Anlık görüntü adlarıyla aynı biçim.
    const name = `depsis-${now
      .toISOString()
      .replace(/[-:]/gu, '')
      .replace(/\.\d+Z$/u, 'Z')}`;
    const dumped = await this.agent.call(
      { op: 'dump_database', name, keep: DUMP_KEEP },
      'the daily dump of the appliance database',
      correlationId,
    );
    if (dumped.status !== 'database_dumps') {
      // Reddedildiyse sebebi taşınıyor: neredeyse her zaman "bağlantı dizesi yapılandırılmamış",
      // ve o cümle yöneticinin yapacağı şeyi söylüyor.
      return `veritabanı dökümü alınamadı: ${'reason' in dumped ? dumped.reason : dumped.status}`;
    }
    // AYNI TURDA, ve aynı dizine: cihazın kendi durumunun ikinci yarısı. Veritabanı hesapları
    // ve izinleri taşıyor; bu, o cihazın ZeroTier'de KİM OLDUĞUNU. İkincisi kaybedilirse geri
    // gelmiyor — bir ağ kimliğinin üst 40 biti, onu yöneten düğümün adresinin ta kendisi.
    const identity = await this.agent.call(
      { op: 'backup_node_identity', name, keep: DUMP_KEEP },
      'the daily archive of the ZeroTier identity and controller state',
      correlationId,
    );
    const note =
      identity.status !== 'node_identity_backed_up'
        ? ' (ZeroTier durumu arşivlenemedi)'
        : identity.included.length === 0
          ? '' // ZeroTier kurulu değil: arşivlenecek bir şey yok, ve bu bir arıza değil.
          : identity.unreadable.length > 0
            ? ` (ZeroTier durumu arşivlendi; ${String(
                identity.unreadable.length,
              )} kayıt OKUNAMADI: ${identity.unreadable.join(', ')})`
            : ' (ZeroTier durumu da arşivlendi)';

    return `veritabanı dökümü alındı: ${name} (${String(dumped.dumps.length)} döküm saklanıyor)${note}`;
  }

  private async runOne(organizationId: string, schedule: ScheduleRow, now: Date): Promise<void> {
    const name = snapshotNameFor(schedule.cadence, now);
    const correlationId = randomUUID();

    const created = await this.agent.call(
      { op: 'create_snapshot', dataset: schedule.dataset, name },
      `scheduled snapshot for ${schedule.label}`,
      correlationId,
    );
    if (created.status !== 'snapshot') {
      throw new Error(
        `ajan bir görüntü yerine '${created.status}' cevabı verdi` +
          ('reason' in created ? `: ${String(created.reason)}` : ''),
      );
    }

    await this.enqueueReplication(organizationId, schedule, name);
    await this.prune(schedule, correlationId);
  }

  /**
   * Çoğaltma bir İŞ, bu turun içinde değil.
   *
   * Bir terabaytı taşımak saatler sürüyor, ve turun kendisi beş dakikada bir koşuyor: gönderimi
   * burada beklemek, zamanlayıcıyı bir gecelik transferin arkasına almak olurdu.
   *
   * §8.1'in yazılı onayı ve yeniden kimlik doğrulaması ZAMANLAMA KURULURKEN yapıldı. Her gece
   * parola sormak, bir zamanlamanın olmaması demek olurdu.
   */
  private async enqueueReplication(
    organizationId: string,
    schedule: ScheduleRow,
    snapshot: string,
  ): Promise<void> {
    if (schedule.replicate_target !== null) {
      await this.jobs.enqueue(
        organizationId,
        'storage.replicate',
        {
          source: schedule.dataset,
          snapshot,
          target: schedule.replicate_target,
          // ARTIMLI, en son başarıyla gönderilen görüntüden. İlk turda ve başarısız bir turdan
          // sonra `null` — yani tam gönderim. Her tur tam gönderseydi, bir terabaytlık bir
          // paylaşım her gece bir terabayt taşırdı.
          base: schedule.last_replicated_snapshot,
          // Hangi zamanlamaya ait olduğu: iş bitince tabanı GÜNCELLEYEN şey bu.
          scheduleId: schedule.id,
          requestedBy: null,
        },
        { maxAttempts: 1 },
      );
      return;
    }
    if (schedule.offsite_host !== null && schedule.offsite_user !== null) {
      await this.jobs.enqueue(
        organizationId,
        'storage.replicate-offsite',
        {
          source: schedule.dataset,
          snapshot,
          base: schedule.last_replicated_snapshot,
          host: schedule.offsite_host,
          port: schedule.offsite_port ?? 22,
          user: schedule.offsite_user,
          target: schedule.dataset,
          scheduleId: schedule.id,
          requestedBy: null,
        },
        { maxAttempts: 1 },
      );
    }
  }

  /**
   * Fazlalıkları sil — ve YALNIZ bu zamanlamanın aldıklarını.
   *
   * Envanter havuzdan okunuyor, DEPSIS'in kendi kaydından değil: kabuktan silinmiş bir görüntüyü
   * saymak, saklama sayısını olduğundan büyük gösterip budamayı hiç çalıştırmamak olurdu.
   */
  private async prune(schedule: ScheduleRow, correlationId: string): Promise<void> {
    const listed = await this.agent.call(
      { op: 'list_snapshots', dataset: schedule.dataset },
      `pruning ${schedule.label}`,
      correlationId,
    );
    if (listed.status !== 'snapshots') return;

    const inventory = listed.snapshots.map((snapshot) => ({
      name: snapshot.name,
      createdAt: new Date(snapshot.created_at * 1000),
    }));

    for (const name of prunable(inventory, schedule.cadence, schedule.keep)) {
      const gone = await this.agent.call(
        { op: 'destroy_snapshot', dataset: schedule.dataset, snapshot: name },
        `pruning ${schedule.label}: ${schedule.dataset}@${name}`,
        correlationId,
      );
      if (gone.status !== 'snapshot_destroyed') {
        // Bir görüntünün silinememesi turu durdurmuyor: klonu ya da tutamağı olabilir, ve o bir
        // kullanıcı kararı. Ama sessizce geçilmiyor — havuz doluyorsa sebebi günlükte olsun.
        this.logger.warn(
          `could not prune ${schedule.dataset}@${name}: the agent answered '${gone.status}'`,
        );
      }
    }
  }

  private async advance(
    organizationId: string,
    schedule: ScheduleRow,
    now: Date,
    result: string,
  ): Promise<void> {
    const next = nextRun(
      schedule.cadence,
      schedule.at_hour,
      schedule.at_minute,
      schedule.weekday,
      now,
    );
    await this.db.withTenant(organizationId, (db) =>
      db.query(
        `UPDATE public.backup_schedules
            SET next_run_at = $3, last_run_at = $4, last_result = $5, updated_at = now()
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, schedule.id, next, now, result],
      ),
    );
  }
}
