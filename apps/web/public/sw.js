/*
 * A deliberately small service worker.
 *
 * It caches the APP SHELL and nothing else. That is the whole of what is safe to cache here:
 * every other response on this origin is either a tenant's data or a decision the server made
 * about who is asking, and a cache that served either from disk would show one user another
 * user's file listing after a sign-out — a correctness bug wearing an offline feature's clothes.
 *
 * What this buys is what a PWA needs to be installable and to open without a network round trip:
 * the HTML, the bundle and the icon. What it deliberately does not buy is offline file browsing.
 *
 * ── why the bundle is cached at RUNTIME and not precached ──
 *
 * `SHELL_URLS` cannot name the bundle. Vite writes `/assets/index-<hash>.js`, the hash changes on
 * every build, and this file is static — a literal path here would be stale the moment it was
 * written, and `cache.addAll` rejects the whole install if ONE entry 404s. So the install list is
 * the fixed paths, and anything under `/assets/` is cached as it is fetched.
 *
 * That is safe for the same reason it is useful: a hashed filename names one exact byte sequence,
 * so a cached entry can never be stale, and nothing under `/assets/` is a tenant's data or a
 * decision about who is asking. It also means the cache accumulates the assets of every build the
 * appliance has ever served, which is why `ASSET_BUDGET` exists below.
 */

// v2: kabuk listesi degisti (icon.svg gitti, logo dosyalari geldi). Ad degismezse eski onbellek
// oldugu gibi kalir ve tarayici hala olmayan bir dosyayi tutuyor olur.
const SHELL = 'depsis-shell-v2';
// `addAll` ATOMIK: listedeki tek bir URL 404 verirse TAMAMI reddedilir ve kabuk hic onbellege
// alinmaz. icon.svg silindiginde bu liste guncellenmeseydi, uygulama cevrimdisi hic acilmazdi —
// ve bunun hicbir belirtisi olmazdi, cunku cevrimicide her sey calisiyor gorunur.
const SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/logo-32.png',
  '/logo-64.png',
  '/logo-192.png',
];

/**
 * How many hashed assets to keep.
 *
 * This worker's own byte content does not change between builds, so the browser never sees a new
 * version of it and `activate` — where a cache is normally emptied — never runs again. Without a
 * bound, an appliance updated weekly for a year would carry a year of dead bundles.
 *
 * Eviction is oldest-first: `cache.keys()` resolves in insertion order, and the oldest entries are
 * by construction the ones from the builds furthest in the past.
 */
const ASSET_BUDGET = 40;

/** Hashed build output: immutable by name, and never anybody's data. */
function isAsset(url) {
  return url.pathname.startsWith('/assets/');
}

async function keepAsset(request, response) {
  const cache = await caches.open(SHELL);
  await cache.put(request, response);
  const keys = await cache.keys();
  const assets = keys.filter((k) => isAsset(new URL(k.url)));
  for (const stale of assets.slice(0, Math.max(0, assets.length - ASSET_BUDGET))) {
    await cache.delete(stale);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(SHELL_URLS)));
  // Take over immediately rather than waiting for every tab to close. The shell is versioned by
  // cache name, so an update replaces it wholesale instead of mixing two builds.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== SHELL).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Never the API. Not as a cache, not as a fallback, not on a miss.
  if (url.pathname.startsWith('/api/')) return;
  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // Network first, cache as the fallback. The other way round would serve a stale bundle to
  // somebody who has just updated the appliance, and an appliance whose UI silently lags its API
  // is how a version-skew bug becomes unreproducible.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && SHELL_URLS.includes(url.pathname)) {
          const copy = response.clone();
          void caches.open(SHELL).then((cache) => cache.put(request, copy));
        } else if (response.ok && isAsset(url)) {
          void keepAsset(request, response.clone());
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached !== undefined) return cached;
        // A navigation with no network and no cached entry still has to render something.
        if (request.mode === 'navigate') {
          const shell = await caches.match('/index.html');
          if (shell !== undefined) return shell;
        }
        return new Response('Çevrimdışı', {
          status: 503,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }),
  );
});
