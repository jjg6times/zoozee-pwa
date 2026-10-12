const CACHE = 'jarvis-remote-v25';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './js/mqtt.js',
  './js/rle.js',
  './js/app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(async (c) => {
      // Bypass the HTTP cache so a new SW version always grabs fresh files
      // (prevents mixed old/new code when the CDN updates files at different times).
      for (const u of ASSETS) {
        const res = await fetch(new Request(u, { cache: 'reload' }));
        await c.put(u, res);
      }
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim()).then(async () => {
      // New SW version: hard-reload open pages so users don't sit on old code.
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      return Promise.all(wins.map((c) => c.navigate(c.url).catch(() => null)));
    })
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Only use the cache for same-origin static assets.
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});