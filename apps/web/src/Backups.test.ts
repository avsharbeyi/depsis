import { describe, expect, it } from 'vitest';

import { suggestedDatasets } from './Backups.js';

/**
 * "Yedek al" formunun veri kümesi önerileri.
 *
 * BU TESTİN VAR OLMA NEDENİ hiç yedeği olmayan kutu. Liste eskiden yalnız zaten yedeği olan veri
 * kümelerinden besleniyordu — yani ilk yedeğini almaya çalışan kişiye bomboş açılıyordu. Ham bir
 * ZFS adı yazdıran bir form, adı bilmeyen sahibi terminale iter.
 */
describe('suggestedDatasets', () => {
  it('suggests the shares even when nothing has ever been backed up', () => {
    expect(suggestedDatasets(['tank/depsis/ev'], [])).toEqual(['tank/depsis/ev']);
  });

  it('keeps a dataset whose share is gone but whose backups are not', () => {
    const merged = suggestedDatasets(['tank/depsis/ev'], [{ dataset: 'tank/depsis/eski' }]);
    expect(merged).toEqual(['tank/depsis/eski', 'tank/depsis/ev']);
  });

  it('lists a dataset once when it is both a share and a backup', () => {
    // Aynı adın iki kez çıktığı bir öneri listesi, kullanıcıya ikisinin farklı olduğunu düşündürür.
    expect(suggestedDatasets(['tank/depsis/ev'], [{ dataset: 'tank/depsis/ev' }])).toEqual([
      'tank/depsis/ev',
    ]);
  });

  it('drops empty names instead of offering a blank row', () => {
    expect(suggestedDatasets([''], [{ dataset: '' }])).toEqual([]);
  });
});
