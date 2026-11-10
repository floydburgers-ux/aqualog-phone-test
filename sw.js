
const CACHE_NAME = "aqualog-v10";

const APP_FILES = [
  "./",
  "./index.html",
  "./index.html?v=20261110-6",
  "./style.css?v=20261110-6",
  "./app.js?v=20261110-6",
  "./manifest.json?v=20261110-6",
  "./icon.svg?v=20261110-6",
  "./FB-AquaLog-v2.svg?v=20261110-6",
  "./FB-AquaLog-beeldmerk.svg?v=20261110-6",
  "./aquarium-photo.jpg?v=20261110-6"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request).then(response => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, copy);
          });
        }

        return response;
      });
    })
  );
});

