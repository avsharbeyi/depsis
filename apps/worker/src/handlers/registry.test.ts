import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type {
  AclApplyService,
  AgentService,
  BackupSchedulesService,
  CopyService,
  IdentitySyncService,
  IndexerService,
  JobsService,
  NotificationsService,
  TrashRetentionService,
} from '@depsis/api/worker-surface';

import { registerHandlers } from './registry.js';
import { reconcileHandler, RECONCILE_KIND } from './reconcile.handler.js';
import { indexDrainHandler, INDEX_DRAIN_KIND } from './index-drain.handler.js';
import { WorkerService } from '../worker.service.js';

/**
 * The kinds this worker will actually claim.
 *
 * A list rather than a behaviour, and it earns its place because of how the gap showed up:
 * `PermissionsService` had been enqueuing `permissions.apply` since §6.2's endpoints were served,
 * every one of those rows was unclaimable because no handler was registered, and nothing failed.
 * The API's own test asserted a row landed on the queue; nothing asserted anybody would ever take
 * it off. Adding an enqueue without adding the consumer has to break something, and this is it.
 *
 * AMA BU LİSTE TEK BAŞINA HİÇBİR ŞEY ÖLÇMÜYORDU: elle yazılmış bir dizi, elle yazılmış bir diziyle
 * karşılaştırılıyordu. Kaydı unutan kişi listeyi de güncellemezse test yalnız "liste değişti" der,
 * ve API'nin kuyruğa koyduğu YENİ bir türden hiç haberi olmaz — yani anlattığı arızayı yine
 * yakalayamazdı. Asıl kapı aşağıda: türler API kaynağından ÇIKARILIYOR ve her biri için bir
 * işleyici aranıyor. Liste envanter olarak kalıyor, kapı olarak değil.
 */
/**
 * Zincirli işlerin ardılı, İŞTEN ÖNCE mi kuruluyor?
 *
 * ── NEDEN ÖLÇÜLÜYOR ────────────────────────────────────────────────────────────────────────
 *
 * `files.reconcile` ve `files.index-drain` ardılını iş BİTTİKTEN sonra kuruyordu. `max_attempts`
 * tükendiğinde iş kalıcı olarak ölüyor ve kimse ardılını kurmuyordu — yani ağ sürücüsünden
 * yazılan dosyalar API yeniden başlayana kadar bir daha hiç indekslenmiyordu. Sahibinin
 * bildirdiği belirti buydu.
 *
 * Ölçülen şey SIRA: işleyici, işi yapan çağrıdan önce zamanlama çağrısını yapmalı. Bunu bir
 * çağrı defterine bakarak ölçüyoruz, çünkü sırayı tip sistemi söyleyemez.
 */
describe('chained handlers queue their successor first', () => {
  it('schedules the next reconcile before doing the work', async () => {
    const calls: string[] = [];
    const indexer = {
      schedule: () => {
        calls.push('schedule');
        return Promise.resolve();
      },
      hurryUp: () => Promise.resolve(),
      reconcile: () => {
        calls.push('work');
        // İŞ DÜŞÜYOR — ve asıl ölçüm bu: ardıl yine de kurulmuş olmalı.
        return Promise.reject(new Error('ajan yanıt vermiyor'));
      },
      recordResult: () => Promise.resolve(),
    } as unknown as IndexerService;

    const handler = reconcileHandler(indexer);
    await expect(
      handler({
        job: { id: 'j1', organizationId: 'org', kind: RECONCILE_KIND, payload: { shareId: 's1' } },
        report: () => Promise.resolve(true),
      } as never),
    ).rejects.toThrow();

    expect(calls).toEqual(['schedule', 'work']);
  });

  it('schedules the next drain before doing the work', async () => {
    const calls: string[] = [];
    const indexer = {
      scheduleDrain: () => {
        calls.push('schedule');
        return Promise.resolve();
      },
      hurryUpDrain: () => Promise.resolve(),
      queued: () => {
        calls.push('work');
        return Promise.reject(new Error('veritabanı yanıt vermiyor'));
      },
    } as unknown as IndexerService;

    const handler = indexDrainHandler(indexer);
    await expect(
      handler({
        job: { id: 'j2', organizationId: 'org', kind: INDEX_DRAIN_KIND, payload: {} },
        report: () => Promise.resolve(true),
      } as never),
    ).rejects.toThrow();

    expect(calls).toEqual(['schedule', 'work']);
  });
});

describe('the worker consumes every kind the API enqueues', () => {
  it('registers a handler for each one', () => {
    const worker = new WorkerService({ workerId: 'test' } as unknown as JobsService);
    registerHandlers(worker, {
      agent: {} as unknown as AgentService,
      acl: {} as unknown as AclApplyService,
      jobs: {} as unknown as JobsService,
      identity: {} as unknown as IdentitySyncService,
      copies: {} as unknown as CopyService,
      retention: {} as unknown as TrashRetentionService,
      indexer: {} as unknown as IndexerService,
      notifications: {} as unknown as NotificationsService,
      backupRuns: {} as never,
      schedules: {} as unknown as BackupSchedulesService,
      remote: {} as never,
    });
    expect(worker.kinds.sort()).toEqual([
      'files.copy',
      'files.index-drain',
      'files.reconcile',
      'files.restore-snapshot',
      'files.trash.purge',
      'identity.revoke-smb',
      'identity.sync',
      // `job_history`'nin saklama suresi. `JobsService` acilista her kiraci icin bir satir
      // tohumluyor; isleyicisi kayitli olmasaydi o satir sonsuza kadar `queued` durur ve budama
      // hic kosmazdi -- kuyrukta "yapilacak" gorunen, hicbir zaman yapilmayan bir is.
      'jobs.prune',
      'permissions.apply',
      // Aga katilan cihazlarin kendiliginden yetkilendirilmesi. Yirmi saniyede bir zincirleniyor;
      // bir okumanin yan etkisi olarak yetki vermek, uye listesini acan herkesin agin uyeligini
      // degistirmesi demek olurdu.
      'remote.authorize',
      'storage.backup-tick',
      // Yedek diski turu ve elle baslatilan tur. IKI AYRI TUR, ve ayri olmalari zorunlu:
      // zincirin tekilligini koruyan kismi indeks — ayni anda yalniz bir zamanlanmis tur
      // kuyrukta olabilir — tek tur olsaydi kullanicinin "Simdi yedek al" dugmesini de
      // engellerdi, ve dugme hicbir zaman is kuyruga koyamazdi.
      'storage.backup.purge',
      'storage.backup.run',
      'storage.backup.run.now',
      // Gunluk dogrulama. Tur kac dosya kopyaladigini SAYIYOR ama diskteki baytlara bakmiyor;
      // bu is gercekten bir dosya okuyup asliyla karsilastiriyor. Ayri bir tur olmasinin sebebi
      // ritmi: yedek alti saatte bir, dogrulama gunde bir -- daha siki olmasi ayni dosyayi ayni
      // sonucla tekrar okumak olurdu.
      'storage.backup.verify',
      'storage.pool.create',
      'storage.replicate',
      'storage.replicate-offsite',
      'storage.snapshot',
      'tasks.overdue-sweep',
    ]);
  });
});

/**
 * API'nin kuyruğa koyduğu her tür, KAYNAKTAN çıkarılmış hâliyle.
 *
 * ── NEDEN KAYNAK TARANIYOR ──────────────────────────────────────────────────────────────────
 *
 * Ölçülmek istenen şey iki dosya arasındaki bir SÖZLEŞME: bir uç `jobs.enqueue(..., 'x.y', ...)`
 * yazdığı anda, `registry.ts`te o türü alan bir işleyici olmak zorunda. Tip sistemi bunu
 * söyleyemiyor — tür bir dize, ve `job_queue`ya yazılan satır hiçbir zaman "işleyicisi yok" diye
 * hata vermiyor. Kaydı unutulan tür kuyrukta `queued` duruyor, `claim_job` onu hiç istemiyor, ve
 * ekranda sonsuza kadar "sırada" yazıyor. `permissions.apply` bu yüzden haftalarca beklemişti.
 *
 * ── ÜRETİCİLER İKİ BİÇİMDE YAZILIYOR ────────────────────────────────────────────────────────
 *
 * Birincisi `jobs.enqueue(org, KIND, ...)`. İkincisi ham SQL: `INSERT INTO public.job_queue`, ve
 * orada tür ya doğrudan gövdede (`VALUES ($1, 'storage.backup.run', ...)`) ya da bir parametre
 * olarak (`VALUES ($1, $2, ...)` + `[organizationId, TRASH_PURGE_KIND, ...]`) geçiyor. Bu yüzden
 * önce API kaynağındaki `*_KIND = '...'` sabitlerinden bir sözlük çıkarılıyor, sonra her üretici
 * gövdesinde hem dize hem sabit adı aranıyor.
 *
 * ── KONTROLLER ──────────────────────────────────────────────────────────────────────────────
 *
 * Kaynak okunamazsa ya da bir kalıp değişirse bu test hiçbir şey ölçmeden yeşil geçerdi. Onun
 * için: taranan `INSERT` gövdesi sayısı ham sayıya eşit olmalı, sözlük ve üretici sayısı bir
 * tabanın üstünde olmalı, ve çözülemeyen bir `*_KIND` adı testi düşürmeli.
 *
 * ── TERS YÖN KAPI DEĞİL ─────────────────────────────────────────────────────────────────────
 *
 * İşleyicisi olup üreticisi olmayan bir tür hata değil: `storage.snapshot` bilerek öyle duruyor —
 * o satırı düşürecek bir yol eklendiği gün onu alacak bir işleyici hazır olsun diye.
 */

const API_SRC = resolve(__dirname, '../../../api/src');

const KIND_DEFINITION = /\b([A-Z][A-Z0-9_]*_KIND)\s*=\s*'([^']+)'/g;
/** Bir iş türüne benzeyen dize: küçük harf, en az bir nokta. `'{}'::jsonb` buna uymuyor. */
const KIND_LITERAL = /'([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+)'/g;
const KIND_IDENTIFIER = /\b([A-Z][A-Z0-9_]*_KIND)\b/g;
/**
 * `jobs.enqueue(org, KIND, ...)`, ve YALNIZ o.
 *
 * `identity.enqueue(org, 'bir parola değişimi')` da bir `enqueue` çağrısı ama ikinci argümanı bir
 * gerekçe cümlesi; tür sanılsaydı bu kapı her cümle için bir işleyici arardı.
 */
const ENQUEUE_NAMED = /\bjobs\.enqueue\(\s*[^,()]+,\s*([A-Z][A-Z0-9_]*_KIND)\s*,/g;
const ENQUEUE_LITERAL = /\bjobs\.enqueue\(\s*[^,()]+,\s*'([a-z][a-z0-9.-]+)'\s*,/g;
const INSERT = 'INSERT INTO public.job_queue';

/**
 * Bir çağrının açılış parantezinden EŞLEŞEN kapanışına kadarki gövdesi.
 *
 * Parantez sayarak, bir bitiş kalıbına güvenerek değil: sorgu gövdesinin kendi parantezleri var
 * (`(organization_id, kind, ...)`, `VALUES (...)`), ve metinsel bir sınır gövdeyi ortasından
 * keserdi — tür bir parametre olarak geçtiğinde aranan dizi tam da o kesilen kısımda duruyor.
 */
export function callBodies(text: string, token: string): string[] {
  const bodies: string[] = [];
  for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1)) {
    const start = at + token.length;
    let depth = 0;
    for (let i = start - 1; i < text.length; i += 1) {
      const char = text[i];
      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          bodies.push(text.slice(start, i));
          break;
        }
      }
    }
  }
  return bodies;
}

/** Bir gövdenin kuyruğa koyduğu türler: hem yazılı dizeler hem çözülmüş sabit adları. */
export function kindsInBody(body: string, symbols: Map<string, string>): string[] {
  const kinds = [...body.matchAll(KIND_LITERAL)].map((match) => match[1] as string);
  for (const match of body.matchAll(KIND_IDENTIFIER)) {
    const resolved = symbols.get(match[1] as string);
    // Çözülemeyen bir ad, sözlüğün kalıbının değiştiği anlamına geliyor: sessizce atlamak testin
    // ölçtüğü şeyi kaybettirirdi.
    if (resolved === undefined) throw new Error(`bilinmeyen iş türü sabiti: ${match[1] as string}`);
    kinds.push(resolved);
  }
  return kinds;
}

describe('the gate itself', () => {
  it('reads a kind passed as a query parameter, not only one written into the SQL', () => {
    const body = `
        \`${INSERT} (organization_id, kind, payload, run_after, max_attempts)
         VALUES ($1, $2, '{}'::jsonb, $3, 3)
         ON CONFLICT DO NOTHING\`,
        [organizationId, TRASH_PURGE_KIND, runAfter],`;
    const symbols = new Map([['TRASH_PURGE_KIND', 'files.trash.purge']]);
    expect(kindsInBody(body, symbols)).toContain('files.trash.purge');
  });

  it('reads a kind written into the SQL, and ignores the jsonb literal beside it', () => {
    const body = `\`VALUES ($1, 'storage.backup.run', '{}'::jsonb, $2, 3)\``;
    expect(kindsInBody(body, new Map())).toEqual(['storage.backup.run']);
  });

  it('reads a call body to its matching close, past the parentheses inside the SQL', () => {
    const source = `await this.db.withTenant(organizationId, (q) =>
      q.query(
        \`${INSERT} (organization_id, kind)
         VALUES ($1, $2)\`,
        [organizationId, BACKUP_TICK_KIND],
      ),
    );`;
    const [body] = callBodies(source, '.query(').filter((one) => one.includes(INSERT));
    expect(body).toBeDefined();
    expect(body as string).toContain('BACKUP_TICK_KIND');
  });
});

describe('every kind the API enqueues has a handler', () => {
  it('finds a registered handler for each one', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(dir, entry.name))
          : entry.name.endsWith('.ts') && !entry.name.includes('.test.')
            ? [join(dir, entry.name)]
            : [],
      );
    const sources = walk(API_SRC).map((file) => readFileSync(file, 'utf8'));
    // Kontrol: kaynak okunamadıysa bu test hiçbir şey ölçmez ve sessizce geçer.
    expect(sources.length).toBeGreaterThan(50);

    const symbols = new Map<string, string>();
    for (const text of sources) {
      for (const match of text.matchAll(KIND_DEFINITION)) {
        symbols.set(match[1] as string, match[2] as string);
      }
    }
    expect(symbols.size).toBeGreaterThan(10);

    const produced = new Set<string>();
    let raw = 0;
    let scanned = 0;
    for (const text of sources) {
      raw += text.split(INSERT).length - 1;
      for (const body of callBodies(text, '.query(')) {
        if (!body.includes(INSERT)) continue;
        scanned += 1;
        for (const kind of kindsInBody(body, symbols)) produced.add(kind);
      }
      for (const match of text.matchAll(ENQUEUE_NAMED)) {
        const named = match[1] as string;
        const resolved = symbols.get(named);
        if (resolved === undefined) throw new Error(`bilinmeyen iş türü sabiti: ${named}`);
        produced.add(resolved);
      }
      for (const match of text.matchAll(ENQUEUE_LITERAL)) produced.add(match[1] as string);
    }
    // Kontrol: bir `INSERT` gövdesi okunamadıysa boş bir eksik listesi hiçbir şey kanıtlamaz.
    expect(
      scanned,
      'bir job_queue INSERT gövdesi taranamadı; ya kalıp değişti ya bir yorum bu metni içeriyor',
    ).toBe(raw);
    expect(raw).toBeGreaterThan(5);
    expect(produced.size).toBeGreaterThan(12);
    // Kapının var olma sebebi olan tür: çıkarım onu göremiyorsa kapı da hiçbir şey görmüyor.
    expect(produced.has('permissions.apply'), 'permissions.apply hiç bulunamadı').toBe(true);

    const worker = new WorkerService({ workerId: 'test' } as unknown as JobsService);
    registerHandlers(worker, {
      agent: {} as never,
      acl: {} as never,
      jobs: {} as never,
      identity: {} as never,
      copies: {} as never,
      retention: {} as never,
      indexer: {} as never,
      notifications: {} as never,
      backupRuns: {} as never,
      schedules: {} as never,
      remote: {} as never,
    });
    const registered = new Set(worker.kinds);

    const unclaimable = [...produced].filter((kind) => !registered.has(kind)).sort();
    expect(
      unclaimable,
      `API bu türleri kuyruğa koyuyor ama hiçbir işleyici almıyor: ${unclaimable.join(', ')}`,
    ).toEqual([]);
  });
});
