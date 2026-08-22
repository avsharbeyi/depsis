import { admin, closePane, expect, openPane, signIn, test } from './fixtures.js';

import type { Locator, Page } from '@playwright/test';

/**
 * Signing in, and everything that has to keep being true about not being signed in.
 *
 * Runs in both browser projects against the CLAIMED stack, so every test here starts from a fresh
 * context with no cookie — Playwright gives each test its own, which is what makes "no session"
 * the default state rather than something a test has to arrange.
 */

/**
 * The sentence in a notice.
 *
 * `.tx` rather than the alert itself: the notice puts a decorative "!" glyph in a sibling span, so
 * the alert's own text is "!Kullanıcı adı veya parola hatalı." — and the whole subject of the
 * refusal test is comparing two sentences character for character.
 */
function uyari(page: Page): Locator {
  return page.getByRole('alert').locator('.tx');
}

/** The brand mark in the corner. It only exists once there is a session, so it is what "the desk
 *  is up" means throughout this file — the galaxy is not, see the note in the first test. */
function masaustu(page: Page): Locator {
  return page.getByRole('button', { name: 'Alt barı aç' });
}

function girisBasligi(page: Page): Locator {
  return page.getByRole('heading', { name: 'Giriş yap' });
}

/** One failed attempt at the sign-in form, left on the screen for the caller to read. */
async function basarisizGiris(page: Page, username: string, password: string): Promise<void> {
  await page.getByLabel('Kullanıcı adı').fill(username);
  await page.getByLabel('Parola', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Giriş yap' }).click();
}

/**
 * Every test in this file, including the ones where nothing goes wrong, produces one 401.
 *
 * It is how the application decides which screen to show: the session cookie is HttpOnly, so the
 * only way to learn whether there is a session is to call `GET /me` and be refused. Chrome logs
 * that refusal as a console error, and a suite starting from a fresh context hits it on the first
 * paint of every test.
 *
 * Tolerated here rather than in each test because the justification is the same one five times,
 * and narrowed to the status code so that any other console error — a thrown effect, a 500, a
 * rejected promise — still fails the test it happened in. The screens themselves are asserted on
 * directly below, so a 401 that arrived from somewhere it should not have still shows up as a
 * missing desk rather than passing quietly.
 */
test.beforeEach(({ consoleWatch }) => {
  consoleWatch.tolerate(
    /Failed to load resource.*401/,
    'GET /me is refused whenever there is no session yet — that refusal is how the app chooses ' +
      'between the desk and the sign-in form, and two of the tests below refuse a login on purpose.',
  );
});

test('doğru bilgilerle giriş masaüstünü açıyor', async ({ page }) => {
  await signIn(page);

  await expect(masaustu(page)).toBeVisible();
  await expect(girisBasligi(page)).toHaveCount(0);

  // The galaxy. Asserted alongside the brand mark and never instead of it: `SignIn` mounts the
  // same `<Sky mode="sky">`, so the canvas is on screen before anyone has logged in and proves
  // nothing on its own. What it does prove is that the desk's background actually mounted — a
  // failed 2d context or a thrown effect leaves the element out entirely.
  await expect(page.locator('canvas#sky')).toBeVisible();
});

test('yanlış parola kullanıcının var olup olmadığını sızdırmıyor', async ({ page }) => {
  await page.goto('/');

  // A real account with the wrong password.
  await basarisizGiris(page, admin.username, 'bu-parola-dogru-degil');
  await expect(uyari(page)).toBeVisible();
  const varOlanHesap = await uyari(page).innerText();

  // Exactly one. A second notice — a field-level hint, a toast — would be the leak arriving by
  // another route even if this sentence stayed generic.
  await expect(page.getByRole('alert')).toHaveCount(1);
  expect(varOlanHesap).toBe('Kullanıcı adı veya parola hatalı.');

  // A name that does not exist on this box. Same form, same submit, and the answer must be
  // indistinguishable: the server deliberately refuses both the same way, and an interface that
  // said "no such user" here would hand back the account enumeration the server just refused to
  // give. The username also has to be one nobody seeded — hence the nonsense.
  await page.reload();
  await basarisizGiris(page, 'boyle-bir-hesap-yok', 'bu-parola-dogru-degil');
  await expect(uyari(page)).toBeVisible();
  const olmayanHesap = await uyari(page).innerText();

  expect(olmayanHesap).toBe(varOlanHesap);

  // Neither attempt let anyone in.
  await expect(masaustu(page)).toHaveCount(0);
  await expect(girisBasligi(page)).toBeVisible();
});

test('kullanıcı adındaki baştaki ve sondaki boşluk kırpılıyor', async ({ page }) => {
  // A regression test, and it cost three rounds of instrumentation the first time. A username with
  // a space around it fails the server's format check and comes back as the SAME refusal as a
  // wrong password — so the person at the keyboard sees "parola hatalı", retypes the password they
  // know is right, and gets it again. The invisible character is the one thing the screen cannot
  // show them.
  await page.goto('/');

  const kullaniciAdi = page.getByLabel('Kullanıcı adı');
  await kullaniciAdi.fill(` ${admin.username} `);

  // Trimmed as it is typed, not on submit. Asserted separately because it is the visible half of
  // the fix: a form that only trimmed on submit would still show the user a value with a space in
  // it and leave them unsure what was sent.
  await expect(kullaniciAdi).toHaveValue(admin.username);

  await page.getByLabel('Parola', { exact: true }).fill(admin.password);
  await page.getByRole('button', { name: 'Giriş yap' }).click();

  await expect(masaustu(page)).toBeVisible();
});

test('çıkış giriş ekranına döndürüyor ve geri tuşu oturumu geri getirmiyor', async ({ page }) => {
  await signIn(page);

  // Two history entries before the logout, both made by the product itself: opening a pane writes
  // `#/notlar` and closing it writes `#/`. Without them `goBack()` would leave the origin entirely
  // and the test would be about the browser's blank page, not about the appliance.
  await openPane(page, 'Notlar');
  await closePane(page);

  await page.getByRole('button', { name: 'Güç' }).click();
  await page.getByRole('button', { name: 'Çıkış yap' }).click();

  await expect(girisBasligi(page)).toBeVisible();
  await expect(masaustu(page)).toHaveCount(0);

  // The back button. The desk was on screen at the previous history entry, and a bfcache restore
  // or a component that kept its state would put it back — with no session behind it, which is the
  // shape of every "I logged out on a shared machine" report.
  await page.goBack();
  await expect(girisBasligi(page)).toBeVisible();
  await expect(masaustu(page)).toHaveCount(0);

  // And a full reload from that same restored address, which is the version of the same gesture
  // that goes all the way back to the server. This is the assertion that says the cookie is gone
  // rather than merely ignored by a React state that happened to survive.
  await page.reload();
  await expect(girisBasligi(page)).toBeVisible();
  await expect(masaustu(page)).toHaveCount(0);
});

test('oturum yokken doğrudan #/dosyalar açmak giriş ekranını gösteriyor', async ({ page }) => {
  // A deep link is how somebody arrives from a bookmark, and the pane address is a real address —
  // `location.hash` is the router. The screen behind it must still be decided by the session and
  // not by the fragment.
  await page.goto('/#/dosyalar');

  await expect(girisBasligi(page)).toBeVisible();
  await expect(masaustu(page)).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Dosyalar' })).toHaveCount(0);

  // The fragment survives — the app does not rewrite the address, so signing in from here still
  // lands on the pane that was asked for. Asserted so that a future "redirect to /" would be a
  // deliberate change rather than a silent one.
  expect(new URL(page.url()).hash).toBe('#/dosyalar');
});
