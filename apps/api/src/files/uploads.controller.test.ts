import { describe, expect, it } from 'vitest';

import type { AgentDataService } from '../agent/agent-data.service.js';
import type { AgentService } from '../agent/agent.service.js';
import type { AuthenticatedRequest } from '../auth/session.guard.js';
import type { DbService } from '../db/db.service.js';
import type { PosixIdentityService } from '../identity/posix.service.js';
import type { CopyService } from './copy.service.js';
import { NameTakenOnDiskError, type FilesService } from './files.service.js';
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

function controller(publishFails: boolean): {
  route: UploadsController;
  steps: Step[];
} {
  const steps: Step[] = [];

  const db = {
    withTenant: <T>(_organizationId: string, run: (q: unknown) => Promise<T>): Promise<T> =>
      run({
        query: (sql: string): Promise<unknown[]> =>
          Promise.resolve(sql.includes('FROM public.upload_sessions') ? [SESSION] : []),
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
      return publishFails
        ? Promise.reject(new NameTakenOnDiskError('rapor.pdf', 'the destination exists'))
        : Promise.resolve(10);
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

  return { route: new UploadsController(db, files, agent, data, posix, copies), steps };
}

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

  it('leaves the parked file in the bin when the publish succeeds', async () => {
    // Kontrol: geri alma yalnız yayım DÜŞTÜĞÜNDE koşmalı. Başarılı bir "değiştir"de eski dosya
    // çöpte kalıyor — kullanıcının yanlış karar verdiyse geri alabileceği yerde.
    const { route, steps } = controller(false);

    await route.resolve(request(), SESSION.id, { policy: 'replace' });

    expect(steps.map((step) => step.op)).toEqual(['rename', 'trash', 'publish', 'record']);
  });
});
