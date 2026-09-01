import type { Locator, Page } from '@playwright/test';

import { closePane, expect, openPane, signIn, test } from './fixtures.js';

/**
 * The shell: the frame every other pane is drawn inside.
 *
 * Nothing here tests a feature. It tests that the furniture is there, that the one control which
 * reaches everything else actually reaches it, and that an address typed into the bar lands where
 * it says it will. A suite that checks the file manager thoroughly while the dock is broken is
 * testing a screen nobody can get to.
 *
 * Every test in this file runs in BOTH projects — `desktop` at 1280x800 and `mobile-360` at
 * 360x740 with touch. That is deliberate rather than lazy: the stylesheet reflows the desk twice
 * on the way down (1080px and 680px), and the two claims that matter most — the dock is reachable,
 * the page does not scroll sideways — can only be falsified by the narrow project.
 */

/**
 * The desk asks `/me` before it knows whether anybody is signed in.
 *
 * `App` mounts, reads `/setup/status`, and then asks `/me` to find out whether the HttpOnly cookie
 * it cannot read is still good. On the sign-in screen the honest answer to that question is 401,
 * and Chromium writes every 4xx response to the console as `Failed to load resource`. So the first
 * load of every test in this suite produces one console error that is the application working
 * correctly — and the watch has to be told, or it fails every test for the same non-defect.
 *
 * Deliberately not narrowed to a URL: the browser's resource-error line does not carry one.
 */
test.beforeEach(({ consoleWatch }) => {
  consoleWatch.tolerate(
    /401 \(Unauthorized\)/,
    'Oturum açılmadan önce /me sorulur ve 401 döner; tarayıcı her 4xx yanıtı konsola yazar.',
  );
  consoleWatch.tolerate(
    /503 \(Service Unavailable\)/,
    'Bu yığında ZFS yok: /system/telemetry ve /system/storage havuzları soramıyor ve 503 ' +
      'dönüyor. Ürünün doğru cevabı — "bilmiyoruz" ile "havuz yok" aynı şey değil — ve ' +
      'tarayıcı her hata durumunu konsola yazıyor. Gerçek bir cihazda bu satır çıkmaz.',
  );
});

/** The tile row across the top of the desk. Located by class because the tiles are `role=button`
 *  and their accessible name is their entire contents, which changes with the data in them. */
const TILES = '.tiles';

function dock(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Uygulamalar' });
}

/**
 * The dock entries by their ACCESSIBLE name, which is what `openPane` matches on.
 *
 * Not `allInnerTexts()`: each dock button holds an `aria-hidden` glyph before its label, so the
 * rendered text of the files entry is "🗂\nDosyalar" while the name a screen reader — and
 * Playwright's `getByRole` — sees is "Dosyalar". Stripping the hidden nodes here is that same
 * rule applied by hand, and it is the difference between a list this test can act on and a list
 * of strings that match nothing.
 */
async function dockNames(page: Page): Promise<string[]> {
  const badge = page.getByRole('button', { name: 'Alt barı aç' });
  if ((await badge.getAttribute('aria-expanded')) !== 'true') await badge.click();

  const buttons = dock(page).getByRole('button');
  await expect(buttons.first()).toBeVisible();

  return buttons.evaluateAll((nodes) =>
    nodes.map((node) => {
      const clone = node.cloneNode(true) as HTMLElement;
      for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
      return (clone.textContent ?? '').trim();
    }),
  );
}

test('masaüstü açılıyor: selamlama, hap göstergeler, kutucuklar ve sağ sütun', async ({ page }) => {
  await signIn(page);

  const top = page.getByRole('banner');

  // The greeting is one of three, chosen by the hour, and the name beside it is the whole point:
  // this line is the only place the desk says WHO is signed in. Asserting the three-way regex
  // rather than recomputing the hour keeps the test from re-implementing `greeting()` and then
  // agreeing with itself when both are wrong.
  await expect(top).toContainText(/İyi (sabahlar|günler|akşamlar), e2eyonetici/);

  // Three pills — load, memory, hottest disk. The count is asserted as well as the contents,
  // because a pill that renders as an empty box still passes a "contains text" check on its
  // neighbour.
  const pills = top.locator('.pill');
  await expect(pills).toHaveCount(3);
  for (const pill of await pills.all()) {
    await expect(pill).not.toBeEmpty();
  }

  // TELEFONDA "Dosyalar" KUTUSU YOK, ve bu bir eksiklik değil: orada ana ekranın en üstünde dosya
  // gezgininin KENDİSİ duruyor. Özet kutusunu da çizmek, aynı adı taşıyan iki kutuyu alt alta
  // koymak olurdu — cihazın sahibinin gördüğü ve "iki tane dosyalar var" dediği şey buydu.
  //
  // Test bunu proje adına bakarak ayırıyor, çünkü ikisi de doğru: geniş ekranda üç kutu, dar
  // ekranda iki kutu ve üstünde gezginin kendisi.
  const mobile = test.info().project.name === 'mobile-360';
  const tiles = page.locator(TILES);
  for (const title of mobile ? ['Notlar', 'İşler'] : ['Dosyalar', 'Notlar', 'İşler']) {
    await expect(tiles.getByText(title, { exact: true })).toBeVisible();
  }
  if (mobile) {
    // Ve gezginin kendisi orada: başlığı kutucukların değil, kartın kendisinin üstünde.
    await expect(page.locator('.mfm').getByText('Dosyalar', { exact: true })).toBeVisible();
    await expect(tiles.getByText('Dosyalar', { exact: true })).toHaveCount(0);
  }

  // `<aside aria-label="Cihaz durumu">`. At 360px the stylesheet turns this column into a
  // horizontally scrolling strip rather than hiding it, so the assertion holds in both projects —
  // and a rule that hid it would fail here, which is the point.
  const side = page.getByRole('complementary', { name: 'Cihaz durumu' });
  await expect(side).toBeVisible();
  for (const title of ['Depolama', 'Sistem', 'Uzak erişim']) {
    await expect(side.getByText(title, { exact: true })).toBeVisible();
  }
});

test('marka rozeti alt barı açıyor ve tekrar basınca kapatıyor', async ({ page }) => {
  await signIn(page);

  const badge = page.getByRole('button', { name: 'Alt barı aç' });

  // The dock is in the document at all times — it slides in and out on a transform — so
  // `toBeVisible` would already be true before the first click. `aria-expanded` on the badge is
  // what assistive technology is told, and asserting the same thing the screen reader is told is
  // the only version of this test that can fail for a reason worth fixing.
  await expect(badge).toHaveAttribute('aria-expanded', 'false');

  await badge.click();
  await expect(badge).toHaveAttribute('aria-expanded', 'true');
  await expect(dock(page)).toHaveClass(/\bon\b/);
  await expect(dock(page).getByRole('button', { name: 'Dosyalar', exact: true })).toBeVisible();

  await badge.click();
  await expect(badge).toHaveAttribute('aria-expanded', 'false');
  await expect(dock(page)).not.toHaveClass(/\bon\b/);
});

test('alt bardaki her giriş kendi penceresini açıyor', async ({ page }) => {
  /**
   * This one test gets a budget of its own, and it is not the suite's 60s stretched to fit.
   *
   * Every other test in the file opens ONE pane. This one opens all twelve, in sequence, each with
   * its own mount and its own request — so its cost is structurally about twelve times a normal
   * test's, and putting it under the same deadline measures the machine rather than the product.
   *
   * Measured: 27.5s on its own, 89s and 120s in the two projects with eight workers competing for
   * the same box and the same API. Both of those are the product working; the flat 60s turned the
   * second pair into a red suite twice with nothing wrong. The budget is therefore per pane, so
   * that adding a thirteenth entry to the dock raises it instead of quietly eating the margin.
   *
   * It is a timeout and not a retry, which is the distinction that matters: nothing here is
   * re-attempted and no assertion is weakened. A pane that comes up blank still fails.
   */
  const PANE_BUDGET_MS = 20_000;

  await signIn(page);

  // Read from the dock rather than written out here. A pane added to `DOCK_ORDER` without a
  // screen behind it is exactly the defect this test exists to catch, and a hard-coded list would
  // simply not know about it.
  const names = await dockNames(page);
  expect(names.length).toBeGreaterThan(0);

  // After `dockNames`, because the count is what the budget is made of. Playwright measures the
  // new deadline from the start of the test, so the sign-in above is inside it.
  test.setTimeout(PANE_BUDGET_MS * names.length);

  for (const name of names) {
    const window = await openPane(page, name);
    // Not merely "a dialog appeared": an empty window under the right title is the failure mode of
    // a pane whose body rendered nothing. The console watch catches a pane that threw; this
    // catches one that came up blank without throwing.
    await expect(window.locator('.wb')).not.toBeEmpty();
    await closePane(page);
  }

  // The absence of console errors is the real subject of this test, and it is asserted by the
  // watch at teardown. Twelve panes opened in one session is the automated version of pressing
  // every button in the product looking for a dead one.
});

test('hash adresi paneli doğrudan açıyor ve yenilemeye dayanıyor', async ({ page }) => {
  await signIn(page);

  await page.goto('/#/notlar');
  await expect(page.getByRole('dialog', { name: 'Notlar' })).toBeVisible();

  // The reload is the half that matters. The pane is opened from `location.hash` on mount as well
  // as on `hashchange`, and a version that only listened for the event would pass the line above
  // and still leave anyone who bookmarked the address looking at a bare desk.
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Notlar' })).toBeVisible();
});

test('escape açık pencereyi kapatıyor', async ({ page }) => {
  await signIn(page);
  await openPane(page, 'Notlar');

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

/**
 * Sub-pixel slack, and only that.
 *
 * `scrollWidth` rounds up and `clientWidth` rounds down, so a box whose content lands on a
 * fractional boundary — which `transform: translateX(-50%)` produces on any odd width — reports one
 * pixel of overflow that nobody can scroll to. Anything wider than this is real: the smallest
 * overflow a reader can actually notice is a whole column, not a rounding error.
 */
const PAY_PX = 1;

/**
 * How far one box's content sticks out past its own right edge.
 *
 * NOT `document.body.scrollWidth - window.innerWidth`, which is what this test used to measure and
 * which cannot fail against this product. `.os` is `position: fixed; inset: 0; overflow: hidden`
 * and every overlay drawn over it — `.dock`, `.ovl`, `.toasts`, `.pmenu` — is `position: fixed` as
 * well. Fixed boxes are laid out against the viewport and add nothing to the document's scrollable
 * area, and `.os` clips whatever is left. Measured in this same Chromium on a page shaped exactly
 * like the shell: a 5000px-wide child inside `.os` at a 360px viewport still reports
 * `document.body.scrollWidth === 360` while `.os.scrollWidth === 5000`. The old assertion passed
 * over 4640px of overflow.
 *
 * `scrollWidth - clientWidth` on the box itself is the measurement that survives that, and it works
 * on a clipping box as well as on a scrolling one — `overflow: hidden` hides the content, it does
 * not stop the box knowing how wide it is.
 */
async function tasma(page: Page, selector: string): Promise<number> {
  return page
    .locator(selector)
    .first()
    .evaluate((el) => el.scrollWidth - el.clientWidth);
}

/**
 * The worst distance by which any dock entry falls outside the viewport, or 0 if all of them are in.
 *
 * The dock is measured by its ENTRIES rather than by its own box, because "the dock is reachable"
 * is a claim about the buttons. `.dock` is `max-width: calc(100% - 230px)` with `flex-wrap: wrap`
 * and no `overflow` of its own, so a `.dk` too wide to wrap — every one of them is
 * `white-space: nowrap` — paints outside its parent's background without the parent's box changing
 * size at all. Asking the parent would report that as fine.
 */
async function dockTasmasi(page: Page): Promise<number> {
  return page.locator('.dock .dk').evaluateAll((nodes) =>
    nodes.reduce((worst, node) => {
      const rect = node.getBoundingClientRect();
      return Math.max(worst, -rect.left, rect.right - window.innerWidth);
    }, 0),
  );
}

test('yatay kaydırma yok: masaüstü, açık alt bar ve geniş pencere', async ({ page }) => {
  await signIn(page);

  /**
   * A desk that overflows sideways puts the right-hand part of every row behind a gesture nobody
   * makes, and it is invisible to every assertion about whether an element "is visible" — an
   * element 200px past the right edge is visible as far as Playwright is concerned.
   */
  expect(await tasma(page, '.os'), 'masaüstü').toBeLessThanOrEqual(PAY_PX);

  await page.getByRole('button', { name: 'Alt barı aç' }).click();
  await expect(dock(page)).toHaveClass(/\bon\b/);
  expect(await tasma(page, '.os'), 'alt bar açık: kabuk').toBeLessThanOrEqual(PAY_PX);
  // The dock holds twelve entries and cannot fit them across 360px on one line. It is supposed to
  // wrap onto more lines inside a box that stays on screen, and on a desktop screen a dock that
  // wrapped correctly and one that ran off the right edge are indistinguishable.
  expect(await dockTasmasi(page), 'alt bar açık: girişler').toBeLessThanOrEqual(PAY_PX);

  // `Dosyalar` is one of the panes marked `wide`, which sets `width: min(1120px, 100%)` — the
  // second clause being the one that keeps it from being 1120px wide inside a 360px viewport.
  await openPane(page, 'Dosyalar');
  expect(await tasma(page, '.os'), 'geniş pencere: kabuk').toBeLessThanOrEqual(PAY_PX);
});

test('geniş pencerenin gövdesi de yana kaymıyor', async ({ page }) => {
  /*
   * BROKEN IN THE PRODUCT AT 360px, and the measurement is the diagnosis.
   *
   * `.wb` is the box that actually scrolls — `overflow: auto` — so it is the one that can hide the
   * right-hand edge of the file manager behind a sideways gesture instead of reflowing it. It is
   * clean on the desktop project and two pixels wide of clean on the narrow one, which is exactly
   * the kind of thing the mobile-360 project exists to find.
   *
   * Measured with the file manager open, at 360x740 in this suite's own Chromium:
   *
   *     .wb   scrollWidth 340   clientWidth 338   padding 12px / 12px
   *     .fm   scrollWidth 342   clientWidth 342   margin  -14px / -14px
   *
   * `.wb > .fm { margin: -14px }` (styles.css:533) cancels the window body's padding so the file
   * manager's own 13px column inset is not nested inside a second gutter. That is right at 14px of
   * padding — and the 680px media query changes `.wb` to `padding: 12px` (styles.css:2570) without
   * changing the margin with it. The file manager then reaches two pixels past the padding box on
   * each side, and the right-hand two become scrollable overflow.
   *
   * The fix is one line in apps/web — the negative margin has to follow the padding, e.g. by
   * setting `margin: -12px` alongside the narrow padding — and apps/web is not this branch's to
   * change. So the test states what should hold and is marked fixme rather than being loosened
   * into a tolerance that would also accept a two-hundred-pixel version of the same fault.
   */
  test.fixme(
    true,
    'styles.css:2570 `.wb { padding: 12px }` 680px altında, ama `.wb > .fm { margin: -14px }` ' +
      '(styles.css:533) onunla birlikte değişmiyor: dosya yöneticisi pencere gövdesinin dolgu ' +
      'kutusunu her iki yandan 2px aşıyor ve sağdaki 2px yatay kaydırmaya dönüşüyor.',
  );

  await signIn(page);
  await openPane(page, 'Dosyalar');

  expect(await tasma(page, '.win .wb'), 'pencere gövdesi').toBeLessThanOrEqual(PAY_PX);
  // And the file manager inside it, which has no overflow of its own: a `.frow` wider than the
  // window is what pushes `.wb` into scrolling, and asking both says which of the two is at fault.
  expect(await tasma(page, '.wb .fm'), 'dosya yöneticisi').toBeLessThanOrEqual(PAY_PX);
});

test('telemetri gelmediğinde kartlar okunamadığını söylüyor, boş sayı göstermiyor', async ({
  page,
  consoleWatch,
}) => {
  // 503 rather than an aborted request, because it is the answer the appliance actually gives when
  // the privileged agent is not running — the ordinary state of a box whose pool has not been
  // created yet. `useSnapshot` turns it into a specific sentence, and a card showing "0 B / 0 B"
  // beside that sentence would be reporting an empty disk on a machine it cannot see.
  await page.route('**/api/v1/system/telemetry', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/problem+json',
      body: JSON.stringify({ title: 'Service Unavailable', status: 503 }),
    }),
  );
  consoleWatch.tolerate(
    /503 \(Service Unavailable\)/,
    'Telemetri 503’ü bu testin kendi kurduğu durum; ölçülen şey arayüzün ona verdiği yanıt.',
  );

  await signIn(page);

  const note = 'Depolama ajanı yanıt vermiyor';
  const side = page.getByRole('complementary', { name: 'Cihaz durumu' });
  await expect(side).toContainText(note);
  // The status line under the greeting reads from the same note, so an operator who only glances
  // at the top of the screen is told as well.
  await expect(page.getByRole('banner')).toContainText(note);

  // Em dashes, not zeroes. This is the assertion the test is named after: `— yük` is "not known",
  // `0,00 yük` is a claim about an idle machine.
  const pills = page.getByRole('banner').locator('.pill');
  await expect(pills.nth(0)).toHaveText('— yük');
  await expect(pills.nth(1)).toHaveText('— bellek');
  await expect(pills.nth(2)).toHaveText('— °C');

  // And nothing numeric survives in the column. `.fig` and `.ring` are the two figure treatments
  // the storage and system cards use, and both sit in the branch that only renders when there is
  // telemetry to render — zero of them is the structural half of the same claim.
  await expect(side.locator('.fig, .ring')).toHaveCount(0);
});
