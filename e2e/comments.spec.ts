import type { Locator, Page } from '@playwright/test';

import { closePane, expect, openPane, signIn, test } from './fixtures.js';

/**
 * Yorumlar, anmalar ve izleyiciler — uçtan uca.
 *
 * `task-comments.integration.test.ts` sunucunun ne yazdığını ölçüyor: kim haber alıyor, mention
 * hangi sınırda çözülüyor, silinen yorumun gövdesi nereye gidiyor. Buradan görünen ve oradan
 * görünmeyen soru şu — **BİR İNSAN BU KONUŞMAYI YAPABİLİYOR MU.** Bir yorum ucu kusursuz çalışıp
 * arayüzde bir kutu olmasa, ürün açısından yorum diye bir şey yok.
 *
 * İKİ HESAP, ve yine kuralın kendisi yüzünden: kimse kendi yazdığı yorum için bildirim almıyor,
 * yani tek hesapla koşan bir test her zaman boş bir zil görürdü.
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

function yeniUyeAdi(): string {
  return `yor${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function unique(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function bell(page: Page): Locator {
  return page.getByRole('button', { name: /^Bildirimler/ });
}

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

/** Panoya bir iş ekle ve satırını döndür. */
async function isEkle(pane: Locator, body: string): Promise<Locator> {
  const input = pane.getByPlaceholder('Kimseye atanmamış iş ekle — Enter');
  await input.fill(body);
  await input.press('Enter');
  const row = pane.locator('.jitem').filter({ hasText: body });
  await expect(row).toBeVisible();
  return row;
}

/** Bir işin tartışma panelini aç. Panel satırın KARDEŞİ, çocuğu değil — sarmalayıcıdan bulunuyor. */
async function tartismayiAc(pane: Locator, body: string): Promise<Locator> {
  const wrap = pane.locator('.jwrap').filter({ hasText: body });
  await wrap.getByRole('button', { name: new RegExp(`"${body}" işinin yorumları`) }).click();
  const thread = wrap.locator('.thread');
  await expect(thread).toBeVisible();
  return thread;
}

test('yorum yazılıyor, ekranda kalıyor ve yenilemeye dayanıyor', async ({ page }) => {
  await signIn(page);
  const pane = await openPane(page, 'İşler');

  const body = unique('e2e-yorum');
  await isEkle(pane, body);
  const thread = await tartismayiAc(pane, body);
  await expect(thread.getByText('Henüz yorum yok.')).toBeVisible();

  await thread.getByLabel('Yorum yaz').fill('Diski taktım, kontrol eder misin?');
  await thread.getByRole('button', { name: 'Gönder' }).click();
  await expect(thread.getByText('Diski taktım, kontrol eder misin?')).toBeVisible();
  // Kutu yalnız BAŞARIDAN sonra temizleniyor.
  await expect(thread.getByLabel('Yorum yaz')).toHaveValue('');

  // Yenilemeye dayanıyor: bir POST'un yeşil dönmesi ile satırın gerçekten yazılmış olması aynı
  // şey değil, ve arayüz testlerinin görebildiği tek fark bu.
  await page.reload();
  // `openPane` DEĞİL: pencere adresten kendi açılıyor (hash), ve üstündeki `.ovl` örtüsü alt bar
  // rozetine yapılan tıklamayı yutuyor. Zaten açık olan bir paneli yeniden açmaya çalışmak, testin
  // ölçtüğü şeyle ilgisi olmayan bir zaman aşımı üretiyordu.
  const again = page.getByRole('dialog', { name: 'İşler' });
  await expect(again).toBeVisible();
  const reopened = await tartismayiAc(again, body);
  await expect(reopened.getByText('Diski taktım, kontrol eder misin?')).toBeVisible();
});

test('silinen yorum listede kalıyor ve silindiğini söylüyor', async ({ page }) => {
  await signIn(page);
  const pane = await openPane(page, 'İşler');

  const body = unique('e2e-silinen');
  await isEkle(pane, body);
  const thread = await tartismayiAc(pane, body);

  await thread.getByLabel('Yorum yaz').fill('Bu cümle silinecek');
  await thread.getByRole('button', { name: 'Gönder' }).click();
  await expect(thread.getByText('Bu cümle silinecek')).toBeVisible();

  await thread.getByRole('button', { name: 'Yorumu sil' }).click();
  // Satır KALIYOR ve ne olduğunu söylüyor: sessizce kaybolan bir replika, okuyanı kendi
  // hafızasından şüphe ettirir.
  await expect(thread.getByText('Bu yorum silindi.')).toBeVisible();
  await expect(thread.getByText('Bu cümle silinecek')).toHaveCount(0);
});

test('anılan kişinin zili yanıyor ve yazan kendi yorumunu duymuyor', async ({ page }) => {
  const uye = await uyeOlustur(page);

  const body = unique('e2e-anma');
  const pane = await openPane(page, 'İşler');
  await isEkle(pane, body);
  const thread = await tartismayiAc(pane, body);

  await thread.getByLabel('Yorum yaz').fill(`Buna bakar mısın @${uye.username}`);
  await thread.getByRole('button', { name: 'Gönder' }).click();
  await expect(thread.locator('.mention')).toHaveText(`@${uye.username}`);

  // Yazanın kendi zili boş.
  await expect(bell(page)).toHaveAccessibleName('Bildirimler');
  await closePane(page);
  await cikisYap(page);

  await signIn(page, uye.username, uye.password);
  await expect(bell(page)).toHaveAccessibleName(/1 okunmamış/);
  await bell(page).click();
  await expect(page.locator('.pmenu.notif').getByText(/seni andı/)).toBeVisible();
});

test('izleme açılıp kapanıyor ve kapalıyken haber gelmiyor', async ({ page }) => {
  const uye = await uyeOlustur(page);

  const body = unique('e2e-izleme');
  const pane = await openPane(page, 'İşler');
  const row = await isEkle(pane, body);
  await row.getByLabel('Atanan kişi', { exact: true }).selectOption({ label: uye.username });
  await closePane(page);
  await cikisYap(page);

  // Üye atandığı için otomatik izliyor; önce onu okuyup sonra bırakıyor.
  await signIn(page, uye.username, uye.password);
  const uyeninPanosu = await openPane(page, 'İşler');
  const uyeninThread = await tartismayiAc(uyeninPanosu, body);
  const watch = uyeninThread.getByRole('button', { name: /İzliyorsun|İzle/ });
  await expect(watch).toHaveAttribute('aria-pressed', 'true');

  await watch.click();
  await expect(watch).toHaveAttribute('aria-pressed', 'false');
  // Yenilemeye dayanıyor: bir düğmenin görüntüsünün değişmesi ile satırın silinmiş olması aynı
  // şey değil.
  await page.reload();
  const tekrar = page.getByRole('dialog', { name: 'İşler' });
  await expect(tekrar).toBeVisible();
  const tekrarThread = await tartismayiAc(tekrar, body);
  await expect(tekrarThread.getByRole('button', { name: /İzliyorsun|İzle/ })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});
