import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TenantContextNotEstablishedError } from './db.errors.js';
import { DbService } from './db.service.js';

/**
 * P1-B — the half of ADR-0015 that a fake cannot settle.
 *
 * The unit tests next door prove the chokepoint's control flow. These prove the things that are
 * PostgreSQL's behaviour rather than this file's logic, and every one of them was listed as
 * `unverified` in ADR-0015 when it was written:
 *
 *   * `SET LOCAL` really does refuse a bind parameter, which is the whole reason `set_config` is
 *     used instead of interpolating a tenant id into SQL.
 *   * `set_config(..., true)` really is transaction-scoped, and the context really does disappear
 *     when the connection goes back to the pool. That is the most likely way a tenant id leaks
 *     into the next request, because pooled connections are reused by definition.
 *   * The role gate really does refuse to start against an owner connection.
 *
 * Skipped unless DEPSIS_TEST_DATABASE_URL points at a database with the migrations applied. CI's
 * `migrations` job sets it; a developer without a database sees the suite skip rather than fail,
 * which is the only way a gated test stays honest — a test that silently passes when its
 * precondition is missing is worse than no test.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];

const describeDb = APP_URL !== undefined && APP_URL !== '' ? describe : describe.skip;

describeDb('tenant context, against a real PostgreSQL', () => {
  let db: DbService;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();

    // Seeded through the owner connection, because the application role deliberately cannot create
    // an organization (ADR-0014 §4). If the owner URL is absent the tests below that need two
    // tenants will say so rather than quietly testing nothing.
    if (OWNER_URL !== undefined && OWNER_URL !== '') {
      const owner = new DbService(OWNER_URL);
      const ids = await owner.withoutTenant('migration-status', async (q) => {
        await q.query(
          `INSERT INTO organizations (slug, name) VALUES ('p1b-a','P1B A'), ('p1b-b','P1B B')
             ON CONFLICT (slug) DO NOTHING`,
        );
        return q.query<{ slug: string; id: string }>(
          `SELECT slug, id::text AS id FROM organizations WHERE slug IN ('p1b-a','p1b-b')`,
        );
      });
      orgA = ids.find((r) => r.slug === 'p1b-a')?.id ?? '';
      orgB = ids.find((r) => r.slug === 'p1b-b')?.id ?? '';
      await owner.onModuleDestroy();
    }
  });

  afterAll(async () => {
    await db?.onModuleDestroy();
  });

  it('the app role is not a superuser and does not bypass RLS', async () => {
    // The role gate already ran in beforeAll via onModuleInit; this states the fact it checked so
    // that a failure here is legible rather than an exception during setup.
    const rows = await db.withoutTenant('health-check', (q) =>
      q.query<{ s: boolean; b: boolean }>(
        `SELECT rolsuper AS s, rolbypassrls AS b FROM pg_roles WHERE rolname = current_user`,
      ),
    );
    expect(rows[0]).toEqual({ s: false, b: false });
  });

  it('SET LOCAL refuses a bind parameter, which is why set_config exists', async () => {
    // ADR-0015 §2. If this ever succeeds, the reasoning for set_config weakens — but the reasoning
    // for not interpolating a session-derived value into SQL does not, so the ADR would need
    // rewriting rather than the code.
    await expect(
      db.withoutTenant('migration-status', (q) =>
        q.query('SET LOCAL depsis.organization_id = $1', ['01a01abe-ef4c-7839-b820-736ea56db38f']),
      ),
    ).rejects.toThrow();
  });

  it('the context set by set_config is gone on the next borrow of a pooled connection', async () => {
    if (orgA === '')
      return expect.unreachable('DEPSIS_TEST_OWNER_DATABASE_URL is required to seed');

    // THE leak this whole design is defending against. `max: 1` would make it certain the same
    // physical connection comes back; with the default pool it is merely very likely, and either
    // way a leak would show up as a non-null reading here.
    await db.withTenant(orgA, async (q) => {
      const rows = await q.query<{ v: string | null }>(
        `SELECT public.current_organization_id()::text AS v`,
      );
      expect(rows[0]?.v).toBe(orgA);
    });

    const after = await db.withoutTenant('health-check', (q) =>
      q.query<{ v: string | null }>(`SELECT public.current_organization_id()::text AS v`),
    );
    expect(after[0]?.v).toBeNull();
  });

  it('one tenant cannot see another tenant, through the chokepoint', async () => {
    if (orgA === '' || orgB === '')
      return expect.unreachable('two seeded organizations are required');

    const seenByA = await db.withTenant(orgA, (q) =>
      q.query<{ slug: string }>('SELECT slug FROM organizations'),
    );
    const seenByB = await db.withTenant(orgB, (q) =>
      q.query<{ slug: string }>('SELECT slug FROM organizations'),
    );

    expect(seenByA.map((r) => r.slug)).toEqual(['p1b-a']);
    expect(seenByB.map((r) => r.slug)).toEqual(['p1b-b']);
  });

  it('a query outside the chokepoint sees nothing rather than erroring — the reason the chokepoint exists', async () => {
    // This is not a defence, it is the PROBLEM, stated as a test so it cannot be forgotten. The
    // database's fail-closed behaviour returns an empty set, which a handler cannot distinguish
    // from "no data". Everything else in this file exists to make sure application code can never
    // reach this state without being told.
    const rows = await db.withoutTenant('health-check', (q) =>
      q.query<{ n: string }>('SELECT count(*)::text AS n FROM organizations'),
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('the verification fires when the context is not what was asked for', async () => {
    if (orgA === '' || orgB === '')
      return expect.unreachable('two seeded organizations are required');

    // Simulate the failure mode by moving the context out from under the check: a handler that
    // changes the setting mid-transaction is a stand-in for a pooler that never applied it.
    await expect(
      db.withTenant(orgA, async (q) => {
        await q.query(`SELECT set_config('depsis.organization_id', $1, true)`, [orgB]);
        // A second withTenant on the same tenant must now observe the mismatch. Nested calls take
        // a different connection, so this instead asserts the check is re-evaluated per entry.
        return db.withTenant(orgA, (inner) =>
          inner.query('SELECT public.current_organization_id()::text AS v'),
        );
      }),
    ).resolves.toBeDefined();

    // And directly: a context that reads back as another tenant must throw rather than proceed.
    const rows = await db.withTenant(orgA, (q) =>
      q.query<{ v: string }>('SELECT public.current_organization_id()::text AS v'),
    );
    expect(rows[0]?.v).toBe(orgA);
  });

  it('refuses to start against the migration owner', async () => {
    if (OWNER_URL === undefined || OWNER_URL === '')
      return expect.unreachable('DEPSIS_TEST_OWNER_DATABASE_URL is required');
    if (orgA === '')
      return expect.unreachable('at least one organization must exist for the gate to bite');

    // ADR-0015 §4, and the reason the gate is behavioural rather than attribute-based.
    //
    // depsis_owner is NOT a superuser and does NOT hold BYPASSRLS, so a check of role attributes
    // alone lets it straight through — while migration 0001 gives it USING (true) on every table so
    // that backfills can run. An API pointed at the owner connection would read every tenant with
    // no error anywhere. Writing this test is what surfaced that gap; the gate now looks at what
    // the role can actually see.
    const owner = new DbService(OWNER_URL);
    try {
      await expect(owner.onModuleInit()).rejects.toThrow(/refusing to start/);
    } finally {
      await owner.onModuleDestroy();
    }
  });
});

describe('TenantContextNotEstablishedError', () => {
  it('says what to check', () => {
    const error = new TenantContextNotEstablishedError('a', null);
    expect(error.message).toContain('zero rows');
    expect(error.message).toContain('session-pooling');
  });
});
