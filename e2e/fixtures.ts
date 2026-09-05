import { test as base, expect, type Locator, type Page } from '@playwright/test';

/**
 * What every spec imports instead of `@playwright/test`.
 *
 * The extra thing it carries is the console watch below. Everything else here is a helper for the
 * two gestures that come before any assertion worth making: getting a session, and opening a pane.
 */

/* ─── the console watch ─────────────────────────────────────────────────────── */

export interface ConsoleWatch {
  /**
   * Accept one kind of console error for this test.
   *
   * `why` is not decoration and is not optional. A tolerated error is a defect somebody decided
   * not to fix today, and the sentence is how the next reader tells that apart from a tolerance
   * added to make a red test go green.
   */
  tolerate(pattern: RegExp, why: string): void;
  /** What has been seen so far, for a test that wants to assert on it directly. */
  readonly seen: readonly string[];
}

/**
 * A page that logs an error or throws past React is a page that is lying about working.
 *
 * This is the cheapest assertion in the suite and the one that catches the most: a screen renders,
 * the text is right, the button is there — and behind it a request 500s, a promise rejects, or a
 * component throws inside an effect. A human eye misses that every time, and so does a test that
 * only looks at what is on screen.
 *
 * It is an auto FIXTURE rather than a `beforeEach`, and the difference matters: a `beforeEach` can
 * only arm the listener, and the assertion has to happen AFTER the test body. A fixture's teardown
 * half is the only hook that runs there for every test, including one that failed.
 */
const consoleWatchFixture = async (
  { page }: { page: Page },
  use: (watch: ConsoleWatch) => Promise<void>,
): Promise<void> => {
  const errors: string[] = [];
  const tolerated: { pattern: RegExp; why: string }[] = [];
  /**
   * Küçük resmi 404 ile cevaplanan istek sayısı — ve neden ayrı sayılıyor.
   *
   * ── PAYLAŞILAN SUNUCU, YARIŞAN İŞÇİLER ──────────────────────────────────────────────────
   *
   * Bütün Playwright işçileri TEK bir API'ye bakıyor, ve giriş yapan her sayfanın ana ekranı
   * "son değişenler" listesini çekip her satır için gömülü küçük resmi soruyor. Bir işçinin o
   * listede gördüğü dosyayı başka bir işçi iki saniye sonra silebiliyor: istek yola çıktığında
   * satır vardı, ulaştığında yoktu, ve uç doğru cevabı veriyor — 404, "böyle bir girdi yok".
   *
   * Tarayıcı her 4xx'i konsola yazdığı için bu, hiçbir şeyle ilgisi olmayan bir testi düşürüyordu:
   * işler panosunu ölçen bir test, başka bir testin sildiği bir fotoğraf yüzünden kırmızı oluyor.
   *
   * TOLERANS DESENLE YAZILAMIYOR, çünkü konsol satırının metninde adres yok — yalnız "status of
   * 404". Desenle yazmak, o testteki BÜTÜN 404'leri hoş görmek olurdu. Bu yüzden cevabın kendisi
   * dinleniyor: yalnız küçük resim ucundan gelmiş bir 404, ve her biri yalnız BİR konsol satırını
   * karşılıyor.
   *
   * Ucun sözleşmesi bundan etkilenmiyor: küçük resmi olmayan bir dosya hâlâ 204 dönmek zorunda ve
   * `thumbnails.spec.ts` bunu 204 cevabını AÇIKÇA bekleyerek ölçüyor.
   */
  let staleThumbnails = 0;
  page.on('response', (answer) => {
    if (answer.status() === 404 && answer.url().includes('/thumbnail')) staleThumbnails += 1;
  });

  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    errors.push(`console.error: ${message.text()}`);
  });
  // Separate from the above and not merged into it: an uncaught exception never reaches
  // `console.error` unless something logs it, and React's error boundary swallows the ones it
  // catches. This is the only way a throw inside a render or an effect becomes visible here.
  page.on('pageerror', (error) => {
    errors.push(`pageerror: ${error.message}`);
  });

  const watch: ConsoleWatch = {
    tolerate(pattern, why) {
      tolerated.push({ pattern, why });
    },
    get seen() {
      return errors;
    },
  };

  await use(watch);

  const unexplained = errors.filter((line) => {
    if (tolerated.some(({ pattern }) => pattern.test(line))) return false;
    if (staleThumbnails > 0 && /status of 404/.test(line)) {
      staleThumbnails -= 1;
      return false;
    }
    return true;
  });
  if (unexplained.length === 0) return;

  throw new Error(
    `Sayfa ${unexplained.length} konsol hatası üretti:\n` +
      unexplained.map((line) => `  ${line}`).join('\n'),
  );
};

export const test = base.extend<{ consoleWatch: ConsoleWatch }>({
  consoleWatch: [consoleWatchFixture, { auto: true }],
});

export { expect };

/* ─── credentials ───────────────────────────────────────────────────────────── */

/**
 * The account tools/dev/e2e-stack.sh seeded on the main stack.
 *
 * Read from the environment rather than hard-coded, because the script accepts overrides and a
 * second copy of the default here is a second place to change when it moves.
 */
export const admin = {
  username: process.env.DEPSIS_E2E_ADMIN_USERNAME ?? 'e2eyonetici',
  password: process.env.DEPSIS_E2E_ADMIN_PASSWORD ?? 'depsis-e2e-parola-42',
} as const;

/* ─── the desk ──────────────────────────────────────────────────────────────── */

/** The brand mark in the corner, which is also the button that opens the dock. */
function brandBadge(page: Page): Locator {
  return page.getByRole('button', { name: 'Alt barı aç' });
}

/**
 * Sign in and wait for the desk.
 *
 * `page.goto('/')` rather than a deep link: the application decides between the wizard, the sign-in
 * form and a live session by asking `/setup/status` and `/me` on mount, so landing on the root is
 * the only entry that exercises that decision.
 *
 * The wait is on the brand badge, not on the form disappearing. Between the two there is a moment
 * where the desk is mounted and `/me` has not answered — a test that continued there would race
 * every pane it opened.
 */
export async function signIn(
  page: Page,
  username: string = admin.username,
  password: string = admin.password,
): Promise<void> {
  await page.goto('/');

  await page.getByLabel('Kullanıcı adı').fill(username);
  await page.getByLabel('Parola', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Giriş yap' }).click();

  await expect(brandBadge(page)).toBeVisible();
}

/**
 * Open a pane from the dock and wait for its window.
 *
 * `name` is the Turkish label on the dock button — 'Dosyalar', 'Kullanıcılar', 'Konsol' — because
 * that is what a person reading a failure sees on the screenshot beside it.
 *
 * The dock is a toggle, so this checks whether it is already open instead of clicking blindly. A
 * second click closes it, and the resulting "button not found" names the wrong problem.
 */
export async function openPane(page: Page, name: string): Promise<Locator> {
  const badge = brandBadge(page);
  await expect(badge).toBeVisible();

  if ((await badge.getAttribute('aria-expanded')) !== 'true') {
    await badge.click();
  }

  const dock = page.getByRole('navigation', { name: 'Uygulamalar' });
  await dock.getByRole('button', { name, exact: true }).click();

  // Located by its accessible name, which the window takes from its title. `getByRole('dialog')`
  // alone would also match a confirmation box left open by a previous step.
  const window = page.getByRole('dialog', { name });
  await expect(window).toBeVisible();
  return window;
}

/**
 * Close the open pane and wait for it to actually go.
 *
 * Scoped to the window's own header, because 'Kapat' is a label several panes use on buttons of
 * their own — an unscoped locator resolves to more than one element and fails with a strict-mode
 * violation that says nothing about what the test was doing.
 */
export async function closePane(page: Page): Promise<void> {
  const window = page.getByRole('dialog');
  await window.getByRole('button', { name: 'Kapat', exact: true }).first().click();
  await expect(window).toHaveCount(0);
}

/**
 * A pane that is not in the dock for this account is not a pane this account has.
 *
 * Useful to a member-role test: `PANES[...].adminOnly` hides the console, the account list and
 * backups entirely rather than offering them and answering 403, and asserting the absence is how
 * that stays true.
 */
export async function dockLabels(page: Page): Promise<string[]> {
  const badge = brandBadge(page);
  if ((await badge.getAttribute('aria-expanded')) !== 'true') {
    await badge.click();
  }
  const dock = page.getByRole('navigation', { name: 'Uygulamalar' });
  await expect(dock.getByRole('button').first()).toBeVisible();
  return dock.getByRole('button').allInnerTexts();
}
