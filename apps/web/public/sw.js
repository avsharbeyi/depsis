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
 */

const SHELL = 'depsis-shell-v1';
const SHELL_URLS = ['/', '/index.html', '/icon.svg', '/manifest.webmanifest'];

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
