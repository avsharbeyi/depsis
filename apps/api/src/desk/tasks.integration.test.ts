import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DbService } from '../db/db.service.js';
import { NotificationsService } from './notifications.service.js';
import { TaskWatchersService } from './task-watchers.service.js';
import {
  AssigneeNotFoundError,
  TaskNotFoundError,
  TaskNotYoursError,
  TaskRejectedError,
  TasksService,
} from './tasks.service.js';

/**
 * The shared job board against a real PostgreSQL.
 *
 * The two things here that a fake cannot answer:
 *
 *   * the board is shared inside a tenant and sealed between tenants, and only one of those is
 *     enforced by a policy;
 *   * assigning a job to somebody in ANOTHER organisation is a write RLS happily accepts — the
 *     row's own `organization_id` is correct, so the policy is satisfied and the job lands on a
 *     board its assignee will never see. The check that refuses it lives in `TasksService`, and
 *     this suite is what proves it is still there.
 *
 * Skipped unless `DEPSIS_TEST_DATABASE_URL` and `DEPSIS_TEST_OWNER_DATABASE_URL` point at a
 * migrated database.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];

const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

/**
 * Teardown ve kural-dışı çağrılar için: bu satırlar başkasının işini BİLEREK siliyor.
 * Kuralın kendisi `tasks.integration.test.ts` içinde ayrıca ölçülüyor.
 */
const AS_ADMIN = { userId: '00000000-0000-4000-8000-000000000000', isOrganizationAdmin: true };

describeDb('the job board, against a real PostgreSQL', () => {
  let db: DbService;
  let owner: DbService;
  let tasks: TasksService;

  let orgA = '';
  let orgB = '';
  let deniz = '';
  let emre = '';
  let figen = '';
  let cem = '';

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);
    tasks = new TasksService(db, new NotificationsService(db), new TaskWatchersService(db));

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name)
         VALUES ('tasks-a','Tasks A'), ('tasks-b','Tasks B')
         ON CONFLICT (slug) DO NOTHING`,
      );
      const orgs = await q.query<{ slug: string; id: string }>(
        `SELECT slug, id::text AS id FROM organizations WHERE slug IN ('tasks-a','tasks-b')`,
      );
      orgA = orgs.find((r) => r.slug === 'tasks-a')?.id ?? '';
      orgB = orgs.find((r) => r.slug === 'tasks-b')?.id ?? '';

      const seeded = await q.query<{ username: string; id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1, 'tasks-deniz', 'admin', 'x'),
                ($1, 'tasks-emre', 'member', 'x'),
                ($1, 'tasks-cem', 'member', 'x'),
                ($2, 'tasks-figen', 'admin', 'x')
         RETURNING username, id::text AS id`,
        [orgA, orgB],
      );
      deniz = seeded.find((r) => r.username === 'tasks-deniz')?.id ?? '';
      emre = seeded.find((r) => r.username === 'tasks-emre')?.id ?? '';
      figen = seeded.find((r) => r.username === 'tasks-figen')?.id ?? '';
      cem = seeded.find((r) => r.username === 'tasks-cem')?.id ?? '';
    });
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM tasks WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM users WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM organizations WHERE id = ANY($1)`, [[orgA, orgB]]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  it('lets only the creator, the assignee or an administrator delete a job', async () => {
    // KAPANAN DELIK. `DELETE /tasks/{id}` hicbir sahiplik sinamasi yapmiyordu: herhangi bir uye
    // herhangi bir meslektasinin isini siliyordu, ve `task_activity`'nin ON DELETE CASCADE'i
    // denetim izini de goturuyordu — o tabloda DELETE yetkisinin verilmemis olmasi bir referans
    // silmesini durdurmuyor, yani olan bitenin kaydi olan bitenle birlikte gidiyordu.
    const denizin = await tasks.create(orgA, deniz, 'Denizin isi', emre);

    // Cem ne yaratici, ne atanan, ne yonetici. Ayni panoyu goruyor, ama silemiyor.
    await expect(
      tasks.remove(orgA, denizin.id, { userId: cem, isOrganizationAdmin: false }),
    ).rejects.toBeInstanceOf(TaskNotYoursError);
    // Ve ret gercekten reddetti: satir hala orada. Bu satir olmadan test yalnizca atilan hatayi
    // olcerdi, silmenin olup olmadigini degil.
    await expect(tasks.find(orgA, denizin.id)).resolves.toBeDefined();

    // Atanan silebilir.
    await tasks.remove(orgA, denizin.id, { userId: emre, isOrganizationAdmin: false });
    await expect(tasks.find(orgA, denizin.id)).rejects.toBeInstanceOf(TaskNotFoundError);

    // Yaratici da.
    const ikinci = await tasks.create(orgA, deniz, 'Denizin ikinci isi', emre);
    await tasks.remove(orgA, ikinci.id, { userId: deniz, isOrganizationAdmin: false });
    await expect(tasks.find(orgA, ikinci.id)).rejects.toBeInstanceOf(TaskNotFoundError);

    // Ikisi de olmayan bir yonetici de. Pano paylasimli oldugu icin bu bir kacis kapisi degil,
    // birinin izne cikmasi halinde isin panoda takili kalmamasinin tek yolu.
    const ucuncu = await tasks.create(orgA, deniz, 'Denizin ucuncu isi', emre);
    await tasks.remove(orgA, ucuncu.id, { userId: cem, isOrganizationAdmin: true });
    await expect(tasks.find(orgA, ucuncu.id)).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it('answers "not yours" and "no such job" differently, deliberately', async () => {
    // DOSYA AGACINDAN BILEREK AYRILIYOR. Orada bir girdinin VARLIGI sirdir ve yetkisiz istek 404
    // alir. Panoda ise her uye zaten her isi GORUYOR; burada 404 demek hicbir seyi gizlemez,
    // yalnizca ekraninda duran isi goren kisiye "boyle bir is yok" demis olurdu.
    const gorunen = await tasks.create(orgA, deniz, 'Gorunen ama benim olmayan is', null);

    await expect(
      tasks.remove(orgA, gorunen.id, { userId: cem, isOrganizationAdmin: false }),
    ).rejects.toBeInstanceOf(TaskNotYoursError);
    await expect(
      tasks.remove(orgA, '00000000-0000-4000-8000-0000000000ff', {
        userId: cem,
        isOrganizationAdmin: false,
      }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);

    await tasks.remove(orgA, gorunen.id, AS_ADMIN);
  });

  it("still refuses another tenant's job, admin flag or not", async () => {
    // Sahiplik yuklemi satir seviyesi guvenlige EK, asla onun yerine gecen bir sey degil. Bir
    // kurulusun yoneticisi otekinde hic kimsedir, ve `isOrganizationAdmin` cagiranin KENDI
    // kurulusu hakkinda bir iddia — burada bir kestirme, yerel bir rolu kuresel yapardi.
    const otekinin = await tasks.create(orgB, figen, 'Oteki kiracinin isi', null);

    await expect(
      tasks.remove(orgA, otekinin.id, { userId: figen, isOrganizationAdmin: true }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    // Kendi kiracisinda hala duruyor.
    await expect(tasks.find(orgB, otekinin.id)).resolves.toBeDefined();
    await tasks.remove(orgB, otekinin.id, AS_ADMIN);
  });

  it('creates an unassigned job, which is a real state rather than a missing value', async () => {
    const task = await tasks.create(orgA, deniz, 'çöpü çıkar', null);
    expect(task.assignee_id).toBeNull();
    expect(task.assignee_username).toBeNull();
    expect(task.done_at).toBeNull();
    expect(task.position).toBe(0);
  });

  it('joins the assignee username, and keeps returning it after a reassignment', async () => {
    const task = await tasks.create(orgA, deniz, 'bulaşık', emre);
    expect(task.assignee_username).toBe('tasks-emre');

    const moved = await tasks.update(orgA, task.id, { assigneeId: deniz });
    expect(moved.assignee_username).toBe('tasks-deniz');

    const freed = await tasks.update(orgA, task.id, { assigneeId: null });
    expect(freed.assignee_id).toBeNull();
    expect(freed.assignee_username).toBeNull();
  });

  it('shows the board to everybody in the tenant, unlike a note', async () => {
    // Written by Deniz, and the service takes no reader identity at all — there is no call shape
    // in which Emre gets a narrower board.
    const task = await tasks.create(orgA, deniz, 'ortak iş', null);
    const board = await tasks.list(orgA);
    expect(board.map((t) => t.id)).toContain(task.id);
  });

  it("does not show or change one tenant's board from another", async () => {
    const theirs = await tasks.create(orgB, figen, 'onların işi', figen);

    expect((await tasks.list(orgA)).map((t) => t.id)).not.toContain(theirs.id);
    await expect(tasks.find(orgA, theirs.id)).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(tasks.update(orgA, theirs.id, { done: true })).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    await expect(tasks.remove(orgA, theirs.id, AS_ADMIN)).rejects.toBeInstanceOf(TaskNotFoundError);

    expect((await tasks.find(orgB, theirs.id)).done_at).toBeNull();
  });

  it('refuses to assign a job to somebody in another organization', async () => {
    // The write RLS would allow: `organization_id` is orgA, so the policy passes, and the foreign
    // key is satisfied because Figen is a real user. Nothing below the service catches this.
    await expect(tasks.create(orgA, deniz, 'yanlış kişi', figen)).rejects.toBeInstanceOf(
      AssigneeNotFoundError,
    );

    const task = await tasks.create(orgA, deniz, 'doğru kişi', emre);
    await expect(tasks.update(orgA, task.id, { assigneeId: figen })).rejects.toBeInstanceOf(
      AssigneeNotFoundError,
    );

    // And the refused reassignment left the job where it was, rather than half-applied.
    expect((await tasks.find(orgA, task.id)).assignee_id).toBe(emre);
  });

  it('refuses an assignee that does not exist anywhere', async () => {
    await expect(
      tasks.create(orgA, deniz, 'hayalet', '00000000-0000-4000-8000-000000000000'),
    ).rejects.toBeInstanceOf(AssigneeNotFoundError);
  });

  it('does not move done_at when a job that is already done is marked done again', async () => {
    // Two taps on a checkbox, or an interface that re-sends the whole row on every edit. Either way
    // the answer to "when did we finish this" must not become "just now".
    const task = await tasks.create(orgA, deniz, 'iki kere işaretlenecek', emre);
    const first = await tasks.update(orgA, task.id, { done: true });
    expect(first.done_at).not.toBeNull();

    const again = await tasks.update(orgA, task.id, { done: true });
    expect(again.done_at?.getTime()).toBe(first.done_at?.getTime());

    // Unticking and reticking IS a new completion — the job was genuinely reopened.
    const reopened = await tasks.update(orgA, task.id, { done: false });
    expect(reopened.done_at).toBeNull();
    const redone = await tasks.update(orgA, task.id, { done: true });
    expect(redone.done_at?.getTime()).toBeGreaterThan(first.done_at?.getTime() ?? 0);
  });

  it('keeps a completed job on the board rather than hiding it', async () => {
    const task = await tasks.create(orgA, deniz, 'bitmiş iş', null);
    await tasks.update(orgA, task.id, { done: true });

    const board = await tasks.list(orgA);
    const found = board.find((t) => t.id === task.id);
    // "What did we finish today" is one of the questions the board exists to answer, so filtering
    // is the client's decision and not the server's.
    expect(found?.done_at).not.toBeNull();
  });

  it('orders by assignee, then position, then age', async () => {
    // Its own organisation, so the ordering assertion does not depend on what other tests left on
    // the shared board.
    const { orgId, alice, bob } = await seedOrg(owner, 'tasks-order');
    try {
      const later = await tasks.create(orgId, alice, 'ikinci sırada', alice);
      const earlier = await tasks.create(orgId, alice, 'birinci sırada', alice);
      await tasks.update(orgId, earlier.id, { position: -1 });
      const bobs = await tasks.create(orgId, alice, "bob'un işi", bob);
      const nobodys = await tasks.create(orgId, alice, 'kimsenin işi', null);

      const board = await tasks.list(orgId);
      const ids = board.map((t) => t.id);

      // Within one assignee, position decides.
      expect(ids.indexOf(earlier.id)).toBeLessThan(ids.indexOf(later.id));
      // Assignees group together, and the unassigned column sorts last: PostgreSQL puts NULLs last
      // in an ascending order, which is also where "somebody should do this" belongs on screen.
      expect(ids.indexOf(nobodys.id)).toBe(ids.length - 1);
      expect(ids).toContain(bobs.id);
    } finally {
      await cleanupOrg(owner, orgId);
    }
  });

  it('edits only the fields it was given', async () => {
    const task = await tasks.create(orgA, deniz, 'ilk metin', emre);
    const edited = await tasks.update(orgA, task.id, { body: 'yeni metin' });
    expect(edited.body).toBe('yeni metin');
    expect(edited.assignee_id).toBe(emre);
    expect(edited.done_at).toBeNull();
    expect(edited.position).toBe(task.position);
  });

  it('deletes permanently and refuses the second delete', async () => {
    const task = await tasks.create(orgA, deniz, 'silinecek', null);
    await tasks.remove(orgA, task.id, AS_ADMIN);
    await expect(tasks.find(orgA, task.id)).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(tasks.remove(orgA, task.id, AS_ADMIN)).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it('turns the body CHECK constraint into a refusal rather than a fault', async () => {
    await expect(tasks.create(orgA, deniz, '  ', null)).rejects.toBeInstanceOf(TaskRejectedError);
    await expect(tasks.create(orgA, deniz, 'x'.repeat(2001), null)).rejects.toBeInstanceOf(
      TaskRejectedError,
    );

    const task = await tasks.create(orgA, deniz, 'sağlam', null);
    await expect(tasks.update(orgA, task.id, { body: '' })).rejects.toBeInstanceOf(
      TaskRejectedError,
    );
  });
});

interface SeededOrg {
  orgId: string;
  alice: string;
  bob: string;
}

/** A whole organisation of this test's own, for the assertions that are about a board's contents. */
async function seedOrg(owner: DbService, slug: string): Promise<SeededOrg> {
  return owner.withoutTenant('migration-status', async (q) => {
    const orgs = await q.query<{ id: string }>(
      `INSERT INTO organizations (slug, name) VALUES ($1, $1) RETURNING id::text AS id`,
      [slug],
    );
    const orgId = orgs[0]?.id ?? '';
    const users = await q.query<{ username: string; id: string }>(
      `INSERT INTO users (organization_id, username, role, password_hash)
       VALUES ($1, 'alice', 'admin', 'x'), ($1, 'bob', 'member', 'x')
       RETURNING username, id::text AS id`,
      [orgId],
    );
    return {
      orgId,
      alice: users.find((u) => u.username === 'alice')?.id ?? '',
      bob: users.find((u) => u.username === 'bob')?.id ?? '',
    };
  });
}

async function cleanupOrg(owner: DbService, orgId: string): Promise<void> {
  await owner.withoutTenant('migration-status', async (q) => {
    await q.query(`DELETE FROM tasks WHERE organization_id = $1`, [orgId]);
    await q.query(`DELETE FROM users WHERE organization_id = $1`, [orgId]);
    await q.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
  });
}
