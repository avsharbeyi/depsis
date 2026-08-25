import type { Locator, Page } from '@playwright/test';

import { closePane, expect, openPane, signIn, test } from './fixtures.js';

/**
 * Bildirim merkezi, uçtan uca.
 *
 * `notifications.integration.test.ts` sunucunun ne yazdığını ölçüyor: kim haber alıyor, kim
 * almıyor, ve aynı şey iki kez düşmüyor. Buradan görünen ve oradan görünmeyen tek soru şu —
 * **BİR İNSAN BUNU GÖRÜYOR MU.** Bir bildirim satırı doğru yazılıp hiç okunmayan bir tabloda
 * kalırsa, ürün açısından hiç yazılmamıştır; ve bu iki test o farkı ölçüyor.
 *
 * İKİ HESAP GEREKİYOR, ve bu bir kurulum zahmeti değil, kuralın kendisi: kimse kendi yaptığı şey
 * için bildirim almıyor. Tek hesapla koşan bir test, her zaman boş bir zil görürdü — ve o boş zil,
 * kural çalıştığı için de bozuk olduğu için de aynı görünürdü.
 */

test.beforeEach(({ consoleWatch }) => {
  consoleWatch.tolerate(
    /401 \(Unauthorized\)/,
    'Oturum açılmadan önce /me sorulur ve 401 döner; tarayıcı her 4xx yanıtı konsola yazar.',
  );
  // Bu süitin ikinci yarısı ÜYE olarak koşuyor, ve bir üyenin masaüstü `/system/telemetry`'yi
  // yoklayıp 403 alıyor — tasarım gereği, ve arayüz onu bir nota çeviriyor. `permissions.spec.ts`
  // aynı satırı aynı sebeple hoş görüyor.
  consoleWatch.tolerate(
    /403 \(Forbidden\)/,
    'Üyenin masaüstü /system/telemetry’yi yoklar ve 403 alır; arayüz bunu bir nota çevirir.',
  );
});

const UYE_PAROLA = 'depsis-e2e-uye-parola-42';

function yeniUyeAdi(): string {
  return `bil${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function unique(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Üst çubuktaki zil. Rozeti yokken de var: sayı sıfırken rozet çizilmiyor, düğme duruyor. */
function bell(page: Page): Locator {
  return page.getByRole('button', { name: /^Bildirimler/ });
}

function panel(page: Page): Locator {
  return page.locator('.pmenu.notif');
}

/** `permissions.spec.ts` ile aynı yol: güç menüsü, ve çıkışın gerçekten olduğunun kanıtı. */
async function cikisYap(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Güç' }).click();
  await page.getByRole('button', { name: 'Çıkış yap' }).click();
  await expect(page.getByRole('button', { name: 'Giriş yap' })).toBeVisible();
}

async function uyeOlustur(page: Page): Promise<{ username: string; password: string }> {
  const username = yeniUyeAdi();
  await signIn(page);
  const pencere = await openPane(page, 'Kullanıcılar');
  await pencere.getByLabel('Kullanıcı adı').fill(username);
  await pencere.getByLabel(/^Parola/).fill(UYE_PAROLA);
  await pencere.getByLabel(/^Rol/).selectOption('member');
  await pencere.getByRole('button', { name: 'Oluştur' }).click();
  await expect(page.getByRole('status').last()).toContainText(`"${username}" oluşturuldu.`);
  await closePane(page);
  return { username, password: UYE_PAROLA };
}

test('bir iş atanınca karşı tarafın zili yanıyor ve okundu işaretlenebiliyor', async ({ page }) => {
  const uye = await uyeOlustur(page);

  // Yönetici hâlâ oturumda: işi O oluşturuyor ve üyeye veriyor.
  const body = unique('e2e-bildirim');
  const isler = await openPane(page, 'İşler');
  const kutu = isler.getByPlaceholder('Kimseye atanmamış iş ekle — Enter');
  await kutu.fill(body);
  await kutu.press('Enter');
  const satir = isler.locator('.jitem').filter({ hasText: body });
  await expect(satir).toBeVisible();
  await satir.getByLabel('Atanan kişi', { exact: true }).selectOption({ label: uye.username });

  // Yöneticinin kendi zili boş: atamayı yapan kişiye haber gitmiyor. Bu satır olmasaydı test,
  // "birine bir şey düştü" ile "herkese her şey düşüyor" arasını ayıramazdı.
  await expect(bell(page)).toHaveAccessibleName('Bildirimler');
  await closePane(page);
  await cikisYap(page);

  await signIn(page, uye.username, uye.password);
  const zil = bell(page);
  await expect(zil).toHaveAccessibleName(/1 okunmamış/);

  await zil.click();
  await expect(panel(page).getByText(`Sana bir iş atandı: ${body}`)).toBeVisible();

  // "Hepsini okundu yap" rozeti düşürüyor — ve rozetin kendisi kayboluyor, çünkü sıfır yazan bir
  // rozet göz için hâlâ bir şey var demek.
  await panel(page).getByRole('button', { name: 'Hepsini okundu yap' }).click();
  await expect(zil).toHaveAccessibleName('Bildirimler');
  await expect(zil.locator('.badge')).toHaveCount(0);
});

test('panelin açılması tek başına okundu saymıyor', async ({ page }) => {
  const uye = await uyeOlustur(page);

  const body = unique('e2e-acilis');
  const isler = await openPane(page, 'İşler');
  const kutu = isler.getByPlaceholder('Kimseye atanmamış iş ekle — Enter');
  await kutu.fill(body);
  await kutu.press('Enter');
  await isler
    .locator('.jitem')
    .filter({ hasText: body })
    .getByLabel('Atanan kişi', { exact: true })
    .selectOption({ label: uye.username });
  await closePane(page);
  await cikisYap(page);

  await signIn(page, uye.username, uye.password);
  const zil = bell(page);
  await expect(zil).toHaveAccessibleName(/1 okunmamış/);

  // Bir paneli açmak "gördüm" demek değil — yanlış tuşa basmak da paneli açıyor. Otomatik okundu
  // işaretlemek, kullanıcının bir daha asla bulamayacağı bir hatırlatma üretirdi.
  await zil.click();
  await expect(panel(page).getByText(body)).toBeVisible();
  await zil.click();
  await expect(zil).toHaveAccessibleName(/1 okunmamış/);
});
