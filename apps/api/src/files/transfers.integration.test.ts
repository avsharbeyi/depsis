import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DbService, type TenantQuery } from '../db/db.service.js';
import { TransfersService, type TransferRow } from './transfers.service.js';

/**
 * The transfer list, against a real PostgreSQL.
 *
 * Nothing here can be settled by a fake, and the reason is that almost every answer this endpoint
 * gives is the database's rather than this repository's: row-level security decides which tenant's
 * uploads exist at all, and `state` is a CASE expression evaluated against the SAME clock that
 * wrote `updated_at`. Computing the staleness cutoff in Node instead would compare the API host's
 * clock with the database's, and on an appliance where those two drift the list would report a
 * freshly written upload as stalled — a bug that no unit test with a frozen timer would ever show.
 *
 * Skipped unless `DEPSIS_TEST_DATABASE_URL` points at a migrated database. A gated test that
 * silently passes when its precondition is missing is worse than no test, so the skip is visible.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];

const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

interface SeedOptions {
  organizationId: string;
  shareId: string;
  createdBy: string;
  filename: string;
  lengthBytes: number;
  offsetBytes: number;
  /** How long ago the row was last written. Drives `state` and the 24-hour window. */
  updatedSecondsAgo: number;
  /** How long ago the upload began. Defaults to `updatedSecondsAgo`. */
  createdSecondsAgo?: number;
  /**
   * Whether the session was PUBLISHED — `completed_at` and `file_id` set, which migration 0008
   * pairs under `upload_sessions_completion_pair`. Distinct from a full `offset_bytes` on purpose:
   * separating the two is the whole subject of the regression test below.
   */
  completed?: boolean;
}

describeDb('the transfer list, against a real PostgreSQL', () => {
  let db: DbService;
  let owner: DbService;
  let transfers: TransfersService;

  let orgA = '';
  let orgB = '';
  let shareA = '';
  let shareB = '';
  let adminA = '';
  let memberA = '';
  let otherA = '';
  let memberB = '';

  /**
   * Insert an upload session directly, with timestamps this test chose.
   *
   * Written as the owner and with explicit `created_at`/`updated_at` because the only trigger on
   * this table is BEFORE UPDATE: an INSERT is the one moment a test can place a row in the past.
   * Going through `UploadsController` instead would stamp every row `now()` and make the stalled
   * and window cases untestable without sleeping for a minute.
   */
  async function seed(options: SeedOptions): Promise<string> {
    const createdSecondsAgo = options.createdSecondsAgo ?? options.updatedSecondsAgo;
    const fileId =
      options.completed === true
        ? await seedFileEntry(options.organizationId, options.shareId, options.filename)
        : null;
    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ id: string }>(
        `INSERT INTO public.upload_sessions
           (organization_id, share_id, parent_id, created_by, filename, staging_name,
            length_bytes, offset_bytes, file_id, completed_at, created_at, updated_at)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $10::uuid,
                 CASE WHEN $10::uuid IS NULL THEN NULL
                      ELSE now() - make_interval(secs => $9::double precision) END,
                 now() - make_interval(secs => $8::double precision),
                 now() - make_interval(secs => $9::double precision))
         RETURNING id::text AS id`,
        [
          options.organizationId,
          options.shareId,
          options.createdBy,
          options.filename,
          `${randomUUID()}.part`,
          options.lengthBytes,
          options.offsetBytes,
          createdSecondsAgo,
          options.updatedSecondsAgo,
          fileId,
        ],
      ),
    );
    return rows[0]?.id ?? '';
  }

  /**
   * The published entry a completed session must point at.
   *
   * Not optional decoration: `upload_sessions_completion_pair` makes `completed_at` and `file_id`
   * inseparable, so there is no way to write "this upload finished" without a row in the tree to
   * finish into — which is exactly the invariant the service now reads.
   */
  async function seedFileEntry(
    organizationId: string,
    shareId: string,
    name: string,
  ): Promise<string> {
    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ id: string }>(
        `INSERT INTO public.file_entries
           (organization_id, share_id, parent_id, kind, name, path, size_bytes)
         VALUES ($1, $2, NULL, 'file', $3, '/' || $3, 0)
         RETURNING id::text AS id`,
        [organizationId, shareId, name],
      ),
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('the file entry was not created');
    return id;
  }

  function byName(rows: TransferRow[], filename: string): TransferRow | undefined {
    return rows.find((r) => r.filename === filename);
  }

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);
    transfers = new TransfersService(db);

    await owner.withoutTenant('migration-status', async (q) => {
      // Clear anything a previous run left behind BEFORE seeding, not only after.
      //
      // The teardown below is not guaranteed to run — a crashed process, a killed run, another
      // agent restarting the database mid-suite. The previous version of this block inserted the
      // organisations with `ON CONFLICT DO NOTHING` and the users and shares without one, so a
      // leftover state produced either a bare 23505 on the share insert or, worse, an
      // `ON CONFLICT DO NOTHING ... RETURNING` that returned zero rows and left every user id as
      // the empty string — which then failed deep inside the first test as SQLSTATE 22P02 on
      // `created_by`, an error that reads like a product defect rather than like leftover state.
      await deleteSuiteRows(q);

      await q.query(
        `INSERT INTO organizations (slug, name)
         VALUES ('transfers-a','Transfers A'), ('transfers-b','Transfers B')
         ON CONFLICT (slug) DO NOTHING`,
      );
      const orgs = await q.query<{ slug: string; id: string }>(
        `SELECT slug, id::text AS id FROM organizations
          WHERE slug IN ('transfers-a','transfers-b')`,
      );
      orgA = orgs.find((r) => r.slug === 'transfers-a')?.id ?? '';
      orgB = orgs.find((r) => r.slug === 'transfers-b')?.id ?? '';

      // `created_by` is NOT NULL, so a transfer needs a real account behind it. Three in A: the
      // administrator whose scope is the organisation, and two members whose scopes must not
      // overlap.
      //
      // Inserted and then SELECTed back rather than read from `RETURNING`, so the ids are correct
      // whether the insert wrote the rows or an earlier one did.
      await q.query(
        `INSERT INTO users (organization_id, username, role)
         VALUES ($1,'tadmin','admin'), ($1,'tmember','member'), ($1,'tother','member'),
                ($2,'tbmember','member')
         ON CONFLICT DO NOTHING`,
        [orgA, orgB],
      );
      const seededUsers = await q.query<{ username: string; id: string }>(
        `SELECT username, id::text AS id FROM users WHERE organization_id = ANY($1)`,
        [[orgA, orgB]],
      );
      adminA = seededUsers.find((u) => u.username === 'tadmin')?.id ?? '';
      memberA = seededUsers.find((u) => u.username === 'tmember')?.id ?? '';
      otherA = seededUsers.find((u) => u.username === 'tother')?.id ?? '';
      memberB = seededUsers.find((u) => u.username === 'tbmember')?.id ?? '';

      await q.query(
        `INSERT INTO shares (organization_id, name, dataset)
         VALUES ($1,'transfers_a','tank/shares/transfers_a'),
                ($2,'transfers_b','tank/shares/transfers_b')
         ON CONFLICT DO NOTHING`,
        [orgA, orgB],
      );
      const shares = await q.query<{ organization_id: string; id: string }>(
        `SELECT organization_id::text AS organization_id, id::text AS id
           FROM shares WHERE organization_id = ANY($1)`,
        [[orgA, orgB]],
      );
      shareA = shares.find((s) => s.organization_id === orgA)?.id ?? '';
      shareB = shares.find((s) => s.organization_id === orgB)?.id ?? '';

      // Fail here, in setup, rather than three tests later with a 22P02 nobody can trace back.
      for (const [name, id] of Object.entries({
        orgA,
        orgB,
        shareA,
        shareB,
        adminA,
        memberA,
        otherA,
        memberB,
      })) {
        if (id === '') throw new Error(`the transfers suite could not seed ${name}`);
      }
    });
  });

  /**
   * Children before parents: every reference here is ON DELETE RESTRICT on purpose, so a teardown
   * in the wrong order fails loudly instead of cascading metadata away.
   *
   * `upload_sessions` before `file_entries` because a completed session points at one, and
   * `file_id` is ON DELETE SET NULL — which would trip the completion-pair CHECK if the entry went
   * first.
   */
  async function deleteSuiteRows(q: TenantQuery): Promise<void> {
    const slugs = ['transfers-a', 'transfers-b'];
    const orgIds = `(SELECT id FROM organizations WHERE slug = ANY($1))`;
    await q.query(`DELETE FROM upload_sessions WHERE organization_id IN ${orgIds}`, [slugs]);
    await q.query(`DELETE FROM file_entries WHERE organization_id IN ${orgIds}`, [slugs]);
    // Before the shares: `folder_grants.share_id` is ON DELETE RESTRICT, so a share carrying a
    // grant cannot be deleted, and both creation paths write one now.
    await q.query(`DELETE FROM folder_grants WHERE organization_id IN ${orgIds}`, [slugs]);
    await q.query(`DELETE FROM shares WHERE organization_id IN ${orgIds}`, [slugs]);
    await q.query(`DELETE FROM users WHERE organization_id IN ${orgIds}`, [slugs]);
    // And the teams before the organisation, for the same reason: `teams.organization_id` is
    // ON DELETE RESTRICT, and `everyone_team()` creates one the first time a share is opened
    // implicitly. Scoped through `orgIds` like everything else here — `teams` has no `slug`.
    await q.query(`DELETE FROM team_members WHERE organization_id IN ${orgIds}`, [slugs]);
    await q.query(`DELETE FROM teams WHERE organization_id IN ${orgIds}`, [slugs]);
    await q.query(`DELETE FROM organizations WHERE slug = ANY($1)`, [slugs]);
  }

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', deleteSuiteRows);
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  it("does not show one tenant's upload to another, not even to an administrator", async () => {
    // The one failure that would matter more than every other case in this file: a filename is the
    // entire content of a transfer row, so a leak here is a leak of what the other organisation is
    // working on. Asserted against the ADMIN scope, which is the widest query this service issues.
    const secret = `b-only-${randomUUID()}.bin`;
    await seed({
      organizationId: orgB,
      shareId: shareB,
      createdBy: memberB,
      filename: secret,
      lengthBytes: 100,
      offsetBytes: 10,
      updatedSecondsAgo: 5,
    });

    const seenByA = await transfers.list(orgA, null);
    expect(byName(seenByA, secret)).toBeUndefined();

    // And it really does exist, read back through its own tenant — otherwise this test would pass
    // just as well against a query that returns nothing at all.
    const seenByB = await transfers.list(orgB, null);
    expect(byName(seenByB, secret)).toBeDefined();
  });

  it("does not show a member another member's upload", async () => {
    const mine = `mine-${randomUUID()}.bin`;
    const theirs = `theirs-${randomUUID()}.bin`;
    await seed({
      organizationId: orgA,
      shareId: shareA,
      createdBy: memberA,
      filename: mine,
      lengthBytes: 100,
      offsetBytes: 10,
      updatedSecondsAgo: 5,
    });
    await seed({
      organizationId: orgA,
      shareId: shareA,
      createdBy: otherA,
      filename: theirs,
      lengthBytes: 100,
      offsetBytes: 10,
      updatedSecondsAgo: 5,
    });

    const asMember = await transfers.list(orgA, memberA);
    expect(byName(asMember, mine)).toBeDefined();
    expect(byName(asMember, theirs)).toBeUndefined();
  });

  it('shows an administrator the whole organisation, which is the point of the wider scope', async () => {
    // An administrator narrowed to their own uploads cannot answer "who is filling the disk", and
    // that question is the reason the wider scope exists.
    const someoneElses = `disk-filler-${randomUUID()}.bin`;
    await seed({
      organizationId: orgA,
      shareId: shareA,
      createdBy: otherA,
      filename: someoneElses,
      lengthBytes: 1_000_000,
      offsetBytes: 1,
      updatedSecondsAgo: 2,
    });

    const asAdmin = await transfers.list(orgA, null);
    expect(byName(asAdmin, someoneElses)).toBeDefined();

    // The same administrator asking the narrow question gets only their own — the scope is a
    // parameter, so a caller that forgets to widen it cannot accidentally widen it either.
    const narrowed = await transfers.list(orgA, adminA);
    expect(byName(narrowed, someoneElses)).toBeUndefined();
  });

  it('calls a writing upload active, a silent one stalled, and a full one completed', async () => {
    const active = `active-${randomUUID()}.bin`;
    const stalled = `stalled-${randomUUID()}.bin`;
    const completed = `completed-${randomUUID()}.bin`;

    await seed({
      organizationId: orgA,
      shareId: shareA,
      createdBy: memberA,
      filename: active,
      lengthBytes: 1000,
      offsetBytes: 400,
      updatedSecondsAgo: 2,
    });
    // Past the sixty-second cutoff with bytes still missing. This is the case the feature exists
    // for: a closed browser tab writes nothing further and announces nothing.
    await seed({
      organizationId: orgA,
      shareId: shareA,
      createdBy: memberA,
      filename: stalled,
      lengthBytes: 1000,
      offsetBytes: 400,
      updatedSecondsAgo: 300,
    });
    // Silent for five minutes AND published. Completion wins: a finished upload is not stalled,
    // and ordering the CASE the other way round would have marked every yesterday's upload as
    // stuck.
    await seed({
      organizationId: orgA,
      shareId: shareA,
      createdBy: memberA,
      filename: completed,
      lengthBytes: 1000,
      offsetBytes: 1000,
      updatedSecondsAgo: 300,
      completed: true,
    });

    const rows = await transfers.list(orgA, memberA);
    expect(byName(rows, active)?.state).toBe('active');
    expect(byName(rows, stalled)?.state).toBe('stalled');
    expect(byName(rows, completed)?.state).toBe('completed');
  });

  it('does not call an upload completed just because every byte arrived', async () => {
    // The regression. `offset_bytes = length_bytes` is NOT completion, and the gap between the two
    // is a real window in `UploadsController.sendChunk`: the last chunk's offset is written first,
    // and only then does the controller publish the staging file and record the entry. A publish
    // that throws — AgentOutOfSpaceError (507), NameTakenError (409), the agent gone — leaves the
    // row at 100% forever with `completed_at IS NULL` and no file in the tree.
    //
    // Deriving `state` from the offset told the user that upload had finished. The transfer list is
    // the thing consulted when something went wrong, so reporting success at the exact moment the
    // upload failed is the one answer it must never give. The row is `active` while it is fresh...
    const publishFailedFresh = `publish-failed-fresh-${randomUUID()}.bin`;
    await seed({
      organizationId: orgA,
      shareId: shareA,
      createdBy: memberA,
      filename: publishFailedFresh,
      lengthBytes: 1000,
      offsetBytes: 1000,
      updatedSecondsAgo: 2,
      completed: false,
    });

    // ...and `stalled` a minute later, which is what an operator can act on.
    const publishFailedOld = `publish-failed-old-${randomUUID()}.bin`;
    await seed({
      organizationId: orgA,
      shareId: shareA,
      createdBy: memberA,
      filename: publishFailedOld,
      lengthBytes: 1000,
      offsetBytes: 1000,
      updatedSecondsAgo: 300,
      completed: false,
    });

    const rows = await transfers.list(orgA, memberA);
    expect(byName(rows, publishFailedFresh)?.state).toBe('active');
    expect(byName(rows, publishFailedOld)?.state).toBe('stalled');
  });

  it('calls a published upload completed even when its offset cache lags behind', async () => {
    // The mirror image, and the reason `completed_at` is the authority rather than merely a second
    // opinion. `offset_bytes` is documented in migration 0008 as a CACHE the agent may contradict;
    // `completed_at` is paired with `file_id` under a CHECK, so it cannot be set without an entry
    // in the tree. A row that says "published" while the cache says 900 of 1000 is completed.
    const published = `published-short-offset-${randomUUID()}.bin`;
    await seed({
      organizationId: orgA,
      shareId: shareA,
      createdBy: memberA,
      filename: published,
      lengthBytes: 1000,
      offsetBytes: 900,
      updatedSecondsAgo: 2,
      completed: true,
    });

    expect(byName(await transfers.list(orgA, memberA), published)?.state).toBe('completed');
  });

  it('keeps a long upload that is still writing, and drops one that went quiet a day ago', async () => {
    // The window cuts on `updated_at`, not `created_at`, and these two rows are what that
    // difference means. A thirty-hour upload of a large file is still in flight; a session that
    // has not been touched in twenty-five hours is history.
    //
    // ESKİ SATIR YARIM KALMIŞ BİR YÜKLEME, tamamlanmış değil — ve fark ölçümün kendisi. Baytların
    // hepsi gelmiş bir satır kullanıcının cevabını bekliyor demek, ve pencere ONU kesmiyor
    // (aşağıdaki iki test bunu ölçüyor). Pencerenin kestiği şey, kimsenin beklemediği bir kayıt.
    const longRunning = `long-${randomUUID()}.bin`;
    const ancient = `ancient-${randomUUID()}.bin`;

    await seed({
      organizationId: orgA,
      shareId: shareA,
      createdBy: memberA,
      filename: longRunning,
      lengthBytes: 5_000_000,
      offsetBytes: 4_000_000,
      updatedSecondsAgo: 3,
      createdSecondsAgo: 30 * 3600,
    });
    await seed({
      organizationId: orgA,
      shareId: shareA,
      createdBy: memberA,
      filename: ancient,
      lengthBytes: 1000,
      offsetBytes: 400,
      updatedSecondsAgo: 25 * 3600,
      createdSecondsAgo: 26 * 3600,
    });

    const rows = await transfers.list(orgA, memberA);
    expect(byName(rows, longRunning)).toBeDefined();
    expect(byName(rows, ancient)).toBeUndefined();
  });

  it('returns the most recently written transfer first', async () => {
    // Newest-first is also what makes the row cap safe: the rows the limit discards are the ones
    // nobody is watching.
    const older = `order-older-${randomUUID()}.bin`;
    const newer = `order-newer-${randomUUID()}.bin`;
    await seed({
      organizationId: orgA,
      shareId: shareA,
      createdBy: memberA,
      filename: older,
      lengthBytes: 100,
      offsetBytes: 10,
      updatedSecondsAgo: 600,
    });
    await seed({
      organizationId: orgA,
      shareId: shareA,
      createdBy: memberA,
      filename: newer,
      lengthBytes: 100,
      offsetBytes: 10,
      updatedSecondsAgo: 1,
    });

    const rows = await transfers.list(orgA, memberA);
    const olderAt = rows.findIndex((r) => r.filename === older);
    const newerAt = rows.findIndex((r) => r.filename === newer);
    expect(newerAt).toBeGreaterThanOrEqual(0);
    expect(olderAt).toBeGreaterThan(newerAt);
  });

  it('hands the byte counts back without rounding them through a JavaScript number', async () => {
    // node-postgres returns `bigint` as a string, and this asserts the service does not quietly
    // undo that. The controller parses it once, at the contract boundary, where the loss is a
    // decision rather than an accident.
    const big = `big-${randomUUID()}.bin`;
    await seed({
      organizationId: orgA,
      shareId: shareA,
      createdBy: memberA,
      filename: big,
      lengthBytes: Number.MAX_SAFE_INTEGER,
      offsetBytes: 0,
      updatedSecondsAgo: 1,
    });

    const row = byName(await transfers.list(orgA, memberA), big);
    expect(row?.length_bytes).toBe('9007199254740991');
  });

  it('refuses an offset past the declared length, at the database', async () => {
    // 23514. The transfer list reports progress as `offsetBytes` against `lengthBytes`, and a row
    // where the first exceeds the second would render as more than 100% — the constraint is what
    // makes that unrepresentable rather than something the UI has to clamp.
    await expect(
      seed({
        organizationId: orgA,
        shareId: shareA,
        createdBy: memberA,
        filename: `impossible-${randomUUID()}.bin`,
        lengthBytes: 100,
        offsetBytes: 101,
        updatedSecondsAgo: 1,
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  /**
   * ── CEVAP BEKLEYEN BİR YÜKLEME LİSTEDEN DÜŞMEZ ────────────────────────────────────────────
   *
   * Bu iki test sahada ölçülmüş bir kusurun karşılığı. Cihazda 235 yükleme kararı bekliyordu ve
   * ekran onların yalnız 75'ini gösteriyordu: 12'si 24 saatlik pencerenin dışında kalmıştı, 148'i
   * 200'lük tavana takılmıştı — çünkü tavanı yayımlanmış ve süren yüklemelerle paylaşıyorlardı.
   *
   * Kesilen satır bir kayıt değil, YAPILACAK BİR İŞTİ: 663 MB bayt sunucuda duruyordu ve onları
   * yayımlatacak tek düğme o listedeydi. Kesmek, kullanıcının çıkış yolunu bir terminal yapıyordu.
   */
  it('bir günden eski bile olsa cevap bekleyen yüklemeyi listeden düşürmüyor', async () => {
    const bekleyen = `bekleyen-eski-${randomUUID()}.jpeg`;
    // Pencerenin İKİ KATI kadar eski, ve baytların hepsi gelmiş. Yayımlanmamış olması bir
    // aksaklık değil: kullanıcıya sorulan soru henüz cevaplanmadı.
    await seed({
      organizationId: orgA,
      shareId: shareA,
      createdBy: memberA,
      filename: bekleyen,
      lengthBytes: 1000,
      offsetBytes: 1000,
      updatedSecondsAgo: 48 * 3600,
      createdSecondsAgo: 49 * 3600,
    });

    const rows = await transfers.list(orgA, memberA);
    expect(byName(rows, bekleyen)).toBeDefined();
    // Ve hâlâ "tamamlandı" demiyor: baytlar geldi, dosya yayımlanmadı.
    expect(byName(rows, bekleyen)?.state).not.toBe('completed');
  });

  it('tavanı dolduran yeni satırlar, cevap bekleyen bir yüklemeyi dışarı itmiyor', async () => {
    const bekleyen = `bekleyen-tavan-${randomUUID()}.jpeg`;
    await seed({
      organizationId: orgA,
      shareId: shareA,
      createdBy: memberA,
      filename: bekleyen,
      lengthBytes: 1000,
      offsetBytes: 1000,
      updatedSecondsAgo: 5 * 3600,
    });

    // TAVANDAN FAZLASI, ve hepsi bekleyen satırdan DAHA YENİ: "en yenisi önce" sıralamasında
    // bekleyen satır tavanın altında kalıyor, ve eski sorgu onu tam olarak burada kaybediyordu.
    // Tek bir INSERT: iki yüz ayrı tur, ölçtüğü şeyden uzun sürerdi.
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO public.upload_sessions
           (organization_id, share_id, parent_id, created_by, filename, staging_name,
            length_bytes, offset_bytes, created_at, updated_at)
         SELECT $1, $2, NULL, $3, 'dolgu-' || $4 || '-' || i || '.bin', gen_random_uuid() || '.part',
                1000, 10, now() - interval '1 hour', now() - make_interval(secs => i)
           FROM generate_series(1, 220) AS i`,
        [orgA, shareA, memberA, randomUUID()],
      ),
    );

    const rows = await transfers.list(orgA, memberA);
    expect(byName(rows, bekleyen)).toBeDefined();

    // Ve sayı listeden değil tablodan geliyor: tavana takılan bir listenin uzunluğu, "kaç dosya
    // bekliyor" sorusunun cevabı değil.
    const total = await transfers.awaitingCount(orgA, memberA);
    expect(total).toBeGreaterThanOrEqual(1);
    // Dolgu satırlarının hiçbiri sayılmıyor: baytları eksik, yani kimse onlar için bir soruya
    // cevap beklemiyor.
    expect(total).toBeLessThan(220);
  });
});
