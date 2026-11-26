/**
 * sw.js – "service worker": gør at appen kan installeres på telefonen og
 * virker uden internet, når den først har været brugt én gang.
 *
 *  - Appens egne filer hentes fra nettet (så opdateringer slår igennem med det
 *    samme), men gemmes også, så de kan bruges offline eller på dårligt net.
 *  - Bibliotekerne fra cdn.jsdelivr.net (Three.js og Transformers.js) har et fast
 *    versionsnummer og ændrer sig aldrig, så de tages direkte fra cachen.
 *  - AI-modellerne fra Hugging Face gemmer Transformers.js selv.
 */
const APP_CACHE = 'foto3d-app-v1';
const CDN_CACHE = 'foto3d-cdn-v1';
const APP_FILES = [
  './',
  'index.html',
  'css/style.css',
  'js/main.js',
  'js/ai-worker.js',
  'js/mesh.js',
  'js/viewer.js',
  'js/export.js',
  'js/camera.js',
  'icon.svg',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(APP_CACHE)
      .then((cache) => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Ryd gamle udgaver af cachen op
      for (const key of await caches.keys()) {
        if (key.startsWith('foto3d-') && key !== APP_CACHE && key !== CDN_CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
  } else if (url.hostname === 'cdn.jsdelivr.net' && !url.pathname.endsWith('.wasm')) {
    event.respondWith(cacheFirst(request));
  }
  // Alt andet (fx AI-modellerne) går direkte til nettet.
});

/** Prøv nettet først. Er der ikke svar inden for 3 sekunder, bruges den gemte udgave. */
async function networkFirst(request) {
  const cache = await caches.open(APP_CACHE);
  const network = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  const cached = await cache.match(request, { ignoreSearch: true });
  if (!cached) return network; // aldrig gemt før: vent på nettet
  return Promise.race([
    network.catch(() => cached),
    new Promise((resolve) => setTimeout(() => resolve(cached), 3000)),
  ]);
}

/** Brug den gemte udgave, hvis den findes – ellers hent og gem. */
async function cacheFirst(request) {
  const cache = await caches.open(CDN_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}
