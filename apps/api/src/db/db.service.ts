import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';

import { TenantContextError, TenantContextNotEstablishedError } from './db.errors.js';

/**
 * The only thing a caller ever gets to hold.
 *
 * Deliberately not a `PoolClient`. Handing out the client would let a caller keep it past the
 * transaction, release it twice, or start a second transaction on it — and, more importantly, it
 * would let a caller obtain a connection with no tenant context at all, which is the single thing
 * ADR-0015 exists to make impossible.
 */
export interface TenantQuery {
  query<Row = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<Row[]>;
}

/**
 * Work that genuinely touches no tenant-scoped table.
 *
 * ADR-0015 §1 limits this to three jobs, and the list lives in the ADR rather than in code so that
 * adding a fourth is a decision someone has to write down. The values here are the machine-readable
 * half of that list.
 */
export type UntenantedJustification =
  | 'health-check'
  | 'migration-status'
  // Both of these run BEFORE a tenant is known, which is the only reason they are here.
  | 'resolve-organization-by-slug'
  | 'resolve-session'
  // Login throttling counts attempts against an address that may belong to no tenant at all, and
  // has to bite before the tenant is resolved. Migration 0003 explains why the table carries no
  // organization_id and why adding one would let an attacker pick their own throttling bucket.
  | 'login-throttle'
  // The second factor step. Same shape as resolve-session: an opaque token names the tenant, and
  // the tenant cannot be known until it is resolved.
  | 'resolve-pending-login'
  // Setup precedes every tenant by definition: the question is whether ANY tenant exists, and the
  // claim that answers it is what creates the first one. ADR-0015 §5d.
  | 'setup-status';

const SET_TENANT_SQL = `SELECT set_config('depsis.organization_id', $1, true) AS applied,
                               public.current_organization_id()::text  AS observed`;

interface SetTenantRow {
  applied: string | null;
  observed: string | null;
}

interface RoleRow {
  role_name: string;
  is_super: boolean;
  bypasses_rls: boolean;
}

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);

  // Private, and there is no getter. ADR-0015 forbids any `Pool` or `PoolClient` living outside
  // this file; that prohibition is only worth anything if the type system agrees.
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      // A statement that runs longer than this is a bug or an attack, and either way it is holding
      // a connection the rest of the application needs. Bounded here rather than per query so a new
      // query cannot forget it.
      statement_timeout: 30_000,
      // Distinct from statement_timeout: this bounds how long a transaction may sit IDLE holding
      // locks, which is what a request that dies mid-transaction leaves behind.
      idle_in_transaction_session_timeout: 15_000,
      max: 10,
    });

    // A pool error is emitted on idle clients and is fatal to the process if unhandled. Losing the
    // API because a database restarted is worse than logging and letting the pool reconnect.
    this.pool.on('error', (error) => {
      this.logger.error(`idle client error: ${error.message}`);
    });
  }

  /**
   * Refuse to start if the application is connected as a role that ignores row level security.
   *
   * Not hypothetical: P1-A measured that a pre-existing `depsis_app` carrying BYPASSRLS makes every
   * policy in the schema decorative, and the application would read every tenant's rows without a
   * single error at any layer. `bootstrap.sql` now repairs the role, but a `DEPSIS_DATABASE_URL`
   * that points at `depsis_owner` — the exact mistake ADR-0014's two-variable split exists to
   * prevent — produces the same outcome. One query, once, at startup.
   */
  async onModuleInit(): Promise<void> {
    const [role] = await this.queryDirect<RoleRow>(
      `SELECT current_user                     AS role_name,
              rolsuper                         AS is_super,
              rolbypassrls                     AS bypasses_rls
         FROM pg_roles
        WHERE rolname = current_user`,
    );

    if (!role) {
      throw new TenantContextError('could not read the current role from pg_roles');
    }

    if (role.is_super || role.bypasses_rls) {
      throw new TenantContextError(
        `refusing to start: connected as '${role.role_name}', which ` +
          `${role.is_super ? 'is a superuser' : 'holds BYPASSRLS'}. Row level security would not ` +
          `apply and every tenant's rows would be visible, with no error anywhere. ` +
          `DEPSIS_DATABASE_URL must name the application role, never the migration owner ` +
          `(ADR-0014, ADR-0015 §4).`,
      );
    }

    // Attributes are not enough, and finding that out is what P1-B was for.
    //
    // `depsis_owner` is neither a superuser nor a BYPASSRLS role, so the check above lets it
    // through — yet migration 0001 gives it `USING (true)` on every table, precisely so it can run
    // backfills. An API pointed at the owner connection therefore reads every tenant's rows and
    // passes an attribute-based gate cleanly. The attribute check catches the blunt cases; only a
    // behavioural one catches this.
    //
    // So: with no tenant context, a tenant-scoped table must be empty. Any row visible here is a
    // row that row level security did not hide.
    const [leak] = await this.queryDirect<{ visible: string }>(
      'SELECT count(*)::text AS visible FROM public.organizations',
    );
    if (leak && leak.visible !== '0') {
      throw new TenantContextError(
        `refusing to start: as '${role.role_name}', ${leak.visible} organization row(s) are ` +
          `visible with no tenant context set. Row level security is not confining this role — ` +
          `every tenant's data would be readable, with no error anywhere. DEPSIS_DATABASE_URL ` +
          `must name the application role, never the migration owner (ADR-0014, ADR-0015 §4).`,
      );
    }

    // The one limit worth stating: on a database with no organizations yet, this passes vacuously.
    // It cannot produce a false refusal, and on an empty system there is nothing to leak — but it
    // means the gate becomes meaningful only once the first tenant exists.
    this.logger.log(`connected as '${role.role_name}'; row level security confines it`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Run `fn` inside a transaction whose tenant context is set to `organizationId` and VERIFIED.
   *
   * The verification is the part that matters. `set_config` returning a value proves the statement
   * ran; it does not prove the value is what a policy will read back, and the failure mode when it
   * is not is a query that returns zero rows rather than an error — indistinguishable, from a
   * handler's point of view, from "this tenant has no data". PgBouncer in session pooling mode
   * (which ADR-0013 forbids, but a configuration error can produce) is one way to get there.
   *
   * Both halves come back from the same round trip, so the check costs nothing.
   */
  async withTenant<T>(organizationId: string, fn: (db: TenantQuery) => Promise<T>): Promise<T> {
    if (!UUID_PATTERN.test(organizationId)) {
      // Rejected before it reaches the database. `set_config` takes a bind parameter so this is
      // not an injection guard — it is a "this value did not come from where you think" guard.
      throw new TenantContextError(`not a UUID: ${JSON.stringify(organizationId)}`);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query<SetTenantRow>(SET_TENANT_SQL, [organizationId]);
      const row = result.rows[0];

      if (!row || row.observed !== organizationId) {
        throw new TenantContextNotEstablishedError(organizationId, row?.observed ?? null);
      }

      const value = await fn(wrap(client));
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await rollbackQuietly(client, this.logger);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Run `fn` in a transaction with NO tenant context.
   *
   * The justification is a required argument rather than a comment because this is the one hole in
   * the wall, and a hole nobody has to name is a hole that grows. The type limits it to the three
   * jobs ADR-0015 §1 allows; a fourth needs the ADR changed, not just this union.
   */
  async withoutTenant<T>(
    justification: UntenantedJustification,
    fn: (db: TenantQuery) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await fn(wrap(client));
      await client.query('COMMIT');
      this.logger.debug(`untenanted transaction: ${justification}`);
      return value;
    } catch (error) {
      await rollbackQuietly(client, this.logger);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Startup-only, and outside any transaction.
   *
   * Used by `onModuleInit` before the module is usable at all, where neither `withTenant` nor
   * `withoutTenant` makes sense yet. Private so it cannot become a general-purpose escape.
   */
  private async queryDirect<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      text,
      params ? [...params] : undefined,
    );
    // Same claim-not-proof caveat as `wrap` above.
    return result.rows as unknown as Row[];
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function wrap(client: PoolClient): TenantQuery {
  return {
    async query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
      const result = await client.query<Record<string, unknown>>(
        text,
        params ? [...params] : undefined,
      );
      // The cast is the honest shape of this boundary. Neither `pg` nor TypeScript can know what a
      // raw SQL statement returns, so `Row` is a claim made by the caller rather than something the
      // compiler verified. ADR-0014 records this as the accepted cost of keeping the schema in SQL
      // rather than in a DSL, and the consequence is that these claims are checked by tests against
      // a real database — never by the type checker.
      return result.rows as unknown as Row[];
    },
  };
}

/**
 * A failed ROLLBACK must not replace the error that caused it.
 *
 * If the connection is already broken the ROLLBACK throws too, and rethrowing that would hide the
 * real cause behind a generic connection error — with the original problem never reaching a log.
 */
async function rollbackQuietly(client: PoolClient, logger: Logger): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch (rollbackError) {
    logger.warn(`rollback failed: ${(rollbackError as Error).message}`);
  }
}
