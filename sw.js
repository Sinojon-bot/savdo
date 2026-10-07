const CACHE = 'savdo-app-v41';
const ASSETS = [
  '/',
  '/index.html',
  '/i18n.js',
  '/app.js',
  '/download.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png'
];

// Always fetch fresh app shell on phones (avoid stuck old login UI).
const NETWORK_ONLY = new Set(['/app.js', '/i18n.js', '/index.html', '/', '/sw.js']);

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;
  if (req.method !== 'GET') return;

  if (NETWORK_ONLY.has(url.pathname)) {
    event.respondWith(
      fetch(req, {cache: 'no-store'}).catch(() => caches.match(req).then(r => r || caches.match('/index.html')))
    );
    return;
  }

  event.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then(r => r || caches.match('/index.html'))
      )
  );
});
