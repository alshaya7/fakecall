// FakeCall service worker: precache every static file, then serve cache-first,
// so the app opens and works in airplane mode.
//
// Because responses come from the cache first, bump VERSION whenever any file
// changes; the new worker then replaces the old cache.

const VERSION = "v1";
const CACHE = `fakecall-${VERSION}`;

const ASSETS = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "manifest.webmanifest",
  "assets/icons/icon.svg",
  "assets/icons/apple-touch-icon.png",
  "assets/icons/icon-192.png",
  "assets/icons/icon-512.png",
  "assets/ringtones/chime.wav",
  "assets/ringtones/bell.wav",
  "assets/ringtones/pulse.wav",
];

// Nice to have: the app works without these, so a missing one must not block install.
const OPTIONAL_ASSETS = ["assets/keepawake.mp4"];

// "reload" bypasses the HTTP cache so a new version never precaches stale files.
const fresh = (url) => new Request(url, { cache: "reload" });

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        cache
          .addAll(ASSETS.map(fresh))
          .then(() => Promise.allSettled(OPTIONAL_ASSETS.map((url) => cache.add(fresh(url))))),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  try {
    return await fetch(request);
  } catch (error) {
    // Offline and not precached: fall back to the app shell for page loads.
    if (request.mode === "navigate") {
      const shell = await cache.match("index.html");
      if (shell) return shell;
    }
    throw error;
  }
}
