import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentService } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import { FilesService } from '../files/files.service.js';
import { PreferencesRejectedError, PreferencesService } from './preferences.service.js';

/**
 * Interface preferences, against a real PostgreSQL.
 *
 * A fake settles none of what matters here. Row-level security keeping one tenant's document out
 * of another's read is the database's behaviour; so is the upsert that makes two simultaneous
 * writes end in one row rather than a primary-key violation; and so is the CHECK that bounds the
 * jsonb. The background check is the same again from the other side — it asks `FilesService` a
 * question that only has the right answer when RLS is really applied.
 *
 * Every test seeds what it needs, because a test that depends on the order it runs in fails for a
 * reason nobody is looking for.
 *
 * Skipped unless `DEPSIS_TEST_DATABASE_URL` points at a migrated database. A gated test that
 * silently passes when its precondition is missing is worse than no test, so the skip is visible.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];

const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

/** Nothing here moves bytes; every file in this suite is a metadata row. */
const noAgent = {
  isAvailable: () => false,
  call: () => Promise.reject(new Error('no test here should call the agent')),
} as unknown as AgentService;

describeDb('interface preferences, against a real PostgreSQL', () => {
  let db: DbService;
  let owner: DbService;
  let files: FilesService;
  let preferences: PreferencesService;
  let orgA = '';
  let orgB = '';
  let shareA = '';
  let shareB = '';
  let aliceA = '';
  let bulentA = '';

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);
    files = new FilesService(db, noAgent);
    preferences = new PreferencesService(db, files);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name)
         VALUES ('prefs-a','Prefs A'), ('prefs-b','Prefs B')
         ON CONFLICT (slug) DO NOTHING`,
      );
      const orgs = await q.query<{ slug: string; id: string }>(
        `SELECT slug, id::text AS id FROM organizations WHERE slug IN ('prefs-a','prefs-b')`,
      );
      orgA = orgs.find((r) => r.slug === 'prefs-a')?.id ?? '';
      orgB = orgs.find((r) => r.slug === 'prefs-b')?.id ?? '';

      // Two people in one organisation, because "a preference belongs to a person" is one of the
      // things this suite has to settle, and one account cannot show it.
      const seeded = await q.query<{ username: string; id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1, 'ayse', 'admin', 'x'), ($1, 'bulent', 'member', 'x')
         RETURNING username, id::text AS id`,
        [orgA],
      );
      aliceA = seeded.find((r) => r.username === 'ayse')?.id ?? '';
      bulentA = seeded.find((r) => r.username === 'bulent')?.id ?? '';
    });

    shareA = (await files.defaultShare(orgA, 'prefs-a')).id;
    shareB = (await files.defaultShare(orgB, 'prefs-b')).id;
  });

  afterAll(async () => {
    // Preferences before users, users before organizations: the organisation reference is
    // ON DELETE RESTRICT, so a teardown in the wrong order fails loudly instead of quietly
    // cascading somebody's rows away.
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM user_preferences WHERE organization_id = ANY($1)`, [
          [orgA, orgB],
        ]);
        await q.query(
          `DELETE FROM file_entries WHERE organization_id = ANY($1) AND parent_id IS NOT NULL`,
          [[orgA, orgB]],
        );
        await q.query(`DELETE FROM file_entries WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM shares WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM sessions WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM users WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM organizations WHERE id = ANY($1)`, [[orgA, orgB]]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  /** A published file row, named uniquely so no test depends on another having run. */
  async function seedFile(organizationId: string, shareId: string, name: string): Promise<string> {
    const entry = await files.recordPublishedFile(
      organizationId,
      shareId,
      null,
      name,
      1024,
      'image/jpeg',
    );
    return entry.id;
  }

  it('answers with an empty document, and writes nothing, for someone who has never chosen', async () => {
    const read = await preferences.read(orgA, bulentA);
    expect(read).toEqual({});

    // The half that a status code alone cannot show: reading did not create the row. If it did,
    // "has this person ever set anything" would be unanswerable after the first page load.
    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query(`SELECT 1 FROM user_preferences WHERE organization_id = $1 AND user_id = $2`, [
        orgA,
        bulentA,
      ]),
    );
    expect(rows).toHaveLength(0);
  });

  it('stores a document and hands back what was stored', async () => {
    const written = await preferences.write(orgA, aliceA, {
      background: { kind: 'sky' },
      sound: true,
      shortcuts: [
        { id: 'files', label: 'Dosyalar', cell: 0 },
        { id: 'notes', cell: 12 },
      ],
    });

    expect(written).toEqual({
      background: { kind: 'sky' },
      sound: true,
      shortcuts: [
        { id: 'files', label: 'Dosyalar', cell: 0 },
        { id: 'notes', cell: 12 },
      ],
    });
    expect(await preferences.read(orgA, aliceA)).toEqual(written);
  });

  it('replaces the whole document rather than merging into it', async () => {
    const user = await seedUser(orgA, 'degistiren');
    await preferences.write(orgA, user, {
      sound: true,
      shortcuts: [{ id: 'files', cell: 3 }],
    });

    // A merge would leave `shortcuts` behind, and the person who cleared their home screen would
    // find it repopulated on the next load.
    const second = await preferences.write(orgA, user, { sound: false });
    expect(second).toEqual({ sound: false });
    expect(await preferences.read(orgA, user)).toEqual({ sound: false });
  });

  it("keeps one person's desk out of another's, inside the same organisation", async () => {
    const one = await seedUser(orgA, 'sahip1');
    const two = await seedUser(orgA, 'sahip2');

    await preferences.write(orgA, one, { sound: true });
    expect(await preferences.read(orgA, two)).toEqual({});

    await preferences.write(orgA, two, { sound: false });
    expect(await preferences.read(orgA, one)).toEqual({ sound: true });
  });

  it("does not let one tenant read or overwrite another tenant's document", async () => {
    await preferences.write(orgA, aliceA, { background: { kind: 'solid', preset: 'gece' } });

    // Under tenant B the row is not there at all. The primary key names the same user id, so RLS
    // is the only thing standing between the two, and a `WHERE organization_id = $1` accidentally
    // dropped from the service would show up right here.
    expect(await preferences.read(orgB, aliceA)).toEqual({});

    // Not merely invisible: unwritable. This is the raw statement rather than the service, because
    // what is under test is the policy and not this repository's WHERE clause — an UPDATE that
    // names the row directly still has to change nothing.
    const overwritten = await db.withTenant(orgB, (q) =>
      q.query(
        `UPDATE public.user_preferences SET data = '{"sound":false}'::jsonb
          WHERE user_id = $1 RETURNING user_id`,
        [aliceA],
      ),
    );
    expect(overwritten).toHaveLength(0);
    expect(await preferences.read(orgA, aliceA)).toEqual({
      background: { kind: 'solid', preset: 'gece' },
    });
  });

  it('refuses a field the contract does not describe', async () => {
    // `additionalProperties: false` in the contract, `.strict()` here. Without it the column
    // accumulates whatever a client felt like sending and nothing ever reports it.
    await expect(preferences.write(orgA, aliceA, { theme: 'dark' })).rejects.toBeInstanceOf(
      PreferencesRejectedError,
    );
    await expect(
      preferences.write(orgA, aliceA, { background: { kind: 'sky', opacity: 0.5 } }),
    ).rejects.toBeInstanceOf(PreferencesRejectedError);
    await expect(
      preferences.write(orgA, aliceA, { shortcuts: [{ id: 'a', cell: 1, icon: 'x' }] }),
    ).rejects.toBeInstanceOf(PreferencesRejectedError);
  });

  it('refuses documents that are the wrong shape rather than storing them', async () => {
    const bad: unknown[] = [
      null,
      [],
      'sound',
      { sound: 'yes' },
      { background: { kind: 'nebula' } },
      { background: 'sky' },
      { shortcuts: { id: 'a', cell: 1 } },
      { shortcuts: [{ cell: 1 }] },
    ];
    for (const document of bad) {
      await expect(preferences.write(orgA, aliceA, document)).rejects.toBeInstanceOf(
        PreferencesRejectedError,
      );
    }
  });

  it('holds the shortcut bounds the grid depends on', async () => {
    const tooMany = Array.from({ length: 61 }, (_, i) => ({ id: `s${i}`, cell: i }));
    await expect(preferences.write(orgA, aliceA, { shortcuts: tooMany })).rejects.toBeInstanceOf(
      PreferencesRejectedError,
    );

    // 60 is legal, so the cap is a cap and not an off-by-one.
    const exactly = Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, cell: i }));
    await expect(preferences.write(orgA, aliceA, { shortcuts: exactly })).resolves.toBeTruthy();

    for (const cell of [-1, 1000, 1.5]) {
      await expect(
        preferences.write(orgA, aliceA, { shortcuts: [{ id: 'a', cell }] }),
      ).rejects.toBeInstanceOf(PreferencesRejectedError);
    }

    await expect(
      preferences.write(orgA, aliceA, { shortcuts: [{ id: 'x'.repeat(129), cell: 0 }] }),
    ).rejects.toBeInstanceOf(PreferencesRejectedError);
    await expect(
      preferences.write(orgA, aliceA, { shortcuts: [{ id: 'a', label: 'y'.repeat(65), cell: 0 }] }),
    ).rejects.toBeInstanceOf(PreferencesRejectedError);
  });

  it("refuses a 'solid' background with no preset, and a 'file' background with no file", async () => {
    await expect(
      preferences.write(orgA, aliceA, { background: { kind: 'solid' } }),
    ).rejects.toBeInstanceOf(PreferencesRejectedError);
    await expect(
      preferences.write(orgA, aliceA, { background: { kind: 'file' } }),
    ).rejects.toBeInstanceOf(PreferencesRejectedError);
  });

  it('accepts a background that names a real, untrashed file', async () => {
    const user = await seedUser(orgA, 'duvarkagidi');
    const fileId = await seedFile(orgA, shareA, 'manzara.jpg');

    const written = await preferences.write(orgA, user, {
      background: { kind: 'file', fileId },
    });
    expect(written).toEqual({ background: { kind: 'file', fileId } });
  });

  it('refuses a background naming a file that is gone, trashed, or a folder', async () => {
    const user = await seedUser(orgA, 'kirikduvar');

    // Never existed. The refusal is what stops the home screen from asking for missing bytes on
    // every single load, with nothing in the failure naming the preference that caused it.
    await expect(
      preferences.write(orgA, user, {
        background: { kind: 'file', fileId: '00000000-0000-4000-8000-000000000000' },
      }),
    ).rejects.toBeInstanceOf(PreferencesRejectedError);

    const trashed = await seedFile(orgA, shareA, 'silinecek.jpg');
    await files.trash(orgA, trashed, user);
    await expect(
      preferences.write(orgA, user, { background: { kind: 'file', fileId: trashed } }),
    ).rejects.toBeInstanceOf(PreferencesRejectedError);

    const folder = await files.createFolder(orgA, shareA, null, 'klasor-arkaplan');
    await expect(
      preferences.write(orgA, user, { background: { kind: 'file', fileId: folder.id } }),
    ).rejects.toBeInstanceOf(PreferencesRejectedError);
  });

  it("refuses a background naming another tenant's file", async () => {
    // The important one. Accepting it would hand tenant A a working reference to bytes it may not
    // read, and the id alone would confirm the file exists.
    const theirs = await seedFile(orgB, shareB, 'onlarin-duvar.jpg');
    await expect(
      preferences.write(orgA, aliceA, { background: { kind: 'file', fileId: theirs } }),
    ).rejects.toBeInstanceOf(PreferencesRejectedError);
  });

  it('leaves a stale fileId alone once the background is no longer a file', async () => {
    // Someone picks a wallpaper, deletes the file, then switches back to the drawn sky. The unused
    // reference must not make every later write fail — refusing it would be the same bug as the
    // unvalidated reference, seen from the other side.
    const user = await seedUser(orgA, 'eskiduvar');
    await expect(
      preferences.write(orgA, user, {
        background: { kind: 'sky', fileId: '00000000-0000-4000-8000-000000000001' },
        sound: true,
      }),
    ).resolves.toBeTruthy();
  });

  it('lets two simultaneous writes settle on one row rather than colliding', async () => {
    // Two tabs, one person. Read-then-write loses one of them and a plain INSERT raises 23505 on
    // the primary key; the single-statement upsert does neither.
    const user = await seedUser(orgA, 'ikisekme');
    const [first, second] = await Promise.all([
      preferences.write(orgA, user, { sound: true }),
      preferences.write(orgA, user, { sound: false }),
    ]);
    // `RETURNING` reports each statement's own row, so both writers see what they wrote rather
    // than one of them discovering it wrote nothing.
    expect(first.sound).toBe(true);
    expect(second.sound).toBe(false);

    const stored = await preferences.read(orgA, user);
    expect(typeof stored.sound).toBe('boolean');

    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query(`SELECT 1 FROM user_preferences WHERE organization_id = $1 AND user_id = $2`, [
        orgA,
        user,
      ]),
    );
    expect(rows).toHaveLength(1);
  });

  /** A fresh account, so that no test in this file inherits another one's document. */
  async function seedUser(organizationId: string, username: string): Promise<string> {
    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1, $2, 'member', 'x')
         RETURNING id::text AS id`,
        [organizationId, username],
      ),
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`could not seed ${username}`);
    return id;
  }
});
