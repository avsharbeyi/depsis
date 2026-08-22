import type { Locator, Page } from '@playwright/test';

import { closePane, expect, openPane, signIn, test, type ConsoleWatch } from './fixtures.js';

/**
 * The browser half of §20's access-control acceptance tests.
 *
 * The server half is already covered by the API integration suite: every route under
 * `AdminGuard` refuses a member, and that is what actually protects the appliance. What no
 * server-side test can see is whether the INTERFACE tells the truth about those decisions — and
 * the two ways it can lie are opposite.
 *
 * It can offer a member something they cannot have, which turns a locked door into a broken
 * button. Or it can fall over when a member reaches an admin address by typing it, which turns a
 * refusal into a white screen with no way back. Both are tested here, and neither is visible from
 * the other side of the wire.
 *
 * THIS FILE LEAVES ACCOUNTS BEHIND, and that is a limitation rather than an oversight. Every test
 * creates a member and nothing removes one, because the product does not offer removal — an
 * administrator can disable an account, which is a different thing on purpose (§20: an account is
 * an audit subject and a disabled one still owns its rows). So a full local run adds eight accounts
 * to `depsis_e2e`, two per test across the two projects, and running `pnpm test:e2e` repeatedly
 * against one stack accumulates them without bound. They are harmless — `yeniUyeAdi()` cannot
 * collide, and no assertion here counts rows — but a stack that has been run against all afternoon
 * has a long user list. CI is unaffected: `e2e-stack.sh` drops and rebuilds both databases every
 * time. Locally, bring the stack up again when the list gets in the way.
 */

/** Long enough for the server's twelve-character floor, and it is written down here rather than
 *  generated so a failure screenshot shows a password the reader can retype by hand. */
const UYE_PAROLA = 'uye-parola-2026';
const YENI_PAROLA = 'uye-yeni-parola-2026';

/**
 * See `shell.spec.ts` for the long version: the desk asks `/me` before it knows whether anybody is
 * signed in, and Chromium writes the honest 401 to the console as a resource error.
 *
 * This file signs in and out repeatedly, so it produces one of these per sign-in screen rather
 * than one per test.
 */
test.beforeEach(({ consoleWatch }) => {
  consoleWatch.tolerate(
    /401 \(Unauthorized\)/,
    'Oturum açılmadan önce /me sorulur ve 401 döner; tarayıcı her 4xx yanıtı konsola yazar.',
  );
});

/**
 * A username no other run of this suite will pick.
 *
 * The stack is not rebuilt between tests and both projects drive the same database, so a fixed
 * name would collide with itself the second time anything ran — as a 409 on the create form,
 * reported as "the interface cannot create a member", which is the wrong diagnosis entirely.
 *
 * Constrained to the contract's `CreateUserRequest.username` pattern: it has to start
 * alphanumeric, and `.`, `-` and `_` are the only punctuation allowed.
 */
function yeniUyeAdi(): string {
  return `uye${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Sign in as the administrator and create a member THROUGH THE INTERFACE.
 *
 * Deliberately not seeded over the API. Creating an account is the one administrative action the
 * whole of §20 rests on, and a suite that reached past the form to set it up would leave the form
 * itself untested while appearing to exercise the permission model built on top of it.
 *
 * Leaves the browser signed in as the administrator; a test that needs the member signs out first.
 */
async function uyeOlustur(page: Page): Promise<{ username: string; password: string }> {
  const username = yeniUyeAdi();

  await signIn(page);
  const pencere = await openPane(page, 'Kullanıcılar');

  await pencere.getByLabel('Kullanıcı adı').fill(username);
  // `/^Parola/` rather than the exact string. These fields are wrapped in a `<label>` that also
  // holds the hint underneath them, so the accessible name of the password box is the whole of
  // "Parola En az 12 karakter. Karışım kuralı yok; uzunluk yeterli." — an exact match finds
  // nothing, and the failure reads as a missing field rather than a longer name than expected.
  await pencere.getByLabel(/^Parola/).fill(UYE_PAROLA);
  // Anchored, and for a reason worth writing down: `getByLabel` with a plain string matches a
  // substring case-insensitively, and "Rol" is inside "paROLa". The string form of this locator
  // resolves to the password box as well as the select.
  await pencere.getByLabel(/^Rol/).selectOption('member');
  await pencere.getByRole('button', { name: 'Oluştur' }).click();

  // The toast is the confirmation the product itself gives. Waiting for the new row instead would
  // pass on a form that silently succeeded without telling the person who filled it in.
  //
  // `.last()` because toasts stack and linger for several seconds, so an earlier one is still on
  // screen when the next action finishes — and an unqualified `getByRole('status')` then fails
  // strict mode with a message about two elements rather than about the product.
  await expect(page.getByRole('status').last()).toContainText(`"${username}" oluşturuldu.`);
  await expect(uyeSatiri(pencere, username)).toBeVisible();

  await closePane(page);
  return { username, password: UYE_PAROLA };
}

/** One account's row in the user list, found by the name printed in it. */
function uyeSatiri(pencere: Locator, username: string): Locator {
  return pencere.locator('.urow').filter({ hasText: username });
}

/**
 * A member's desk polls `/system/telemetry` and is refused, forever, by design.
 *
 * `SystemController.telemetry` asks `isSystemAdministrator` — the one account recorded in
 * `system_setup` — so a member gets 403 every ten seconds for as long as the desk is open, and
 * `useSnapshot` turns each one into "Sistem ayrıntıları yalnız cihazı kuran hesaba açık." rather
 * than an error. The interface is behaving correctly; Chromium is simply logging every 4xx.
 *
 * Tolerated per test rather than for the whole file: the administrator tests below must still
 * fail if anything they touch starts answering 403.
 */
function uyeTelemetrisiReddedilir(consoleWatch: ConsoleWatch): void {
  consoleWatch.tolerate(
    /403 \(Forbidden\)/,
    'Üyenin masaüstü /system/telemetry’yi yoklar ve 403 alır; arayüz bunu bir nota çevirir.',
  );
}

async function cikisYap(page: Page): Promise<void> {
  const guc = page.getByRole('button', { name: 'Güç' });
  await guc.click();

  // `aria-expanded` on the button, asserted for its own sake and not as a guard on the click below.
  // The click needs no guard: `.pmenu` is `display: none` until `.on` (styles.css:1208, 1215), so a
  // closed menu's entries are unreachable and Playwright's actionability check waits for the menu
  // to open by itself. What this line adds is the other half — that the state a screen reader is
  // told matches the state the sighted reader can see. auth.spec.ts's logout test omits it because
  // it is testing the way out, not the announcement, and the two files agree about why.
  await expect(guc).toHaveAttribute('aria-expanded', 'true');

  await page.getByRole('button', { name: 'Çıkış yap' }).click();
  await expect(page.getByRole('button', { name: 'Giriş yap' })).toBeVisible();
}

/* ─── what a member is offered ──────────────────────────────────────────────── */

test('üye alt barda yönetici panellerini görmüyor', async ({ page, consoleWatch }) => {
  uyeTelemetrisiReddedilir(consoleWatch);
  const uye = await uyeOlustur(page);
  await cikisYap(page);
  await signIn(page, uye.username, uye.password);

  const badge = page.getByRole('button', { name: 'Alt barı aç' });
  await badge.click();
  const altBar = page.getByRole('navigation', { name: 'Uygulamalar' });
  await expect(altBar.getByRole('button', { name: 'Dosyalar', exact: true })).toBeVisible();

  // Absent, not disabled and not present-but-403. `PANES[...].adminOnly` filters the dock, and the
  // reason it filters rather than greys out is that every route behind these three is refused for
  // a member end to end — an entry that can only ever produce a refusal is a button that lies
  // about what the appliance can do for the person pressing it.
  for (const label of ['Kullanıcılar', 'Konsol', 'Yedekleme']) {
    await expect(
      altBar.getByRole('button', { name: label, exact: true }),
      `üyeye "${label}" gösterilmemeli`,
    ).toHaveCount(0);
  }

  // The ordinary panes are still there. Without this the test would also pass against a dock that
  // rendered nothing at all.
  for (const label of ['Paylaşımlar', 'Notlar', 'Hesabım']) {
    await expect(altBar.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
});

test('üye yönetici adresine doğrudan girdiğinde masaüstü ayakta kalıyor', async ({
  page,
  consoleWatch,
}) => {
  uyeTelemetrisiReddedilir(consoleWatch);
  const uye = await uyeOlustur(page);
  await cikisYap(page);
  await signIn(page, uye.username, uye.password);

  // A fresh load carrying the hash, which is the case a bookmark or a pasted link produces — and
  // the one that goes through `paneFromHash()` on mount rather than through the dock.
  await page.goto('/#/kullanicilar');

  // What the application does, established by reading `Desktop`: the pane is dropped and the desk
  // is drawn without it. No redirect and no 403 screen. That is a defensible choice — pretending
  // the window exists in order to refuse it teaches the member nothing — but the choice only holds
  // if the desk behind it is genuinely there, so this asserts the desk rather than the absence.
  await expect(page.getByRole('button', { name: 'Alt barı aç' })).toBeVisible();
  await expect(page.getByRole('banner')).toContainText(uye.username);
  await expect(page.locator('.tiles')).toBeVisible();

  // No window, admin or otherwise. `Kullanıcılar` rendered for a member would 403 on its first
  // read and show "Hesaplar okunamadı." — a refusal dressed as a fault.
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // And the desk is still working, not merely painted: the dock opens and an ordinary pane comes
  // up. A frozen shell looks identical to a live one in a screenshot.
  await openPane(page, 'Notlar');

  // The console watch closes this test. A blank screen and an unhandled throw are the two failures
  // this case is really about, and neither is visible in the assertions above.
});

test('üye kendi parolasını değiştirebiliyor', async ({ page, consoleWatch }) => {
  uyeTelemetrisiReddedilir(consoleWatch);
  const uye = await uyeOlustur(page);
  await cikisYap(page);
  await signIn(page, uye.username, uye.password);

  const pencere = await openPane(page, 'Hesabım');
  await pencere.getByLabel('Mevcut parola').fill(uye.password);
  // Same wrapping-label problem as the create form, with a second twist: "Yeni parola" is a prefix
  // of "Yeni parola (tekrar)", so a plain substring match resolves to both boxes and fails strict
  // mode. The lookahead is what separates the two without depending on the hint's exact wording.
  await pencere.getByLabel(/^Yeni parola(?! \(tekrar\))/).fill(YENI_PAROLA);
  await pencere.getByLabel('Yeni parola (tekrar)').fill(YENI_PAROLA);
  await pencere.getByRole('button', { name: 'Parolayı değiştir' }).click();

  await expect(page.getByRole('status').last()).toContainText('Parola değişti');

  // The window stays open after a successful change — the person may want to read the toast — and
  // its backdrop covers the whole desk, the power button with it. Closing it here is what the
  // person would do, not a workaround.
  await closePane(page);

  // The toast is the product's claim; this is the proof. A screen that reported success and left
  // the old password in place would pass every assertion above it, and the failure would only
  // surface the next time somebody tried to sign in — which is the worst possible moment.
  await cikisYap(page);
  await signIn(page, uye.username, YENI_PAROLA);
  await expect(page.getByRole('banner')).toContainText(uye.username);
});

/* ─── what an administrator is asked ────────────────────────────────────────── */

test('üyeyi devre dışı bırakma onayı hesabın adını gösteriyor', async ({ page }) => {
  const uye = await uyeOlustur(page);

  const pencere = await openPane(page, 'Kullanıcılar');
  const satir = uyeSatiri(pencere, uye.username);
  await expect(satir).toContainText('etkin');

  await satir.getByRole('button', { name: 'Devre dışı bırak' }).click();

  // `role="alertdialog"`, which is a different role from the pane's `dialog` — so this locator
  // cannot accidentally resolve to the window underneath it.
  const onay = page.getByRole('alertdialog');
  await expect(onay).toBeVisible();

  // The name, in the box, before the click. A destructive confirmation that says "this account"
  // is a confirmation that gets answered without reading, and the account it destroys is whichever
  // row the pointer happened to be on.
  await expect(onay).toContainText(uye.username);
  await expect(onay).toContainText('Hesap silinmiyor.');

  await onay.getByRole('button', { name: 'Devre dışı bırak' }).click();

  await expect(page.getByRole('status').last()).toContainText(`"${uye.username}" devre dışı.`);
  // Re-read from the server, not from optimistic local state: `patch` reloads the list, and the
  // pill is where an administrator checks that the change actually landed.
  await expect(uyeSatiri(pencere, uye.username)).toContainText('devre dışı');
});
