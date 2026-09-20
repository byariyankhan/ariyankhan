/* Piece the World + Puzzle – Train Your Brain — service worker.
   Scope is the whole origin (it has to be, to control the game page), but the fetch
   handler only ever answers for the game's own files; every other request on the
   site is left to the network exactly as if no worker were installed. */
const VERSION = 'ptw-cache-v72';
const GAME_FILES = new Set([
  '/piece-the-world.html', '/css/style.css', '/css/piece-the-world.css',
  '/js/piece-the-world.js', '/js/site-nav.js', '/js/site-footer.js',
  '/games/piece-the-world.webmanifest', '/images/ariyan-khan-profile.webp',
  '/puzzle/', '/css/puzzle.css', '/js/puzzle.js', '/puzzle/app.webmanifest',
  // the game's own icon and its coin: installed from the home screen, with no network, the game still has a
  // face and its gold still has a face
  '/puzzle/icons/puzzle-96.png', '/puzzle/icons/puzzle-180.png',
  '/puzzle/icons/puzzle-192.png', '/puzzle/icons/puzzle-512.png',
  '/puzzle/icons/puzzle-maskable-512.png', '/images/puzzle-coin.png',
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
  // The game's backend is never cached, and never touched by this worker: every answer it gives is about right
  // now. It falls outside GAME_FILES anyway, but saying so here keeps a later broad rule from swallowing it.
  if (path.startsWith('/api/puzzle/') || path.startsWith('/ws/puzzle')) return;
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

/* ── Notifications ──────────────────────────────────────────────────────────────
   Two things in this game happen while nobody is looking at it: a friend asks you
   to a match, and the league pays out on Sunday night. The server encrypts those
   to this browser's own push service (see games/puzzle/backend/src/push.ts); this
   is where they land.

   A push always shows something. A browser that is handed a push and shows no
   notification eventually has its permission taken away — so an undecodable or
   empty payload still puts the game's own name on the screen rather than nothing. */
self.addEventListener('push', event => {
  let note = {};
  try { note = event.data ? event.data.json() : {}; } catch { note = {}; }
  const title = note.title || 'Puzzle – Train Your Brain';
  const options = {
    body: note.body || '',
    // The game's own icon, and its silhouette for the status bar on Android.
    icon: '/puzzle/icons/puzzle-192.png?v=2',
    badge: '/puzzle/icons/puzzle-96.png?v=2',
    // Notifications sharing a tag replace each other: five invitations are one line, not five.
    tag: note.tag || 'puzzle',
    renotify: true,
    data: { url: note.url || '/puzzle/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

/* Tapping it goes to the game — to the tab that already has it open if there is one,
   because two copies of the same game in two tabs is how a match gets played twice. */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/puzzle/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if (!client.url.includes('/puzzle')) continue;
      await client.focus();
      // Same tab, new destination: the client decides what to do with the hash it is handed.
      if ('navigate' in client) { try { await client.navigate(url); } catch { /* a focused tab is enough */ } }
      return;
    }
    await self.clients.openWindow(url);
  })());
});
