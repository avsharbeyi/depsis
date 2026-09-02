import { Injectable, Logger } from '@nestjs/common';

import { AgentService, expectStatus } from '../agent/agent.service.js';
import { SecretBox, SecretDecryptionError } from '../auth/secret-box.js';
import { ntHash } from '../auth/nt-hash.js';
import { DbService, type TenantQuery } from '../db/db.service.js';
import { JobsService } from '../jobs/jobs.service.js';

/** The job kind that carries an identity sync. Exported so the worker's registry can name it. */
export const IDENTITY_SYNC_KIND = 'identity.sync';

/**
 * Bir hesabın SMB kimlik bilgisini düşüren işin türü.
 *
 * `identity.sync`ten AYRI, ve ayrı olmak zorunda: eşitleme istenen durumu gönderiyor ve hesaplar
 * için TOPLAYICI — listede olmayanı silmiyor. Kaldırmayı eşitlemeye yaptırmak, eşitlemenin
 * listede olmayan HER hesabı uçurması demek olurdu.
 *
 * PAYLOAD BİR AD TAŞIYOR, ve bu da eşitlemenin tersi: burada iş tek bir hesap hakkında. Eşitlemenin
 * payload'ı boş çünkü o bütün durumu okuyor; bunun payload'ı dolu çünkü hangi hesabın kesileceğini
 * başka söyleyecek bir şey yok.
 */
export const REVOKE_SMB_KIND = 'identity.revoke-smb';

/**
 * How many times the queue retries a sync before giving up.
 *
 * The same budget `permissions.apply` uses and for the same reason: the queue's default of five
 * spends thirty seconds in total, which does not survive an agent restart or a package upgrade —
 * and what is abandoned here is a user who cannot reach SMB, or worse, one who still can after
 * being removed from a team.
 */
export const IDENTITY_SYNC_MAX_ATTEMPTS = 20;

/** `key_version` for an AES-GCM envelope. Mirrors `KEY_VERSION_AES_GCM`; migration 0019 pins it. */
const SEALED = 1;

interface UserRow {
  id: string;
  username: string;
  posix_uid: number | null;
  nt_hash: Buffer | null;
  nt_hash_key_version: number | null;
}

interface TeamRow {
  id: string;
  posix_gid: number | null;
}

/**
 * The Unix side of DEPSIS's principals, and the SMB password that makes an account usable.
 *
 * WHY THIS EXISTS. `folder_grants` decides access, `AclApplyService` writes it to disk as POSIX
 * entries naming numeric gids, and `SecureShareRoot` closes the top of each share. All measured
 * working against a real smbd in `tools/poc/p2-a-smb-identity.sh` — and all reaching nobody,
 * because the numbers those entries name belonged to no account. This is what makes them real.
 *
 * TWO HALVES, and they are separate because they happen at different moments:
 *
 *   `rememberPassword` runs when a password is SET, which is the only instant the plaintext
 *   exists. It computes the NT hash and seals it.
 *
 *   `sync` runs whenever the desired state changes — a user created, a team's membership edited —
 *   and hands the agent the whole picture.
 *
 * DESIRED STATE, never a delta. The agent replaces group membership wholesale, which is what makes
 * a member who left a team actually leave the Unix group; an additive sync would let their ACL
 * access outlive the grant that justified it. It also makes this idempotent, which the at-least-
 * once queue requires (§17).
 */
@Injectable()
export class IdentitySyncService {
  private readonly logger = new Logger(IdentitySyncService.name);

  constructor(
    private readonly db: DbService,
    private readonly agent: AgentService,
    /**
     * Null when `DEPSIS_SECRET_KEY_FILE` is unset.
     *
     * The same posture `MfaService` takes: without a key the feature refuses rather than storing
     * the secret in the clear. An NT hash is password-equivalent for one protocol, so a plaintext
     * fallback would be a database backup that hands out SMB access.
     */
    private readonly secrets: SecretBox | null,
    /** Queues the sync. See `enqueue` — the work never happens in the request. */
    private readonly jobs: JobsService,
  ) {}

  /**
   * Ask for a sync, without waiting for one.
   *
   * UNCONDITIONALLY, with no `agent.isAvailable()` check, and that is the lesson of this round
   * rather than an oversight. Enqueuing is an INSERT; the worker is a different process with its
   * own agent connection and its own retries; and `AgentService.available` is a startup latch that
   * never recovers. A guard here would mean a user created during an agent restart never got a
   * Unix account at all — exactly the failure the ACL enqueue sites had.
   *
   * A failure to enqueue is LOGGED, not thrown. The change the caller made — a new account, a
   * membership edit — has already committed and is correct; refusing it after the fact would be
   * worse than a filesystem that is briefly behind.
   */
  /**
   * Bir hesabın SMB kimlik bilgisini düşürmeyi kuyruğa verir.
   *
   * İSTEK İÇİNDEKİ DENEME BAŞARISIZ OLDUĞUNDA çağrılıyor, onun yerine değil: kapatmanın anlamı
   * erişimin HEMEN kesilmesi, ve kuyruk yalnız ajanın o an ulaşılamaz olduğu durumun ağı.
   *
   * Hata burada da yutuluyor, `enqueue` ile aynı gerekçeyle: hesap zaten kapandı ve web tarafı
   * güvende. Kuyruğa yazamamak, kapatmayı geri almak için bir sebep değil.
   */
  async enqueueRevokeSmb(organizationId: string, username: string): Promise<void> {
    try {
      await this.jobs.enqueue(
        organizationId,
        REVOKE_SMB_KIND,
        { username },
        { maxAttempts: IDENTITY_SYNC_MAX_ATTEMPTS },
      );
    } catch (error) {
      this.logger.error(
        `could not queue the SMB revocation for '${username}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Kuyruktan gelen düşürme. `UsersService.revokeSmb` ile aynı çağrı, aynı kabul kümesi.
   *
   * İDEMPOTENT, ve at-least-once bir kuyruk bunu gerektiriyor (§17): zaten düşürülmüş bir kimlik
   * bilgisinde `pdbedit -x` sıfırdan farklı dönüyor ve ajan onu başarı sayıyor — istenen şey
   * hesabın SMB'ye girememesi, ve giremiyor.
   */
  async revokeSmbNow(username: string, reason: string): Promise<void> {
    const response = await this.agent.call(
      { op: 'revoke_smb_credential', login: username },
      reason,
    );
    if (response.status === 'smb_credential_revoked' || response.status === 'smb_unavailable') {
      return;
    }
    throw new Error(
      'reason' in response && typeof response.reason === 'string'
        ? response.reason
        : response.status,
    );
  }

  async enqueue(organizationId: string, why: string): Promise<void> {
    try {
      await this.jobs.enqueue(
        organizationId,
        IDENTITY_SYNC_KIND,
        {},
        { maxAttempts: IDENTITY_SYNC_MAX_ATTEMPTS },
      );
    } catch (error) {
      this.logger.error(
        `${why} committed but the identity sync could not be queued: ` +
          `${error instanceof Error ? error.message : String(error)}. The Unix accounts and ` +
          `groups on this box no longer match the tenant's principals.`,
      );
    }
  }

  /**
   * Compute and seal the NT hash for a password that is being set.
   *
   * CALLED WITH THE PLAINTEXT, at the one moment it exists — account creation, an administrator
   * resetting a password, a user changing their own. Nothing else in the system can produce this:
   * Argon2 is one-way, so a hash that is not captured here can never be recovered.
   *
   * IN THE CALLER'S TRANSACTION, always. Passing the query handle rather than opening one means
   * the NT hash and the Argon2 hash land together or not at all — a commit that stored one and
   * lost the other would leave a user whose web password and SMB password disagree, with nothing
   * recording which is which.
   *
   * Does nothing when there is no key, and says so once rather than per call: the account still
   * works everywhere except SMB, which is the honest degradation.
   */
  async rememberPassword(
    q: TenantQuery,
    organizationId: string,
    userId: string,
    password: string,
  ): Promise<void> {
    if (this.secrets === null) {
      this.logger.warn(
        `no secret key is configured, so no SMB credential was stored for ${userId}; the account ` +
          `works everywhere except SMB`,
      );
      return;
    }
    // The hash is computed and sealed without ever being logged, returned, or written anywhere
    // else. `ntHash` carries its own MD4 because Node's crypto cannot: OpenSSL 3 moved MD4 to the
    // legacy provider.
    const sealed = this.secrets.seal(Buffer.from(ntHash(password), 'ascii'), {
      userId,
      organizationId,
    });
    await q.query(
      `UPDATE public.users
          SET nt_hash = $3, nt_hash_key_version = $4
        WHERE organization_id = $1 AND id = $2`,
      [organizationId, userId, sealed, SEALED],
    );
  }

  /**
   * Hand the agent the whole desired state for one tenant.
   *
   * Every user with a POSIX uid and every team with a POSIX gid, plus the membership between them.
   * A principal with no id yet is LEFT OUT rather than allocated one here: allocation belongs to
   * `PosixIdentityService`, which writes it in the same transaction as the row that needs it, and
   * inventing one here would spend a number nothing records.
   */
  async sync(organizationId: string, reason: string): Promise<void> {
    const plan = await this.db.withTenant(organizationId, async (q) => {
      const users = await q.query<UserRow>(
        `SELECT id::text AS id, username, posix_uid, nt_hash, nt_hash_key_version
           FROM public.users
          WHERE organization_id = $1 AND posix_uid IS NOT NULL AND disabled_at IS NULL
          ORDER BY posix_uid`,
        [organizationId],
      );
      const teams = await q.query<TeamRow>(
        `SELECT id::text AS id, posix_gid
           FROM public.teams
          WHERE organization_id = $1 AND posix_gid IS NOT NULL
          ORDER BY posix_gid`,
        [organizationId],
      );
      const members = await q.query<{ team_id: string; user_id: string }>(
        `SELECT team_id::text AS team_id, user_id::text AS user_id
           FROM public.team_members
          WHERE organization_id = $1`,
        [organizationId],
      );
      return { users, teams, members };
    });

    const uidOf = new Map(plan.users.map((row) => [row.id, row.posix_uid]));

    const users = plan.users.map((row) => {
      const hash = this.unseal(organizationId, row);
      return {
        uid: row.posix_uid as number,
        login: row.username,
        // Omitted rather than null when there is none: the agent's `nt_hash` is optional and an
        // absent one leaves whatever password the account already had. A user who has not changed
        // their password since this feature existed simply has no SMB access yet.
        ...(hash === null ? {} : { nt_hash: hash }),
      };
    });

    const groups = plan.teams.map((team) => ({
      gid: team.posix_gid as number,
      members: plan.members
        .filter((m) => m.team_id === team.id)
        .map((m) => uidOf.get(m.user_id))
        .filter((uid): uid is number => typeof uid === 'number'),
    }));

    if (users.length === 0 && groups.length === 0) return;

    expectStatus(
      await this.agent.call({ op: 'sync_posix_identity', users, groups }, reason),
      'posix_identity_synced',
    );
  }

  /**
   * Open one user's sealed NT hash, or report that it cannot be used.
   *
   * A row that will not open is NOT an error that fails the sync. The usual cause is the key file
   * having been replaced, and the right answer is that this one account loses SMB until its
   * password is set again — not that every other account in the tenant stops being synced too.
   */
  private unseal(organizationId: string, row: UserRow): string | null {
    if (row.nt_hash === null || row.nt_hash_key_version === null) return null;
    if (this.secrets === null) {
      this.logger.warn(
        `user ${row.id} has a sealed SMB credential and no key is configured to open it`,
      );
      return null;
    }
    try {
      return this.secrets.open(row.nt_hash, { userId: row.id, organizationId }).toString('ascii');
    } catch (error) {
      this.logger.error(
        `could not open the SMB credential for ${row.id}: ` +
          `${error instanceof SecretDecryptionError ? error.message : String(error)}. ` +
          `That account keeps its old SMB password until it is set again.`,
      );
      return null;
    }
  }
}
