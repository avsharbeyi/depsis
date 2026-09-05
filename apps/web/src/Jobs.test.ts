import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { KIND } from './Jobs.js';

/** Kuyruğa iş koyan iki ağaç; tür sabitleri bunların içine dağılmış durumda. */
const TREES = ['../../api/src', '../../worker/src'];

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.isFile() && path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

/**
 * Kuyruğun gerçekten kaydettiği iş türleri: `... KIND = 'storage.backup.run'` biçimindeki
 * sabitler. Türü tek bir dosyadan okumak mümkün değil — `registry.ts` sabitleri on bir ayrı
 * modülden içeri alıyor.
 */
function registeredKinds(): string[] {
  const found = new Set<string>();
  for (const tree of TREES) {
    for (const file of sources(fileURLToPath(new URL(tree, import.meta.url)))) {
      for (const match of readFileSync(file, 'utf8').matchAll(/KIND\s*=\s*'([a-z][\w.-]*)'/g)) {
        const kind = match[1];
        if (kind !== undefined) found.add(kind);
      }
    }
  }
  return [...found].sort();
}

/**
 * Sistem işleri panosunun tür sözlüğü.
 *
 * BU TESTİN VAR OLMA NEDENİ: sözlükte üç satır varken kuyruk yirmi tür kaydediyordu. "200 dosya
 * kopyalanıyor, ilerlemesi Sistem işleri panosunda" denen kullanıcı panoda `files.copy ·
 * files.copy` okuyordu; havuz kurulumu `storage.pool.create`, gece yedeği `storage.backup.run`
 * olarak görünüyordu. Terminale hiç girmemesi beklenen bir cihaz sahibi için pano okunaksızdı.
 *
 * Test API ve worker kaynaklarını okuyor, çünkü asıl kusur unutmak: yeni bir tür eklendiği gün
 * buraya bir satır eklenmezse pano yine ham ad gösterir ve bunu kimse fark etmez.
 */
describe('Jobs KIND sözlüğü', () => {
  it('names every kind the queue can actually run', () => {
    const missing = registeredKinds().filter((kind) => KIND[kind] === undefined);
    expect(missing).toEqual([]);
  });

  it('found the kinds at all, so an empty scan cannot pass silently', () => {
    // Yol ya da desen bozulursa liste boşalır ve yukarıdaki test hiçbir şey ölçmeden geçerdi.
    expect(registeredKinds()).toContain('files.copy');
    expect(registeredKinds().length).toBeGreaterThan(15);
  });

  it('has no Turkish label for a kind the queue never registers', () => {
    // Ölü bir satır, sözlüğün kuyruğu anlattığı iddiasını zayıflatır.
    const kinds = new Set(registeredKinds());
    expect(Object.keys(KIND).filter((kind) => !kinds.has(kind))).toEqual([]);
  });
});
