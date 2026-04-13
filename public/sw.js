// Minimal service worker — enables "Add to Home Screen" on iOS/Android
self.addEventListener('fetch', event => {
  event.respondWith(fetch(event.request));
});
