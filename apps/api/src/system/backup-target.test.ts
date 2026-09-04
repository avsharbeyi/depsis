import { describe, expect, it } from 'vitest';

import type { AgentRequest, AgentResponse, AgentService } from '../agent/agent.service.js';
import type { DbService } from '../db/db.service.js';
import type { PosixIdentityService } from '../identity/posix.service.js';
import { BackupTargetService } from './backup-target.service.js';

/**
 * Yedekten geri getirmenin SESSİZ ARIZASI.
 *
 * Ajan ara dosyayı kök olarak 0600 ile açıyor ve sahipliği yalnız istekten öğreniyor. İstek
 * sahipliği taşımadığında dosya diskte `root:root 0600` olarak oturuyordu: ekran "geri getirildi"
 * diyor, dosya listede görünüyor, web'den bile inebiliyor (ajan kök olarak okuyor) — ama sahibi
 * ağ sürücüsünden açmaya kalkınca "erişim reddedildi" alıyor. Terminalsiz bir çıkış yok.
 *
 * Veritabanı taklit ediliyor: ölçülen şey İSTEĞİN İÇERİĞİ, ve o PostgreSQL'e bağlı değil.
 */

const ORG = '3f2a51c0-0000-4000-8000-00000000aaaa';
const ACTOR = '9b7e42d1-0000-4000-8000-00000000cccc';
/** Kimliğin ayrılmış aralığından bir uid; ajanın `PosixId`i bunun dışını reddediyor. */
const UID = 300_100;

interface Harness {
  targets: BackupTargetService;
  calls: AgentRequest[];
}

function harness(
  posixUidFor: () => Promise<number> = () => Promise.resolve(UID),
  recoveryOnly = false,
): Harness {
  const calls: AgentRequest[] = [];

  const agent = {
    isAvailable: () => true,
    call: (request: AgentRequest): Promise<AgentResponse> => {
      calls.push(request);
      if (request.op === 'restore_file_from_backup') {
        return Promise.resolve<AgentResponse>({ status: 'copied', offset: 11, done: true });
      }
      return Promise.resolve<AgentResponse>({ status: 'ok', schema_version: 43 });
    },
  } as unknown as AgentService;

  const query = (text: string): Promise<unknown[]> => {
    if (text.includes('FROM public.backup_targets')) {
      return Promise.resolve([
        {
          id: 'aa11bb22-0000-4000-8000-00000000dddd',
          pool: 'yedek',
          label: 'Kirmizi disk',
          cadence_hours: 6,
          retain_days: 30,
          recovery_only: recoveryOnly,
          device_id: null,
          enabled: true,
          last_verified_at: null,
          last_verify_ok: null,
          last_verify_note: null,
          last_scrub_at: null,
        },
      ]);
    }
    return Promise.resolve([]);
  };
  const db = {
    withTenant: <T>(_organizationId: string, fn: (q: { query: typeof query }) => Promise<T>) =>
      fn({ query }),
  } as unknown as DbService;

  const posix = { posixUidFor } as unknown as PosixIdentityService;

  return { targets: new BackupTargetService(db, agent, posix), calls };
}

describe('yedekten geri getirme', () => {
  it('dosyayı geri getiren hesabın adına yazıyor', async () => {
    const { targets, calls } = harness();

    const result = await targets.restore(
      ORG,
      {
        from: ['Dosyalar', 'belgeler', 'vergi.pdf'],
        share: 'belgeler',
        to: ['vergi.pdf'],
        actorId: ACTOR,
      },
      'kor-1',
    );

    expect(result).toEqual({ restoredBytes: 11 });
    const restore = calls.find((call) => call.op === 'restore_file_from_backup');
    expect(restore).toBeDefined();
    // İDDİANIN TAMAMI BU. Alanlar olmadan da test yeşildi ve dosya `root:root` iniyordu; ajan
    // sahipliği başka hiçbir yerden öğrenemiyor.
    expect(restore).toMatchObject({ owner_uid: UID, owner_gid: UID });
  });

  it('posix kimliği çözülemeyen bir hesapta ajana hiç gitmiyor', async () => {
    // SESSİZ KÖK SAHİPLİĞİ OLMAZ. Kimliği çözülemeyen bir hesap için geri getirme, sahipsiz bir
    // dosya bırakmaktansa burada durmalı — ajan tarafındaki karşılığı `PosixId`in 0'ı ayrıştırma
    // anında reddetmesi.
    const { targets, calls } = harness(() => Promise.reject(new Error('bu hesabın uid’i yok')));

    await expect(
      targets.restore(
        ORG,
        { from: ['Dosyalar', 'a.txt'], share: 'belgeler', to: ['a.txt'], actorId: ACTOR },
        'kor-2',
      ),
    ).rejects.toThrow();
    expect(calls.some((call) => call.op === 'restore_file_from_backup')).toBe(false);
  });
});

/**
 * KURTARMA DİSKİNDE YEDEKLEME AÇMAK.
 *
 * Bayrak sessizce kabul ediliyordu: satır `enabled = true` oluyor, ekran "yedekleniyor" diyor, ama
 * tur kurtarma kipini görüp hiçbir şey yapmadan "bitti" dönüyor — sahibinin gördüğü şey,
 * çalışıyormuş gibi duran ve hiç yedek almayan bir anahtar. Bir kontrolün çalışıyor GÖRÜNMESİ,
 * hiç olmamasından kötü.
 */
describe('kurtarma diskinin ayarları', () => {
  it('yedeklemeyi açma isteğini sebebiyle birlikte reddediyor', async () => {
    const { targets } = harness(undefined, true);

    await expect(targets.update(ORG, { enabled: true })).rejects.toThrow(/kurtarma kipi/u);
  });

  it('etiket gibi zararsız bir alanı değiştirmeye engel olmuyor', async () => {
    const { targets } = harness(undefined, true);

    await expect(targets.update(ORG, { label: 'Mavi disk' })).resolves.toBeDefined();
  });
});
