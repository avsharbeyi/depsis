import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileUnreadable, uploadFile } from './Files.js';

/**
 * Yükleyicinin, dosyayı OKUYAMAMAK ile ağın KOPMASINI ayırması.
 *
 * ── SAHADAN ────────────────────────────────────────────────────────────────────────────────
 *
 * *"iOS'ta hâlâ dosya yüklerken hepsini yüklemiyor."* iOS, seçilen fotoğrafların geçici
 * kopyasını bir süre sonra bırakıyor; `fetch` gövdesi olarak verilen `File` o anda okunamıyor ve
 * tarayıcı bunu bir ağ hatası gibi bildiriyor ("Load failed"). Yükleyici bunu bir kopma sanıp
 * sunucuya "nerede kaldım" diye sorup üç kez daha deniyordu — üçü de aynı yerde düşüyor, ve
 * kullanıcıya söylenen şey ağdı. Ağ sağlamdı.
 *
 * Burada ölçülen: okunamayan bir dosya bir PATCH bile üretmiyor, kendi türüyle düşüyor, ve
 * düşerken ağ yeniden denemesine hiç girmiyor.
 */

/** `slice().arrayBuffer()` çağrısı reddeden bir dosya — iOS'un bıraktığı fotoğraf. */
function unreadable(name: string, size: number): File {
  const file = new File([new Uint8Array(size)], name, { type: 'image/jpeg' });
  Object.defineProperty(file, 'slice', {
    value: () => ({
      arrayBuffer: () => Promise.reject(new Error('The operation couldn’t be completed.')),
    }),
  });
  return file;
}

function stubFetch(): { calls: { url: string; method: string }[] } {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: input, method });
    if (method === 'POST') {
      return Promise.resolve(
        new Response(null, { status: 201, headers: { location: '/api/v1/uploads/u1' } }),
      );
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  // Bu tarayıcının kendi notu; testte boş.
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('telefonun artık okutmadığı bir dosya', () => {
  it('kendi türüyle düşüyor ve tek bir PATCH bile göndermiyor', async () => {
    const { calls } = stubFetch();
    const run = uploadFile(unreadable('IMG_0042.jpg', 3000), undefined, 's1');

    await expect(
      (async () => {
        for await (const _ of run) {
          // ilerleme yok; ilk parça okunamıyor
        }
      })(),
    ).rejects.toBeInstanceOf(FileUnreadable);

    // Oturum açıldı (POST), sonra okuma düştü: ağa hiçbir bayt gitmedi, ve "nerede kaldım"
    // sorusu (HEAD) da sorulmadı — sorulacak bir şey yok, dosya bizde okunmuyor.
    expect(calls.map((c) => c.method)).toEqual(['POST']);
  });

  it('cümlesi yeniden SEÇMEYİ söylüyor, yeniden denemeyi değil', () => {
    const error = new FileUnreadable('IMG_0042.jpg');
    expect(error.message).toContain('IMG_0042.jpg');
    expect(error.message).toContain('yeniden seç');
  });
});
