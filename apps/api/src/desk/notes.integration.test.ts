import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DbService } from '../db/db.service.js';
import { NoteNotFoundError, NoteRejectedError, NotesService } from './notes.service.js';

/**
 * The notepad against a real PostgreSQL.
 *
 * What cannot be settled by a fake, and is therefore the whole reason this suite exists: notes are
 * private WITHIN a tenant, and nothing in the database enforces that. Migration 0012's policy tests
 * `organization_id` and stops there, so the `author_id` predicate in every statement of
 * `NotesService` is the only thing between one household member and another's notes. A mock of the
 * database would return whatever the service asked for and would agree with a service that had
 * dropped the predicate entirely.
 *
 * Skipped unless `DEPSIS_TEST_DATABASE_URL` and `DEPSIS_TEST_OWNER_DATABASE_URL` point at a
 * migrated database.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];

const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

describeDb('notes, against a real PostgreSQL', () => {
  let db: DbService;
  let owner: DbService;
  let notes: NotesService;

  // Two organisations, and two people inside the first one. The second person is not decoration:
  // the tenant wall and the author wall are different walls and only this shape tests both.
  let orgA = '';
  let orgB = '';
  let ayse = '';
  let bora = '';
  let ceren = '';

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);
    notes = new NotesService(db);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name)
         VALUES ('notes-a','Notes A'), ('notes-b','Notes B')
         ON CONFLICT (slug) DO NOTHING`,
      );
      const orgs = await q.query<{ slug: string; id: string }>(
        `SELECT slug, id::text AS id FROM organizations WHERE slug IN ('notes-a','notes-b')`,
      );
      orgA = orgs.find((r) => r.slug === 'notes-a')?.id ?? '';
      orgB = orgs.find((r) => r.slug === 'notes-b')?.id ?? '';

      const seeded = await q.query<{ username: string; id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1, 'notes-ayse', 'admin', 'x'),
                ($1, 'notes-bora', 'member', 'x'),
                ($2, 'notes-ceren', 'admin', 'x')
         RETURNING username, id::text AS id`,
        [orgA, orgB],
      );
      ayse = seeded.find((r) => r.username === 'notes-ayse')?.id ?? '';
      bora = seeded.find((r) => r.username === 'notes-bora')?.id ?? '';
      ceren = seeded.find((r) => r.username === 'notes-ceren')?.id ?? '';
    });
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM notes WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM users WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM organizations WHERE id = ANY($1)`, [[orgA, orgB]]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  it('stores a note and hands it back to its author', async () => {
    const created = await notes.create(orgA, ayse, 'alışveriş', 'süt, ekmek');
    expect(created.title).toBe('alışveriş');
    expect(created.body).toBe('süt, ekmek');

    const read = await notes.find(orgA, ayse, created.id);
    expect(read.id).toBe(created.id);
  });

  it('defaults the body to empty, because a title-only note is a real note', async () => {
    const created = await notes.create(orgA, ayse, 'hatırlat', '');
    expect(created.body).toBe('');
  });

  it("does not show one tenant another tenant's notes", async () => {
    const theirs = await notes.create(orgB, ceren, 'onların notu', 'gizli');

    // Same author id would not help: the row is behind a policy that never sees it.
    await expect(notes.find(orgA, ceren, theirs.id)).rejects.toBeInstanceOf(NoteNotFoundError);
    const mine = await notes.list(orgA, ayse);
    expect(mine.map((n) => n.id)).not.toContain(theirs.id);
  });

  it("does not let one tenant change or delete another tenant's note", async () => {
    const theirs = await notes.create(orgB, ceren, 'dokunma', 'içerik');

    await expect(
      notes.update(orgA, ceren, theirs.id, { title: 'ele geçirildi' }),
    ).rejects.toBeInstanceOf(NoteNotFoundError);
    await expect(notes.remove(orgA, ceren, theirs.id)).rejects.toBeInstanceOf(NoteNotFoundError);

    // And it really is untouched, read back through its own tenant.
    expect((await notes.find(orgB, ceren, theirs.id)).title).toBe('dokunma');
  });

  it("does not let one person in a tenant read another person's note", async () => {
    // The case RLS does NOT cover. Both rows carry the same `organization_id`, so the policy admits
    // both; only the `author_id` predicate keeps them apart.
    const hers = await notes.create(orgA, ayse, 'ayşenin notu', 'özel');

    await expect(notes.find(orgA, bora, hers.id)).rejects.toBeInstanceOf(NoteNotFoundError);

    const borasList = await notes.list(orgA, bora);
    expect(borasList.map((n) => n.id)).not.toContain(hers.id);
  });

  it("does not let one person in a tenant edit or delete another person's note", async () => {
    const hers = await notes.create(orgA, ayse, 'silinmeyecek', 'metin');

    await expect(notes.update(orgA, bora, hers.id, { body: 'değişti' })).rejects.toBeInstanceOf(
      NoteNotFoundError,
    );
    await expect(notes.remove(orgA, bora, hers.id)).rejects.toBeInstanceOf(NoteNotFoundError);

    const still = await notes.find(orgA, ayse, hers.id);
    expect(still.body).toBe('metin');
  });

  it('lists an author\'s notes with the most recently edited first', async () => {
    // Self-contained: its own author, so the ordering assertion cannot be disturbed by a note
    // another test in this file created.
    const solo = await seedUser(owner, orgA, 'notes-sira');
    const first = await notes.create(orgA, solo, 'bir', '');
    const second = await notes.create(orgA, solo, 'iki', '');

    // Touching the older one must move it to the front — that is what makes the column
    // `updated_at` rather than `created_at`, and the trigger is what sets it.
    const touched = await notes.update(orgA, solo, first.id, { body: 'düzeltildi' });
    expect(touched.updated_at.getTime()).toBeGreaterThanOrEqual(first.updated_at.getTime());

    const listed = await notes.list(orgA, solo);
    expect(listed.map((n) => n.id)).toEqual([first.id, second.id]);
  });

  it('edits only the fields it was given', async () => {
    const note = await notes.create(orgA, ayse, 'başlık', 'gövde');

    const retitled = await notes.update(orgA, ayse, note.id, { title: 'yeni başlık' });
    expect(retitled.title).toBe('yeni başlık');
    expect(retitled.body).toBe('gövde');

    const rebodied = await notes.update(orgA, ayse, note.id, { body: 'yeni gövde' });
    expect(rebodied.title).toBe('yeni başlık');
    expect(rebodied.body).toBe('yeni gövde');
  });

  it('deletes permanently and refuses the second delete', async () => {
    const note = await notes.create(orgA, ayse, 'geçici', '');
    await notes.remove(orgA, ayse, note.id);

    await expect(notes.find(orgA, ayse, note.id)).rejects.toBeInstanceOf(NoteNotFoundError);
    await expect(notes.remove(orgA, ayse, note.id)).rejects.toBeInstanceOf(NoteNotFoundError);
  });

  it('turns the title and body CHECK constraints into a refusal rather than a fault', async () => {
    // The controller's zod schema normally catches both of these. This asserts the LAST line of
    // defence answers 422 rather than 500 — a service called from anywhere else, or a schema that
    // drifts from migration 0012, must not produce an error page.
    await expect(notes.create(orgA, ayse, '   ', '')).rejects.toBeInstanceOf(NoteRejectedError);
    await expect(notes.create(orgA, ayse, 'x'.repeat(201), '')).rejects.toBeInstanceOf(
      NoteRejectedError,
    );
    await expect(notes.create(orgA, ayse, 'uzun', 'y'.repeat(65_537))).rejects.toBeInstanceOf(
      NoteRejectedError,
    );

    const note = await notes.create(orgA, ayse, 'sağlam', '');
    await expect(notes.update(orgA, ayse, note.id, { title: '' })).rejects.toBeInstanceOf(
      NoteRejectedError,
    );
  });
});

/** A user of this test's own, so a test that needs a clean author does not borrow a shared one. */
async function seedUser(owner: DbService, organizationId: string, username: string): Promise<string> {
  const rows = await owner.withoutTenant('migration-status', (q) =>
    q.query<{ id: string }>(
      `INSERT INTO users (organization_id, username, role, password_hash)
       VALUES ($1, $2, 'member', 'x')
       RETURNING id::text AS id`,
      [organizationId, username],
    ),
  );
  return rows[0]?.id ?? '';
}
