import { describe, expect, it } from 'vitest';

import { deviceNameFrom } from './device-name.js';

describe('okunan cihaz adı', () => {
  it('Android telefonu MODELİYLE söylüyor', () => {
    // Bir evde üç Android telefon olabilir. Üçü de yalnız "Android" yazsaydı liste hiçbir şey
    // söylemezdi, ve bu sütunun var olma sebebi tam olarak satırı ayırt edilebilir yapmak.
    expect(
      deviceNameFrom(
        'Mozilla/5.0 (Linux; Android 14; SM-S926B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe('Android · SM-S926B');
  });

  it('modelin peşindeki Build ekini atıyor', () => {
    expect(
      deviceNameFrom('Mozilla/5.0 (Linux; Android 12; Pixel 6 Build/SQ3A.220705.003) Mobile'),
    ).toBe('Android · Pixel 6');
  });

  it('model yerine geçen kalıpları model saymıyor', () => {
    // Chrome'un gizlilik için gönderdiği `K`, ve WebView'ın `wv`si. İkisi de bir cihaz adı değil,
    // ve "Android · K" diye bir satır bilgi vermek yerine soru sordururdu.
    expect(deviceNameFrom('Mozilla/5.0 (Linux; Android 13; K) AppleWebKit/537.36')).toBe('Android');
    expect(deviceNameFrom('Mozilla/5.0 (Linux; Android 11; wv) AppleWebKit/537.36')).toBe(
      'Android',
    );
  });

  it('daha ÖZEL olanı önce soruyor', () => {
    // Android'in kullanıcı aracısı `Linux` da içeriyor. Genel kural önce sorulsaydı her telefon
    // "Linux PC" olurdu — ve bu, yanlış bir cevabın doğru görünmesinin klasik yolu.
    expect(deviceNameFrom('Mozilla/5.0 (Linux; Android 14; SM-A536B) Mobile')).toContain('Android');
    expect(deviceNameFrom('Mozilla/5.0 (X11; Linux x86_64) Firefox/128.0')).toBe('Linux PC');
  });

  it('masaüstlerini sürüm numarası olmadan söylüyor', () => {
    // "Windows PC" bir insanın listede aradığı şey; "Windows NT 10.0; Win64; x64" değil.
    expect(deviceNameFrom('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0')).toBe(
      'Windows PC',
    );
    expect(deviceNameFrom('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1')).toBe(
      'Mac',
    );
    expect(deviceNameFrom('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/126.0')).toBe(
      'Chromebook',
    );
  });

  it('Apple’ın telefonunu ve tabletini ayırıyor', () => {
    expect(deviceNameFrom('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari')).toBe(
      'iPhone',
    );
    expect(deviceNameFrom('Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) Safari')).toBe('iPad');
  });

  it('okuyamadığında null diyor, boş metin değil', () => {
    // "Bilmiyoruz" ile "adı yok" farklı iki şey. Bilinmeyen bir değer, bilinen bir değerin üstüne
    // yazılmamalı — ve ikisi aynı tipte olsaydı çağıran ayırt edemezdi.
    expect(deviceNameFrom(null)).toBeNull();
    expect(deviceNameFrom(undefined)).toBeNull();
    expect(deviceNameFrom('   ')).toBeNull();
    expect(deviceNameFrom('curl/8.4.0')).toBeNull();
  });
});
