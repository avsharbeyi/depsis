import type { OpenApi } from '@depsis/contracts';
import { describe, expect, it } from 'vitest';

import { byMonth, walkPhotos, type Page, type ReadFolder } from './Photos.js';

type FileEntry = OpenApi.components['schemas']['FileEntry'];

/** Yalnız bu kararın okuduğu alanlar. */
function file(id: string, name: string, modifiedAt: string): FileEntry {
  return { id, name, kind: 'file', modifiedAt, size: 1, permissions: [] } as unknown as FileEntry;
}

function folder(id: string): FileEntry {
  const row = { id, name: id, kind: 'folder', modifiedAt: '', size: 0, permissions: [] };
  return row as unknown as FileEntry;
}

/** Klasör kimliğinden sayfalara: gerçek uç yerine, testin kurduğu ağaç. */
function tree(pages: Record<string, Page[]>): { read: ReadFolder; reads: string[] } {
  const reads: string[] = [];
  const cursors = new Map<string, number>();
  const read: ReadFolder = (parentId, cursor) => {
    const key = parentId ?? 'root';
    reads.push(cursor === undefined ? key : `${key}@${cursor}`);
    const index = cursor === undefined ? 0 : (cursors.get(cursor) ?? 0);
    const page = pages[key]?.[index] ?? { items: [], hasMore: false };
    if (page.nextCursor !== undefined) cursors.set(page.nextCursor, index + 1);
    return Promise.resolve(page);
  };
  return { read, reads };
}

/**
 * Ağaç gezintisi.
 *
 * BU TESTİN VAR OLMA NEDENİ: §4'ün "Fotoğraflar" modülü depoda hiç yoktu, ve `GET /files` bir
 * `kind=image` süzgeci bilmiyor — zaman çizelgesi ancak ağacı gezerek kurulabiliyor. Gezinti
 * imleci takip etmezse 400 fotoğraflı bir klasörün ilk sayfasından ötesi hiç görünmez, bütçe
 * olmazsa da büyük bir NAS'ta tarayıcı ağacın dibinde kalır.
 */
describe('walkPhotos', () => {
  it('collects images from nested folders and leaves other files alone', async () => {
    const { read } = tree({
      root: [
        {
          items: [folder('a'), file('n', 'notlar.txt', '2026-03-01T00:00:00Z')],
          hasMore: false,
        },
      ],
      a: [{ items: [file('p', 'tatil.jpg', '2026-03-02T00:00:00Z')], hasMore: false }],
    });
    const found = await walkPhotos(read);
    expect(found.photos.map((photo) => photo.id)).toEqual(['p']);
    expect(found.truncated).toBe(false);
  });

  it('follows the cursor instead of stopping at the first page', async () => {
    const { read } = tree({
      root: [
        { items: [file('1', 'bir.jpg', '2026-03-01T00:00:00Z')], hasMore: true, nextCursor: 'c1' },
        { items: [file('2', 'iki.jpg', '2026-03-02T00:00:00Z')], hasMore: false },
      ],
    });
    const found = await walkPhotos(read);
    // Yeniden eskiye: ikinci sayfadaki daha yeni fotoğraf başa geçiyor.
    expect(found.photos.map((photo) => photo.id)).toEqual(['2', '1']);
    expect(found.truncated).toBe(false);
  });

  it('stops at the folder budget and says the list is cut short', async () => {
    const { read, reads } = tree({
      root: [{ items: [folder('a'), folder('b'), folder('c')], hasMore: false }],
      a: [{ items: [file('p', 'a.jpg', '2026-03-01T00:00:00Z')], hasMore: false }],
      b: [{ items: [file('q', 'b.jpg', '2026-03-02T00:00:00Z')], hasMore: false }],
      c: [{ items: [file('r', 'c.jpg', '2026-03-03T00:00:00Z')], hasMore: false }],
    });
    const found = await walkPhotos(read, { folders: 2, photos: 100 });
    expect(reads).toHaveLength(2);
    expect(found.truncated).toBe(true);
  });

  it('keeps what it read when a folder cannot be read, and admits the gap', async () => {
    const read: ReadFolder = (parentId) =>
      Promise.resolve(
        parentId === undefined
          ? { items: [folder('a'), file('p', 'var.jpg', '2026-03-01T00:00:00Z')], hasMore: false }
          : null,
      );
    const found = await walkPhotos(read);
    expect(found.photos.map((photo) => photo.id)).toEqual(['p']);
    expect(found.truncated).toBe(true);
  });
});

/**
 * Ay başlıkları.
 *
 * Ay sınırı YEREL takvimden okunuyor: UTC'ye göre gruplamak, ayın ilk gecesi çekilmiş bir
 * fotoğrafı bir önceki ayın altına yazardı.
 */
describe('byMonth', () => {
  it('groups by calendar month in the order the photos arrive', () => {
    const groups = byMonth([
      file('a', 'a.jpg', new Date(2026, 2, 20, 12).toISOString()),
      file('b', 'b.jpg', new Date(2026, 2, 2, 12).toISOString()),
      file('c', 'c.jpg', new Date(2026, 1, 27, 12).toISOString()),
    ]);
    expect(groups.map((group) => group.key)).toEqual(['2026-03', '2026-02']);
    expect(groups[0]?.items.map((photo) => photo.id)).toEqual(['a', 'b']);
  });

  it('does not drop a photo whose timestamp cannot be read', () => {
    const groups = byMonth([file('a', 'a.jpg', 'bir tarih değil')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe('Tarihi bilinmeyenler');
  });
});
