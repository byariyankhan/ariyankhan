/* Piece the World + Puzzle – Train Your Brain — service worker.
   Scope is the whole origin (it has to be, to control the game page), but the fetch
   handler only ever answers for the game's own files; every other request on the
   site is left to the network exactly as if no worker were installed. */
const VERSION = 'ptw-cache-v151';
const GAME_FILES = new Set([
  '/piece-the-world.html', '/css/style.css', '/css/piece-the-world.css',
  '/js/piece-the-world.js', '/js/site-nav.js', '/js/site-footer.js',
  '/games/piece-the-world.webmanifest', '/images/ariyan-khan-profile.webp',
  '/puzzle', '/puzzle/', '/css/puzzle.css', '/js/puzzle.js', '/puzzle/app.webmanifest', '/images/puzzle-brain-mark.svg', '/images/puzzle-brain-mark-rose.svg', '/images/puzzle-brain-mark-white.svg',
  // the game's own icon and its coin: installed from the home screen, with no network, the game still has a
  // face and its gold still has a face
  '/puzzle/icons/puzzle-96.png', '/puzzle/icons/puzzle-180.png',
  '/puzzle/icons/puzzle-192.png', '/puzzle/icons/puzzle-512.png',
  '/puzzle/icons/puzzle-maskable-512.png', '/images/puzzle-coin.png',
  '/favicon/favicon.ico', '/favicon/favicon-96x96.png', '/favicon/apple-touch-icon.png',
]);
const isLevelData = p => p.startsWith('/games/data/') && p.endsWith('.json');
// The gallery: the paintings never change (art.json is versioned by query string), so a painting seen once is kept.
const isArt = p => p.startsWith('/images/art/');

/* Put the game in the cache now, rather than when somebody happens to ask for it again.

   This used to be skipWaiting() alone, and the hole it left only showed up in the Android app. A worker does
   not control the navigation that registered it, so the first visit was never cached; the cache filled on the
   *second* online visit. Open the app once, turn the network off, open it again, and the worker was in
   control, the network was gone, the cache was empty, and the fetch handler below threw — which the WebView
   reported as net::ERR_FAILED over a blank page. A browser hid the same bug behind its own HTTP cache.

   Only the three files the game cannot start without are fetched here, each tolerating its own failure so one
   404 cannot fail the install and leave the site with no worker at all. Everything else still arrives the way
   it always did, on first use. The query strings the page stamps on the CSS and the JS are not known here and
   do not need to be: the fallback below matches with ignoreSearch. */
const CORE = ['/puzzle/', '/css/puzzle.css', '/js/puzzle.js', '/images/puzzle-brain-mark-rose.svg', '/images/puzzle-brain-mark-white.svg'];
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(VERSION).then(cache =>
    Promise.all(CORE.map(path => cache.add(new Request(path, { cache: 'reload' })).catch(() => {})))));
});
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
  if (isLevelData(path) || isArt(path)) {
    // Level data is versioned by query string, and a painting is a painting → cache first, forever.
    event.respondWith(caches.open(VERSION).then(async cache => {
      const hit = await cache.match(req); if (hit) return hit;
      const res = await fetch(req); if (res.ok) cache.put(req, res.clone()); return res;
    }));
    return;
  }
  if (!GAME_FILES.has(path)) return;
  if (req.mode === 'navigate' && (path === '/puzzle' || path === '/puzzle/')) { event.respondWith(openGame(event)); return; }
  // Page, CSS, JS: network first so a deploy shows up immediately; cache is the offline fallback.
  event.respondWith(caches.open(VERSION).then(async cache => {
    // A server error is not a newer copy of the game: the cached one is served over a 5xx, the same as
    // over no network at all.
    try {
      const res = await fetch(req);
      if (res.ok) { cache.put(req, res.clone()); return res; }
      if (res.status >= 500) { const hit = await cache.match(req, { ignoreSearch: true }); if (hit) return hit; }
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  }));
});

/* Opening the game: the network if it answers in time, the copy already here if it does not.

   Network first with no limit meant that on a connection that is up but barely moving -- a train, a basement,
   the last bar of signal -- a returning player sat on the app's splash (or a blank tab) until the request gave
   up, which can be most of a minute, with a perfectly good game in the cache the whole time. So the network
   gets NAV_WAIT_MS. An answer inside that is used exactly as before (a new deploy shows up at once, a 5xx falls
   back to the cache). After it, the cached page is served, and the network's answer, whenever it comes, still
   goes into the cache for next time. A first visit has nothing cached and simply waits for the network. */
const NAV_WAIT_MS = 2000;
function openGame(event) {
  const req = event.request;
  let saved = Promise.resolve();
  const net = fetch(req).then(res => {
    // Cloned here, before anybody can start reading the body: the page may be handed this same response.
    if (res.ok) { const copy = res.clone(); saved = caches.open(VERSION).then(cache => cache.put(req, copy)).catch(() => {}); }
    return res;
  });
  // The worker is kept alive until the late answer is stored, not only until the page has one.
  event.waitUntil(net.then(() => saved, () => {}));
  return (async () => {
    const cached = () => caches.open(VERSION).then(cache => cache.match(req, { ignoreSearch: true }));
    const first = await Promise.race([net.catch(() => null), new Promise(r => setTimeout(r, NAV_WAIT_MS, null))]);
    if (first && (first.ok || first.status < 500)) return first;
    const hit = await cached();
    if (hit) return hit;
    return first || net;   // nothing cached: the network's answer after all, or its error
  })();
}

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
