// Service worker: caches only the static shell files (/static/*, the manifest) so the app survives a
// flaky connection. It never caches API responses, media, or the HTML page (each page carries a fresh
// CSP nonce). Network first, so a deploy is seen on the next load (the server answers 304 when nothing
// changed); the cache answers only when the network fails. Bump VERSION when the file list changes.
const VERSION = 'community-static-v3';
const SHELL = [
  '/static/app.css', '/static/app.js', '/static/controls.js', '/static/core.js', '/static/ui.js',
  '/static/lib/api.js', '/static/lib/b64.js', '/static/lib/brand.js', '/static/lib/dom.js', '/static/lib/e2e.js',
  '/static/lib/format.js', '/static/lib/keystore.js', '/static/lib/ledger.js', '/static/lib/media.js', '/static/lib/places.js', '/static/lib/router.js', '/static/lib/webauthn.js',
  '/static/screens/books.js', '/static/screens/home.js', '/static/screens/join.js', '/static/screens/me.js', '/static/screens/messages.js',
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
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req);
      if (hit) return hit;
      throw err;
    }
  }));
});
