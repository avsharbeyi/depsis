import { Injectable } from '@nestjs/common';

import { DbService, type TenantQuery } from '../db/db.service.js';

/**
 * Bir denetim satırının yazılırkenki hâli.
 *
 * `actorId` null olabilir — kurulum talebi ve sistemin kendi işleri bir hesap adına değil — ama
 * `actorUsername` HİÇ boş olamaz: okunacak satırda boş bir "kim", sorunun kendisidir. Kimliği olan
 * aktörlerde ad, INSERT'in içindeki alt sorguyla hesaplardan okunur; buradaki değer yalnız hesabın
 * o anda bulunamaması hâlinde yedektir, yani çağıranın "sistem" gibi kimliksiz adlar dışında ad
 * uydurması gerekmez.
 */
export interface AuditEntry {
  actorId: string | null;
  actorUsername?: string;
  /** Noktalı eylem adı: `auth.login`, `user.role-changed`. Biçim veritabanında da kısıtlı. */
  action: string;
  target?: { kind: string; id: string; label?: string | null };
  /** Bir cümle, insan için. §16: parola, jeton, sır, dosya içeriği ASLA. */
  summary: string;
  correlationId?: string | null;
  /** Yalnız kimlik doğrulama olayları doldurur; gerekçe migration 0036'da. */
  ip?: string | null;
}

export interface AuditRow {
  id: string;
  actor_id: string | null;
  actor_username: string;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  target_label: string | null;
  summary: string;
  correlation_id: string | null;
  ip: string | null;
  created_at: Date;
}

/** Sayfa boyutunun tavanı; sözleşmedeki `limit` de aynı sayıyla sınırlı. */
const MAX_PAGE = 200;

/**
 * Cihazın denetim kaydı (migration 0036).
 *
 * ── yazmanın iki kipi, ve bugün hangisinin kullanıldığı ──
 *
 * `record` bir işlem tanıtıcısı (`TenantQuery`) alabiliyor; alan çağrıda satır, denetlediği
 * değişiklikle AYNI transaction'da yazılır ve geri alınan işlem kayıt bırakmaz — mekanizma
 * entegrasyon testiyle ölçülü. BUGÜNKÜ çağrı yerlerinin hiçbiri bu kipi kullanmıyor: her uç,
 * değişiklik kendi servisinin transaction'ında committed olduktan sonra kaydediyor, çünkü o
 * transaction servislerin içinde açılıp kapanıyor ve denetimi içine taşımak her servis imzasını
 * değiştirmek demek. Bu bir sıralama gerçeği ve buradan görünür olmalı: commit'ten SONRA düşen
 * bir denetim yazması, olmuş bir değişikliği kayıtsız bırakır ve istek hata döner.
 *
 * O pencereyi gerçekçi olarak açabilecek tek şey metin kısıtlarıydı — 500 karakterlik özet
 * sınırını aşan bir kullanıcı listesi — ve `clip` onu kapatıyor: alanlar tablonun CHECK
 * sınırlarına burada, üç nokta ile kırpılır. Geriye kalan hata sınıfı gerçek bir veritabanı
 * arızası, ve o YUTULMAZ: kaydın tutulamadığını söylemek, sessizce tutulmamış saymaktan iyidir.
 *
 * ── silme ve güncelleme YOK, burada bile ──
 *
 * Bu sınıfta bir `remove` ya da `redact` metodu bilerek yok. `depsis_app` rolünün UPDATE ve
 * DELETE yetkisi zaten yok (migration 0036), yani böyle bir metot yazılsa da çalışmazdı — ve
 * bunu ölçen entegrasyon testi var. Saklama politikası bir gün gerekirse, migration rolüyle
 * çalışan zamanlanmış bir işin konusu olur, bu sınıfın değil.
 */
@Injectable()
export class AuditService {
  constructor(private readonly db: DbService) {}

  async record(organizationId: string, entry: AuditEntry, db?: TenantQuery): Promise<void> {
    const summary = clip(entry.summary, 500);
    const label = entry.target?.label == null ? null : clip(entry.target.label, 255);
    const fallbackName = clip(entry.actorUsername ?? 'sistem', 128);
    const write = (q: TenantQuery): Promise<unknown> =>
      q.query(
        // Aktörün adı hesaplardan, YAZMA ANINDA. Ayrı bir ön sorgu iki ayrı an demek olurdu;
        // alt sorgu, satırla aynı anlık görüntüden okur. Hesap yoksa (kimliksiz aktör) yedek ad.
        `INSERT INTO public.audit_events
           (organization_id, actor_id, actor_username, action,
            target_kind, target_id, target_label, summary, correlation_id, ip)
         VALUES ($1, $2,
                 COALESCE((SELECT username FROM public.users
                            WHERE organization_id = $1 AND id = $2), $3),
                 $4, $5, $6, $7, $8, $9, $10)`,
        [
          organizationId,
          entry.actorId,
          fallbackName,
          entry.action,
          entry.target?.kind ?? null,
          entry.target?.id ?? null,
          label,
          summary,
          entry.correlationId ?? null,
          entry.ip ?? null,
        ],
      );

    if (db !== undefined) {
      await write(db);
      return;
    }
    await this.db.withTenant(organizationId, write);
  }

  /**
   * En yeni önce, imleçli.
   *
   * İmleç son görülen satırın `id`'si: uuidv7 zaman sıralı olduğu için `id < imleç` hem kararlı
   * hem tek sütunlu bir "daha eskiler" sorusudur. `created_at` üzerinden sayfalamak, aynı
   * milisaniyede yazılmış iki satırın sayfa sınırında yitmesi demek olurdu.
   */
  async list(
    organizationId: string,
    options: { before?: string | undefined; action?: string | undefined; limit: number },
  ): Promise<AuditRow[]> {
    const limit = Math.min(Math.max(options.limit, 1), MAX_PAGE);
    return this.db.withTenant(organizationId, (db) =>
      db.query<AuditRow>(
        `SELECT id::text             AS id,
                actor_id::text       AS actor_id,
                actor_username,
                action,
                target_kind,
                target_id,
                target_label,
                summary,
                correlation_id::text AS correlation_id,
                ip,
                created_at
           FROM public.audit_events
          WHERE organization_id = $1
            AND ($2::uuid IS NULL OR id < $2::uuid)
            AND ($3::text IS NULL OR action = $3 OR starts_with(action, $3 || '.'))
          ORDER BY id DESC
          LIMIT $4`,
        [organizationId, options.before ?? null, options.action ?? null, limit],
      ),
    );
  }
}

/**
 * Tablonun CHECK sınırına, üç noktayla.
 *
 * Kırpma SESSİZ bir kayıp değil, bilinçli bir sınır: özet zaten bir cümle olsun diye var, ve
 * taşan tek gerçekçi durum — bir izin değişikliğinin etkilediği herkesin adını saymak — sınıra
 * çarpıp satırı düşürmektense "…" ile bitmelidir. Satırı düşürmek, commit'ten sonra kaydeden
 * bugünkü çağrı yerlerinde OLMUŞ bir değişikliği kayıtsız bırakırdı.
 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
