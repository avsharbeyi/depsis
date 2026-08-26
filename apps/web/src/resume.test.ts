import { describe, expect, it } from 'vitest';

import { fingerprint, MEMO_TTL_MS, parseMemos, prune, resumeOffset } from './resume.js';

/**
 * Devam ettirmenin karar veren kısmı.
 *
 * Burada ölçülen üç şeyin üçü de yanlış olduğunda dosya BOZULUYOR ya da var olmayan bir dosya
 * "yüklendi" görünüyor; ağ tarafı ise yalnız bu kararları taşıyor.
 */
describe('resume fingerprints', () => {
  const file = { name: 'rapor.pdf', size: 1024, lastModified: 1_700_000_000_000 };

  it('separates two different files that share a name, a size and a folder', () => {
    // BU TESTİN VAR OLMA NEDENİ. Ad ve boyut eşleşiyor diye devam etmek — bir belgeyi düzeltip
    // aynı adla yeniden göndermek gibi tamamen olağan bir durumda — iki dosyanın yarısını
    // birbirine dikerdi. `lastModified` bunu ayıran tek alan.
    const edited = { ...file, lastModified: file.lastModified + 1000 };
    expect(fingerprint(file, 'folder-1')).not.toBe(fingerprint(edited, 'folder-1'));
  });

  it('separates the same file in two folders, and the root from a folder', () => {
    expect(fingerprint(file, 'folder-1')).not.toBe(fingerprint(file, 'folder-2'));
    expect(fingerprint(file, undefined)).not.toBe(fingerprint(file, 'folder-1'));
  });

  it('cannot be collided by a name that contains the separator', () => {
    // Ayraç NUL: bir dosya adında bulunamaz (POSIX de izin vermiyor), yani bileşenler ad içine
    // ayraç yazarak kaydırılamıyor. Yine de ölçülüyor, çünkü ayracı bir gün değiştiren kişi bunu
    // görmeli.
    const sneaky = { ...file, name: `x\u0000${file.size}\u0000${file.lastModified}\u0000y` };
    expect(fingerprint(sneaky, 'a')).not.toBe(fingerprint(file, 'a'));
  });

  it('is stable for the same file', () => {
    expect(fingerprint(file, 'folder-1')).toBe(fingerprint({ ...file }, 'folder-1'));
  });
});

describe('the resume decision', () => {
  const SIZE = 5000;

  it('resumes from a partial offset', () => {
    expect(resumeOffset({ status: 200, offset: 2048, length: SIZE }, SIZE)).toBe(2048);
  });

  it('refuses a session whose bytes are complete but which may never have been published', () => {
    // `UploadsController.sendChunk` önce offset'i yazıyor, sonra yayımlıyor. Yayım 507 ya da 409
    // ile düşerse satır kalıcı olarak %100'de ve `completed_at IS NULL` kalıyor. Buna "devam"
    // etmek, tek bayt göndermeden "yüklendi" demek olurdu — dosya ortada yokken. Sıfırdan
    // başlamak, kötü ihtimalle dürüst bir 409 üretir.
    expect(resumeOffset({ status: 200, offset: SIZE, length: SIZE }, SIZE)).toBeNull();
  });

  it('refuses when the server knows a different length', () => {
    expect(resumeOffset({ status: 200, offset: 10, length: SIZE + 1 }, SIZE)).toBeNull();
    expect(resumeOffset({ status: 200, offset: 10, length: null }, SIZE)).toBeNull();
  });

  it('refuses anything that is not a 200, and any unreadable offset', () => {
    expect(resumeOffset({ status: 404, offset: 10, length: SIZE }, SIZE)).toBeNull();
    expect(resumeOffset({ status: 200, offset: null, length: SIZE }, SIZE)).toBeNull();
    expect(resumeOffset({ status: 200, offset: -1, length: SIZE }, SIZE)).toBeNull();
    expect(resumeOffset({ status: 200, offset: 1.5, length: SIZE }, SIZE)).toBeNull();
  });

  it('treats a zero offset as nothing to resume', () => {
    // Sıfırdan "devam" etmek sıfırdan başlamaktır. Çağıran not siliyor ve yeni bir oturum
    // açıyor; eskisi hiç bayt almadığı için bunun bir bedeli yok.
    expect(resumeOffset({ status: 200, offset: 0, length: SIZE }, SIZE)).toBeNull();
  });
});

describe('the memo store', () => {
  it('survives anything that is not its own shape', () => {
    expect(parseMemos(null)).toEqual({});
    expect(parseMemos('not json')).toEqual({});
    expect(parseMemos('[]')).toEqual({});
    expect(parseMemos('"a string"')).toEqual({});
    expect(parseMemos('{"k": 3}')).toEqual({});
    expect(parseMemos('{"k": {"location": "", "at": 1}}')).toEqual({});
    expect(parseMemos('{"k": {"location": "/uploads/1"}}')).toEqual({});
    expect(parseMemos('{"k": {"location": "/uploads/1", "at": "soon"}}')).toEqual({});
  });

  it('keeps a well-formed entry', () => {
    expect(parseMemos('{"k": {"location": "/uploads/1", "at": 5}}')).toEqual({
      k: { location: '/uploads/1', at: 5 },
    });
  });

  it('drops memos past the server’s own transfer window', () => {
    // Sunucunun listesiyle aynı pencere. Daha uzun tutmak, artık var olmayan bir oturuma HEAD
    // atıp 404 yemek ve kullanıcıya boşuna bir gidiş dönüş ödetmek demek.
    const now = 1_000_000_000;
    const memos = {
      taze: { location: '/uploads/a', at: now - 1000 },
      bayat: { location: '/uploads/b', at: now - MEMO_TTL_MS },
    };
    expect(Object.keys(prune(memos, now))).toEqual(['taze']);
  });
});
