import type { Locator } from '@playwright/test';

import { expect, openPane, signIn, test } from './fixtures.js';

/**
 * Alt görevler ve kontrol listeleri — uçtan uca.
 *
 * `task-checklist.integration.test.ts` sunucunun ne yazdığını ve neyi reddettiğini ölçüyor: tek
 * seviye kuralı, kaskat, denetim satırları. Buradan görünen ve oradan görünmeyen şey, arayüzün
 * KENDİ İDDİALARI — bir parça eklendiğinde satırın kenarındaki rozetin gerçekten değişmesi, bir
 * maddenin tiklenmiş hâlinin yenilemeye dayanması, ve bir alt görevde "parça ekle" kutusunun hiç
 * çizilmemesi.
 *
 * O son madde bir kontrolün kendisi: kutu çizilseydi, sunucu onu her seferinde reddederdi ve
 * kullanıcı hiç çalışmayan bir alana yazıyor olurdu.
 */

test.beforeEach(({ consoleWatch }) => {
  consoleWatch.tolerate(
    /401 \(Unauthorized\)/,
    'Oturum açılmadan önce /me sorulur ve 401 döner; tarayıcı her 4xx yanıtı konsola yazar.',
  );
});

function unique(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

async function isEkle(pane: Locator, body: string): Promise<void> {
  const input = pane.getByPlaceholder('Kimseye atanmamış iş ekle — Enter');
  await input.fill(body);
  await input.press('Enter');
  await expect(pane.locator('.jitem').filter({ hasText: body })).toBeVisible();
}

/** Bir işin sarmalayıcısı — tartışma paneli satırın kardeşi, çocuğu değil. */
function wrap(pane: Locator, body: string): Locator {
  return pane.locator('.jwrap').filter({ hasText: body });
}

async function paneliAc(pane: Locator, body: string): Promise<Locator> {
  const box = wrap(pane, body);
  await box.getByRole('button', { name: new RegExp(`"${body}" işinin yorumları`) }).click();
  const thread = box.locator('.thread');
  await expect(thread).toBeVisible();
  return thread;
}

test('kontrol listesi maddesi ekleniyor, tikleniyor ve yenilemeye dayanıyor', async ({ page }) => {
  await signIn(page);
  const pane = await openPane(page, 'İşler');

  const body = unique('e2e-liste');
  await isEkle(pane, body);
  const thread = await paneliAc(pane, body);

  const box = thread.getByLabel('Kontrol listesine madde ekle');
  await box.fill('Diski çıkar');
  await box.press('Enter');
  await box.fill('Yenisini tak');
  await box.press('Enter');

  const items = thread.locator('.citem');
  await expect(items).toHaveCount(2);
  // Eklendiği sırayla: sırayı sunucu hesaplıyor, ve istemcinin tahmin etmesi o hesabı ikinci kez
  // yazmak olurdu.
  await expect(items.first()).toContainText('Diski çıkar');

  await items.first().getByRole('checkbox').check();
  // Satırın kenarındaki rozet, listeyle aynı şeyi söylüyor mu.
  await expect(wrap(pane, body).locator('.jitem .pill', { hasText: '☑' })).toContainText('1/2');

  await page.reload();
  const again = page.getByRole('dialog', { name: 'İşler' });
  await expect(again).toBeVisible();
  const reopened = await paneliAc(again, body);
  await expect(reopened.locator('.citem').first().getByRole('checkbox')).toBeChecked();
});

test('parça ekleniyor, panoda kendi satırı oluyor ve üstünü işaret ediyor', async ({ page }) => {
  await signIn(page);
  const pane = await openPane(page, 'İşler');

  const body = unique('e2e-ust');
  await isEkle(pane, body);
  const thread = await paneliAc(pane, body);

  const box = thread.getByLabel('Parça ekle');
  const partBody = unique('e2e-parca');
  await box.fill(partBody);
  await box.press('Enter');

  // Parça panoda KENDİ SATIRI: pano kişiye göre gruplanıyor ve bir parça da birine verilen iş.
  // Yalnız üstünün panelinde göstermek, o işi panodan kaldırmak olurdu.
  const part = pane.locator('.jitem').filter({ hasText: partBody });
  await expect(part).toBeVisible();
  await expect(part.locator('.pill', { hasText: '⤷' })).toBeVisible();

  // Ve üstün satırındaki rozet parçayı sayıyor.
  await expect(wrap(pane, body).locator('.jitem .pill', { hasText: '⑂' })).toContainText('0/1');
});

test('bir parçada "parça ekle" kutusu hiç çizilmiyor', async ({ page }) => {
  await signIn(page);
  const pane = await openPane(page, 'İşler');

  const body = unique('e2e-derinlik');
  await isEkle(pane, body);
  const thread = await paneliAc(pane, body);
  const partBody = unique('e2e-alt');
  await thread.getByLabel('Parça ekle').fill(partBody);
  await thread.getByLabel('Parça ekle').press('Enter');
  await expect(pane.locator('.jitem').filter({ hasText: partBody })).toBeVisible();

  // TEK SEVİYE. Kuralı veritabanındaki tetikleyici tutuyor ve reddi o veriyor; arayüzün işi,
  // her seferinde reddedilecek bir kutuyu hiç göstermemek.
  const partThread = await paneliAc(pane, partBody);
  await expect(partThread.getByLabel('Parça ekle')).toHaveCount(0);
  // Kontrol listesi ise DURUYOR: bir parçanın kendi maddeleri olabilir.
  await expect(partThread.getByLabel('Kontrol listesine madde ekle')).toBeVisible();
});
