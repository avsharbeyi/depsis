import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';

import type { AuthenticatedRequest } from '../auth/session.guard.js';
import { ProblemException } from './problem.filter.js';

/**
 * §14: "Rate limit kullanıcı + IP + eylem duyarlılığına göre."
 *
 * ── NE EKSİKTİ ───────────────────────────────────────────────────────────────────────────────
 *
 * Girişin kendi sayacı vardı (`LoginThrottleService`) ve akış sayısının bir tavanı vardı
 * (`EventsService.MAX_STREAMS`); geri kalan her uç sınırsızdı. Kimliği doğrulanmış SIRADAN bir
 * kullanıcı `GET /search?q=a` isteğini saniyede yüzlerce kez göndererek — her biri bir `pg_trgm`
 * taraması — kutuyu evdeki herkes için cevap veremez hâle getirebiliyordu. Tehdit modelinin TB1
 * hücresi bunu ismen istiyor.
 *
 * ── NEDEN NGINX'TE DEĞİL ─────────────────────────────────────────────────────────────────────
 *
 * `limit_req_zone $binary_remote_addr` burada YANLIŞ cevap: istek loopback'teki ters vekilden
 * geliyor, yani bütün ev tek bir adres olarak görünür ve ilk kurbanlar bir kişinin taşkınlığı
 * değil, herkesin paylaştığı bütçe olur. Kim olduğunu bilen tek yer burası — oturum kimliği
 * `SessionGuard`ta çözülmüş hâlde, ve muhafızlar araç katmanından ÖNCE koşuyor.
 *
 * ── ANAHTAR: KİM + NEREDEN + NE ──────────────────────────────────────────────────────────────
 *
 * Üçü birden, çünkü ikisi yetmiyor. Yalnız kullanıcı olsaydı oturumsuz uçlar sınırsız kalırdı;
 * yalnız adres olsaydı aynı evdeki iki kişi birbirinin bütçesini yerdi; yalnız yol olsaydı bir
 * kişinin taşkınlığı herkesi keserdi. Yoldaki kimlikler tek bir `:id`ye indirgeniyor, yoksa her
 * dosya kendi bütçesiyle gelirdi ve sınır hiç ısırmazdı.
 *
 * ── BÜTÇE CÖMERT, VE BU BİR TERCİH ───────────────────────────────────────────────────────────
 *
 * Dakikada 600 istek, yol başına. Sıradan kullanımın hiçbir yerine değmiyor — iki yüz küçük
 * resmi olan bir klasörü açmak tek bir yol anahtarında iki yüz istek demek, ve bir sınırın
 * çalışan bir ürünü bozması, olmayan bir sınırdan kötüdür. Bir kişinin tek bir uçtan saniyede
 * ondan fazla iş çıkarmasını engelliyor, ki DoS için gereken de bu.
 *
 * ── İKİ MUAFİYET, İKİSİ DE ADLA ──────────────────────────────────────────────────────────────
 *
 * `/events` uzun ömürlü tek bir bağlantı ve zaten `MAX_STREAMS` ile sayılı. Yükleme PATCH'leri
 * ise tanım gereği parça parça: on gigabaytlık bir dosya bu sayacın altında meşru olarak
 * binlerce istek eder, ve onu kesmek yüklemenin kendisini bozardı (ADR-0008).
 */
@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  /** Pencere uzunluğu ve pencere başına istek. */
  static readonly WINDOW_MS = 60_000;
  static readonly MAX_PER_WINDOW = 600;

  /**
   * Aynı anda kaç anahtar hatırlanıyor.
   *
   * Harita sadece bir sayaç: kaybetmenin bedeli bir pencerenin sıfırlanması. Bu yüzden tek tek
   * yaşlandırılmıyor, dolduğunda süresi geçmişler atılıyor — ve hepsi geçerliyse tamamen
   * boşaltılıyor. Sınırsız bir harita, sınırın kendisini bir bellek sızıntısına çevirirdi.
   */
  static readonly MAX_KEYS = 20_000;

  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const path = pathOf(request.url ?? '');
    if (isExempt(request.method ?? 'GET', path)) return next.handle();

    const who = request.depsis?.userId ?? 'anon';
    const where = request.ip ?? 'unknown';
    const what = `${request.method ?? 'GET'} ${normalise(path)}`;
    const retryAfter = this.take(`${who}|${where}|${what}`, Date.now());

    if (retryAfter !== null) {
      throw new ProblemException(
        'rate-limited',
        'Çok fazla istek gönderildi. Kısa bir süre bekleyip tekrar deneyin.',
        undefined,
        retryAfter,
      );
    }
    return next.handle();
  }

  /** Saniye cinsinden bekleme süresi, ya da izin verildiyse null. */
  private take(key: string, now: number): number | null {
    const window = this.windows.get(key);
    if (window === undefined || now >= window.resetAt) {
      if (this.windows.size >= RateLimitInterceptor.MAX_KEYS) this.forget(now);
      this.windows.set(key, { count: 1, resetAt: now + RateLimitInterceptor.WINDOW_MS });
      return null;
    }
    if (window.count >= RateLimitInterceptor.MAX_PER_WINDOW) {
      return Math.max(1, Math.ceil((window.resetAt - now) / 1000));
    }
    window.count += 1;
    return null;
  }

  private forget(now: number): void {
    for (const [key, window] of this.windows) {
      if (now >= window.resetAt) this.windows.delete(key);
    }
    if (this.windows.size >= RateLimitInterceptor.MAX_KEYS) this.windows.clear();
  }
}

/** Sorgu dizesi olmadan yol. Aynı ucun iki farklı sorgusu tek bir eylemdir. */
function pathOf(url: string): string {
  const at = url.indexOf('?');
  return at === -1 ? url : url.slice(0, at);
}

/**
 * Yoldaki kimlikleri `:id`ye indir.
 *
 * `Express`in `req.route`una bakmak yerine metnin kendisinden: araç katmanı yönlendiriciden önce
 * de koşabiliyor, ve o durumda `req.route` tanımsız olurdu. Bir kimlik yerinde bırakılsaydı her
 * dosya kendi bütçesiyle gelir ve sınır hiçbir zaman ısırmazdı.
 */
function normalise(path: string): string {
  return path
    .split('/')
    .map((segment) => (UUID.test(segment) || /^\d+$/.test(segment) ? ':id' : segment))
    .join('/');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bkz. sınıfın başındaki "iki muafiyet". */
function isExempt(method: string, path: string): boolean {
  if (path.includes('/events')) return true;
  if (method.toUpperCase() === 'PATCH' && path.includes('/uploads/')) return true;
  return false;
}
