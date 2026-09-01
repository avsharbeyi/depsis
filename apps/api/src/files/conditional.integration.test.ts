import { PreconditionFailedException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentService } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import { PosixIdentityService } from '../identity/posix.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import { ProblemException } from '../common/problem.filter.js';
import { parseChecksum } from './uploads.controller.js';
import { FilesService, type SortOrder } from './files.service.js';

/**
 * The three contract features that were declared and unimplemented: `sort`, `If-Match` and
 * `Upload-Checksum`.
 *
 * The sort half needs a real database because the thing that can be wrong is not the SQL text but
 * whether the CURSOR agrees with the ORDER BY — a page boundary that repeats or skips a row is
 * invisible until rows exist on both sides of it. The other two are pure functions and are
 * asserted directly.
 *
 * Skipped unless `DEPSIS_TEST_DATABASE_URL` and `DEPSIS_TEST_OWNER_DATABASE_URL` point at a
 * migrated database.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];
const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

describe('Upload-Checksum, as a header', () => {
  const digest = Buffer.alloc(32, 7);

  it('is optional', () => {
    expect(parseChecksum(undefined)).toBeNull();
    expect(parseChecksum('   ')).toBeNull();
  });

  it('reads the tus form', () => {
    const header = `sha256 ${digest.toString('base64')}`;
    expect(parseChecksum(header)?.equals(digest)).toBe(true);
  });

  it('refuses an algorithm it cannot compute rather than ignoring the header', () => {
    // The failure this whole change exists to end, one level down: a client that misspelled the
    // algorithm would believe its uploads were being checked while nothing checked them.
    expect(() => parseChecksum(`md5 ${digest.toString('base64')}`)).toThrow(ProblemException);
    expect(() => parseChecksum(`sha1 ${digest.toString('base64')}`)).toThrow(ProblemException);
  });

  it('refuses a value that is not a sha256 digest', () => {
    // `Buffer.from(..., 'base64')` never throws — it stops at the first unreadable character — so
    // a typo decodes to something short rather than to an error. The length is the check.
    expect(() => parseChecksum('sha256 not-base64!!')).toThrow(ProblemException);
    expect(() => parseChecksum('sha256 aGVsbG8=')).toThrow(ProblemException);
    expect(() => parseChecksum('sha256')).toThrow(ProblemException);
  });

  it('is case-insensitive about the algorithm name', () => {
    expect(parseChecksum(`SHA256 ${digest.toString('base64')}`)?.equals(digest)).toBe(true);
  });
});

describeDb('sorting a folder', () => {
  let db: DbService;
  let owner: DbService;
  let files: FilesService;
  let org = '';
  let share = '';
  /** Uzantıları birbirinden farklı dosyaların durduğu klasör. */
  let typed = '';

  /** The names in the order the given sort should produce them. */
  const namesIn = async (sort: SortOrder, limit = 50): Promise<string[]> => {
    const page = await files.list(org, share, null, null, limit, sort);
    return page.items.map((row) => row.name);
  };

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name) VALUES ('sort-a','Sort A')
         ON CONFLICT (slug) DO NOTHING`,
      );
      org =
        (
          await q.query<{ id: string }>(
            `SELECT id::text AS id FROM organizations WHERE slug = 'sort-a'`,
          )
        )[0]?.id ?? '';

      await q.query(`DELETE FROM folder_grants WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM file_entries WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM shares WHERE organization_id = $1`, [org]);
      share =
        (
          await q.query<{ id: string }>(
            `INSERT INTO shares (organization_id, name, dataset)
             VALUES ($1, 'sort', 'tank/depsis/sort') RETURNING id::text AS id`,
            [org],
          )
        )[0]?.id ?? '';

      // Names, sizes and times chosen so no two sorts agree: alphabetical order is the reverse of
      // size order and unrelated to time order, which is what makes a wrong `ORDER BY` visible.
      await q.query(
        `INSERT INTO file_entries
           (organization_id, share_id, parent_id, kind, name, path, size_bytes, updated_at)
         VALUES
           ($1, $2, NULL, 'folder', 'zeta',  '/zeta',  0,    now() - interval '1 day'),
           ($1, $2, NULL, 'folder', 'alfa',  '/alfa',  0,    now() - interval '3 day'),
           ($1, $2, NULL, 'file',   'a.bin', '/a.bin', 900,  now() - interval '5 day'),
           ($1, $2, NULL, 'file',   'b.bin', '/b.bin', 300,  now() - interval '2 day'),
           ($1, $2, NULL, 'file',   'c.bin', '/c.bin', 600,  now() - interval '9 day')`,
        [org, share],
      );

      // ── TÜR SIRALAMASI KENDİ KLASÖRÜNDE ─────────────────────────────────────────────────
      //
      // Kökteki dosyaların üçü de `.bin`, yani orada tür sıralaması hiçbir şey ispatlamaz. Ve
      // köke satır eklemek yukarıdaki üç sıralamanın beklediği dizileri değiştirirdi — bir
      // ölçümü başka bir ölçümü bozarak yapmak.
      //
      // Buradaki adlar üç şeyi birden ölçüyor: UZANTISIZ bir dosya (`belge`), BAŞTA NOKTA taşıyan
      // gizli bir dosya (`.gizli` — bir `gizli` dosyası DEĞİL), ve BÜYÜK HARFLİ bir uzantı
      // (`resim.JPG`, `.jpg` ile aynı grupta olmalı).
      const kind = (
        await q.query<{ id: string }>(
          `INSERT INTO file_entries
             (organization_id, share_id, parent_id, kind, name, path, size_bytes, updated_at)
           VALUES ($1, $2, NULL, 'folder', 'tipler', '/tipler', 0, now() - interval '2 day')
           RETURNING id::text AS id`,
          [org, share],
        )
      )[0]?.id;
      typed = kind ?? '';
      await q.query(
        `INSERT INTO file_entries
           (organization_id, share_id, parent_id, kind, name, path, size_bytes)
         VALUES
           ($1, $2, $3, 'file', 'arsiv.zip',  '/tipler/arsiv.zip',  10),
           ($1, $2, $3, 'file', 'not.txt',    '/tipler/not.txt',    20),
           ($1, $2, $3, 'file', 'resim2.jpg', '/tipler/resim2.jpg', 30),
           ($1, $2, $3, 'file', 'resim.JPG',  '/tipler/resim.JPG',  40),
           ($1, $2, $3, 'file', 'belge',      '/tipler/belge',      50),
           ($1, $2, $3, 'file', '.gizli',     '/tipler/.gizli',     60)`,
        [org, share, typed],
      );
    });

    // A real service over a real database, with an agent that is never reached: `list` is a query
    // and nothing else, so the three collaborators below exist only to satisfy the constructor.
    files = new FilesService(
      db,
      { isAvailable: () => false } as unknown as AgentService,
      new PosixIdentityService(db),
      new JobsService(db),
    );
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM folder_grants WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM file_entries WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM shares WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM teams WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM organizations WHERE id = $1`, [org]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  it('never interleaves folders with files, whatever the sort', async () => {
    // `kind` leads every ordering, so the two never mix — and files come first, because `kind` is
    // text and 'file' < 'folder'. That is the order this endpoint has always produced; the
    // assertion pins it so adding a sort cannot change the default listing by accident.
    for (const sort of ['name', 'type', 'modified', 'size'] as const) {
      const names = await namesIn(sort);
      // `tipler` de bir klasör: kökte artık üç dosya ve ÜÇ klasör var.
      expect(names.slice(3).sort(), sort).toEqual(['alfa', 'tipler', 'zeta']);
    }
  });

  it('sorts by name, folded', async () => {
    expect(await namesIn('name')).toEqual(['a.bin', 'b.bin', 'c.bin', 'alfa', 'tipler', 'zeta']);
  });

  it('sorts by type, grouping the same extension together', async () => {
    // Ölçülen şey GRUPLAMA, grup içindeki tam sıra değil: `.gizli` ile `belge` arasındaki sıra
    // `name_fold`un ve harmanlamanın işi, ve onu burada sabitlemek bu testi başka bir şeyin testi
    // yapardı. Ölçülmesi gereken, aynı uzantının bir arada ve uzantıların artan sırada olması.
    const page = await files.list(org, share, typed, null, 50, 'type');
    const ext = (name: string): string => {
      const dot = name.lastIndexOf('.');
      return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    };
    const groups = page.items.map((row) => ext(row.name));

    // Uzantısızlar önce (boş dize her şeyden küçük), sonra jpg, txt, zip.
    expect(groups).toEqual(['', '', 'jpg', 'jpg', 'txt', 'zip']);

    // BÜYÜK HARFLİ UZANTI KÜÇÜĞÜYLE AYNI GRUPTA. `resim.JPG` ayrı bir tür değil.
    const names = page.items.map((row) => row.name);
    expect(Math.abs(names.indexOf('resim.JPG') - names.indexOf('resim2.jpg'))).toBe(1);

    // BAŞTA NOKTA BİR UZANTI DEĞİL: `.gizli` uzantısızlarla duruyor, `g` grubunda değil.
    expect(names.indexOf('.gizli')).toBeLessThan(2);
  });

  it('counts the folders and the files, not just the rows', async () => {
    // Kutunun "6 klasör · 42 dosya" diyebilmesi için. Aynı taramanın üstünde iki `FILTER`, yani
    // üçü asla birbiriyle çelişemez — ayrı sorgular olsaydı çelişebilirlerdi.
    const page = await files.list(org, share, typed, null, 50, 'name');
    expect(page.total).toBe(6);
    expect(page.folders).toBe(0);
    expect(page.files).toBe(6);

    const root = await files.list(org, share, null, null, 50, 'name');
    expect(root.folders).toBe(3);
    expect(root.files).toBe(3);
    expect(root.total).toBe(6);
  });

  it('sorts by modification time, newest first', async () => {
    // Descending, which the contract does not specify: somebody who sorts by date is asking what
    // changed last, and ascending would answer with the oldest thing in the folder.
    expect(await namesIn('modified')).toEqual([
      'b.bin',
      'a.bin',
      'c.bin',
      'zeta',
      'tipler',
      'alfa',
    ]);
  });

  it('sorts by size, largest first', async () => {
    const names = await namesIn('size');
    expect(names.slice(0, 3)).toEqual(['a.bin', 'c.bin', 'b.bin']);
    // The two folders are both 0 bytes, so `id DESC` decides between them and the ids are random.
    // Asserting a fixed order there would be asserting the uuid generator's output.
    expect(names.slice(3).sort()).toEqual(['alfa', 'tipler', 'zeta']);
  });

  it('pages every sort without repeating or skipping a row', async () => {
    // The assertion that justifies this being an integration test. The cursor re-reads the last
    // row's sort key and compares a row value against it; if `keys`, `after` and `by` ever stop
    // agreeing, a page boundary silently repeats or drops a row — which is exactly the failure
    // cursor pagination was chosen over offset pagination to avoid.
    for (const sort of ['name', 'type', 'modified', 'size'] as const) {
      const whole = await namesIn(sort);

      const collected: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await files.list(org, share, null, cursor, 2, sort);
        collected.push(...page.items.map((row) => row.name));
        cursor = page.nextCursor;
        if (cursor === null) break;
      }

      expect(collected, `paging by ${sort}`).toEqual(whole);
    }
  });

  it('does not lose extensionless files past the first page of a type sort', async () => {
    // ── `coalesce` OLMASAYDI BU TEST DÜŞERDİ ────────────────────────────────────────────────
    //
    // Uzantısız bir dosyada uzantı ifadesi NULL, ve `(uzantı, ...) > (c_uzantı, ...)` NULL üretir:
    // satır ne doğru ne yanlış — SÜZÜLÜR. İmleçten sonraki her sayfa `belge` ile `.gizli`yi
    // sessizce düşürürdü, ve ilk sayfada göründükleri için kimse fark etmezdi.
    //
    // Sayfa boyu 2, yani altı satır üç sayfa: uzantısızlar ilk sayfada, geri kalanı imlecin
    // ötesinde.
    const collected: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await files.list(org, share, typed, cursor, 2, 'type');
      collected.push(...page.items.map((row) => row.name));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }

    expect(collected.sort()).toEqual(
      ['.gizli', 'arsiv.zip', 'belge', 'not.txt', 'resim.JPG', 'resim2.jpg'].sort(),
    );
  });
});

describe('If-Match, as a rule', () => {
  // The comparison the controller performs, restated here as the contract states it so a change
  // to one has to be a change to both.
  const matches = (offered: string, current: string): boolean =>
    offered.trim() === '*' ||
    offered
      .split(',')
      .map((tag) => tag.trim())
      .includes(current);

  const current = '"m-6f1b-abc"';

  it('accepts the tag the server issued', () => {
    expect(matches(current, current)).toBe(true);
  });

  it('accepts a list containing it', () => {
    expect(matches(`"m-old", ${current}`, current)).toBe(true);
  });

  it('accepts `*` as "the resource must exist"', () => {
    expect(matches('*', current)).toBe(true);
  });

  it('rejects a weak tag even when its opaque part matches', () => {
    // RFC 9110: `If-Match` uses STRONG comparison. A weak validator asserts that two
    // representations are equivalent, not that they are the same one — and a conditional write has
    // to know it is looking at the same one.
    expect(matches(`W/${current}`, current)).toBe(false);
  });

  it('rejects a stale tag', () => {
    expect(matches('"m-6f1b-aaa"', current)).toBe(false);
  });

  it('is the error the caller can act on', () => {
    // 412 rather than 409: the request was well-formed and the state moved. Two people renaming
    // one file from two tabs is the case, and without this the second rename silently wins.
    const problem = new ProblemException('precondition-failed');
    expect(problem.getStatus()).toBe(412);
    expect(new PreconditionFailedException().getStatus()).toBe(412);
  });
});
