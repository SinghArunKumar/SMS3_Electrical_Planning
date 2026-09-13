// Service worker for the Stores Dashboard PWA.
//
// Scope, deliberately: just make "Add to Home Screen" work like a real app
// (Chrome/Android require an active service worker with a fetch handler
// before they'll offer installation at all). This is NOT an offline-first
// build -- that was explicitly out of scope for this pass.
//
// Strategy is NETWORK-FIRST, not cache-first, and that's a deliberate
// safety choice given how this project actually gets updated: fixes ship
// by re-uploading files to GitHub, and everyone's used to a hard refresh
// (or incognito window) showing the latest version immediately. A
// cache-first service worker would silently break that -- someone could
// hard-refresh and still see a stale, already-fixed bug because the
// service worker served an old cached copy instead of checking the
// network. Network-first means: if you're online (the assumed normal
// case), you always get whatever's actually live, same as today. The
// cache is only ever consulted as a last resort if the network request
// itself fails outright.
//
// CRITICAL: every Apps Script call goes to script.google.com, a different
// origin from this site (singharunkumar.github.io). The origin check below
// means this service worker NEVER intercepts, caches, or interferes with
// those calls -- stock balances, approvals, search results, everything
// that comes from Code.gs is untouched, always live, exactly as before.

const CACHE_NAME = 'stores-dashboard-shell-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './shared.js',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Cross-origin (Apps Script, Google Fonts, etc.) -- never touch, let the
  // browser handle it exactly as if this service worker didn't exist.
  if (url.origin !== self.location.origin) {
    return;
  }

  // Same-origin (this site's own files: index.html, shared.js, every
  // fragments/*.html page). Network-first: always try to get the current
  // live version; only fall back to whatever's cached if the network
  // request fails outright (e.g. genuinely offline).
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
