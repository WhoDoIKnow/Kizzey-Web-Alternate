/* Kizzey Web — installable shell, network-first for live files */
const CACHE = 'kizzey-shell-v5';
const SHELL = [
  '/', '/styles.css', '/core.js', '/screens-rpc.js', '/screens-tools.js',
  '/screens-tools2.js', '/screens-social.js', '/screens-social2.js',
  '/screens-settings.js', '/screens-accounts.js', '/login.js', '/app.js', '/icon.png',
  '/icon-512.png', '/icon-fg-512.png', '/manifest.webmanifest'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return;

  event.respondWith(
    fetch(req)
      .then(response => {
        if (response.ok && !url.pathname.startsWith('/api/')) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(req).then(hit => hit || (req.mode === 'navigate' ? caches.match('/') : undefined)))
  );
});
