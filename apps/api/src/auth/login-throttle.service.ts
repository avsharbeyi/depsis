import { Injectable, Logger } from '@nestjs/common';

import { DbService } from '../db/db.service.js';

/**
 * Brute-force resistance for the login path.
 *
 * ADR-0009 is specific about the shape and about what it refuses: **not account lockout**. An
 * attacker who knows an address could otherwise lock its owner out at will, turning a brute-force
 * defence into a denial of service aimed at the victim. The counter is therefore keyed on the
 * combination of account and source address.
 *
 * Two refinements to the ADR's wording, made here because "increasing delay" alone has a failure
 * mode of its own:
 *
 *   * The delay is capped low (1 s). A server that sleeps five seconds per attempt is holding a
 *     connection and a pool slot for five seconds per attempt, which is a denial-of-service surface
 *     handed to the attacker rather than taken away.
 *   * Past a threshold the answer is an immediate refusal instead of a longer sleep. This does not
 *     reintroduce the lockout ADR-0009 rules out: the refusal is keyed on the PAIR, so the victim
 *     signing in from their own address is unaffected by an attacker hammering from theirs.
 *
 * Neither refinement has been measured under load, and §18.2's latency targets remain untested
 * across this project — so the numbers below are reasoned, not calibrated, and are marked as such.
 */
@Injectable()
export class LoginThrottleService {
  private readonly logger = new Logger(LoginThrottleService.name);

  /** How far back failures are counted. */
  private static readonly WINDOW_MINUTES = 15;

  /** Failures beyond this get a refusal rather than a delay. */
  private static readonly REFUSE_AFTER = 10;

  /** Upper bound on the sleep, in milliseconds. */
  private static readonly MAX_DELAY_MS = 1_000;

  constructor(private readonly db: DbService) {}

  /**
   * Count recent failures for this pair and apply the resulting delay.
   *
   * Returns `allowed: false` when the caller should refuse outright. The delay is applied HERE
   * rather than returned, so a caller cannot forget to honour it.
   *
   * ── NEDEN KALAN SÜREYİ DE DÖNDÜRÜYOR ────────────────────────────────────────────────────────
   *
   * Reddedilen deneme KAYDEDİLMİYOR (`AuthService.login` `gate` yanlış dönünce `record`
   * çağırmıyor), yani sayaç kendiliğinden azalmaz: bekleme, sayılan hatalardan EN YENİ ONUNCUSUNUN
   * 15 dakikalık pencereden çıkmasına kadar sürer. Bu, ekranda söylenmesi gereken tek sayı — ve
   * söylenmediği sürece kullanıcı "biraz bekle" deyip erken deniyor, hiçbir şey değişmiyor,
   * cihazın bozuk olduğunu sanıyor. Ürün kuralı gereği kilit süresi arayüzde görünmeli.
   */
  async gate(emailNormalized: string, ip: string): Promise<GateDecision> {
    const failures = await this.recentFailures(emailNormalized, ip);

    if (failures >= LoginThrottleService.REFUSE_AFTER) {
      this.logger.warn(`refusing login attempt after ${failures} recent failures from ${ip}`);
      return {
        allowed: false,
        retryAfterSeconds: await this.retryAfterSeconds(emailNormalized, ip),
      };
    }

    if (failures > 0) {
      // Doubling, capped. The first failure costs nothing, which keeps an ordinary typo cheap.
      const delay = Math.min(2 ** (failures - 1) * 50, LoginThrottleService.MAX_DELAY_MS);
      await sleep(delay);
    }

    return { allowed: true };
  }

  /**
   * Record the outcome of an attempt.
   *
   * Untenanted, and necessarily so: an attempt against a slug that does not exist has no tenant to
   * attribute it to, and the throttle has to work at exactly that point. Migration 0003 carries the
   * same reasoning for why the table has no `organization_id` and no policy.
   */
  async record(emailNormalized: string, ip: string, succeeded: boolean): Promise<void> {
    await this.db.withoutTenant('login-throttle', (q) =>
      q.query(
        `INSERT INTO login_attempts (email_normalized, ip_address, succeeded) VALUES ($1, $2, $3)`,
        [emailNormalized, ip, succeeded],
      ),
    );
  }

  /**
   * Kilidin ne zaman kalkacağı, saniye cinsinden.
   *
   * Sayılan hataların en yenisinden geriye `REFUSE_AFTER - 1` adım gidilir: eşiğin altına düşmek
   * için pencereden çıkması gereken satır tam odur. Ofset sabitten türetiliyor, elle yazılmıyor —
   * eşik değişince bu sorgunun sessizce yanlışlaşmasının yolu buydu.
   *
   * Yüklem sayımla birebir aynı (aynı çift, başarısız, aynı pencere), yoksa iki sorgu farklı
   * satır kümesine bakar ve gösterilen süre kilidin süresi olmaz. En az 1 saniyeye kırpılıyor:
   * satır tam sınırdayken ya da saat kayarken sıfır/negatif çıkabilir, ve "0 saniye bekleyin"
   * yazan bir ekran hiçbir şey söylememiş olur.
   */
  private async retryAfterSeconds(emailNormalized: string, ip: string): Promise<number> {
    const rows = await this.db.withoutTenant('login-throttle', (q) =>
      q.query<{ s: string }>(
        `SELECT ceil(
                  extract(epoch FROM (attempted_at + ($3 || ' minutes')::interval - now()))
                )::text AS s
           FROM login_attempts
          WHERE email_normalized = $1
            AND ip_address = $2
            AND NOT succeeded
            AND attempted_at > now() - ($3 || ' minutes')::interval
          ORDER BY attempted_at DESC
         OFFSET $4 LIMIT 1`,
        [
          emailNormalized,
          ip,
          String(LoginThrottleService.WINDOW_MINUTES),
          LoginThrottleService.REFUSE_AFTER - 1,
        ],
      ),
    );
    const seconds = Number(rows[0]?.s ?? '0');
    return Math.max(1, Number.isFinite(seconds) ? seconds : 1);
  }

  private async recentFailures(emailNormalized: string, ip: string): Promise<number> {
    const rows = await this.db.withoutTenant('login-throttle', (q) =>
      q.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM login_attempts
          WHERE email_normalized = $1
            AND ip_address = $2
            AND NOT succeeded
            AND attempted_at > now() - ($3 || ' minutes')::interval`,
        [emailNormalized, ip, String(LoginThrottleService.WINDOW_MINUTES)],
      ),
    );
    return Number(rows[0]?.n ?? '0');
  }
}

/**
 * `gate`'in cevabı. `retryAfterSeconds` yalnız reddedilen dalda dolu: izin verilen bir çağrının
 * bekleyeceği bir şey yok, ve `Retry-After` başlığına yazılacak bir sayı da yok.
 */
export type GateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
