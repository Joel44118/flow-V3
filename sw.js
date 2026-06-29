// sw.js — Flow V3 Service Worker (v5 — NETWORK FIRST ALWAYS)
// FIX: Was cache-first for all files = stale content on every open
// NOW: Network-first for ALL JS/HTML — cache is only a fallback if offline
// This guarantees every open shows the latest Vercel deployment

const CACHE   = 'flow-v3-5';
const OFFLINE = ['/', '/index.html'];  // minimal offline fallback only

self.addEventListener('install', e => {
  self.skipWaiting();  // activate immediately, don't wait for old tabs
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(OFFLINE)).catch(() => {})
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(Promise.all([
    // Wipe ALL old caches
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ),
    self.clients.claim(),  // take control of all open tabs now
  ]));
});

self.addEventListener('fetch', e => {
  const { url, method } = e.request;
  const parsed = new URL(url);

  // Never cache: API calls, mediapipe, external CDNs
  if (
    parsed.pathname.startsWith('/api/') ||
    parsed.pathname.startsWith('/mediapipe/') ||
    parsed.origin !== self.location.origin
  ) {
    e.respondWith(fetch(e.request).catch(() => new Response('offline', { status: 503 })));
    return;
  }

  // NETWORK FIRST for everything — cache is only a fallback when offline
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Cache a fresh copy for offline fallback
        if (res.ok && method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))  // offline: serve cached version
  );
});
