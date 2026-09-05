import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentRequest, AgentResponse, AgentService } from '../agent/agent.service.js';
import type { DbService } from '../db/db.service.js';
import { BackupRunService } from './backup-run.service.js';
import type { BackupTargetRow, BackupTargetService } from './backup-target.service.js';

/**
 * Turun SESSİZ ARIZALARI, hepsi sahada ölçülmüş türden — hiçbiri ekranda görünmüyordu.
 *
 * Ajanın dizin listelemesi 5.000 girdide kesiliyor ve gerisi `after` imleciyle geliyor. İmleci
 * kullanmayan bir ilk tur, içinde 5.000'den fazla girdi olan tek bir klasörde hata veriyor, taban
 * hiç yazılmıyor, ve o paylaşımın hiçbir dosyası hiçbir zaman yedeğe girmiyor — ekranda "6 saatte
 * bir yedekleniyor" yazarken. Her tur bir `depsis-yedek-*` görüntüsü alıyor ve eskisini kimse yok
 * etmiyordu; kullanıcının sildiği her blok o görüntülerde asılı kaldığı için havuz doluyor.
 * Değişen bir dosyanın yedekteki eski sürümü, yenisi yazılmadan ÖNCE siliniyordu. Bir klasörün
 * yeniden adlandırılması hiç işlenmiyordu. Ve silinenler klasörü tek listelemeye sığmadığında
 * saklama süresi orada hiç işlemiyordu.
 *
 * Veritabanı taklit ediliyor: ölçülen şey turun KARARLARI — hangi çağrı, hangi sırayla — ve
 * bunların hiçbiri PostgreSQL'e bağlı değil.
 */

const ORG = '3f2a51c0-0000-4000-8000-00000000aaaa';
const SHARE = {
  id: 'd1c9f0aa-0000-4000-8000-00000000bbbb',
  name: 'Fotograflar',
  dataset: 'tank/paylasimlar/fotograflar',
};
/** Alfabetik olarak SONRAKİ paylaşım: bir öncekinin arızası bunu da yedeksiz bırakıyordu. */
const NEXT_SHARE = {
  id: 'e2d0a1bb-0000-4000-8000-00000000dddd',
  name: 'Videolar',
  dataset: 'tank/paylasimlar/videolar',
};
const SHARE_ROOT = '/srv/depsis/paylasimlar';

interface DirRow {
  name: string;
  directory: boolean;
}

interface Behaviour {
  /** Turun göreceği paylaşımlar, ada göre sıralı. */
  shares?: (typeof SHARE)[];
  /** Paylaşımın ağacı: anahtar yolun '/' ile birleşmiş hâli, '' kök. */
  tree?: Record<string, DirRow[]>;
  /** Ajanın tek yanıtta kaç girdi verdiği — sahadaki 5.000'in testteki karşılığı. */
  pageSize?: number;
  /** Adı verilen paylaşımın kökü, imleç nereye giderse gitsin hep "daha var" diyor. */
  endlessRoot?: string;
  /** Havuzdaki görüntüler. */
  inventory?: { name: string; used_bytes: number; created_at: number }[];
  /** `diff_snapshots` cevabı. */
  diff?: AgentResponse;
  /** Diskin durumu — verilmezse hazır, açık ve bağlı. */
  root?: { prepared: boolean; key_loaded: boolean; mounted: boolean };
  /** `copy_file_to_backup` cevabı; dolu bir diski taklit etmenin yolu. */
  copy?: AgentResponse;
  /** `backup_move_entry` cevabı, isteğe göre. Verilmezse her taşıma başarılı. */
  move?: (request: { from: string[]; to: string[] }) => AgentResponse;
  /**
   * YEDEK ağacı: anahtar yolun '/' ile birleşmiş hâli. Silme bu haritayı gerçekten değiştiriyor,
   * yani temizlik turunun ilerleyip ilerlemediği ölçülebiliyor.
   */
  backupTree?: Record<string, DirRow[]>;
  /** `backup_list_directory`nin tek yanıtta verdiği girdi sayısı — sahadaki 5.000. */
  backupPageSize?: number;
  /** Doğrulamanın okuyacağı dosya — satırdaki `last_copied_*`. Yoksa doğrulanacak bir şey yok. */
  lastCopied?: { share: string; path: string[] };
  /** `compare_backup_copy` cevabı. */
  compare?: AgentResponse;
}

interface Harness {
  runs: BackupRunService;
  calls: AgentRequest[];
  trace: string[];
  bases: Map<string, string | null>;
  /** Satıra yazılan doğrulama sonuçları: `null` = ölçüm YAPILMADI, `false` = yedek bozuk. */
  verifications: { ok: boolean | null; note: string }[];
  /** `backup_runs`a gerçekten yazılan satırlar, yazıldıkları sırayla. */
  recorded: { state: string; error: string | null }[];
}

function harness(behaviour: Behaviour = {}, base: string | null = null): Harness {
  const calls: AgentRequest[] = [];
  const trace: string[] = [];
  const shares = behaviour.shares ?? [SHARE];
  const bases = new Map<string, string | null>(
    shares.map((share): [string, string | null] => [share.id, base]),
  );
  const pageSize = behaviour.pageSize ?? 3;
  const tree = behaviour.tree ?? {};
  const backupTree = behaviour.backupTree ?? {};
  const backupPageSize = behaviour.backupPageSize ?? 3;
  let endless = 0;

  const agent = {
    isAvailable: () => true,
    call: (request: AgentRequest): Promise<AgentResponse> => {
      calls.push(request);
      switch (request.op) {
        case 'backup_root_status':
          return Promise.resolve<AgentResponse>({
            status: 'backup_root',
            prepared: behaviour.root?.prepared ?? true,
            key_loaded: behaviour.root?.key_loaded ?? true,
            mounted: behaviour.root?.mounted ?? true,
            available_bytes: 1_000_000_000,
            used_bytes: 0,
          });
        case 'share_root_status':
          return Promise.resolve<AgentResponse>({
            status: 'share_root',
            empty: false,
            path: SHARE_ROOT,
          });
        case 'create_snapshot':
          trace.push(`snapshot ${request.name}`);
          return Promise.resolve<AgentResponse>({
            status: 'snapshot',
            full_name: `${request.dataset}@${request.name}`,
          });
        case 'list_snapshots':
          return Promise.resolve<AgentResponse>({
            status: 'snapshots',
            missing: false,
            snapshots: behaviour.inventory ?? [],
          });
        case 'destroy_snapshot':
          trace.push(`destroy ${request.snapshot}`);
          return Promise.resolve<AgentResponse>({
            status: 'snapshot_destroyed',
            full_name: `${request.dataset}@${request.snapshot}`,
          });
        case 'diff_snapshots':
          return Promise.resolve<AgentResponse>(
            behaviour.diff ?? { status: 'diff', truncated: false, entries: [] },
          );
        case 'list_directory': {
          const key = request.path.join('/');
          if (behaviour.endlessRoot === request.share && key === '') {
            endless += 1;
            return Promise.resolve<AgentResponse>({
              status: 'listing',
              truncated: true,
              entries: [row(`bitmeyen-${String(endless).padStart(4, '0')}`, false)],
            });
          }
          const all = tree[key];
          if (all === undefined) {
            return Promise.resolve<AgentResponse>({ status: 'not_found', reason: 'yok' });
          }
          // İmleç bir AD: ajan girdileri ada göre veriyor ve `after`dan büyük olanları döndürüyor.
          const after = request.after ?? null;
          const rest = after === null ? all : all.filter((entry) => entry.name > after);
          const page = rest.slice(0, pageSize);
          return Promise.resolve<AgentResponse>({
            status: 'listing',
            truncated: rest.length > page.length,
            entries: page.map((entry) => row(entry.name, entry.directory)),
          });
        }
        case 'copy_file_to_backup':
          return Promise.resolve<AgentResponse>(
            behaviour.copy ?? { status: 'copied', offset: 4, done: true },
          );
        case 'backup_move_entry':
          return Promise.resolve<AgentResponse>(
            behaviour.move?.({ from: request.from, to: request.to }) ?? { status: 'moved' },
          );
        case 'backup_list_directory': {
          const key = request.path.join('/');
          const all = backupTree[key];
          if (all === undefined) {
            return Promise.resolve<AgentResponse>({ status: 'not_found', reason: 'yok' });
          }
          const page = all.slice(0, backupPageSize);
          return Promise.resolve<AgentResponse>({
            status: 'listing',
            truncated: all.length > page.length,
            entries: page.map((entry) => row(entry.name, entry.directory)),
          });
        }
        case 'backup_remove_entry': {
          const key = request.path.join('/');
          const parent = request.path.slice(0, -1).join('/');
          const name = request.path[request.path.length - 1];
          if (request.directory && (backupTree[key]?.length ?? 0) > 0) {
            // DOLU BİR DİZİN silinemiyor: ajanın kendi cevabı da bu.
            return Promise.resolve<AgentResponse>({ status: 'conflict', reason: 'dolu dizin' });
          }
          if (request.directory) delete backupTree[key];
          const siblings = backupTree[parent];
          if (siblings !== undefined) {
            backupTree[parent] = siblings.filter((entry) => entry.name !== name);
          }
          return Promise.resolve<AgentResponse>({ status: 'removed' });
        }
        case 'backup_create_directory':
          return Promise.resolve<AgentResponse>({ status: 'directory_created' });
        case 'compare_backup_copy':
          return Promise.resolve<AgentResponse>(
            behaviour.compare ?? {
              status: 'comparison',
              identical: true,
              partial: false,
              compared_bytes: 4,
              live_bytes: 4,
              backup_bytes: 4,
            },
          );
        default:
          return Promise.resolve<AgentResponse>({ status: 'ok', schema_version: 42 });
      }
    },
  } as unknown as AgentService;

  const verifications: { ok: boolean | null; note: string }[] = [];

  const recorded: { state: string; error: string | null }[] = [];

  const query = (text: string, params?: readonly unknown[]): Promise<unknown[]> => {
    if (text.includes('FROM public.shares')) return Promise.resolve(shares);
    if (text.includes('INSERT INTO public.backup_runs')) {
      recorded.push({ state: String(params?.[3]), error: (params?.[7] ?? null) as string | null });
      return Promise.resolve([]);
    }
    // `lastRunSaidTheSame` bunu okuyor: tabloya yazılanın aynısı, en yenisi başta.
    if (text.includes('FROM public.backup_runs')) {
      const last = recorded[recorded.length - 1];
      return Promise.resolve(last === undefined ? [] : [last]);
    }
    if (text.includes('last_copied_share AS share')) {
      return Promise.resolve(
        behaviour.lastCopied === undefined
          ? []
          : [{ share: behaviour.lastCopied.share, path: behaviour.lastCopied.path }],
      );
    }
    if (text.includes('SET last_verified_at')) {
      verifications.push({
        ok: (params?.[1] ?? null) as boolean | null,
        note: String(params?.[2]),
      });
      return Promise.resolve([]);
    }
    if (text.includes('WHERE base_snapshot IS NOT NULL')) {
      const named = [...bases.values()].filter((name): name is string => name !== null);
      return Promise.resolve(named.map((base_snapshot) => ({ base_snapshot })));
    }
    if (text.includes('FROM public.backup_bases WHERE share_id')) {
      return Promise.resolve([{ base_snapshot: bases.get(String(params?.[0])) ?? null }]);
    }
    if (text.includes('INSERT INTO public.backup_bases')) {
      const written = (params?.[2] ?? null) as string | null;
      bases.set(String(params?.[1]), written);
      trace.push(`taban ${written ?? 'yok'}`);
    }
    return Promise.resolve([]);
  };
  const db = {
    withTenant: <T>(_organizationId: string, fn: (q: { query: typeof query }) => Promise<T>) =>
      fn({ query }),
  } as unknown as DbService;

  const target: BackupTargetRow = {
    id: '9c0b1d22-0000-4000-8000-00000000cccc',
    pool: 'yedek',
    label: 'Yedek diski',
    cadenceHours: 6,
    retainDays: 30,
    recoveryOnly: false,
    deviceId: null,
    enabled: true,
    lastVerifiedAt: null,
    lastVerifyOk: null,
    lastVerifyNote: null,
    lastScrubAt: null,
  };
  const targets = {
    row: () => Promise.resolve(target),
    writeDiskDescription: () => Promise.resolve(),
  } as unknown as BackupTargetService;

  return {
    runs: new BackupRunService(db, agent, targets),
    calls,
    trace,
    bases,
    verifications,
    recorded,
  };
}

function row(name: string, directory: boolean): DirRow & { size: number; modified_unix: number } {
  return { name, directory, size: 4, modified_unix: 1_787_000_000 };
}

function listings(calls: AgentRequest[], path: string[]): AgentRequest[] {
  return calls.filter(
    (call) => call.op === 'list_directory' && call.path.join('/') === path.join('/'),
  );
}

function copied(calls: AgentRequest[]): string[] {
  return calls
    .filter((call) => call.op === 'copy_file_to_backup')
    .map((call) => call.from.join('/'));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ilk yedek turu, tek listelemeye sığmayan bir dizinde', () => {
  it('imleçle sayfalayıp klasörün TAMAMINI kopyalar', async () => {
    // ASIL ÖLÇÜM. Yedi girdilik bir kök, üçerlik sayfalarla: imleci kullanmayan bir tur burada
    // hata verip tabanı hiç yazmıyordu, yani paylaşım hiçbir zaman yedeklenmiyordu.
    const { runs, calls, bases } = harness({
      pageSize: 3,
      tree: {
        '': [
          { name: 'a01', directory: false },
          { name: 'a02', directory: false },
          { name: 'a03', directory: false },
          { name: 'a04', directory: false },
          { name: 'a05', directory: false },
          { name: 'a06', directory: false },
          { name: 'klasor', directory: true },
        ],
        klasor: [
          { name: 'ic01', directory: false },
          { name: 'ic02', directory: false },
        ],
      },
    });

    const outcome = await runs.runOnce(ORG, 'zamanli');

    expect(outcome.state).toBe('bitti');
    expect(copied(calls)).toEqual([
      'a01',
      'a02',
      'a03',
      'a04',
      'a05',
      'a06',
      'klasor/ic01',
      'klasor/ic02',
    ]);
    // Taban yazıldı: bir sonraki tur artık yalnız değişenleri isteyecek.
    expect(bases.get(SHARE.id)).toMatch(/^depsis-yedek-/u);
  });

  it('her sayfayı bir öncekinin SON ADIYLA istiyor', async () => {
    // İmleç bir ad, ofset değil. Ofset olsaydı sayfalar arasında eklenen bir dosya sırayı
    // kaydırır ve aradaki her ad ya iki kez ya hiç kopyalanırdı.
    const { runs, calls } = harness({
      pageSize: 3,
      tree: {
        '': [
          { name: 'a01', directory: false },
          { name: 'a02', directory: false },
          { name: 'a03', directory: false },
          { name: 'a04', directory: false },
          { name: 'a05', directory: false },
          { name: 'a06', directory: false },
          { name: 'a07', directory: false },
        ],
      },
    });

    await runs.runOnce(ORG, 'zamanli');

    const root = listings(calls, []);
    expect(root).toHaveLength(3);
    const cursors = root.map((call) =>
      call.op === 'list_directory' ? (call.after ?? null) : null,
    );
    expect(cursors).toEqual([null, 'a03', 'a06']);
  });

  it('sayfa TAVANI aşılırsa hâlâ düşüyor ve tabanı yazmıyor', async () => {
    // Tavana çarpıldığında susmak, eksik bir ilk turun ardından tabanı yazmak olurdu: bir daha
    // hiç sorulmayacak dosyalar. Yedeğin en tehlikeli hâli, olduğu sanılan ve olmayan yedektir.
    const { runs, calls, bases } = harness({ endlessRoot: SHARE.name });

    const outcome = await runs.runOnce(ORG, 'zamanli');

    expect(outcome.state).toBe('dustu');
    expect(outcome.error).toContain('listeleme sayfasında bitmedi');
    expect(listings(calls, [])).toHaveLength(40);
    expect(bases.get(SHARE.id)).toBeNull();
  });

  it('düşen paylaşım, SIRADAKİ paylaşımın turunu iptal etmiyor', async () => {
    // Paylaşımlar ada göre geliyor: 'Fotograflar' bozukken turu bitirmek, 'Videolar'ı arıza
    // sürdükçe yedeksiz bırakıyordu — ve ekranda hâlâ "6 saatte bir yedekleniyor" yazıyordu.
    const { runs, bases } = harness({
      shares: [SHARE, NEXT_SHARE],
      endlessRoot: SHARE.name,
      tree: { '': [] },
    });

    const outcome = await runs.runOnce(ORG, 'zamanli');

    // Tur yine de DÜŞMÜŞ sayılıyor: sıradaki paylaşımın başarısı arızanın üstünü örtmüyor.
    expect(outcome.state).toBe('dustu');
    expect(bases.get(SHARE.id)).toBeNull();
    expect(bases.get(NEXT_SHARE.id)).toMatch(/^depsis-yedek-/u);
  });

  it('İKİ paylaşım da düştüğünde kayıtta İKİSİNİN de gerekçesi duruyor', async () => {
    // `total.error` her arızada üzerine yazılıyordu: üç paylaşımın bozulduğu bir günde kayıtta
    // yalnız sonuncusu kalıyor, ekranda sahibinin gördüğü tek cümle o oluyordu — ilk iki arıza
    // hiçbir yerde yoktu.
    const { runs } = harness({
      shares: [SHARE, NEXT_SHARE],
      tree: { '': [{ name: 'a01', directory: false }] },
      copy: { status: 'refused', reason: 'ajan kopyalamayı reddetti' },
    });

    const outcome = await runs.runOnce(ORG, 'zamanli');

    expect(outcome.state).toBe('dustu');
    expect(outcome.error).toContain(SHARE.name);
    expect(outcome.error).toContain(NEXT_SHARE.name);
  });
});

describe('tur görüntüleri', () => {
  it('geçmiş turların görüntülerini yok ediyor, başkasınınkine dokunmuyor', async () => {
    const { runs, calls } = harness(
      {
        tree: { '': [] },
        inventory: [
          { name: 'depsis-yedek-800', used_bytes: 1, created_at: 800 },
          { name: 'depsis-yedek-900', used_bytes: 1, created_at: 900 },
          { name: 'depsis-yedek-1000', used_bytes: 1, created_at: 1000 },
          { name: 'depsis-daily-20260101T030000Z', used_bytes: 1, created_at: 1100 },
          { name: 'yukseltmeden-once', used_bytes: 1, created_at: 1200 },
        ],
      },
      'depsis-yedek-1000',
    );

    await runs.runOnce(ORG, 'zamanli');

    const destroyed = calls
      .filter((call) => call.op === 'destroy_snapshot')
      .map((call) => call.snapshot);
    // Elle alınmış ve zamanlanmış görüntüler DURUYOR: onların ne zaman silineceğine bu tur karar
    // veremez, ve kullanıcı elle aldığı görüntüyü ancak ihtiyaç duyduğu gün arar.
    expect(destroyed).toEqual(['depsis-yedek-800', 'depsis-yedek-900']);
  });

  it('yürürlükteki tabanı ancak YERİNE YENİSİ yazıldıktan sonra siliyor', async () => {
    // Sıra burada mekanik: tabanı önce silen bir tur, bir sonraki turun karşılaştıracağı görüntüyü
    // yok eder ve o tur bütün ağacı baştan yürür.
    const { runs, trace } = harness(
      {
        tree: { '': [] },
        inventory: [{ name: 'depsis-yedek-1000', used_bytes: 1, created_at: 1000 }],
      },
      'depsis-yedek-1000',
    );
    vi.spyOn(Date, 'now').mockReturnValue(2000);

    await runs.runOnce(ORG, 'zamanli');
    // İLK TURDA HİÇBİR ŞEY SİLİNMİYOR: 'depsis-yedek-1000' bu turun karşılaştırdığı tabandı, ve
    // yerine yenisi ancak turun sonunda yazıldı.
    expect(trace).toEqual(['snapshot depsis-yedek-2000', 'taban depsis-yedek-2000']);

    trace.length = 0;
    vi.spyOn(Date, 'now').mockReturnValue(3000);
    await runs.runOnce(ORG, 'zamanli');

    expect(trace).toEqual([
      'snapshot depsis-yedek-3000',
      'destroy depsis-yedek-1000',
      'taban depsis-yedek-3000',
    ]);
  });

  it('taban ilerlemeyen turda, o turda alınan görüntüyü siliyor', async () => {
    // Kesilmiş bir değişiklik listesi tabanı düşürüyor; bu turun görüntüsüne artık kimse
    // bakmayacak, ama havuzda tuttuğu bloklar duruyor.
    const { runs, trace } = harness(
      { tree: { '': [] }, diff: { status: 'diff', truncated: true, entries: [] } },
      'depsis-yedek-1000',
    );
    vi.spyOn(Date, 'now').mockReturnValue(4000);

    await runs.runOnce(ORG, 'zamanli');

    expect(trace).toEqual(['snapshot depsis-yedek-4000', 'taban yok', 'destroy depsis-yedek-4000']);
  });

  it('başarılı bir turun kendi görüntüsünü silmiyor', async () => {
    const { runs, calls } = harness({ tree: { '': [] } });

    await runs.runOnce(ORG, 'zamanli');

    expect(calls.filter((call) => call.op === 'destroy_snapshot')).toHaveLength(0);
  });
});

/** Yeniden adlandırma girdisi — `zfs diff`in tek satırlık `R`si. */
function renamed(kind: 'file' | 'directory', from: string, to: string): AgentResponse {
  return {
    status: 'diff',
    truncated: false,
    entries: [
      {
        change: 'renamed',
        kind,
        path: `${SHARE_ROOT}/${SHARE.name}/${to}`,
        old_path: `${SHARE_ROOT}/${SHARE.name}/${from}`,
      },
    ],
  };
}

describe('değişmiş bir dosyanın yedekteki eski sürümü', () => {
  const ONE_FILE = { tree: { '': [{ name: 'video.mp4', directory: false }] } };

  it('yeni kopya yazılmadan ÖNCE kaldırılmıyor', async () => {
    // SIRA BURADA MEKANİK. Eski sürüm ilk çağrıda siliniyordu: kırk gigabaytlık bir dosya
    // değişip disk dolduğunda o dosyanın yedekte NE eski NE yeni sürümü kalıyordu.
    const { runs, calls } = harness(ONE_FILE);

    await runs.runOnce(ORG, 'zamanli');

    const ops = calls.map((call) => call.op);
    expect(ops.lastIndexOf('copy_file_to_backup')).toBeLessThan(ops.indexOf('backup_remove_entry'));
  });

  it('kopyalama YER YOK ile düştüğünde eski sürüme hiç dokunulmuyor', async () => {
    // ASIL ÖLÇÜM: dolu bir diskte yedekteki sağlam kopya YERİNDE kalıyor.
    const { runs, calls } = harness({
      ...ONE_FILE,
      copy: { status: 'out_of_space', reason: 'yedek diskinde video.mp4 için yer yok' },
    });

    const outcome = await runs.runOnce(ORG, 'zamanli');

    expect(outcome.state).toBe('yer-yok');
    expect(calls.some((call) => call.op === 'backup_remove_entry')).toBe(false);
  });

  it('yeni sürümü geçici bir ada yazıp sonra yerine taşıyor', async () => {
    const { runs, calls } = harness(ONE_FILE);

    await runs.runOnce(ORG, 'zamanli');

    const copy = calls.find((call) => call.op === 'copy_file_to_backup');
    const move = calls.find((call) => call.op === 'backup_move_entry');
    // Kopyalama hedefi GEÇİCİ ad; son adım onu asıl adın yerine koyuyor.
    if (copy === undefined || copy.op !== 'copy_file_to_backup') {
      throw new Error('kopyalama çağrısı yok');
    }
    expect(copy.to[copy.to.length - 1]).not.toBe('video.mp4');
    expect(move).toMatchObject({ to: ['Dosyalar', SHARE.name, 'video.mp4'] });
  });
});

describe('yedek diski okunamadığında', () => {
  it('disk TAKILI DEĞİLKEN sebebi kaydediyor', async () => {
    // Havuz içe alınmamışken durum "kilitli" diye kaydediliyordu ve ekran parola soruyordu:
    // doğru parola da `dataset does not exist` ile düşüyor, ve arızanın adı hiçbir yerde
    // geçmiyordu.
    const { runs } = harness({ root: { prepared: false, key_loaded: false, mounted: false } });

    const outcome = await runs.runOnce(ORG, 'zamanli');

    expect(outcome.state).toBe('kilitli');
    expect(outcome.error).toMatch(/takılı değil/u);
  });

  it('AYNI sebebi ikinci kez yazmıyor, ama elle başlatılan tura yine cevap veriyor', async () => {
    // Sahibin kuralı: yedekleme yalnız yedek diski varsa çalışır. Fişi çekilmiş bir diskte tur
    // yine üç saatte bir koşuyor ve her turda AYNI satırı yazıyordu — sahada dört günde
    // birbirinin kopyası otuz iki satır, ve tur geçmişi ekranı yedekleme çalışıyormuş gibi
    // görünüyordu, hem de tek bir dosya kopyalanmadan.
    const { runs, recorded } = harness({
      root: { prepared: false, key_loaded: false, mounted: false },
    });

    await runs.runOnce(ORG, 'zamanli');
    await runs.runOnce(ORG, 'zamanli');
    await runs.runOnce(ORG, 'zamanli');

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.error).toMatch(/takılı değil/u);

    // Düğmeye basan biri her seferinde bir cevap hak ediyor.
    await runs.runOnce(ORG, 'elle');
    expect(recorded).toHaveLength(2);
  });

  it('sebep DEĞİŞTİĞİNDE yeniden yazıyor', async () => {
    // Sessizlik "artık hiç yazma" demek değil: disk takılıp kilitli kaldığında cümle değişiyor
    // ve sahibinin onu görmesi gerekiyor.
    const behaviour = { root: { prepared: false, key_loaded: false, mounted: false } };
    const { runs, recorded } = harness(behaviour);

    await runs.runOnce(ORG, 'zamanli');
    behaviour.root.prepared = true;
    await runs.runOnce(ORG, 'zamanli');

    expect(recorded).toHaveLength(2);
    expect(recorded[1]?.error).toMatch(/parola/u);
  });

  it('disk gerçekten kilitliyken parolayı istiyor', async () => {
    const { runs } = harness({ root: { prepared: true, key_loaded: false, mounted: false } });

    const outcome = await runs.runOnce(ORG, 'zamanli');

    expect(outcome.state).toBe('kilitli');
    expect(outcome.error).toMatch(/parola/u);
  });
});

describe('yeniden adlandırma', () => {
  it('bir KLASÖRÜ yedekte de taşıyor, içindekileri yeniden kopyalamadan', async () => {
    // `zfs diff` kırk bin fotoğraflık bir klasörün yeniden adlandırılmasını TEK satır olarak
    // veriyor. Bu satır yok sayıldığında yedekte klasör eski adıyla kalıyor, yeni ad hiç
    // oluşmuyor, ve eski kopya silinme defterine hiç girmediği için saklama süresi ona hiç
    // bakmıyordu.
    const { runs, calls, bases } = harness(
      { diff: renamed('directory', '2024', '2024-eski') },
      'depsis-yedek-1000',
    );

    const outcome = await runs.runOnce(ORG, 'zamanli');

    expect(outcome.state).toBe('bitti');
    expect(outcome.movedFiles).toBe(1);
    expect(calls.find((call) => call.op === 'backup_move_entry')).toMatchObject({
      from: ['Dosyalar', SHARE.name, '2024'],
      to: ['Dosyalar', SHARE.name, '2024-eski'],
    });
    expect(calls.some((call) => call.op === 'copy_file_to_backup')).toBe(false);
    expect(bases.get(SHARE.id)).toMatch(/^depsis-yedek-/u);
  });

  it('yedekte bulunamayan bir DOSYAYI yeni adıyla kopyalıyor', async () => {
    const { runs, calls } = harness(
      {
        diff: renamed('file', 'eski.txt', 'yeni.txt'),
        move: (request) =>
          request.from.includes('eski.txt')
            ? { status: 'not_found', reason: 'yedekte yok' }
            : { status: 'moved' },
      },
      'depsis-yedek-1000',
    );

    const outcome = await runs.runOnce(ORG, 'zamanli');

    expect(outcome.state).toBe('bitti');
    expect(copied(calls)).toEqual(['yeni.txt']);
  });

  it('taşıma ÇAKIŞTIĞINDA hedefi silmiyor, tabanı düşürüyor', async () => {
    // `zfs diff` satırlarının sırası garanti değil: hedefte duran şey bu turda yeni ada yazılmış
    // gerçek bir dosya olabilir, ve onu silip üstüne taşımak kullanıcının yedeğini yok ederdi.
    const { runs, calls, bases } = harness(
      {
        diff: renamed('directory', '2024', '2024-eski'),
        move: () => ({ status: 'conflict', reason: 'hedefte zaten bir düğüm var' }),
      },
      'depsis-yedek-1000',
    );

    const outcome = await runs.runOnce(ORG, 'zamanli');

    expect(calls.some((call) => call.op === 'backup_remove_entry')).toBe(false);
    // Taban düşürüldü: bir sonraki tur ağacın tamamını yürüyecek.
    expect(bases.get(SHARE.id)).toBeNull();
    expect(outcome.state).toBe('devam');
  });
});

describe('silinenler klasörünün temizliği', () => {
  it('tek listelemeye SIĞMAYAN bir gün klasörünü de boşaltıyor', async () => {
    // `backup_list_directory` tek yanıtta 5.000 girdi veriyor ve bir `after` imleci taşımıyor.
    // Kesilmiş listelemede hiç dokunmamak, 8.000 fotoğrafın silindiği bir gün klasörünün ASLA
    // temizlenmemesi demekti: her saat aynı uyarı, ve o bloklar diskte sonsuza kadar.
    const backupTree: Record<string, DirRow[]> = {
      'DEPSIS-YEDEK/silinenler': [{ name: '2000-01-01', directory: true }],
      'DEPSIS-YEDEK/silinenler/2000-01-01': Array.from({ length: 8 }, (_, n) => ({
        name: `foto-${n}.jpg`,
        directory: false,
      })),
    };
    const { runs } = harness({ backupTree, backupPageSize: 3 });

    const purged = await runs.purgeExpired(ORG);

    expect(purged).toBe(8);
    // Gün klasörünün kendisi de gitti: dolu kaldığı sürece üst dizin de silinemiyordu.
    expect(backupTree['DEPSIS-YEDEK/silinenler']).toEqual([]);
  });

  it('saklama süresi dolmamış bir güne dokunmuyor', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const backupTree: Record<string, DirRow[]> = {
      'DEPSIS-YEDEK/silinenler': [{ name: today, directory: true }],
      [`DEPSIS-YEDEK/silinenler/${today}`]: [{ name: 'dun.txt', directory: false }],
    };
    const { runs } = harness({ backupTree });

    expect(await runs.purgeExpired(ORG)).toBe(0);
    expect(backupTree[`DEPSIS-YEDEK/silinenler/${today}`]).toHaveLength(1);
  });
});

/**
 * GÜNLÜK DOĞRULAMANIN YANLIŞ ALARMI.
 *
 * `compare_backup_copy` yedeği CANLI dosyayla karşılaştırıyor, anlık görüntüyle değil. Tur 06:00'da
 * kopyalıyor, doğrulama 14:00'te bakıyor: o gün üzerinde çalışılan bir tablo dosyası her seferinde
 * "yedekte aslından FARKLI" çıkıyor ve ekran "Yedek doğrulanamadı, diski kontrol edin" diyen
 * kırmızı bir kart açıyordu. Arızası olmayan bir cihazda her gün bir arıza kartı — ve gerçek
 * bozulmayı bu gürültünün içinden ayırmanın yolu yok.
 */
describe('yedeğin doğrulanması', () => {
  const LAST = { share: 'Fotograflar', path: ['Muhasebe', 'defter.xlsx'] };

  it('BOYUTU tutmayan bir farkı "bozuk" saymıyor', async () => {
    const { runs, verifications } = harness({
      lastCopied: LAST,
      compare: {
        status: 'comparison',
        identical: false,
        partial: false,
        compared_bytes: 1_100_000,
        live_bytes: 1_200_000,
        backup_bytes: 1_100_000,
      },
    });

    const result = await runs.verifyOnce(ORG);

    // `null` — YAPILMAMIŞ bir ölçüm. `false` yazmak arıza kartı açardı, `true` yazmak yapılmamış
    // bir ölçümü başarılı göstererek doğrulamanın tamamını süse çevirirdi.
    expect(verifications).toEqual([
      { ok: null, note: expect.stringContaining('ölçüm yapılamadı') },
    ]);
    expect(result.note).not.toContain('FARKLI');
  });

  it('boyut AYNIYKEN içerik farklıysa hâlâ arıza diyor', async () => {
    // Sessiz çürüme tam bu şekilde görünüyor: dosya aynı uzunlukta, içeriği değil.
    const { runs, verifications } = harness({
      lastCopied: LAST,
      compare: {
        status: 'comparison',
        identical: false,
        partial: false,
        compared_bytes: 1_200_000,
        live_bytes: 1_200_000,
        backup_bytes: 1_200_000,
      },
    });

    const result = await runs.verifyOnce(ORG);

    expect(verifications).toEqual([{ ok: false, note: expect.stringContaining('FARKLI') }]);
    expect(result.ok).toBe(false);
  });

  it('yedekteki kopya BOŞSA ölçülemedi demiyor', async () => {
    // Dolu bir dosyanın yedekte sıfır bayt olması, canlı tarafta yapılan bir düzenlemenin
    // üretebileceği bir şey değil: kopyalama yolunun kendisi bozuk.
    const { runs, verifications } = harness({
      lastCopied: LAST,
      compare: {
        status: 'comparison',
        identical: false,
        partial: false,
        compared_bytes: 0,
        live_bytes: 1_200_000,
        backup_bytes: 0,
      },
    });

    await runs.verifyOnce(ORG);

    expect(verifications[0]?.ok).toBe(false);
  });

  it('aynı olduğunda başarılı yazıyor', async () => {
    const { runs, verifications } = harness({ lastCopied: LAST });

    const result = await runs.verifyOnce(ORG);

    expect(result.ok).toBe(true);
    expect(verifications[0]?.ok).toBe(true);
  });
});
