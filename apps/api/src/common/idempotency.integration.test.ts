import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DbService } from '../db/db.service.js';
import { IdempotencyService } from './idempotency.service.js';

/**
 * `Idempotency-Key`, against a real PostgreSQL.
 *
 * The claim is a race, and a race is the one thing a fake cannot measure: the whole design rests on
 * `INSERT ... ON CONFLICT DO NOTHING` being atomic on the primary key. A stub would report whatever
 * ordering the test wrote.
 *
 * Skipped unless `DEPSIS_TEST_DATABASE_URL` and `DEPSIS_TEST_OWNER_DATABASE_URL` point at a
 * migrated database.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];
const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

const ENDPOINT = 'POST /files/folders';

describeDb('the idempotency key', () => {
  let db: DbService;
  let owner: DbService;
  let keys: IdempotencyService;
  let orgA = '';
  let orgB = '';
  let ayse = '';
  let veli = '';

  const print = (label: string): Buffer =>
    IdempotencyService.fingerprint('POST', '/files/folders', { name: label });

  /** Anahtarları saklama penceresinin dışına taşı — süpürmenin göreceği hâl. */
  const age = async (list: readonly string[]): Promise<void> => {
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `UPDATE idempotency_keys SET created_at = now() - interval '48 hours'
          WHERE organization_id = $1 AND idempotency_key = ANY($2)`,
        [orgA, list],
      ),
    );
  };

  const present = async (key: string): Promise<boolean> => {
    const rows = await db.withTenant(orgA, (q) =>
      q.query(`SELECT 1 FROM public.idempotency_keys WHERE idempotency_key = $1`, [key]),
    );
    return rows.length > 0;
  };

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name)
         VALUES ('idem-a','Idem A'), ('idem-b','Idem B')
         ON CONFLICT (slug) DO NOTHING`,
      );
      const orgs = await q.query<{ slug: string; id: string }>(
        `SELECT slug, id::text AS id FROM organizations WHERE slug IN ('idem-a','idem-b')`,
      );
      orgA = orgs.find((r) => r.slug === 'idem-a')?.id ?? '';
      orgB = orgs.find((r) => r.slug === 'idem-b')?.id ?? '';

      // Deleted and re-inserted rather than upserted: `users_username_unique` is a partial index
      // on `fold_identity(username)`, so there is no plain (organization_id, username) constraint
      // for `ON CONFLICT` to name.
      await q.query(`DELETE FROM users WHERE organization_id = $1`, [orgA]);
      const people = await q.query<{ username: string; id: string }>(
        `INSERT INTO users (organization_id, username, password_hash)
         VALUES ($1, 'idem-ayse', 'x'), ($1, 'idem-veli', 'x')
         RETURNING username, id::text AS id`,
        [orgA],
      );
      ayse = people.find((r) => r.username === 'idem-ayse')?.id ?? '';
      veli = people.find((r) => r.username === 'idem-veli')?.id ?? '';
    });

    keys = new IdempotencyService(db);
  });

  beforeEach(async () => {
    await owner.withoutTenant('migration-status', (q) =>
      q.query(`DELETE FROM idempotency_keys WHERE organization_id = ANY($1)`, [[orgA, orgB]]),
    );
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM idempotency_keys WHERE organization_id = ANY($1)`, [
          [orgA, orgB],
        ]);
        await q.query(`DELETE FROM users WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM organizations WHERE id = ANY($1)`, [[orgA, orgB]]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  it('lets the first request through and replays the second', async () => {
    const key = randomUUID();

    expect(await keys.claim(orgA, ayse, ENDPOINT, key, print('belgeler'))).toEqual({
      outcome: 'claimed',
    });
    await keys.complete(orgA, ayse, ENDPOINT, key, 201, { id: 'abc', name: 'belgeler' }, {});

    expect(await keys.claim(orgA, ayse, ENDPOINT, key, print('belgeler'))).toEqual({
      outcome: 'replay',
      status: 201,
      body: { id: 'abc', name: 'belgeler' },
      headers: {},
    });
  });

  it('replays the headers that carried the answer', async () => {
    // `POST /uploads` answers 201 with an empty body: the address of the created upload is in
    // `Location` and nowhere else. A replay without it is a 201 that says nothing.
    const key = randomUUID();
    await keys.claim(orgA, ayse, ENDPOINT, key, print('yükleme'));
    await keys.complete(orgA, ayse, ENDPOINT, key, 201, undefined, {
      location: '/api/v1/uploads/u-1',
    });

    const replay = await keys.claim(orgA, ayse, ENDPOINT, key, print('yükleme'));
    expect(replay).toEqual({
      outcome: 'replay',
      status: 201,
      body: null,
      headers: { location: '/api/v1/uploads/u-1' },
    });
  });

  it('refuses the same key carrying a different request', async () => {
    // ADR-0008's rule, and the reason a fingerprint is stored at all: replaying the first answer
    // for a genuinely different request would silently drop the second one.
    const key = randomUUID();
    await keys.claim(orgA, ayse, ENDPOINT, key, print('belgeler'));
    await keys.complete(orgA, ayse, ENDPOINT, key, 201, { id: 'abc' }, {});

    expect(await keys.claim(orgA, ayse, ENDPOINT, key, print('arsiv'))).toEqual({
      outcome: 'reused',
    });
  });

  it('says a request is still running rather than running it twice', async () => {
    // The row exists with no status: somebody claimed it and has not finished. This is what makes
    // the key work for the case it exists for — a client that retried because it never saw the
    // first response, while the first response is still being produced.
    const key = randomUUID();
    await keys.claim(orgA, ayse, ENDPOINT, key, print('belgeler'));

    expect(await keys.claim(orgA, ayse, ENDPOINT, key, print('belgeler'))).toEqual({
      outcome: 'in-flight',
    });
  });

  it('holds only one of two simultaneous claims', async () => {
    // The atomicity the whole design rests on, measured rather than assumed. Both calls are in
    // flight before either resolves.
    const key = randomUUID();
    const [first, second] = await Promise.all([
      keys.claim(orgA, ayse, ENDPOINT, key, print('belgeler')),
      keys.claim(orgA, ayse, ENDPOINT, key, print('belgeler')),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(['claimed', 'in-flight']);
  });

  it('gives the key back when the request failed', async () => {
    // A transient 503 must not burn the key. Telling a client to mint a new key for a retry is
    // telling them the header does nothing.
    const key = randomUUID();
    await keys.claim(orgA, ayse, ENDPOINT, key, print('belgeler'));
    await keys.release(orgA, ayse, ENDPOINT, key);

    expect(await keys.claim(orgA, ayse, ENDPOINT, key, print('belgeler'))).toEqual({
      outcome: 'claimed',
    });
  });

  it('never gives back a key whose request succeeded', async () => {
    // `release` is called from the error path, but an interceptor is not the only thing that can
    // call it. Scoping the DELETE to `status IS NULL` means a late release cannot erase a
    // completed record and let the work happen twice.
    const key = randomUUID();
    await keys.claim(orgA, ayse, ENDPOINT, key, print('belgeler'));
    await keys.complete(orgA, ayse, ENDPOINT, key, 201, { id: 'abc' }, {});
    await keys.release(orgA, ayse, ENDPOINT, key);

    expect((await keys.claim(orgA, ayse, ENDPOINT, key, print('belgeler'))).outcome).toBe('replay');
  });

  it('scopes the key to one user, so nobody replays somebody else’s answer', async () => {
    // The reason `user_id` is in the primary key. Clients choose their own keys; without the user
    // in scope, guessing one would hand you another person's response body.
    const key = randomUUID();
    await keys.claim(orgA, ayse, ENDPOINT, key, print('belgeler'));
    await keys.complete(orgA, ayse, ENDPOINT, key, 201, { id: 'ayse-folder' }, {});

    expect(await keys.claim(orgA, veli, ENDPOINT, key, print('belgeler'))).toEqual({
      outcome: 'claimed',
    });
  });

  it('scopes the key to one endpoint', async () => {
    const key = randomUUID();
    await keys.claim(orgA, ayse, ENDPOINT, key, print('belgeler'));
    await keys.complete(orgA, ayse, ENDPOINT, key, 201, { id: 'abc' }, {});

    expect(await keys.claim(orgA, ayse, 'POST /backups/snapshots', key, print('belgeler'))).toEqual(
      { outcome: 'claimed' },
    );
  });

  it('cannot be read across tenants', async () => {
    // RLS, not a WHERE clause. The row is written under orgA's context and is not visible from
    // orgB's at all — so a key that collides across tenants reads as unused rather than as
    // somebody else's answer.
    const key = randomUUID();
    await keys.claim(orgA, ayse, ENDPOINT, key, print('belgeler'));
    await keys.complete(orgA, ayse, ENDPOINT, key, 201, { id: 'abc' }, {});

    const rows = await db.withTenant(orgB, (q) =>
      q.query(`SELECT 1 FROM public.idempotency_keys WHERE idempotency_key = $1`, [key]),
    );
    expect(rows).toHaveLength(0);
  });

  it('sweeps keys past their retention, INCLUDING the ones stuck in flight', async () => {
    // ADR-0008 24 saatlik saklama diyor ve hiçbir şey bir satırı silmiyordu: `complete` her isteğin
    // tam yanıt gövdesini jsonb olarak yazıyor, ve her gece yedek alan bir dış istemci bir yılda
    // on binlerce satır bırakıyor. Arayüzde temizleyecek bir yol yok.
    const stale = randomUUID();
    const stuck = randomUUID();
    const fresh = randomUUID();

    await keys.claim(orgA, ayse, ENDPOINT, stale, print('eski'));
    await keys.complete(orgA, ayse, ENDPOINT, stale, 201, { id: 'a' }, {});
    // `status IS NULL`: API süreci `claim` ile `complete` arasında öldü. Bu anahtar sonsuza dek
    // 409 `operation-in-progress` döndürür ve kullanıcının onu kurtaracak bir düğmesi yok — aynı
    // pencerenin bunu da toplaması, süpürmenin asıl sebebi.
    await keys.claim(orgA, ayse, ENDPOINT, stuck, print('takili'));
    await keys.claim(orgA, ayse, ENDPOINT, fresh, print('yeni'));

    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `UPDATE idempotency_keys SET created_at = now() - interval '48 hours'
          WHERE organization_id = $1 AND idempotency_key = ANY($2)`,
        [orgA, [stale, stuck]],
      ),
    );

    expect(await keys.purgeExpired(orgA)).toBe(2);

    // Ve süpürülen anahtar yeniden kullanılabilir — takılı kalmış olanın çıkış yolu bu.
    expect(await keys.claim(orgA, ayse, ENDPOINT, stuck, print('takili'))).toEqual({
      outcome: 'claimed',
    });
    // Bugünün anahtarı yerinde: pencereyi geçmemiş bir tekrar hâlâ korunuyor.
    expect(await keys.claim(orgA, ayse, ENDPOINT, fresh, print('yeni'))).toEqual({
      outcome: 'in-flight',
    });
  });

  it('sweeps from the claim path, and then holds off for an hour', async () => {
    // `purgeExpired` vardı ama onu çağıran hiçbir üretim yolu YOKTU — yalnız bir önceki test.
    // Yani saklama süresi kâğıt üstündeydi: tabloda hiçbir satır silinmiyordu.
    const stale = randomUUID();
    await keys.claim(orgA, ayse, ENDPOINT, stale, print('eski'));
    await age([stale]);

    // Kendi süpürme sayacı henüz dolmamış taze bir servis — `keys` bu testten önce çoktan
    // süpürmüş olurdu.
    const swept = new IdempotencyService(db);
    expect(await swept.claim(orgA, ayse, ENDPOINT, randomUUID(), print('yeni'))).toEqual({
      outcome: 'claimed',
    });
    expect(await present(stale)).toBe(false);

    // Ve bir sonraki istek yeniden süpürmüyor: silme, her idempotent isteğin sırtına binen bir
    // maliyet değil, saatte bir koşan bir tur.
    const second = randomUUID();
    await keys.claim(orgA, ayse, ENDPOINT, second, print('ikinci'));
    await age([second]);
    await swept.claim(orgA, ayse, ENDPOINT, randomUUID(), print('ucuncu'));
    expect(await present(second)).toBe(true);
  });

  it('gives a different body a different fingerprint', () => {
    expect(print('belgeler').equals(print('belgeler'))).toBe(true);
    expect(print('belgeler').equals(print('arsiv'))).toBe(false);
    // And a different path, even with the same body — two folders under two parents are two jobs.
    expect(
      IdempotencyService.fingerprint('POST', '/files/folders', { name: 'a' }).equals(
        IdempotencyService.fingerprint('POST', '/backups/snapshots', { name: 'a' }),
      ),
    ).toBe(false);
  });
});
