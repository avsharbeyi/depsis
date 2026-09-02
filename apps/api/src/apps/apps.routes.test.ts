import { describe, expect, it } from 'vitest';

/**
 * Rota bildirim sırası — Nest'in kaydettiği sıra.
 *
 * VERİTABANI GEREKTİRMİYOR ve gerektirmemeli: ölçülen şey sınıfın kendi biçimi. Nest rotaları
 * prototipteki bildirim sırasıyla kaydediyor, ve `:slug` gibi parametreli bir yol kendinden
 * SONRA gelen her sabit yolu yutuyor.
 *
 * NEDEN BİR TEST GEREKİYOR. `POST /apps/custom` aylarca `install`a düşüyordu: `slug` 'custom'
 * oluyor, gövde `installSchema`ya uymuyor, 400 dönüyordu. Ekrandaki "Özel uygulama ekle" formu
 * hiç çalışmamıştı, ve hiçbir tip denetimi, hiçbir sözleşme kapısı bunu göremezdi — iki
 * dekoratörün sırası ne tipe ne sözleşmeye yansıyor.
 */
describe('route declaration order', () => {
  it('declares every fixed path before the wildcard that would swallow it', async () => {
    const { AppsController } = await import('./apps.controller.js');
    // `getOwnPropertyNames` prototipteki metotları TANIMLANMA SIRASIYLA veriyor, ve Nest'in
    // kaydettiği sıra da o.
    const order = Object.getOwnPropertyNames(AppsController.prototype);

    // `POST /apps/custom` — `POST /apps/:slug`in üstünde olmalı.
    expect(order.indexOf('addCustom')).toBeGreaterThan(-1);
    expect(order.indexOf('install')).toBeGreaterThan(-1);
    expect(order.indexOf('addCustom')).toBeLessThan(order.indexOf('install'));

    // `DELETE /apps/custom/:slug` — bu hep doğru sıradaydı, ve burada durması bir kontrol:
    // test kırıldığında hangisinin bozulduğunu söylüyor.
    expect(order.indexOf('removeCustom')).toBeLessThan(order.indexOf('remove'));
  });
});
