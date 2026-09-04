import { randomUUID } from 'node:crypto';
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { IndexerService, OrganizationsService } from '@depsis/api/worker-surface';

import { SmbAuditReader } from './smb-audit.reader.js';

/**
 * Okuma sınırının satır sonuna hizalanması.
 *
 * rsyslog çıktıyı tamponlayarak yazıyor ve tampon bir satırın ORTASINDA boşalabiliyor. Sınır dosya
 * boyutu olsaydı o satır ikiye bölünürdü: ilk parça altı alandan az olduğu için, ikinci parça
 * `smbd_audit: ` işaretini taşımadığı için ayrıştırıcıdan düşer — yani satırın adlandırdığı dizin
 * ADR-0011'in hızlı yolundan HİÇ geçmez ve ancak on beş dakikalık yürüyüşle görünür.
 *
 * Ölçülen şey tam olarak bu: yarım yazılmış bir satır, tamamlandıktan sonra bir kez ve doğru
 * biçimde kuyruğa girmeli.
 */
describe('the audit reader stops at a line boundary', () => {
  const path = join(tmpdir(), `depsis-smb-audit-${randomUUID()}.log`);
  let reader: SmbAuditReader | null = null;

  afterEach(() => {
    reader?.stop();
    reader = null;
    rmSync(path, { force: true });
  });

  const line = (fields: string): string =>
    `2026-09-04T09:15:02.114Z depsis smbd_audit: ${fields}\n`;

  /** Sahibin ürettiği tek olay: `belgeler` paylaşımında `docs/` altına bir dosya kapandı. */
  const event = line('ayse|10.0.0.5|belgeler|close|ok|docs/rapor.pdf');

  function build(enqueued: { directory: string }[]): SmbAuditReader {
    const indexer = {
      shareByName: () => Promise.resolve('share-1'),
      enqueuePath: (_org: string, _share: string, directory: string) => {
        enqueued.push({ directory });
        return Promise.resolve();
      },
    } as unknown as IndexerService;
    const organizations = {
      resolveSoleId: () => Promise.resolve('org-1'),
    } as unknown as OrganizationsService;
    return new SmbAuditReader(path, indexer, organizations);
  }

  /**
   * `tick` özel; zamanlayıcıyı beklemek yerine doğrudan çevriliyor.
   *
   * `start()` de bilerek çağrılmıyor: o gerçek bir `setInterval` kuruyor ve saniyede bir kendi
   * turunu atıyor, yani testin okuduğu şey testin yazdığı şeyle yarışırdı. Yeni bir okuyucu zaten
   * dosyanın başından (`offset = 0`) başlıyor.
   */
  const tick = (r: SmbAuditReader): Promise<void> =>
    (r as unknown as { tick: () => Promise<void> }).tick();

  it('waits for the rest of a line that arrived in two writes', async () => {
    writeFileSync(path, '');
    const enqueued: { directory: string }[] = [];
    reader = build(enqueued);

    // rsyslog'un tamponu satırın ortasında boşaldı.
    const split = event.indexOf('close');
    appendFileSync(path, event.slice(0, split));
    await tick(reader);
    expect(enqueued, 'yarım satır hiçbir şey üretmemeli').toEqual([]);

    appendFileSync(path, event.slice(split));
    await tick(reader);
    expect(enqueued).toEqual([{ directory: 'docs' }]);
  });

  it('does not read a completed line twice', async () => {
    writeFileSync(path, '');
    const enqueued: { directory: string }[] = [];
    reader = build(enqueued);

    appendFileSync(path, event);
    await tick(reader);
    // İkinci tur: dosya büyümedi, sınır zaten satır sonunda.
    await tick(reader);
    expect(enqueued).toEqual([{ directory: 'docs' }]);
  });

  it('keeps the complete lines that came before a split one', async () => {
    writeFileSync(path, '');
    const enqueued: { directory: string }[] = [];
    reader = build(enqueued);

    const second = line('ayse|10.0.0.5|belgeler|close|ok|arsiv/eski.pdf');
    appendFileSync(path, event + second.slice(0, 20));
    await tick(reader);
    expect(enqueued, 'tamamlanan satır beklemeden geçmeli').toEqual([{ directory: 'docs' }]);

    appendFileSync(path, second.slice(20));
    await tick(reader);
    expect(enqueued).toEqual([{ directory: 'docs' }, { directory: 'arsiv' }]);
  });
});
