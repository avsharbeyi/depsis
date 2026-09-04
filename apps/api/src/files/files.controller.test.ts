import { describe, expect, it } from 'vitest';
import type { Permission } from '@depsis/authz';

import { servesInline, toPage } from './files.controller.js';
import type { FileEntryPage, FileEntryRow } from './files.service.js';

/**
 * Sayfayı sözleşmeye çeviren iki karar.
 *
 * İkisi de "ekran doğru görünüyor ama söylediği şey yanlış" ailesinden: biri kullanıcıya
 * kendisinden saklanan bir klasörün varlığını sayıyla söylüyor, öbürü bir PDF'i açmanın tek
 * yolunu diske indirmek yapıyordu.
 */

const ALL: ReadonlySet<Permission> = new Set<Permission>([
  'list',
  'read',
  'download',
  'create',
  'modify',
  'move',
  'delete',
]);

function row(id: string, kind: 'file' | 'folder', name: string): FileEntryRow {
  return {
    id,
    share_id: 'share-1',
    parent_id: null,
    kind,
    name,
    path: `paylasim/${name}`,
    size_bytes: '0',
    content_type: null,
    trashed_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  };
}

function page(items: FileEntryRow[]): FileEntryPage {
  return { items, nextCursor: null, hasMore: false, total: 3, folders: 2, files: 1 };
}

describe('toPage sayaçları', () => {
  it('hiçbir satır düşmediyse sunucunun sayılarını olduğu gibi taşır', () => {
    const rows = [row('f-1', 'folder', 'Belgeler'), row('f-2', 'folder', 'Maaşlar')];
    const permissions = new Map<string, ReadonlySet<Permission>>(
      rows.map((entry): [string, ReadonlySet<Permission>] => [entry.id, ALL]),
    );

    const result = toPage(page(rows), permissions);

    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(3);
    expect(result.folders).toBe(2);
    expect(result.files).toBe(1);
  });

  it('bir satır bile gizlendiyse sayaçların ÜÇÜNÜ DE hiç göndermez', () => {
    // BU TESTİN VAR OLMA NEDENİ. COUNT sorgusu izne bakmıyor: 'Maaşlar' listeden çıkıyor ama
    // sayaçta kalıyordu, ve "2 klasör" yazan bir alt bilgi tek satırlık bir listenin altında
    // duruyordu — yani kullanıcı görmediği klasörün var olduğunu sayıdan öğreniyordu.
    const rows = [row('f-1', 'folder', 'Belgeler'), row('f-2', 'folder', 'Maaşlar')];
    const permissions = new Map<string, ReadonlySet<Permission>>([['f-1', ALL]]);

    const result = toPage(page(rows), permissions);

    expect(result.items.map((item) => item.name)).toEqual(['Belgeler']);
    expect('total' in result).toBe(false);
    expect('folders' in result).toBe(false);
    expect('files' in result).toBe(false);
    // Sayfalama gizlemeden etkilenmiyor: imleç klasörün içindeki ilerlemeyi anlatıyor.
    expect(result.hasMore).toBe(false);
  });
});

describe('içeriğin satır içi sunulması', () => {
  it('yalnız .pdf uzantısında ve yalnız bayrak açıkken', () => {
    expect(servesInline('sözleşme.pdf', '1')).toBe(true);
    expect(servesInline('SÖZLEŞME.PDF', '1')).toBe(true);
    expect(servesInline('sözleşme.pdf', undefined)).toBe(false);
    expect(servesInline('sözleşme.pdf', '0')).toBe(false);
  });

  it('adı .pdf ile bitmeyen hiçbir şeyi açmaz', () => {
    // Asıl kural bu: kiracının yüklediği bir HTML dosyası API'nin kendi kökeninde belge olarak
    // açılırsa, her oturuma karşı depolanmış XSS olur.
    expect(servesInline('sayfa.html', '1')).toBe(false);
    expect(servesInline('rapor.pdf.html', '1')).toBe(false);
    expect(servesInline('resim.svg', '1')).toBe(false);
  });
});
