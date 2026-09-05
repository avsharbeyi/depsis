import { describe, expect, it } from 'vitest';

import { pickQuery } from './ui.js';

/**
 * Taşı/Kopyala klasör seçicisinin listeleme sorgusu.
 *
 * BU TESTİN VAR OLMA NEDENİ eksik `shareId`. Seçici sorguyu paylaşımsız gönderiyordu; `shareId`
 * yokken sunucu kiracının VARSAYILAN paylaşımını seçiyor, yani "Arşiv"deki bir dosyayı taşımak
 * isteyen kullanıcıya hep varsayılan paylaşımın klasörleri gösteriliyordu. Seçtiği hedef başka bir
 * paylaşımda olduğu için taşıma reddediliyor, Arşiv'in kendi alt klasörleri listede hiç
 * görünmediği için de Arşiv içinde taşımanın tek yolu sürükle-bırak kalıyordu.
 */
describe('pickQuery', () => {
  it('carries the selected share into the ROOT listing', () => {
    expect(pickQuery(undefined, 'share-arsiv')).toEqual({ shareId: 'share-arsiv', limit: 200 });
  });

  it('carries it into a subfolder listing too', () => {
    // Uç, satırın paylaşımıyla istenen paylaşımı karşılaştırıyor; seçici doğru ağaçta gezdiği
    // sürece ikisi aynı, ve göndermek listenin hangi paylaşımdan geldiğini belirsiz bırakmıyor.
    expect(pickQuery('folder-1', 'share-arsiv')).toEqual({
      parentId: 'folder-1',
      shareId: 'share-arsiv',
      limit: 200,
    });
  });

  it('omits the field entirely when no share is selected', () => {
    // Tek paylaşımlı kutuda seçici hiç görünmüyor; boş bir `shareId` göndermek uca geçersiz bir
    // kimlik yollamak olurdu.
    expect(pickQuery(undefined, undefined)).toEqual({ limit: 200 });
    expect(pickQuery('folder-1', undefined)).toEqual({ parentId: 'folder-1', limit: 200 });
  });
});
