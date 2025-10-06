// public/sw.js
const CACHE_NAME = "ufotrac-v1";
const OFFLINE_URLS = ["/", "/manifest.json"];

// Install: cache basic assets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(OFFLINE_URLS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k === CACHE_NAME ? null : caches.delete(k))))
    )
  );
  self.clients.claim();
});

// Fetch: network-first for pages, cache-first for others
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const isPage = request.mode === "navigate";

  if (isPage) {
    // network-first for HTML
    event.respondWith(
      fetch(request)
        .then((res) => {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(request, resClone));
          return res;
        })
        .catch(() => caches.match(request).then((r) => r || caches.match("/")))
    );
  } else {
    // cache-first for assets
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((res) => {
            const resClone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(request, resClone));
            return res;
          })
      )
    );
  }
});
