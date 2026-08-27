import { expect, test } from './fixtures.js';

import type { Locator, Page } from '@playwright/test';

/**
 * The setup wizard, on a box nobody has claimed.
 *
 * ── THE FILE NAME ────────────────────────────────────────────────────────────────────────────
 *
 * `setup.kurulum.spec.ts` and not `setup.spec.ts`, because playwright.config.ts routes the wizard
 * by name: the `kurulum` project matches `*.kurulum.spec.ts` and the two browser projects ignore
 * it. A file called `setup.spec.ts` would fall through to `desktop` and `mobile-360`, which point
 * at the CLAIMED stack — the wizard is not there, so every assertion below would run against the
 * sign-in form and say nothing at all about the wizard.
 *
 * ── THE ORDER OF THESE TESTS IS LOAD-BEARING ─────────────────────────────────────────────────
 *
 * The claim is single-shot in the database, so the successful claim is the LAST test in this file
 * and everything that needs an unclaimed box comes before it. Playwright runs a file's tests in
 * declaration order, and the `kurulum` project pins `workers: 1` / `fullyParallel: false` so that
 * order is the real one.
 *
 * The corollary: this file passes ONCE per unclaimed database. A second run needs
 * `bash tools/dev/e2e-stack.sh --reset-setup`, which rebuilds that database and restarts that API.
 */

/** Clears the wizard's `minLength={12}` without looking like a real secret. */
const PAROLA = 'kurulum-parolasi-42';

/**
 * A field, by the caption a person reads — deliberately NOT `getByLabel`.
 *
 * Every field here wraps its input in a `<label>` that also contains the grey `.sub` hint, so an
 * input's accessible name is its caption with the whole hint glued on. Two consequences decided
 * this helper:
 *
 *   - `getByLabel('Parola')` matches "ParolaEn az 12 karakter…" AND "Parola (tekrar)" — two
 *     elements, and a strict-mode violation that reads like the field is missing.
 *   - `getByLabel('E-posta')` MATCHES the username field, because its hint ends "E-posta değil."
 *     A regression test written on `getByLabel` would report the exact bug it exists to rule out,
 *     on a form that does not have it.
 *
 * `normalize-space(text())` takes the label's own direct text node — the caption — and ignores the
 * hint in the nested span.
 */
function alan(page: Page, baslik: string): Locator {
  return page.locator(`xpath=//label[normalize-space(text())="${baslik}"]/input`);
}

/**
 * The sentence in the error notice.
 *
 * `.tx` rather than the alert itself: the notice renders a decorative "!" glyph as a sibling span,
 * so the alert's own text is "!Kurulum tamamlanamadı…" and no assertion about the sentence the
 * product actually shows would read correctly.
 */
function uyari(page: Page): Locator {
  return page.getByRole('alert').locator('.tx');
}

/** The whole form. */
async function formuDoldur(page: Page): Promise<void> {
  await alan(page, 'Cihaz adı').fill('Ev');
  await alan(page, 'Kısa ad').fill('ev');
  await alan(page, 'Kullanıcı adı').fill('serkan');
  await alan(page, 'Parola').fill(PAROLA);
  await alan(page, 'Parola (tekrar)').fill(PAROLA);
}

test.describe('kurulum sihirbazı', () => {
  test.beforeEach(async ({ page, consoleWatch }) => {
    // A REAL DEFECT, tolerated here because this branch may not touch apps/ — reported rather than
    // hidden, and see the `test.fixme` at the bottom of this file.
    //
    // `SetupWizard.tsx` gives the "Kısa ad" input `pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"`.
    // Chrome compiles `pattern` in `v` mode, where a bare `-` at the end of a character class is a
    // syntax error, so the expression does not compile — and the HTML spec says an uncompilable
    // pattern is simply IGNORED. Measured on this stack: with "ge cer siz!!" in the field,
    // `validity.patternMismatch` is false and the form posts. The constraint the attribute claims
    // to impose does not exist.
    //
    // Narrow on purpose. It matches this one message, so any other console error in these tests
    // still fails them.
    consoleWatch.tolerate(
      /Pattern attribute value .* is not a valid regular expression/,
      'apps/web/src/SetupWizard.tsx: the "Kısa ad" pattern does not compile under Chrome\'s v-mode ' +
        'regex, so the browser drops it. Not fixable from this branch.',
    );

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Cihazı kur' })).toBeVisible();
  });

  test('sahiplenilmemiş cihaz sihirbazı açıyor ve tek atımlık olduğunu söylüyor', async ({
    page,
  }) => {
    // Jetonsuz tasarımın iki yükü bu ekranda: ilk kuranın yönetici olacağı AÇIKÇA yazmalı, ve
    // cihazı kurmayan birinin ne yapacağı da (fişi çek, yeniden kur). Bir jeton alanı ya da
    // journalctl komutu görünmemeli — o dünyaya dönüş, bu testin yakalayacağı gerileme.
    await expect(page.getByText('ilk hesap cihazın yöneticisi olur')).toBeVisible();
    await expect(page.getByText('siz kurmadıysanız')).toBeVisible();
    await expect(page.locator('pre')).toHaveCount(0);
    await expect(page.getByText('Kurulum anahtarı')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cihazı sahiplen' })).toBeEnabled();
  });

  test('kullanıcı adı alanının etiketi "E-posta" değil', async ({ page }) => {
    // A regression test. The field was once captioned "E-posta", which made people type an address
    // here and then be refused by a login form that wants a username — a failure that presents as
    // a wrong password and is not one.
    //
    // Read as raw captions rather than through a locator because the claim is about the whole
    // form: no field anywhere on it asks for an address.
    const basliklar = await page
      .locator('form label')
      .evaluateAll((etiketler) =>
        etiketler.map((etiket) => (etiket.childNodes[0]?.textContent ?? '').trim()),
      );

    expect(basliklar).toContain('Kullanıcı adı');
    expect(basliklar.filter((baslik) => baslik.includes('E-posta'))).toEqual([]);

    // And the field means it: `autocomplete="username"` is what stops a password manager offering
    // an email address into a box that will not accept one.
    await expect(alan(page, 'Kullanıcı adı')).toHaveAttribute('autocomplete', 'username');
  });

  /**
   * FIXME — fails today, and the fix is in apps/web/src/SetupWizard.tsx, which this branch owns
   * none of. Written out rather than left as a sentence in a report so it is carried with the
   * suite and turns green by itself the day the attribute is corrected.
   *
   * `pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"` does not compile in Chrome, because `pattern`
   * is compiled with the `v` flag and a bare `-` at the end of `[a-z0-9-]` is a syntax error
   * there. An uncompilable pattern is ignored, so the field has NO client-side constraint at all:
   * "ge cer siz!!" passes `checkValidity()` and posts.
   *
   * Escaping it — `[a-z0-9\-]` — compiles under `v` and restores the check.
   *
   * The consequence is not cosmetic. The slug is the tenant's address; the server rejects a bad
   * one, but it does so after the form has been filled in once and it answers with a message the
   * wizard shows verbatim, instead of the field going red under the box that is wrong.
   *
   * Measured, not deduced: in the same Chromium this suite drives, `new RegExp('^(?:' + attr +
   * ')$', 'v')` throws "Invalid character class" for the attribute as written, `patternMismatch`
   * stays false for "ge cer siz!!", and both come right with the `-` escaped.
   *
   * DECLARED BEFORE THE CLAIM TEST, and that is load-bearing rather than tidy: the wizard
   * only exists while the appliance is unclaimed, so this has to run while that is still
   * true. Measured — placed after the claim it fails, because there is no wizard to read a
   * field off.
   */
  test('kısa ad alanı geçersiz bir kısa adı tarayıcıda reddediyor', async ({ page }) => {
    const kisaAd = alan(page, 'Kısa ad');
    await kisaAd.fill('ge cer siz!!');

    expect(await kisaAd.evaluate((el: HTMLInputElement) => el.validity.patternMismatch)).toBe(true);
  });

  test('iki parola uyuşmazsa istek hiç gönderilmiyor', async ({ page }) => {
    // Counted rather than only asserting the message, because the message alone cannot tell a
    // check that ran in the browser from one the server performed. The server never sees the
    // confirmation field — so if this request goes out at all, the mismatch was not caught.
    let istekSayisi = 0;
    page.on('request', (istek) => {
      if (istek.url().includes('/setup/claim')) istekSayisi += 1;
    });

    await formuDoldur(page);
    await alan(page, 'Parola (tekrar)').fill(`${PAROLA}-baska`);
    await page.getByRole('button', { name: 'Cihazı sahiplen' }).click();

    await expect(uyari(page)).toHaveText('İki parola aynı değil.');
    expect(istekSayisi).toBe(0);

    // Still the wizard: a refused submit must not have navigated anywhere, and the box must
    // still be unclaimed — a claim leaking out here would take the rest of the file with it.
    await expect(page.getByRole('heading', { name: 'Cihazı kur' })).toBeVisible();
  });

  // ── LAST. This claims the box; nothing after it can find an unclaimed one. ──
  test('sahiplenme giriş ekranına götürüyor', async ({ page }) => {
    await formuDoldur(page);
    await page.getByRole('button', { name: 'Cihazı sahiplen' }).click();

    // The wizard hands over to the sign-in form in place, without a reload. Waited on the heading
    // rather than on the wizard disappearing: between the two there is a frame where neither is
    // mounted, and a test that continued there would race the form it is about to assert on.
    await expect(page.getByRole('heading', { name: 'Giriş yap' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Cihazı kur' })).toHaveCount(0);

    // Signed OUT, not signed in. Claiming the box creates the administrator; the account then
    // proves itself the same way it always will — by logging in with its password.
    await expect(page.getByRole('button', { name: 'Alt barı aç' })).toHaveCount(0);

    // The server now says so too. This is what separates "the interface moved on" from "the claim
    // was actually recorded" — the first can happen without the second.
    const durum = await page.request.get('/api/v1/setup/status');
    expect(durum.status()).toBe(200);
    expect(await durum.json()).toEqual({ setupRequired: false });
  });
});
