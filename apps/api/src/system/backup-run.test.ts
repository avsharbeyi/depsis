import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentRequest, AgentResponse, AgentService } from '../agent/agent.service.js';
import type { DbService } from '../db/db.service.js';
import { BackupRunService } from './backup-run.service.js';
import type { BackupTargetRow, BackupTargetService } from './backup-target.service.js';

/**
 * Turun İKİ SESSİZ ARIZASI, ikisi de sahada ölçülmüş türden.
 *
 * BİRİNCİSİ: ajanın dizin listelemesi 5.000 girdide kesiliyor ve gerisi `after` imleciyle
 * geliyor. İmleci kullanmayan bir ilk tur, içinde 5.000'den fazla girdi olan tek bir klasörde
 * hata veriyor, taban hiç yazılmıyor, ve o paylaşımın hiçbir dosyası hiçbir zaman yedeğe
 * girmiyor — ekranda "6 saatte bir yedekleniyor" yazarken.
 *
 * İKİNCİSİ: her tur bir `depsis-yedek-*` görüntüsü alıyor ve eskisini kimse yok etmiyordu.
 * Kullanıcının sildiği her blok o görüntülerde asılı kaldığı için havuz doluyor, ve dolduğunda
 * duran şey yedek değil SMB yazmaları oluyor.
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
}

interface Harness {
  runs: BackupRunService;
  calls: AgentRequest[];
  trace: string[];
  bases: Map<string, string | null>;
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
  let endless = 0;

  const agent = {
    isAvailable: () => true,
    call: (request: AgentRequest): Promise<AgentResponse> => {
      calls.push(request);
      switch (request.op) {
        case 'backup_root_status':
          return Promise.resolve<AgentResponse>({
            status: 'backup_root',
            prepared: true,
            key_loaded: true,
            mounted: true,
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
          return Promise.resolve<AgentResponse>({ status: 'copied', offset: 4, done: true });
        case 'backup_remove_entry':
          return Promise.resolve<AgentResponse>({ status: 'removed' });
        case 'backup_create_directory':
          return Promise.resolve<AgentResponse>({ status: 'directory_created' });
        default:
          return Promise.resolve<AgentResponse>({ status: 'ok', schema_version: 42 });
      }
    },
  } as unknown as AgentService;

  const query = (text: string, params?: readonly unknown[]): Promise<unknown[]> => {
    if (text.includes('FROM public.shares')) return Promise.resolve(shares);
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

  return { runs: new BackupRunService(db, agent, targets), calls, trace, bases };
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
