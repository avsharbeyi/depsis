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
  /** Satırın O ANKİ hâli: devralma gerçekten yazdı mı, buradan okunuyor. */
  row: { recoveryOnly: boolean; enabled: boolean; deviceId: string | null };
}

function harness(
  posixUidFor: () => Promise<number> = () => Promise.resolve(UID),
  recoveryOnly = false,
  /** Diskin ajandan okunan hâli — verilmezse hazır, açık ve bağlı. */
  root: { prepared: boolean; key_loaded: boolean; mounted: boolean } = {
    prepared: true,
    key_loaded: true,
    mounted: true,
  },
): Harness {
  const calls: AgentRequest[] = [];
  const row: Harness['row'] = { recoveryOnly, enabled: true, deviceId: 'olen-cihaz' };

  const agent = {
    isAvailable: () => true,
    call: (request: AgentRequest): Promise<AgentResponse> => {
      calls.push(request);
      if (request.op === 'restore_file_from_backup') {
        return Promise.resolve<AgentResponse>({ status: 'copied', offset: 11, done: true });
      }
      if (request.op === 'backup_root_status') {
        return Promise.resolve<AgentResponse>({
          status: 'backup_root',
          ...root,
          available_bytes: 1_000,
          used_bytes: 10,
        });
      }
      return Promise.resolve<AgentResponse>({ status: 'ok', schema_version: 43 });
    },
  } as unknown as AgentService;

  const query = (text: string): Promise<unknown[]> => {
    // DEVRALMA GERÇEKTEN YAZIYOR MU. Satırı sabit döndüren bir taklit, `claim`in hiçbir şey
    // yazmadığı bir sürümde de yeşil kalırdı.
    if (text.includes('UPDATE public.backup_targets') && text.includes('recovery_only = false')) {
      row.recoveryOnly = false;
      row.enabled = true;
      row.deviceId = null;
      return Promise.resolve([]);
    }
    if (text.includes('FROM public.backup_targets')) {
      return Promise.resolve([
        {
          id: 'aa11bb22-0000-4000-8000-00000000dddd',
          pool: 'yedek',
          label: 'Kirmizi disk',
          cadence_hours: 6,
          retain_days: 30,
          recovery_only: row.recoveryOnly,
          device_id: row.deviceId,
          enabled: row.enabled,
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

  return { targets: new BackupTargetService(db, agent, posix), calls, row };
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

  it('reddin cümlesi diski DEVRALMA adımına yönlendiriyor', async () => {
    // Kapalı bir anahtarı gören sahibinin sorusu "neden" değil "nasıl". Sebebi söyleyip çıkışı
    // söylemeyen bir cümle, onu terminale ya da diski silmeye gönderiyordu.
    const { targets } = harness(undefined, true);

    await expect(targets.update(ORG, { enabled: true })).rejects.toThrow(/devral/u);
  });
});

/**
 * KURTARMA DİSKİNİ DEVRALMAK.
 *
 * Ev yanıyor, yeni cihaz alınıyor, disk tanıtılıyor, dosyalar geri getiriliyor — ve sonra sahibi
 * aynı diskin yeni cihazın yedek diski olmasını istiyor. Bunun bir yolu yoktu: `enabled:true`
 * reddediliyor, disk bırakılıp yeniden kurulamıyor (`prepare_backup_root` koşulsuz `zfs create`
 * çalıştırıyor ve dolu diskte hata veriyor), yani kalan tek yol terminalde `zfs destroy` idi —
 * yedeği silmeden devam edilemiyordu.
 */
describe('kurtarma diskinin devralınması', () => {
  it('kurtarma kipini kapatıp yedeklemeyi açıyor', async () => {
    const { targets, row } = harness(undefined, true);

    const view = await targets.claim(ORG, 'kor-3');

    expect(row.recoveryOnly).toBe(false);
    expect(row.enabled).toBe(true);
    expect(view.recoveryOnly).toBe(false);
  });

  it('ölen cihazın kimliğini satırda BIRAKMIYOR', async () => {
    // `device_id`, disk.json'dan okunan ÖLEN cihazın kimliğiydi. Diski devralan cihaz o değil, ve
    // yerine yazılacak bir şey de yok — `prepare()` de bu sütunu doldurmuyor.
    const { targets, row } = harness(undefined, true);

    await targets.claim(ORG, 'kor-4');

    expect(row.deviceId).toBeNull();
  });

  it('KİLİTLİ bir diski devralmıyor', async () => {
    // Bayrağı kilitli bir diskte düşürmek, "artık bu cihazın yedeği" diyen bir satır ve her turda
    // `kilitli` yazan bir zincir bırakırdı.
    const { targets, row } = harness(undefined, true, {
      prepared: true,
      key_loaded: false,
      mounted: false,
    });

    await expect(targets.claim(ORG, 'kor-5')).rejects.toThrow(/kilid/u);
    expect(row.recoveryOnly).toBe(true);
  });

  it('zaten bu cihazın olan diski ikinci kez devralmıyor', async () => {
    const { targets } = harness(undefined, false);

    await expect(targets.claim(ORG, 'kor-6')).rejects.toThrow(/zaten/u);
  });
});

/**
 * Diskin ŞİFRESİZ yarısına konan metin, diski eline geçiren HERKESİN okuduğu metin.
 */
describe('OKUBENI.txt', () => {
  it('olmayan bir klasörü vaat etmiyor', async () => {
    // Metin `DEPSIS-YEDEK/gunluk/` diye bir defter söz veriyordu ve onu yazan hiçbir kod yoktu:
    // diski başka bir bilgisayara takan insan olmayan bir klasörü arıyordu.
    const { targets, calls } = harness();

    await targets.writeDiskDescription(ORG, 'kor-7');

    const readme = calls.find(
      (call) => call.op === 'backup_write_meta' && call.name === 'OKUBENI.txt',
    );
    expect(readme).toBeDefined();
    const content = readme?.op === 'backup_write_meta' ? readme.content : '';
    expect(content).toContain('DEPSIS-YEDEK/silinenler/');
    expect(content).not.toContain('gunluk');
  });
});
