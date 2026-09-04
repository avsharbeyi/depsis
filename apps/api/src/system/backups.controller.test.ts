import { describe, expect, it } from 'vitest';

import type { OpenApi } from '@depsis/contracts';

import { BackupsController, explain } from './backups.controller.js';
import { MAX_DATASETS } from './backups.service.js';
import type { BackupsService, PoolSnapshot, SnapshotRow } from './backups.service.js';

type Schemas = OpenApi.components['schemas'];

/**
 * What the agent's rationale is allowed to carry into an HTTP response.
 *
 * The reason a REFUSAL reaches the caller verbatim is that only the agent knows it and only the
 * caller can act on it. The reason a command FAILURE must not is that
 * `services/system-agent/src/mod.rs` formats `SeamError::Command` as
 * `command {program} failed with status {status}: {stderr}` — the absolute path of the privileged
 * binary and raw `zfs` stderr, which names the full dataset path. `dispatch.rs` turns every
 * execution error into `Response::Failed`, and `expectStatus` collapses `Failed` and `Refused` into
 * one `AgentRefusedError`, so this prefix is the only thing that tells them apart from the API
 * side. Losing the split is a one-character edit to the regex, hence these tests.
 */

const CID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

describe('the agent reason a 409 body is allowed to repeat', () => {
  it('repeats a refusal, because only the operator can act on it', () => {
    expect(explain('the dataset is busy', CID)).toBe('the dataset is busy');
    expect(explain('pool is read-only', CID)).toBe('pool is read-only');
  });

  it('withholds the command, its absolute path and the raw stderr', () => {
    const leaked =
      'command /usr/sbin/zfs failed with status 1: cannot create snapshot ' +
      "'tank/shares/acme_private@nightly': dataset is busy";
    const answer = explain(leaked, CID);

    expect(answer).toBe('the snapshot command failed; see the system log for this request');
    // Asserted on the parts rather than only on the whole, so a future rewrite that returns a
    // different fixed sentence still fails if it starts interpolating any of these back in.
    expect(answer).not.toContain('/usr/sbin/zfs');
    expect(answer).not.toContain('tank/shares/acme_private');
    expect(answer).not.toContain('status 1');
  });

  it('withholds it however the exit status is written', () => {
    // A signal death is reported as a negative status by the agent's `ExitStatus::code` handling,
    // and a three-digit status is legal. Both are the same disclosure.
    expect(explain('command /sbin/zfs failed with status -9: killed', CID)).not.toContain('/sbin/');
    expect(explain('command /sbin/zfs failed with status 127: no such file', CID)).not.toContain(
      '/sbin/',
    );
  });

  it('withholds it even when the stderr is multi-line, which is how zfs actually writes', () => {
    // The collapse to one line happens before the match, so a real multi-line dump must not slip
    // past the prefix test by starting with a newline's worth of whitespace.
    const leaked =
      '  command /usr/sbin/zfs failed with status 1:\n  cannot open ' +
      "'tank/shares/acme': dataset does not exist\n";
    expect(explain(leaked, CID)).not.toContain('tank/shares/acme');
  });

  it('does not withhold a refusal that merely mentions a command', () => {
    // The guard is a prefix, not a keyword search. An agent-authored refusal is allowed to use the
    // word, and swallowing it would hide the one sentence the operator needs.
    const refusal = 'the snapshot command is disabled while a scrub is running';
    expect(explain(refusal, CID)).toBe(refusal);
  });

  it('still caps a long refusal at one line', () => {
    const long = `a${'b'.repeat(400)}`;
    const answer = explain(long, CID);
    expect(answer.length).toBe(200);
    expect(answer.endsWith('…')).toBe(true);
  });

  it('says so rather than answering with nothing when the agent gave no reason', () => {
    expect(explain('   \n  ', CID)).toBe('the system agent gave no reason');
  });
});

/**
 * Kayıt ile HAVUZUN karşılaştırılması.
 *
 * Bu uç bir zamanlar yalnız `snapshots` tablosunu okuyordu ve `complete: false` diyordu; ekranda
 * bir uyarı kutusu "bu liste havuzun envanteri değil" diye yazıyordu. Uyarı dürüsttü ve sorunun
 * kendisiydi: kabuktan silinmiş bir görüntü kayıtta duruyor, ve ekran var olmayan bir geri dönüş
 * noktası öneriyordu. Bir yedek listesinin yanıldığı an, tam olarak ona bakılan an.
 *
 * Aşağıdakiler o karşılaştırmanın üç çıktısını ve ajanın susması hâlini ölçüyor. Sahte bir servis
 * yeterli çünkü ölçülen şey BİRLEŞTİRME: hangi satırın hangi duruma düştüğü, ve ajan cevap
 * vermediğinde hiçbirinin "kayıp" olmaması.
 */
describe('the backups list, compared against the pool', () => {
  const row = (name: string, dataset = 'tank/depsis'): SnapshotRow => ({
    id: `id-${name}`,
    dataset,
    name,
    full_name: `${dataset}@${name}`,
    created_at: new Date('2026-08-01T00:00:00Z'),
    created_by_username: 'ayse',
  });

  const onPool = (name: string, dataset = 'tank/depsis'): PoolSnapshot => ({
    dataset,
    name,
    usedBytes: 4096,
    createdAt: new Date('2026-08-01T00:00:00Z'),
  });

  /** Yalnız bu iki metodu kullanan bir denetleyici için yeterli. */
  function controllerWith(
    rows: SnapshotRow[],
    pool: PoolSnapshot[] | null,
  ): { list: () => Promise<Schemas['SnapshotPage']> } {
    const service = {
      list: () => Promise.resolve(rows),
      inventory: () => Promise.resolve(pool),
    } as unknown as BackupsService;
    const controller = new BackupsController(service);
    const request = {
      depsis: { organizationId: 'org', userId: 'user' },
    } as unknown as Parameters<BackupsController['list']>[0];
    return { list: () => controller.list(request) };
  }

  it('marks a recorded snapshot that is really there as present', async () => {
    const page = await controllerWith([row('nightly')], [onPool('nightly')]).list();
    expect(page.complete).toBe(true);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.state).toBe('present');
    // Yer HAVUZDAN geliyor; DEPSIS onu kaydetmiyor çünkü rakam zamanla değişiyor.
    expect(page.items[0]?.usedBytes).toBe(4096);
  });

  it('marks a recorded snapshot the pool no longer has as missing', async () => {
    // ASIL OLAN BU. Eskiden bu satır "present" ile ayırt edilemezdi, ve ekran var olmayan bir geri
    // dönüş noktası öneriyordu.
    const page = await controllerWith([row('silinmis')], []).list();
    expect(page.items[0]?.state).toBe('missing');
    // Yer YOK: havuzda olmayan bir şeyin tuttuğu yer de yok, ve bir sayı göstermek onu var gibi
    // gösterirdi.
    expect(page.items[0]?.usedBytes).toBeUndefined();
  });

  it('shows a snapshot taken from a shell, and gives it no id', async () => {
    const page = await controllerWith([], [onPool('elle')]).list();
    expect(page.items[0]?.state).toBe('unmanaged');
    // Kimlik NULL: DEPSIS'in o satır için bir kaydı yok, ve uydurulmuş bir kimlik istemciye
    // gerçek olmayan bir tutamak verirdi.
    expect(page.items[0]?.id).toBeNull();
    expect(page.items[0]?.createdBy).toBeNull();
  });

  it('does not call a recorded snapshot missing when the agent cannot be reached', async () => {
    // Ajanı bir dakikalığına düşmüş bir kutuda bütün yedekleri silinmiş göstermek, bu değişikliğin
    // düzeltmeye çalıştığı hatanın daha kötü bir hâli olurdu.
    const page = await controllerWith([row('nightly')], null).list();
    expect(page.complete).toBe(false);
    expect(page.items[0]?.state).toBe('unknown');
  });

  it('sorts the two sources into one list, newest first', async () => {
    // İki listeyi ayrı sıralayıp uç uca eklemek, ekranda tarihlerin bir yerde geri sarması demek.
    const older: SnapshotRow = { ...row('eski'), created_at: new Date('2026-01-01T00:00:00Z') };
    const newer: PoolSnapshot = { ...onPool('yeni'), createdAt: new Date('2026-12-01T00:00:00Z') };
    const middle: SnapshotRow = { ...row('orta'), created_at: new Date('2026-06-01T00:00:00Z') };

    const page = await controllerWith([older, middle], [newer, onPool('orta')]).list();
    expect(page.items.map((item) => item.name)).toEqual(['yeni', 'orta', 'eski']);
  });

  it('keeps two datasets apart even when a snapshot name is shared', async () => {
    // Aynı ad iki veri kümesinde olabilir; karşılaştırma `dataset@ad` üzerinden yapılmazsa biri
    // ötekini "present" gösterirdi.
    const page = await controllerWith(
      [row('nightly', 'tank/a'), row('nightly', 'tank/b')],
      [onPool('nightly', 'tank/a')],
    ).list();
    const byDataset = new Map(page.items.map((item) => [item.dataset, item.state]));
    expect(byDataset.get('tank/a')).toBe('present');
    expect(byDataset.get('tank/b')).toBe('missing');
  });

  it('sorulmamis bir veri kumesinin satirini "kayip" gostermiyor', async () => {
    // `inventory` en cok `MAX_DATASETS` kume soruyor. Sorulmayan kumenin satirlari eskiden
    // `missing` cikiyordu — yani "kabuktan silinmis; geri donulemez" — oysa havuzda duruyorlardi:
    // on yedinci paylasimi olan bir cihazda o paylasimin butun geri donus noktalari yok
    // goruluyordu. Sorulmamis bir sey hakkinda verilebilecek tek durust cevap `unknown`.
    const datasets = Array.from(
      { length: MAX_DATASETS + 1 },
      (_, n) => `tank/pay${String(n).padStart(2, '0')}`,
    );
    const last = datasets[MAX_DATASETS] as string;
    const page = await controllerWith(
      datasets.map((dataset) => row('nightly', dataset)),
      datasets.slice(0, MAX_DATASETS).map((dataset) => onPool('nightly', dataset)),
    ).list();

    const byDataset = new Map(page.items.map((item) => [item.dataset, item.state]));
    expect(byDataset.get('tank/pay00')).toBe('present');
    expect(byDataset.get(last)).toBe('unknown');
    // VE CEVABIN TAMAMI EKSIK. Yalnizca durumu degistirmek, ekranin "liste eksiksiz" demeye
    // devam etmesi demek olurdu.
    expect(page.complete).toBe(false);
  });

  it('kumelerin hepsi sorulabildiginde liste eksiksiz kaliyor', async () => {
    const datasets = Array.from({ length: MAX_DATASETS }, (_, n) => `tank/pay${n}`);
    const page = await controllerWith(
      datasets.map((dataset) => row('nightly', dataset)),
      datasets.map((dataset) => onPool('nightly', dataset)),
    ).list();

    expect(page.complete).toBe(true);
    expect(page.items.every((item) => item.state === 'present')).toBe(true);
  });
});
