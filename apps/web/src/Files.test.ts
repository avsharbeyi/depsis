import type { OpenApi } from '@depsis/contracts';
import { describe, expect, it } from 'vitest';

import {
  conflict,
  foldName,
  folderBody,
  merged,
  nextSelection,
  pathSegments,
  previewAs,
  uploadMetadata,
  uploadsOf,
} from './Files.js';

type FileEntry = OpenApi.components['schemas']['FileEntry'];

/**
 * Dosya yöneticisinin ekrandan bakınca doğru görünen kararları.
 *
 * Dördü de aynı aileden: hepsinde ekran "oldu" diyor ve olmuyor. Bir klasör başka bir paylaşımda
 * açılıyor, bir dosya başka bir paylaşıma iniyor, bir klasörün yarısı hiç görünmüyor, ve bir ad
 * çakışması "yüklendi" diye rapor ediliyor. Hiçbiri kullanıcıya kendini göstermiyor — o yüzden
 * ölçülmeleri gereken yer burası.
 */

/** Satır kurmanın kısası: bu testlerin baktığı tek şey `kind` ve `name`. */
function entry(kind: FileEntry['kind'], name: string): FileEntry {
  return { id: `${kind}-${name}`, kind, name } as FileEntry;
}

describe('hangi paylaşımda klasör açılıyor', () => {
  it('kökte seçili paylaşımı taşır', () => {
    // BU TESTİN VAR OLMA NEDENİ. `shareId` düşünce sunucu kiracının VARSAYILAN paylaşımını
    // seçiyor: "Arşiv" seçiliyken açılan klasör başka bir paylaşımda açılıyor, ekran
    // "oluşturuldu" diyor ve klasör listede hiç görünmüyordu.
    expect(folderBody('Faturalar', undefined, 'share-arsiv')).toEqual({
      name: 'Faturalar',
      shareId: 'share-arsiv',
    });
  });

  it('bir üst klasör varken paylaşımı SORMUYOR', () => {
    // Paylaşımı üst klasör belirliyor ve sözleşme aynı soruya iki cevabı kabul etmiyor.
    expect(folderBody('Faturalar', 'parent-1', 'share-arsiv')).toEqual({
      name: 'Faturalar',
      parentId: 'parent-1',
    });
  });

  it('paylaşım seçilmemişken kökte yalnız adı gönderir', () => {
    expect(folderBody('Faturalar', undefined, undefined)).toEqual({ name: 'Faturalar' });
  });
});

describe('yükleme oturumunun hedefi', () => {
  const decode = (metadata: string): Map<string, string> =>
    new Map(
      metadata.split(',').map((pair): [string, string] => {
        const space = pair.indexOf(' ');
        return [
          pair.slice(0, space),
          Buffer.from(pair.slice(space + 1), 'base64').toString('utf8'),
        ];
      }),
    );

  it('köke yüklemede seçili paylaşımı taşır', () => {
    // Sunucunun paylaşımı öğrenebileceği tek kanal bu başlık. Onsuz dosyanın bütün baytları
    // varsayılan paylaşıma iniyor ve kullanıcı yüklediği dosyayı açık listede bulamıyor.
    const fields = decode(uploadMetadata('sunum.pptx', undefined, 'share-arsiv'));
    expect(fields.get('filename')).toBe('sunum.pptx');
    expect(fields.get('shareId')).toBe('share-arsiv');
    expect(fields.has('parentId')).toBe(false);
  });

  it('bir klasöre yüklemede paylaşımı göndermez', () => {
    const fields = decode(uploadMetadata('sunum.pptx', 'parent-1', 'share-arsiv'));
    expect(fields.get('parentId')).toBe('parent-1');
    expect(fields.has('shareId')).toBe(false);
  });

  it('Türkçe bir adı base64 ile taşır', () => {
    // `btoa` Latin-1 dışını kabul etmiyor; kodlama bozulursa dosya adı ağa hiç çıkamıyor.
    expect(decode(uploadMetadata('şantiye raporu.pdf', undefined, undefined)).get('filename')).toBe(
      'şantiye raporu.pdf',
    );
  });
});

describe('yükleme sırasındaki 409', () => {
  it('ad çakışmasını, yanıtta bir Upload-Offset dursa bile çakışma sayar', () => {
    // BU TESTİN VAR OLMA NEDENİ. Sunucu son PATCH'te `Upload-Offset`i yazdıktan SONRA yayımı
    // deniyor, yani ad çakışması 409'unun üzerinde dosyanın tam boyutu duruyor. Hizalama dalı
    // önce baktığı sürece döngü "bitti" sayılıyor, kullanıcıya hiç sorulmuyor ve ekran
    // "yüklendi" diyordu.
    expect(conflict('name-taken', '1048576')).toEqual({ kind: 'name-taken' });
  });

  it('gerçek bir hizasızlıkta sunucunun söylediği yerden devam eder', () => {
    expect(conflict('offset-mismatch', '4096')).toEqual({ kind: 'realign', offset: 4096 });
  });

  it('başlık yokken sıfırdan başlamaz', () => {
    // `Number(null ?? '')` sıfır: başlıksız bir 409'u hizalama sayan bir dal, yüklemeyi baştan
    // başlatıp aynı 409'a yeniden düşerdi.
    expect(conflict(null, null)).toEqual({ kind: 'other' });
    expect(conflict(null, 'bilinmeyen')).toEqual({ kind: 'other' });
  });
});

describe('sayfanın devamı listeye eklenirken', () => {
  const page1 = [entry('file', 'ada.txt'), entry('file', 'zeynep.txt')];
  const page2 = [entry('file', 'ömer.txt'), entry('folder', 'Belgeler')];

  it('sonraki sayfada gelen klasörü listenin başına alır', () => {
    // BU TESTİN VAR OLMA NEDENİ. Sunucu `kind`i ARTAN sıralıyor (`file` < `folder`), yani
    // klasörler en son sayfada geliyor. Yalnız yeni sayfa sıralansaydı klasör iki yüz dosyanın
    // ORTASINDA kalırdı; oysa tek sayfaya sığan bir klasörde ekran önce klasörleri gösteriyor.
    const rows = merged(page1, page2, 'name');
    expect(rows.map((row) => row.name)).toEqual(['Belgeler', 'ada.txt', 'ömer.txt', 'zeynep.txt']);
  });

  it('ada göre olmayan bir sıralamada sunucunun sırasını olduğu gibi bırakır', () => {
    // Boyuta göre dizilmiş bir listeyi yeniden dizmek, ekran "en büyük önce" derken alfabetik
    // bir liste göstermek olurdu.
    const rows = merged(page1, page2, 'size');
    expect(rows.map((row) => row.name)).toEqual(['ada.txt', 'zeynep.txt', 'ömer.txt', 'Belgeler']);
  });

  it('ilk sayfayı yerinde değiştirmez', () => {
    const before = [...page1];
    merged(page1, page2, 'name');
    expect(page1).toEqual(before);
  });
});

describe('var olan klasörü ararken ad karşılaştırması', () => {
  it('sunucunun katladığı adları aynı sayar', () => {
    // BU TESTİN VAR OLMA NEDENİ. Sunucu ad tekliğini `fold_identity` ile soruyor: 'FOTOĞRAFLAR'
    // varken 'fotoğraflar' 409 alıyor. İstemci birebir karşılaştırdığı sürece 409'dan sonra o
    // klasörü bulamıyor ve klasördeki ÜÇ YÜZ fotoğrafın her biri "klasör kurulamadı" ile düşüyordu.
    expect(foldName('FOTOĞRAFLAR')).toBe(foldName('fotoğraflar'));
    expect(foldName('İSTANBUL')).toBe(foldName('istanbul'));
    expect(foldName('ISPARTA')).toBe(foldName('ısparta'));
  });

  it('aksanı OLAN ve OLMAYAN adı ayrı tutar', () => {
    // `fold_identity` arama normalleştirmesi değil: 'Çağrı' ile 'Cagri' sunucuda iki ayrı ad, ve
    // burada da öyle olmalı — yoksa istemci var olmayan bir klasörü benimsemeye çalışırdı.
    expect(foldName('Çağrı')).not.toBe(foldName('Cagri'));
  });
});

describe('yükleme işlerinin yolu', () => {
  it('klasör seçicisinden gelen dosyanın üstündeki klasörleri çıkarır', () => {
    expect(pathSegments('Tatil 2025/Deniz/kum.jpg')).toEqual(['Tatil 2025', 'Deniz']);
    expect(pathSegments('kum.jpg')).toEqual([]);
  });

  it('düz dosya seçiminde hiçbir klasör açtırmaz', () => {
    const file = { name: 'kum.jpg', webkitRelativePath: 'Tatil 2025/kum.jpg' } as unknown as File;
    expect(uploadsOf([file], false)).toEqual([{ file, segments: [] }]);
    expect(uploadsOf([file], true)).toEqual([{ file, segments: ['Tatil 2025'] }]);
  });
});

describe('hangi dosya önizlenebiliyor', () => {
  it('§5.1in istediği türleri tanır', () => {
    expect(previewAs(entry('file', 'tatil.jpg'))).toBe('image');
    expect(previewAs(entry('file', 'tatil.mp4'))).toBe('video');
    // BU ÜÇÜ EKSİKTİ: bir sözleşmeye bakmak için onu diske indirmek gerekiyordu.
    expect(previewAs(entry('file', 'savunma_v3.pdf'))).toBe('pdf');
    expect(previewAs(entry('file', 'notlar.txt'))).toBe('text');
    expect(previewAs(entry('file', 'kayit.mp3'))).toBe('audio');
  });

  it('klasörü, bilinmeyeni ve SVGyi önizlemez', () => {
    // SVG betik taşıyabilen bir belge; onu oturumun kökeninde çizmek bu ekranın işi değil.
    expect(previewAs(entry('folder', 'Belgeler'))).toBeNull();
    expect(previewAs(entry('file', 'kurulum.bin'))).toBeNull();
    expect(previewAs(entry('file', 'logo.svg'))).toBeNull();
  });
});

describe('çoklu seçim', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];

  it('düz tıklama tek satırı ekler ve çıkarır', () => {
    const once = nextSelection(ids, new Set(), 'b', null, { range: false, add: false });
    expect([...once]).toEqual(['b']);
    expect([...nextSelection(ids, once, 'b', 'b', { range: false, add: false })]).toEqual([]);
  });

  it('Shift ile çapadan tıklanana kadarki aralığı seçer', () => {
    // BU TESTİN VAR OLMA NEDENİ. Üç yüz fotoğraflı bir klasörü taşımak, aralık seçimi olmadan
    // üç yüz ayrı tıklama demekti.
    const span = nextSelection(ids, new Set(['b']), 'd', 'b', { range: true, add: false });
    expect([...span]).toEqual(['b', 'c', 'd']);
  });

  it('aralığı yukarı doğru da kurar', () => {
    const span = nextSelection(ids, new Set(['d']), 'b', 'd', { range: true, add: false });
    expect([...span].sort()).toEqual(['b', 'c', 'd']);
  });

  it('yalnız Shift eski seçimin yerine geçer, Ctrl+Shift onu korur', () => {
    const replaced = nextSelection(ids, new Set(['a']), 'c', 'b', { range: true, add: false });
    expect([...replaced].sort()).toEqual(['b', 'c']);
    const added = nextSelection(ids, new Set(['a']), 'c', 'b', { range: true, add: true });
    expect([...added].sort()).toEqual(['a', 'b', 'c']);
  });

  it('çapa listede yoksa aralık isteğini tekile düşürür', () => {
    // Klasör değişmiş ya da satır silinmiş olabilir; olmayan bir çapadan başlayan aralık,
    // kullanıcının hiç görmediği satırları seçmek olurdu.
    const only = nextSelection(ids, new Set(), 'c', 'silinmiş', { range: true, add: false });
    expect([...only]).toEqual(['c']);
  });
});
