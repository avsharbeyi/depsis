// `createRequire`, düz bir `import` DEĞİL: paket CommonJS ve varsayılan dışa aktarımı
// `verbatimModuleSyntax` altında çağrılabilir bir tip olarak görünmüyor. Çalışma zamanında
// ikisi de aynı şeyi veriyor; bu biçim tsc'yi de doğru bilgilendiriyor.
import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';

import { expect, openPane, signIn, test } from './fixtures.js';

/**
 * Erişilebilirlik — §21'in "erişilebilirlik testleri" maddesi.
 *
 * BİR GÖRÜNÜM TESTİ DEĞİL. axe'ın yakaladığı şeyler makine tarafından KARARA BAĞLANABİLİR olanlar:
 * kontrastı ölçülebilen renkler, adı olmayan düğmeler, etiketi olmayan alanlar, bozuk ARIA. Bunlar
 * bir ekranın kullanılabilir olduğunu KANITLAMIYOR — klavyeyle gezilebilirlik, odak sırası ve ekran
 * okuyucunun okuduğu cümlenin anlamlı olması hâlâ insan işi. Kanıtladıkları şey, kullanılamaz
 * olmasının en yaygın dört sebebinin orada olmadığı.
 *
 * NEDEN BU ÜRÜNDE. DEPSIS'in arayüzü koyu bir zemin üzerinde ince gri metinlerle çalışıyor
 * (`--dim: #5b6d7e`), ve o palet kontrast eşiğinin altına düşmenin en kolay yolu. Bir de bu oturumda
 * yazılan her ekran — bildirim zili, tartışma paneli, etiket şeridi, çoğaltma formu, bağlanma
 * komutları — kendi düğmelerini ve alanlarını getirdi, ve hiçbiri bu gözle bakılmadı.
 *
 * KONTRAST DA DAHİL, ve bu ölçülerek karar verildi. İlk hâlde `color-contrast` hariç tutulmuştu —
 * gerekçe "palet bir tasarım kararı, onu bir testle değiştirmek referans tasarımı testin beğenisine
 * göre yeniden yazmak olur" idi. Sonra kural bir kez açılıp koşuldu: dokuz ekranın hiçbirinde ihlal
 * yok. Yani hariç tutma, geçen bir kuralı kapatmaktan ibaretti; ve geçen bir kuralı "tartışmalı"
 * diye kapatmak, kendi ölçümünün yalanladığı bir yorum bırakmak olurdu. Palet AA eşiğini
 * karşılıyor, ve artık bunu bir test tutuyor.
 */

/** Bir sayfayı tara ve ihlalleri okunabilir bir listeye çevir. */
/**
 * axe'ın cevabından KULLANILAN kadarı.
 *
 * `axe-core`'un kendi tipleri geçişli bir bağımlılıktan geliyor ve doğrudan çözülmüyor. Tam tipi
 * yeniden yazmak yerine yalnız okunan alanlar: bir raporun bu dosyada ne kadarına baktığı, tipin
 * kendisinden okunabilir olsun.
 */
interface AxeNode {
  target: string[];
  failureSummary?: string;
}
interface AxeViolation {
  id: string;
  impact?: string | null;
  help: string;
  nodes: AxeNode[];
}
interface AxeResults {
  violations: AxeViolation[];
}

interface AxeRunner {
  withTags: (tags: string[]) => AxeRunner;
  disableRules: (rules: string[]) => AxeRunner;
  analyze: () => Promise<AxeResults>;
}
/** Modülün şekli, `any` üzerinden geçmeden: `require`'ın dönüşü tiplenmemiş. */
interface AxeModule {
  default: new (options: { page: Page }) => AxeRunner;
}
const AxeBuilder = (createRequire(import.meta.url)('@axe-core/playwright') as AxeModule).default;

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return result.violations.map(
    (v: AxeViolation) =>
      `${v.id} (${v.impact ?? 'bilinmiyor'}): ${v.help}\n` +
      v.nodes
        .slice(0, 4)
        .map((n: AxeNode) => `    ${n.target.join(' ')}\n      ${n.failureSummary ?? ''}`)
        .join('\n'),
  );
}

test.beforeEach(({ consoleWatch }) => {
  consoleWatch.tolerate(
    /401 \(Unauthorized\)/,
    'Oturum açılmadan önce /me sorulur ve 401 döner; tarayıcı her 4xx yanıtı konsola yazar.',
  );
  consoleWatch.tolerate(
    /503 \(Service Unavailable\)/,
    'Ajansız bir yığında bayt taşıyan uçlar 503 veriyor; bu süit ekranın yapısını ölçüyor.',
  );
});

test('giriş ekranı', async ({ page }) => {
  // Oturum AÇMADAN: bu, kimliği doğrulanmamış birinin gördüğü tek ekran, ve bir parola alanının
  // etiketsiz olması ekran okuyucuyla giriş yapmayı imkânsız kılar.
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Giriş yap' })).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test('masaüstü', async ({ page }) => {
  await signIn(page);
  expect(await violations(page)).toEqual([]);
});

/**
 * Bu oturumda yazılan her panel, tek tek.
 *
 * Tek bir "bütün panelleri gez" testi yerine ayrı testler: bir panelin ihlali ötekini de kırmızı
 * yapsaydı, rapor hangisinin bozuk olduğunu söylemezdi — ve bir erişilebilirlik raporunun tek işi
 * nereye bakılacağını söylemek.
 */
for (const pane of ['İşler', 'Notlar', 'Paylaşımlar', 'Dosyalar', 'Yedekleme'] as const) {
  test(`panel: ${pane}`, async ({ page }) => {
    await signIn(page);
    await openPane(page, pane);
    expect(await violations(page)).toEqual([]);
  });
}

test('bildirim paneli açıkken', async ({ page }) => {
  await signIn(page);
  // Zil ve altındaki panel gövdeye portallanmış; kapalıyken hiç çizilmiyor, yani açılmadan
  // taranması hiçbir şey ölçmezdi.
  await page.getByRole('button', { name: /^Bildirimler/ }).click();
  await expect(page.locator('.pmenu.notif')).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test('tartışma paneli açıkken', async ({ page }) => {
  await signIn(page);
  const pane = await openPane(page, 'İşler');

  const body = `e2e-a11y-${Math.random().toString(36).slice(2, 10)}`;
  const input = pane.getByPlaceholder('Kimseye atanmamış iş ekle — Enter');
  await input.fill(body);
  await input.press('Enter');

  const wrap = pane.locator('.jwrap').filter({ hasText: body });
  await expect(wrap).toBeVisible();
  await wrap.getByRole('button', { name: new RegExp(`"${body}" işinin yorumları`) }).click();
  await expect(wrap.locator('.thread')).toBeVisible();

  expect(await violations(page)).toEqual([]);

  // Satırı bırakmamak: bu süit panoyu paylaşıyor.
  await wrap.getByRole('button', { name: new RegExp(`"${body}" işini sil`) }).click();
});

/**
 * TARAYICININ KENDİSİ ÇALIŞIYOR MU.
 *
 * Dokuz ekranın da temiz çıkması iki şey anlamına gelebilir: ekranlar gerçekten temiz, ya da tarama
 * hiçbir şeye bakmıyor. İkisi rapora bakınca aynı görünüyor — ve yalnız geçebilen bir süit, bir
 * süit değil.
 *
 * Bu test sayfaya BİLEREK bozuk bir düğme koyuyor: adı olmayan bir düğme, ekran okuyucunun
 * "düğme" diye okuyup geçtiği ve hiçbir şey ifade etmeyen şey. axe bunu görmüyorsa yukarıdaki
 * dokuz testin hepsi anlamsız, ve bunu söyleyen tek şey burası.
 */
test('taramanın kendisi bozuk bir düğmeyi görüyor', async ({ page }) => {
  await signIn(page);
  await page.evaluate(() => {
    const bad = document.createElement('button');
    bad.id = 'a11y-negative-control';
    document.body.append(bad);
  });

  const found = await violations(page);
  expect(
    found.some((line) => line.startsWith('button-name')),
    `axe adsız bir düğmeyi bildirmeliydi; bildirdikleri: ${found.join(' | ') || '(hiçbiri)'}`,
  ).toBe(true);

  // Ve kaldırılınca yine temiz: kontrol, kalıcı bir ihlal bırakmıyor.
  await page.evaluate(() => document.querySelector('#a11y-negative-control')?.remove());
  expect(await violations(page)).toEqual([]);
});
