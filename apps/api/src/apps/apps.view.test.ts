import { describe, expect, it } from 'vitest';

import type { AppView, CatalogueRow } from './apps.service.js';

/**
 * Yanıt gövdesinin kendi biçimi — `toApp` saf bir dönüştürücü, veritabanı gerektirmiyor.
 *
 * NEDEN BİR TEST GEREKİYOR. `custom` alanı katalog satırında vardı, sözleşmede vardı, arayüz de
 * onu okuyordu; yalnız `toApp` onu kopyalamıyordu. Sonuç: özel uygulama sıradan bir katalog satırı
 * gibi görünüyor, "Özel" rozeti ve yöneticiye özel "Sil" düğmesi hiç çizilmiyor, yanlış eklenmiş
 * bir özel uygulama arayüzden kaldırılamıyordu. Alanın DÜŞMESİ ne tipe ne sözleşme kapısına
 * yansıyor — opsiyonel bir alanı yazmamak da geçerli bir gövde.
 */
describe('toApp', () => {
  it('carries the custom flag through to the response', async () => {
    const { toApp } = await import('./apps.controller.js');
    const app = toApp(view({ custom: true }));

    expect(app.catalogue.custom).toBe(true);
  });

  it('omits the flag entirely for a curated catalogue row', async () => {
    const { toApp } = await import('./apps.controller.js');
    const app = toApp(view({}));

    // `custom: false` DEĞİL, alanın hiç bulunmaması: sözleşme onu opsiyonel tanımlıyor ve arayüz
    // yalnız `=== true` dalını çiziyor.
    expect('custom' in app.catalogue).toBe(false);
  });
});

function view(extra: Partial<CatalogueRow>): AppView {
  const catalogue: CatalogueRow = {
    id: '11111111-1111-4111-8111-111111111111',
    slug: 'nginx',
    name: 'Nginx',
    summary: 'Bir web sunucusu.',
    icon: 'globe',
    container_port: 80,
    ...extra,
  };
  return {
    catalogue,
    containers: [
      {
        catalogue_id: catalogue.id,
        role: 'app',
        ordinal: 0,
        is_primary: true,
        image: 'docker.io/library/nginx',
        tag: 'stable',
        env: {},
        mounts: [],
        volumes: [],
        shm_bytes: null,
      },
    ],
    instance: null,
    state: null,
  };
}
