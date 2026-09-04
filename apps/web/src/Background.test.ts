import type { OpenApi } from '@depsis/contracts';
import { describe, expect, it } from 'vitest';

import { appendPage } from './Background.js';

type FileEntry = OpenApi.components['schemas']['FileEntry'];

/** Yalnız bu kararın okuduğu alanlar; gerisi sunucudan gelir ve seçiciyi ilgilendirmez. */
function entry(name: string, kind: FileEntry['kind'], mimeType?: string): FileEntry {
  return { id: `${kind}-${name}`, name, kind, mimeType } as FileEntry;
}

/**
 * Arka plan seçicisinin sayfa birleştirmesi.
 *
 * BU TESTİN VAR OLMA NEDENİ `hasMore`. Seçici tek sayfa okuyup imleci hiç istemiyordu; sunucunun
 * varsayılan sınırı 100 olduğu için 400 fotoğraflı bir klasörde son 300 resim yok sayılıyor ve
 * hiçbir şey "devamı var" demiyordu. Kullanıcı orada olduğunu bildiği resmi bulamayınca seçici
 * bozuk görünüyor.
 */
describe('appendPage', () => {
  it('carries the cursor and the "there is more" flag out of the page', () => {
    const page = {
      items: [entry('a.jpg', 'file', 'image/jpeg')],
      hasMore: true,
      nextCursor: 'ABC',
    };
    const result = appendPage([], page);
    expect(result.more).toBe(true);
    expect(result.cursor).toBe('ABC');
  });

  it('does not promise more when the server gave no cursor to ask with', () => {
    // Basıldığında hiçbir şey yapmayan bir "Daha fazla göster", olmayandan kötüdür.
    const result = appendPage([], { items: [], hasMore: true });
    expect(result.more).toBe(false);
    expect(result.cursor).toBeUndefined();
  });

  it('keeps what is already on screen and re-sorts the whole list', () => {
    const first = [entry('Ev', 'folder'), entry('z.png', 'file', 'image/png')];
    const result = appendPage(first, {
      items: [entry('Araba', 'folder'), entry('a.png', 'file', 'image/png')],
      hasMore: false,
    });
    // Klasörler önce, sonra ad: ikinci sayfanın klasörleri birinci sayfanın dosyalarının altında
    // kalsaydı, liste sayfa sınırını kullanıcıya gösterirdi.
    expect(result.entries.map((item) => item.name)).toEqual(['Araba', 'Ev', 'a.png', 'z.png']);
  });

  it('counts what the media filter dropped in THIS page only', () => {
    const result = appendPage([], {
      items: [entry('notlar.txt', 'file', 'text/plain'), entry('a.jpg', 'file', 'image/jpeg')],
      hasMore: false,
    });
    expect(result.hiddenAdded).toBe(1);
    expect(result.entries.map((item) => item.name)).toEqual(['a.jpg']);
  });
});
