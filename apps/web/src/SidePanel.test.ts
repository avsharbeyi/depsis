import { describe, expect, it } from 'vitest';

import { sambaAddress } from './SidePanel.js';

/**
 * Masaüstündeki Samba satırının adresi.
 *
 * BU TESTİN VAR OLMA NEDENİ: adres bir zamanlar `\\depsis` diye sabit yazılıydı. Ana makine adı
 * kurulumda verilebiliyor (`--hostname ofis-nas`), ve öyle kurulmuş bir kutuda o satır Gezgin'de
 * hiçbir yere çözülmeyen bir adres gösteriyordu. Kopyalanmak için konmuş bir adresin yanlış
 * olması, satırın hiç olmamasından kötü.
 */
describe('sambaAddress', () => {
  it('takes the host the appliance actually announces itself as', () => {
    expect(sambaAddress(['\\\\ofis-nas\\belgeler'])).toBe('\\\\ofis-nas');
  });

  it('draws nothing rather than inventing a host name', () => {
    // Hiç paylaşım yoksa (ya da liste okunamadıysa) uydurulacak bir ad yok; `null`, satırın
    // çizilmemesi demek.
    expect(sambaAddress([])).toBeNull();
    expect(sambaAddress(['belgeler'])).toBeNull();
    expect(sambaAddress(['\\\\'])).toBeNull();
  });

  it('skips a malformed path and uses the first usable one', () => {
    expect(sambaAddress(['', '\\\\depsis\\ev'])).toBe('\\\\depsis');
  });

  it('keeps the host when the path carries no share after it', () => {
    expect(sambaAddress(['\\\\depsis'])).toBe('\\\\depsis');
  });
});
