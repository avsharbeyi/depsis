import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

const HERE = import.meta.dirname;

/**
 * The stack is EXTERNAL, and `webServer` is deliberately not used.
 *
 * Three reasons, in the order they were hit:
 *
 * 1. On a developer box the stack runs inside WSL — it needs PostgreSQL, a Linux node and a
 *    `/mnt/c` checkout — while Playwright runs from Windows. `webServer` spawns a child process of
 *    the test runner, and there is no command Windows can spawn that leaves a working stack behind
 *    on the other side of that boundary. CI happens to be one machine; the developer box is not,
 *    and a harness that only works in CI is a harness nobody runs before pushing.
 *
 * 2. There are two origins, not one — see tools/dev/e2e-stack.sh for why the setup wizard needs a
 *    box nobody has claimed. `webServer` can hold several entries, but the second origin's URL and
 *    the one-time claim token still have to reach the tests through the environment, so the file
 *    below would exist either way.
 *
 * 3. `webServer` reports a stack that failed to come up as a timeout. The script prints the
 *    migration error, or the build error, or the refused claim, on the CI step that ran it.
 *
 * So the CI step runs `bash tools/dev/e2e-stack.sh` and this config reads what it wrote.
 */
function loadStackEnv(): void {
  const file = join(HERE, '.env.stack');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const split = trimmed.indexOf('=');
    if (split <= 0) continue;
    const key = trimmed.slice(0, split);
    // A real environment variable wins over the file. That is what lets CI point the suite at a
    // stack it brought up differently without editing anything.
    if (process.env[key] !== undefined) continue;
    process.env[key] = trimmed.slice(split + 1);
  }
}

loadStackEnv();

const BASE_URL = process.env.DEPSIS_E2E_BASE_URL ?? 'http://127.0.0.1:3210';
const SETUP_BASE_URL = process.env.DEPSIS_E2E_SETUP_BASE_URL ?? 'http://127.0.0.1:3211';

/**
 * The wizard's specs, by name.
 *
 * They are the only ones that run against the unclaimed stack, and they must run exactly once: the
 * claim is one-time in the database AND in the API process's memory, so a second project running
 * the same spec would find a box that had already been set up and fail for a reason that has
 * nothing to do with the interface. Naming them here rather than tagging them keeps the decision
 * in one place instead of depending on every future spec remembering a tag.
 */
const WIZARD_SPECS = '**/*.kurulum.spec.ts';

export default defineConfig({
  testDir: HERE,
  testMatch: '**/*.spec.ts',

  // `test.only` left in a file turns the rest of that file off. Locally that is a useful shortcut;
  // on CI it is a suite that reports green having run one test.
  forbidOnly: process.env.CI !== undefined,

  /**
   * `workers` is left at Playwright's default — half the cores — and that is right for CI, where a
   * runner has two or four of them. On a developer box it can be too many, and the failure has a
   * recognisable shape: tests stop on `Yükleniyor…` or on a disabled "Giriş yapılıyor…" button,
   * scattered across files, never the same ones twice. That is not flakiness in the product. The
   * stack runs inside WSL off /mnt/c — a Windows filesystem reached over 9p — and eight browsers
   * plus two Nest processes plus PostgreSQL plus the agent saturate it; measured here, sixteen
   * cores gave eight workers, seven such stops, and a clean run at three.
   *
   * So it is a flag and not a setting: `pnpm test:e2e -- --workers=3`. Pinning it in the config
   * would slow CI down to hide a property of one machine.
   */

  // No retries, on purpose. A test that passes on the second attempt is a test that failed, and a
  // retry turns that into a green tick with a footnote nobody reads. This suite drives a stack on
  // one machine with no network in it — there is no flakiness here that is not a real defect, in
  // the product or in the test, and either way it should be looked at rather than papered over.
  retries: 0,

  // The appliance boots off /mnt/c on a developer box, where a first paint can take several
  // seconds. 30s is Playwright's default and it expired on the sign-in test before the bundle had
  // parsed.
  timeout: 60_000,
  expect: { timeout: 10_000 },

  /**
   * The JSON report is not for a human; it is what the CI job reads to prove the suite ran.
   *
   * A Playwright run that matched no files exits 0 and prints "no tests found" — which is a green
   * tick over zero measurements, the exact failure the `migrations` job's skip gate exists to
   * refuse. `.github/workflows/ci.yml` parses this file and fails on an empty run, and on a run
   * where either browser project contributed nothing.
   *
   * It is written OUTSIDE the working tree on CI (`$RUNNER_TEMP`), because a JSON file dropped
   * into the repository is a file `pnpm format:check` then reports as unformatted.
   */
  reporter: [
    ...(process.env.CI !== undefined ? [['github'] as const] : []),
    ['list'] as const,
    ['html', { open: 'never' }] as const,
    ...(process.env.DEPSIS_E2E_JSON_REPORT !== undefined
      ? [['json', { outputFile: process.env.DEPSIS_E2E_JSON_REPORT }] as const]
      : []),
  ],

  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The interface is Turkish end to end, including its date and number formatting. A browser
    // claiming en-US would make every assertion about a formatted figure a test of the runner's
    // locale rather than of the product.
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
  },

  projects: [
    {
      name: 'desktop',
      testIgnore: WIZARD_SPECS,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: BASE_URL,
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      // 360x740, which is where the stylesheet's `max-width: 680px` rules take over and where the
      // dock, the window chrome and the file table have to survive a thumb rather than a pointer.
      name: 'mobile-360',
      testIgnore: WIZARD_SPECS,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: BASE_URL,
        viewport: { width: 360, height: 740 },
        // Both, and they are not the same claim: `isMobile` turns on the mobile viewport meta
        // handling, `hasTouch` is what makes the pointer events touch events. A layout tested at
        // 360px with a mouse would miss every hover-only affordance, which is the class of bug
        // this project exists to catch.
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      },
    },
    {
      // The unclaimed box. A project of its own rather than a fixture, because the difference is
      // the ORIGIN the browser opens — and baseURL is a project setting.
      name: 'kurulum',
      testMatch: WIZARD_SPECS,
      // One at a time. Both specs in this project share one API process holding one live token,
      // so running two in parallel means one of them races the other's claim.
      fullyParallel: false,
      workers: 1,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: SETUP_BASE_URL,
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
});
