import { describe, expect, it } from 'vitest';
import type { Writable } from 'node:stream';

import type { AgentDataService } from '../agent/agent-data.service.js';
import type { FilesService } from './files.service.js';
import { ThumbnailsService } from './thumbnails.service.js';

/**
 * Küçük resim önbelleğinin AJANLA olan ilişkisi.
 *
 * Burada ölçülen şey üretilen görüntü değil — onu `exif-thumbnail.test.ts` ölçüyor — kaç kere
 * `open_download` açıldığı. Ajan her açık indirme jetonunu 300 saniye tutuyor ve okuma yönündeki
 * bir jeton geri verilemiyor; 64 jeton dolduğunda cihazdaki HER yükleme ve HER indirme "too many
 * transfers are open" ile reddediliyor. Yani gereksiz açılan bir jeton, bir performans ayrıntısı
 * değil, beş dakikalık bir kilit.
 */

/** Ajanın `open_download`u: kaç kere açıldığını sayıyor, ve bildirdiği boyut ayarlanabiliyor. */
function stubs(diskSize: number): {
  files: FilesService;
  data: AgentDataService;
  opens: () => number;
} {
  let opened = 0;
  const files = {
    openDownload: (): Promise<{ token: string; size: number }> => {
      opened += 1;
      return Promise.resolve({ token: `t${opened}`, size: diskSize });
    },
  } as unknown as FilesService;
  const data = {
    receive: (_token: string, _offset: number, length: number, sink: Writable): Promise<void> =>
      // Sıfır baytlar: içinde EXIF yok, yani cevap "küçük resmi yok" — ve o cevap da önbelleğe
      // giriyor, asıl kazancın olduğu yer orası.
      new Promise((resolve) => {
        sink.end(Buffer.alloc(length), () => resolve());
      }),
  } as unknown as AgentDataService;
  return { files, data, opens: () => opened };
}

describe('the thumbnail cache and the agent', () => {
  const at = new Date(1_700_000_000_000);

  it('opens ONE download however many times the same row is asked for', async () => {
    // ── SIZINTI ───────────────────────────────────────────────────────────────────────────
    //
    // Önbellek anahtarı ajanın bildirdiği boyutu içerdiği için, önbelleğe bakmadan ÖNCE
    // `open_download` çağrılıyordu; isabet hâlinde dönen jeton hiç okunmuyordu. 64'ten fazla
    // fotoğraflı bir klasörün İKİNCİ açılışı — bütün cevaplar önbellekten geldiği hâlde — 64
    // jetonu beş dakika boyunca ajanda asılı bırakıyor, ve o sürede sahibi hiçbir dosya
    // yükleyemiyor, hiçbir dosya indiremiyordu.
    const { files, data, opens } = stubs(4096);
    const service = new ThumbnailsService(files, data);

    expect(await service.of('e1', 4096, at, 'depo', ['a.jpg'], 'c1', 'test')).toBeNull();
    expect(await service.of('e1', 4096, at, 'depo', ['a.jpg'], 'c2', 'test')).toBeNull();

    expect(opens()).toBe(1);
  });

  it('reads again when the row says the file changed', async () => {
    // Anahtar satırın kendi alanlarından kuruluyor: SMB'den değişen dosyayı uzlaştırma turu satıra
    // yazıyor, ve satır değişince eski cevap artık o dosyanın cevabı değil.
    const { files, data, opens } = stubs(4096);
    const service = new ThumbnailsService(files, data);

    await service.of('e1', 4096, at, 'depo', ['a.jpg'], 'c1', 'test');
    await service.of('e1', 4096, new Date(at.getTime() + 1000), 'depo', ['a.jpg'], 'c2', 'test');

    expect(opens()).toBe(2);
  });

  it('never opens a download for a file the row says is empty', async () => {
    // Cevap satırdan verilebiliyor. Açılmış bir jetonu geri verecek yol olmadığı için, gereksiz
    // açılan her jeton beş dakikalık bir yer kaplıyor.
    const { files, data, opens } = stubs(0);
    const service = new ThumbnailsService(files, data);

    expect(await service.of('bos', 0, at, 'depo', ['bos.jpg'], 'c1', 'test')).toBeNull();
    expect(opens()).toBe(0);
  });

  it('does not cache an answer read from a file the row does not describe', async () => {
    // Diskteki boyut satırdakinden farklı: dosya SMB'den değişmiş ve uzlaştırma turu satırı henüz
    // güncellememiş. Cevap üretiliyor — kullanıcı bir görüntü görüyor — ama ESKİ satır anahtarının
    // altına yazılmıyor, yoksa yanlış görüntü satır güncellenene kadar kalıcı olurdu.
    const { files, data, opens } = stubs(9000);
    const service = new ThumbnailsService(files, data);

    await service.of('e1', 4096, at, 'depo', ['a.jpg'], 'c1', 'test');
    await service.of('e1', 4096, at, 'depo', ['a.jpg'], 'c2', 'test');

    expect(opens()).toBe(2);
  });
});
