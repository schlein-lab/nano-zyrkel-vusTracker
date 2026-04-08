const CACHE = 'vus-tracker-v1';
const SHELL = ['/', '/index.html', '/app.js', '/style.css', '/pkg/vus_tracker_lib_bg.wasm', '/pkg/vus_tracker_lib.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('/data/')) {
    // Data: network first, cache fallback
    e.respondWith(
      fetch(e.request).then(r => {
        const clone = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return r;
      }).catch(() => caches.match(e.request))
    );
  } else {
    // Shell: cache first
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
  }
});
