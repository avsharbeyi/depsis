import { afterEach, describe, expect, it, vi } from 'vitest';

import { couldHavePreview, DECODE_LIMIT, previewOf } from './thumbs.js';

/**
 * Karenin HANGİ YOLDAN geldiği.
 *
 * ── ÖLÇÜLEN ARIZA ─────────────────────────────────────────────────────────────────────────────
 *
 * Uç yalnız JPEG'in EXIF'ine gömülü küçük resmi veriyor, ve sahibinin telefondan gelen
 * fotoğraflarının hiçbirinde o yok: bir turda 244 tane 204, yani albümün tamamı boş çerçeve.
 * Eskiden 204 yolun sonuydu. Burada ölçülen şey, artık olmadığı: gömülü olan yoksa dosyanın
 * kendisi isteniyor ve kare tarayıcıda üretiliyor.
 *
 * Kod çözme bu ortamda yok (`document` yok), o yüzden üretilen kare `null` kalıyor — ama
 * İSTEKLERİN SIRASI tam olarak ölçülebilen şey, ve düzelen de o.
 */
function photo(over: Partial<{ id: string; name: string; size: number }> = {}): {
  id: string;
  name: string;
  size: number;
  modifiedAt: string;
} {
  return {
    id: over.id ?? 'e1',
    name: over.name ?? 'tatil.jpg',
    size: over.size ?? 800_000,
    modifiedAt: '2026-09-07T09:35:00.000Z',
  };
}

/** Çağrılan yolları sırasıyla toplayan bir `fetch`. */
function stubFetch(answers: Record<string, Response>): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal('fetch', (input: string) => {
    calls.push(input);
    for (const [needle, answer] of Object.entries(answers)) {
      if (input.includes(needle)) return Promise.resolve(answer);
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });
  // Düğüm ortamında yok; üretilen kare hiç kullanılmıyor, yalnız çağrılıyor.
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:stub' }));
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bir satırın karesi', () => {
  it('gömülü küçük resim varsa dosyanın kendisini İSTEMİYOR', async () => {
    const { calls } = stubFetch({
      '/thumbnail': new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200 }),
    });

    const found = await previewOf(photo(), new AbortController().signal);

    expect(found).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/thumbnail');
  });

  it('gömülü küçük resim yoksa (204) dosyanın kendisini istiyor', async () => {
    const { calls } = stubFetch({
      '/thumbnail': new Response(null, { status: 204 }),
      '/content': new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200 }),
    });

    await previewOf(photo(), new AbortController().signal);

    expect(calls.map((c) => c.split('/').pop())).toEqual(['thumbnail', 'content']);
  });

  it('ajan meşguldü (503) — yine dosyanın kendisine düşüyor', async () => {
    const { calls } = stubFetch({
      '/thumbnail': new Response(null, { status: 503 }),
      '/content': new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200 }),
    });

    await previewOf(photo(), new AbortController().signal);

    expect(calls).toHaveLength(2);
  });

  it('sınırın üstündeki bir dosyanın baytları İSTENMİYOR', async () => {
    // Kırk megapiksellik dosyalarla bir ızgarayı doldurmak, sekmenin belleğini tüketir.
    const { calls } = stubFetch({ '/thumbnail': new Response(null, { status: 204 }) });

    await previewOf(photo({ size: DECODE_LIMIT + 1 }), new AbortController().signal);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/thumbnail');
  });

  it('JPEG olmayan bir görüntüde gömülü olan hiç sorulmuyor', async () => {
    const { calls } = stubFetch({
      '/content': new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200 }),
    });

    await previewOf(photo({ name: 'ekran.png' }), new AbortController().signal);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/content');
  });

  it('iptal edilmiş bir istek ağa hiç çıkmıyor', async () => {
    const { calls } = stubFetch({});
    const stop = new AbortController();
    stop.abort();

    expect(await previewOf(photo(), stop.signal)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('hangi satır denemeye değer', () => {
  it('görüntü olmayanı elemiyor', () => {
    expect(couldHavePreview('rapor.pdf', 1000)).toBe(false);
    expect(couldHavePreview('notlar', 1000)).toBe(false);
  });

  it('JPEG her boyutta deneniyor, çünkü gömülü olanı büyüklükten bağımsız', () => {
    expect(couldHavePreview('kamera.JPG', DECODE_LIMIT * 10)).toBe(true);
  });

  it('gömülü taşımayan türlerde yalnız sınırın altındakiler', () => {
    expect(couldHavePreview('ekran.png', 1000)).toBe(true);
    expect(couldHavePreview('ekran.png', DECODE_LIMIT + 1)).toBe(false);
  });
});
