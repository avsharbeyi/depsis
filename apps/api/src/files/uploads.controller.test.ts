import type { Response } from 'express';
import { describe, expect, it } from 'vitest';

import type { AgentDataService } from '../agent/agent-data.service.js';
import type { AgentService } from '../agent/agent.service.js';
import type { AuthenticatedRequest } from '../auth/session.guard.js';
import { ProblemException } from '../common/problem.filter.js';
import type { DbService } from '../db/db.service.js';
import type { PosixIdentityService } from '../identity/posix.service.js';
import type { CopyService } from './copy.service.js';
import { NameTakenOnDiskError, StagedBytesGoneError, type FilesService } from './files.service.js';
import { UploadsController } from './uploads.controller.js';

/**
 * "Değiştir"in geri alma yarısı.
 *
 * Burada ölçülen tek şey SIRA ve TELAFİ: eski dosya, yayımlama denenmeden önce boş bir ada
 * taşınıp çöpe atılıyor — adı gerçekten serbest bırakan tek adım bu — ve yayımlama düşerse
 * kullanıcının klasöründe hiçbir şey kalmıyordu. Eski dosya çöp kutusundaydı, üstelik
 * `rapor (2).pdf` gibi hiç koymadığı bir adla; yeni dosya ise hiç oluşmamıştı.
 *
 * Veritabanı yok: ölçülen şey iki mağazanın hâli değil, bu denetleyicinin çağırdığı adımların
 * sırası. Gerçek PostgreSQL'e ihtiyaç duyan her şey `files.integration.test.ts`te.
 */

const SESSION = {
  id: '00000000-0000-4000-8000-00000000ab01',
  share_id: '00000000-0000-4000-8000-00000000ab02',
  parent_id: null,
  filename: 'rapor.pdf',
  staging_name: 'aaaaaaaa-0000-4000-8000-000000000001.part',
  length_bytes: '10',
  offset_bytes: '10',
  file_id: null,
};

const SHARE = { id: SESSION.share_id, name: 'depo', dataset: 'tank/depsis/depo', read_only: false };

const EXISTING = '00000000-0000-4000-8000-00000000ab03';

function request(): AuthenticatedRequest {
  return {
    depsis: {
      sessionId: '00000000-0000-4000-8000-00000000ab04',
      organizationId: '00000000-0000-4000-8000-00000000ab05',
      userId: '00000000-0000-4000-8000-00000000ab06',
      role: 'member',
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  } as unknown as AuthenticatedRequest;
}

/** Every step the resolve path takes, in the order it took them. */
type Step =
  | { op: 'rename'; id: string; name: string }
  | { op: 'trash'; id: string }
  | { op: 'restore'; id: string }
  | { op: 'publish' }
  | { op: 'record' };

function controller(
  publishFails: boolean,
  /** Yayımın hangi hatayla düştüğü. Verilmezse "ad dolu" — bu dosyanın çoğu testinin durumu. */
  failWith?: Error,
): {
  route: UploadsController;
  steps: Step[];
  /** Çalıştırılan SQL: bir satırın SİLİNDİĞİNİ ölçmenin buradaki tek yolu. */
  sql: string[];
} {
  const steps: Step[] = [];
  const sql: string[] = [];

  const db = {
    withTenant: <T>(_organizationId: string, run: (q: unknown) => Promise<T>): Promise<T> =>
      run({
        query: (statement: string): Promise<unknown[]> => {
          sql.push(statement);
          return Promise.resolve(
            statement.includes('FROM public.upload_sessions') ? [SESSION] : [],
          );
        },
      }),
  } as unknown as DbService;

  const files = {
    shareFor: () => Promise.resolve(SHARE),
    effectiveAt: () => Promise.resolve(new Set(['create', 'list', 'read'])),
    componentsOf: () => Promise.resolve([]),
    rename: (_org: string, id: string, name: string) => {
      steps.push({ op: 'rename', id, name });
      return Promise.resolve({ id, name });
    },
    trash: (_org: string, id: string) => {
      steps.push({ op: 'trash', id });
      return Promise.resolve({ id });
    },
    restore: (_org: string, id: string) => {
      steps.push({ op: 'restore', id });
      return Promise.resolve({ id });
    },
    publish: () => {
      steps.push({ op: 'publish' });
      // Ara dosyayı süpürücü silmiş, ya da adı ağ sürücüsünden yazılmış bir dosya tutuyor.
      if (!publishFails) return Promise.resolve(10);
      return Promise.reject(
        failWith ?? new NameTakenOnDiskError('rapor.pdf', 'the destination exists'),
      );
    },
    recordPublishedFile: () => {
      steps.push({ op: 'record' });
      return Promise.resolve({
        id: '00000000-0000-4000-8000-00000000ab07',
        share_id: SESSION.share_id,
        parent_id: null,
        kind: 'file',
        name: 'rapor.pdf',
        path: '/rapor.pdf',
        size_bytes: '10',
        content_type: null,
        trashed_at: null,
        created_at: new Date(0),
        updated_at: new Date(0),
      });
    },
  } as unknown as FilesService;

  const copies = {
    entryNamed: () => Promise.resolve({ id: EXISTING }),
    freeName: () => Promise.resolve('rapor (2).pdf'),
  } as unknown as CopyService;

  const posix = { posixUidFor: () => Promise.resolve(20000) } as unknown as PosixIdentityService;
  const agent = { isAvailable: () => true } as unknown as AgentService;
  const data = { isAvailable: () => true } as unknown as AgentDataService;

  return { route: new UploadsController(db, files, agent, data, posix, copies), steps, sql };
}

/** Yükleme oturumu, HENÜZ TEK BAYT ALMAMIŞ hâlde: parça yolunu sürmek için gereken şekil. */
const FRESH = { ...SESSION, offset_bytes: '0' };

/** tus `Upload-Metadata`: adı ve paylaşımı taşıyor — köke yüklemede paylaşımı çağıran söylüyor. */
const metadata = (filename: string): string =>
  `filename ${Buffer.from(filename, 'utf8').toString('base64')},` +
  `shareId ${Buffer.from(SHARE.id, 'utf8').toString('base64')}`;

interface ChunkHarness {
  route: UploadsController;
  agentCalls: Record<string, unknown>[];
  offsets: number[];
  response: Response;
}

/**
 * Parça yolunun (`PATCH /uploads/{id}`) sürücüsü.
 *
 * Veritabanı yok: ölçülen şey bu denetleyicinin ajanla ve ofset önbelleğiyle ne yaptığı.
 * `data.send` özeti GÜNCELLEMİYOR — gerçek veri kanalı güncelliyor — yani `Upload-Checksum` ile
 * gönderilen her özet uyuşmaz sayılıyor; uyuşmazlık dalını sürmenin en ucuz yolu bu.
 */
function chunkController(
  options: { agentUp?: boolean; discarded?: boolean; available?: number | null } = {},
): ChunkHarness {
  const agentCalls: Record<string, unknown>[] = [];
  const offsets: number[] = [];

  const db = {
    withTenant: <T>(_organizationId: string, run: (q: unknown) => Promise<T>): Promise<T> =>
      run({
        query: (sql: string, values: unknown[]): Promise<unknown[]> => {
          if (sql.includes('SET offset_bytes')) offsets.push(Number(values[2]));
          if (sql.includes('INSERT INTO public.upload_sessions')) {
            return Promise.resolve([{ id: FRESH.id }]);
          }
          return Promise.resolve(sql.includes('FROM public.upload_sessions') ? [FRESH] : []);
        },
      }),
  } as unknown as DbService;

  const files = {
    shareFor: () => Promise.resolve(SHARE),
    find: () => Promise.resolve({ share_id: SHARE.id, kind: 'folder', trashed_at: null }),
    effectiveAt: () => Promise.resolve(new Set(['create', 'list', 'read'])),
    componentsOf: () => Promise.resolve([]),
  } as unknown as FilesService;

  const agent = {
    isAvailable: () => options.agentUp ?? true,
    call: (call: Record<string, unknown>) => {
      agentCalls.push(call);
      switch (call['op']) {
        case 'open_transfer':
          return Promise.resolve({ status: 'transfer', token: 'tok', offset: 0 });
        case 'discard_transfer':
          return Promise.resolve({
            status: (options.discarded ?? true) ? 'discarded' : 'refused',
            reason: 'no',
          });
        default:
          return Promise.reject(new Error(`no fixture answers '${String(call['op'])}'`));
      }
    },
  } as unknown as AgentService;

  const data = {
    isAvailable: () => true,
    send: (_token: string, _offset: number, length: number): Promise<number> =>
      Promise.resolve(length),
  } as unknown as AgentDataService;

  const posix = { posixUidFor: () => Promise.resolve(20000) } as unknown as PosixIdentityService;
  const copies = {
    availableBytes: () => Promise.resolve(options.available ?? null),
  } as unknown as CopyService;

  return {
    route: new UploadsController(db, files, agent, data, posix, copies),
    agentCalls,
    offsets,
    response: {
      setHeader: () => undefined,
      status: () => undefined,
      end: () => undefined,
    } as unknown as Response,
  };
}

describe('PATCH /uploads/{id} with a checksum that does not match', () => {
  it('throws the staged file away instead of resuming past the corrupt region', async () => {
    // ESKİDEN: yalnız kaydedilen ofset ilerletilmiyordu. Ama baytlar diske yazılıp `fsync`
    // edilmişti ve bir sonraki PATCH'te `open_transfer` dosyayı `seek(End)` ile ölçüp istemciye
    // bozuk parçanın SONRASINDAN devam etmesini söylüyordu — yükleme, ortasında bozuk bir bölgeyle,
    // hatasız "tamamlanıyordu". Tek doğru cevap ara dosyayı atmak.
    const { route, agentCalls, offsets, response } = chunkController();
    const digest = Buffer.alloc(32, 7).toString('base64');

    const error = await route
      .sendChunk(request(), response, FRESH.id, '0', '10', `sha256 ${digest}`)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProblemException);
    expect((error as ProblemException).code).toBe('checksum-mismatch');
    expect(agentCalls.map((call) => call['op'])).toContain('discard_transfer');
    // Ve önbellek SIFIRA çekiliyor: istemci baştan gönderiyor, bozuk bölgenin ötesinden değil.
    expect(offsets.at(-1)).toBe(0);
  });

  it('says the staged file still holds the corrupt region when it cannot be discarded', async () => {
    // Sessizce "checksum uyuşmadı" demek, istemciye devam etmesi için yeşil ışık olurdu.
    const { route, response } = chunkController({ discarded: false });
    const digest = Buffer.alloc(32, 7).toString('base64');

    const error = await route
      .sendChunk(request(), response, FRESH.id, '0', '10', `sha256 ${digest}`)
      .then(() => null)
      .catch((e: unknown) => e);

    expect((error as ProblemException).code).toBe('dependency-unavailable');
  });
});

describe('the agent availability latch', () => {
  it('does not refuse an upload because the agent was slow at BOOT', async () => {
    // `AgentService.available` yalnız `onModuleInit`te `true` oluyor ve bir daha
    // değerlendirilmiyor. Açılışta ajan geç yetişirse bayrak kalıcı `false` kalıyor, ajan bir
    // dakika sonra sağlıklı hâle gelse bile cihaza web'den hiçbir dosya yüklenemiyordu; tek çıkış
    // API'yi yeniden başlatmaktı. Aynı mandal `shares`, `permissions` ve `teams` servislerinden
    // aynı gerekçeyle kaldırılmıştı.
    const { route, response } = chunkController({ agentUp: false });

    await expect(
      route.create(request(), response, '10', metadata('rapor.pdf')),
    ).resolves.toBeUndefined();
  });
});

describe('POST /uploads with more bytes than the pool has', () => {
  it('refuses at the FIRST request instead of at the last byte', async () => {
    // §5.4: sunucu kotayı ve boş alanı başlamadan denetler. Denetim yalnız yazma sırasındayken
    // kullanıcı 40 GB'lık bir dosyayı sürükleyip saatler sonra %15'te 507 alıyordu.
    const { route, response } = chunkController({ available: 6 });

    const error = await route
      .create(request(), response, '40', metadata('film.mkv'))
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProblemException);
    expect((error as ProblemException).code).toBe('insufficient-storage');
    // Ve iki sayı da cümlede: "40 B gerekiyor, 6 B boş" bir kullanıcının ne yapacağını bilebileceği
    // cümle; "yer yok" değil.
    expect((error as ProblemException).detail).toContain('40 B');
    expect((error as ProblemException).detail).toContain('6 B');
  });
});

describe('POST /uploads/{id}/resolve with policy "replace"', () => {
  it('puts the parked file back when the publish fails', async () => {
    const { route, steps } = controller(true);

    await expect(route.resolve(request(), SESSION.id, { policy: 'replace' })).rejects.toThrow();

    // Park, yayım denemesi, sonra geri alma: çöpten çıkar ve ESKİ adına döndür. Bunlar olmadan
    // klasörde ne eski ne yeni dosya kalıyor, ve eski dosya çöpte başka bir adla duruyor.
    expect(steps).toEqual([
      { op: 'rename', id: EXISTING, name: 'rapor (2).pdf' },
      { op: 'trash', id: EXISTING },
      { op: 'publish' },
      { op: 'restore', id: EXISTING },
      { op: 'rename', id: EXISTING, name: 'rapor.pdf' },
    ]);
  });

  it('baytları kalmamış bir yüklemenin satırını KAPATIYOR', async () => {
    // ── ÇIKIŞI OLMAYAN SATIR ──────────────────────────────────────────────────────────────
    // Ara alandaki dosya yoksa bu oturum için yapılabilecek hiçbir şey yok: yayımlanacak bayt
    // yok. Satır bırakılırsa ekran ona sonsuza kadar "cevabınızı bekliyor" der ve verilen her
    // karar "yayımlanamadı" ile döner. Cihazda 12 dosya tam olarak öyle duruyordu.
    //
    // Kod da ayrı: 409 çözülebilir bir çakışma demek, bu ise çözülemez — kullanıcıya söylenecek
    // tek cümle "yeniden yükleyin".
    const { route, sql } = controller(true, new StagedBytesGoneError('staging: no such file'));

    const error = await route
      .resolve(request(), SESSION.id, { policy: 'keep-both' })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProblemException);
    expect((error as ProblemException).code).toBe('staged-bytes-gone');
    expect(sql.some((statement) => statement.includes('DELETE FROM public.upload_sessions'))).toBe(
      true,
    );
  });

  it('leaves the parked file in the bin when the publish succeeds', async () => {
    // Kontrol: geri alma yalnız yayım DÜŞTÜĞÜNDE koşmalı. Başarılı bir "değiştir"de eski dosya
    // çöpte kalıyor — kullanıcının yanlış karar verdiyse geri alabileceği yerde.
    const { route, steps } = controller(false);

    await route.resolve(request(), SESSION.id, { policy: 'replace' });

    expect(steps.map((step) => step.op)).toEqual(['rename', 'trash', 'publish', 'record']);
  });
});
