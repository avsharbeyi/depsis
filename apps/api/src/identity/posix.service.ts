import { Injectable } from '@nestjs/common';

import { DbService, type TenantQuery } from '../db/db.service.js';

/**
 * No such account, or it belongs to another tenant — deliberately one answer.
 *
 * The same shape `UsersService` uses, and duplicated rather than imported so that this module has
 * no dependency on the account-administration surface. What matters here is that the two cases are
 * indistinguishable: RLS makes another tenant's row invisible to the SELECT below, so a caller that
 * names a foreign user id gets "no such user" and learns nothing about whether one exists.
 */
export class PosixIdentityUnknownUserError extends Error {
  constructor() {
    super('no such user');
    this.name = 'PosixIdentityUnknownUserError';
  }
}

/**
 * The identity space is full, or the database handed back something unusable.
 *
 * Separate from the error above because the remedy is different: one is a caller naming a user
 * that is not there, the other is an appliance that has run out of the 100 000 ids migration 0015
 * reserved, and neither the user nor the API can do anything about the second.
 */
export class PosixIdentityUnavailableError extends Error {
  constructor(reason: string) {
    super(`a POSIX identity could not be allocated: ${reason}`);
    this.name = 'PosixIdentityUnavailableError';
  }
}

/**
 * The lock every allocation is taken behind, as `pg_advisory_xact_lock(classifier, key)`.
 *
 * 15 is the migration that reserved the range; 1 is the id space inside it. Two integers rather
 * than one 64-bit value so that a second lock added later — a different space, a different
 * migration — cannot collide with this one by arithmetic accident.
 *
 * The lock is needed because `allocate_posix_id` is `MAX + 1` over two tables and holds nothing
 * while it reads: two transactions that call it at the same instant both see the same maximum and
 * both return the same number. The unique index catches the second write, but only as an error the
 * caller has to recognise and retry, and a retry loop around an unserialised allocator is a loop
 * whose worst case is unbounded. Serialising the allocation itself makes the index the last line
 * of defence instead of the first.
 *
 * Transaction-scoped (`_xact_`), so it is released by the COMMIT that writes the id and there is no
 * unlock to forget. Device-wide and NOT tenant-scoped, because the id space is: a per-tenant lock
 * would let two organisations allocate concurrently and hand the same uid to two people, which is
 * precisely two strangers owning each other's files.
 */
const ALLOCATION_LOCK: readonly [number, number] = [15, 1];

/**
 * DEPSIS accounts as the filesystem sees them.
 *
 * The agent refuses `owner_uid` or `owner_gid` of 0 on every operation that takes them, and its
 * reason is worth repeating here because this class is the thing that reason was waiting for: an
 * API that skips the mapping should fail loudly rather than quietly produce root-owned files inside
 * a tenant's share. So every method here either returns a real id in the reserved range or throws.
 *
 * NOTHING here touches `/etc/passwd`. `fchown` and `setfacl` take numbers, so a numeric identity is
 * a complete one as far as the filesystem is concerned; the visible consequence is that `ls -l`
 * over a shell prints the number instead of a name, which is a cosmetic cost against not having a
 * privileged operation that edits the system's account files (ADR-0004).
 */
@Injectable()
export class PosixIdentityService {
  constructor(private readonly db: DbService) {}

  /**
   * The uid this user's files are owned by, allocating one if the account has never needed it.
   *
   * LAZY, and the rule is: an account gets its uid when it is created, and an account that predates
   * this code gets one the first time something is about to be written on its behalf. The
   * alternative — a migration that backfills every existing row — was rejected because the id is
   * not merely a number in a column: it is what a file on disk is stamped with, and handing one out
   * to accounts that may never upload anything spends the reserved range on nobody. Lazily is also
   * the only rule that stays correct for an account this process did not create: the FIRST
   * administrator is inserted by `claim_appliance`, a SQL function that predates migration 0015 and
   * knows nothing about `posix_uid`, so on every appliance in existence the one account guaranteed
   * to be there is the one guaranteed to arrive here without an id.
   *
   * `organizationId` comes from the session and `userId` from the request, never the other way
   * round: the SELECT runs under the session's tenant context, so a caller naming a user in another
   * organisation finds no row and gets `PosixIdentityUnknownUserError`. A tenant cannot cause an id
   * to be spent on somebody else's account.
   */
  async posixUidFor(organizationId: string, userId: string): Promise<number> {
    return this.db.withTenant(organizationId, async (db) => {
      const existing = await db.query<{ posix_uid: number | null }>(
        `SELECT posix_uid FROM public.users WHERE organization_id = $1 AND id = $2`,
        [organizationId, userId],
      );
      const row = existing[0];
      if (row === undefined) throw new PosixIdentityUnknownUserError();
      if (row.posix_uid !== null) return assertUsable(row.posix_uid);

      const allocated = await PosixIdentityService.allocateWithin(db, 'user');
      const written = await db.query<{ posix_uid: number | null }>(
        // Guarded by `posix_uid IS NULL` so that a concurrent allocation for the SAME user — two
        // uploads from one account starting together — cannot overwrite an id a file on disk may
        // already carry. The loser of that race reads the winner's value below rather than
        // replacing it.
        `UPDATE public.users SET posix_uid = $3
          WHERE organization_id = $1 AND id = $2 AND posix_uid IS NULL
          RETURNING posix_uid`,
        [organizationId, userId, allocated],
      );
      const stored = written[0]?.posix_uid;
      if (stored !== undefined && stored !== null) return assertUsable(stored);

      // The guard bit: somebody else wrote one between the SELECT and the UPDATE. Read theirs.
      const reread = await db.query<{ posix_uid: number | null }>(
        `SELECT posix_uid FROM public.users WHERE organization_id = $1 AND id = $2`,
        [organizationId, userId],
      );
      const settled = reread[0]?.posix_uid;
      if (settled === undefined || settled === null) {
        throw new PosixIdentityUnavailableError('the account has no uid and would not take one');
      }
      return assertUsable(settled);
    });
  }

  /**
   * Allocate an id inside a transaction the caller already owns.
   *
   * Static and taking a `TenantQuery` rather than opening its own transaction, because the one rule
   * `allocate_posix_id` states in its own COMMENT is that the caller must WRITE the returned value
   * in the SAME transaction. A method that opened its own would return a number nobody has claimed
   * yet, and the next caller would be handed the same one.
   *
   * This is what account creation uses: the id and the row are one INSERT, so an account that
   * exists always has a uid and there is no window in which it does not.
   */
  static async allocateWithin(db: TenantQuery, kind: 'user' | 'team'): Promise<number> {
    await db.query(`SELECT pg_catalog.pg_advisory_xact_lock($1, $2)`, [
      ALLOCATION_LOCK[0],
      ALLOCATION_LOCK[1],
    ]);
    const rows = await db.query<{ id: number | null }>(
      `SELECT public.allocate_posix_id($1) AS id`,
      [kind],
    );
    const id = rows[0]?.id;
    if (id === undefined || id === null) {
      throw new PosixIdentityUnavailableError('allocate_posix_id returned nothing');
    }
    return assertUsable(id);
  }
}

/**
 * The reserved range, checked on the way out as well as in the schema.
 *
 * `users_posix_uid_range` already refuses anything outside 300000–399999 on write, so this can only
 * fire on a value that was read back — a column widened by hand, a restore from a database that
 * predates the constraint. It is checked anyway because the number's next stop is `fchown`, where
 * 0 means root and a low number means a system service, and the whole point of the agent refusing 0
 * is that a wrong owner is not a condition anyone notices until the file is unreadable.
 */
function assertUsable(id: number): number {
  if (!Number.isInteger(id) || id < 300000 || id > 399999) {
    throw new PosixIdentityUnavailableError(
      `${id} is not inside the reserved POSIX range 300000-399999`,
    );
  }
  return id;
}
