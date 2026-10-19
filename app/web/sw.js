// Service worker: caches only the static shell files (/static/*, the manifest) so the app opens fast
// and survives a flaky connection. It never caches API responses, media, or the HTML page (each page
// carries a fresh CSP nonce). Bump VERSION when the file list changes.
const VERSION = 'community-static-v1';
const SHELL = [
  '/static/app.css', '/static/app.js', '/static/core.js', '/static/ui.js',
  '/static/lib/api.js', '/static/lib/b64.js', '/static/lib/brand.js', '/static/lib/dom.js', '/static/lib/e2e.js',
  '/static/lib/format.js', '/static/lib/keystore.js', '/static/lib/media.js', '/static/lib/places.js', '/static/lib/router.js', '/static/lib/webauthn.js',
  '/static/screens/home.js', '/static/screens/join.js', '/static/screens/me.js', '/static/screens/messages.js',
  '/static/screens/safety.js', '/static/screens/spaces.js', '/static/screens/work.js',
  '/manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!(url.pathname.startsWith('/static/') || url.pathname === '/manifest.webmanifest')) return; // API, media, pages: network only
  // Stale-while-revalidate: answer from the cache, refresh it in the background.
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const hit = await cache.match(req);
    const fresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || fresh;
  }));
});
