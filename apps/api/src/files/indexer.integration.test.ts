import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AgentRequest, AgentResponse, AgentService } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import { PosixIdentityService } from '../identity/posix.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import { FilesService } from './files.service.js';
import { IndexerService, RECONCILE_KIND } from './indexer.service.js';

/**
 * The reconciliation walk, against a real PostgreSQL and a fake filesystem.
 *
 * The agent's half — that a listing really reads a directory under `RESOLVE_BENEATH` and really
 * drops symlinks — is measured on the Rust side against a real kernel. What only this side can
 * measure is what the walk DECIDES: that an SMB write becomes a row, that a deleted file loses
 * one, that a clipped listing removes nothing, and that a trashed entry does not come back from
 * the dead every fifteen minutes.
 *
 * Skipped unless `DEPSIS_TEST_DATABASE_URL` and `DEPSIS_TEST_OWNER_DATABASE_URL` point at a
 * migrated database.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];
const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

/** A directory, as the fake disk holds it: path (share-relative, '/' joined) → entries. */
type Disk = Map<
  string,
  { entries: Array<{ name: string; directory: boolean; size: number }>; truncated?: boolean }
>;

function stubAgent(disk: Disk): AgentService {
  return {
    isAvailable: () => true,
    call: (request: AgentRequest): Promise<AgentResponse> => {
      if (request.op !== 'list_directory') {
        return Promise.resolve<AgentResponse>({ status: 'ok', schema_version: 10 });
      }
      const key = request.path.join('/');
      const found = disk.get(key);
      if (found === undefined) {
        return Promise.resolve<AgentResponse>({ status: 'not_found', reason: `${key}: gone` });
      }
      return Promise.resolve<AgentResponse>({
        status: 'listing',
        truncated: found.truncated ?? false,
        entries: found.entries.map((entry) => ({
          name: entry.name,
          directory: entry.directory,
          size: entry.size,
          // Fixed, so a second pass over an unchanged disk reports nothing changed.
          modified_unix: 1_700_000_000,
        })),
      });
    },
  } as unknown as AgentService;
}

describeDb('reconciling a share with the disk', () => {
  let db: DbService;
  let owner: DbService;
  let org = '';
  let admin = '';
  let share = '';

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name) VALUES ('index-a','Index A')
         ON CONFLICT (slug) DO NOTHING`,
      );
      org =
        (
          await q.query<{ id: string }>(
            `SELECT id::text AS id FROM organizations WHERE slug = 'index-a'`,
          )
        )[0]?.id ?? '';
      await q.query(`DELETE FROM job_queue WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM file_entries WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM folder_grants WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM shares WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM users WHERE organization_id = $1`, [org]);
      admin =
        (
          await q.query<{ id: string }>(
            `INSERT INTO users (organization_id, username, role, password_hash)
             VALUES ($1, 'index-admin', 'admin', 'x') RETURNING id::text AS id`,
            [org],
          )
        )[0]?.id ?? '';
      share =
        (
          await q.query<{ id: string }>(
            `INSERT INTO shares (organization_id, name, dataset)
             VALUES ($1, 'idx', 'tank/depsis/idx') RETURNING id::text AS id`,
            [org],
          )
        )[0]?.id ?? '';
    });
  });

  beforeEach(async () => {
    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(`DELETE FROM job_queue WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM index_queue WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM file_entries WHERE organization_id = $1`, [org]);
    });
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM job_queue WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM file_entries WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM folder_grants WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM shares WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM users WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM teams WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM organizations WHERE id = $1`, [org]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  function indexer(disk: Disk): IndexerService {
    const agent = stubAgent(disk);
    const files = new FilesService(db, agent, new PosixIdentityService(db), new JobsService(db));
    return new IndexerService(db, agent, files);
  }

  const held = (): Promise<boolean> => Promise.resolve(true);

  async function paths(): Promise<string[]> {
    const rows = await db.withTenant(org, (q) =>
      q.query<{ path: string }>(
        `SELECT path FROM public.file_entries WHERE organization_id = $1 AND trashed_at IS NULL
          ORDER BY path`,
        [org],
      ),
    );
    return rows.map((r) => r.path);
  }

  /** A row DEPSIS already knows about. */
  async function row(
    parent: string | null,
    kind: 'folder' | 'file',
    name: string,
    path: string,
    bytes = 0,
    trashed = false,
  ): Promise<string> {
    const rows = await owner.withoutTenant('migration-status', (q) =>
      q.query<{ id: string }>(
        `INSERT INTO file_entries
           (organization_id, share_id, parent_id, kind, name, path, size_bytes,
            updated_at, trashed_at, trashed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp(1700000000),
                 CASE WHEN $8 THEN now() ELSE NULL END,
                 CASE WHEN $8 THEN $9::uuid ELSE NULL END)
         RETURNING id::text AS id`,
        [org, share, parent, kind, name, path, bytes, trashed, admin],
      ),
    );
    return rows[0]?.id ?? '';
  }

  it('keeps walking when ONE folder cannot be listed', async () => {
    // ── SAHADAN GELEN ARIZA ───────────────────────────────────────────────────────────────
    //
    // `listing` ajan 'listing'/'not_found' dışında bir şey söylediğinde fırlatıyor, ve fırlayan
    // hata BÜTÜN turu bitiriyordu: adı ajanın kabul etmediği bir karakter taşıyan tek bir klasör,
    // izinleri bozulmuş tek bir dizin, ya da tam o an silinmiş bir yol — hepsi paylaşımın
    // tamamının indekslenmesini durduruyordu.
    //
    // Sahibinin bildirdiği belirti buydu: "samba ile yükleniyor, arayüzde görünmüyor."
    const disk: Disk = new Map([
      [
        '',
        {
          entries: [
            { name: 'saglam', directory: true, size: 0 },
            { name: 'bozuk', directory: true, size: 0 },
          ],
        },
      ],
      ['saglam', { entries: [{ name: 'gorunmeli.txt', directory: false, size: 7 }] }],
      // 'bozuk' diskte YOK — ama `not_found` değil, ajan başka bir şey söylüyor (aşağıda).
    ]);

    const agent = {
      isAvailable: () => true,
      call: (request: AgentRequest): Promise<AgentResponse> => {
        if (request.op !== 'list_directory') {
          return Promise.resolve<AgentResponse>({ status: 'ok', schema_version: 10 });
        }
        if (request.path.join('/') === 'bozuk') {
          // Ajanın reddi: 'listing' de değil 'not_found' da değil. Eski hâlde bu, turu bitiren
          // bir istisnaya dönüşüyordu.
          return Promise.resolve<AgentResponse>({ status: 'refused', reason: 'okunamadı' });
        }
        const found = disk.get(request.path.join('/'));
        if (found === undefined) {
          return Promise.resolve<AgentResponse>({ status: 'not_found', reason: 'gone' });
        }
        return Promise.resolve<AgentResponse>({
          status: 'listing',
          truncated: false,
          entries: found.entries.map((entry) => ({
            name: entry.name,
            directory: entry.directory,
            size: entry.size,
            modified_unix: 1_700_000_000,
          })),
        });
      },
    } as unknown as AgentService;

    const service = new IndexerService(
      db,
      agent,
      new FilesService(db, agent, new PosixIdentityService(db), new JobsService(db)),
    );

    // Tur DÜŞMÜYOR, ve okunabilen tarafın dosyası dizine giriyor.
    await service.reconcile(org, share, held, 'test');
    await service.reconcile(org, share, held, 'test');

    expect(await paths()).toContain('/saglam/gorunmeli.txt');
  });

  it('still fails the pass when NOTHING can be listed', async () => {
    // Tek bir klasörün okunamaması bir klasör sorunu; hiçbirinin okunamaması bir KESİNTİ. İkisini
    // aynı saymak, ajanı kapalı bir cihazda "0 klasör tarandı, her şey yolunda" demek olurdu — ve
    // indeksin boş kalması normal görünürdü.
    const agent = {
      isAvailable: () => true,
      call: (request: AgentRequest): Promise<AgentResponse> =>
        request.op === 'list_directory'
          ? Promise.resolve<AgentResponse>({ status: 'refused', reason: 'ajan kapalı' })
          : Promise.resolve<AgentResponse>({ status: 'ok', schema_version: 10 }),
    } as unknown as AgentService;

    const service = new IndexerService(
      db,
      agent,
      new FilesService(db, agent, new PosixIdentityService(db), new JobsService(db)),
    );

    await expect(service.reconcile(org, share, held, 'test')).rejects.toThrow(/yanıt vermiyor/);
  });

  it('writes a row for a file DEPSIS has never seen — the SMB write', async () => {
    // The acceptance criterion, in one test. Before this, a file created from Windows was invisible
    // to the web interface, to search and to the permission walk.
    const disk: Disk = new Map([
      ['', { entries: [{ name: 'windows.docx', directory: false, size: 4096 }] }],
    ]);

    const result = await indexer(disk).reconcile(org, share, held, 'test');
    expect(result).toMatchObject({ discovered: 1, removed: 0 });
    expect(await paths()).toEqual(['/windows.docx']);
  });

  it('reads a directory with more entries than one listing can carry', async () => {
    // ── SAHADAN GELEN ARIZA ───────────────────────────────────────────────────────────────
    //
    // Cihazın paylaşım kökünde 20.246 klasör vardı. Ajanın tek bir cevabı `MAX_LISTING` (5.000)
    // satırda kesiliyor, ve çağıranın yapacak bir şeyi yoktu: dizin yalnız 11.941 satırla doldu
    // ve HİÇBİR ZAMAN tamamlanamadı. Yürüyüş her üç saniyede bir koşup her seferinde aynı ilk
    // 5.000'i görüyor, "bu klasörde daha var" diye uyarıp duruyordu.
    //
    // ── NEDEN YİRMİ BİN SATIRLA ÖLÇÜLMÜYOR ────────────────────────────────────────────────
    //
    // Ölçülen şey SAYFA SINIRINI GEÇEBİLMEK, ve o mantık sayfa boyu üç olduğunda da beş bin
    // olduğunda da aynı. Gerçek sayıyla kurulan bir test, bu süite on iki bin satır ve saniyeler
    // ekler — ve ölçtüğü şeyi bir gram daha kesin ölçmez.
    const all = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt', 'g.txt'];
    const PAGE = 3;
    const pages: Array<string | undefined> = [];

    const agent = {
      isAvailable: () => true,
      call: (request: AgentRequest): Promise<AgentResponse> => {
        if (request.op !== 'list_directory') {
          return Promise.resolve<AgentResponse>({ status: 'ok', schema_version: 10 });
        }
        if (request.path.length > 0) {
          return Promise.resolve<AgentResponse>({
            status: 'listing',
            truncated: false,
            entries: [],
          });
        }
        // Ajan gibi: ada göre sıralı, `after`dan KESİN OLARAK sonrası, sayfa başına en fazla
        // `PAGE`, ve daha varsa `truncated`.
        const after = (request as { after?: string }).after;
        pages.push(after);
        const rest = all.filter((name) => after === undefined || name > after);
        return Promise.resolve<AgentResponse>({
          status: 'listing',
          truncated: rest.length > PAGE,
          entries: rest.slice(0, PAGE).map((name) => ({
            name,
            directory: false,
            size: 4,
            modified_unix: 1_700_000_000,
          })),
        });
      },
    } as unknown as AgentService;

    const service = new IndexerService(
      db,
      agent,
      new FilesService(db, agent, new PosixIdentityService(db), new JobsService(db)),
    );
    const result = await service.reconcile(org, share, held, 'test');

    // Yedisi de girdi — eski hâlde yalnız ilk üçü girer ve orada kalırdı.
    expect(result.discovered).toBe(all.length);
    expect((await paths()).sort()).toEqual(all.map((n) => `/${n}`).sort());

    // Üç sayfa, ve imleç HER SEFERİNDE bir önceki sayfanın son adı.
    expect(pages).toEqual([undefined, 'c.txt', 'f.txt']);

    // Ve KIRPILMIŞ SAYILMIYOR: kırpılmış sayılsaydı bu klasörün altında hiçbir şey silinemezdi.
    expect(result.truncated).toBe(0);
  });

  it('rests between passes instead of spinning when a share is bigger than one batch', async () => {
    // `hasUnscanned` "BU TURDA okunmamış klasör var mı" diye soruyordu, ve bir paylaşımda
    // BATCH'ten fazla klasör olduğu anda cevabı sonsuza kadar evet oluyordu: her tur BATCH
    // tanesini damgalıyor, geri kalanın damgası hep bu turun başlangıcından eski kalıyor.
    //
    // Sahada ölçüldü: on beş dakikada bir koşması gereken iş, yirmi dakikada 684 kez koştu.
    const count = IndexerService.BATCH + 40;
    const many: Disk = new Map([
      [
        '',
        {
          entries: Array.from({ length: count }, (_, i) => ({
            name: `d${String(i).padStart(4, '0')}`,
            directory: true,
            size: 0,
          })),
        },
      ],
    ]);
    for (let i = 0; i < count; i += 1) {
      many.set(`d${String(i).padStart(4, '0')}`, { entries: [] });
    }

    const service = indexer(many);
    let more = true;
    let passes = 0;
    while (more && passes < 10) {
      more = (await service.reconcile(org, share, held, 'test')).more;
      passes += 1;
    }

    // Hepsi AZ ÖNCE okundu, yani zincir dinleniyor. Eski hâlde bu döngü 10'da tükenirdi.
    expect(more).toBe(false);
    expect(passes).toBeLessThan(10);
  });

  it('walks into folders it discovers', async () => {
    const disk: Disk = new Map([
      ['', { entries: [{ name: 'proje', directory: true, size: 0 }] }],
      ['proje', { entries: [{ name: 'plan.xlsx', directory: false, size: 11 }] }],
    ]);

    const result = await indexer(disk).reconcile(org, share, held, 'test');
    expect(result.discovered).toBe(2);
    expect(await paths()).toEqual(['/proje', '/proje/plan.xlsx']);
  });

  it('changes nothing on a second pass over an unchanged disk', async () => {
    // The property that makes a fifteen-minute schedule bearable. A pass that "found" something
    // every time would rewrite every row forever and make `updated_at` meaningless.
    const disk: Disk = new Map([['', { entries: [{ name: 'a.txt', directory: false, size: 3 }] }]]);
    const service = indexer(disk);
    await service.reconcile(org, share, held, 'test');

    const again = await service.reconcile(org, share, held, 'test');
    expect(again).toMatchObject({ discovered: 0, updated: 0, removed: 0 });
  });

  it('removes a row whose file is gone from disk', async () => {
    await row(null, 'file', 'silinmis.txt', '/silinmis.txt', 5);
    const disk: Disk = new Map([['', { entries: [] }]]);

    const result = await indexer(disk).reconcile(org, share, held, 'test');
    expect(result.removed).toBe(1);
    expect(await paths()).toEqual([]);
  });

  it('forgets a file that arrived through an upload, whose session still names it', async () => {
    // ── SAHADAN GELEN ARIZA, YENİDEN ÜRETİLMİŞ ────────────────────────────────────────────
    //
    // Cihazın sahibi ağ sürücüsünden yüklediği dosyaların arayüzde hiç görünmediğini bildirdi.
    // Cihazda dizinde 1702, diskte 2044 öğe vardı, ve uzlaştırma turu şununla ölüyordu:
    //
    //   "upload_sessions" tablosuna girilen yeni satır "upload_sessions_completion_pair"
    //   check kısıtlamasını ihlal ediyor
    //
    // Sebep iki şema kuralının çelişmesiydi: `file_id` ON DELETE SET NULL, ama eski CHECK dolu
    // bir `completed_at` yanında NULL bir `file_id`i yasaklıyordu. Yani web'den yüklenmiş bir
    // dosyayı ağ sürücüsünden silmek, o satırı silmeye çalışan turu öldürüyordu — ve tur ölünce
    // ağdan yazılan hiçbir dosya bir daha indekslenmiyordu.
    //
    // Ölçülen şey turun HAYATTA KALMASI: dosya dizinden düşüyor, ve aynı turda keşfedilen yeni
    // dosya dizine giriyor.
    const before: Disk = new Map([
      ['', { entries: [{ name: 'yuklenen.txt', directory: false, size: 5 }] }],
    ]);
    await indexer(before).reconcile(org, share, held, 'test');

    const entry = await db.withTenant(org, (q) =>
      q.query<{ id: string }>(
        `SELECT id::text AS id FROM file_entries WHERE share_id = $1 AND name = 'yuklenen.txt'`,
        [share],
      ),
    );
    const fileId = entry[0]?.id;
    expect(fileId).toBeDefined();

    // Web'den yüklenmiş gibi: TAMAMLANMIŞ bir oturum, o dosyayı adlıyor.
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO upload_sessions
           (organization_id, share_id, parent_id, created_by, filename, staging_name,
            length_bytes, offset_bytes, file_id, completed_at)
         VALUES ($1, $2, NULL, $3, 'yuklenen.txt', 'stg-yuklenen', 5, 5, $4, now())`,
        [org, share, admin, fileId],
      ),
    );

    // Dosya ağ sürücüsünden silindi, ve aynı anda yenisi yazıldı.
    const after: Disk = new Map([
      ['', { entries: [{ name: 'yeni-gelen.txt', directory: false, size: 9 }] }],
    ]);
    await indexer(after).reconcile(org, share, held, 'test');

    const paths_ = await paths();
    expect(paths_).not.toContain('/yuklenen.txt');
    // ASIL ÖLÇÜM: tur ölmediği için sıradaki dosya da geldi.
    expect(paths_).toContain('/yeni-gelen.txt');
  });

  it('removes a whole subtree when its folder is gone', async () => {
    const folder = await row(null, 'folder', 'eski', '/eski');
    await row(folder, 'file', 'a.txt', '/eski/a.txt', 3);
    // The share root lists nothing; `eski` itself is not listable either.
    const disk: Disk = new Map([['', { entries: [] }]]);

    const result = await indexer(disk).reconcile(org, share, held, 'test');
    expect(result.removed).toBe(2);
    expect(await paths()).toEqual([]);
  });

  it('deletes NOTHING when the share ROOT itself is missing from disk', async () => {
    // ── HAVUZ BAĞLI DEĞİL ─────────────────────────────────────────────────────────────────
    //
    // Havuz içe aktarılmamış ya da veri kümesi bağlanmamışken /srv/depsis duruyor ama paylaşımın
    // dizini yok, yani KÖK dahil her yol `not_found`. Eski hâlde kökün cevabı yalnız atlanıyordu
    // (kökün satırı yok, silinecek bir şey yok) ve tur bayat klasörlerle devam ediyordu: her biri
    // 'gone' → alt ağacın bütün satırları, KLASÖR YETKİLERİ ve görev bağları CASCADE ile gidiyordu.
    // Havuz geri gelince dosyalar yeni kimliklerle geri geliyor, yetkiler gelmiyor.
    const folder = await row(null, 'folder', 'arsiv', '/arsiv');
    await row(folder, 'file', 'a.txt', '/arsiv/a.txt', 3);

    await expect(indexer(new Map()).reconcile(org, share, held, 'test')).rejects.toThrow(
      /kökü diskte yok/,
    );
    expect(await paths()).toEqual(['/arsiv', '/arsiv/a.txt']);
  });

  it('removes NOTHING under a folder whose listing had to be clipped', async () => {
    // The one mistake this pass must never make. A truncated listing says nothing about the names
    // it did not report, so reconciling half a directory and deleting the rest of the rows would
    // destroy the index for a folder whose only crime is being large.
    await row(null, 'file', 'gorunmeyen.txt', '/gorunmeyen.txt', 5);
    const disk: Disk = new Map([
      ['', { truncated: true, entries: [{ name: 'baska.txt', directory: false, size: 1 }] }],
    ]);

    const result = await indexer(disk).reconcile(org, share, held, 'test');
    expect(result.truncated).toBe(1);
    expect(result.removed).toBe(0);
    // The new one is still learned about — a clipped listing is incomplete, not wrong.
    expect(await paths()).toEqual(['/baska.txt', '/gorunmeyen.txt']);
  });

  it('does not resurrect a trashed entry whose bytes are still on disk', async () => {
    // The subtle one. The trash is a COLUMN, not a folder, so a trashed file's bytes are still
    // exactly where they were. A pass that counted trashed rows as missing would create a second
    // row for something the user has already deleted, and the bin would refill itself every
    // fifteen minutes.
    await row(null, 'file', 'atilan.txt', '/atilan.txt', 9, true);
    const disk: Disk = new Map([
      ['', { entries: [{ name: 'atilan.txt', directory: false, size: 9 }] }],
    ]);

    const result = await indexer(disk).reconcile(org, share, held, 'test');
    expect(result.discovered).toBe(0);
    expect(await paths()).toEqual([]);

    const all = await db.withTenant(org, (q) =>
      q.query(`SELECT 1 FROM public.file_entries WHERE organization_id = $1`, [org]),
    );
    expect(all).toHaveLength(1);
  });

  it('updates a row whose file grew', async () => {
    await row(null, 'file', 'buyuyen.log', '/buyuyen.log', 100);
    const disk: Disk = new Map([
      ['', { entries: [{ name: 'buyuyen.log', directory: false, size: 900 }] }],
    ]);

    const result = await indexer(disk).reconcile(org, share, held, 'test');
    expect(result).toMatchObject({ updated: 1, discovered: 0, removed: 0 });
    const rows = await db.withTenant(org, (q) =>
      q.query<{ size_bytes: string }>(
        `SELECT size_bytes::text AS size_bytes FROM public.file_entries WHERE organization_id = $1`,
        [org],
      ),
    );
    expect(rows[0]?.size_bytes).toBe('900');
  });

  it('replaces a row whose kind no longer matches the disk', async () => {
    // Somebody deleted the file over SMB and made a directory with the same name. The row
    // describes something that does not exist; the disk is the authority.
    await row(null, 'file', 'rapor', '/rapor', 12);
    const disk: Disk = new Map([
      ['', { entries: [{ name: 'rapor', directory: true, size: 0 }] }],
      ['rapor', { entries: [{ name: 'ic.txt', directory: false, size: 4 }] }],
    ]);

    const result = await indexer(disk).reconcile(org, share, held, 'test');
    expect(result.removed).toBe(1);
    expect(result.discovered).toBe(2);
    const kinds = await db.withTenant(org, (q) =>
      q.query<{ kind: string; path: string }>(
        `SELECT kind, path FROM public.file_entries WHERE organization_id = $1 ORDER BY path`,
        [org],
      ),
    );
    expect(kinds).toEqual([
      { kind: 'folder', path: '/rapor' },
      { kind: 'file', path: '/rapor/ic.txt' },
    ]);
  });

  it('never asks the agent to delete anything', async () => {
    // What makes an unattended schedule safe. A row goes from the DATABASE because the file is
    // already gone; there is no path from this class to a destructive agent operation.
    const seen: string[] = [];
    const disk: Disk = new Map([['', { entries: [] }]]);
    await row(null, 'file', 'yok.txt', '/yok.txt', 1);

    const agent = {
      isAvailable: () => true,
      call: (request: AgentRequest): Promise<AgentResponse> => {
        seen.push(request.op);
        return stubAgent(disk).call(request, 'r', 'c');
      },
    } as unknown as AgentService;
    const files = new FilesService(db, agent, new PosixIdentityService(db), new JobsService(db));
    await new IndexerService(db, agent, files).reconcile(org, share, held, 'test');

    expect(seen).toEqual(['list_directory']);
  });

  it('stops when the lease is gone and says there is more to do', async () => {
    const disk: Disk = new Map([
      ['', { entries: [{ name: 'a', directory: true, size: 0 }] }],
      ['a', { entries: [] }],
    ]);
    let calls = 0;
    const report = (): Promise<boolean> => {
      calls += 1;
      return Promise.resolve(calls < 2);
    };
    const result = await indexer(disk).reconcile(org, share, report, 'test');
    expect(result.more).toBe(true);
  });

  // ── the fast path: ADR-0011 Layer 1 ──

  it('reconciles ONE directory without walking below it', async () => {
    // The whole point of the fast path. A Samba audit line names one directory; re-reading the
    // share to find one new file would make a ten-thousand-file copy into ten thousand full walks.
    const disk: Disk = new Map([
      ['', { entries: [{ name: 'proje', directory: true, size: 0 }] }],
      ['proje', { entries: [{ name: 'yeni.txt', directory: false, size: 5 }] }],
      ['proje/alt', { entries: [{ name: 'derin.txt', directory: false, size: 5 }] }],
    ]);
    const folder = await row(null, 'folder', 'proje', '/proje');
    const service = indexer(disk);

    const result = await service.reconcileOne(org, share, ['proje'], 'test');

    expect(result).toMatchObject({ discovered: 1, scanned: 1 });
    // The new file landed under `proje`, and nothing under `proje/alt` was touched — the fake disk
    // has a `derin.txt` there and no row was written for it.
    expect(await paths()).toEqual(['/proje', '/proje/yeni.txt']);
    expect(folder).not.toBe('');
  });

  it('does not descend into a folder it discovers', async () => {
    // One event must not become an unbounded walk. The folder gets a row; its contents wait for
    // their own events, or for the periodic walk.
    const disk: Disk = new Map([
      ['', { entries: [{ name: 'yeni-klasor', directory: true, size: 0 }] }],
      ['yeni-klasor', { entries: [{ name: 'ic.txt', directory: false, size: 3 }] }],
    ]);

    const result = await indexer(disk).reconcileOne(org, share, [], 'test');
    expect(result.discovered).toBe(1);
    expect(await paths()).toEqual(['/yeni-klasor']);
  });

  it('does nothing for a directory DEPSIS has never heard of', async () => {
    // The event names a path with no row anywhere in the chain. Nothing to compare against; the
    // parent's own event, or the walk, will create it.
    const disk: Disk = new Map([['bilinmeyen', { entries: [] }]]);
    const result = await indexer(disk).reconcileOne(org, share, ['bilinmeyen'], 'test');
    expect(result).toMatchObject({ discovered: 0, removed: 0 });
  });

  it('removes a folder whose directory is gone', async () => {
    const folder = await row(null, 'folder', 'silinmis', '/silinmis');
    await row(folder, 'file', 'a.txt', '/silinmis/a.txt', 3);
    // The share root reads fine and does not contain it: the folder is genuinely gone. The disk
    // MUST carry a root — an empty map would mean "the storage is not there", which is the case
    // below and answers differently.
    const disk: Disk = new Map([['', { entries: [] }]]);
    const result = await indexer(disk).reconcileOne(org, share, ['silinmis'], 'test');
    expect(result.removed).toBe(2);
    expect(await paths()).toEqual([]);
  });

  it('deletes NOTHING through the fast path when the share ROOT is missing too', async () => {
    // Aynı ayrım, hızlı yolda. Havuz bağlı değilken paylaşımın altındaki her yol `not_found`
    // dönüyor, ve tek bir Samba denetim satırı bir alt ağacın bütün satırlarını yetkileriyle
    // birlikte sildirmeye yetiyordu. Kök de okunamıyorsa cevap "klasör silinmiş" değil
    // "depolama yok": fırlatılıyor, indekse dokunulmuyor.
    const folder = await row(null, 'folder', 'arsiv', '/arsiv');
    await row(folder, 'file', 'a.txt', '/arsiv/a.txt', 3);

    await expect(indexer(new Map()).reconcileOne(org, share, ['arsiv'], 'test')).rejects.toThrow(
      /kökü diskte yok/,
    );
    expect(await paths()).toEqual(['/arsiv', '/arsiv/a.txt']);
  });

  it('keeps one row per directory however many events arrive', async () => {
    // A copy of ten thousand files into one folder is one queue row whose timestamp moves, not ten
    // thousand rows. The queue grows with CHANGED DIRECTORIES, not with events.
    const service = indexer(new Map());
    for (let n = 0; n < 5; n += 1) {
      await service.enqueuePath(org, share, 'docs', 'ayse', '10.0.0.5');
    }
    await service.enqueuePath(org, share, 'baska', 'veli', '10.0.0.6');

    const queued = await service.queued(org, 50);
    expect(queued.map((q) => q.path).sort()).toEqual(['baska', 'docs']);
    expect(queued.find((q) => q.path === 'baska')?.actor).toBe('veli');
  });

  it('hands out the oldest change first', async () => {
    // A directory somebody is writing to continuously would otherwise hold the front of the queue
    // forever and starve everything behind it.
    const service = indexer(new Map());
    await service.enqueuePath(org, share, 'eski', null, null);
    await owner.withoutTenant('migration-status', (q) =>
      q.query(`UPDATE index_queue SET seen_at = now() - interval '1 hour' WHERE path = 'eski'`),
    );
    await service.enqueuePath(org, share, 'yeni', null, null);

    const queued = await service.queued(org, 50);
    expect(queued.map((q) => q.path)).toEqual(['eski', 'yeni']);
  });

  it('does not lose an event that arrived while the directory was being read', async () => {
    // The reason `dequeue` compares the timestamp. A client that saved a file again while the
    // reconciliation was running must not have that second change thrown away by the delete that
    // follows the first.
    const service = indexer(new Map());
    await service.enqueuePath(org, share, 'docs', null, null);
    const startedAt = new Date();

    // ...and while the pass was running, another event for the same directory.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await service.enqueuePath(org, share, 'docs', 'ayse', null);

    await service.dequeue(org, share, 'docs', startedAt);
    expect((await service.queued(org, 50)).map((q) => q.path)).toEqual(['docs']);
  });

  it('takes the entry off once nothing newer has arrived', async () => {
    const service = indexer(new Map());
    await service.enqueuePath(org, share, 'docs', null, null);
    await service.dequeue(org, share, 'docs', new Date(Date.now() + 1000));
    expect(await service.queued(org, 50)).toEqual([]);
  });

  it('finds a share by the name Samba knows it as, folded', async () => {
    // The audit stream names the SHARE — that is the only identifier smbd has — and SMB clients
    // treat `Belgeler` and `belgeler` as one name, which is why `shares_name_unique` folds.
    const service = indexer(new Map());
    expect(await service.shareByName(org, 'idx')).toBe(share);
    expect(await service.shareByName(org, 'IDX')).toBe(share);
    expect(await service.shareByName(org, 'boyle-bir-sey-yok')).toBeNull();
  });

  it('refuses to be scheduled twice for one share, and allows a second share', async () => {
    // Migration 0024 is what makes `ON CONFLICT DO NOTHING` mean anything. Without it every boot
    // would leave another copy, and two passes over one share would race each other's writes.
    const service = indexer(new Map());
    await service.schedule(org, share, new Date());
    await service.schedule(org, share, new Date());

    const other =
      (
        await owner.withoutTenant('migration-status', (q) =>
          q.query<{ id: string }>(
            `INSERT INTO shares (organization_id, name, dataset)
             VALUES ($1, 'idx2', 'tank/depsis/idx2') RETURNING id::text AS id`,
            [org],
          ),
        )
      )[0]?.id ?? '';
    await service.schedule(org, other, new Date());

    const rows = await db.withTenant(org, (q) =>
      q.query(`SELECT 1 FROM public.job_queue WHERE organization_id = $1 AND kind = $2`, [
        org,
        RECONCILE_KIND,
      ]),
    );
    expect(rows).toHaveLength(2);

    await owner.withoutTenant('migration-status', (q) =>
      q.query(`DELETE FROM shares WHERE id = $1`, [other]),
    );
  });
});
