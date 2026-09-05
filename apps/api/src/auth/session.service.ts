import { Injectable } from '@nestjs/common';

import { DbService } from '../db/db.service.js';
import { generateToken, hashToken } from './token.js';

/** The organisation-level role, distinct from the per-node ACL (ADR-0004, migration 0009). */
export type UserRole = 'admin' | 'member';

export interface ResolvedSession {
  sessionId: string;
  organizationId: string;
  userId: string;
  /**
   * Read in the SAME statement that resolved the session, not fetched afterwards.
   *
   * A second query is a second moment in time: an administrator demoted between the two would
   * still be treated as one for the request already in flight.
   */
  role: UserRole;
  expiresAt: Date;
}

export interface IssuedSession {
  /** The only time the raw token exists outside the client. Goes straight into a cookie. */
  token: string;
  sessionId: string;
  expiresAt: Date;
}

interface ResolveRow {
  session_id: string;
  organization_id: string;
  user_id: string;
  role: string;
  expires_at: Date;
}

@Injectable()
export class SessionService {
  /**
   * Bir oturumun ömrü: BİR HAFTA.
   *
   * ── NEDEN ON İKİ SAAT DEĞİL ─────────────────────────────────────────────────────────────
   *
   * On iki saat "bir iş günü, bir ay değil" diye seçilmişti ve ADR-0009'un yenileme dönüşümünü
   * bekliyordu. Ama bu bir ofis uygulaması değil, evdeki bir cihaz: sahibi duvardaki dokunmatik
   * ekrandan, telefondan ve masaüstünden aynı kutuya bakıyor, ve on iki saat her sabah yeniden
   * parola girmek demekti. Sahibinin sözü: *"beni hatırla bütün oturumlarda çok kısa çalışıyor,
   * uzun süre hatırlayacak, 1 hafta falan."*
   *
   * ── BUNUN BEDELİ, VE NEDEN KABUL EDİLEBİLİR ─────────────────────────────────────────────
   *
   * Çalınan bir çerez artık on iki saat değil bir hafta yaşıyor. Karşılığında duran şeyler:
   * çerez `HttpOnly`, `Secure` ve `SameSite`; her satır iptal edilebiliyor ve kullanıcı kendi
   * cihazlarını `GET /me/sessions` ile görüp tek tek kapatabiliyor; parola değişimi bütün
   * oturumları düşürüyor. Yani "hatırla" uzun, ama unutturmanın yolu terminalsiz ve elde.
   *
   * MUTLAK, KAYAN DEĞİL. Kullanımla uzamıyor: bir hafta sonra herkes yeniden giriyor. Kayan bir
   * pencere, günde bir kez açılan bir tarayıcıda çalınmış bir çerezi sonsuza kadar yaşatırdı.
   */
  private static readonly LIFETIME_HOURS = 24 * 7;

  constructor(private readonly db: DbService) {}

  /**
   * Issue a session for a user who has already been authenticated.
   *
   * Runs inside the tenant context because `sessions` is tenant-scoped like everything else; only
   * the LOOKUP has to happen without one.
   */
  async issue(
    organizationId: string,
    userId: string,
    device: { userAgent: string | null; ip: string | null },
  ): Promise<IssuedSession> {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + SessionService.LIFETIME_HOURS * 3_600_000);

    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ id: string }>(
        `INSERT INTO sessions (organization_id, user_id, token_hash, user_agent, ip_address, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id::text AS id`,
        [
          organizationId,
          userId,
          hashToken(token),
          // Bounded to the column's CHECK rather than left to the database to reject: a 500 on a
          // long User-Agent would be a trivially triggerable failure of the login path.
          device.userAgent === null ? null : device.userAgent.slice(0, 512),
          device.ip,
          expiresAt,
        ],
      ),
    );

    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error('session insert returned no row');
    }
    return { token, sessionId: id, expiresAt };
  }

  /**
   * Turn a raw token into a tenant context, or nothing.
   *
   * The raw token never reaches the database — only its digest does — so it cannot appear in
   * `pg_stat_activity`, a slow-query log, or an error message. Expired, revoked and disabled-user
   * sessions all come back as `null`, indistinguishable from a token that never existed
   * (migration 0003).
   */
  async resolve(token: string): Promise<ResolvedSession | null> {
    const rows = await this.db.withoutTenant('resolve-session', (q) =>
      q.query<ResolveRow>(
        `SELECT session_id::text AS session_id,
                organization_id::text AS organization_id,
                user_id::text AS user_id,
                role,
                expires_at
           FROM public.resolve_session($1)`,
        [hashToken(token)],
      ),
    );

    const row = rows[0];
    if (row === undefined) return null;
    return {
      sessionId: row.session_id,
      organizationId: row.organization_id,
      userId: row.user_id,
      // Anything the database does not vouch for is a member. The CHECK constraint makes the third
      // value unreachable, so this is not a fallback anybody expects to see — it is the direction
      // an impossible value has to fail in.
      role: row.role === 'admin' ? 'admin' : 'member',
      expiresAt: row.expires_at,
    };
  }

  /**
   * Mark a session revoked. Not a DELETE: migration 0003 keeps the row so that an audit can tell
   * "revoked" apart from "never existed", and a retention job removes it later.
   */
  async revoke(organizationId: string, sessionId: string): Promise<void> {
    await this.db.withTenant(organizationId, (q) =>
      q.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [
        sessionId,
      ]),
    );
  }

  /**
   * Revoke every session a user holds.
   *
   * §16 requires that a security incident can end every session; this is the per-user half, and it
   * is what a password change must call.
   */
  async revokeAllForUser(organizationId: string, userId: string): Promise<number> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ n: string }>(
        `WITH revoked AS (
           UPDATE sessions SET revoked_at = now()
            WHERE user_id = $1 AND revoked_at IS NULL
            RETURNING 1
         )
         SELECT count(*)::text AS n FROM revoked`,
        [userId],
      ),
    );
    return Number(rows[0]?.n ?? '0');
  }

  /**
   * Move `last_seen_at` forward, for the device list ADR-0009 requires.
   *
   * Deliberately best-effort and fire-and-forget at the call site: a write on every authenticated
   * request is a cost, and failing to record "you were seen" must never fail the request itself.
   */
  async touch(organizationId: string, sessionId: string): Promise<void> {
    await this.db.withTenant(organizationId, (q) =>
      q.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [sessionId]),
    );
  }
}
