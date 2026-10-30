/* Kizzey Web — installable shell, network-first for live files.
   BUILD is the single cache-generation knob: bump it and the worker script
   bytes change, so every browser installs the new worker, purges the old
   shell cache, and reloads the open windows onto it. */

const BUILD = 'v9';
const CACHE = 'kizzey-shell-' + BUILD;

const SHELL = [
  '/',
  '/styles.css?b=' + BUILD,
  '/core.js?b=' + BUILD,
  '/screens-rpc.js?b=' + BUILD,
  '/screens-tools.js?b=' + BUILD,
  '/screens-tools2.js?b=' + BUILD,
  '/screens-social.js?b=' + BUILD,
  '/screens-social2.js?b=' + BUILD,
  '/screens-settings.js?b=' + BUILD,
  '/screens-accounts.js?b=' + BUILD,
  '/login.js?b=' + BUILD,
  '/app.js?b=' + BUILD,
  '/icon.png',
  '/icon-512.png',
  '/icon-fg-512.png',
  '/manifest.webmanifest?b=' + BUILD,
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(cache => cache.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      // Purge every cache that is not this generation. On a real upgrade from
      // an older shell this is what removes the stale OAuth-era bundle.
      const keys = await caches.keys();
      const stale = keys.filter(key => key !== CACHE);
      const upgraded = stale.length > 0;
      await Promise.all(stale.map(key => caches.delete(key)));

      await self.clients.claim();

      // A page that is still running the pre-upgrade bundle has to be reloaded
      // before it can pick up the new one — its own registration code is old.
      if (upgraded) {
        const windows = await self.clients.matchAll({ type: 'window' });
        await Promise.all(
          windows.map(client => {
            if (!client.navigate) return undefined;
            return client.navigate(client.url).catch(() => {});
          })
        );
      }
    })()
  );
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return;

  // Documents always come from the server while it is up; the cache is only a
  // last resort for a temporarily unreachable local server.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/')));
    return;
  }

  event.respondWith(
    fetch(req)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(req))
  );
});