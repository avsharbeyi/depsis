import { describe, expect, it } from 'vitest';

import { backupCandidatePools } from './BackupDisk.js';

/**
 * Yedek diskinin kurulabileceği havuzları seçen karar.
 *
 * Burası yanlış olduğunda ekran, tutamayacağı bir söz veriyor: paylaşımların durduğu havuzu
 * seçtirip "cihazın dışında bir kopyanız var" demek. Tek havuzlu bir kutuda bunun somut sonucu,
 * verinin aynı disklere ikinci kez yazılıp havuzun dolması.
 */
describe('backupCandidatePools', () => {
  it('drops the pool the shares live on', () => {
    expect(backupCandidatePools(['tank', 'yedek'], 'tank/depsis')).toEqual(['yedek']);
  });

  it('leaves a single-pool box with no candidate, which is what disables the button', () => {
    // BU TESTİN VAR OLMA NEDENİ. Liste boş kalmalı ki "Yedek diski kur" düğmesi kapalı kalsın;
    // dolu bir liste, sahibine ana havuzunu yedek havuzu olarak seçtirirdi.
    expect(backupCandidatePools(['tank'], 'tank/depsis')).toEqual([]);
  });

  it('compares by component, so tank2 survives next to tank', () => {
    // Metin öneki karşılaştırması `tank2`yi de elerdi — sahibinin elindeki tek geçerli yedek
    // havuzunu listeden silmek, freni koymaktan daha büyük bir arıza olurdu.
    expect(backupCandidatePools(['tank', 'tank2'], 'tank/depsis')).toEqual(['tank2']);
  });

  it('keeps every pool while the share tree is still unknown', () => {
    // Paylaşım ağacı henüz kurulmamışken elenecek bir havuz yok; reddeden fren ajanda.
    expect(backupCandidatePools(['tank', 'yedek'], undefined)).toEqual(['tank', 'yedek']);
    expect(backupCandidatePools(['tank'], '')).toEqual(['tank']);
  });

  it('handles a parent dataset that is the pool root itself', () => {
    expect(backupCandidatePools(['tank', 'yedek'], 'tank')).toEqual(['yedek']);
  });
});
