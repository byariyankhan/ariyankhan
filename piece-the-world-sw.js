/* Piece the World + Arrow Atlas — service worker.
   Scope is the whole origin (it has to be, to control the game page), but the fetch
   handler only ever answers for the game's own files; every other request on the
   site is left to the network exactly as if no worker were installed. */
const VERSION = 'ptw-cache-v31';
const GAME_FILES = new Set([
  '/piece-the-world.html', '/css/style.css', '/css/piece-the-world.css',
  '/js/piece-the-world.js', '/js/site-nav.js', '/js/site-footer.js',
  '/games/piece-the-world.webmanifest', '/images/ariyan-khan-profile.webp',
  '/arrow-atlas.html', '/css/arrow-atlas.css', '/js/arrow-atlas.js', '/games/arrow-atlas.webmanifest',
  '/favicon/favicon.ico', '/favicon/favicon-96x96.png', '/favicon/apple-touch-icon.png',
]);
const isLevelData = p => p.startsWith('/games/data/') && p.endsWith('.json');

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('ptw-cache-') && k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (isLevelData(path)) {
    // Level data is versioned by query string → cache first, forever.
    event.respondWith(caches.open(VERSION).then(async cache => {
      const hit = await cache.match(req); if (hit) return hit;
      const res = await fetch(req); if (res.ok) cache.put(req, res.clone()); return res;
    }));
    return;
  }
  if (!GAME_FILES.has(path)) return;
  // Page, CSS, JS: network first so a deploy shows up immediately; cache is the offline fallback.
  event.respondWith(caches.open(VERSION).then(async cache => {
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  }));
});
