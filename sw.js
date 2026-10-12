const CACHE = 'jarvis-remote-v30';
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
      // Bypass the HTTP cache so a new SW version always grabs fresh files.
      for (const u of ASSETS) {
        try {
          const res = await fetch(new Request(u, { cache: 'reload' }));
          await c.put(u, res);
        } catch (err) { /* keep going; network-first below will fill in */ }
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

// Network-first (revalidating) so online users ALWAYS get the latest app shell;
// fall back to the cache only when offline. This prevents the app from getting
// stuck on a stale rle.js/app.js after a deploy.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
  );
});
