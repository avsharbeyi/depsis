import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { ProblemException } from '../common/problem.filter.js';
import { DbService } from '../db/db.service.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { PasswordService } from './password.service.js';

interface UserRow {
  username_folded: string;
  password_hash: string | null;
}

/**
 * "Prove you are still at the keyboard", for the operations that need it (§0.5).
 *
 * A SERVICE RATHER THAN A METHOD ON EACH CONTROLLER, and the reason is what a review found in the
 * two copies that existed before it: neither went through `LoginThrottleService`. `POST /console`
 * and `POST /storage/pools` each read `password_hash` and called `passwords.verify` directly, so
 * an attacker holding a stolen session cookie could guess the password against those routes at
 * full speed — no delay, no refusal after ten failures, and NOTHING in `login_attempts`, which is
 * the table an administrator would look at to find out it had happened.
 *
 * The login route has had that defence since ADR-0009. Two side doors past it is exactly the shape
 * of thing that gets written twice and reviewed once, so there is now one door.
 *
 * VE İKİ TANE DEĞİLLERMİŞ. Bu yorum "artık tek kapı var" derken dört tanesi daha duruyordu:
 * `POST /me/password`, `DELETE /me/mfa`, `POST /me/mfa/recovery-codes` ve `/users` altındaki
 * parola sıfırlama bileti ile hesap silme. Hepsi kendi `passwords.verify` çağrısını yapıyordu.
 * Dersin kendisi de burada: bu yorum, hiçbiri okunmadan doğru sayıldığı için dört tanesini
 * saymamıştı. Yeni bir parola kontrolü yazmak yerine bu servis çağrılır.
 *
 * WHY THE THROTTLE IS KEYED ON THE SAME PAIR as a login. A session already names the account, so
 * keying on the session would be the account lockout ADR-0009 rules out — an attacker with a
 * stolen cookie could lock the owner out of their own console at will. Keyed on (account, source
 * address), the victim signing in from their own address is unaffected. It also means a failed
 * re-authentication and a failed login count together, which is right: they are the same guess
 * against the same secret.
 */
@Injectable()
export class ReauthService {
  constructor(
    private readonly db: DbService,
    private readonly passwords: PasswordService,
    private readonly throttle: LoginThrottleService,
  ) {}

  /**
   * Throw unless `password` is this user's current password.
   *
   * Throws `UnauthorizedException` for a wrong password, for an account that has gone away, and
   * for one that has no password set. The caller does not distinguish them and must not: they are
   * all "you did not prove it".
   *
   * Kısıtlanmış bir çağıran ise 429 alır (aşağıdaki gerekçe), 401 değil — o "kanıtlayamadın"
   * değil, "şu an denemene bakmıyorum" demek, ve ikisini aynı cevaba katlamak sahibini yanlış
   * teşhise gönderiyordu.
   */
  async require(
    organizationId: string,
    userId: string,
    password: string,
    request: Request,
  ): Promise<void> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<UserRow>(`SELECT username_folded, password_hash FROM users WHERE id = $1`, [userId]),
    );
    const user = rows[0];
    // The guard resolved this session a moment ago, so a missing row means the account went away
    // in between. A dead session, not a server error.
    if (user === undefined) throw new UnauthorizedException();

    const ip = clientIp(request);
    const decision = await this.throttle.gate(user.username_folded, ip);
    if (!decision.allowed) {
      // ── ESKİDEN BURASI DA 401 DÖNÜYORDU, VE GEREKÇESİ TUTMUYORDU ─────────────────────────────
      //
      // Yorumu şuydu: "parola yanlışla aynı cevap, bilerek — ayrı bir 'kısıtlandın' cevabı
      // saldırgana tahminlerinin gerçek bir hesaba düştüğünü söyler". Bu yol için doğru değil.
      // Buraya gelen çağıran `SessionGuard`'dan geçmiş, yani hesabın var olduğunu ZATEN biliyor;
      // 429 ona bilmediği hiçbir şey söylemiyor. Söylediği tek şey sayacın dolduğu, ki o sayacı
      // kendisi doldurdu.
      //
      // Karşılığında ödenen bedel gerçekti: doğru parolayla gelen sahibi 15 dakika boyunca
      // "Parola hatalı." okuyor, parolasını yanlış hatırladığını sanıyor, ve beklemesi gerektiğini
      // hiçbir yerden öğrenemiyordu — /console, havuz kurma, disk sıfırlama, güncelleme, sertifika
      // ve çoğaltma ekranlarının hepsinde. Terminalsiz ürün kuralı kilit süresinin ekranda
      // görünmesini istiyor; `ProblemException.retryAfter` hem `Retry-After` başlığını hem
      // gövdedeki `retryAfter` alanını üretiyor, Türkçe `detail` ise 429'u ayrıca işlemeyen
      // ekranlarda da doğru cümleyi gösteriyor.
      //
      // Zamanlama eşitliği KORUNUYOR: bu dal Argon2 doğrulamasını yapmıyor, tıpkı eskisi gibi.
      const minutes = Math.ceil(decision.retryAfterSeconds / 60);
      throw new ProblemException(
        'rate-limited',
        `Çok fazla yanlış parola denemesi. ${minutes} dakika sonra yeniden deneyin — bu sayaç ` +
          'oturum açmayla ortaktır.',
        undefined,
        decision.retryAfterSeconds,
      );
    }

    // An account with NO password reaches here with `password_hash === null`. `PasswordService`
    // answers false for that, but only after doing the verify — so this is not a shortcut, it is
    // the reason the null is passed through rather than special-cased into an early return that
    // would skip recording the attempt.
    const ok = await this.passwords.verify(user.password_hash, password);
    await this.throttle.record(user.username_folded, ip, ok);
    if (!ok) throw new UnauthorizedException('the password is wrong');
  }
}

/**
 * The address the attempt came from.
 *
 * The same derivation `auth.controller.ts` uses, and it has the same caveat: `req.ip` honours
 * `X-Forwarded-For` only when Express is configured to trust a proxy, so behind an untrusted one
 * every attempt shares an address and the throttle becomes global rather than per-source. That is
 * the safe direction — it throttles more, not less.
 */
function clientIp(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? '0.0.0.0';
}
