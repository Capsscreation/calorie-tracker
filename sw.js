// Offline support: network first for the app's own files, falling back to the cache.
// Open Food Facts and the scanner library always go to the network.
const CACHE = 'calories-v2';
const SHELL = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './js/app.js', './js/foods.js', './js/parse.js', './js/off.js', './js/scanner.js', './js/store.js', './js/images.js',
  './icons/icon.svg', './icons/icon-192.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))),
  );
});
