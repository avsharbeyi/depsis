import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AgentRequest, AgentResponse, AgentService } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import { PosixIdentityService } from '../identity/posix.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import {
  CopyDestinationOccupiedError,
  CopyOutOfSpaceError,
  CopyService,
  CopyTooLargeError,
  type CopyPayload,
} from './copy.service.js';
import { FilesService } from './files.service.js';

/**
 * The copy walk, against a real PostgreSQL and a fake agent.
 *
 * The split is the one the rest of this repository draws: whether `copy_file` actually moves bytes
 * without overwriting anything is measured on the Rust side, against a real filesystem and a real
 * `renameat2`. What cannot be measured there is everything this suite is about — that folders are
 * created before their children, that a folder the user ALREADY had is not merged into, that a
 * redelivery copies nothing twice, and that a caller cannot take a file they may not read.
 *
 * Most of these exist because an adversarial review found the bug first. Each such case says so.
 *
 * Skipped unless `DEPSIS_TEST_DATABASE_URL` and `DEPSIS_TEST_OWNER_DATABASE_URL` point at a
 * migrated database.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];
const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

interface Recorded {
  op: string;
  from?: string;
  to?: string;
}

interface AgentBehaviour {
  /** Destination paths the agent should refuse, as a real one does for a name already on disk. */
  conflicts?: Set<string>;
  /** True once, and the copy answers out of space. */
  outOfSpace?: boolean;
}

function stubAgent(behaviour: AgentBehaviour = {}): { agent: AgentService; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const agent = {
    isAvailable: () => true,
    call: (request: AgentRequest): Promise<AgentResponse> => {
      if (request.op === 'copy_file') {
        const to = request.to.join('/');
        calls.push({ op: request.op, from: request.from.join('/'), to });
        if (behaviour.outOfSpace === true) {
          return Promise.resolve<AgentResponse>({ status: 'out_of_space', reason: 'refquota' });
        }
        if (behaviour.conflicts?.has(to) === true) {
          return Promise.resolve<AgentResponse>({
            status: 'conflict',
            reason: `${to}: something is already there`,
          });
        }
        // One slice is enough for every fixture here.
        return Promise.resolve<AgentResponse>({ status: 'copied', offset: 11, done: true });
      }
      if (request.op === 'create_directory') {
        calls.push({ op: request.op, to: request.path.join('/') });
        return Promise.resolve<AgentResponse>({ status: 'directory_created' });
      }
      calls.push({ op: request.op });
      return Promise.resolve<AgentResponse>({ status: 'ok', schema_version: 9 });
    },
  } as unknown as AgentService;
  return { agent, calls };
}

describeDb('copying a tree', () => {
  let db: DbService;
  let owner: DbService;
  let org = '';
  let admin = '';
  let member = '';
  let share = '';
  let docs = '';
  let inner = '';
  let fileA = '';
  let fileB = '';
  let target = '';

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name) VALUES ('copy-a','Copy A')
         ON CONFLICT (slug) DO NOTHING`,
      );
      org =
        (
          await q.query<{ id: string }>(
            `SELECT id::text AS id FROM organizations WHERE slug = 'copy-a'`,
          )
        )[0]?.id ?? '';
      await q.query(`DELETE FROM file_entries WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM folder_grants WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM shares WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM team_members WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM teams WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM users WHERE organization_id = $1`, [org]);
      const people = await q.query<{ username: string; id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1, 'copy-admin', 'admin', 'x'), ($1, 'copy-uye', 'member', 'x')
         RETURNING username, id::text AS id`,
        [org],
      );
      admin = people.find((r) => r.username === 'copy-admin')?.id ?? '';
      member = people.find((r) => r.username === 'copy-uye')?.id ?? '';
      share =
        (
          await q.query<{ id: string }>(
            `INSERT INTO shares (organization_id, name, dataset)
             VALUES ($1, 'copy', 'tank/depsis/copy') RETURNING id::text AS id`,
            [org],
          )
        )[0]?.id ?? '';
    });
  });

  beforeEach(async () => {
    // A fresh tree per test: `docs/{a.txt, inner/{b.txt}}` and an empty `target/`.
    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(`DELETE FROM folder_grants WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM file_entries WHERE organization_id = $1`, [org]);
      const mk = async (
        parent: string | null,
        kind: 'folder' | 'file',
        name: string,
        path: string,
      ): Promise<string> => {
        const rows = await q.query<{ id: string }>(
          `INSERT INTO file_entries (organization_id, share_id, parent_id, kind, name, path, size_bytes)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text AS id`,
          [org, share, parent, kind, name, path, kind === 'file' ? 11 : 0],
        );
        return rows[0]?.id ?? '';
      };
      docs = await mk(null, 'folder', 'docs', '/docs');
      target = await mk(null, 'folder', 'target', '/target');
      fileA = await mk(docs, 'file', 'a.txt', '/docs/a.txt');
      inner = await mk(docs, 'folder', 'inner', '/docs/inner');
      fileB = await mk(inner, 'file', 'b.txt', '/docs/inner/b.txt');
    });
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM folder_grants WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM file_entries WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM shares WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM team_members WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM teams WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM users WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM organizations WHERE id = $1`, [org]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  function service(behaviour?: AgentBehaviour): { copies: CopyService; calls: Recorded[] } {
    const { agent, calls } = stubAgent(behaviour);
    const posix = new PosixIdentityService(db);
    const files = new FilesService(db, agent, posix, new JobsService(db));
    return { copies: new CopyService(db, agent, files, posix), calls };
  }

  const payload = (
    sourceIds: string[],
    destinationId: string | null,
    actorId = admin,
  ): CopyPayload => ({ shareId: share, sourceIds, destinationId, actorId });

  /** A report that always says the lease is held, and remembers what it was told. */
  function reporter(): { report: (n: number) => Promise<boolean>; seen: number[] } {
    const seen: number[] = [];
    return {
      report: (n) => {
        seen.push(n);
        return Promise.resolve(true);
      },
      seen,
    };
  }

  async function rowsUnder(parentId: string | null): Promise<string[]> {
    const rows = await db.withTenant(org, (q) =>
      q.query<{ name: string }>(
        `SELECT name FROM public.file_entries
          WHERE organization_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND trashed_at IS NULL
          ORDER BY name`,
        [org, parentId],
      ),
    );
    return rows.map((r) => r.name);
  }

  async function idOfPath(path: string): Promise<string> {
    const rows = await db.withTenant(org, (q) =>
      q.query<{ id: string }>(
        `SELECT id::text AS id FROM public.file_entries WHERE organization_id = $1 AND path = $2`,
        [org, path],
      ),
    );
    return rows[0]?.id ?? '';
  }

  it('copies a single file and records a row for it', async () => {
    const { copies, calls } = service();
    const { report } = reporter();
    const result = await copies.copy(org, payload([fileA], target), report, 'test');

    expect(result).toMatchObject({ copied: 1, skipped: 0, refused: 0, total: 1 });
    expect(calls).toEqual([{ op: 'copy_file', from: 'docs/a.txt', to: 'target/a.txt' }]);
    expect(await rowsUnder(target)).toEqual(['a.txt']);
  });

  it('creates a folder before anything inside it', async () => {
    // The whole correctness of the walk. `CreateDirectory` refuses to `mkdir -p`, so a file whose
    // parent has not been made yet comes back `not_found` — the order is not a preference.
    const { copies, calls } = service();
    const { report } = reporter();
    await copies.copy(org, payload([docs], target), report, 'test');

    const order = calls.map((c) => `${c.op} ${c.to ?? ''}`);
    expect(order.indexOf('create_directory target/docs')).toBeLessThan(
      order.indexOf('copy_file target/docs/a.txt'),
    );
    expect(order.indexOf('create_directory target/docs/inner')).toBeLessThan(
      order.indexOf('copy_file target/docs/inner/b.txt'),
    );
  });

  it('reproduces the whole tree under the destination', async () => {
    const { copies } = service();
    const { report } = reporter();
    const result = await copies.copy(org, payload([docs], target), report, 'test');

    expect(result.copied).toBe(4);
    expect(await rowsUnder(target)).toEqual(['docs']);
    expect(await rowsUnder(await idOfPath('/target/docs'))).toEqual(['a.txt', 'inner']);
    expect(await rowsUnder(await idOfPath('/target/docs/inner'))).toEqual(['b.txt']);
  });

  it('makes a SECOND folder when the destination already holds one of that name', async () => {
    // Found by an adversarial review, and it was the worst bug in the feature. Identity was
    // name-shaped for folders, so a folder the user ALREADY had was indistinguishable from one
    // this job had created: the copy merged into it, `docs (2)` was unreachable code, and the
    // children landed inside the user's own folder with no record that they had been added.
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO file_entries (organization_id, share_id, parent_id, kind, name, path, size_bytes)
         VALUES ($1, $2, $3, 'folder', 'docs', '/target/docs', 0)`,
        [org, share, target],
      ),
    );

    const { copies } = service();
    const { report } = reporter();
    await copies.copy(org, payload([docs], target), report, 'test');

    expect(await rowsUnder(target)).toEqual(['docs', 'docs (2)']);
    // The user's own folder is untouched; everything landed in the new one.
    expect(await rowsUnder(await idOfPath('/target/docs'))).toEqual([]);
    expect(await rowsUnder(await idOfPath('/target/docs (2)'))).toEqual(['a.txt', 'inner']);
  });

  /**
   * ÇÖPTEKİ BİR SATIR ADI HÂLÂ TUTUYOR, ve sahada bunun bedeli ödendi.
   *
   * Çöpe atmak satıra bir bayrak yazıyor ama dosyayı diskte KENDİ ADIYLA bırakıyor; tekil indeks
   * çöptekileri dışladığı için liste adı boş gösteriyor. `freeName` de onları görmediği için
   * "boş" dediği ad diskte doluydu: cihazda 143 yükleme tam bu yüzden yayımlanamadı ve iki çıkış
   * yolu da (değiştir, ikisini de tut) aynı duvara çarptı.
   */
  it('çöpteki bir dosyanın tuttuğu adı BOŞ saymıyor', async () => {
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO file_entries
           (organization_id, share_id, parent_id, kind, name, path, size_bytes, trashed_at, trashed_by)
         VALUES ($1, $2, $3, 'file', 'foto.jpg', '/target/foto.jpg', 4, now(), NULL)`,
        [org, share, target],
      ),
    );

    const { copies } = service();

    // Ad çöpte duruyor: bir sonraki boş ad "foto (2).jpg".
    expect(await copies.freeName(org, share, target, 'foto.jpg')).toBe('foto (2).jpg');

    // Ve adı tutan satır BULUNUYOR, çöpte olduğu söylenerek — çağıran onu ikinci kez çöpe
    // atmak yerine park etmeyi seçebilsin diye.
    const holder = await copies.entryNamed(org, share, target, 'foto.jpg');
    expect(holder).not.toBeNull();
    expect(holder?.trashed).toBe(true);
  });

  it('canlı bir dosyanın tuttuğu ad, çöpte sayılmıyor', async () => {
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO file_entries (organization_id, share_id, parent_id, kind, name, path, size_bytes)
         VALUES ($1, $2, $3, 'file', 'canli.jpg', '/target/canli.jpg', 4)`,
        [org, share, target],
      ),
    );

    const { copies } = service();
    const holder = await copies.entryNamed(org, share, target, 'canli.jpg');
    expect(holder?.trashed).toBe(false);
  });

  it('duplicating a folder in place makes a copy instead of merging it into itself', async () => {
    // The same defect from the other direction: copying `docs` into the share root, where `docs`
    // already is. Name-shaped identity found `docs` itself, decided it was its own copy, and
    // poured `a (2).txt` into the original.
    const { copies } = service();
    const { report } = reporter();
    await copies.copy(org, payload([docs], null), report, 'test');

    expect(await rowsUnder(null)).toEqual(['docs', 'docs (2)', 'target']);
    expect(await rowsUnder(docs)).toEqual(['a.txt', 'inner']);
    expect(await rowsUnder(await idOfPath('/docs (2)'))).toEqual(['a.txt', 'inner']);
  });

  it('resolves a file name collision instead of failing or overwriting', async () => {
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO file_entries (organization_id, share_id, parent_id, kind, name, path, size_bytes)
         VALUES ($1, $2, $3, 'file', 'a.txt', '/target/a.txt', 5)`,
        [org, share, target],
      ),
    );

    const { copies, calls } = service();
    const { report } = reporter();
    await copies.copy(org, payload([fileA], target), report, 'test');

    expect(calls[0]?.to).toBe('target/a (2).txt');
    expect(await rowsUnder(target)).toEqual(['a (2).txt', 'a.txt']);
  });

  it('copies nothing twice when the job is redelivered', async () => {
    // At-least-once, which the queue guarantees and §17 requires the handler to absorb.
    const { copies } = service();
    const { report } = reporter();
    const first = await copies.copy(org, payload([docs], target), report, 'test');
    expect(first.copied).toBe(4);

    const again = await copies.copy(org, payload([docs], target), report, 'test');
    expect(again).toMatchObject({ copied: 0, skipped: 4 });
    expect(await rowsUnder(target)).toEqual(['docs']);
    expect(await rowsUnder(await idOfPath('/target/docs'))).toEqual(['a.txt', 'inner']);
  });

  it('selecting a folder together with something inside it copies each node once', async () => {
    // Found by review: without deduplication the inner node appeared twice — once as a root and
    // once as a descendant — the plan never shrank, and the chained job re-enqueued itself forever.
    const { copies } = service();
    const { report } = reporter();
    const result = await copies.copy(org, payload([docs, inner, fileA], target), report, 'test');

    // docs, inner, a.txt, b.txt — four nodes, each once.
    expect(result.total).toBe(4);
    expect(result.copied).toBe(4);
  });

  it('refuses rather than adopting a destination something else already holds', async () => {
    // Found by review. The old code treated an agent `conflict` as "my own copy from a previous
    // attempt" and wrote a row for it — so a file written over SMB became a DEPSIS row claiming to
    // be a copy of something it had nothing to do with. The two cases are indistinguishable from
    // here, so it fails with the path instead and an operator resolves it.
    const { copies } = service({ conflicts: new Set(['target/a.txt']) });
    const { report } = reporter();

    await expect(copies.copy(org, payload([fileA], target), report, 'test')).rejects.toBeInstanceOf(
      CopyDestinationOccupiedError,
    );
    expect(await rowsUnder(target)).toEqual([]);
  });

  it('gives up rather than retrying into a full pool', async () => {
    // ADR-0008: a full dataset is PERMANENT and must not be retried. Its own agent status rather
    // than a generic failure, because five retries would park five more part-files against the
    // quota that is already exhausted.
    const { copies } = service({ outOfSpace: true });
    const { report } = reporter();
    await expect(copies.copy(org, payload([fileA], target), report, 'test')).rejects.toBeInstanceOf(
      CopyOutOfSpaceError,
    );
  });

  it('will not copy a file the requester may not read the contents of', async () => {
    // ADR-0021 lets a subfolder NARROW what its parent grants. Found by review: authorization was
    // checked only on the ids the caller NAMED, and the walk then copied every descendant — so a
    // member with `download` on `docs` and none on `docs/inner` could copy `inner/b.txt` into a
    // folder they control. Exfiltration with the product's own hands.
    await owner.withoutTenant('migration-status', async (q) => {
      // The member may see and take everything in the share...
      await q.query(
        `INSERT INTO folder_grants (organization_id, share_id, entry_id, user_id, permissions)
         VALUES ($1, $2, NULL, $3, ARRAY['list','read','download','create']::public.folder_permission[])`,
        [org, share, member],
      );
      // ...except inside `inner`, where the grant narrows to listing.
      await q.query(
        `INSERT INTO folder_grants (organization_id, share_id, entry_id, user_id, permissions)
         VALUES ($1, $2, $3, $4, ARRAY['list']::public.folder_permission[])`,
        [org, share, inner, member],
      );
    });

    const { copies } = service();
    const { report } = reporter();
    const result = await copies.copy(org, payload([docs], target, member), report, 'test');

    expect(result.refused).toBe(1);
    expect(await rowsUnder(await idOfPath('/target/docs/inner'))).toEqual([]);
    // ...and the rest of the tree still copied.
    expect(await rowsUnder(await idOfPath('/target/docs'))).toEqual(['a.txt', 'inner']);
  });

  it('skips the whole subtree under a refused folder instead of killing the job', async () => {
    // Bulunan kusur: reddedilen bir klasör `placed`e girmiyor, ama İZİNLİ çocuğu yine de sıraya
    // geliyordu — `destinationParent` "klasörün kopyası çocuğundan önce yapılmadı" diye hata
    // fırlatıyor, hata işi ORTASINDA öldürüyor, beş deneme aynı yerde düşüyor ve kullanıcı yarım
    // bir kopyayla açıklamasız bir `dead` iş görüyordu.
    //
    // Ulaşılabilir bir durum, çünkü klasöre `list`, dosyaya `download` ayrı ayrı verilebiliyor:
    // burada üye `inner`ı LİSTELEYEMİYOR ama `inner/b.txt`i indirebiliyor.
    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO folder_grants (organization_id, share_id, entry_id, user_id, permissions)
         VALUES ($1, $2, NULL, $3, ARRAY['list','read','download','create']::public.folder_permission[])`,
        [org, share, member],
      );
      // `inner` üzerinde listeleme yok — klasör reddedilecek...
      await q.query(
        `INSERT INTO folder_grants (organization_id, share_id, entry_id, user_id, permissions)
         VALUES ($1, $2, $3, $4, ARRAY['read','download']::public.folder_permission[])`,
        [org, share, inner, member],
      );
    });

    const { copies } = service();
    const { report } = reporter();
    const result = await copies.copy(org, payload([docs], target, member), report, 'test');

    // İş BİTİYOR: `docs` ve `a.txt` kopyalandı, `inner` ve altındaki `b.txt` reddedildi.
    expect(result).toMatchObject({ copied: 2, refused: 2, total: 4 });
    expect(await rowsUnder(await idOfPath('/target/docs'))).toEqual(['a.txt']);
    // Ve alt ağaç hedefin KÖKÜNE de düşmedi: reddedilen bir klasörün içindekiler ortaya saçılmaz.
    expect(await rowsUnder(target)).toEqual(['docs']);
  });

  it('refuses to run at all when the share was turned read-only after the click', async () => {
    // Uç zaten reddediyor, ama iş kuyruğa girdikten sonra da paylaşım salt okunura çevrilebiliyor.
    // O pencerede işçi hiçbir şey sormadan yazmaya devam ediyordu.
    await owner.withoutTenant('migration-status', (q) =>
      q.query(`UPDATE shares SET read_only = true WHERE id = $1`, [share]),
    );
    const { copies, calls } = service();
    const { report } = reporter();
    try {
      await expect(copies.copy(org, payload([fileA], target), report, 'test')).rejects.toThrow(
        /salt okunur/,
      );
      // Ve tek bir bayt bile taşınmadı.
      expect(calls).toEqual([]);
    } finally {
      await owner.withoutTenant('migration-status', (q) =>
        q.query(`UPDATE shares SET read_only = false WHERE id = $1`, [share]),
      );
    }
  });

  it('refuses to run at all for an account that has since been disabled', async () => {
    // The job runs minutes after the click. Every file it would create would be owned by, and
    // reachable through, an account an administrator has switched off.
    await owner.withoutTenant('migration-status', (q) =>
      q.query(`UPDATE users SET disabled_at = now() WHERE id = $1`, [member]),
    );
    const { copies } = service();
    const { report } = reporter();
    await expect(
      copies.copy(org, payload([fileA], target, member), report, 'test'),
    ).rejects.toThrow(/no longer active/);

    await owner.withoutTenant('migration-status', (q) =>
      q.query(`UPDATE users SET disabled_at = NULL WHERE id = $1`, [member]),
    );
  });

  it('stops when the lease is gone rather than copying on without it', async () => {
    // Two workers copying the same tree would race on `keep_both` names and produce duplicates.
    const { copies } = service();
    let calls = 0;
    const report = (): Promise<boolean> => {
      calls += 1;
      return Promise.resolve(calls < 2);
    };
    const result = await copies.copy(org, payload([docs], target), report, 'test');
    expect(result.copied).toBeLessThan(4);
  });

  it('reports progress that advances across the whole operation', async () => {
    const { copies } = service();
    const { report, seen } = reporter();
    await copies.copy(org, payload([docs], target), report, 'test');

    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(1);
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] ?? 0);
    }
  });

  it('counts the selection before anything is copied', async () => {
    // `size` is what the endpoint calls to refuse an oversized copy on the click. The limit thrown
    // in the worker instead is a deterministic failure the queue retries and then reports `dead`
    // to somebody who was told the copy had started.
    const { copies, calls } = service();
    // Bytes as well as entries: the endpoint uses the weight to refuse a copy the pool cannot
    // hold, which turns an hour-long half-finished failure into an immediate 507.
    expect(await copies.size(org, share, [docs])).toEqual({ entries: 4, bytes: 22 });
    expect(calls).toEqual([]);
  });

  it('refuses a selection larger than it will attempt', async () => {
    const { copies } = service();
    const { report } = reporter();
    const original = CopyService.MAX_ENTRIES;
    Object.defineProperty(CopyService, 'MAX_ENTRIES', { value: 2, configurable: true });
    try {
      await expect(
        copies.copy(org, payload([docs], target), report, 'test'),
      ).rejects.toBeInstanceOf(CopyTooLargeError);
    } finally {
      Object.defineProperty(CopyService, 'MAX_ENTRIES', { value: original, configurable: true });
    }
  });

  it('copies into the share root when no destination is named', async () => {
    const { copies, calls } = service();
    const { report } = reporter();
    await copies.copy(org, payload([fileB], null), report, 'test');
    expect(calls[0]).toEqual({ op: 'copy_file', from: 'docs/inner/b.txt', to: 'b.txt' });
    expect(await rowsUnder(null)).toContain('b.txt');
  });
});
