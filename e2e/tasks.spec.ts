import type { Locator } from '@playwright/test';

import { closePane, expect, openPane, signIn, test } from './fixtures.js';

/**
 * Oturum açılmadan önce `/me` sorulur ve 401 döner; tarayıcı her 4xx yanıtı konsola yazıyor.
 * `shell.spec.ts` aynı satırı aynı sebeple hoş görüyor.
 */
test.beforeEach(({ consoleWatch }) => {
  consoleWatch.tolerate(
    /401 \(Unauthorized\)/,
    'Oturum açılmadan önce /me sorulur ve 401 döner; tarayıcı her 4xx yanıtı konsola yazar.',
  );
});

/**
 * İş panosunun §7'ye doğru büyümüş hâli: durum, öncelik, son tarih.
 *
 * Sunucu tarafı `tasks.integration.test.ts` ve `task-files.integration.test.ts` ile ölçülüyor —
 * durum makinesinin ne yasakladığı, ve bir dosya bağının izin vermediği şey. Buradan görünen ve
 * oradan görünmeyen şey başka: bir kontrol EKRANDA VAR MI, ve değiştirdiği şey yeniden yüklendikten
 * sonra hâlâ orada mı.
 *
 * İkisi ayrı sorular. Bir `PATCH` yeşil dönerken arayüzün eski değeri göstermeye devam etmesi,
 * sunucu testlerinin göremeyeceği bir hata — ve kullanıcı için "kaydedilmedi" ile ayırt edilemez.
 */

/** Panodaki bir işin satırı, gövdesinden bulunuyor. */
function row(pane: Locator, body: string): Locator {
  return pane.locator('.jitem').filter({ hasText: body });
}

async function addTask(pane: Locator, body: string): Promise<Locator> {
  // "Atanmamış" sütununun kendi ekleme kutusu var; pano kişiye göre gruplanıyor, ve her grubun
  // kendi alanı — o yüzden yer tutucu adı grubu içeriyor.
  const input = pane.getByPlaceholder('Kimseye atanmamış iş ekle — Enter');
  await input.fill(body);
  await input.press('Enter');
  const created = row(pane, body);
  await expect(created).toBeVisible();
  return created;
}

/** Benzersiz, çünkü bu süit ardında iş bırakıyor — silme her testin sonunda değil, kendi testinde. */
function unique(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

test('durum, öncelik ve son tarih kaydediliyor ve yeniden yüklemeye dayanıyor', async ({
  page,
}) => {
  await signIn(page);
  const pane = await openPane(page, 'İşler');

  const body = unique('e2e-gorev');
  const task = await addTask(pane, body);

  // Üç kontrol de EKRANDA. Bir alanı sözleşmeye eklemek onu arayüze koymuyor, ve §7'nin istediği
  // şey bir sütun değil bir ekran.
  await task.getByLabel('Durum', { exact: true }).selectOption('in_progress');
  await task.getByLabel('Öncelik', { exact: true }).selectOption('urgent');
  await task.getByLabel('Son tarih', { exact: true }).fill('2027-03-04');

  // YENİDEN YÜKLEME, ve testin asıl noktası bu. Bir `PATCH`in yeşil dönmesi, değerin sunucuda
  // durduğunu göstermiyor: arayüz kendi yanıtından okuyor, ve sunucunun normalleştirdiği bir
  // değeri geri yazmayan bir ekran, kaydedilmiş görünüp kaydetmemiş olur.
  await closePane(page);
  const reopened = await openPane(page, 'İşler');
  const again = row(reopened, body);

  await expect(again.getByLabel('Durum', { exact: true })).toHaveValue('in_progress');
  await expect(again.getByLabel('Öncelik', { exact: true })).toHaveValue('urgent');
  await expect(again.getByLabel('Son tarih', { exact: true })).toHaveValue('2027-03-04');

  await removeTask(reopened, body);
});

test('geçmiş bir son tarih GEÇTİĞİNİ söylüyor, tarih göstermiyor', async ({ page }) => {
  // Gecikmiş bir işi normal bir tarih gibi göstermek, son tarihin var olma sebebini boşa çıkarır.
  await signIn(page);
  const pane = await openPane(page, 'İşler');

  const body = unique('e2e-gecik');
  const task = await addTask(pane, body);
  await task.getByLabel('Son tarih', { exact: true }).fill('2020-01-01');

  await expect(task.getByText(/gün geçti/)).toBeVisible();

  await removeTask(pane, body);
});

test('sunucunun reddettiği bir geçiş arayüzde SÖYLENİYOR, sessizce yutulmuyor', async ({
  page,
  consoleWatch,
}) => {
  // Bu testin ÜRETTİĞİ 422. Tarayıcı her hata durumunu konsola yazıyor, ve reddedilen bir geçiş
  // bu testin ölçtüğü şeyin ta kendisi — hoş görülmezse test kendi başarısını hata sayar.
  consoleWatch.tolerate(
    /422 \(Unprocessable Entity\)/,
    'Bu test bilerek reddedilen bir durum geçişi gönderiyor; 422 beklenen cevap.',
  );

  // Durum makinesi yalnız iki geçişi yasaklıyor ve bu onlardan biri: bitmiş bir işi iptal etmek,
  // hem yapıldı hem yapılmadı demek. Seçenekler istemcide filtrelenmiyor — sunucunun kuralını
  // ikinci kez yazmak zamanla ayrışan iki kural demek — o yüzden reddin KULLANICIYA ULAŞMASI
  // gerekiyor, yoksa seçim geri sıçrar ve kimse nedenini bilmez.
  await signIn(page);
  const pane = await openPane(page, 'İşler');

  const body = unique('e2e-kapat');
  const task = await addTask(pane, body);
  await task.getByLabel('Durum', { exact: true }).selectOption('done');

  // KAPANAN İŞ ARŞİVE TAŞINIYOR — pano yalnız açık işleri gösteriyor. Bu testin ikinci yarısı bu
  // yüzden Arşiv sekmesinde: yasaklı geçişlerin ikisi de kapalı bir durumdan başlıyor, yani
  // reddin kullanıcıya ulaştığını ölçmenin yeri artık orası. Arşiv satırı durum kutusunu tam da
  // bunun için taşıyor.
  await pane.getByRole('tab', { name: /^Arşiv/ }).click();
  const archived = row(pane, body);
  await expect(archived.getByLabel('Durum', { exact: true })).toHaveValue('done');

  await archived.getByLabel('Durum', { exact: true }).selectOption('cancelled');

  await expect(page.locator('.toasts .toast.error')).toBeVisible();
  // Ve değer değişmedi: ekran reddedilen bir değeri kabul edilmiş gibi göstermiyor.
  await expect(archived.getByLabel('Durum', { exact: true })).toHaveValue('done');

  await removeTask(pane, body);
});

async function removeTask(pane: Locator, body: string): Promise<void> {
  const task = row(pane, body);
  await task.getByRole('button', { name: new RegExp(`"${body}" işini sil`) }).click();
  await expect(task).toHaveCount(0);
}
