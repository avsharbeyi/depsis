import type { Locator, Page } from '@playwright/test';

import { expect, openPane, signIn, test } from './fixtures.js';

/**
 * Gömülü küçük resimler — uçtan uca.
 *
 * `exif-thumbnail.test.ts` ayrıştırıcıyı ölçüyor: sınırlar, bozuk girdiler, hiç atmama. Buradan
 * görünen ve oradan görünmeyen şey, ZİNCİRİN TAMAMI — yüklenen bayt, ajanın veri kanalından geri
 * okunan ilk 128 kB, çıkarılan JPEG, ve satırın solundaki karede beliren görüntü. Aradaki her
 * halka doğru çalışıp da kare simge olarak kalsaydı, ürün açısından küçük resim diye bir şey
 * olmazdı.
 *
 * İkinci soru da en az o kadar önemli: küçük resmi OLMAYAN bir dosya tarayıcı konsoluna bir hata
 * yazmıyor. Sunucu 204 dönüyor ve istemci `fetch` kullanıyor tam bunun için — bir klasördeki
 * seksen ekran görüntüsü, seksen kırmızı satır demek olurdu.
 */

/**
 * EXIF'ine GERÇEK bir 1×1 JPEG gömülmüş, 230 baytlık bir JPEG.
 *
 * Elle kurulmuş, çünkü ölçülen şey zincirin kendisi ve bir örnek fotoğraf onu ancak tek bir
 * noktada yoklardı. Yönlendirme etiketi 6 (90°): sunucunun onu başlıkta taşıdığını ve istemcinin
 * bir CSS dönüşümüne çevirdiğini de bu dosya gösteriyor.
 *
 * Gömülü olan gerçekten çözülebilir bir JPEG — bozuk baytlar olsaydı `<img>` çözemez ve konsola
 * hata yazardı, yani testin sessizlik iddiası kendi kurgusuyla çökerdi.
 */
const JPEG_WITH_THUMBNAIL =
  '/9j/4QDgRXhpZgAASUkqAAgAAAABABIBAwABAAAABgAAABoAAAACAAECBAABAAAAOAAAAAICBAAB' +
  'AAAAoAAAAAAAAAD/2P/gABBKRklGAAEBAQBgAGAAAP/bAEMACAYGBwYFCAcHBwkJCAoMFA0MCwsM' +
  'GRITDxQdGh8eHRocHCAkLicgIiwjHBwoNyksMDE0NDQfJzk9ODI8LjM0Mv/AAAsIAAEAAQEBEQD/' +
  'xAAUAAEAAAAAAAAAAAAAAAAAAAAJ/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAAPwAqn//Z/9k=';

function unique(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Dosyalar panelini aç ve YÜKLENMESİNİ bekle.
 *
 * `openPane` pencerenin belirmesini bekliyor, listenin gelmesini değil — ve boş bir panelde
 * "⤒ Yükle" düğmesi henüz yok. `files.spec.ts` aynı sebeple aynı üç beklemeyi yapıyor.
 */
async function dosyalariAc(page: Page): Promise<Locator> {
  const pane = await openPane(page, 'Dosyalar');
  await expect(pane.getByText('Yükleniyor…')).toHaveCount(0);
  await expect(pane.locator('.ffoot .val')).toHaveText(/\d+\+? (öğe|sonuç)/);
  return pane;
}

/**
 * Bir dosyayı seçiciden yükle; sunucunun cevabını döndür.
 *
 * Cevap ÇAĞIRANA dönüyor, çünkü ajansız bir yığında 503 geliyor ve o dalda ölçülecek bir küçük
 * resim yok — testin kendini orada kapatması, atlanmış saymaktan dürüst.
 */
async function yukle(pane: Locator, name: string, bytes: Buffer): Promise<number> {
  const cevap = pane
    .page()
    .waitForResponse((r) => r.url().endsWith('/api/v1/uploads') && r.request().method() === 'POST');
  const secici = pane.page().waitForEvent('filechooser');
  await pane.getByRole('button', { name: '⤒ Yükle' }).click();
  await pane.getByRole('button', { name: /Dosya yükle/ }).click();
  await (await secici).setFiles({ name, mimeType: 'image/jpeg', buffer: bytes });
  return (await cevap).status();
}

/** `files.spec.ts`'in kullandığı düğmelerin aynısı: uydurulmuş bir ad, asılıp kalan bir test. */
async function sil(pane: Locator, name: string): Promise<void> {
  const row = pane.locator('.frow').filter({ hasText: name });
  if ((await row.count()) === 0) return;
  await row.getByRole('button', { name: `${name} çöpe at` }).click();
  await pane
    .getByRole('alertdialog', { name: 'Çöp kutusuna taşı' })
    .getByRole('button', { name: 'Çöpe at' })
    .click();
  await expect(row).toHaveCount(0);
}

test('gömülü küçük resmi olan bir fotoğraf, satırın karesinde görünüyor', async ({
  page,
  consoleWatch,
}) => {
  consoleWatch.tolerate(
    /401 \(Unauthorized\)/,
    'Oturum açılmadan önce /me sorulur ve 401 döner; tarayıcı her 4xx yanıtı konsola yazar.',
  );
  // Ajansız bir yığında yükleme 503 veriyor; o durumda test kendini kapatıyor (aşağıda), ama
  // konsol satırı yine de doğuyor.
  consoleWatch.tolerate(
    /503 \(Service Unavailable\)/,
    'Ajansız bir yığında bayt taşıyan her uç 503 veriyor; test o dalda kendini kapatıyor.',
  );

  await signIn(page);
  const pane = await dosyalariAc(page);

  const name = `${unique('e2e-kucukresim')}.jpg`;
  const durum = await yukle(pane, name, Buffer.from(JPEG_WITH_THUMBNAIL, 'base64'));

  // Ajansız yığında bayt taşınamıyor ve satır hiç doğmuyor. Atlamak yerine burada bitiyor:
  // ölçülecek bir şey yok, ve bunu söylemek "geçti" demekten dürüst.
  if (durum === 503) {
    await expect(page.locator('.toasts .toast')).toBeVisible();
    return;
  }

  const row = pane.locator('.frow').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 20_000 });

  // ZİNCİRİN TAMAMI: kare artık bir simge değil, bir görüntü taşıyor.
  const image = row.locator('.g.thumb img');
  await expect(image).toBeVisible();
  // Ve gerçekten ÇÖZÜLDÜ — bozuk bir görüntü de DOM'da durur, ama genişliği sıfır olur.
  expect(await image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  // Yönlendirme 6 = 90°, sunucudan başlıkla geldi ve bir CSS dönüşümüne çevrildi.
  await expect(image).toHaveCSS('transform', /matrix/);

  await sil(pane, name);
});

test('küçük resmi olmayan bir dosya konsola hiçbir şey yazmıyor', async ({
  page,
  consoleWatch,
}) => {
  consoleWatch.tolerate(
    /401 \(Unauthorized\)/,
    'Oturum açılmadan önce /me sorulur ve 401 döner; tarayıcı her 4xx yanıtı konsola yazar.',
  );
  consoleWatch.tolerate(
    /503 \(Service Unavailable\)/,
    'Ajansız bir yığında bayt taşıyan her uç 503 veriyor; test o dalda kendini kapatıyor.',
  );

  await signIn(page);
  const pane = await dosyalariAc(page);

  // Adı `.jpg` ama içinde EXIF yok: istemci soruyor, sunucu 204 diyor. 404 olsaydı bu testin
  // KENDİSİ tolerans satırı eklemek zorunda kalırdı — ve o tolerans, hatayı gizleyen şey olurdu.
  const name = `${unique('e2e-exifsiz')}.jpg`;
  // Beklenti YÜKLEMEDEN ÖNCE kuruluyor: istek satır çizilir çizilmez gidiyor, ve beklemeyi sonra
  // kurmak onu çoktan olmuş bir şeyi beklemeye çeviriyordu.
  const bosCevap = page.waitForResponse(
    (r) => r.url().includes('/thumbnail') && r.status() === 204,
  );
  const durum = await yukle(pane, name, Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2Q==', 'base64'));

  if (durum === 503) {
    await expect(page.locator('.toasts .toast')).toBeVisible();
    return;
  }

  const row = pane.locator('.frow').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 20_000 });

  // Küçük resim ucu 204 dedi — yani baytlar OKUNDU ve içinde gömülü bir küçük resim yoktu. 503
  // olsaydı bu bekleme dolardı, ve o fark önemli: "okuyamadım" ile "yok" ayrı şeyler.
  await bosCevap;
  await expect(row.locator('.g.thumb')).toHaveCount(0);
  await expect(row.locator('.g')).toBeVisible();

  // Ve `consoleWatch` bu testin sonunda hiçbir hoş görülmemiş satır bulmuyor — asıl iddia bu.
  await sil(pane, name);
});
