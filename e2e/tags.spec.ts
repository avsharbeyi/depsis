import type { Locator, Page } from '@playwright/test';

import { closePane, expect, openPane, signIn, test } from './fixtures.js';

/**
 * Etiketler — uçtan uca.
 *
 * `task-tags.integration.test.ts` sunucunun ne yaptığını ölçüyor: katlama, yarış, kaskat, yetki.
 * Buradan görünen ve oradan görünmeyen şeyler:
 *
 *   * bir etiketin panonun ÜSTÜNDE bir süzgeç olarak belirmesi ve gerçekten süzmesi;
 *   * bir üyeye "etiketleri düzenle" düğmesinin HİÇ ÇİZİLMEMESİ — sunucu reddediyor, ama
 *     çalışmayan bir düğme çalışmayan bir kontroldür.
 */

test.beforeEach(({ consoleWatch }) => {
  consoleWatch.tolerate(
    /401 \(Unauthorized\)/,
    'Oturum açılmadan önce /me sorulur ve 401 döner; tarayıcı her 4xx yanıtı konsola yazar.',
  );
  consoleWatch.tolerate(
    /403 \(Forbidden\)/,
    'Üyenin masaüstü /system/telemetry’yi yoklar ve 403 alır; arayüz bunu bir nota çevirir.',
  );
});

const UYE_PAROLA = 'depsis-e2e-uye-parola-42';

function unique(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

async function isEkle(pane: Locator, body: string): Promise<void> {
  const input = pane.getByPlaceholder('Kimseye atanmamış iş ekle — Enter');
  await input.fill(body);
  await input.press('Enter');
  await expect(pane.locator('.jitem').filter({ hasText: body })).toBeVisible();
}

async function paneliAc(pane: Locator, body: string): Promise<Locator> {
  const box = pane.locator('.jwrap').filter({ hasText: body });
  await box.getByRole('button', { name: new RegExp(`"${body}" işinin yorumları`) }).click();
  const thread = box.locator('.thread');
  await expect(thread).toBeVisible();
  return thread;
}

async function cikisYap(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Güç' }).click();
  await page.getByRole('button', { name: 'Çıkış yap' }).click();
  await expect(page.getByRole('button', { name: 'Giriş yap' })).toBeVisible();
}

test('etiket oluşturuluyor, satırda beliriyor ve panoyu süzüyor', async ({ page }) => {
  await signIn(page);
  const pane = await openPane(page, 'İşler');

  const tagged = unique('e2e-etiketli');
  const plain = unique('e2e-etiketsiz');
  await isEkle(pane, tagged);
  await isEkle(pane, plain);

  const tagName = unique('acil');
  const thread = await paneliAc(pane, tagged);
  await thread.getByLabel('Yeni etiket').fill(tagName);
  await thread.getByLabel('Yeni etiket').press('Enter');

  // Çip İŞİN SATIRINDA: etiketin tek işe yarar tarafı, panoya bakarken görünmesi.
  const row = pane.locator('.jitem').filter({ hasText: tagged });
  await expect(row.locator('.tg', { hasText: tagName })).toBeVisible();

  // Ve panonun üstündeki şeritte bir süzgeç olarak.
  const filter = pane.locator('.tagbar').getByRole('button', { name: tagName, exact: true });
  await expect(filter).toBeVisible();
  await filter.click();

  // Süzgeç açıkken etiketsiz iş GİTMİŞ olmalı — süzülmeyen bir süzgeç, süzgeç değil.
  await expect(pane.locator('.jitem').filter({ hasText: tagged })).toBeVisible();
  await expect(pane.locator('.jitem').filter({ hasText: plain })).toHaveCount(0);

  await filter.click();
  await expect(pane.locator('.jitem').filter({ hasText: plain })).toBeVisible();
});

test('aynı ad büyük harfle yazılınca ikinci bir etiket üretmiyor', async ({ page }) => {
  await signIn(page);
  const pane = await openPane(page, 'İşler');

  const body = unique('e2e-katlama');
  await isEkle(pane, body);
  const thread = await paneliAc(pane, body);

  const name = unique('depo');
  await thread.getByLabel('Yeni etiket').fill(name);
  await thread.getByLabel('Yeni etiket').press('Enter');
  await expect(thread.locator('.tg.on', { hasText: name })).toBeVisible();

  // Aynı ad, büyük harfle. Sunucu `fold_identity` ile katlıyor ve VAR OLANI döndürüyor; ekranda
  // ikinci bir çip belirmemeli.
  await thread.getByLabel('Yeni etiket').fill(name.toUpperCase());
  await thread.getByLabel('Yeni etiket').press('Enter');

  const row = pane.locator('.jitem').filter({ hasText: body });
  await expect(row.locator('.tg')).toHaveCount(1);
});

test('üye "etiketleri düzenle" düğmesini görmüyor', async ({ page }) => {
  // Önce yönetici bir etiket oluşturuyor ki şerit çizilsin.
  await signIn(page);
  const pane = await openPane(page, 'İşler');
  const body = unique('e2e-yetki');
  await isEkle(pane, body);
  const thread = await paneliAc(pane, body);
  const tagName = unique('gorunur');
  await thread.getByLabel('Yeni etiket').fill(tagName);
  await thread.getByLabel('Yeni etiket').press('Enter');
  await expect(pane.locator('.tagbar').getByRole('button', { name: tagName })).toBeVisible();
  // Yöneticide düğme VAR.
  await expect(pane.getByRole('button', { name: 'Etiketleri düzenle' })).toBeVisible();

  const username = `etk${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  await closePane(page);
  const users = await openPane(page, 'Kullanıcılar');
  await users.getByLabel('Kullanıcı adı').fill(username);
  await users.getByLabel(/^Parola/).fill(UYE_PAROLA);
  await users.getByLabel(/^Rol/).selectOption('member');
  await users.getByRole('button', { name: 'Oluştur' }).click();
  await expect(page.getByRole('status').last()).toContainText(`"${username}" oluşturuldu.`);
  await closePane(page);
  await cikisYap(page);

  await signIn(page, username, UYE_PAROLA);
  const uyeninPanosu = await openPane(page, 'İşler');
  // Etiketi GÖRÜYOR ve süzebiliyor — sözlük herkese açık.
  await expect(
    uyeninPanosu.locator('.tagbar').getByRole('button', { name: tagName }),
  ).toBeVisible();
  // Ama bakım düğmesi YOK: sunucu zaten reddediyor, ve çalışmayan bir düğme çalışmayan bir kontrol.
  await expect(uyeninPanosu.getByRole('button', { name: 'Etiketleri düzenle' })).toHaveCount(0);
});
